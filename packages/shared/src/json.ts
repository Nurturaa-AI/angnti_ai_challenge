import { z } from "zod";
import { ModelError, SchemaError } from "./errors";

/**
 * Turning model text into a validated object. Both failure modes get their own
 * error type so callers can tell "the model produced garbage" apart from "the
 * model produced JSON that breaks the contract".
 */

const FENCE = /^\s*```(?:json|jsonc)?\s*\n([\s\S]*?)\n?\s*```\s*$/;

/**
 * Extracts a JSON object from model output. Tolerates markdown fences and
 * leading/trailing prose, both of which happen even with a response schema set.
 */
export function parseModelJson(raw: string): unknown {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ModelError(
      "The model returned an empty response.",
      "This usually means the output token limit was reached or the request was filtered. Try REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS with a larger value.",
    );
  }

  const fenced = FENCE.exec(raw);
  const unfenced = fenced?.[1] ?? raw;

  const candidates = [unfenced, sliceOutermostObject(unfenced)];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }

  throw new ModelError(
    `The model response was not valid JSON (${raw.length} characters). First 200 characters: ${JSON.stringify(raw.slice(0, 200))}`,
    "If this repeats, the response was probably truncated mid-object; raise REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS.",
  );
}

/** Returns the substring from the first `{` to the last `}`, or null if absent. */
function sliceOutermostObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Validates parsed JSON against a schema, reporting every issue with its path. */
export function validateWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  throw new SchemaError(
    `${label} did not satisfy the analysis schema (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
    issues,
    "The response schema sent to the model and the Zod schema may have drifted apart. `pnpm test` covers that invariant.",
  );
}
