import { z } from "zod";
import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  EvaluationMetricsSchema,
  EvaluationReportSchema,
  aggregate,
  type AggregateInput,
  type EvaluationReport,
} from "./aggregate";
import {
  BENCHMARK_CATEGORIES,
  BENCHMARK_DIFFICULTIES,
  EVIDENCE_KINDS,
  evidenceKind,
  questionKey,
  type Benchmark,
} from "./benchmark";
import { renderEvaluationMarkdown } from "./report";
import { rate, type CaseScore, type QuestionScore } from "./score";

/**
 * A benchmark run report: an evaluation report plus the three identities and the
 * per-set split.
 *
 * Additive on purpose. `aggregate()` and `renderEvaluationMarkdown()` are the
 * code that produced the Iteration 3 numbers, so neither is touched here; the
 * per-set metrics are produced by calling the *same* `aggregate()` on each set's
 * subset of cases, and the per-set markdown is written around
 * `renderEvaluationMarkdown()` rather than inside it. A combined figure computed
 * one way and a per-set figure computed another would not be comparable, and the
 * whole point of reporting them separately is that they are.
 *
 * Three identities travel with the report and none of them substitutes for
 * another:
 *
 *   - `systemVersion`        — what code ran (inherited from the evaluation report)
 *   - `provenance`           — where in the development process the run originated
 *   - `benchmark.version`    — which dataset it was measured against
 *
 * The schema version is 2 rather than 1 precisely so that a historical run cannot
 * be mistaken for one of these. A v1 file declares no benchmark and no
 * provenance; the reader below represents that as *unrecorded* and never invents
 * a value for it.
 */

export const BENCHMARK_REPORT_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const BenchmarkIdentitySchema = z.object({
  name: z.string().min(1),
  /** The dataset identity. Not a system version and not a provenance label. */
  version: z.string().min(1),
  regressionCount: z.number().int().min(0),
  challengeCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  /**
   * How many of the manifest's questions this run actually scored. Present so a
   * partial run (`--case`, a quota cut-off) cannot be read as a full one.
   */
  evaluatedQuestions: z.number().int().min(0),
  /** True only when every question in the manifest was scored. */
  complete: z.boolean(),
});
export type BenchmarkIdentity = z.infer<typeof BenchmarkIdentitySchema>;

// ---------------------------------------------------------------------------
// Per set
// ---------------------------------------------------------------------------

export const BenchmarkSetReportSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  frozen: z.boolean(),
  caseIds: z.array(z.string()),
  /** Questions this set holds in the manifest. */
  declaredQuestions: z.number().int().min(0),
  /** Metrics over this set alone, from the unmodified aggregator. */
  metrics: EvaluationMetricsSchema,
});
export type BenchmarkSetReport = z.infer<typeof BenchmarkSetReportSchema>;

// ---------------------------------------------------------------------------
// Failure grouping
// ---------------------------------------------------------------------------

/**
 * One group's figures. Deliberately thin: counts plus the two accuracies, so a
 * group can be compared with the combined run without re-deriving anything.
 */
export const GroupScoreSchema = z.object({
  key: z.string(),
  questions: z.number().int().min(0),
  correct: z.number().int().min(0),
  evidenceBacked: z.number().int().min(0),
  partialEvidence: z.number().int().min(0),
  unsupportedAnswers: z.number().int().min(0),
  fabrications: z.number().int().min(0),
  answerAccuracy: z.number().min(0).max(1),
  evidenceBackedTaskAccuracy: z.number().min(0).max(1),
});
export type GroupScore = z.infer<typeof GroupScoreSchema>;

/**
 * The four groupings the failure analysis needs. Each is a complete partition of
 * the scored questions, so a group's questions always sum to the run's total and
 * a weakness cannot be an artefact of questions falling outside every bucket.
 */
export const BenchmarkBreakdownSchema = z.object({
  bySet: z.array(GroupScoreSchema),
  byCategory: z.array(GroupScoreSchema),
  byDifficulty: z.array(GroupScoreSchema),
  byRepository: z.array(GroupScoreSchema),
  byEvidenceKind: z.array(GroupScoreSchema),
});
export type BenchmarkBreakdown = z.infer<typeof BenchmarkBreakdownSchema>;

