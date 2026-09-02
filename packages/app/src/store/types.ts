import type { AnalysisReport } from "../report";
import type { ArchitectureGraph } from "../architecture";
import type { AnsweredQuestionView } from "../questions";
import type { AnalysisSystem } from "../service";
import type { EvidenceType } from "@repo-arch/shared";

/**
 * The lifecycle of one analysis.
 *
 * Five states, no more. `queued` is the record's existence; `validating` is the
 * repository boundary check, which is the one thing that can fail before any
 * model call and therefore deserves its own state; `analyzing` covers the
 * pipeline itself; and the two terminal states are self-explanatory. Finer
 * progress is reported as a *phase* inside `analyzing` (see `AnalysisPhase`)
 * rather than as another status, because a phase is an observation and a status
 * is a promise about what the record contains.
 */
export const ANALYSIS_STATUSES = ["queued", "validating", "analyzing", "completed", "failed"] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Statuses after which nothing further will happen to the record on its own. */
export const TERMINAL_STATUSES: readonly AnalysisStatus[] = ["completed", "failed"];

export function isTerminal(status: AnalysisStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The phases the product layer can *observe*, in order.
 *
 * Every one of these corresponds to a real point in the pipeline that the
 * product layer is told about — not to a guess about elapsed time. There is
 * deliberately no interpolation, no fake progress and no percentage: a phase
 * appears when the pipeline reaches it and not before.
 */
export const ANALYSIS_PHASES = [
  "collecting-context",
  "scouting",
  "exploring",
  "synthesizing",
  "validating-schema",
  "refining-evidence",
  "grounding",
  "building-report",
] as const;

export type AnalysisPhase = (typeof ANALYSIS_PHASES)[number];

/**
 * One evidence artefact, as persisted.
 *
 * `id` is the ledger id, which for a file source is the repository-relative
 * path — never an absolute one. `text` is the artefact's content *after*
 * redaction; see `projectEvidence` for why redaction happens here rather than
 * on the way out.
 */
export interface StoredEvidenceSource {
  id: string;
  type: EvidenceType;
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Everything needed to open a record, minus the payloads. */
export interface AnalysisMetadata {
  system: AnalysisSystem;
  provider: string;
  model: string;
  /** The scout focus the analysis was started with, if any. */
  focus: string | null;
  /** Wall-clock time from `queued` to a terminal state, once there is one. */
  durationMs: number | null;
}

/**
 * One durable analysis.
 *
 * What is *absent* here is as deliberate as what is present. There is no
 * `RunRecord`, so no model prose and no tool trajectory can be persisted or
 * served. There is no absolute path: `repositoryPath` is relative to the
 * workspace root the server was started with, so the same database opened on
 * another machine still resolves, and a leaked row leaks nothing about the host
 * filesystem. See `docs/architecture.md` for the full argument.
 */
export interface AnalysisRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AnalysisStatus;
  /** The last phase observed, or `null` before the pipeline starts. */
  phase: AnalysisPhase | null;
  /** Workspace-relative. Never an absolute host path. */
  repositoryPath: string;
  repositoryName: string;
  /** One line for the list view; the report's own summary once there is one. */
  summary: string;
  /** A safe, user-facing sentence. Only ever set when `status === "failed"`. */
  error: string | null;
  metadata: AnalysisMetadata;
  report: AnalysisReport | null;
  graph: ArchitectureGraph | null;
  evidence: readonly StoredEvidenceSource[];
  questions: readonly AnsweredQuestionView[];
}

/** The row shape the list view needs. Cheap to read: no payload columns. */
export interface AnalysisSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AnalysisStatus;
  phase: AnalysisPhase | null;
  repositoryPath: string;
  repositoryName: string;
  summary: string;
  error: string | null;
  system: AnalysisSystem;
  model: string;
  questionCount: number;
}

/** What `create` needs. Everything else is derived or arrives later. */
export interface NewAnalysis {
  id: string;
  repositoryPath: string;
  repositoryName: string;
  system: AnalysisSystem;
  provider: string;
  model: string;
  focus?: string | undefined;
}

/**
 * A partial update. Absent fields are left alone; `null` is a real value for
 * the nullable columns, which is why this is not `Partial<AnalysisRecord>`.
 */
export interface AnalysisPatch {
  status?: AnalysisStatus | undefined;
  phase?: AnalysisPhase | null | undefined;
  summary?: string | undefined;
  error?: string | null | undefined;
  durationMs?: number | null | undefined;
  report?: AnalysisReport | null | undefined;
  graph?: ArchitectureGraph | null | undefined;
  /** Replaces the stored evidence set when present. */
  evidence?: readonly StoredEvidenceSource[] | undefined;
}

/**
 * The durable analysis store.
 *
 * Promise-based even though the only implementation is synchronous
 * (`node:sqlite` is a synchronous binding). The interface is the seam: a caller
 * written against it cannot tell the difference, and a future implementation
 * that talks to something over a socket needs no caller to change. The cost is
 * an `async` keyword on methods that never yield, which is cheap and honest.
 */
export interface AnalysisStore {
  /** Inserts a `queued` record and returns it. Rejects a duplicate id. */
  create(input: NewAnalysis): Promise<AnalysisRecord>;
  get(id: string): Promise<AnalysisRecord | undefined>;
  /** Newest first. */
  list(options?: { limit?: number | undefined }): Promise<AnalysisSummary[]>;
  /** Applies a patch atomically and returns the new state. */
  update(id: string, patch: AnalysisPatch): Promise<AnalysisRecord>;
  /** `true` if a record was removed. Cascades to evidence and questions. */
  delete(id: string): Promise<boolean>;
  /**
   * Appends one answered question, oldest evicted past the bound. Scoped by
   * analysis id, so a question can only ever join the analysis it was asked of.
   */
  appendQuestion(analysisId: string, question: AnsweredQuestionView): Promise<void>;
  /**
   * The only evidence lookup. Both ids are required, so an evidence id from
   * another analysis resolves to nothing rather than to someone else's bytes.
   */
  getEvidenceSource(analysisId: string, sourceId: string): Promise<StoredEvidenceSource | undefined>;
  close(): Promise<void>;
}

/** How many answered questions one analysis keeps. */
export const MAX_STORED_QUESTIONS = 50;
