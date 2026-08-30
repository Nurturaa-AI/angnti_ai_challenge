import type { Evidence, RunRecord } from "@repo-arch/shared";
import { AnalysisBodySchema, RUN_RECORD_SCHEMA_VERSION } from "@repo-arch/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { EvalQuestionSchema, type EvalQuestion } from "../src/case-schema";
import { failedCase, scoreCase, scoreQuestion } from "../src/score";

/**
 * Evaluation scoring.
 *
 * The four measures have to stay apart under test, because the whole point of the
 * primary metric is that it is harder to satisfy than "the answer was right".
 * Several tests below exist specifically to prove a briefing cannot earn
 * `evidenceBacked` by accident.
 */

const repository = {
  name: "demo",
  path: "fixtures/demo",
  isGitRepository: true,
  head: { commit: "abc1234", branch: "main" },
  fileCount: 8,
  directoryCount: 3,
  totalBytes: 900,
  languages: [{ extension: ".js", files: 6 }],
};

/** A citation the grounding step confirmed. Anything unconfirmed is not credited. */
function cite(evidence: Evidence): Evidence {
  return { ...evidence, grounded: true };
}

function record(
  overrides: Partial<z.input<typeof AnalysisBodySchema>> = {},
  metaOverrides: Partial<RunRecord["meta"]> = {},
): RunRecord {
  const body = AnalysisBodySchema.parse({
    summary: "A demo service.",
    architecture: "One process.",
    testing: { approach: "Vitest unit tests." },
    confidence: 0.4,
    ...overrides,
  });

  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    meta: {
      runId: "baseline-demo-2026-01-01T00-00-00Z",
      system: "baseline",
      systemVersion: "0.1.0",
      provider: "mock",
      model: "mock-deterministic-v1",
      seed: 7,
      thinkingLevel: "low",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      durationMs: 2000,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      estimatedCostUsd: null,
      contextSources: [],
      evidenceAudit: { claimed: 0, grounded: 0, dropped: [], unsupportedClaims: 0 },
      nodeVersion: "v22.0.0",
      ...metaOverrides,
    },
    result: { ...body, repository },
    trajectory: [],
  };
}

function question(overrides: Partial<EvalQuestion> & { id?: string } = {}): EvalQuestion {
  return EvalQuestionSchema.parse({
    id: "q1",
    question: "Which HTTP framework does this use?",
    expectedAnswer: "Express.",
    expectedKeywords: ["express"],
    ...overrides,
  });
}

describe("scoreQuestion — (1) correct answer", () => {
  it("passes when every expected keyword appears in the target field", () => {
    const score = scoreQuestion(
      question({ field: "dependencies", expectedKeywords: ["express", "4.19"] }),
      record({ dependencies: [{ name: "express", version: "^4.19.2", scope: "runtime", evidence: [] }] }),
    );

    expect(score.answerCorrect).toBe(true);
    expect(score.missingKeywords).toEqual([]);
  });

  it("fails when one expected keyword is missing, and names which one", () => {
    const score = scoreQuestion(
      question({ field: "dependencies", expectedKeywords: ["express", "kafka"] }),
      record({ dependencies: [{ name: "express", scope: "runtime", evidence: [] }] }),
    );

    expect(score.answerCorrect).toBe(false);
    expect(score.missingKeywords).toEqual(["kafka"]);
  });

  it("accepts any one complete group of alternative phrasings", () => {
    const withBearer = record({ summary: "Requests carry a bearer token." });
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: [], anyOfKeywords: [["jwt"], ["bearer", "token"]] }),
      withBearer,
    );
    expect(score.answerCorrect).toBe(true);
  });

  it("requires every keyword inside an alternative group, not just one of them", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: [], anyOfKeywords: [["bearer", "token"]] }),
      record({ summary: "Requests carry a bearer credential." }),
    );
    expect(score.answerCorrect).toBe(false);
  });

  it("matches case-insensitively and across collapsed whitespace", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["order.created"] }),
      record({ summary: "Publishes\n   Order.Created  events." }),
    );
    expect(score.answerCorrect).toBe(true);
  });
});

describe("scoreQuestion — (3) unsupported and fabricated claims", () => {
  it("treats a forbidden phrase as a fabrication and fails the answer", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["orders"], mustNotContain: ["graphql"] }),
      record({ summary: "Exposes orders over a GraphQL gateway." }),
    );

    expect(score.answerCorrect).toBe(false);
    expect(score.fabricationDetected).toBe(true);
    expect(score.forbiddenHits).toEqual(["graphql"]);
    expect(score.notes.join(" ")).toContain("forbidden");
  });

  it("counts a correct answer with no citation as unsupported", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["demo"] }),
      record({ summary: "A demo service.", evidence: [] }),
    );

    expect(score.answerCorrect).toBe(true);
    expect(score.unsupportedAnswer).toBe(true);
    expect(score.evidenceBacked).toBe(false);
    expect(score.citedEvidence).toBe(0);
  });

  it("does not count an incorrect answer as unsupported — it is simply wrong", () => {
    const score = scoreQuestion(question({ field: "summary", expectedKeywords: ["kafka"] }), record());
    expect(score.answerCorrect).toBe(false);
    expect(score.unsupportedAnswer).toBe(false);
  });
});

