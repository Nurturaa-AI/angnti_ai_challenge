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
 * Credential shapes with a distinctive prefix, redacted wherever they appear.
 *
 * These are deliberately shape-based rather than name-based, which is what makes them
 * safe to apply to arbitrary repository text: nobody writes `AKIA` followed by sixteen
 * uppercase alphanumerics by accident, so the false-positive rate against real source
 * code is effectively zero. The complementary rule — redacting by *variable name* —
 * lives below and is intentionally not broadened to `secret`/`token`/`password`, because
 * `jwtSecret: env.JWT_SECRET` is a reference to a credential rather than a credential,
 * and redacting it would make evidence less readable while protecting nothing.
 *
 * What this cannot do is recognise a bare high-entropy string with no prefix and no
 * label. That limit is real and documented; a heuristic wide enough to catch it would
 * redact hashes, UUIDs and minified code.
 */
const CREDENTIAL_SHAPES: readonly { pattern: RegExp; placeholder: string }[] = [
  // A PEM private key, body and all. First, so the block is gone before anything
  // inside it can be matched piecemeal.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    placeholder: "<redacted-private-key>",
  },
  // `<redacted-api-key>` is what trajectories have said since the first iteration, and
  // an existing test pins the wording, so this one keeps its own placeholder.
  { pattern: /AIza[0-9A-Za-z_-]{10,}/g, placeholder: "<redacted-api-key>" },
  // AWS access key id. The prefixes are AWS's own resource-type codes.
  { pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, placeholder: "<redacted-credential>" },
  { pattern: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g, placeholder: "<redacted-credential>" },
  { pattern: /\bgithub_pat_[0-9A-Za-z_]{22,255}\b/g, placeholder: "<redacted-credential>" },
  { pattern: /\bxox[abeoprs]-[0-9A-Za-z-]{10,}/g, placeholder: "<redacted-credential>" },
  { pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, placeholder: "<redacted-credential>" },
  { pattern: /\bsk-(?:ant|proj)-[0-9A-Za-z_-]{16,}/g, placeholder: "<redacted-credential>" },
  // A JWT: three base64url segments, the first of which decodes to `{"...`.
  {
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    placeholder: "<redacted-credential>",
  },
];

/**
 * Redacts anything shaped like a credential before it reaches a log, a file, an HTTP
 * response or an exported document.
 *
 * Two complementary rules. The first matches distinctive credential *shapes*
 * (`CREDENTIAL_SHAPES` above) anywhere in the text, which is what protects a repository
 * excerpt — a token committed to a source file has no `API_KEY =` next to it to give it
 * away. The second matches an assignment to a credential-*named* variable whatever the
 * value looks like, which catches this project's own configuration.
 *
 * The second rule has to survive JSON serialisation, because that is how a
 * credential would most plausibly reach a report: `"GEMINI_API_KEY": "..."` puts a
 * closing quote between the name and the colon. A quoted value is replaced with a
 * quoted placeholder so the surrounding JSON stays parseable.
 */
export function redactSecrets(value: string): string {
  let redacted = value;
  for (const { pattern, placeholder } of CREDENTIAL_SHAPES) {
    redacted = redacted.replace(pattern, placeholder);
  }
  return redacted.replace(
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
