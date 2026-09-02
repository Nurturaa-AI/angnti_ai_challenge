import { formatError, redactSecrets, RepoArchaeologistError, RequestError } from "@repo-arch/shared";
import type { AnalysisPhase, AnalysisStatus } from "./store/types";

/**
 * Analysis progress, as the browser is allowed to see it.
 *
 * Five event types, each one a fact the product layer observed. What is *not*
 * here is the point: no model text, no tool arguments, no tool results, no
 * prompts, no absolute paths. A phase event says "the pipeline reached
 * scouting"; it does not say what the scout searched for or what it found. The
 * trajectory that would answer those questions stays inside the run and is never
 * persisted (see `store/projection.ts`), so there is no path from here to it.
 */
export type AnalysisEvent =
  | { type: "analysis.created"; analysisId: string; at: string; repositoryPath: string; status: AnalysisStatus }
  | { type: "analysis.started"; analysisId: string; at: string; status: AnalysisStatus }
  | { type: "analysis.phase"; analysisId: string; at: string; phase: AnalysisPhase; message: string }
  | { type: "analysis.completed"; analysisId: string; at: string; durationMs: number }
  | { type: "analysis.failed"; analysisId: string; at: string; error: string };

export type AnalysisEventType = AnalysisEvent["type"];

/** One line of prose per phase. The browser shows these verbatim. */
export const PHASE_MESSAGES: Record<AnalysisPhase, string> = {
  "collecting-context": "Collecting reconnaissance context",
  scouting: "Searching the repository for relevant files",
  exploring: "Reading files and following the evidence",
  synthesizing: "Drafting the briefing",
  "validating-schema": "Checking the briefing against its schema",
  "refining-evidence": "Re-ordering and corroborating citations",
  grounding: "Verifying every citation against the evidence ledger",
  "building-report": "Assembling the report and architecture graph",
};

type Listener = (event: AnalysisEvent) => void;

/**
 * A per-analysis publish/subscribe bus with a bounded replay buffer.
 *
 * The replay buffer is what makes the stream usable rather than merely correct.
 * A browser that posts an analysis and then opens the event stream is always a
 * round trip late, so without replay it would reliably miss `analysis.created`
 * and often `analysis.started`. Keeping the events for an analysis and sending
 * them to a new subscriber first means a late subscriber sees the same sequence
 * as an early one — which is exactly the property the tests assert.
 *
 * Bounded twice over: at most `maxEventsPerAnalysis` per analysis, and at most
 * `maxAnalyses` analyses, oldest evicted. This is a live-progress buffer, not a
 * record; the record is the database.
 */
export class AnalysisEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly history = new Map<string, AnalysisEvent[]>();

  constructor(
    private readonly maxEventsPerAnalysis = 64,
    private readonly maxAnalyses = 64,
  ) {}

  /** Records the event and delivers it to every current subscriber. */
  emit(event: AnalysisEvent): void {
    const events = this.history.get(event.analysisId) ?? [];
    events.push(event);
    if (events.length > this.maxEventsPerAnalysis) events.splice(0, events.length - this.maxEventsPerAnalysis);
    this.history.set(event.analysisId, events);

    if (this.history.size > this.maxAnalyses) {
      const oldest = this.history.keys().next();
      if (!oldest.done && oldest.value !== event.analysisId) this.history.delete(oldest.value);
    }

    for (const listener of this.listeners.get(event.analysisId) ?? []) {
      try {
        listener(event);
      } catch {
        // A subscriber whose socket died must not stop the analysis. The
        // transport removes it on close; this is the belt to that braces.
      }
    }
  }

  /**
   * Subscribes to one analysis, replaying what it has already emitted.
   *
   * Returns the unsubscribe function rather than taking a token, so a caller
   * cannot unsubscribe someone else's listener.
   */
  subscribe(analysisId: string, listener: Listener): () => void {
    for (const event of this.history.get(analysisId) ?? []) listener(event);

    const listeners = this.listeners.get(analysisId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(analysisId, listeners);

    return () => {
      const current = this.listeners.get(analysisId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(analysisId);
    };
  }

  /** What has been emitted for one analysis, oldest first. */
  replay(analysisId: string): readonly AnalysisEvent[] {
    return this.history.get(analysisId) ?? [];
  }

  subscriberCount(analysisId: string): number {
    return this.listeners.get(analysisId)?.size ?? 0;
  }

  /** Called after a delete: an id that no longer exists has no progress. */
  forget(analysisId: string): void {
    this.history.delete(analysisId);
    this.listeners.delete(analysisId);
  }
}

/**
 * Turns any failure into one sentence a stranger may read.
 *
 * The rule is that the *category* of the error decides whether its text
 * survives. Our own error types are written to be read by the person who caused
 * them — a missing field, a path outside the repository, a model that returned
 * unparseable JSON — so their message passes through, redacted. Anything else is
 * an exception we did not anticipate, and its message is a filesystem path, a
 * SQL fragment or a stack frame at least as often as it is an explanation, so it
 * is replaced wholesale rather than filtered.
 *
 * The `hint` is deliberately dropped even for our own errors: hints exist to
 * tell an *operator* which file to look at, and this string is for a browser.
 */
export function safeFailureMessage(error: unknown): string {
  if (error instanceof RequestError || error instanceof RepoArchaeologistError) {
    return redactSecrets(error.message);
  }
  return "The analysis failed. See the server log for details.";
}

/**
 * The operator's version: everything, for stderr, redacted.
 *
 * Kept next to `safeFailureMessage` so the pair is obvious — one of these is for
 * the browser and one is for the terminal, and confusing them is the bug this
 * module exists to prevent.
 */
export function logFailureMessage(error: unknown): string {
  return redactSecrets(formatError(error));
}

/** The legal transitions. Anything else is a bug in the caller, not in the input. */
const ALLOWED: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
  queued: ["validating", "failed"],
  validating: ["analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function canTransition(from: AnalysisStatus, to: AnalysisStatus): boolean {
  return ALLOWED[from].includes(to);
}
