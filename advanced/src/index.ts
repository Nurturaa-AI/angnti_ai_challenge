import {
  AnalysisBodySchema,
  AnalysisResultSchema,
  ConfigError,
  EvidenceLedger,
  ModelError,
  RUN_RECORD_SCHEMA_VERSION,
  RunRecordSchema,
  TOOL_DEFINITIONS,
  TrajectoryRecorder,
  applyEvidencePrecision,
  collectRepositoryContext,
  createLlmClient,
  estimateCostUsd,
  executeTool,
  groundAnalysis,
  loadExplorationBudget,
  loadPrecisionPolicy,
  parseModelJson,
  runEvidenceScout,
  slugify,
  timestampSlug,
  validateWithSchema,
  type AnalysisConfig,
  type CollectOptions,
  type ContextSourceText,
  type ConversationStep,
  type ExplorationBudget,
  type ExplorationSummary,
  type LlmClient,
  type PrecisionPolicy,
  type RunRecord,
  type TokenUsage,
  type ToolCall,
} from "@repo-arch/shared";
import { ADVANCED_RESPONSE_SCHEMA, ADVANCED_SYSTEM_INSTRUCTION, buildReconnaissancePrompt, buildSynthesisPrompt } from "./prompt";

/**
 * The advanced system: reconnaissance, then a deterministic search pass, then a
 * bounded agent loop.
 *
 * Same shape as the baseline — repository in, grounded run record out — with two
 * structural changes in the middle. The model gets the baseline's context plus three
 * read-only tools and a bounded number of turns; and before it gets a turn at all,
 * the Evidence Scout searches the repository for terms drawn from its own
 * documentation, ranks what matched, and reads the best few files.
 *
 * That ordering is iteration 2's whole point. Iteration 1 gave the model a search
 * tool and it used it zero times out of seven calls, guessing filenames instead. So
 * the search stops being optional and starts being a phase. The model keeps its
 * tools and can still explore — the scout sets a floor on the evidence, not a
 * ceiling.
 *
 * The property that makes this trustworthy is the evidence ledger. It starts as the
 * reconnaissance context and grows only when a tool actually returns bytes — the
 * scout's reads go through the same `read_file`, the same boundary checks, the same
 * `recordAll` door. Grounding then checks every citation against the ledger, so the
 * model's own text can never be the thing that authorises a citation. If it claims
 * to have read a file that was never opened, the citation is dropped and the claim
 * is recorded as unsupported — visibly, in the audit and in the trajectory.
 *
 * Iteration 3 adds one deterministic step between synthesis and grounding. The model
 * chose *which* of its evidence to cite, and iteration 2's two remaining failures were
 * both that choice going wrong rather than the retrieval: a correct answer, a grounded
 * citation, the wrong source. The precision pass revisits that choice using nothing but
 * the citations and the ledger — it opens no file and calls no model — and grounding
 * still has the last word on everything it produces.
 */

export const ADVANCED_SYSTEM_NAME = "advanced";
export const ADVANCED_VERSION = "0.1.0";

export interface RunAdvancedOptions {
  repositoryPath: string;
  config: AnalysisConfig;
  /** Defaults to the budget from environment and defaults. */
  budget?: ExplorationBudget;
  /**
   * How the post-synthesis precision pass is allowed to edit citations. Defaults to
   * the policy from environment and defaults; set `maxCorroborations: 0` to run the
   * pass in hygiene-only mode, which is iteration 3's control condition.
   */
  precisionPolicy?: PrecisionPolicy;
  /** Injectable for tests; defaults to a client built from `config`. */
  client?: LlmClient;
  collectOptions?: CollectOptions;
  /** Injectable for deterministic run ids in tests. */
  now?: () => Date;
  /**
   * A question to aim the scout's search terms at. Reaches here from `--focus`.
   *
   * Not set during evaluation, deliberately. The harness never shows a system the
   * questions it is scored on, so passing them here would hand the advanced system
   * an advantage the baseline does not have and make the comparison meaningless.
   * Without it the scout derives its terms from the repository's own documentation,
   * which is the configuration every measured number in the changelog comes from.
   */
  focus?: string | undefined;
  /**
   * Receives the finished evidence ledger — sources *with their text* — once the run
   * has stopped gathering evidence.
   *
   * The run record carries only source metadata (`meta.contextSources`), which is
   * enough to audit a run but not enough to serve a citation back to a reader or to
   * ground a later question against the same evidence. A consumer that needs the bytes
   * asks for them here rather than replaying the run to re-derive them, which could
   * silently produce a *different* ledger under a different budget.
   *
   * Strictly an observation: it is called after the ledger is final, it cannot add to
   * it, and nothing downstream of it reads the callback's return value. A run with no
   * callback behaves identically to one before this option existed.
   */
  onSources?: ((sources: readonly ContextSourceText[]) => void) | undefined;
}

