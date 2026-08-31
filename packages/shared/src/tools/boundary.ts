import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors";

/**
 * The repository boundary.
 *
 * Every tool argument that names a path goes through `resolveInsideRepository`.
 * A model is free to ask for `../../../../etc/passwd`; this is the single place
 * that says no. There is deliberately no second path-handling code path in any
 * individual tool, so the boundary cannot be bypassed by forgetting a check.
 */

/** Files above this size are never read or searched: they are data, not source. */
export const MAX_CANDIDATE_FILE_BYTES = 512 * 1024;

/** Extensions that are binary or generated noise even when small. */
const SKIPPED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".tiff",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".class", ".pyc", ".pyo",
  ".wasm", ".db", ".sqlite", ".sqlite3", ".parquet", ".pack", ".idx",
]);

/** Lockfiles: enormous, machine-written, and never the answer to a question. */
const SKIPPED_FILENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "go.sum",
  "Gemfile.lock",
]);

export interface ResolvedPath {
  /** Absolute path on this machine. Never serialised into a result. */
  absolute: string;
  /** Repository-relative, forward-slashed. `""` means the repository root. */
  relative: string;
}

/**
 * Resolves a model-supplied path against the repository root, or throws.
 *
 * Rejects, in order: null bytes, absolute paths, explicit `..` traversal, and —
 * after resolution — anything whose real path escapes the repository. The last
 * check is what catches a symlink pointing outside the tree, which the textual
 * checks alone cannot see.
 */
export function resolveInsideRepository(root: string, input: string | undefined): ResolvedPath {
  const requested = (input ?? "").trim();

  if (requested.includes("\0")) {
    throw new ToolError("Path contains a null byte.", "Pass a plain repository-relative path.");
  }

  // Tolerate the two harmless spellings of "the repository root" a model produces.
  const cleaned = requested === "." || requested === "./" || requested === "/" ? "" : requested.replace(/^\.\//, "");

  if (path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    throw new ToolError(
      `Absolute paths are not allowed: "${requested}".`,
      "Use a path relative to the repository root, e.g. src/index.ts.",
    );
  }

  const segments = cleaned.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new ToolError(
      `Path escapes the repository: "${requested}".`,
      "Only paths inside the analysed repository can be read.",
    );
  }

  const relative = segments.join("/");
  const rootReal = realpathOr(root);
  const absolute = path.resolve(rootReal, relative);

  // Belt and braces: resolve() already collapsed the path, so this only fires if
  // the checks above ever regress. Cheap, and the failure it prevents is severe.
  if (!isInside(rootReal, absolute)) {
    throw new ToolError(
      `Path escapes the repository: "${requested}".`,
      "Only paths inside the analysed repository can be read.",
    );
  }

  // A symlink inside the tree may still point out of it.
  if (existsSync(absolute) && !isInside(rootReal, realpathOr(absolute))) {
    throw new ToolError(
      `Path "${relative}" is a link pointing outside the repository.`,
      "Symlinks that leave the repository are not followed.",
    );
  }

  return { absolute, relative };
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function realpathOr(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** `true` when a file is worth searching or reading as text. */
export function isCandidateTextFile(relativePath: string, sizeBytes: number): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  if (SKIPPED_FILENAMES.has(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && SKIPPED_EXTENSIONS.has(name.slice(dot).toLowerCase())) return false;
  return sizeBytes <= MAX_CANDIDATE_FILE_BYTES;
}

/**
 * Content-based binary detection: a NUL byte in the first 8 KiB.
 *
 * Extension lists miss things (`.dat`, no extension at all), and printing raw
 * bytes into a prompt wastes the budget and can break the request encoding.
 */
export function looksBinary(contents: string): boolean {
  return contents.slice(0, 8192).includes("\0");
}

export function statOrNull(absolute: string): { isFile: boolean; isDirectory: boolean; size: number } | null {
  try {
    const stat = statSync(absolute);
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size };
  } catch {
    return null;
  }
}
