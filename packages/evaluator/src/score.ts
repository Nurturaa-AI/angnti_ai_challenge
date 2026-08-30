import { normalizeForMatch, type Evidence, type RunRecord } from "@repo-arch/shared";
import { z } from "zod";
import type { EvalCase, EvalQuestion } from "./case-schema";
import { bestEvidenceStrength, evidenceStrengthFor, matchedKeywords, satisfiesKeywords, selectClaims } from "./matching";

/**
 * Scoring.
 *
 * Four measures, kept separate because collapsing them is exactly how a tool
 * like this flatters itself:
 *
 *   1. answerCorrect      — the conclusion is right
 *   2. evidenceBacked     — it is right *and* cited from something that can
 *                           actually support it (the primary metric)
 *   3. unsupportedAnswer  — it is right but cited nothing
 *   4. evidenceRelevance  — of what it did cite, how much was on point
 *
 * A briefing that guesses correctly scores on (1) and never on (2). That gap is
 * the number this project exists to move.
 */

export const EVIDENCE_STRENGTHS = ["content", "existence"] as const;

export const QuestionScoreSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  field: z.string(),
  /** (1) Conclusion matches the expected keywords and asserts nothing forbidden. */
  answerCorrect: z.boolean(),
  /** (2) Primary metric contributor: correct *and* supported by a content-bearing citation. */
  evidenceBacked: z.boolean(),
  /** Partial credit: the location was only shown to exist, not shown to behave as claimed. */
  partialEvidence: z.boolean(),
  evidenceStrength: z.enum(EVIDENCE_STRENGTHS).nullable(),
  /** (3) Correct, but with no surviving citation at all. */
  unsupportedAnswer: z.boolean(),
  /** Asserted something the case marks as false. */
  fabricationDetected: z.boolean(),
  /** (4) relevantCitations / totalCitations on the matching claim. Null when not measurable. */
  evidenceRelevance: z.number().min(0).max(1).nullable(),
  citedEvidence: z.number().int().min(0),
  relevantEvidence: z.number().int().min(0),
  /** Which section the matching claim came from, for debugging a failure. */
  matchedIn: z.string().nullable(),
  missingKeywords: z.array(z.string()).default([]),
  forbiddenHits: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type QuestionScore = z.infer<typeof QuestionScoreSchema>;

export const CaseTotalsSchema = z.object({
  questions: z.number().int().min(0),
  correct: z.number().int().min(0),
  evidenceBacked: z.number().int().min(0),
  partialEvidence: z.number().int().min(0),
  unsupportedAnswers: z.number().int().min(0),
  fabrications: z.number().int().min(0),
});
export type CaseTotals = z.infer<typeof CaseTotalsSchema>;

export const CaseScoreSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  repository: z.string(),
  /** Null when the run itself failed, so a broken case cannot silently score zero-of-zero. */
  runId: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  questions: z.array(QuestionScoreSchema).default([]),
  totals: CaseTotalsSchema,
  answerAccuracy: z.number().min(0).max(1),
  evidenceBackedAccuracy: z.number().min(0).max(1),
  /** Whole-briefing figures, from the run's grounding audit. */
  briefingUnsupportedClaims: z.number().int().min(0),
  droppedCitations: z.number().int().min(0),
  durationMs: z.number().min(0),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
  }),
  estimatedCostUsd: z.number().nullable(),
  /** Set when the system failed to produce a briefing for this case. */
  error: z.string().optional(),
});
export type CaseScore = z.infer<typeof CaseScoreSchema>;

