import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Path and file helpers with two rules baked in:
 *   - nothing we write contains an absolute path from the machine that ran it
 *   - nothing we write contains anything that looks like a credential
 */

/**
 * Renders a path relative to the current working directory, so results and
 * reports are identical no matter where the repository is checked out.
 */
export function toPortablePath(input: string, cwd: string = process.cwd()): string {
  if (!path.isAbsolute(input)) return normalizeSeparators(input);
  const relative = path.relative(cwd, input);
  // Prefer the relative form even when it escapes cwd ("../sibling-repo"):
  // it still avoids leaking a home directory.
  return normalizeSeparators(relative === "" ? "." : relative);
}

function normalizeSeparators(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Redacts anything shaped like an API key before it reaches a log or a file.
 *
 * The second rule has to survive JSON serialisation, because that is how a
 * credential would most plausibly reach a report: `"GEMINI_API_KEY": "..."` puts a
 * closing quote between the name and the colon. A quoted value is replaced with a
 * quoted placeholder so the surrounding JSON stays parseable.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "<redacted-api-key>")
    .replace(
      /(GEMINI_API_KEY|GOOGLE_API_KEY|API[_-]?KEY)("?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|\S+)/gi,
      (_match, name: string, separator: string, secret: string) =>
        `${name}${separator}${secret.startsWith('"') ? '"<redacted>"' : "<redacted>"}`,
    );
}

export function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

/** Writes pretty-printed JSON with a trailing newline, creating parent directories. */
export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, `${redactSecrets(JSON.stringify(value, null, 2))}\n`, "utf8");
}

export function writeTextFile(filePath: string, contents: string): void {
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, redactSecrets(contents), "utf8");
}

/** Filesystem-safe slug, for filenames derived from repository or case names. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "unnamed" : slug;
}

/** `2026-08-30T18-52-04Z` — sortable, and legal in a filename on every platform. */
export function timestampSlug(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
