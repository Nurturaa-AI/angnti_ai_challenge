import {
  DEFAULT_EXPLORATION_BUDGET,
  EvidenceLedger,
  EvidenceSchema,
  ModelError,
  RequestError,
  TOOL_DEFINITIONS,
  TrajectoryRecorder,
  createSourceResolver,
  executeTool,
  groundAnalysis,
  parseModelJson,
  runEvidenceScout,
  validateWithSchema,
  type AnalysisBody,
  type ContextSourceText,
  type ConversationStep,
  type Evidence,
  type EvidenceType,
  type ExplorationBudget,
  type LlmClient,
  type TokenUsage,
  type ToolCall,
  type TrajectoryStep,
} from "@repo-arch/shared";
import { z } from "zod";
import {
  QUESTION_RESPONSE_SCHEMA,
  QUESTION_SYSTEM_INSTRUCTION,
  buildAnswerPrompt,
  buildQuestionPrompt,
} from "./question-prompt";

/**
 * Grounded question answering: question → search → repository evidence → model →
 * citation extraction → grounding → verified answer.
 *
 * The pipeline is the briefing's, shortened. It reuses the same scout, the same
 * three tools, the same boundary, the same `groundAnalysis`, and returns an answer
 * that has been through the same verification the briefing goes through. What it
 * does not reuse is the briefing's *ledger*, and that is the design decision worth
 * defending.
 *
 * Grounding asks two questions of a citation: was this source in context, and does
 * this quote really appear in it. The first has a scope, and the scope has to be the
 * evidence *this question* actually inspected. If a question were grounded against
 * everything the original analysis read, a model could cite a file it had never been
 * shown — with no excerpt — and grounding would accept it, because the file really is
 * in the analysis ledger. The citation would be technically true and epistemically
 * worthless.
 *
 * So each question gets its own ledger: the reconnaissance context (whose text is in
 * the prompt), the files the scout found for this question, and whatever the model
 * read on its own turns. Nothing else. The answer is then verifiable in the strong
 * sense — every citation names something the model was actually handed — and the
 * fallback wording below is literally true rather than a figure of speech.
 *
 * The cost of that choice is real and worth stating: a follow-up question may re-read
 * a file an earlier question already read. Bounded reads are cheap; a citation that
 * proves nothing is not.
 */

/**
 * The exact wording required when nothing survives verification.
 *
 * Produced by the harness, never by the model — which is the point. A model asked to
 * write its own admission of failure writes a hedge; this is a fact about the run,
 * and the run is what states it.
 */
export const UNSUPPORTED_ANSWER = "I couldn't verify this from the repository evidence I inspected.";

/**
 * A question's exploration budget: smaller than the briefing's in every dimension
 * that costs a round trip.
 *
 * A briefing has to cover a repository; a question has to settle one thing. Four tool
 * calls over three turns is enough for search → read → read, which is the shape of
 * almost every question a reader actually asks, and it is a hard ceiling rather than
 * a suggestion: the loop stops, tells the model it has stopped, and asks for the
 * answer. There is no path here that spends an unbounded number of calls.
 */
export const DEFAULT_QUESTION_BUDGET: ExplorationBudget = {
  ...DEFAULT_EXPLORATION_BUDGET,
  maxToolCalls: 4,
  maxTurns: 3,
  maxScoutFiles: 3,
};

/** Longer than any real question, short enough that it cannot be a prompt payload. */
export const MAX_QUESTION_CHARS = 1_000;

/** Kept small: history is replayed into every later prompt. */
export const MAX_HISTORY_TURNS = 6;

/**
 * Artefact types whose text lives in the question prompt.
 *
 * The same four the report calls reconnaissance. They are bounded by the collector's
 * own caps, which is what makes it safe to render all of them into every question.
 *
 * Exported because it is also the rule the durable store projects by: these are the
 * artefacts a question needs in order to be answerable after a restart, so these are
 * the artefacts whose text has to survive one.
 */
