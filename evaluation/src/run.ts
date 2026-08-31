import path from "node:path";
import { ADVANCED_SYSTEM_NAME, ADVANCED_VERSION, runAdvanced } from "@repo-arch/advanced";
import {
  BASELINE_SYSTEM_NAME,
  BASELINE_VERSION,
  runBaseline,
} from "@repo-arch/baseline";
import {
  aggregate,
  failedCase,
  loadCases,
  renderEvaluationMarkdown,
  scoreCase,
  type CaseScore,
  type EvaluationReport,
  type LoadedCase,
} from "@repo-arch/evaluator";
import {
  EvaluationError,
  createLlmClient,
  formatError,
  loadExplorationBudget,
  timestampSlug,
  writeJsonFile,
  writeTextFile,
  type AnalysisConfig,
  type ExplorationBudget,
  type LlmClient,
  type RunRecord,
} from "@repo-arch/shared";

/**
 * The evaluation runner.
 *
 * Cases run sequentially and in sorted order: it keeps the run reproducible,
 * keeps the log readable, and avoids tripping provider rate limits. The briefing
 * for each case is produced *blind* — the analyzer never sees the questions — so
 * the harness measures understanding rather than test-taking.
 *
 * Both systems run through this same path: the same cases, the same scorer, the
 * same report. `runSystem` is the only place that knows which one is executing,
 * and everything downstream of it — scoring, aggregation, rendering — is handed a
 * `RunRecord` with no indication of where it came from. That is what keeps the
 * comparison honest: the evaluator cannot score the advanced system differently,
 * because it cannot tell.
 */

export const DEFAULT_CASES_DIR = "evaluation/cases";
export const DEFAULT_RESULTS_DIR = "evaluation/results";

/** Systems this harness can run. Adding one means adding a branch in `runSystem`. */
export const EVALUABLE_SYSTEMS = [BASELINE_SYSTEM_NAME, ADVANCED_SYSTEM_NAME] as const;

const SYSTEM_VERSIONS: Record<string, string> = {
  [BASELINE_SYSTEM_NAME]: BASELINE_VERSION,
  [ADVANCED_SYSTEM_NAME]: ADVANCED_VERSION,
};

export interface EvaluationRunOptions {
  /** Which system to evaluate: "baseline" or "advanced". */
  system?: string;
  casesDir?: string;
  resultsDir?: string;
  /** When set, each case's trajectory + run record is written here. */
  trajectoryDir?: string;
  config: AnalysisConfig;
  /** Injectable for tests, so scoring can be exercised without a network call. */
  client?: LlmClient;
  /** Restrict the run to specific case ids. */
  caseIds?: readonly string[];
  /** Exploration limits for the advanced system. Ignored by the baseline. */
  budget?: ExplorationBudget;
  /**
   * Seconds to wait between cases. Zero by default; raise it when a provider's
   * per-minute quota is the binding constraint rather than the model.
   */
  caseDelaySeconds?: number;
  now?: () => Date;
  /** Progress sink. Defaults to silence, so library use prints nothing. */
  logger?: (message: string) => void;
}

export interface EvaluationRunOutput {
  report: EvaluationReport;
  markdown: string;
  /** Paths written, relative to the working directory. */
  jsonPath: string;
  markdownPath: string;
}

