import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors";
import { IGNORED_DIRECTORIES } from "../repo";
import { isCandidateTextFile, looksBinary, resolveInsideRepository, statOrNull } from "./boundary";
import type { ToolContext, ToolDefinition, ToolOutcome } from "./types";

/**
 * `search_code` — find where something is mentioned.
 *
 * Matching is literal and case-insensitive, never a regular expression: a model
 * supplied pattern is untrusted input, and `(a+)+$` against a large file is a
 * denial of service. A multi-word query matches lines containing *all* the words,
 * which is what a model means by "step dispatch" and costs nothing in safety.
 *
 * Deliberately, this tool returns no citable artefacts. A search hit tells the
 * agent where to look; `read_file` is what earns the right to quote. That keeps
 * "cite what you actually read" true by construction rather than by instruction.
 */

/** At most this many hits from one file, so a dense file cannot crowd out the rest. */
const MAX_MATCHES_PER_FILE = 5;
/** Matching lines are trimmed to this width. Full context comes from `read_file`. */
const MAX_LINE_CHARS = 200;
/** Ceiling on files examined per call, so a huge repository cannot stall a run. */
const MAX_FILES_SCANNED = 4_000;

export const SEARCH_CODE_DEFINITION: ToolDefinition = {
  name: "search_code",
  description:
    "Search the repository's text files for a literal, case-insensitive string. " +
    "A query containing spaces matches lines that contain every word, in any order. " +
    "Regular expressions are not supported. Returns 'path:line: matching line' rows, " +
    "sorted by path then line number. Generated and vendored directories (.git, node_modules, " +
    "dist, build, __pycache__, .venv and similar), lockfiles and binary files are never searched. " +
    "Search tells you where to look; it does not let you cite. Use read_file on a hit before quoting it.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Literal text to find, e.g. \"REGISTRY\" or \"step handler\". Case-insensitive.",
      },
      path: {
        type: "string",
        description:
          "Optional repository-relative directory or file to restrict the search to, e.g. \"src/services\". Omit to search the whole repository.",
      },
      maxResults: {
        type: "integer",
        description: "Optional cap on returned rows. Clamped to the run's configured maximum.",
      },
    },
    required: ["query"],
  },
};

interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export function searchCode(context: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const query = readStringArgument(args, "query", { required: true }) ?? "";
  const scope = readStringArgument(args, "path", { required: false });
  const requestedMax = readIntegerArgument(args, "maxResults");

  if (query.trim() === "") {
    throw new ToolError("search_code requires a non-empty query.", 'Example: {"query": "REGISTRY"}.');
  }

  const limit = clamp(requestedMax ?? context.budget.maxSearchResults, 1, context.budget.maxSearchResults);
  const terms = query.trim().toLowerCase().split(/\s+/);
  const target = resolveInsideRepository(context.repositoryRoot, scope);

  const targetStat = statOrNull(target.absolute);
  if (!targetStat) {
    throw new ToolError(
      `No such path in the repository: "${target.relative || "."}".`,
      "Use list_directory to see what exists before searching inside it.",
    );
  }

  const files = targetStat.isFile
    ? [{ relative: target.relative, absolute: target.absolute, size: targetStat.size }]
    : collectSearchableFiles(target.absolute, target.relative);

  const hits: SearchHit[] = [];
  let filesWithMatches = 0;
  let totalMatches = 0;

  for (const file of files) {
    if (!isCandidateTextFile(file.relative, file.size)) continue;

    let contents: string;
    try {
      contents = readFileSync(file.absolute, "utf8");
    } catch {
      continue;
    }
    if (looksBinary(contents)) continue;

    const lines = contents.split("\n");
    let matchesInFile = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const haystack = line.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;

      totalMatches += 1;
      matchesInFile += 1;
      if (matchesInFile <= MAX_MATCHES_PER_FILE) {
        hits.push({ file: file.relative, line: index + 1, text: truncateLine(line) });
      }
    }
    if (matchesInFile > 0) filesWithMatches += 1;
  }

  // Deterministic order, independent of directory iteration order.
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const shown = hits.slice(0, limit);
  const truncated = hits.length > shown.length;

  const scopeLabel = target.relative === "" ? "the repository" : target.relative;
  const header =
    shown.length === 0
      ? `No match for "${query}" in ${scopeLabel}.`
      : `${totalMatches} match(es) for "${query}" in ${filesWithMatches} file(s) under ${scopeLabel}. Showing ${shown.length}:`;

  const body = shown.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  if (truncated) {
    body.push(`[... ${hits.length - shown.length} further shown-able match(es) omitted at maxResults=${limit} ...]`);
  }
  if (shown.length === 0) {
    body.push("Try a shorter or different query, or list_directory to see what is there.");
  }

  return {
    output: [header, ...body].join("\n"),
    // Discovery only. Nothing here becomes citable evidence.
    artifacts: [],
    isError: false,
    summary: {
      query,
      scope: target.relative,
      filesScanned: files.length,
      filesWithMatches,
      totalMatches,
      returned: shown.length,
      truncated,
    },
  };
}

interface SearchableFile {
  relative: string;
  absolute: string;
  size: number;
}

function collectSearchableFiles(rootAbsolute: string, rootRelative: string): SearchableFile[] {
  const files: SearchableFile[] = [];
  const queue: Array<{ absolute: string; relative: string }> = [{ absolute: rootAbsolute, relative: rootRelative }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (files.length >= MAX_FILES_SCANNED) break;

    let children;
    try {
      children = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      // Symlinks are never followed: cycles, and reads outside the repository.
      if (child.isSymbolicLink()) continue;
      const relative = current.relative === "" ? child.name : `${current.relative}/${child.name}`;
      const absolute = path.join(current.absolute, child.name);

      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        queue.push({ absolute, relative });
      } else if (child.isFile()) {
        files.push({ relative, absolute, size: statOrNull(absolute)?.size ?? 0 });
      }
    }
  }

  return files;
}

function truncateLine(line: string): string {
  const collapsed = line.replace(/\t/g, "  ").trimEnd();
  const trimmed = collapsed.trimStart();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)} […]` : trimmed;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Argument readers. A model can and will send a number where a string belongs,
 * or omit a required field. Each of these produces a message the model can act
 * on, which is the whole point of surfacing tool errors back into the loop.
 */
export function readStringArgument(
  args: Record<string, unknown>,
  name: string,
  options: { required: boolean },
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (options.required) {
      throw new ToolError(`Missing required argument "${name}".`, `Provide "${name}" as a string.`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolError(
      `Argument "${name}" must be a string, received ${describeType(value)}.`,
      `Provide "${name}" as a string.`,
    );
  }
  return value;
}

export function readIntegerArgument(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;

  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw new ToolError(
      `Argument "${name}" must be an integer, received ${describeType(value)}.`,
      `Provide "${name}" as a whole number, or omit it.`,
    );
  }
  return Math.trunc(numeric);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}