export const RECONNAISSANCE_TYPES = new Set<EvidenceType>(["tree", "readme", "manifest", "metadata"]);

/**
 * What the model may return.
 *
 * `citations` reuses `EvidenceSchema` rather than describing a citation again, so a
 * question's citation and a briefing's citation are the same object with the same
 * validation — including the part where `grounded` exists but the model's copy of it
 * is overwritten by grounding regardless of what it says.
 */
export const QuestionAnswerBodySchema = z.object({
  answer: z.string().min(1, "answer must not be empty"),
  sufficient: z.boolean(),
  citations: z.array(EvidenceSchema).default([]),
  confidence: z.number().min(0).max(1),
});

export type QuestionAnswerBody = z.infer<typeof QuestionAnswerBodySchema>;

/** One surviving citation on an answer. Shaped like `ReportEvidence`, scoped to the question. */
export interface QuestionCitation {
  /** Unique across the analysis: `q-1-ev-001`. */
  id: string;
  type: EvidenceType;
  /** As the model wrote it. */
  source: string;
  /** The ledger artefact it resolves to, or `null` if unresolvable. */
  sourceId: string | null;
  location: string | undefined;
  excerpt: string | undefined;
  supports: string | undefined;
}

export interface QuestionMetricsRecord {
  durationMs: number;
  turns: number;
  /** The model's own tool calls. The scout's are reported separately, as in a run. */
  toolCalls: number;
  failedToolCalls: number;
  scoutFilesRead: number;
  bytesFromTools: number;
  budgetExhausted: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface AnsweredQuestion {
  id: string;
  question: string;
  askedAt: string;
  /** The model's answer, or `UNSUPPORTED_ANSWER` when nothing survived grounding. */
  answer: string;
  /** False when the answer is the fallback. */
  supported: boolean;
  /** The model's own claim about whether the evidence settled the question. */
  modelReportedSufficient: boolean;
  confidence: number;
  citations: QuestionCitation[];
  /** Ledger artefacts this question inspected, by id. */
  inspectedSources: string[];
  audit: {
    claimed: number;
    grounded: number;
    dropped: { source: string; reason: string }[];
  };
  metrics: QuestionMetricsRecord;
  trajectory: TrajectoryStep[];
}

/**
 * An answered question as everything outside the answering loop sees it.
 *
 * The trajectory is the difference, and dropping it is structural rather than
 * cosmetic. A trajectory step carries the model's own prose and the raw bytes a
 * tool returned; both are internal by policy. Making the *type* lack the field
 * means a route or a store row cannot leak it by forgetting to strip it — there
 * is nothing to strip.
 */
export type AnsweredQuestionView = Omit<AnsweredQuestion, "trajectory">;

/** Drops the trajectory. The only way an answered question leaves this module. */
export function questionView(answered: AnsweredQuestion): AnsweredQuestionView {
  const { trajectory: _trajectory, ...view } = answered;
  return view;
}

export interface AnswerQuestionOptions {
  question: string;
  /** Stable within the analysis: `q-1`. Prefixes the citation ids. */
  questionId: string;
  /** Absolute path. The boundary of every tool call this question makes. */
  repositoryRoot: string;
  repositoryName: string;
  /** The analysis ledger. Only its reconnaissance artefacts seed the question. */
  sources: readonly ContextSourceText[];
  /** Earlier answers, oldest first. Replayed as context; never citable. */
  history?: readonly Pick<AnsweredQuestion, "question" | "answer">[] | undefined;
  client: LlmClient;
  budget?: ExplorationBudget | undefined;
  now?: (() => Date) | undefined;
}

export interface QuestionRun {
  answered: AnsweredQuestion;
  /**
   * Artefacts this question added to the repository's evidence — the scout's reads and
   * the model's. The caller merges them into the analysis ledger so the evidence
   * explorer can serve their text; they do not retroactively affect the briefing,
   * whose citations were grounded against the ledger as it stood.
   */
  newSources: ContextSourceText[];
}

export async function answerQuestion(options: AnswerQuestionOptions): Promise<QuestionRun> {
  const question = options.question.trim();
  if (question === "") {
    throw new RequestError("A question is required.", "Send a non-empty question.");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new RequestError(
      `A question may be at most ${MAX_QUESTION_CHARS} characters; this one is ${question.length}.`,
      "Ask one thing at a time. A long question is usually several questions.",
    );
  }

  const client = options.client;
  if (!client.generateWithTools) {
    throw new ModelError(
      `The "${client.provider}" provider does not support tool use, which question answering requires.`,
      'Use the Gemini provider, or run with the mock provider for an offline answer.',
    );
  }
  const generateWithTools = client.generateWithTools.bind(client);

  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const budget = options.budget ?? DEFAULT_QUESTION_BUDGET;
  const trajectory = new TrajectoryRecorder(() => now().getTime());

  // The question's own ledger. Seeded with exactly the artefacts whose text the
  // prompt will contain, so a surviving citation always names something the model
  // was handed. See the note at the top of this file.
  const contextSources = options.sources.filter((source) => RECONNAISSANCE_TYPES.has(source.type));
  const ledger = new EvidenceLedger(contextSources);
  const newSources: ContextSourceText[] = [];

  const toolContext = { repositoryRoot: options.repositoryRoot, budget };
  const usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const filesRead: string[] = [];
  let bytesFromTools = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;

  trajectory.step("question-received", {
    questionChars: question.length,
    historyTurns: options.history?.length ?? 0,
    contextSources: contextSources.map((source) => source.id),
    budget: { ...budget },
  });

  // 1. The scout, aimed at the question. This is the one place `focus` is set in
  //    production: a reader asking about the queue consumer wants terms drawn from
  //    their question, not from the README. The evaluation harness never reaches
  //    here — it runs the CLI pipeline, which leaves `focus` unset — so aiming the
  //    search at a question cannot flatter a benchmark number.
  const scout = runEvidenceScout(toolContext, {
    focus: question,
    sources: contextSources,
    repositoryName: options.repositoryName,
  });

  for (const artifact of scout.artifacts) {
    bytesFromTools += artifact.bytes;
    if (artifact.type === "file" && !filesRead.includes(artifact.id)) filesRead.push(artifact.id);
    newSources.push(artifact);
  }
  ledger.recordAll(scout.artifacts);

  trajectory.step("scout-search", {
    terms: scout.terms.map((term) => ({ term: term.term, origin: term.origin, weight: term.weight })),
    searches: scout.searches,
    candidates: scout.candidates.map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
    })),
  });
  trajectory.step("scout-read", { reads: scout.reads, summary: scout.summary });

  // 2. The bounded exploration loop.
  //
  //    Deliberately not shared with the briefing's loop in `advanced/`. That one is
  //    woven into a full run's trajectory, per-tool counters and budget accounting;
  //    refactoring it to serve both would mean editing the measured pipeline on an
  //    iteration whose whole point is not to disturb it. The two do share everything
  //    that would be dangerous to duplicate — the tools, the boundary, the ledger and
  //    the grounding — and differ only in the loop around them.
  const history = (options.history ?? []).slice(-MAX_HISTORY_TURNS);
  const prompt = buildQuestionPrompt({
    question,
    repositoryName: options.repositoryName,
    sources: contextSources,
    scoutEvidence: scout.evidence,
    budget,
    // Only the words. A previous answer's citations are not replayed: they were
    // verified against an earlier ledger, and re-presenting them here would invite
    // the model to cite them again without inspecting anything.
    history: history.map((turn) => ({ question: turn.question, answer: turn.answer })),
  });
  trajectory.step("build-question-prompt", {
    promptChars: prompt.length,
    scoutEvidenceChars: scout.evidence.length,
    historyTurns: history.length,
  });

  const conversation: ConversationStep[] = [{ kind: "user", text: prompt }];
  let turns = 0;
  let budgetExhausted = false;
  let lastModel = client.model;

  for (let turn = 1; turn <= budget.maxTurns; turn += 1) {
    turns = turn;
    const response = await generateWithTools({
      systemInstruction: QUESTION_SYSTEM_INSTRUCTION,
      steps: conversation,
      tools: TOOL_DEFINITIONS,
    });
    lastModel = response.model;
    addUsage(usageTotal, response.usage);
    trajectory.step(
      "model-turn",
      {
        turn,
        requestedTools: response.toolCalls.map((call) => call.name),
        modelText: response.text,
      },
      { usage: response.usage },
    );

    // The provider's continuation tokens must open a replayed model turn, then its
    // prose, then all of its calls, then all of their results. The arrangement is the
    // Interactions API's, not a preference; see the note in `advanced/src/index.ts`.
    for (const payload of response.providerSteps) conversation.push({ kind: "providerStep", payload });
    if (response.text !== "") conversation.push({ kind: "model", text: response.text });
    if (response.toolCalls.length === 0) break;

    const callSteps: ConversationStep[] = [];
    const resultSteps: ConversationStep[] = [];

    for (const call of response.toolCalls) {
      callSteps.push({ kind: "toolCall", id: call.id, name: call.name, arguments: argumentsForHistory(call) });

      if (toolCalls >= budget.maxToolCalls) {
        budgetExhausted = true;
        resultSteps.push({
          kind: "toolResult",
          callId: call.id,
          name: call.name,
          output: `ERROR: this question's exploration budget is spent after ${toolCalls} tool calls. Answer with what you have, and say what is missing.`,
          isError: true,
        });
        trajectory.step("budget-exhausted", { attemptedTool: call.name, toolCalls }, { tool: call.name, ok: false });
        continue;
      }

      const outcome = executeTool(toolContext, call);
      toolCalls += 1;
      if (outcome.isError) failedToolCalls += 1;

      for (const artifact of outcome.artifacts) {
        bytesFromTools += artifact.bytes;
        if (artifact.type === "file" && !filesRead.includes(artifact.id)) filesRead.push(artifact.id);
        newSources.push(artifact);
      }
      ledger.recordAll(outcome.artifacts);

      trajectory.step(
        "tool-call",
        {
          ...outcome.summary,
          artifacts: outcome.artifacts.map((artifact) => ({
            id: artifact.id,
            type: artifact.type,
            bytes: artifact.bytes,
            truncated: artifact.truncated,
          })),
        },
        { tool: call.name, toolArgs: call.arguments, toolResult: outcome.output, ok: !outcome.isError },
      );
      resultSteps.push({
        kind: "toolResult",
        callId: call.id,
        name: call.name,
        output: outcome.output,
        isError: outcome.isError,
      });
    }

    conversation.push(...callSteps, ...resultSteps);
    if (toolCalls >= budget.maxToolCalls) budgetExhausted = true;
    if (turn === budget.maxTurns) budgetExhausted = true;
  }

  // 3. The answer turn: no tools, strict schema, closed citable set.
  const sources = ledger.toArray();
  const citableIds = sources.map((source) => source.id);
  conversation.push({
    kind: "user",
    text: buildAnswerPrompt({ question, citableIds, filesRead, budgetExhausted }),
  });

  const finalResponse = await generateWithTools({
    systemInstruction: QUESTION_SYSTEM_INSTRUCTION,
    steps: conversation,
    tools: [],
    schema: QUESTION_RESPONSE_SCHEMA,
  });
  turns += 1;
  lastModel = finalResponse.model;
  addUsage(usageTotal, finalResponse.usage);
  trajectory.step(
    "answer-call",
    { model: lastModel, responseChars: finalResponse.text.length, citableIds },
    { usage: finalResponse.usage },
  );

  if (finalResponse.text.trim() === "") {
    throw new ModelError(
      "The model returned no answer on the final turn.",
      "Raise REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS, or ask a narrower question.",
    );
  }

  const body = validateWithSchema(
    QuestionAnswerBodySchema,
    parseModelJson(finalResponse.text),
    "model answer",
  );
  trajectory.step("validate-answer", {
    answerChars: body.answer.length,
    citations: body.citations.length,
    modelReportedSufficient: body.sufficient,
  });

  // 4. Grounding — the real one, over the question's ledger.
  const { citations, audit } = groundCitations(body.citations, sources, options.questionId);
  trajectory.step("ground-answer", {
    ledgerSources: sources.length,
    claimed: audit.claimed,
    grounded: audit.grounded,
    dropped: audit.dropped,
  });

  // An answer is served only when something survived verification *and* the model did
  // not itself report the evidence as insufficient. Both conditions matter: the first
  // stops an unverifiable answer from being presented as fact, and the second respects
  // a model that correctly said it could not tell — overriding that with a partially
  // cited answer would punish the honest outcome.
  const supported = citations.length > 0 && body.sufficient;
  const finishedAt = now();

  const answered: AnsweredQuestion = {
    id: options.questionId,
    question,
    askedAt: startedAt.toISOString(),
    answer: supported ? body.answer : UNSUPPORTED_ANSWER,
    supported,
    modelReportedSufficient: body.sufficient,
    confidence: supported ? body.confidence : 0,
    // Kept even when unsupported: what the model tried to cite, and what grounding
    // made of it, is the most useful thing a reader can see about a failed answer.
    citations,
    inspectedSources: citableIds,
    audit,
    metrics: {
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      turns,
      toolCalls,
      failedToolCalls,
      scoutFilesRead: scout.summary.filesRead,
      bytesFromTools,
      budgetExhausted,
      inputTokens: usageTotal.inputTokens,
      outputTokens: usageTotal.outputTokens,
    },
    trajectory: trajectory.toJSON(),
  };

  return { answered, newSources };
}

