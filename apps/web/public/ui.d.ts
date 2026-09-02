/*
 * Types for `ui.js`.
 *
 * Hand-written, because there is no build step: the browser loads `ui.js` as-is and
 * TypeScript never compiles it. What this file buys is a typechecked test. Under
 * `moduleResolution: "bundler"`, `import … from "../public/ui.js"` resolves here for
 * `tsc` and to the real module for Node, so `apps/web/test/ui.test.ts` gets the same
 * type safety as the rest of the repository while exercising the exact bytes the
 * browser runs.
 *
 * It is not served: `CONTENT_TYPES` in `apps/web/src/static.ts` has no `.ts` entry, so a
 * request for `/ui.d.ts` is a 404 rather than a source disclosure.
 *
 * Because the declarations are hand-written they can drift from the implementation.
 * Two things limit the damage: the shapes below are mostly the server's own DTOs
 * (imported, not restated, so a server change surfaces here), and the tests call every
 * export.
 */

import type {
  AnalysisReport,
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
} from "@repo-arch/app";
import type { AnalysisSummaryDto, EvidenceViewDto } from "../src/dto";

export interface Section {
  readonly id: string;
  readonly label: string;
}

export const SECTIONS: readonly Section[];
export const NODE_COLOURS: Readonly<Record<string, string>>;

// ---------------------------------------------------------------- lifecycle

export interface PhaseStep {
  readonly phase: string;
  readonly label: string;
}

export const PHASE_STEPS: readonly PhaseStep[];
export const PHASES: readonly string[];

export function phaseIndex(phase: string | null | undefined): number;

export interface StatusDescription {
  readonly label: string;
  /** A class name, not a colour: `queued`, `running`, `good`, `bad`. */
  readonly tone: string;
  readonly running: boolean;
}

export function statusDescription(status: string): StatusDescription;
export function isRunningStatus(status: string): boolean;
export function phaseStep(phase: string | null | undefined): { index: number; total: number } | null;
export function phaseChecklist(
  phase: string | null | undefined,
): { phase: string; label: string; done: boolean; active: boolean }[];
export function progressLine(
  status: string,
  phase?: string | null | undefined,
  phaseMessage?: string | null | undefined,
): string;

// ---------------------------------------------------------------- formatting

export function fmt(value: unknown): string;
export function duration(ms: number | null | undefined): string;
export function truncate(value: unknown, max: number): string;
export function absoluteTime(iso: string): string;
export function relativeTime(iso: string, nowMs: number): string;

// ---------------------------------------------------------------- list rows

export interface AnalysisRowView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pathIsName: boolean;
  readonly status: string;
  readonly statusLabel: string;
  readonly tone: string;
  readonly running: boolean;
  readonly progress: string;
  readonly created: string;
  readonly createdAbsolute: string;
  readonly updated: string;
  readonly updatedAbsolute: string;
  readonly updatedSameAsCreated: boolean;
  readonly summary: string;
  readonly system: string;
  readonly questionCount: number;
  readonly failed: boolean;
  readonly error: string | null;
}

export function describeAnalysisRow(summary: AnalysisSummaryDto, nowMs: number): AnalysisRowView;

// ---------------------------------------------------------------- the graph

export function nodeMatchesSearch(node: ArchitectureNode, search: string): boolean;

export function filterGraph(
  graph: Pick<ArchitectureGraph, "nodes" | "edges">,
  hiddenTypes: ReadonlySet<string>,
  hiddenRelationships: ReadonlySet<string>,
): { nodes: ArchitectureNode[]; edges: ArchitectureEdge[] };

export function relatedNodeIds(
  edges: readonly ArchitectureEdge[],
  selectedId: string | null | undefined,
): Set<string>;

export interface RelationshipView {
  readonly edgeId: string;
  readonly direction: "in" | "out";
  readonly relationship: string;
  readonly otherId: string;
  readonly otherLabel: string;
  readonly description: string;
  readonly evidenceIds: readonly string[];
  readonly phrase: string;
}

export function nodeDetail(
  graph: Pick<ArchitectureGraph, "nodes" | "edges">,
  nodeId: string,
): { node: ArchitectureNode; relationships: RelationshipView[] } | null;

export function edgeDetail(
  graph: Pick<ArchitectureGraph, "nodes" | "edges">,
  edgeId: string,
): { edge: ArchitectureEdge; from: ArchitectureNode | null; to: ArchitectureNode | null } | null;

export interface OutlineRow {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly path: string | null;
  readonly description: string;
  readonly claimId: string;
  readonly evidenceIds: readonly string[];
  readonly relationships: RelationshipView[];
}

export function architectureOutline(graph: Pick<ArchitectureGraph, "nodes" | "edges">): OutlineRow[];
export function graphSummaryLabel(graph: ArchitectureGraph): string;

export interface PlacedNode {
  readonly node: ArchitectureNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface GraphLayout {
  readonly placed: Map<string, PlacedNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
}

export function layoutGraph(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
): GraphLayout;

export const LARGE_GRAPH_NODES: number;
export function defaultGraphView(graph: ArchitectureGraph, narrowViewport: boolean): "diagram" | "outline";

// ---------------------------------------------------------------- evidence

export function evidenceLineRange(payload: EvidenceViewDto): string | null;
export function evidenceLocationLabel(payload: EvidenceViewDto): string;
export function evidenceStrength(payload: EvidenceViewDto): { label: string; tone: string };

// ---------------------------------------------------------------- questions

export const UNSUPPORTED_NOTICE: string;

export function questionOutcome(question: { supported: boolean; failed?: boolean }): {
  state: "supported" | "unsupported" | "error";
  label: string;
  tone: string;
};

// ---------------------------------------------------------------- export

export function countOmittedClaims(report: AnalysisReport): number;
