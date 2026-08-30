import { redactSecrets } from "./paths";
import type { TrajectoryStep } from "./schemas";

/**
 * Records what the system did, in order, so a reader can audit the run rather
 * than trust the report. For the baseline the trajectory is short by design —
 * that shortness is exactly the comparison the advanced agent will be measured
 * against.
 */

/** Detail payloads are capped so a trajectory never becomes a copy of the repository. */
const MAX_DETAIL_CHARS = 2_000;

export class TrajectoryRecorder {
  private readonly steps: TrajectoryStep[] = [];
  private lastMark: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastMark = this.now();
  }

  /** Records one action, timing it from the previous step. */
  step(action: string, detail?: unknown): void {
    const at = this.now();
    const entry: TrajectoryStep = {
      step: this.steps.length + 1,
      at: new Date(at).toISOString(),
      action,
      durationMs: at - this.lastMark,
    };
    if (detail !== undefined) entry.detail = truncateDetail(detail);
    this.steps.push(entry);
    this.lastMark = at;
  }

  toJSON(): TrajectoryStep[] {
    return this.steps.map((step) => ({ ...step }));
  }

  get length(): number {
    return this.steps.length;
  }
}

function truncateDetail(detail: unknown): unknown {
  if (typeof detail === "string") {
    const safe = redactSecrets(detail);
    return safe.length > MAX_DETAIL_CHARS ? `${safe.slice(0, MAX_DETAIL_CHARS)}... [truncated]` : safe;
  }
  const serialized = safeStringify(detail);
  if (serialized.length <= MAX_DETAIL_CHARS) return JSON.parse(serialized) as unknown;
  return `${serialized.slice(0, MAX_DETAIL_CHARS)}... [truncated]`;
}

function safeStringify(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value) ?? "null");
  } catch {
    return '"<unserialisable>"';
  }
}
