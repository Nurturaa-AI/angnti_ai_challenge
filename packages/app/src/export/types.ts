import type { ArchitectureGraph } from "../architecture";
import type { AnsweredQuestionView } from "../questions";
import type { AnalysisReport } from "../report";

/**
 * The export seam.
 *
 * Everything the application knows about producing a document is this interface. The
 * dashboard, the routes and the store never name a format, a library or a byte layout,
 * so a second exporter — HTML, DOCX, a different PDF implementation — is a new class
 * and a new registry entry rather than a change to any caller.
 *
 * `export` returns bytes rather than writing a file. A server streams them to a
 * response, a CLI writes them to disk, and a test asserts on them; a function that
 * chose a path for its caller could do only the middle one.
 */

export interface ExportInput {
  report: AnalysisReport;
  graph: ArchitectureGraph;
  /**
   * Questions asked against this analysis, oldest first.
   *
   * The *view*, not the full answer: an `AnsweredQuestion` carries the model's own
   * trajectory, and a document that gets mailed around is the last place it should
   * appear. Taking the narrower type means the exporter cannot print it even by
   * accident — there is no field to reach for.
   */
  questions: readonly AnsweredQuestionView[];

  /**
   * The stored record's identity and timing.
   *
   * Distinct from `report.metrics.durationMs`, which times the pipeline. This is the
   * lifecycle: how long the analysis took from the moment it was queued, which is
   * the number a reader comparing two exports is actually looking at. Optional so a
   * caller holding only a report — the CLI — can still export one.
   */
  analysisId?: string | undefined;
  createdAt?: string | undefined;
  /** Workspace-relative. Never an absolute host path; see `dto.ts`. */
  repositoryPath?: string | undefined;
  durationMs?: number | null | undefined;
}

export interface ReportExporter {
  /** Short identifier used in routes and filenames, e.g. `pdf`. */
  readonly format: string;
  readonly contentType: string;
  export(input: ExportInput): Promise<Uint8Array>;
  /** Suggested download filename for one report. */
  filename(report: AnalysisReport): string;
}
