import { redactSecrets } from "./paths";
import type { TokenUsage, TrajectoryStep } from "./schemas";

/**
 * Records what the system did, in order, so a reader can audit the run rather
 * than trust the report. For the baseline the trajectory is short by design —
 * that shortness is exactly the comparison the advanced agent will be measured
 * against.
 */

/** Detail payloads are capped so a trajectory never becomes a copy of the repository. */
const MAX_DETAIL_CHARS = 2_000;

/** Tool output is the bulkiest thing in a trajectory, and gets a wider budget. */
const MAX_TOOL_RESULT_CHARS = 4_000;

/**
 * Fields recorded from a tool call or a model turn.
 *
 * These are written from the real call and the real result. Nothing here is ever
 * copied out of model prose, which is the point: the trajectory is the record that
 * lets a reader check whether a citation was earned or invented.
 */
export interface TrajectoryExtras {
  tool?: string | undefined;
  toolArgs?: unknown;
  toolResult?: string | undefined;
  ok?: boolean | undefined;
  usage?: TokenUsage | undefined;
}

export class TrajectoryRecorder {
  private readonly steps: TrajectoryStep[] = [];
  private lastMark: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastMark = this.now();
  }

  /** Records one action, timing it from the previous step. */
  step(action: string, detail?: unknown, extras: TrajectoryExtras = {}): void {
    const at = this.now();
    const entry: TrajectoryStep = {
      step: this.steps.length + 1,
      at: new Date(at).toISOString(),
      action,
      durationMs: at - this.lastMark,
    };
    if (detail !== undefined) entry.detail = truncateDetail(detail);
    if (extras.tool !== undefined) entry.tool = extras.tool;
    if (extras.toolArgs !== undefined) entry.toolArgs = truncateDetail(extras.toolArgs);
    if (extras.toolResult !== undefined) entry.toolResult = truncateText(extras.toolResult, MAX_TOOL_RESULT_CHARS);
    if (extras.ok !== undefined) entry.ok = extras.ok;
    if (extras.usage !== undefined) entry.usage = extras.usage;
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

function truncateText(value: string, limit: number): string {
  const safe = redactSecrets(value);
  return safe.length > limit ? `${safe.slice(0, limit)}... [truncated]` : safe;
}

function truncateDetail(detail: unknown): unknown {
  if (typeof detail === "string") return truncateText(detail, MAX_DETAIL_CHARS);
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
