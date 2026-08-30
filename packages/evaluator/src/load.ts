import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EvaluationError } from "@repo-arch/shared";
import { EvalCaseSchema, type EvalCase } from "./case-schema";

/**
 * Loading cases from disk.
 *
 * Files are read in sorted order and validated eagerly: a malformed case fails
 * the whole load rather than silently shrinking the denominator of the primary
 * metric. Duplicate ids are rejected for the same reason.
 */

export interface LoadedCase {
  /** Path the case was read from, relative to the project root. */
  file: string;
  case: EvalCase;
}

export function loadCaseFile(filePath: string): EvalCase {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new EvaluationError(
      `Could not read evaluation case "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      "Check the path and file permissions.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EvaluationError(
      `Evaluation case "${filePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "A case file is a single JSON object. Trailing commas and comments are not allowed.",
    );
  }

  const result = EvalCaseSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    throw new EvaluationError(
      `Evaluation case "${filePath}" does not match the case schema:\n  - ${issues.join("\n  - ")}`,
      'Every question needs an id, question, expectedAnswer, and at least one of "expectedKeywords" or "anyOfKeywords".',
    );
  }
  return result.data;
}

/**
 * Loads every `*.json` file in `directory`. Sorted by filename so two machines
 * evaluate the same cases in the same order.
 */
export function loadCases(directory: string, options: { readonly filterIds?: readonly string[] } = {}): LoadedCase[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw new EvaluationError(
      `Could not read the evaluation case directory "${directory}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      "Cases live in evaluation/cases/. Create the directory, or pass --cases <dir>.",
    );
  }

  const files = entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(directory, entry))
    .filter((filePath) => statSync(filePath).isFile());

  if (files.length === 0) {
    throw new EvaluationError(
      `No evaluation cases found in "${directory}".`,
      'Add at least one <case>.json file. Run "pnpm fixtures:build" first if the cases point at fixtures/.',
    );
  }

  const loaded: LoadedCase[] = [];
  const seen = new Map<string, string>();

  for (const filePath of files) {
    const evalCase = loadCaseFile(filePath);
    const previous = seen.get(evalCase.id);
    if (previous !== undefined) {
      throw new EvaluationError(
        `Duplicate case id "${evalCase.id}" in "${filePath}" (already used by "${previous}").`,
        "Case ids appear in the results file and must be unique.",
      );
    }
    seen.set(evalCase.id, filePath);
    loaded.push({ file: path.relative(process.cwd(), filePath).split(path.sep).join("/"), case: evalCase });
  }

  if (options.filterIds === undefined || options.filterIds.length === 0) return loaded;

  const wanted = new Set(options.filterIds);
  const selected = loaded.filter((entry) => wanted.has(entry.case.id));
  const missing = [...wanted].filter((id) => !loaded.some((entry) => entry.case.id === id));
  if (missing.length > 0) {
    throw new EvaluationError(
      `No such case id(s): ${missing.join(", ")}.`,
      `Available ids: ${loaded.map((entry) => entry.case.id).join(", ")}.`,
    );
  }
  return selected;
}
