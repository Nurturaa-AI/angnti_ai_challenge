import { ZERO_USAGE, addUsage, type TokenUsage } from "@repo-arch/shared";
import { z } from "zod";
import { CaseScoreSchema, rate, type CaseScore } from "./score";

/**
 * Aggregation across cases.
 *
 * The headline number is `evidenceBackedTaskAccuracy`. Everything else is here so
 * that number can be interrogated rather than merely quoted — in particular
 * `answerAccuracy` alongside it, because the distance between the two is the
 * measurement this project cares about.
 */

export const EVALUATION_REPORT_SCHEMA_VERSION = 1;

export const EvaluationMetricsSchema = z.object({
  totalCases: z.number().int().min(0),
  /** Cases where every question was answered correctly. */
  passedCases: z.number().int().min(0),
  /** Cases where every answer was also backed by content-bearing evidence. */
  evidenceBackedCases: z.number().int().min(0),
  /** Cases where the system failed to produce a briefing at all. */
  failedCases: z.number().int().min(0),

  totalQuestions: z.number().int().min(0),
  correctAnswers: z.number().int().min(0),
  evidenceBackedAnswers: z.number().int().min(0),
  partialEvidenceAnswers: z.number().int().min(0),
  unsupportedAnswers: z.number().int().min(0),
  fabrications: z.number().int().min(0),

  /** Claims across all briefings that ended up with no grounded evidence. */
  briefingUnsupportedClaims: z.number().int().min(0),
  /** Citations removed during grounding because the system never received the source. */
  droppedCitations: z.number().int().min(0),

  answerAccuracy: z.number().min(0).max(1),
  /** PRIMARY METRIC. */
  evidenceBackedTaskAccuracy: z.number().min(0).max(1),
  /** Mean of per-question evidence relevance, over questions where it was measurable. */
  meanEvidenceRelevance: z.number().min(0).max(1).nullable(),
});
export type EvaluationMetrics = z.infer<typeof EvaluationMetricsSchema>;

export const EvaluationReportSchema = z.object({
  schemaVersion: z.literal(EVALUATION_REPORT_SCHEMA_VERSION),
  runId: z.string(),
  system: z.string(),
  systemVersion: z.string(),
  provider: z.string(),
  model: z.string(),
  seed: z.number(),
  thinkingLevel: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().min(0),
  metrics: EvaluationMetricsSchema,
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
  }),
  /** Sum of the case estimates that are priceable. */
  estimatedCostUsd: z.number().nullable(),
  /** False when at least one model in the run has no published price. */
  costEstimateComplete: z.boolean(),
  environment: z.object({
    nodeVersion: z.string(),
    platform: z.string(),
  }),
  /** Anything about this run that would mislead a reader who saw only the metrics. */
  caveats: z.array(z.string()).default([]),
  cases: z.array(CaseScoreSchema).default([]),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export interface AggregateInput {
  runId: string;
  system: string;
  systemVersion: string;
  provider: string;
  model: string;
  seed: number;
  thinkingLevel: string;
  startedAt: Date;
  finishedAt: Date;
  cases: readonly CaseScore[];
  caveats?: readonly string[];
}

export function aggregate(input: AggregateInput): EvaluationReport {
  const cases = [...input.cases];

  let usage: TokenUsage = ZERO_USAGE;
  let costTotal = 0;
  let costComplete = true;
  const metrics = {
    totalCases: cases.length,
    passedCases: 0,
    evidenceBackedCases: 0,
    failedCases: 0,
    totalQuestions: 0,
    correctAnswers: 0,
    evidenceBackedAnswers: 0,
    partialEvidenceAnswers: 0,
    unsupportedAnswers: 0,
    fabrications: 0,
    briefingUnsupportedClaims: 0,
    droppedCitations: 0,
    answerAccuracy: 0,
    evidenceBackedTaskAccuracy: 0,
    meanEvidenceRelevance: null as number | null,
  };

  const relevanceSamples: number[] = [];

  for (const caseScore of cases) {
    usage = addUsage(usage, caseScore.usage);
    if (caseScore.estimatedCostUsd === null) costComplete = false;
    else costTotal += caseScore.estimatedCostUsd;

    if (caseScore.error !== undefined) metrics.failedCases += 1;

    metrics.totalQuestions += caseScore.totals.questions;
    metrics.correctAnswers += caseScore.totals.correct;
    metrics.evidenceBackedAnswers += caseScore.totals.evidenceBacked;
    metrics.partialEvidenceAnswers += caseScore.totals.partialEvidence;
    metrics.unsupportedAnswers += caseScore.totals.unsupportedAnswers;
    metrics.fabrications += caseScore.totals.fabrications;
    metrics.briefingUnsupportedClaims += caseScore.briefingUnsupportedClaims;
    metrics.droppedCitations += caseScore.droppedCitations;

    // A case with zero questions is not a pass; there was nothing to get right.
    const complete = caseScore.totals.questions > 0 && caseScore.error === undefined;
    if (complete && caseScore.totals.correct === caseScore.totals.questions) metrics.passedCases += 1;
    if (complete && caseScore.totals.evidenceBacked === caseScore.totals.questions) {
      metrics.evidenceBackedCases += 1;
    }

    for (const question of caseScore.questions) {
      if (question.evidenceRelevance !== null) relevanceSamples.push(question.evidenceRelevance);
    }
  }

  metrics.answerAccuracy = rate(metrics.correctAnswers, metrics.totalQuestions);
  metrics.evidenceBackedTaskAccuracy = rate(metrics.evidenceBackedAnswers, metrics.totalQuestions);
  metrics.meanEvidenceRelevance =
    relevanceSamples.length === 0
      ? null
      : Math.round((relevanceSamples.reduce((sum, value) => sum + value, 0) / relevanceSamples.length) * 10_000) /
        10_000;

  const caveats = [...(input.caveats ?? [])];
  if (!costComplete) {
    caveats.push("At least one model in this run has no published price, so the cost estimate is a lower bound.");
  }
  if (metrics.failedCases > 0) {
    caveats.push(`${metrics.failedCases} case(s) failed to produce a briefing and are scored as zero.`);
  }

  return EvaluationReportSchema.parse({
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    runId: input.runId,
    system: input.system,
    systemVersion: input.systemVersion,
    provider: input.provider,
    model: input.model,
    seed: input.seed,
    thinkingLevel: input.thinkingLevel,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    metrics,
    usage,
    estimatedCostUsd: costComplete || costTotal > 0 ? Math.round(costTotal * 1_000_000) / 1_000_000 : null,
    costEstimateComplete: costComplete,
    environment: { nodeVersion: process.version, platform: process.platform },
    caveats,
    cases,
  } satisfies EvaluationReport);
}