describe("scoreQuestion — (2) evidence-backed answer, the primary metric", () => {
  it("credits it when the citation carries the expected file's own content", () => {
    const score = scoreQuestion(
      question({ field: "dependencies", expectedKeywords: ["express"], expectedEvidence: ["package.json"] }),
      record({
        dependencies: [
          {
            name: "express",
            scope: "runtime",
            evidence: [cite({ type: "manifest", source: "package.json", location: "dependencies.express" })],
          },
        ],
      }),
    );

    expect(score.evidenceBacked).toBe(true);
    expect(score.evidenceStrength).toBe("content");
    expect(score.partialEvidence).toBe(false);
    expect(score.unsupportedAnswer).toBe(false);
  });

  it("withholds it when the citation only proves the location exists", () => {
    const score = scoreQuestion(
      question({
        field: "risks",
        expectedKeywords: ["inventory"],
        expectedEvidence: ["src/services/inventory.js"],
      }),
      record({
        risks: [
          {
            title: "Inventory oversell",
            description: "The inventory check may race.",
            severity: "high",
            evidence: [cite({ type: "tree", source: "tree", location: "src/services/inventory.js" })],
          },
        ],
      }),
    );

    expect(score.answerCorrect).toBe(true);
    expect(score.evidenceBacked).toBe(false);
    expect(score.partialEvidence).toBe(true);
    expect(score.evidenceStrength).toBe("existence");
    expect(score.notes.join(" ")).toContain("only shown to exist");
  });

  it("ignores a citation the grounding step never confirmed", () => {
    const score = scoreQuestion(
      question({ field: "dependencies", expectedKeywords: ["express"], expectedEvidence: ["package.json"] }),
      record({
        dependencies: [
          {
            name: "express",
            scope: "runtime",
            // No `grounded: true` — an unverified citation must not earn the metric.
            evidence: [{ type: "manifest", source: "package.json" }],
          },
        ],
      }),
    );

    expect(score.answerCorrect).toBe(true);
    expect(score.evidenceBacked).toBe(false);
    expect(score.citedEvidence).toBe(0);
    expect(score.unsupportedAnswer).toBe(true);
  });

  it("does not credit evidence hanging off a different claim than the one that answers", () => {
    // "express" and "routing" each appear, but in separate components. The joined
    // text satisfies the keywords; no single claim does.
    const score = scoreQuestion(
      question({ field: "components", expectedKeywords: ["express", "routing"] }),
      record({
        components: [
          {
            name: "express",
            responsibility: "Web layer.",
            evidence: [cite({ type: "manifest", source: "package.json" })],
          },
          { name: "router", responsibility: "Routing table.", evidence: [] },
        ],
      }),
    );

    expect(score.answerCorrect).toBe(true);
    expect(score.evidenceBacked).toBe(false);
    expect(score.citedEvidence).toBe(0);
    expect(score.notes.join(" ")).toContain("across separate claims");
  });

  it("accepts any grounded citation when the case names no expected location", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["demo"], expectedEvidence: [] }),
      record({ evidence: [cite({ type: "readme", source: "README.md" })] }),
    );

    expect(score.evidenceBacked).toBe(true);
    expect(score.evidenceStrength).toBeNull();
    expect(score.evidenceRelevance).toBeNull();
  });

  it("never marks an incorrect answer as evidence-backed, however well cited", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["kafka"], expectedEvidence: ["README.md"] }),
      record({ evidence: [cite({ type: "readme", source: "README.md" })] }),
    );

    expect(score.answerCorrect).toBe(false);
    expect(score.evidenceBacked).toBe(false);
    expect(score.partialEvidence).toBe(false);
  });

  it("resolves an expected directory prefix against a path beneath it", () => {
    const score = scoreQuestion(
      question({ field: "components", expectedKeywords: ["pricing"], expectedEvidence: ["src/services/"] }),
      record({
        components: [
          {
            name: "pricing",
            responsibility: "Totals an order.",
            evidence: [cite({ type: "file", source: "src/services/pricing.js" })],
          },
        ],
      }),
    );

    expect(score.evidenceStrength).toBe("content");
    expect(score.evidenceBacked).toBe(true);
  });
});

