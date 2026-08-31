import {
  AnalysisBodySchema,
  AnalysisResultSchema,
  RUN_RECORD_SCHEMA_VERSION,
  RunRecordSchema,
  TrajectoryRecorder,
  collectRepositoryContext,
  createLlmClient,
  estimateCostUsd,
  groundAnalysis,
  parseModelJson,
  slugify,
  timestampSlug,
  validateWithSchema,
  type AnalysisConfig,
  type CollectOptions,
  type LlmClient,
  type RunRecord,
} from "@repo-arch/shared";
import { ANALYSIS_RESPONSE_SCHEMA, BASELINE_SYSTEM_INSTRUCTION, buildBaselinePrompt } from "./prompt";

/**
 * The baseline system.
 *
 * Deliberately shallow: one pass, one model call, shallow context. It does not
 * read source files, run tests, inspect git history, or verify anything. That is
 * the point — it is the honest measurement of "point an LLM at a repository and
 * ask nicely", which is what the advanced agent has to beat.
 *
 * The one thing it does not do is fabricate. Every citation is checked against
 * the context it received, and anything unverifiable is stripped and audited.
 */

export const BASELINE_SYSTEM_NAME = "baseline";
export const BASELINE_VERSION = "0.1.0";

export interface RunBaselineOptions {
  repositoryPath: string;
  config: AnalysisConfig;
  /** Injectable for tests; defaults to a client built from `config`. */
  client?: LlmClient;
  collectOptions?: CollectOptions;
  /** Injectable for deterministic run ids in tests. */
  now?: () => Date;
}

export async function runBaseline(options: RunBaselineOptions): Promise<RunRecord> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const trajectory = new TrajectoryRecorder(() => now().getTime());

  // 1. Shallow context collection — the baseline's entire view of the repository.
  const context = collectRepositoryContext(options.repositoryPath, options.collectOptions);
  trajectory.step("collect-context", {
    sources: context.sources.map((source) => source.id),
    files: context.repository.fileCount,
    directories: context.repository.directoryCount,
  });

  // 2. One prompt. No tools, no follow-up turns.
  const prompt = buildBaselinePrompt({ repositoryName: context.repository.name, sources: context.sources });
  trajectory.step("build-prompt", { promptChars: prompt.length });

  const client = options.client ?? createLlmClient(options.config);

  // 3. One model call.
  const response = await client.generateStructured({
    systemInstruction: BASELINE_SYSTEM_INSTRUCTION,
    input: prompt,
    schema: ANALYSIS_RESPONSE_SCHEMA,
  });
  trajectory.step("model-call", {
    provider: client.provider,
    model: response.model,
    usage: response.usage,
    responseChars: response.text.length,
  });

  // 4. Parse and validate. A malformed response fails loudly rather than
  //    degrading into a partially-populated briefing.
  const parsed = parseModelJson(response.text);
  const body = validateWithSchema(AnalysisBodySchema, parsed, "model analysis");
  trajectory.step("validate-schema", {
    components: body.components.length,
    flows: body.flows.length,
    risks: body.risks.length,
  });

  // 5. Grounding: drop every citation the system cannot prove it received.
  const { body: groundedBody, audit } = groundAnalysis(body, context.sources);
  trajectory.step("ground-evidence", {
    claimed: audit.claimed,
    grounded: audit.grounded,
    dropped: audit.dropped.length,
    unsupportedClaims: audit.unsupportedClaims,
  });

  const finishedAt = now();
  const result = validateWithSchema(
    AnalysisResultSchema,
    { ...groundedBody, repository: context.repository },
    "analysis result",
  );

  const record: RunRecord = {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    meta: {
      runId: buildRunId(context.repository.name, startedAt),
      system: BASELINE_SYSTEM_NAME,
      systemVersion: BASELINE_VERSION,
      provider: client.provider,
      model: response.model,
      seed: options.config.seed,
      thinkingLevel: options.config.thinkingLevel,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      usage: response.usage,
      estimatedCostUsd: estimateCostUsd(response.model, response.usage),
      contextSources: context.sources.map((source) => ({
        id: source.id,
        type: source.type,
        bytes: source.bytes,
        truncated: source.truncated,
      })),
      evidenceAudit: audit,
      nodeVersion: process.version,
    },
    result,
    trajectory: trajectory.toJSON(),
  };

  // Validate our own output too: the run record is the artefact everything
  // downstream reads, so a bug here should surface at the source.
  return validateWithSchema(RunRecordSchema, record, "run record");
}

export function buildRunId(repositoryName: string, at: Date): string {
  return `${BASELINE_SYSTEM_NAME}-${slugify(repositoryName)}-${timestampSlug(at)}`;
}

export { ANALYSIS_RESPONSE_SCHEMA, BASELINE_SYSTEM_INSTRUCTION, buildBaselinePrompt } from "./prompt";
// Re-exported for callers that already import the renderer from here. It now lives
// in `shared` because both systems produce the `RunRecord` it renders.
export { renderBriefingMarkdown } from "@repo-arch/shared";
