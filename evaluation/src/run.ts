import { existsSync } from "node:fs";
import path from "node:path";
import { ADVANCED_SYSTEM_NAME, ADVANCED_VERSION, runAdvanced } from "@repo-arch/advanced";
import {
  BASELINE_SYSTEM_NAME,
  BASELINE_VERSION,
  runBaseline,
} from "@repo-arch/baseline";
import {
  aggregate,
  aggregateBenchmark,
  failedCase,
  loadBenchmark,
  loadCases,
  renderBenchmarkMarkdown,
  renderEvaluationMarkdown,
  scoreCase,
  type Benchmark,
  type BenchmarkRunReport,
  type CaseScore,
  type EvaluationReport,
  type LoadedCase,
} from "@repo-arch/evaluator";
import {
  EvaluationError,
  createLlmClient,
  formatError,
  loadExplorationBudget,
  loadPrecisionPolicy,
  resolveProvenance,
  timestampSlug,
  writeJsonFile,
  writeTextFile,
  type AnalysisConfig,
  type ExplorationBudget,
  type LlmClient,
  type PrecisionPolicy,
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
 *
 * Three identities are recorded with every run and none of them stands in for
 * another: the **system version** (what code ran), the **provenance** (where in
 * the development process the run originated) and the **benchmark version** (the
 * dataset it was measured against). The benchmark manifest sits beside the cases
 * directory; when it is absent — an ad-hoc case directory, a test fixture — the
 * run still happens and produces the older report shape, which declares no
 * benchmark rather than claiming one it did not use.
 */

export const DEFAULT_CASES_DIR = "evaluation/cases";
export const DEFAULT_RESULTS_DIR = "evaluation/results";

/** The manifest filename, looked for beside the cases directory. */
export const BENCHMARK_MANIFEST_NAME = "benchmark.json";

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
  /** Citation policy for the advanced system's precision pass. Ignored by the baseline. */
  precisionPolicy?: PrecisionPolicy;
  /**
   * Seconds to wait between cases. Zero by default; raise it when a provider's
   * per-minute quota is the binding constraint rather than the model.
   */
  caseDelaySeconds?: number;
  /**
   * Where this run originated in the development process — `iteration-6-baseline`,
   * `ci-nightly`. Falls back to `REPO_ARCHAEOLOGIST_PROVENANCE`, then to
   * `unlabelled`. Never a system version and never a dataset version.
   */
  provenance?: string;
  /**
   * The benchmark manifest. Defaults to `benchmark.json` beside the cases
   * directory. Pass `null` to run without one, which produces the older report
   * shape rather than a report that claims a benchmark it did not use.
   */
  benchmark?: Benchmark | null;
  now?: () => Date;
  /** Progress sink. Defaults to silence, so library use prints nothing. */
  logger?: (message: string) => void;
}

export interface EvaluationRunOutput {
  /**
   * A `BenchmarkRunReport` when a manifest was in play, an `EvaluationReport`
   * otherwise. Both carry the same metrics computed by the same aggregator; the
   * benchmark shape adds the three identities and the per-set split.
   */
  report: EvaluationReport | BenchmarkRunReport;
  /** The same object as `report`, narrowed, or null when no manifest was used. */
  benchmarkReport: BenchmarkRunReport | null;
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

  // Resolved before anything expensive happens: a malformed label should fail the
  // run in the first millisecond, not after paying for thirty-eight questions.
  const provenance = resolveProvenance(options.provenance);
  const benchmark = resolveBenchmark(options, casesDir);

  const loaded = loadCases(casesDir, { filterIds: options.caseIds });
  const startedAt = now();
  const runId = `eval-${system}-${timestampSlug(startedAt)}`;

  log(`${runId}: ${loaded.length} case(s) from ${casesDir} against ${options.config.provider}/${options.config.model}`);
  log(
    `  system ${SYSTEM_VERSIONS[system] ?? "unknown"} · provenance ${provenance} · ` +
      `benchmark ${
        benchmark === null
          ? `none (no ${BENCHMARK_MANIFEST_NAME} beside ${casesDir})`
          : `${benchmark.name} ${benchmark.version}`
      }`,
  );

