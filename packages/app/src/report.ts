import {
  createSourceResolver,
  type ContextSourceText,
  type Evidence,
  type EvidenceAudit,
  type EvidenceType,
  type RecommendedReading,
  type RepositoryInfo,
  type RunRecord,
  type TrajectoryStep,
} from "@repo-arch/shared";
import type { AnalysisRun } from "./service";

/**
 * The unified analysis report — one shape the dashboard, the architecture graph, the
 * question answerer and the PDF exporter all read.
 *
 * It is an adaptation of `AnalysisResult`, not a replacement for it. The pipeline's
 * schemas stay the source of truth for what a model may assert; this is the same
 * content with one structural change: a claim no longer *contains* its citations, it
 * names them. Every citation is interned once into an addressable table, so that
 *
 *   - a graph node can carry `evidenceIds` without duplicating the evidence,
 *   - the UI can link two claims that rest on the same line of the same file,
 *   - `GET /api/analysis/:id/evidence/:evidenceId` has something to address.
 *
 * Nothing here is model-authored, so nothing here is validated with Zod: it is
 * derived, by this file, from an already-validated `RunRecord`. The Zod schemas in
 * this package guard the two places untrusted input actually arrives — an HTTP
 * request body, and a model's answer to a question.
 */

export const ANALYSIS_REPORT_SCHEMA_VERSION = 1;

