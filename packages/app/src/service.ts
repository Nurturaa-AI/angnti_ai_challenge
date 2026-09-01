import path from "node:path";
import { ADVANCED_SYSTEM_NAME, runAdvanced } from "@repo-arch/advanced";
import { BASELINE_SYSTEM_NAME, runBaseline } from "@repo-arch/baseline";
import {
  ConfigError,
  type AnalysisConfig,
  type CollectOptions,
  type ContextSourceText,
  type ExplorationBudget,
  type LlmClient,
  type PrecisionPolicy,
  type RunRecord,
} from "@repo-arch/shared";

/**
 * The one analysis core.
 *
 * Both consumers — the CLI and the web application — reach the pipeline through
 * here, so there is exactly one place that decides which system runs and what a
 * finished analysis consists of. Before this existed the branch lived twice: once in
 * the CLI's `commandAnalyze` and once in the evaluator's `runSystem`. A third copy in
 * the web layer would have been the point at which "the UI analyses repositories
 * slightly differently from the CLI" became true without anyone deciding it.
 *
 * What this deliberately does *not* do is orchestrate. It adds no phase, skips none,
 * and reorders nothing: `runBaseline` and `runAdvanced` still own the pipeline, and
 * this is the seam that hands their output to whoever asked. The one thing it adds is
 * the evidence ledger — see `AnalysisRun.sources`.
 */

export const ANALYSIS_SYSTEMS: readonly string[] = [ADVANCED_SYSTEM_NAME, BASELINE_SYSTEM_NAME];

/** What a caller gets when it does not choose. */
export const DEFAULT_ANALYSIS_SYSTEM: string = ADVANCED_SYSTEM_NAME;

/**
 * True when the system runs the evidence scout, and can therefore be aimed.
 *
 * A predicate rather than a comparison against a name, so a consumer can validate a
 * request without importing a pipeline package. The web layer depends on this package
 * and this package alone; letting it reach into `@repo-arch/advanced` for a string
 * constant is how a second orchestration path starts.
 */
export function systemSupportsFocus(system: string): boolean {
  return system === ADVANCED_SYSTEM_NAME;
}

export interface AnalyzeRepositoryOptions {
  /** Path to the repository. Callers crossing a trust boundary resolve it first. */
  repositoryPath: string;
  /** `"advanced"` (default) or `"baseline"`. */
  system?: string | undefined;
  config: AnalysisConfig;
  /** Advanced only; ignored by the baseline, which has no tools to bound. */
  budget?: ExplorationBudget | undefined;
  /** Advanced only. */
  precisionPolicy?: PrecisionPolicy | undefined;
  /** Injectable for tests; defaults to a client built from `config`. */
  client?: LlmClient | undefined;
  collectOptions?: CollectOptions | undefined;
  /** Injectable for deterministic run ids in tests. */
  now?: (() => Date) | undefined;
  /**
   * Aims the evidence scout at a question. Advanced only.
   *
   * Refused for the baseline rather than ignored, for the same reason the CLI refuses
   * it on `evaluate`: silently dropping it would make a focused request look like it
   * had been honoured.
   */
  focus?: string | undefined;
}

export interface AnalysisRun {
  record: RunRecord;
  /**
   * The evidence ledger, with text: every artefact the run was allowed to cite.
   *
   * Carried alongside the record because the record itself holds only metadata. Two
   * later features need the bytes and neither may guess at them — grounding a question
   * asked after the analysis has to check against the same ledger the briefing was
   * checked against, and the source viewer has to show a citation's real text rather
   * than a re-read of a file that may since have changed.
   */
  sources: ContextSourceText[];
  /**
   * Absolute path to the analysed repository, held in memory only.
   *
   * Never serialised into a report — reports stay portable — but required as the
   * boundary root for any later tool call, which is what makes follow-up questions
   * able to read from the same repository under the same checks.
   */
  repositoryRoot: string;
}

export async function analyzeRepository(options: AnalyzeRepositoryOptions): Promise<AnalysisRun> {
  const system = options.system ?? ADVANCED_SYSTEM_NAME;
  if (!ANALYSIS_SYSTEMS.includes(system)) {
    throw new ConfigError(
      `Unknown analysis system "${system}".`,
      `Expected one of: ${ANALYSIS_SYSTEMS.join(", ")}.`,
    );
  }
  if (options.focus !== undefined && !systemSupportsFocus(system)) {
    throw new ConfigError(
      `A scout focus is only available to the "${ADVANCED_SYSTEM_NAME}" system, not "${system}".`,
      "The baseline makes one call over shallow context and does not search.",
    );
  }

  // Populated by the callback below, before either system returns.
  let sources: ContextSourceText[] = [];
  const captureSources = (captured: readonly ContextSourceText[]): void => {
    sources = captured.map((source) => ({ ...source }));
  };

  const shared = {
    repositoryPath: options.repositoryPath,
    config: options.config,
    client: options.client,
    collectOptions: options.collectOptions,
    now: options.now,
    onSources: captureSources,
  };

  const record =
    system === ADVANCED_SYSTEM_NAME
      ? await runAdvanced({
          ...shared,
          budget: options.budget,
          precisionPolicy: options.precisionPolicy,
          focus: options.focus,
        })
      : await runBaseline(shared);

  return {
    record,
    sources,
    repositoryRoot: path.resolve(options.repositoryPath),
  };
}