/** One failed question, with the metadata needed to see the pattern it belongs to. */
export const BenchmarkFailureSchema = z.object({
  key: z.string(),
  setId: z.string(),
  repository: z.string(),
  category: z.string(),
  difficulty: z.string(),
  evidenceKind: z.string(),
  question: z.string(),
  /**
   * Which of the three ways a question can fail. Kept apart because they call for
   * different fixes: `wrong-answer` is a reasoning or retrieval failure,
   * `uncited` and `weak-evidence` are grounding failures on an answer that was
   * already right.
   */
  failure: z.enum(["wrong-answer", "uncited", "weak-evidence", "fabrication"]),
  missingKeywords: z.array(z.string()),
  forbiddenHits: z.array(z.string()),
  expectedEvidence: z.array(z.string()),
  citedEvidence: z.number().int().min(0),
});
export type BenchmarkFailure = z.infer<typeof BenchmarkFailureSchema>;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const BenchmarkRunReportSchema = EvaluationReportSchema.extend({
  schemaVersion: z.literal(BENCHMARK_REPORT_SCHEMA_VERSION),
  /** Where in the development process this run originated. */
  provenance: z.string().min(1),
  benchmark: BenchmarkIdentitySchema,
  sets: z.array(BenchmarkSetReportSchema),
  breakdown: BenchmarkBreakdownSchema,
  /** Every question that did not reach the primary metric, with its classification. */
  failures: z.array(BenchmarkFailureSchema),
});
export type BenchmarkRunReport = z.infer<typeof BenchmarkRunReportSchema>;

export interface BenchmarkAggregateInput extends AggregateInput {
  benchmark: Benchmark;
  provenance: string;
}

/**
 * Aggregates a run against a benchmark.
 *
 * The combined metrics are `aggregate()`'s output, unchanged and unrecomputed —
 * this function only adds identity, the per-set split and the failure grouping.
 * Cases the benchmark does not know about are an error rather than a silently
 * unassigned remainder: a run scored against unknown cases has an unknown
 * denominator.
 */
export function aggregateBenchmark(input: BenchmarkAggregateInput): BenchmarkRunReport {
  const { benchmark, provenance, ...aggregateInput } = input;
  const combined = aggregate(aggregateInput);
  const cases = [...input.cases];

  const setOfCase = new Map<string, string>();
  for (const set of benchmark.sets) for (const caseId of set.caseIds) setOfCase.set(caseId, set.id);

  const unknown = cases.map((entry) => entry.caseId).filter((caseId) => !setOfCase.has(caseId));
  if (unknown.length > 0) {
    throw new Error(
      `Cases scored but not in the benchmark: ${unknown.join(", ")}. ` +
        "Add them to a set in the manifest, or run against the benchmark's cases.",
    );
  }

  // Per-set metrics come from the same aggregator over a subset of the same
  // cases. Every case belongs to exactly one set, so the subsets partition the
  // run and the per-set figures are directly comparable with the combined one.
  const sets: BenchmarkSetReport[] = benchmark.sets.map((set) => {
    const subset = cases.filter((entry) => setOfCase.get(entry.caseId) === set.id);
    return {
      id: set.id,
      title: set.title,
      frozen: set.frozen,
      caseIds: [...set.caseIds],
      declaredQuestions: set.questionCount,
      metrics: aggregate({ ...aggregateInput, cases: subset }).metrics,
    };
  });

  const scored = joinQuestions(benchmark, cases);
  const evaluatedQuestions = combined.metrics.totalQuestions;

  return BenchmarkRunReportSchema.parse({
    ...combined,
    schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    provenance,
    benchmark: {
      name: benchmark.name,
      version: benchmark.version,
      regressionCount: benchmark.counts.regression,
      challengeCount: benchmark.counts.challenge,
      totalCount: benchmark.counts.total,
      evaluatedQuestions,
      complete: evaluatedQuestions === benchmark.counts.total,
    },
    sets,
    breakdown: buildBreakdown(scored),
    failures: scored.filter((entry) => !entry.score.evidenceBacked).map(toFailure),
  } satisfies BenchmarkRunReport);
}

