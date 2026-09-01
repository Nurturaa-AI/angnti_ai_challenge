import type { AnalysisReport, ReportEvidence } from "../src/report";
import { ANALYSIS_REPORT_SCHEMA_VERSION } from "../src/report";

/**
 * A report fixture, assembled by hand.
 *
 * The architecture graph and the PDF are both pure functions of a report, so their
 * tests are better served by a report they fully control than by one produced by
 * running a pipeline: a graph test that has to reverse-engineer what the mock model
 * happened to say is a test of the mock.
 *
 * Nothing in here is taken from the evaluation fixtures. The names are generic on
 * purpose — a graph test that passed only for `orders-api` would be measuring the
 * wrong thing, and §24 forbids exactly that shape of coupling.
 */

export function evidence(id: string, overrides: Partial<ReportEvidence> = {}): ReportEvidence {
  return {
    id,
    type: "file",
    source: `src/${id}.ts`,
    sourceId: `file:src/${id}.ts`,
    location: undefined,
    excerpt: undefined,
    supports: undefined,
    origins: ["reconnaissance"],
    claimIds: [],
    ...overrides,
  };
}

export interface ReportOverrides {
  components?: AnalysisReport["components"];
  flows?: AnalysisReport["flows"];
  dependencies?: AnalysisReport["dependencies"];
  testing?: Partial<AnalysisReport["testing"]>;
  risks?: AnalysisReport["risks"];
  evidence?: ReportEvidence[];
  overviewEvidenceIds?: string[];
  audit?: Partial<AnalysisReport["audit"]>;
  metrics?: Partial<AnalysisReport["metrics"]>;
  summary?: string;
  architecture?: string;
  openQuestions?: string[];
  recommendedReading?: AnalysisReport["recommendedReading"];
  confidence?: number;
}

export function report(overrides: ReportOverrides = {}): AnalysisReport {
  const components = overrides.components ?? [
    {
      id: "components-0",
      section: "components",
      evidenceIds: ["ev-001"],
      name: "HTTP router",
      path: "src/router.ts",
      responsibility: "Exposes the request routes.",
    },
    {
      id: "components-1",
      section: "components",
      evidenceIds: ["ev-002"],
      name: "record store",
      path: "src/store.ts",
      responsibility: "Writes records to the database.",
    },
  ];

  return {
    schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
    id: "advanced-widget-2026-01-02T03-04-05Z",
    system: "advanced",
    systemVersion: "0.1.0",
    provider: "mock",
    model: "test-model",
    startedAt: "2026-01-02T03:04:05.000Z",
    finishedAt: "2026-01-02T03:04:06.000Z",
    repository: {
      name: "widget",
      path: "tmp/widget",
      isGitRepository: false,
      head: null,
      fileCount: 4,
      directoryCount: 1,
      totalBytes: 512,
      languages: [{ extension: ".ts", files: 4 }],
    },
    summary: overrides.summary ?? "A small service. It receives requests and stores records.",
    architecture: overrides.architecture ?? "A router in front of a store.",
    overviewEvidenceIds: overrides.overviewEvidenceIds ?? ["ev-001"],
    components,
    flows: overrides.flows ?? [],
    dependencies: overrides.dependencies ?? [
      {
        id: "dependencies-0",
        section: "dependencies",
        evidenceIds: ["ev-003"],
        name: "express",
        version: "^4.19.2",
        scope: "runtime",
        purpose: "HTTP server.",
      },
    ],
    testing: {
      id: "testing-0",
      section: "testing",
      evidenceIds: ["ev-004"],
      approach: "One unit suite.",
      frameworks: ["vitest"],
      testPaths: ["test/"],
      gaps: [],
      ...overrides.testing,
    },
    risks: overrides.risks ?? [],
    recommendedReading: overrides.recommendedReading ?? [{ path: "src/router.ts", reason: "The entry point.", order: 1 }],
    openQuestions: overrides.openQuestions ?? [],
    confidence: overrides.confidence ?? 0.6,
    evidence: overrides.evidence ?? [
      evidence("ev-001", { source: "src/router.ts", sourceId: "file:src/router.ts", claimIds: ["overview", "components-0"] }),
      evidence("ev-002", { source: "src/store.ts", sourceId: "file:src/store.ts", claimIds: ["components-1"] }),
      evidence("ev-003", { source: "package.json", sourceId: "file:package.json", claimIds: ["dependencies-0"] }),
      evidence("ev-004", { source: "test/router.test.ts", sourceId: "file:test/router.test.ts", claimIds: ["testing-0"] }),
    ],
    sources: [
      { id: "file:src/router.ts", type: "file", bytes: 128, truncated: false, origins: ["reconnaissance"], citationCount: 1 },
      { id: "file:src/store.ts", type: "file", bytes: 96, truncated: false, origins: ["scout"], citationCount: 1 },
      { id: "file:package.json", type: "file", bytes: 64, truncated: false, origins: ["reconnaissance"], citationCount: 1 },
      { id: "file:test/router.test.ts", type: "file", bytes: 80, truncated: false, origins: ["model-tool"], citationCount: 1 },
    ],
    audit: { claimed: 4, grounded: 4, dropped: [], unsupportedClaims: 0, ...overrides.audit },
    metrics: {
      durationMs: 1000,
      filesInspected: 4,
      ledgerSources: 4,
      evidenceCount: 4,
      citationsClaimed: 4,
      citationsGrounded: 4,
      citationsDropped: 0,
      unsupportedClaims: 0,
      toolCalls: 2,
      scoutFilesRead: 1,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: null,
      ...overrides.metrics,
    },
  };
}
