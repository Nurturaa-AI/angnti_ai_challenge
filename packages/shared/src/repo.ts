import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ContextSourceText } from "./context-format";
import { RepositoryError } from "./errors";
import { toPortablePath } from "./paths";
import type { RepositoryInfo } from "./schemas";

/**
 * Shallow repository context collection.
 *
 * This is the *only* thing the baseline gets to see: a bounded directory tree,
 * the readme, the root package manifest(s), and counted metadata. Everything
 * here is deterministic — entries are sorted, limits are fixed — so two runs on
 * the same commit produce byte-identical context.
 */

export interface CollectOptions {
  maxTreeEntries?: number;
  maxDepth?: number;
  maxReadmeBytes?: number;
  maxManifestBytes?: number;
  maxManifests?: number;
}

export const DEFAULT_COLLECT_OPTIONS = {
  maxTreeEntries: 600,
  maxDepth: 6,
  maxReadmeBytes: 8_000,
  maxManifestBytes: 6_000,
  maxManifests: 3,
} as const;

/** Hard ceiling on traversal, so a pathological repository cannot hang a run. */
const MAX_WALK_ENTRIES = 20_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
  ".terraform",
  "Pods",
]);

/** Root manifests worth reading, in preference order. */
const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "setup.py",
  "setup.cfg",
  "deno.json",
  "mix.exs",
  "pnpm-workspace.yaml",
] as const;

/** Readme filenames, in preference order. */
const README_PATTERN = /^readme(\.(md|markdown|rst|txt|adoc))?$/i;
const README_PREFERENCE = [".md", ".markdown", ".rst", ".txt", ".adoc", ""];

export interface RepositoryContext {
  repository: RepositoryInfo;
  /** Absolute path, held in memory only. Never serialised, to keep results portable. */
  absolutePath: string;
  /** Exactly the artefacts that will be shown to the model, in order. */
  sources: ContextSourceText[];
}

interface WalkEntry {
  relativePath: string;
  depth: number;
  isDirectory: boolean;
  size: number;
}

export function collectRepositoryContext(inputPath: string, options: CollectOptions = {}): RepositoryContext {
  const limits = { ...DEFAULT_COLLECT_OPTIONS, ...options };
  const absolutePath = path.resolve(inputPath);

  if (!existsSync(absolutePath)) {
    throw new RepositoryError(
      `No such path: ${toPortablePath(absolutePath)}`,
      "Pass a path to a local repository, e.g. `pnpm repo:baseline -- ./fixtures/orders-api`.",
    );
  }
  const rootStat = statSync(absolutePath);
  if (!rootStat.isDirectory()) {
    throw new RepositoryError(
      `${toPortablePath(absolutePath)} is a file, not a directory.`,
      "Repo Archaeologist analyses repositories; pass the directory that contains the project.",
    );
  }

  const entries = walk(absolutePath, limits.maxDepth);
  const isGitRepository = existsSync(path.join(absolutePath, ".git"));

  const files = entries.filter((entry) => !entry.isDirectory);
  const directories = entries.filter((entry) => entry.isDirectory);

  const repository: RepositoryInfo = {
    name: path.basename(absolutePath),
    path: toPortablePath(inputPath),
    isGitRepository,
    head: isGitRepository ? readGitHead(absolutePath) : null,
    fileCount: files.length,
    directoryCount: directories.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
    languages: countExtensions(files),
  };

  const sources: ContextSourceText[] = [];
  sources.push(makeSource("tree", "tree", renderTree(entries, limits.maxTreeEntries)));

  const readme = findReadme(absolutePath);
  if (readme) {
    sources.push(readTextSource(absolutePath, readme, "readme", limits.maxReadmeBytes));
  }

  for (const manifest of findManifests(absolutePath).slice(0, limits.maxManifests)) {
    sources.push(readTextSource(absolutePath, manifest, "manifest", limits.maxManifestBytes));
  }

  sources.push(makeSource("metadata", "metadata", renderMetadata(repository, files)));

  return { repository, absolutePath, sources };
}

