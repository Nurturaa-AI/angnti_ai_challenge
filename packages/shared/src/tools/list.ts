import { readdirSync } from "node:fs";
import path from "node:path";
import type { ContextSourceText } from "../context-format";
import { ToolError } from "../errors";
import { IGNORED_DIRECTORIES } from "../repo";
import { resolveInsideRepository, statOrNull } from "./boundary";
import { clamp, readIntegerArgument, readStringArgument } from "./search";
import type { ToolContext, ToolDefinition, ToolOutcome } from "./types";

/**
 * `list_directory` — what is actually in this part of the tree.
 *
 * The artefact it registers is appended to the `tree` source rather than given an
 * id of its own. That is a scoring decision, not a cosmetic one: the evaluator
 * treats `tree` as existence-level evidence. Listing a directory proves a file
 * exists; it says nothing about what the file does, and it should not be able to
 * earn the same credit as having read it.
 */

export const LIST_DIRECTORY_DEFINITION: ToolDefinition = {
  name: "list_directory",
  description:
    "List the contents of a directory in the repository. Set depth to 2 or 3 to see nested structure. " +
    "Directories are marked with a trailing slash; files show their size in bytes. Generated and " +
    "vendored directories are omitted. This proves a path exists — it is not enough to support a claim " +
    "about what the code does, which needs read_file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional repository-relative directory. Omit or pass \"\" for the repository root.",
      },
      depth: {
        type: "integer",
        description: "Optional levels to descend, 1 means the directory's immediate children. Clamped to the run's maximum.",
      },
    },
    required: [],
  },
};

interface Entry {
  relative: string;
  depth: number;
  isDirectory: boolean;
  size: number;
}

export function listDirectory(context: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const requestedPath = readStringArgument(args, "path", { required: false });
  const requestedDepth = readIntegerArgument(args, "depth");

  const target = resolveInsideRepository(context.repositoryRoot, requestedPath);
  const stat = statOrNull(target.absolute);
  if (!stat) {
    throw new ToolError(
      `No such directory in the repository: "${target.relative || "."}".`,
      "List the parent directory first to see what exists.",
    );
  }
  if (!stat.isDirectory) {
    throw new ToolError(
      `"${target.relative}" is a file, not a directory.`,
      "Use read_file to read a file.",
    );
  }

  const depth = clamp(requestedDepth ?? 1, 1, context.budget.maxListDepth);
  const entries = walk(target.absolute, target.relative, depth);
  const shown = entries.slice(0, context.budget.maxListEntries);
  const truncated = entries.length > shown.length;

  const label = target.relative === "" ? "." : target.relative;
  const baseDepth = target.relative === "" ? 0 : target.relative.split("/").length;

  const lines = shown.map((entry) => {
    const indent = "  ".repeat(Math.max(entry.relative.split("/").length - baseDepth - 1, 0));
    const name = entry.relative.slice(entry.relative.lastIndexOf("/") + 1);
    return entry.isDirectory ? `${indent}${name}/` : `${indent}${name} (${entry.size} bytes)`;
  });
  if (truncated) {
    lines.push(`[... ${entries.length - shown.length} more entr(ies) omitted at maxListEntries=${context.budget.maxListEntries} ...]`);
  }
  if (shown.length === 0) lines.push("(empty)");

  const header = `${label} — depth ${depth}, ${entries.length} entr(ies):`;
  const rendered = [header, ...lines].join("\n");

  // Appended to `tree`, deliberately: existence-level evidence, not content.
  const artifact: ContextSourceText = {
    id: "tree",
    type: "tree",
    text: rendered,
    bytes: Buffer.byteLength(rendered, "utf8"),
    truncated,
  };

  return {
    output: rendered,
    artifacts: [artifact],
    isError: false,
    summary: {
      path: target.relative,
      depth,
      entries: entries.length,
      returned: shown.length,
      truncated,
    },
  };
}

function walk(rootAbsolute: string, rootRelative: string, maxDepth: number): Entry[] {
  const entries: Entry[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: rootAbsolute, relative: rootRelative, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let children;
    try {
      children = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const relative = current.relative === "" ? child.name : `${current.relative}/${child.name}`;
      const absolute = path.join(current.absolute, child.name);

      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        entries.push({ relative, depth: current.depth, isDirectory: true, size: 0 });
        if (current.depth + 1 < maxDepth) {
          queue.push({ absolute, relative, depth: current.depth + 1 });
        }
      } else if (child.isFile()) {
        entries.push({ relative, depth: current.depth, isDirectory: false, size: statOrNull(absolute)?.size ?? 0 });
      }
    }
  }

  entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return entries;
}
