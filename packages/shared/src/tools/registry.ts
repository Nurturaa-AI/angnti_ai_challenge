import type { ContextSourceText } from "../context-format";
import { ToolError } from "../errors";
import { listDirectory, LIST_DIRECTORY_DEFINITION } from "./list";
import { readFileTool, READ_FILE_DEFINITION } from "./read";
import { searchCode, SEARCH_CODE_DEFINITION } from "./search";
import type { ToolCall, ToolContext, ToolDefinition, ToolOutcome } from "./types";

/**
 * The toolbox, and the ledger that keeps the model honest.
 *
 * `executeTool` never throws for a bad call. An unknown tool name, a malformed
 * argument, a path outside the repository — all of them come back as a normal
 * tool result flagged `isError`, so the model reads the reason and can correct
 * itself. A crash here would end the run; a message costs one budget step.
 */

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  SEARCH_CODE_DEFINITION,
  READ_FILE_DEFINITION,
  LIST_DIRECTORY_DEFINITION,
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((definition) => definition.name);

type ToolHandler = (context: ToolContext, args: Record<string, unknown>) => ToolOutcome;

const HANDLERS: Record<string, ToolHandler> = {
  [SEARCH_CODE_DEFINITION.name]: searchCode,
  [READ_FILE_DEFINITION.name]: readFileTool,
  [LIST_DIRECTORY_DEFINITION.name]: listDirectory,
};

export function executeTool(context: ToolContext, call: ToolCall): ToolOutcome {
  const handler = HANDLERS[call.name];
  if (!handler) {
    return errorOutcome(
      `Unknown tool "${call.name}". Available tools: ${TOOL_NAMES.join(", ")}.`,
      { tool: call.name, reason: "unknown-tool" },
    );
  }

  // A provider can hand back arguments as a JSON string, or as nothing at all.
  const args = normalizeArguments(call.arguments);
  if (args === null) {
    return errorOutcome(
      `Arguments for "${call.name}" were not a JSON object.`,
      { tool: call.name, reason: "malformed-arguments" },
    );
  }

  try {
    return handler(context, args);
  } catch (error) {
    if (error instanceof ToolError) {
      const hint = error.hint ? ` ${error.hint}` : "";
      return errorOutcome(`${error.message}${hint}`, { tool: call.name, reason: "rejected" });
    }
    // An unexpected failure is still not fatal, but it is worth naming as such.
    const message = error instanceof Error ? error.message : String(error);
    return errorOutcome(`${call.name} failed unexpectedly: ${message}`, {
      tool: call.name,
      reason: "unexpected-error",
    });
  }
}

function normalizeArguments(input: unknown): Record<string, unknown> | null {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    if (input.trim() === "") return {};
    try {
      const parsed: unknown = JSON.parse(input);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function errorOutcome(message: string, summary: Record<string, unknown>): ToolOutcome {
  return {
    output: `ERROR: ${message}`,
    artifacts: [],
    isError: true,
    summary: { ...summary, error: message },
  };
}

/**
 * The evidence ledger: every byte of repository content the run actually obtained.
 *
 * Only `record` puts anything in it, and only a tool result reaches `record`. The
 * grounding layer verifies citations against this and nothing else, which is what
 * makes an invented tool result unable to support a claim — the model can write
 * whatever it likes, but it cannot write into here.
 */
export class EvidenceLedger {
  private readonly sources = new Map<string, ContextSourceText>();
  private readonly order: string[] = [];

  constructor(initial: readonly ContextSourceText[] = []) {
    for (const source of initial) this.record(source);
  }

  /**
   * Adds or extends a source. A second `read_file` on the same path with a
   * different region appends rather than replaces, so evidence accumulates and an
   * earlier citation cannot be invalidated by a later call.
   */
  record(source: ContextSourceText): void {
    const existing = this.sources.get(source.id);
    if (!existing) {
      this.sources.set(source.id, { ...source });
      this.order.push(source.id);
      return;
    }
    if (existing.text.includes(source.text)) {
      // Already covered; only the truncation flag can worsen.
      this.sources.set(source.id, { ...existing, truncated: existing.truncated || source.truncated });
      return;
    }
    const text = `${existing.text}\n${source.text}`;
    this.sources.set(source.id, {
      ...existing,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: existing.truncated || source.truncated,
    });
  }

  recordAll(sources: readonly ContextSourceText[]): void {
    for (const source of sources) this.record(source);
  }

  /** Insertion-ordered, so context sources stay ahead of tool-earned ones. */
  toArray(): ContextSourceText[] {
    return this.order.flatMap((id) => {
      const source = this.sources.get(id);
      return source ? [source] : [];
    });
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  get size(): number {
    return this.sources.size;
  }
}
