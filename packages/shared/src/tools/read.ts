import { readFileSync } from "node:fs";
import { ToolError } from "../errors";
import type { ContextSourceText } from "../context-format";
import { looksBinary, resolveInsideRepository, statOrNull } from "./boundary";
import { clamp, readIntegerArgument, readStringArgument } from "./search";
import type { ToolContext, ToolDefinition, ToolOutcome } from "./types";

/**
 * `read_file` — the only tool that produces citable evidence.
 *
 * Two representations come out of one call and they are not the same string:
 *
 *   - `output`  — line-numbered, for the model, so it can cite a location.
 *   - `artifacts[0].text` — the raw slice, for the evidence ledger, so that a
 *     multi-line excerpt the model quotes can be verified character for character.
 *
 * If the ledger held the numbered form, a two-line quotation would fail
 * verification against interleaved gutter text and a truthful citation would be
 * dropped. Keeping them separate makes grounding strict without making it wrong.
 */

export const READ_FILE_DEFINITION: ToolDefinition = {
  name: "read_file",
  description:
    "Read a text file from the repository, with line numbers. Use startLine and endLine to read a " +
    "region of a large file. Output is capped by the run's line and byte budget and says so when it " +
    "truncates. Binary files, lockfiles and paths outside the repository are refused. " +
    "This is the only tool whose output you may quote in evidence: an excerpt is verified against the " +
    "exact bytes this call returned.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Repository-relative path to the file, e.g. \"src/services/inventory.js\".",
      },
      startLine: {
        type: "integer",
        description: "Optional 1-based first line to return. Defaults to 1.",
      },
      endLine: {
        type: "integer",
        description: "Optional 1-based last line to return, inclusive. Defaults to the line budget from startLine.",
      },
    },
    required: ["path"],
  },
};

export function readFileTool(context: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const requestedPath = readStringArgument(args, "path", { required: true }) ?? "";
  const startArgument = readIntegerArgument(args, "startLine");
  const endArgument = readIntegerArgument(args, "endLine");

  const target = resolveInsideRepository(context.repositoryRoot, requestedPath);
  if (target.relative === "") {
    throw new ToolError(
      "read_file needs a file path, not the repository root.",
      "Use list_directory to see the root, then read_file on a file inside it.",
    );
  }

  const stat = statOrNull(target.absolute);
  if (!stat) {
    throw new ToolError(
      `No such file in the repository: "${target.relative}".`,
      "Check the path with search_code or list_directory first.",
    );
  }
  if (stat.isDirectory) {
    throw new ToolError(
      `"${target.relative}" is a directory, not a file.`,
      "Use list_directory for directories.",
    );
  }

  let raw: string;
  try {
    raw = readFileSync(target.absolute, "utf8");
  } catch (error) {
    throw new ToolError(
      `Could not read "${target.relative}": ${error instanceof Error ? error.message : String(error)}.`,
      "The file may be unreadable on this machine.",
    );
  }
  if (looksBinary(raw)) {
    throw new ToolError(
      `"${target.relative}" is a binary file.`,
      "Only text files can be read. Look for a source file instead.",
    );
  }

  // Line endings are normalised so a citation verifies identically on any checkout.
  // A single trailing newline is conventional and would otherwise be reported as a
  // phantom final line, which misleads the model about where the file ends.
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  const totalLines = lines.length;

  const start = clamp(startArgument ?? 1, 1, Math.max(totalLines, 1));
  const requestedEnd = endArgument ?? start + context.budget.maxFileLines - 1;
  if (endArgument !== undefined && endArgument < start) {
    throw new ToolError(
      `endLine (${endArgument}) is before startLine (${start}).`,
      "Pass endLine greater than or equal to startLine, or omit it.",
    );
  }
  const budgetCeiling = start + context.budget.maxFileLines - 1;
  const lineCeiling = Math.min(requestedEnd, budgetCeiling, totalLines);

  const selected = lines.slice(start - 1, lineCeiling);
  // Only a *budget* cut counts as truncation in the header: stopping at an endLine
  // the model asked for is the tool doing what it was told, not withholding. With no
  // endLine the model implicitly asked for the rest of the file, so the comparison
  // is against the end of the file rather than against the budget itself.
  const wanted = Math.min(endArgument ?? totalLines, totalLines);
  const truncatedByLines = budgetCeiling < wanted;

  // Byte budget is applied after the line budget, on whole lines, so the raw text
  // in the ledger is always a prefix of real file content — never a half character.
  const { kept, truncatedByBytes } = applyByteBudget(selected, context.budget.maxFileBytes);
  const endLine = start + kept.length - 1;
  const rawSlice = kept.join("\n");
  const truncated = truncatedByLines || truncatedByBytes;
  const isPartialView = start > 1 || endLine < totalLines;

  const gutter = String(endLine).length;
  const numbered = kept.map((line, index) => `${String(start + index).padStart(gutter, " ")} | ${line}`);

  const header =
    `${target.relative} — lines ${start}-${endLine} of ${totalLines}` +
    (truncated ? ` (truncated: ${truncatedByBytes ? "byte" : "line"} budget reached)` : "");
  const footer = isPartialView && endLine < totalLines
    ? `[... ${totalLines - endLine} more line(s). Call read_file again with startLine=${endLine + 1} for the rest ...]`
    : undefined;

  const artifact: ContextSourceText = {
    id: target.relative,
    type: "file",
    text: rawSlice,
    bytes: Buffer.byteLength(rawSlice, "utf8"),
    // `truncated` here drives the grounding message a reader sees when a quote
    // falls outside the retained region, so it must reflect the whole file.
    truncated: isPartialView,
  };

  return {
    output: [header, ...numbered, ...(footer ? [footer] : [])].join("\n"),
    artifacts: [artifact],
    isError: false,
    summary: {
      path: target.relative,
      startLine: start,
      endLine,
      totalLines,
      bytes: artifact.bytes,
      truncated,
      partialView: isPartialView,
    },
  };
}

function applyByteBudget(lines: readonly string[], maxBytes: number): { kept: string[]; truncatedByBytes: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > maxBytes && kept.length > 0) {
      return { kept, truncatedByBytes: true };
    }
    kept.push(line);
    used += cost;
  }
  return { kept, truncatedByBytes: false };
}
