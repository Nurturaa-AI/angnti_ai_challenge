import { ConfigError } from "./errors";

/**
 * Run provenance.
 *
 * Three identities travel with every run and they answer three different
 * questions. Conflating any two of them destroys the ability to compare runs,
 * which is the only reason the numbers are kept at all:
 *
 *   - `systemVersion`    — *what code ran*. `ADVANCED_VERSION` / `BASELINE_VERSION`.
 *                          Moves only when measured behaviour changes.
 *   - `provenance`       — *why this run happened*. Where in the development
 *                          process it originated: `iteration-6-baseline`,
 *                          `iteration-5-runtime-fix`. Two runs of identical code
 *                          can and should have different provenance.
 *   - `benchmarkVersion` — *what it was measured against*. The dataset identity,
 *                          owned by `evaluation/benchmark.json`.
 *
 * The distinction is load-bearing in the other direction too: a provenance label
 * must never be read as a version. `iteration-6-baseline` and
 * `iteration-6-evidence-improvement` may share a system version, and the same
 * provenance may appear against two benchmark versions.
 *
 * Provenance is a *label*, deliberately: a short slug chosen by whoever started
 * the run. It is validated rather than trusted, because it is persisted, printed
 * in reports and returned over HTTP. `PROVENANCE_PATTERN` admits nothing that
 * could carry a secret, a host path or markup — no spaces, no colons, no
 * backslashes, no leading dot — so a mistyped `--provenance $(cat ~/.env)` fails
 * loudly instead of being stored and served.
 */

/** The environment variable that supplies provenance when no flag is given. */
export const PROVENANCE_ENV_VAR = "REPO_ARCHAEOLOGIST_PROVENANCE";

/**
 * What a provenance label may look like: lowercase, starting with a letter or
 * digit, then letters, digits, dot, dash, underscore or slash. At most 64
 * characters. Narrow on purpose — see the note above about what must never fit.
 */
export const PROVENANCE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/**
 * Used when nothing supplies a label. Honest rather than flattering: it says the
 * run was not labelled, instead of silently inheriting a meaningful-looking one
 * from a previous iteration.
 */
export const DEFAULT_PROVENANCE = "unlabelled";

export function isValidProvenance(value: string): boolean {
  return PROVENANCE_PATTERN.test(value);
}

/**
 * Validates a provenance label, or explains why it is not one.
 *
 * Throws rather than falling back to the default: a run started with an explicit
 * label that turned out to be unusable should stop, because the label is how the
 * resulting numbers will be found again.
 */
export function assertProvenance(value: string): string {
  if (isValidProvenance(value)) return value;
  throw new ConfigError(
    `"${value}" is not a usable provenance label.`,
    "A label is up to 64 characters of lowercase letters, digits, dot, dash, underscore or slash — for example iteration-6-baseline. It is persisted and served, so it must not carry paths, secrets or spaces.",
  );
}

/**
 * Resolves provenance for a run: an explicit label wins, then the environment,
 * then `DEFAULT_PROVENANCE`.
 *
 * An empty or whitespace-only value from the environment is treated as absent,
 * because that is what an unset-but-exported shell variable looks like. An
 * environment value that is present but malformed still throws — it was set on
 * purpose and is wrong.
 */
export function resolveProvenance(
  explicit?: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined && explicit.trim() !== "") return assertProvenance(explicit.trim());
  const fromEnv = env[PROVENANCE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return assertProvenance(fromEnv.trim());
  return DEFAULT_PROVENANCE;
}