  // One client for the whole run, so token usage and cost accumulate against a
  // single provider/model pair rather than a per-case guess.
  const client = options.client ?? createLlmClient(options.config);
  const budget = options.budget ?? loadExplorationBudget();
  const precisionPolicy = options.precisionPolicy ?? loadPrecisionPolicy();
  const caseDelayMs = Math.max(options.caseDelaySeconds ?? 0, 0) * 1_000;

  const scores: CaseScore[] = [];
  for (const [index, entry] of loaded.entries()) {
    if (index > 0 && caseDelayMs > 0) {
      log(`    waiting ${caseDelayMs / 1_000}s before the next case`);
      await delay(caseDelayMs);
    }
    log(`[${index + 1}/${loaded.length}] ${entry.case.id} — ${entry.case.repository}`);
    const score = await evaluateCase(entry, { ...options, client, now, system, budget, precisionPolicy });
    scores.push(score);
    log(
      score.error === undefined
        ? `    ${score.totals.evidenceBacked}/${score.totals.questions} evidence-backed, ` +
            `${score.totals.correct}/${score.totals.questions} correct`
        : `    failed: ${score.error}`,
    );
  }

  // One aggregation, either way. The benchmark report is the evaluation report
  // plus identity and the per-set split — it does not recompute a metric, so a
  // combined figure means the same thing whether or not a manifest was present.
  const aggregateInput = {
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
    caveats: buildCaveats(client, loaded, benchmark),
  };

  let benchmarkReport: BenchmarkRunReport | null = null;
  let report: EvaluationReport | BenchmarkRunReport;
  let markdown: string;
  if (benchmark === null) {
    report = aggregate(aggregateInput);
    markdown = renderEvaluationMarkdown(report);
  } else {
    benchmarkReport = aggregateBenchmark({ ...aggregateInput, benchmark, provenance });
    report = benchmarkReport;
    markdown = renderBenchmarkMarkdown(benchmarkReport);
  }

  const jsonPath = path.join(resultsDir, `${runId}.json`);
  const markdownPath = path.join(resultsDir, `${runId}.md`);
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, markdown);

  // A stable filename for the most recent run, so tooling and the README can
  // point at one path. The timestamped files remain the history.
  writeJsonFile(path.join(resultsDir, `latest-${system}.json`), report);
  writeTextFile(path.join(resultsDir, `latest-${system}.md`), markdown);

  return { report, benchmarkReport, markdown, jsonPath, markdownPath };
}

/**
 * Finds the benchmark manifest, which lives beside the cases directory.
 *
 * A missing manifest is not an error: an ad-hoc case directory is a legitimate
 * way to run the harness, and the result then declares no benchmark rather than
 * borrowing the identity of one it did not use. A manifest that *is* there and
 * disagrees with the cases is an error, because that is the case where a
 * denominator would silently be wrong.
 *
 * Deliberately silent — the caller reports the outcome on the identity line, so
 * that the first line of the log stays the run header.
 */
function resolveBenchmark(options: EvaluationRunOptions, casesDir: string): Benchmark | null {
  if (options.benchmark !== undefined) return options.benchmark;
  const manifestFile = path.join(path.dirname(casesDir), BENCHMARK_MANIFEST_NAME);
  if (!existsSync(manifestFile)) return null;
  return loadBenchmark({ casesDirectory: casesDir, manifestFile });
}

interface CaseRunContext extends EvaluationRunOptions {
  client: LlmClient;
  now: () => Date;
  system: string;
  budget: ExplorationBudget;
  precisionPolicy: PrecisionPolicy;
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
    ? runAdvanced({ ...shared, budget: context.budget, precisionPolicy: context.precisionPolicy })
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

function buildCaveats(
  client: LlmClient,
  loaded: readonly LoadedCase[],
  benchmark: Benchmark | null,
): string[] {
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
  // A partial run is the easiest way to publish a misleading percentage, so it is
  // said out loud rather than left to be inferred from a denominator.
  if (benchmark !== null && questionCount !== benchmark.counts.total) {
    caveats.push(
      `This run covered ${questionCount} of the ${benchmark.counts.total} questions in ` +
        `${benchmark.name} ${benchmark.version}. The percentages are over what ran, not over the benchmark.`,
    );
  }
  return caveats;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