/**
 * Verifies a question's citations with `groundAnalysis`.
 *
 * The citations are wrapped into an otherwise-empty analysis body so that the real
 * grounding function runs, unmodified, over them. It looks like a detour and it is
 * the point: a second implementation of "is this citation verifiable" would eventually
 * disagree with the first, and the disagreement would be invisible — an answer the
 * briefing pipeline would have rejected, served as verified.
 *
 * `unsupportedClaims` from that call is meaningless here (the stub has one empty claim
 * by construction) and is not read. `claimed`, `grounded` and `dropped` are exactly
 * what they say.
 */
function groundCitations(
  claimed: readonly Evidence[],
  sources: readonly ContextSourceText[],
  questionId: string,
): { citations: QuestionCitation[]; audit: AnsweredQuestion["audit"] } {
  const stub: AnalysisBody = {
    summary: "question",
    architecture: "question",
    components: [],
    flows: [],
    dependencies: [],
    testing: { approach: "not applicable", frameworks: [], testPaths: [], gaps: [], evidence: [] },
    risks: [],
    recommendedReading: [],
    confidence: 0,
    evidence: [...claimed],
    openQuestions: [],
  };

  const { body, audit } = groundAnalysis(stub, sources);
  const resolveSource = createSourceResolver(sources);

  const citations = body.evidence.map((item, index) => ({
    id: `${questionId}-ev-${String(index + 1).padStart(3, "0")}`,
    type: item.type,
    source: item.source,
    sourceId: resolveSource(item.source)?.id ?? null,
    location: item.location,
    excerpt: item.excerpt,
    supports: item.supports,
  }));

  return {
    citations,
    audit: { claimed: audit.claimed, grounded: audit.grounded, dropped: audit.dropped },
  };
}

function addUsage(total: TokenUsage, next: TokenUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.totalTokens += next.totalTokens;
}

/** Arguments as the replayed conversation records them: an object, whatever arrived. */
function argumentsForHistory(call: ToolCall): Record<string, unknown> {
  const args = call.arguments;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Falls through to the raw form below.
    }
  }
  return { __unparsed: args === undefined ? null : args };
}