/**
 * A scored question paired with what the benchmark knows about it.
 *
 * A failed case contributes no `QuestionScore`s at all (the aggregator counts its
 * questions in the denominator but there is nothing to classify), so this join is
 * over the questions that were actually scored. That is why `byCategory` sums to
 * the scored count rather than to `totalQuestions` when a case crashed, and why
 * `evaluatedQuestions` above is taken from the aggregator instead of from here.
 */
interface ScoredQuestion {
  key: string;
  setId: string;
  repository: string;
  category: string;
  difficulty: string;
  evidenceKind: string;
  expectedEvidence: readonly string[];
  score: QuestionScore;
}

function joinQuestions(benchmark: Benchmark, cases: readonly CaseScore[]): ScoredQuestion[] {
  const byKey = new Map(benchmark.questions.map((question) => [question.key, question]));
  const joined: ScoredQuestion[] = [];
  for (const caseScore of cases) {
    for (const score of caseScore.questions) {
      const key = questionKey(caseScore.caseId, score.questionId);
      const meta = byKey.get(key);
      if (meta === undefined) {
        throw new Error(
          `Scored question "${key}" is not in the benchmark. The scorer and the manifest read the same files; ` +
            "one of them is stale.",
        );
      }
      joined.push({
        key,
        setId: meta.setId,
        repository: meta.repository,
        category: meta.category,
        difficulty: meta.difficulty,
        evidenceKind: evidenceKind(meta.expectedEvidence),
        expectedEvidence: meta.expectedEvidence,
        score,
      });
    }
  }
  return joined;
}

function buildBreakdown(scored: readonly ScoredQuestion[]): BenchmarkBreakdown {
  return {
    bySet: group(scored, (entry) => entry.setId),
    // Fixed orders, so two runs' breakdowns line up row for row and a category
    // with no failures still appears rather than vanishing.
    byCategory: group(scored, (entry) => entry.category, BENCHMARK_CATEGORIES),
    byDifficulty: group(scored, (entry) => entry.difficulty, BENCHMARK_DIFFICULTIES),
    byRepository: group(scored, (entry) => entry.repository),
    byEvidenceKind: group(scored, (entry) => entry.evidenceKind, EVIDENCE_KINDS),
  };
}

