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
  collectRepositoryContext,
  createLlmClient,
  estimateCostUsd,
  executeTool,
  groundAnalysis,
  loadExplorationBudget,
  parseModelJson,
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
  type RunRecord,
  type TokenUsage,
  type ToolCall,
} from "@repo-arch/shared";
import { ADVANCED_RESPONSE_SCHEMA, ADVANCED_SYSTEM_INSTRUCTION, buildReconnaissancePrompt, buildSynthesisPrompt } from "./prompt";

/**
 * The advanced system, iteration 1: targeted repository exploration.
 *
 * Same shape as the baseline — repository in, grounded run record out — with one
 * structural change in the middle. Instead of a single call over shallow context,
 * the model gets that context plus three read-only tools, and a bounded number of
 * turns in which to close the gaps it identifies.
 *
 * The property that makes this trustworthy is the evidence ledger. It starts as
 * the reconnaissance context and grows only when a tool actually returns bytes.
 * Grounding then checks every citation against the ledger, so the model's own text
 * can never be the thing that authorises a citation. If it claims to have read a
 * file it never opened, the citation is dropped and the claim is recorded as
 * unsupported — visibly, in the audit and in the trajectory.
 */

export const ADVANCED_SYSTEM_NAME = "advanced";
export const ADVANCED_VERSION = "0.1.0";

export interface RunAdvancedOptions {
  repositoryPath: string;
  config: AnalysisConfig;
  /** Defaults to the budget from environment and defaults. */
  budget?: ExplorationBudget;
  /** Injectable for tests; defaults to a client built from `config`. */
  client?: LlmClient;
  collectOptions?: CollectOptions;
  /** Injectable for deterministic run ids in tests. */
  now?: () => Date;
}

export async function runAdvanced(options: RunAdvancedOptions): Promise<RunRecord> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const trajectory = new TrajectoryRecorder(() => now().getTime());
  const budget = options.budget ?? loadExplorationBudget();

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

  const reconPrompt = buildReconnaissancePrompt({
    repositoryName: context.repository.name,
    sources: context.sources,
    budget,
  });
  trajectory.step("build-recon-prompt", { promptChars: reconPrompt.length, budget: { ...budget } });

  // 2. The exploration loop.
  const conversation: ConversationStep[] = [{ kind: "user", text: reconPrompt }];
  const toolContext = { repositoryRoot: context.absolutePath, budget };
  const usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const callsByTool: Record<string, number> = {};
  const filesRead: string[] = [];

  let turns = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let bytesFromTools = 0;
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

    for (const call of response.toolCalls) {
      if (toolCalls >= budget.maxToolCalls) {
        budgetExhausted = true;
        // Told, not silently ignored: an unanswered call would leave the model
        // waiting for a result that never comes.
        conversation.push({
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
      conversation.push({ kind: "toolCall", id: call.id, name: call.name, arguments: normalizeForHistory(call) });
      conversation.push({
        kind: "toolResult",
        callId: call.id,
        name: call.name,
        output: outcome.output,
        isError: outcome.isError,
      });
    }

    if (toolCalls >= budget.maxToolCalls) budgetExhausted = true;
    if (turn === budget.maxTurns) budgetExhausted = true;
  }

  // 3. Synthesis: no tools, strict schema, and a closed list of citable ids.
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

  // 4. Parse and validate.
  const parsed = parseModelJson(finalResponse.text);
  const body = validateWithSchema(AnalysisBodySchema, parsed, "model analysis");
  trajectory.step("validate-schema", {
    components: body.components.length,
    flows: body.flows.length,
    risks: body.risks.length,
  });

  // 5. Grounding, against the ledger rather than against the initial context.
  const sources = ledger.toArray();
  const { body: groundedBody, audit } = groundAnalysis(body, sources);
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
    toolCalls,
    failedToolCalls,
    callsByTool,
    filesRead,
    bytesFromTools,
    budgetExhausted,
    budget: { ...budget },
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
