import { redactSecrets } from "@repo-arch/shared";

/**
 * Observability, at the granularity a reader of this tool actually needs.
 *
 * Every event is a count, a duration or an identifier. Nothing here carries repository
 * content, a citation excerpt, a question's text or an answer's text — not because
 * those are uninteresting, but because a metrics stream is the wrong place for them:
 * it is the thing most likely to be forwarded somewhere with weaker access controls
 * than the repository it describes. Every string that does get recorded still goes
 * through `redactSecrets`, the same function the trajectories use, so a repository name
 * or path that happens to look like a credential cannot leak through this path either.
 */

export interface MetricEvent {
  at: string;
  kind: "analysis" | "question" | "export";
  analysisId: string;
  fields: Record<string, string | number | boolean>;
}

export interface MetricsSink {
  record(event: MetricEvent): void;
  snapshot(): MetricEvent[];
}

export interface AnalysisMetrics {
  analysisId: string;
  system: string;
  model: string;
  durationMs: number;
  filesInspected: number;
  ledgerSources: number;
  evidenceCount: number;
  citationsGrounded: number;
  citationsDropped: number;
  unsupportedClaims: number;
  nodeCount: number;
  edgeCount: number;
}

export interface QuestionMetrics {
  analysisId: string;
  /** 1 for the first question asked against this analysis. */
  questionNumber: number;
  durationMs: number;
  /** Tool calls the question's own bounded loop spent. */
  toolCalls: number;
  scoutFilesRead: number;
  citationsClaimed: number;
  citationsGrounded: number;
  /** False when nothing survived grounding and the fallback answer was returned. */
  supported: boolean;
  followUp: boolean;
}

export interface ExportMetrics {
  analysisId: string;
  format: string;
  bytes: number;
  durationMs: number;
}

/**
 * A bounded ring of recent events, plus an optional line logger.
 *
 * Bounded for the same reason the store is: this runs in a long-lived process, and an
 * unbounded event list is a memory leak that only shows up after a long session.
 */
export class ObservabilityRecorder implements MetricsSink {
  private readonly events: MetricEvent[] = [];

  constructor(
    private readonly log?: ((line: string) => void) | undefined,
    private readonly maxEvents = 500,
  ) {}

  record(event: MetricEvent): void {
    const safe: MetricEvent = {
      ...event,
      analysisId: redactSecrets(event.analysisId),
      fields: Object.fromEntries(
        Object.entries(event.fields).map(([key, value]) => [
          key,
          typeof value === "string" ? redactSecrets(value) : value,
        ]),
      ),
    };
    this.events.push(safe);
    if (this.events.length > this.maxEvents) this.events.shift();
    this.log?.(formatEvent(safe));
  }

  snapshot(): MetricEvent[] {
    return this.events.map((event) => ({ ...event, fields: { ...event.fields } }));
  }

  analysisCompleted(metrics: AnalysisMetrics, at: Date = new Date()): void {
    const { analysisId, ...fields } = metrics;
    this.record({ at: at.toISOString(), kind: "analysis", analysisId, fields });
  }

  questionAnswered(metrics: QuestionMetrics, at: Date = new Date()): void {
    const { analysisId, ...fields } = metrics;
    this.record({ at: at.toISOString(), kind: "question", analysisId, fields });
  }

  exportGenerated(metrics: ExportMetrics, at: Date = new Date()): void {
    const { analysisId, ...fields } = metrics;
    this.record({ at: at.toISOString(), kind: "export", analysisId, fields });
  }
}

function formatEvent(event: MetricEvent): string {
  const fields = Object.entries(event.fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `${event.at} ${event.kind} ${event.analysisId} ${fields}`;
}
