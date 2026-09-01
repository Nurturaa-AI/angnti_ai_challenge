import type { ContextSourceText, RunRecord } from "@repo-arch/shared";
import type { ArchitectureGraph } from "./architecture";
import type { AnsweredQuestion } from "./questions";
import type { AnalysisReport } from "./report";

/**
 * Where a finished analysis lives between requests.
 *
 * A repository is analysed once. Every later request — open the dashboard, draw the
 * graph, look up a citation's source text, ask a question, export a PDF — reads that
 * one analysis back. Re-running the pipeline per request would be slow and, worse,
 * dishonest: a second run may explore differently, so a citation shown in the evidence
 * panel could stop matching the briefing the reader is looking at.
 *
 * The interface is deliberately two methods wide (plus a listing for the UI's picker).
 * Nothing here knows about a database, a file, or a cache eviction policy, so swapping
 * the in-memory implementation for a persistent one is a new class rather than a change
 * to every caller.
 */

export interface StoredAnalysis {
  id: string;
  createdAt: string;
  report: AnalysisReport;
  graph: ArchitectureGraph;
  /** The full run record, so the trajectory stays inspectable. */
  record: RunRecord;
  /**
   * The evidence ledger, with text. Held here and not in the report because the report
   * is the portable artefact and this is the repository's bytes.
   */
  sources: ContextSourceText[];
  /** Absolute path, in memory only. The boundary root for any follow-up tool call. */
  repositoryRoot: string;
  /** Questions asked against this analysis, oldest first. */
  questions: AnsweredQuestion[];
}

export interface StoredAnalysisSummary {
  id: string;
  createdAt: string;
  repositoryName: string;
  system: string;
  model: string;
  questionCount: number;
}

export interface AnalysisStore {
  save(analysis: StoredAnalysis): void;
  get(id: string): StoredAnalysis | undefined;
  list(): StoredAnalysisSummary[];
}

/**
 * The default store: a bounded map, newest last.
 *
 * Bounded because the process is long-lived and each entry holds a repository's worth
 * of evidence text. Evicting the oldest is the right failure for a tool someone runs
 * locally to read one repository at a time; it is the wrong one for a shared service,
 * which is a reason to implement a persistent store rather than to raise the cap.
 */
export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly entries = new Map<string, StoredAnalysis>();

  constructor(private readonly maxEntries = 16) {}

  save(analysis: StoredAnalysis): void {
    // Re-saving an existing id (a new question was answered) must not change its age.
    if (!this.entries.has(analysis.id) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(analysis.id, analysis);
  }

  get(id: string): StoredAnalysis | undefined {
    return this.entries.get(id);
  }

  list(): StoredAnalysisSummary[] {
    return [...this.entries.values()]
      .map((analysis) => ({
        id: analysis.id,
        createdAt: analysis.createdAt,
        repositoryName: analysis.report.repository.name,
        system: analysis.report.system,
        model: analysis.report.model,
        questionCount: analysis.questions.length,
      }))
      .reverse();
  }
}