export function scoreQuestion(question: EvalQuestion, record: RunRecord): QuestionScore {
  const claims = selectClaims(record.result, question.field);
  const fieldText = claims.map((claim) => claim.text).join(" \n ");
  const requirement = { expectedKeywords: question.expectedKeywords, anyOfKeywords: question.anyOfKeywords };

  const forbiddenHits = question.mustNotContain.filter((phrase) =>
    normalizeForMatch(fieldText).includes(normalizeForMatch(phrase)),
  );
  const keywordsSatisfied = satisfiesKeywords(fieldText, requirement);
  const answerCorrect = keywordsSatisfied && forbiddenHits.length === 0;

  const missingKeywords = question.expectedKeywords.filter(
    (keyword) => !matchedKeywords(fieldText, [keyword]).includes(keyword),
  );

  // Evidence is only credited when it hangs off a claim that *itself* answers the
  // question. Evidence attached elsewhere in the briefing does not count.
  const matchingClaims = claims.filter((claim) => satisfiesKeywords(claim.text, requirement));
  const pool = matchingClaims.flatMap((claim) => claim.evidence).filter(isGrounded);

  const notes: string[] = [];
  if (keywordsSatisfied && matchingClaims.length === 0) {
    notes.push(
      "keywords matched only across separate claims, so no single claim answers this question; evidence cannot be credited",
    );
  }
  if (forbiddenHits.length > 0) {
    notes.push(`asserted forbidden content: ${forbiddenHits.join(", ")}`);
  }

  const hasExpectedLocations = question.expectedEvidence.length > 0;
  const strength = hasExpectedLocations ? bestEvidenceStrength(pool, question.expectedEvidence) : null;

  const relevantEvidence = hasExpectedLocations
    ? pool.filter((item) =>
        question.expectedEvidence.some((expected) => evidenceStrengthFor(item, expected) !== null),
      ).length
    : 0;

  let evidenceBacked = false;
  if (answerCorrect && matchingClaims.length > 0) {
    evidenceBacked = hasExpectedLocations ? strength === "content" : pool.length > 0;
  }
  const partialEvidence = answerCorrect && !evidenceBacked && strength === "existence";

  if (partialEvidence) {
    notes.push(
      "cited location was only shown to exist (directory listing), which does not establish what it does",
    );
  }
  if (answerCorrect && hasExpectedLocations && strength === null && pool.length > 0) {
    notes.push(`cited ${pool.length} item(s), none pointing at ${question.expectedEvidence.join(" or ")}`);
  }

  return {
    questionId: question.id,
    question: question.question,
    field: question.field,
    answerCorrect,
    evidenceBacked,
    partialEvidence,
    evidenceStrength: strength,
    unsupportedAnswer: answerCorrect && pool.length === 0,
    fabricationDetected: forbiddenHits.length > 0,
    evidenceRelevance: hasExpectedLocations && pool.length > 0 ? round(relevantEvidence / pool.length) : null,
    citedEvidence: pool.length,
    relevantEvidence,
    matchedIn: matchingClaims[0]?.field ?? null,
    missingKeywords,
    forbiddenHits,
    notes,
  };
}

export function scoreCase(evalCase: EvalCase, record: RunRecord): CaseScore {
  const questions = evalCase.questions.map((question) => scoreQuestion(question, record));
  const totals = tallyTotals(questions);

  return CaseScoreSchema.parse({
    caseId: evalCase.id,
    title: evalCase.title,
    repository: evalCase.repository,
    runId: record.meta.runId,
    provider: record.meta.provider,
    model: record.meta.model,
    questions,
    totals,
    answerAccuracy: rate(totals.correct, totals.questions),
    evidenceBackedAccuracy: rate(totals.evidenceBacked, totals.questions),
    briefingUnsupportedClaims: record.meta.evidenceAudit.unsupportedClaims,
    droppedCitations: record.meta.evidenceAudit.dropped.length,
    durationMs: record.meta.durationMs,
    usage: record.meta.usage,
    estimatedCostUsd: record.meta.estimatedCostUsd,
  } satisfies CaseScore);
}

/**
 * A case whose run failed. Recorded as zero-of-N rather than dropped: a system
 * that crashes on a repository has not scored well on it.
 */
export function failedCase(evalCase: EvalCase, error: string, durationMs: number): CaseScore {
  return CaseScoreSchema.parse({
    caseId: evalCase.id,
    title: evalCase.title,
    repository: evalCase.repository,
    runId: null,
    provider: null,
    model: null,
    questions: [],
    totals: {
      questions: evalCase.questions.length,
      correct: 0,
      evidenceBacked: 0,
      partialEvidence: 0,
      unsupportedAnswers: 0,
      fabrications: 0,
    },
    answerAccuracy: 0,
    evidenceBackedAccuracy: 0,
    briefingUnsupportedClaims: 0,
    droppedCitations: 0,
    durationMs,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    estimatedCostUsd: null,
    error,
  } satisfies CaseScore);
}

function tallyTotals(questions: readonly QuestionScore[]): CaseTotals {
  return {
    questions: questions.length,
    correct: questions.filter((question) => question.answerCorrect).length,
    evidenceBacked: questions.filter((question) => question.evidenceBacked).length,
    partialEvidence: questions.filter((question) => question.partialEvidence).length,
    unsupportedAnswers: questions.filter((question) => question.unsupportedAnswer).length,
    fabrications: questions.filter((question) => question.fabricationDetected).length,
  };
}

function isGrounded(item: Evidence): boolean {
  // Grounding removes unverifiable citations, so anything still present should be
  // marked. The check is defensive: an unmarked item is not credited.
  return item.grounded === true;
}

export function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