/** Dashboard sections, in the order the UI presents them. */
export const REPORT_SECTIONS = [
  "overview",
  "components",
  "flows",
  "dependencies",
  "testing",
  "risks",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * How an artefact came to be in the evidence ledger.
 *
 * Recorded per *source* rather than per citation, which is a real limitation worth
 * stating plainly: `EvidenceSchema` describes what a model may write, and a model
 * cannot know how a file reached it. Adding a provenance field there would mean
 * asking the model to self-report something the harness already knows — and the
 * harness's answer is the trustworthy one. So provenance is derived from the run
 * record and attached to the source.
 *
 * The consequence for `"corroboration"`: it means "the precision pass attached this
 * source to at least one claim", not "this exact citation came from the pass".
 */
export const EVIDENCE_ORIGINS = ["reconnaissance", "scout", "model-tool", "corroboration"] as const;

export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

/** One citation, interned. Every one of these survived grounding. */
export interface ReportEvidence {
  /** Stable within a report: `ev-001`, in traversal order. */
  id: string;
  type: EvidenceType;
  /** As the model wrote it. */
  source: string;
  /** The ledger artefact it resolves to, or `null` if unresolvable. */
  sourceId: string | null;
  location: string | undefined;
  excerpt: string | undefined;
  supports: string | undefined;
  origins: EvidenceOrigin[];
  /** Claims citing this, for the reverse lookup the evidence explorer needs. */
  claimIds: string[];
}

/** One ledger artefact, as the evidence explorer lists it. */
export interface ReportSource {
  id: string;
  type: EvidenceType;
  bytes: number;
  /** True when only part of the artefact is in the ledger. */
  truncated: boolean;
  origins: EvidenceOrigin[];
  citationCount: number;
}

interface ClaimBase {
  /** Stable within a report: `components-0`, `risks-2`. Addressable from a graph node. */
  id: string;
  section: ReportSection;
  evidenceIds: string[];
}

export interface ReportComponent extends ClaimBase {
  name: string;
  path: string | undefined;
  responsibility: string;
}

export interface ReportFlow extends ClaimBase {
  name: string;
  description: string;
  steps: string[];
}

export interface ReportDependency extends ClaimBase {
  name: string;
  version: string | undefined;
  scope: string;
  purpose: string | undefined;
}

export interface ReportTesting extends ClaimBase {
  approach: string;
  frameworks: string[];
  testPaths: string[];
  gaps: string[];
}

export interface ReportRisk extends ClaimBase {
  title: string;
  description: string;
  severity: string;
}

export interface ReportMetrics {
  durationMs: number;
  /** Files whose contents reached the ledger, the scout's reads included. */
  filesInspected: number;
  ledgerSources: number;
  /** Distinct citations in the report after interning. */
  evidenceCount: number;
  citationsClaimed: number;
  citationsGrounded: number;
  citationsDropped: number;
  unsupportedClaims: number;
  /** The model's own tool calls. Zero for the baseline, which has no tools. */
  toolCalls: number;
  scoutFilesRead: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
}

export interface AnalysisReport {
  schemaVersion: number;
  /** The run id. One analysis, one report, one id. */
  id: string;
  system: string;
  systemVersion: string;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  repository: RepositoryInfo;
  summary: string;
  architecture: string;
  /** Citations for `summary` and `architecture`, which belong to no section. */
  overviewEvidenceIds: string[];
  components: ReportComponent[];
  flows: ReportFlow[];
  dependencies: ReportDependency[];
  testing: ReportTesting;
  risks: ReportRisk[];
  recommendedReading: RecommendedReading[];
  openQuestions: string[];
  confidence: number;
  evidence: ReportEvidence[];
  sources: ReportSource[];
  /** Verbatim from the run: what was claimed, what survived, what was dropped and why. */
  audit: EvidenceAudit;
  metrics: ReportMetrics;
}

export function buildAnalysisReport(run: AnalysisRun): AnalysisReport {
  const { record, sources } = run;
  const result = record.result;
  const origins = deriveOrigins(record, sources);
  const resolveSource = createSourceResolver(sources);

  const table = new EvidenceTable(origins, resolveSource);

  // Traversal order fixes the ids, so the same run always produces the same report.
  // Overview first because `summary` and `architecture` are what a reader meets first.
  const overviewEvidenceIds = table.intern("overview", result.evidence);

  const components = result.components.map((component, index) => ({
    id: `components-${index}`,
    section: "components" as const,
    name: component.name,
    path: component.path,
    responsibility: component.responsibility,
    evidenceIds: table.intern(`components-${index}`, component.evidence),
  }));

  const flows = result.flows.map((flow, index) => ({
    id: `flows-${index}`,
    section: "flows" as const,
    name: flow.name,
    description: flow.description,
    steps: [...flow.steps],
    evidenceIds: table.intern(`flows-${index}`, flow.evidence),
  }));

  const dependencies = result.dependencies.map((dependency, index) => ({
    id: `dependencies-${index}`,
    section: "dependencies" as const,
    name: dependency.name,
    version: dependency.version,
    scope: dependency.scope,
    purpose: dependency.purpose,
    evidenceIds: table.intern(`dependencies-${index}`, dependency.evidence),
  }));

  const testing: ReportTesting = {
    id: "testing-0",
    section: "testing",
    approach: result.testing.approach,
    frameworks: [...result.testing.frameworks],
    testPaths: [...result.testing.testPaths],
    gaps: [...result.testing.gaps],
    evidenceIds: table.intern("testing-0", result.testing.evidence),
  };

  const risks = result.risks.map((risk, index) => ({
    id: `risks-${index}`,
    section: "risks" as const,
    title: risk.title,
    description: risk.description,
    severity: risk.severity,
    evidenceIds: table.intern(`risks-${index}`, risk.evidence),
  }));

  const evidence = table.toArray();
  const citationCounts = new Map<string, number>();
  for (const item of evidence) {
    if (item.sourceId === null) continue;
    citationCounts.set(item.sourceId, (citationCounts.get(item.sourceId) ?? 0) + 1);
  }

  const exploration = record.meta.exploration;

  return {
    schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
    id: record.meta.runId,
    system: record.meta.system,
    systemVersion: record.meta.systemVersion,
    provider: record.meta.provider,
    model: record.meta.model,
    startedAt: record.meta.startedAt,
    finishedAt: record.meta.finishedAt,
    repository: result.repository,
    summary: result.summary,
    architecture: result.architecture,
    overviewEvidenceIds,
    components,
    flows,
    dependencies,
    testing,
    risks,
    recommendedReading: [...result.recommendedReading].sort((a, b) => a.order - b.order),
    openQuestions: [...result.openQuestions],
    confidence: result.confidence,
    evidence,
    sources: sources.map((source) => ({
      id: source.id,
      type: source.type,
      bytes: source.bytes,
      truncated: source.truncated,
      origins: origins.get(source.id) ?? [],
      citationCount: citationCounts.get(source.id) ?? 0,
    })),
    audit: record.meta.evidenceAudit,
    metrics: {
      durationMs: record.meta.durationMs,
      filesInspected: exploration?.filesRead.length ?? 0,
      ledgerSources: sources.length,
      evidenceCount: evidence.length,
      citationsClaimed: record.meta.evidenceAudit.claimed,
      citationsGrounded: record.meta.evidenceAudit.grounded,
      citationsDropped: record.meta.evidenceAudit.dropped.length,
      unsupportedClaims: record.meta.evidenceAudit.unsupportedClaims,
      toolCalls: exploration?.toolCalls ?? 0,
      scoutFilesRead: exploration?.scout?.filesRead ?? 0,
      inputTokens: record.meta.usage.inputTokens,
      outputTokens: record.meta.usage.outputTokens,
      estimatedCostUsd: record.meta.estimatedCostUsd,
    },
  };
}

/** Looks a citation up by id. Returns `undefined` for an id this report never issued. */
export function findReportEvidence(report: AnalysisReport, evidenceId: string): ReportEvidence | undefined {
  return report.evidence.find((item) => item.id === evidenceId);
}

/** Every claim in the report, flattened, for exporters and the graph builder. */
export function reportClaims(report: AnalysisReport): ClaimBase[] {
  return [...report.components, ...report.flows, ...report.dependencies, report.testing, ...report.risks];
}

/**
 * Interns citations, deduplicating identical ones.
 *
 * Two claims resting on the same lines of the same file is the normal case after the
 * precision pass, not an anomaly — so they share an id, and the shared id is what
 * lets the UI show "this evidence supports 3 claims" instead of listing it three
 * times as though it were three findings.
 */
class EvidenceTable {
  private readonly byKey = new Map<string, ReportEvidence>();
  private readonly order: string[] = [];

  constructor(
    private readonly origins: Map<string, EvidenceOrigin[]>,
    private readonly resolveSource: (source: string) => ContextSourceText | undefined,
  ) {}

  intern(claimId: string, items: readonly Evidence[]): string[] {
    const ids: string[] = [];
    for (const item of items) {
      const key = [item.type, item.source, item.location ?? "", item.excerpt ?? ""].join("\u0000");
      const existing = this.byKey.get(key);
      if (existing) {
        if (!existing.claimIds.includes(claimId)) existing.claimIds.push(claimId);
        if (!ids.includes(existing.id)) ids.push(existing.id);
        continue;
      }
      const resolved = this.resolveSource(item.source);
      const sourceId = resolved?.id ?? null;
      const entry: ReportEvidence = {
        id: `ev-${String(this.order.length + 1).padStart(3, "0")}`,
        type: item.type,
        source: item.source,
        sourceId,
        location: item.location,
        excerpt: item.excerpt,
        supports: item.supports,
        origins: sourceId === null ? [] : (this.origins.get(sourceId) ?? []),
        claimIds: [claimId],
      };
      this.byKey.set(key, entry);
      this.order.push(key);
      ids.push(entry.id);
    }
    return ids;
  }

  toArray(): ReportEvidence[] {
    return this.order.flatMap((key) => {
      const entry = this.byKey.get(key);
      return entry ? [entry] : [];
    });
  }
}

/**
 * Works out how each ledger artefact got there, from the run record alone.
 *
 * Every rule below reads something the *harness* wrote, never something the model
 * said. Reconnaissance is identifiable by artefact type. The model's own reads are
 * identifiable from the trajectory, where each successful `tool-call` step records the
 * artefacts that call produced. The scout's reads are then the remainder of
 * `exploration.filesRead` — the union of both systems' reads — which is a subtraction
 * rather than a second source of truth, so the two can never both claim a file.
 */
function deriveOrigins(
  record: RunRecord,
  sources: readonly ContextSourceText[],
): Map<string, EvidenceOrigin[]> {
  const origins = new Map<string, EvidenceOrigin[]>();
  const add = (id: string, origin: EvidenceOrigin): void => {
    const current = origins.get(id);
    if (!current) {
      origins.set(id, [origin]);
      return;
    }
    if (!current.includes(origin)) current.push(origin);
  };

  const RECONNAISSANCE_TYPES = new Set<EvidenceType>(["tree", "readme", "manifest", "metadata"]);
  for (const source of sources) {
    if (RECONNAISSANCE_TYPES.has(source.type)) add(source.id, "reconnaissance");
  }

  const modelRead = new Set(artifactIdsFromToolCalls(record.trajectory));
  for (const id of modelRead) add(id, "model-tool");

  const exploration = record.meta.exploration;
  if (exploration) {
    for (const file of exploration.filesRead) {
      if (!modelRead.has(file)) add(file, "scout");
    }
    for (const source of exploration.precision?.corroboratedSources ?? []) {
      add(source, "corroboration");
    }
  }

  return origins;
}

/**
 * Artefact ids produced by the model's own tool calls.
 *
 * Read from each step's recorded `artifacts` list rather than from the arguments the
 * model passed, because the two are not the same string: a model may write
 * `./src/a.ts` where the ledger holds `src/a.ts`. The artefact list is what the tool
 * actually returned, so it is already in ledger spelling.
 */
function artifactIdsFromToolCalls(trajectory: readonly TrajectoryStep[]): string[] {
  const ids: string[] = [];
  for (const step of trajectory) {
    if (step.action !== "tool-call" || step.ok !== true) continue;
    const detail = step.detail;
    if (typeof detail !== "object" || detail === null) continue;
    const artifacts = (detail as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (typeof artifact !== "object" || artifact === null) continue;
      const id = (artifact as { id?: unknown }).id;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