export async function runAdvanced(options: RunAdvancedOptions): Promise<RunRecord> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const trajectory = new TrajectoryRecorder(() => now().getTime());
  const budget = options.budget ?? loadExplorationBudget();
  const precisionPolicy = options.precisionPolicy ?? loadPrecisionPolicy();

  const client = options.client ?? createLlmClient(options.config);
  if (!client.generateWithTools) {
    throw new ConfigError(
      `The "${client.provider}" provider does not support tool use, which the advanced system requires.`,
      'Use the Gemini provider, or run with "--mock" for an offline tool trajectory.',
    );
  }

  // 1. Reconnaissance: the same shallow context the baseline gets, and the
  //    starting contents of the evidence ledger.
  const context = collectRepositoryContext(options.repositoryPath, options.collectOptions);
  const ledger = new EvidenceLedger(context.sources);
  trajectory.step("collect-context", {
    sources: context.sources.map((source) => source.id),
    files: context.repository.fileCount,
    directories: context.repository.directoryCount,
  });

  const toolContext = { repositoryRoot: context.absolutePath, budget };
  const usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const callsByTool: Record<string, number> = {};
  const filesRead: string[] = [];

  let toolCalls = 0;
  let failedToolCalls = 0;
  let bytesFromTools = 0;

  // 2. The Evidence Scout: deterministic search, ranking and reading, with no model
  //    in the loop. It runs first so that the model is reasoning about evidence
  //    rather than about which filename to guess.
  const scout = runEvidenceScout(toolContext, {
    focus: options.focus,
    sources: context.sources,
    repositoryName: context.repository.name,
  });

  trajectory.step("scout-search", {
    terms: scout.terms.map((term) => ({ term: term.term, origin: term.origin, weight: term.weight })),
    searches: scout.searches,
    // Every file the search reached and how it scored — including the ones that lost.
    // What the ranking rejected is the half of its reasoning that is otherwise
    // unrecoverable after the fact.
    candidates: scout.candidates.map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
      reasons: candidate.reasons,
    })),
  });

  // The scout's artefacts enter through `recordAll`, exactly like the model's own
  // tool results. There is no second door into the ledger and no privileged one.
  for (const artifact of scout.artifacts) {
    bytesFromTools += artifact.bytes;
    if (artifact.type === "file" && !filesRead.includes(artifact.id)) filesRead.push(artifact.id);
  }
  ledger.recordAll(scout.artifacts);

  trajectory.step("scout-read", {
    reads: scout.reads,
    summary: scout.summary,
    ledgerSources: ledger.toArray().length,
  });

  const reconPrompt = buildReconnaissancePrompt({
    repositoryName: context.repository.name,
    sources: context.sources,
    budget,
    scoutEvidence: scout.evidence,
  });
  trajectory.step("build-recon-prompt", {
    promptChars: reconPrompt.length,
    scoutEvidenceChars: scout.evidence.length,
    budget: { ...budget },
  });

  // 3. The exploration loop.
  const conversation: ConversationStep[] = [{ kind: "user", text: reconPrompt }];

  let turns = 0;
  let budgetExhausted = false;
  let lastModel = client.model;

  for (let turn = 1; turn <= budget.maxTurns; turn += 1) {
    turns = turn;
    const response = await client.generateWithTools({
      systemInstruction: ADVANCED_SYSTEM_INSTRUCTION,
      steps: conversation,
      tools: TOOL_DEFINITIONS,
    });
    lastModel = response.model;
    addUsage(usageTotal, response.usage);

    trajectory.step(
      "model-turn",
      {
        turn,
        provider: client.provider,
        requestedTools: response.toolCalls.map((call) => call.name),
        responseChars: response.text.length,
        // The model's own words, kept verbatim and separately from tool output, so
        // a reader can see what it believed at each point.
        modelText: response.text,
      },
      { usage: response.usage },
    );

    // A model turn has to *open* with its thought block: Gemini rejects a replayed
    // turn that puts prose or a function call first ("Model turns with thought
    // summaries must start with a thought block"). So the provider's continuation
    // tokens go in ahead of everything the model said on this turn. They are
    // opaque — never read, never cited, never counted as evidence.
    for (const payload of response.providerSteps) {
      conversation.push({ kind: "providerStep", payload });
    }
    if (response.text !== "") conversation.push({ kind: "model", text: response.text });
    if (response.toolCalls.length === 0) break;

    // Gemini models a turn as *all* of its function calls followed by *all* of their
    // results. Replaying them in the order they actually happened — call, result,
    // call, result — is rejected with "400 Request contains an invalid argument", so
    // the two kinds are collected here and appended in the provider's arrangement
    // once the turn is done. Nothing else moves: tools still execute in the order the
    // model asked for them, and the ledger and trajectory still record them that way.
    const callSteps: ConversationStep[] = [];
    const resultSteps: ConversationStep[] = [];

    for (const call of response.toolCalls) {
      // Recorded even when the call is about to be refused. The model made it, so the
      // history has to contain it: a function result whose call is missing is a
      // malformed turn, not a shorter one.
      callSteps.push({ kind: "toolCall", id: call.id, name: call.name, arguments: normalizeForHistory(call) });

      if (toolCalls >= budget.maxToolCalls) {
        budgetExhausted = true;
        // Told, not silently ignored: an unanswered call would leave the model
        // waiting for a result that never comes.
        resultSteps.push({
          kind: "toolResult",
          callId: call.id,
          name: call.name,
          output: `ERROR: exploration budget exhausted after ${toolCalls} tool calls. No further tool calls are possible; answer with what you have.`,
          isError: true,
        });
        trajectory.step("budget-exhausted", { attemptedTool: call.name, toolCalls }, { tool: call.name, ok: false });
        continue;
      }

      const outcome = executeTool(toolContext, call);
      toolCalls += 1;
      callsByTool[call.name] = (callsByTool[call.name] ?? 0) + 1;
      if (outcome.isError) failedToolCalls += 1;

      // The ledger only ever grows from a real tool result. This line is the whole
      // guarantee: there is no other path into it.
      for (const artifact of outcome.artifacts) {
        bytesFromTools += artifact.bytes;
        if (artifact.type === "file" && !filesRead.includes(artifact.id)) filesRead.push(artifact.id);
      }
      ledger.recordAll(outcome.artifacts);

      recordToolStep(trajectory, call, outcome);
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

  // 4. Synthesis: no tools, strict schema, and a closed list of citable ids.
  const citableIds = ledger.toArray().map((source) => source.id);
  const synthesisPrompt = buildSynthesisPrompt({ citableIds, filesRead, budgetExhausted });
  conversation.push({ kind: "user", text: synthesisPrompt });
  trajectory.step("build-synthesis-prompt", {
    citableIds,
    filesRead,
    budgetExhausted,
    conversationSteps: conversation.length,
  });

  const finalResponse = await client.generateWithTools({
    systemInstruction: ADVANCED_SYSTEM_INSTRUCTION,
    steps: conversation,
    tools: [],
    schema: ADVANCED_RESPONSE_SCHEMA,
  });
  turns += 1;
  lastModel = finalResponse.model;
  addUsage(usageTotal, finalResponse.usage);
  trajectory.step(
    "synthesis-call",
    { provider: client.provider, model: finalResponse.model, responseChars: finalResponse.text.length },
    { usage: finalResponse.usage },
  );

  if (finalResponse.text.trim() === "") {
    throw new ModelError(
      "The model returned no briefing on the synthesis turn.",
      "Raise REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS, or lower REPO_ARCHAEOLOGIST_MAX_TOOL_CALLS so less of the budget goes on tool output.",
    );
  }

  // 5. Parse and validate.
  const parsed = parseModelJson(finalResponse.text);
  const body = validateWithSchema(AnalysisBodySchema, parsed, "model analysis");
  trajectory.step("validate-schema", {
    components: body.components.length,
    flows: body.flows.length,
    risks: body.risks.length,
  });

  // 6. Evidence precision, over the citations the model produced and the ledger it
  //    produced them from. Deterministic, no model call, and no file opened: it
  //    removes citations another citation already carries and attaches ledger
  //    artefacts the model had but did not cite. Grounding still runs afterwards,
  //    so nothing here can put an unverifiable citation into the briefing.
  const sources = ledger.toArray();
  options.onSources?.(sources);
  const { body: refinedBody, summary: precision } = applyEvidencePrecision(body, sources, precisionPolicy);
  trajectory.step("refine-evidence", { ...precision });

  // 7. Grounding, against the ledger rather than against the initial context.
  const { body: groundedBody, audit } = groundAnalysis(refinedBody, sources);
  trajectory.step("ground-evidence", {
    ledgerSources: sources.length,
    claimed: audit.claimed,
    grounded: audit.grounded,
    dropped: audit.dropped,
    unsupportedClaims: audit.unsupportedClaims,
  });

  const finishedAt = now();
  const result = validateWithSchema(
    AnalysisResultSchema,
    { ...groundedBody, repository: context.repository },
    "analysis result",
  );

  const exploration: ExplorationSummary = {
    turns,
    // The model's own calls only. The scout's are reported beside them rather than
    // added in: mixing a fixed cost into a discretionary budget would make "the agent
    // explored more this iteration" unreadable from the numbers.
    toolCalls,
    failedToolCalls,
    callsByTool,
    // Both systems' reads, because the ledger does not distinguish them and neither
    // does grounding. This is the count that says how much of the repository the
    // briefing was actually written from.
    filesRead,
    bytesFromTools,
    budgetExhausted,
    budget: { ...budget },
    scout: scout.summary,
    precision,
  };

  const record: RunRecord = {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    meta: {
      runId: buildRunId(context.repository.name, startedAt),
      system: ADVANCED_SYSTEM_NAME,
      systemVersion: ADVANCED_VERSION,
      provider: client.provider,
      model: lastModel,
      seed: options.config.seed,
      thinkingLevel: options.config.thinkingLevel,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      usage: usageTotal,
      estimatedCostUsd: estimateCostUsd(lastModel, usageTotal),
      // Every source the model was allowed to cite, reconnaissance and tool-earned
      // alike, with the tool-earned ones distinguishable by `type: "file"`.
      contextSources: sources.map((source: ContextSourceText) => ({
        id: source.id,
        type: source.type,
        bytes: source.bytes,
        truncated: source.truncated,
      })),
      evidenceAudit: audit,
      nodeVersion: process.version,
      exploration,
    },
    result,
    trajectory: trajectory.toJSON(),
  };

  return validateWithSchema(RunRecordSchema, record, "run record");
}

export function buildRunId(repositoryName: string, at: Date): string {
  return `${ADVANCED_SYSTEM_NAME}-${slugify(repositoryName)}-${timestampSlug(at)}`;
}

function addUsage(total: TokenUsage, next: TokenUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.totalTokens += next.totalTokens;
}

/**
 * Records the call and its result as one step.
 *
 * `toolArgs` is what the model asked for and `toolResult` is what the filesystem
 * returned; both are redacted and truncated by the recorder. `summary` carries the
 * counts, so the trajectory stays auditable even where the output was trimmed.
 */
function recordToolStep(trajectory: TrajectoryRecorder, call: ToolCall, outcome: { output: string; isError: boolean; summary: Record<string, unknown>; artifacts: readonly ContextSourceText[] }): void {
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
    {
      tool: call.name,
      toolArgs: call.arguments,
      toolResult: outcome.output,
      ok: !outcome.isError,
    },
  );
}

/** Arguments as recorded in the replayed conversation: an object, whatever arrived. */
function normalizeForHistory(call: ToolCall): Record<string, unknown> {
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

export {
  ADVANCED_RESPONSE_SCHEMA,
  ADVANCED_SYSTEM_INSTRUCTION,
  buildReconnaissancePrompt,
  buildSynthesisPrompt,
} from "./prompt";