function walk(root: string, maxDepth: number): WalkEntry[] {
  const entries: WalkEntry[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (entries.length >= MAX_WALK_ENTRIES) break;

    let children;
    try {
      children = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions). Skip rather than abort the run.
      continue;
    }

    // Deterministic order: directories and files interleaved by name, as `sort` gives.
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const child of children) {
      const relative = current.relative === "" ? child.name : `${current.relative}/${child.name}`;
      // Symlinks are neither followed nor counted: cycles and out-of-tree reads.
      if (child.isSymbolicLink()) continue;

      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        entries.push({ relativePath: relative, depth: current.depth, isDirectory: true, size: 0 });
        if (current.depth + 1 < maxDepth) {
          queue.push({ absolute: path.join(current.absolute, child.name), relative, depth: current.depth + 1 });
        }
      } else if (child.isFile()) {
        let size = 0;
        try {
          size = statSync(path.join(current.absolute, child.name)).size;
        } catch {
          size = 0;
        }
        entries.push({ relativePath: relative, depth: current.depth, isDirectory: false, size });
      }
    }
  }

  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return entries;
}

function renderTree(entries: readonly WalkEntry[], maxEntries: number): string {
  if (entries.length === 0) return "(no files or directories found)";

  const shown = entries.slice(0, maxEntries);
  const lines = shown.map((entry) => {
    const indent = "  ".repeat(entry.depth);
    const name = entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1);
    return `${indent}${name}${entry.isDirectory ? "/" : ""}`;
  });

  if (entries.length > maxEntries) {
    lines.push(`[... ${entries.length - maxEntries} more entries omitted at this listing limit ...]`);
  }
  return lines.join("\n");
}

function renderMetadata(repository: RepositoryInfo, files: readonly WalkEntry[]): string {
  const testFiles = files.filter((entry) =>
    /(^|\/)(tests?|__tests__|spec)\//i.test(entry.relativePath) ||
    /\.(test|spec)\.[a-z]+$/i.test(entry.relativePath) ||
    /(^|\/)test_[^/]+\.py$/i.test(entry.relativePath),
  );

  const languages = repository.languages.map((entry) => `${entry.extension}=${entry.files}`).join(", ") || "none";

  // Note: HEAD commit and branch are deliberately excluded. The baseline is
  // defined as a system with no access to history, and metadata is a context
  // source. They are recorded in the run metadata instead.
  return [
    `name: ${repository.name}`,
    `files: ${repository.fileCount}`,
    `directories: ${repository.directoryCount}`,
    `totalBytes: ${repository.totalBytes}`,
    `gitRepository: ${String(repository.isGitRepository)}`,
    `fileExtensions: ${languages}`,
    `testFilesDetected: ${testFiles.length}`,
  ].join("\n");
}

function countExtensions(files: readonly WalkEntry[]): RepositoryInfo["languages"] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const base = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const extension = dot > 0 ? base.slice(dot) : "(none)";
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([extension, count]) => ({ extension, files: count }));
}

function findReadme(root: string): string | null {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && README_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  names.sort((a, b) => {
    const rank = (name: string): number => {
      const dot = name.lastIndexOf(".");
      const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
      const index = README_PREFERENCE.indexOf(extension);
      return index === -1 ? README_PREFERENCE.length : index;
    };
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });
  return names[0] ?? null;
}

function findManifests(root: string): string[] {
  return MANIFEST_FILES.filter((name) => {
    const candidate = path.join(root, name);
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readTextSource(
  root: string,
  relativePath: string,
  type: ContextSourceText["type"],
  maxBytes: number,
): ContextSourceText {
  let raw = "";
  try {
    raw = readFileSync(path.join(root, relativePath), "utf8");
  } catch {
    raw = "";
  }
  // Normalise line endings so context bytes do not depend on the checkout.
  const normalized = raw.replace(/\r\n/g, "\n");
  const truncated = Buffer.byteLength(normalized, "utf8") > maxBytes;
  const text = truncated ? normalized.slice(0, maxBytes) : normalized;
  return { id: relativePath, type, text, bytes: Buffer.byteLength(text, "utf8"), truncated };
}

function makeSource(id: string, type: ContextSourceText["type"], text: string): ContextSourceText {
  return { id, type, text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
}

/** HEAD commit and branch, for the run record. Returns null outside a git repo. */
export function readGitHead(absolutePath: string): RepositoryInfo["head"] {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: absolutePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
    } catch {
      return null;
    }
  };

  const commit = run(["rev-parse", "HEAD"]);
  if (!commit) return null;
  return { commit, branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "(detached)" };
}