describe("scoreQuestion — (4) evidence relevance", () => {
  it("reports the share of citations pointing at an expected location", () => {
    const score = scoreQuestion(
      question({ field: "testing", expectedKeywords: ["vitest"], expectedEvidence: ["package.json"] }),
      record({
        testing: {
          approach: "Vitest unit tests.",
          evidence: [
            cite({ type: "manifest", source: "package.json", location: "devDependencies.vitest" }),
            cite({ type: "readme", source: "README.md" }),
            cite({ type: "tree", source: "tree" }),
          ],
        },
      }),
    );

    expect(score.citedEvidence).toBe(3);
    expect(score.relevantEvidence).toBe(1);
    expect(score.evidenceRelevance).toBeCloseTo(1 / 3, 4);
  });

  it("says relevance is not measurable when the case names no expected location", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["demo"] }),
      record({ evidence: [cite({ type: "readme", source: "README.md" })] }),
    );
    expect(score.evidenceRelevance).toBeNull();
  });

  it("notes when citations exist but none point where the case expects", () => {
    const score = scoreQuestion(
      question({ field: "summary", expectedKeywords: ["demo"], expectedEvidence: ["src/server.js"] }),
      record({ evidence: [cite({ type: "readme", source: "README.md" })] }),
    );

    expect(score.evidenceBacked).toBe(false);
    expect(score.evidenceStrength).toBeNull();
    expect(score.notes.join(" ")).toContain("none pointing at src/server.js");
  });
});

describe("scoreQuestion — field targeting", () => {
  it("looks only at the named field", () => {
    const score = scoreQuestion(
      question({ field: "dependencies", expectedKeywords: ["express"] }),
      record({ summary: "Built on express." }),
    );
    expect(score.answerCorrect).toBe(false);
  });

  it("searches the whole briefing when the field is any", () => {
    const score = scoreQuestion(
      question({ field: "any", expectedKeywords: ["express"] }),
      record({ summary: "Built on express." }),
    );
    expect(score.answerCorrect).toBe(true);
    expect(score.matchedIn).toBe("summary");
  });

  it("reports which section answered, so a failure can be traced", () => {
    const score = scoreQuestion(
      question({ field: "any", expectedKeywords: ["oversell"] }),
      record({
        risks: [{ title: "Oversell", description: "Stock may go negative.", severity: "high", evidence: [] }],
      }),
    );
    expect(score.matchedIn).toBe("risks");
  });

  it("reports no match at all when nothing answered", () => {
    const score = scoreQuestion(question({ field: "any", expectedKeywords: ["kubernetes"] }), record());
    expect(score.matchedIn).toBeNull();
  });
});

describe("scoreCase", () => {
  const evalCase = {
    id: "case-001",
    title: "Demo",
    repository: "fixtures/demo",
    questions: [
      question({ id: "q1", field: "summary", expectedKeywords: ["demo"], expectedEvidence: ["README.md"] }),
      question({ id: "q2", field: "summary", expectedKeywords: ["demo"] }),
      question({ id: "q3", field: "summary", expectedKeywords: ["kubernetes"] }),
    ],
  };

  it("tallies the four measures and derives both accuracies", () => {
    const score = scoreCase(
      evalCase,
      record({ summary: "A demo service.", evidence: [cite({ type: "readme", source: "README.md" })] }),
    );

    expect(score.totals).toEqual({
      questions: 3,
      correct: 2,
      evidenceBacked: 2,
      partialEvidence: 0,
      unsupportedAnswers: 0,
      fabrications: 0,
    });
    expect(score.answerAccuracy).toBeCloseTo(2 / 3, 4);
    expect(score.evidenceBackedAccuracy).toBeCloseTo(2 / 3, 4);
  });

  it("carries the briefing-level grounding audit through to the case score", () => {
    const score = scoreCase(
      evalCase,
      record(
        {},
        {
          evidenceAudit: {
            claimed: 5,
            grounded: 3,
            dropped: [{ source: "src/ghost.js", reason: "source-not-in-context" }],
            unsupportedClaims: 2,
          },
        },
      ),
    );

    expect(score.briefingUnsupportedClaims).toBe(2);
    expect(score.droppedCitations).toBe(1);
    expect(score.runId).toBe("baseline-demo-2026-01-01T00-00-00Z");
    expect(score.error).toBeUndefined();
  });
});

describe("failedCase", () => {
  const evalCase = {
    id: "case-002",
    title: "Broken",
    repository: "fixtures/missing",
    questions: [question({ id: "q1" }), question({ id: "q2" })],
  };

  it("keeps the question count as the denominator, so a crash scores zero rather than nothing", () => {
    const score = failedCase(evalCase, "RepositoryError: path does not exist", 12);

    expect(score.totals.questions).toBe(2);
    expect(score.totals.correct).toBe(0);
    expect(score.answerAccuracy).toBe(0);
    expect(score.evidenceBackedAccuracy).toBe(0);
  });

  it("records the error and drops the run identity, since there was no run", () => {
    const score = failedCase(evalCase, "RepositoryError: path does not exist", 12);

    expect(score.error).toContain("RepositoryError");
    expect(score.runId).toBeNull();
    expect(score.provider).toBeNull();
    expect(score.estimatedCostUsd).toBeNull();
    expect(score.questions).toEqual([]);
  });
});