export async function runEvaluation(options: EvaluationRunOptions): Promise<EvaluationRunOutput> {
  const system = options.system ?? BASELINE_SYSTEM_NAME;
  if (!(EVALUABLE_SYSTEMS as readonly string[]).includes(system)) {
    throw new EvaluationError(
      `Unknown system "${system}".`,
      `Available systems: ${EVALUABLE_SYSTEMS.join(", ")}.`,
    );
  }

  const log = options.logger ?? ((): void => {});
  const now = options.now ?? ((): Date => new Date());
  const casesDir = options.casesDir ?? DEFAULT_CASES_DIR;
  const resultsDir = options.resultsDir ?? DEFAULT_RESULTS_DIR;

  const loaded = loadCases(casesDir, { filterIds: options.caseIds });
  const startedAt = now();
  const runId = `eval-${system}-${timestampSlug(startedAt)}`;

  log(`${runId}: ${loaded.length} case(s) from ${casesDir} against ${options.config.provider}/${options.config.model}`);

  // One client for the whole run, so token usage and cost accumulate against a
  // single provider/model pair rather than a per-case guess.
  const client = options.client ?? createLlmClient(options.config);
  const budget = options.budget ?? loadExplorationBudget();
  const caseDelayMs = Math.max(options.caseDelaySeconds ?? 0, 0) * 1_000;

  const scores: CaseScore[] = [];
  for (const [index, entry] of loaded.entries()) {
    if (index > 0 && caseDelayMs > 0) {
      log(`    waiting ${caseDelayMs / 1_000}s before the next case`);
      await delay(caseDelayMs);
    }
    log(`[${index + 1}/${loaded.length}] ${entry.case.id} — ${entry.case.repository}`);
    const score = await evaluateCase(entry, { ...options, client, now, system, budget });
    scores.push(score);
    log(
      score.error === undefined
        ? `    ${score.totals.evidenceBacked}/${score.totals.questions} evidence-backed, ` +
            `${score.totals.correct}/${score.totals.questions} correct`
        : `    failed: ${score.error}`,
    );
  }

  const report = aggregate({
    runId,
    system,
    systemVersion: SYSTEM_VERSIONS[system] ?? "unknown",
    provider: client.provider,
    model: client.model,
    seed: options.config.seed,
    thinkingLevel: options.config.thinkingLevel,
    startedAt,
    finishedAt: now(),
    cases: scores,
    caveats: buildCaveats(client, loaded),
  });

  const markdown = renderEvaluationMarkdown(report);
  const jsonPath = path.join(resultsDir, `${runId}.json`);
  const markdownPath = path.join(resultsDir, `${runId}.md`);
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, markdown);

  // A stable filename for the most recent run, so tooling and the README can
  // point at one path. The timestamped files remain the history.
  writeJsonFile(path.join(resultsDir, `latest-${system}.json`), report);
  writeTextFile(path.join(resultsDir, `latest-${system}.md`), markdown);

  return { report, markdown, jsonPath, markdownPath };
}

interface CaseRunContext extends EvaluationRunOptions {
  client: LlmClient;
  now: () => Date;
  system: string;
  budget: ExplorationBudget;
}

/**
 * The only branch on system identity in the whole harness.
 *
 * Both branches return a `RunRecord` and nothing downstream inspects `meta.system`
 * when scoring, so neither system can be scored on different terms from the other.
 */
function runSystem(entry: LoadedCase, context: CaseRunContext): Promise<RunRecord> {
  const shared = {
    repositoryPath: entry.case.repository,
    config: context.config,
    client: context.client,
    now: context.now,
  };
  return context.system === ADVANCED_SYSTEM_NAME
    ? runAdvanced({ ...shared, budget: context.budget })
    : runBaseline(shared);
}

async function evaluateCase(entry: LoadedCase, context: CaseRunContext): Promise<CaseScore> {
  const startedAt = context.now().getTime();
  let record: RunRecord;
  try {
    record = await runSystem(entry, context);
  } catch (error) {
    // A crash is a result, not an excuse to shrink the denominator.
    return failedCase(entry.case, formatError(error), context.now().getTime() - startedAt);
  }

  if (context.trajectoryDir !== undefined) {
    writeJsonFile(path.join(context.trajectoryDir, `${record.meta.runId}.json`), record);
  }

  return scoreCase(entry.case, record);
}

function buildCaveats(client: LlmClient, loaded: readonly LoadedCase[]): string[] {
  const caveats: string[] = [];
  if (client.provider === "mock") {
    caveats.push(
      "This run used the offline **mock** provider. The numbers below verify that the pipeline works end to end; " +
        "they are not a measurement of any real system's quality.",
    );
  }
  const questionCount = loaded.reduce((total, entry) => total + entry.case.questions.length, 0);
  if (loaded.length < 5 || questionCount < 20) {
    caveats.push(
      `The dataset is small (${loaded.length} case(s), ${questionCount} question(s)). ` +
        "Percentages move in large steps; read them as directional, not as a benchmark.",
    );
  }
  return caveats;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