function group(
  scored: readonly ScoredQuestion[],
  keyOf: (entry: ScoredQuestion) => string,
  order?: readonly string[],
): GroupScore[] {
  const buckets = new Map<string, ScoredQuestion[]>();
  for (const key of order ?? []) buckets.set(key, []);
  for (const entry of scored) {
    const key = keyOf(entry);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  const keys = order === undefined ? [...buckets.keys()].sort() : [...buckets.keys()];
  return keys.map((key) => tally(key, buckets.get(key) ?? []));
}

function tally(key: string, entries: readonly ScoredQuestion[]): GroupScore {
  const correct = entries.filter((entry) => entry.score.answerCorrect).length;
  const evidenceBacked = entries.filter((entry) => entry.score.evidenceBacked).length;
  return {
    key,
    questions: entries.length,
    correct,
    evidenceBacked,
    partialEvidence: entries.filter((entry) => entry.score.partialEvidence).length,
    unsupportedAnswers: entries.filter((entry) => entry.score.unsupportedAnswer).length,
    fabrications: entries.filter((entry) => entry.score.fabricationDetected).length,
    answerAccuracy: rate(correct, entries.length),
    evidenceBackedTaskAccuracy: rate(evidenceBacked, entries.length),
  };
}

function toFailure(entry: ScoredQuestion): BenchmarkFailure {
  const score = entry.score;
  return {
    key: entry.key,
    setId: entry.setId,
    repository: entry.repository,
    category: entry.category,
    difficulty: entry.difficulty,
    evidenceKind: entry.evidenceKind,
    question: score.question,
    failure: classifyFailure(score),
    missingKeywords: [...score.missingKeywords],
    forbiddenHits: [...score.forbiddenHits],
    expectedEvidence: [...entry.expectedEvidence],
    citedEvidence: score.citedEvidence,
  };
}

/**
 * Which kind of failure this is. Ordered by what a reader should act on first: a
 * fabrication is the most serious even when other things are also wrong, and an
 * answer that was simply wrong is a different problem from a right answer that
 * could not be shown.
 */
function classifyFailure(score: QuestionScore): BenchmarkFailure["failure"] {
  if (score.fabricationDetected) return "fabrication";
  if (!score.answerCorrect) return "wrong-answer";
  if (score.unsupportedAnswer) return "uncited";
  return "weak-evidence";
}

// ---------------------------------------------------------------------------
// Reading a report of unknown vintage
// ---------------------------------------------------------------------------

/**
 * What a report of *either* schema version says about its three identities.
 *
 * A v1 report predates the benchmark manifest and predates provenance, so it
 * genuinely does not know either. This returns `null` for those rather than
 * defaulting them: labelling a historical Iteration 3 run as benchmark `v1`
 * would be inventing a fact at read time, and a reader comparing it against a
 * `v2` run would then be comparing two datasets while believing it had compared
 * two systems.
 */
export interface ReportIdentity {
  schemaVersion: number;
  runId: string;
  system: string;
  systemVersion: string;
  /** Null when the report predates provenance. Never substituted. */
  provenance: string | null;
  /** Null when the report predates the versioned benchmark. Never substituted. */
  benchmarkVersion: string | null;
  /** Null when the report predates the versioned benchmark. */
  benchmarkTotalCount: number | null;
}

export function readReportIdentity(report: unknown): ReportIdentity {
  const shape = z
    .object({
      schemaVersion: z.number().int(),
      runId: z.string(),
      system: z.string(),
      systemVersion: z.string(),
      provenance: z.string().optional(),
      benchmark: z.object({ version: z.string(), totalCount: z.number().int() }).optional(),
    })
    .safeParse(report);
  if (!shape.success) {
    throw new Error("Not an evaluation report: it has no schemaVersion, runId, system and systemVersion.");
  }
  const data = shape.data;
  return {
    schemaVersion: data.schemaVersion,
    runId: data.runId,
    system: data.system,
    systemVersion: data.systemVersion,
    provenance: data.provenance ?? null,
    benchmarkVersion: data.benchmark?.version ?? null,
    benchmarkTotalCount: data.benchmark?.totalCount ?? null,
  };
}

/** One line describing a report's provenance, honest about what it does not record. */
export function describeReportIdentity(identity: ReportIdentity): string {
  const benchmark =
    identity.benchmarkVersion === null
      ? "benchmark unrecorded (pre-v2 report)"
      : `benchmark ${identity.benchmarkVersion} (${identity.benchmarkTotalCount ?? "?"} questions)`;
  const provenance = identity.provenance === null ? "provenance unrecorded" : `provenance ${identity.provenance}`;
  return `${identity.runId} · ${identity.system} v${identity.systemVersion} · ${provenance} · ${benchmark}`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * The benchmark run summary.
 *
 * The per-set tables come *before* the combined report, because a combined
 * average is the one number that can hide a regression: if the frozen set has
 * dropped while the challenge set carried the mean, the reader has to see that
 * first or they will not look for it.
 */
export function renderBenchmarkMarkdown(report: BenchmarkRunReport): string {
  const lines: string[] = [];

  lines.push(`# Benchmark run — ${report.system} v${report.systemVersion}`, "");
  lines.push("| Identity | Value |", "| --- | --- |");
  lines.push(`| System version | \`${report.systemVersion}\` — what code ran |`);
  lines.push(`| Provenance | \`${report.provenance}\` — where this run came from |`);
  lines.push(
    `| Benchmark | \`${report.benchmark.name} ${report.benchmark.version}\` — ` +
      `${report.benchmark.totalCount} questions (${report.benchmark.regressionCount} regression + ` +
      `${report.benchmark.challengeCount} challenge) |`,
  );
  lines.push(`| Run | \`${report.runId}\` · ${report.provider}/${report.model} · seed ${report.seed} |`);
  lines.push("");

  if (!report.benchmark.complete) {
    lines.push(
      `> **Partial run.** ${report.benchmark.evaluatedQuestions} of ${report.benchmark.totalCount} benchmark`,
      "> questions were scored. The percentages below are over what ran, not over the benchmark.",
      "",
    );
  }

  lines.push("## Per set", "");
  lines.push(
    "Reported separately and before the combined figure, so a regression in the frozen set cannot hide",
    "behind an average.",
    "",
  );
  lines.push(
    "| Set | Frozen | Questions | Answer accuracy | Evidence-backed accuracy | Partial | Uncited | Fabrications |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const set of report.sets) {
    const m = set.metrics;
    lines.push(
      `| ${set.title} | ${set.frozen ? "yes" : "no"} | ${m.totalQuestions} | ` +
        `${percent(m.answerAccuracy)} (${m.correctAnswers}/${m.totalQuestions}) | ` +
        `**${percent(m.evidenceBackedTaskAccuracy)}** (${m.evidenceBackedAnswers}/${m.totalQuestions}) | ` +
        `${m.partialEvidenceAnswers} | ${m.unsupportedAnswers} | ${m.fabrications} |`,
    );
  }
  const combined = report.metrics;
  lines.push(
    `| **Combined** | — | ${combined.totalQuestions} | ` +
      `${percent(combined.answerAccuracy)} (${combined.correctAnswers}/${combined.totalQuestions}) | ` +
      `**${percent(combined.evidenceBackedTaskAccuracy)}** ` +
      `(${combined.evidenceBackedAnswers}/${combined.totalQuestions}) | ` +
      `${combined.partialEvidenceAnswers} | ${combined.unsupportedAnswers} | ${combined.fabrications} |`,
    "",
  );

  lines.push("## Breakdown", "");
  for (const [title, groups] of [
    ["By category", report.breakdown.byCategory],
    ["By difficulty", report.breakdown.byDifficulty],
    ["By repository", report.breakdown.byRepository],
    ["By expected evidence kind", report.breakdown.byEvidenceKind],
  ] as const) {
    lines.push(`### ${title}`, "");
    lines.push("| Group | Questions | Correct | Evidence-backed | Rate |", "| --- | --- | --- | --- | --- |");
    for (const entry of groups) {
      if (entry.questions === 0) continue;
      lines.push(
        `| ${entry.key} | ${entry.questions} | ${entry.correct} | ${entry.evidenceBacked} | ` +
          `${percent(entry.evidenceBackedTaskAccuracy)} |`,
      );
    }
    lines.push("");
  }

  if (report.failures.length > 0) {
    lines.push("## Failures", "");
    lines.push(
      `${report.failures.length} question(s) did not reach the primary metric. Grouped by what went wrong,`,
      "because a wrong answer and an uncited right answer need different fixes.",
      "",
    );
    for (const kind of ["fabrication", "wrong-answer", "uncited", "weak-evidence"] as const) {
      const group = report.failures.filter((failure) => failure.failure === kind);
      if (group.length === 0) continue;
      lines.push(`### ${kind} (${group.length})`, "");
      for (const failure of group) {
        lines.push(
          `- \`${failure.key}\` · ${failure.setId} · ${failure.category} · ${failure.difficulty} · ` +
            `${failure.evidenceKind} evidence`,
        );
        lines.push(`  - ${failure.question}`);
        if (failure.missingKeywords.length > 0) {
          lines.push(`  - missing: ${failure.missingKeywords.map((word) => `\`${word}\``).join(", ")}`);
        }
        if (failure.forbiddenHits.length > 0) {
          lines.push(`  - asserted forbidden: ${failure.forbiddenHits.map((word) => `\`${word}\``).join(", ")}`);
        }
        lines.push(
          `  - expected evidence: ${failure.expectedEvidence.map((ref) => `\`${ref}\``).join(", ")}` +
            ` · cited ${failure.citedEvidence}`,
        );
      }
      lines.push("");
    }
  }

  // The combined report, verbatim from the renderer that produced every earlier
  // run's markdown. Appended rather than merged, so the two are comparable.
  lines.push("---", "");
  lines.push(renderEvaluationMarkdown(combinedView(report)));

  return lines.join("\n");
}

/**
 * The v1 view of a benchmark report: exactly the fields the original renderer
 * reads, with the v2-only fields dropped rather than hidden. Nothing is
 * fabricated — the identities the v1 shape has no place for are simply not part
 * of the section it renders, which is why they are printed above it instead.
 */
function combinedView(report: BenchmarkRunReport): EvaluationReport {
  // The rest element is what does the work: TypeScript exempts the discarded
  // siblings from the unused-variable check precisely because this is the
  // idiomatic way to omit keys.
  const { provenance, benchmark, sets, breakdown, failures, schemaVersion, ...rest } = report;
  return { ...rest, schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
