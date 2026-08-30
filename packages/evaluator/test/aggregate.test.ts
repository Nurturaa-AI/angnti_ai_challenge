import { describe, expect, it } from "vitest";
import { aggregate, type AggregateInput } from "../src/aggregate";
import { renderEvaluationMarkdown } from "../src/report";
import type { CaseScore, QuestionScore } from "../src/score";

/**
 * Aggregation and reporting.
 *
 * The report is written to be read against its own interest, so these tests check
 * the awkward parts: a failed case still counts against the denominator, an
 * unpriced model produces a lower bound rather than a confident zero, and the
 * summary does not claim a gap it does not have.
 */

function questionScore(overrides: Partial<QuestionScore> = {}): QuestionScore {
  return {
    questionId: "q1",
    question: "What is this?",
    field: "summary",
    answerCorrect: true,
    evidenceBacked: true,
    partialEvidence: false,
    evidenceStrength: "content",
    unsupportedAnswer: false,
    fabricationDetected: false,
    evidenceRelevance: 1,
    citedEvidence: 1,
    relevantEvidence: 1,
    matchedIn: "summary",
    missingKeywords: [],
    forbiddenHits: [],
    notes: [],
    ...overrides,
  };
}

function caseScore(overrides: Partial<CaseScore> = {}): CaseScore {
  const questions = overrides.questions ?? [questionScore()];
  return {
    caseId: "case-001",
    title: "Demo",
    repository: "fixtures/demo",
    runId: "baseline-demo",
    provider: "mock",
    model: "mock-deterministic-v1",
    questions,
    totals: {
      questions: questions.length,
      correct: questions.filter((q) => q.answerCorrect).length,
      evidenceBacked: questions.filter((q) => q.evidenceBacked).length,
      partialEvidence: questions.filter((q) => q.partialEvidence).length,
      unsupportedAnswers: questions.filter((q) => q.unsupportedAnswer).length,
      fabrications: questions.filter((q) => q.fabricationDetected).length,
    },
    answerAccuracy: 1,
    evidenceBackedAccuracy: 1,
    briefingUnsupportedClaims: 0,
    droppedCitations: 0,
    durationMs: 1000,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    estimatedCostUsd: 0.0001,
    ...overrides,
  };
}

function input(cases: readonly CaseScore[], caveats: readonly string[] = []): AggregateInput {
  return {
    runId: "eval-baseline-2026-01-01T00-00-00Z",
    system: "baseline",
    systemVersion: "0.1.0",
    provider: "mock",
    model: "mock-deterministic-v1",
    seed: 7,
    thinkingLevel: "low",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    finishedAt: new Date("2026-01-01T00:00:05.000Z"),
    cases,
    caveats,
  };
}

