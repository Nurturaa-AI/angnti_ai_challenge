import type { ArchitectureGraph } from "../architecture";
import type { AnsweredQuestion } from "../questions";
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
  /** Questions asked against this analysis, oldest first. */
  questions: readonly AnsweredQuestion[];
}

export interface ReportExporter {
  /** Short identifier used in routes and filenames, e.g. `pdf`. */
  readonly format: string;
  readonly contentType: string;
  export(input: ExportInput): Promise<Uint8Array>;
  /** Suggested download filename for one report. */
  filename(report: AnalysisReport): string;
}
