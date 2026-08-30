import { describe, expect, it } from "vitest";
import {
  AnalysisBodySchema,
  AnalysisResultSchema,
  DEPENDENCY_SCOPES,
  EVIDENCE_TYPES,
  EvidenceSchema,
  RUN_RECORD_SCHEMA_VERSION,
  RecommendedReadingSchema,
  RunRecordSchema,
  type AnalysisBody,
} from "../src/schemas";

/**
 * The schemas are the contract everything else trusts, so these tests assert the
 * two properties the rest of the system depends on: arrays default to empty
 * rather than undefined, and the model cannot author repository metadata.
 */

function minimalBody(): Record<string, unknown> {
  return {
    summary: "A service.",
    architecture: "One process.",
    testing: { approach: "Vitest unit tests." },
    confidence: 0.4,
  };
}

const repository = {
  name: "demo",
  path: "fixtures/demo",
  isGitRepository: true,
  head: { commit: "abc123", branch: "main" },
  fileCount: 3,
  directoryCount: 1,
  totalBytes: 120,
  languages: [{ extension: ".ts", files: 3 }],
};

describe("AnalysisBodySchema", () => {
  it("defaults every collection to an empty array", () => {
    const body = AnalysisBodySchema.parse(minimalBody());
    expect(body.components).toEqual([]);
    expect(body.flows).toEqual([]);
    expect(body.dependencies).toEqual([]);
    expect(body.risks).toEqual([]);
    expect(body.recommendedReading).toEqual([]);
    expect(body.evidence).toEqual([]);
    expect(body.openQuestions).toEqual([]);
    expect(body.testing.evidence).toEqual([]);
  });

  it("rejects a missing summary", () => {
    const body = minimalBody();
    delete body.summary;
    expect(AnalysisBodySchema.safeParse(body).success).toBe(false);
  });

  it("rejects an empty summary, so an empty string cannot pass for an answer", () => {
    expect(AnalysisBodySchema.safeParse({ ...minimalBody(), summary: "" }).success).toBe(false);
  });

  it.each([-0.1, 1.1])("rejects confidence outside 0..1 (%s)", (confidence) => {
    expect(AnalysisBodySchema.safeParse({ ...minimalBody(), confidence }).success).toBe(false);
  });

  it("defaults a dependency scope to unknown rather than guessing runtime", () => {
    const body = AnalysisBodySchema.parse({
      ...minimalBody(),
      dependencies: [{ name: "express" }],
    });
    expect(body.dependencies[0]?.scope).toBe("unknown");
    expect(DEPENDENCY_SCOPES).toContain("unknown");
  });
});

describe("EvidenceSchema", () => {
  it.each(EVIDENCE_TYPES)("accepts the %s evidence type", (type) => {
    expect(EvidenceSchema.safeParse({ type, source: "tree" }).success).toBe(true);
  });

  it("rejects an unknown evidence type", () => {
    expect(EvidenceSchema.safeParse({ type: "vibes", source: "tree" }).success).toBe(false);
  });

  it("rejects an empty source, because an unnameable source cannot be verified", () => {
    expect(EvidenceSchema.safeParse({ type: "tree", source: "" }).success).toBe(false);
  });

  it("leaves the harness-written grounding fields optional", () => {
    const evidence = EvidenceSchema.parse({ type: "tree", source: "tree" });
    expect(evidence.grounded).toBeUndefined();
    expect(evidence.groundingReason).toBeUndefined();
  });
});

describe("AnalysisResultSchema", () => {
  it("requires repository metadata, which the model never supplies", () => {
    expect(AnalysisResultSchema.safeParse(minimalBody()).success).toBe(false);
    expect(AnalysisResultSchema.safeParse({ ...minimalBody(), repository }).success).toBe(true);
  });

  it("defaults head to null for a non-git directory", () => {
    const result = AnalysisResultSchema.parse({
      ...minimalBody(),
      repository: { ...repository, isGitRepository: false, head: undefined },
    });
    expect(result.repository.head).toBeNull();
  });
});

describe("RecommendedReadingSchema", () => {
  it("requires a 1-based order", () => {
    expect(RecommendedReadingSchema.safeParse({ path: "a", reason: "b", order: 0 }).success).toBe(false);
    expect(RecommendedReadingSchema.safeParse({ path: "a", reason: "b", order: 1 }).success).toBe(true);
  });
});

describe("RunRecordSchema", () => {
  const record = {
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
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      estimatedCostUsd: null,
      contextSources: [{ id: "tree", type: "tree", bytes: 10, truncated: false }],
      evidenceAudit: { claimed: 0, grounded: 0, dropped: [], unsupportedClaims: 1 },
      nodeVersion: "v22.0.0",
    },
    result: { ...(AnalysisBodySchema.parse(minimalBody()) satisfies AnalysisBody), repository },
    trajectory: [{ step: 1, at: "2026-01-01T00:00:00.000Z", action: "collect-context" }],
  };

  it("accepts a complete record", () => {
    expect(RunRecordSchema.parse(record).meta.runId).toBe(record.meta.runId);
  });

  it("allows a null cost estimate rather than forcing a fabricated zero", () => {
    expect(RunRecordSchema.parse(record).meta.estimatedCostUsd).toBeNull();
  });

  it("rejects a provider it does not know about", () => {
    const wrong = { ...record, meta: { ...record.meta, provider: "openai" } };
    expect(RunRecordSchema.safeParse(wrong).success).toBe(false);
  });

  it("rejects a record from a future schema version", () => {
    const wrong = { ...record, schemaVersion: RUN_RECORD_SCHEMA_VERSION + 1 };
    expect(RunRecordSchema.safeParse(wrong).success).toBe(false);
  });
});