describe("aggregate", () => {
  it("computes the primary metric over all questions in the run", () => {
    const report = aggregate(
      input([
        caseScore({
          questions: [
            questionScore({ questionId: "q1" }),
            questionScore({ questionId: "q2", evidenceBacked: false, partialEvidence: true, evidenceStrength: "existence" }),
            questionScore({ questionId: "q3", answerCorrect: false, evidenceBacked: false, evidenceStrength: null }),
          ],
        }),
      ]),
    );

    expect(report.metrics.totalQuestions).toBe(3);
    expect(report.metrics.correctAnswers).toBe(2);
    expect(report.metrics.evidenceBackedAnswers).toBe(1);
    expect(report.metrics.partialEvidenceAnswers).toBe(1);
    expect(report.metrics.evidenceBackedTaskAccuracy).toBeCloseTo(1 / 3, 4);
    expect(report.metrics.answerAccuracy).toBeCloseTo(2 / 3, 4);
  });

  it("reports zero rather than dividing by zero when there is nothing to score", () => {
    const report = aggregate(input([]));

    expect(report.metrics.totalCases).toBe(0);
    expect(report.metrics.evidenceBackedTaskAccuracy).toBe(0);
    expect(report.metrics.meanEvidenceRelevance).toBeNull();
  });

  it("counts a case as passed only when every answer is correct", () => {
    const report = aggregate(
      input([
        caseScore({ caseId: "all-right" }),
        caseScore({
          caseId: "one-wrong",
          questions: [questionScore(), questionScore({ questionId: "q2", answerCorrect: false, evidenceBacked: false })],
        }),
      ]),
    );

    expect(report.metrics.passedCases).toBe(1);
    expect(report.metrics.evidenceBackedCases).toBe(1);
  });

  it("does not count a case with no questions as a pass", () => {
    const report = aggregate(input([caseScore({ questions: [] })]));

    expect(report.metrics.passedCases).toBe(0);
    expect(report.metrics.evidenceBackedCases).toBe(0);
  });

  it("counts a failed case against the denominator and says so in the caveats", () => {
    const failed = caseScore({
      caseId: "case-002",
      error: "RepositoryError: path does not exist",
      questions: [],
      totals: { questions: 4, correct: 0, evidenceBacked: 0, partialEvidence: 0, unsupportedAnswers: 0, fabrications: 0 },
      answerAccuracy: 0,
      evidenceBackedAccuracy: 0,
      estimatedCostUsd: null,
    });

    const report = aggregate(input([caseScore(), failed]));

    expect(report.metrics.failedCases).toBe(1);
    expect(report.metrics.totalQuestions).toBe(5);
    expect(report.metrics.evidenceBackedTaskAccuracy).toBeCloseTo(1 / 5, 4);
    expect(report.caveats.join(" ")).toContain("failed to produce a briefing");
  });

  it("sums token usage across cases", () => {
    const report = aggregate(input([caseScore(), caseScore({ caseId: "case-002" })]));

    expect(report.usage).toEqual({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });
  });

  it("treats an unpriced model as a lower bound rather than a confident total", () => {
    const report = aggregate(input([caseScore(), caseScore({ caseId: "case-002", estimatedCostUsd: null })]));

    expect(report.costEstimateComplete).toBe(false);
    expect(report.caveats.join(" ")).toContain("lower bound");
    expect(report.estimatedCostUsd).toBeCloseTo(0.0001, 6);
  });

  it("reports a null cost when nothing in the run was priceable", () => {
    const report = aggregate(input([caseScore({ estimatedCostUsd: null })]));

    expect(report.estimatedCostUsd).toBeNull();
    expect(report.costEstimateComplete).toBe(false);
  });

  it("keeps the caveats it was handed, ahead of the ones it derives", () => {
    const report = aggregate(input([caseScore({ estimatedCostUsd: null })], ["This run used the offline mock provider."]));

    expect(report.caveats[0]).toContain("mock provider");
  });

  it("averages evidence relevance only over questions where it was measurable", () => {
    const report = aggregate(
      input([
        caseScore({
          questions: [
            questionScore({ evidenceRelevance: 1 }),
            questionScore({ questionId: "q2", evidenceRelevance: 0.5 }),
            questionScore({ questionId: "q3", evidenceRelevance: null }),
          ],
        }),
      ]),
    );

    expect(report.metrics.meanEvidenceRelevance).toBeCloseTo(0.75, 4);
  });

  it("records the duration and the environment needed to reproduce the run", () => {
    const report = aggregate(input([caseScore()]));

    expect(report.durationMs).toBe(5000);
    expect(report.seed).toBe(7);
    expect(report.environment.nodeVersion).toBe(process.version);
    expect(report.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("renderEvaluationMarkdown", () => {
  it("leads with the primary metric and puts caveats above the numbers", () => {
    const report = aggregate(input([caseScore()], ["This run used the offline mock provider."]));
    const markdown = renderEvaluationMarkdown(report);

    expect(markdown.indexOf("mock provider")).toBeLessThan(markdown.indexOf("Primary metric"));
    expect(markdown).toContain("Evidence-backed task accuracy");
  });

  it("quantifies the gap when answers outrun their evidence", () => {
    const report = aggregate(
      input([
        caseScore({
          questions: [questionScore({ evidenceBacked: false, unsupportedAnswer: true, evidenceStrength: null })],
        }),
      ]),
    );

    expect(renderEvaluationMarkdown(report)).toContain("Answer accuracy exceeds evidence-backed accuracy");
  });

  it("does not claim uncited guessing when there is no gap to claim", () => {
    const markdown = renderEvaluationMarkdown(aggregate(input([caseScore()])));

    expect(markdown).not.toContain("Answer accuracy exceeds");
    expect(markdown).toContain("Answer accuracy and evidence-backed accuracy are equal");
  });

  it("names a failed case in the per-question detail instead of showing an empty section", () => {
    const failed = caseScore({
      caseId: "case-002",
      error: "RepositoryError: path does not exist",
      questions: [],
      totals: { questions: 2, correct: 0, evidenceBacked: 0, partialEvidence: 0, unsupportedAnswers: 0, fabrications: 0 },
      answerAccuracy: 0,
      evidenceBackedAccuracy: 0,
    });

    const markdown = renderEvaluationMarkdown(aggregate(input([failed])));

    expect(markdown).toContain("**Run failed:** RepositoryError");
  });

  it("says the cost is unknown rather than printing a fabricated zero", () => {
    const markdown = renderEvaluationMarkdown(aggregate(input([caseScore({ estimatedCostUsd: null })])));

    expect(markdown).toContain("unknown (no published price");
    expect(markdown).not.toContain("$0.000000");
  });

  it("marks a partially priceable run as a lower bound", () => {
    const markdown = renderEvaluationMarkdown(
      aggregate(input([caseScore(), caseScore({ caseId: "case-002", estimatedCostUsd: null })])),
    );

    expect(markdown).toContain("at least $");
  });

  it("surfaces a tripped fabrication check in the question detail", () => {
    const report = aggregate(
      input([
        caseScore({
          questions: [
            questionScore({
              answerCorrect: false,
              evidenceBacked: false,
              fabricationDetected: true,
              forbiddenHits: ["graphql"],
              evidenceStrength: null,
            }),
          ],
        }),
      ]),
    );

    const markdown = renderEvaluationMarkdown(report);
    expect(markdown).toContain("asserted forbidden: `graphql`");
    expect(report.metrics.fabrications).toBe(1);
  });
});
