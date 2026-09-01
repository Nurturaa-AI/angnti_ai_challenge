/**
 * Typed error hierarchy. Every error carries an optional `hint` describing the
 * concrete next action a user can take, because "ENOENT" alone has never helped
 * anybody.
 */

export class RepoArchaeologistError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.hint = hint;
  }
}

/** Missing or invalid configuration (API key, model, provider). */
export class ConfigError extends RepoArchaeologistError {}

/** The target path is not a readable directory / not a git repository. */
export class RepositoryError extends RepoArchaeologistError {}

/** The model call failed, or returned something unusable. */
export class ModelError extends RepoArchaeologistError {}

/** Model output did not satisfy the analysis schema. */
export class SchemaError extends RepoArchaeologistError {
  readonly issues: string[];

  constructor(message: string, issues: string[], hint?: string) {
    super(message, hint);
    this.issues = issues;
  }
}

/** An evaluation case file is malformed. */
export class EvaluationError extends RepoArchaeologistError {}

/**
 * A request from outside the process is malformed or names something absent.
 *
 * Distinct from `ConfigError`, which is the *operator* having set something up
 * wrongly, and from `ToolError`, which is a call the *model* made. This is a
 * caller's mistake: a missing field, an over-long question, an analysis id that
 * was never issued. It exists so a request handler can answer "your fault, here
 * is what to change" without inspecting message text to guess the category.
 */
export class RequestError extends RepoArchaeologistError {
  /** Set when the specific failure is "no such thing", so a handler can answer 404. */
  readonly notFound: boolean;

  constructor(message: string, hint?: string, options?: { notFound?: boolean }) {
    super(message, hint);
    this.notFound = options?.notFound ?? false;
  }
}

/**
 * A tool call the agent asked for cannot be honoured: unknown tool, invalid
 * arguments, or a path outside the repository.
 *
 * Unlike the errors above this one is usually *not* fatal. The agent loop turns
 * it into a tool result the model can read and correct, so a bad call costs one
 * step of the exploration budget instead of the whole run.
 */
export class ToolError extends RepoArchaeologistError {}

/**
 * Render an error for the terminal: message, hint, and schema issues if any.
 * Never includes a stack trace for our own error types — they are user-facing.
 */
export function formatError(error: unknown): string {
  if (error instanceof RepoArchaeologistError) {
    const lines = [`${error.name}: ${error.message}`];
    if (error instanceof SchemaError && error.issues.length > 0) {
      for (const issue of error.issues.slice(0, 12)) lines.push(`  - ${issue}`);
      if (error.issues.length > 12) lines.push(`  ... and ${error.issues.length - 12} more`);
    }
    if (error.hint) lines.push(`\nHint: ${error.hint}`);
    return lines.join("\n");
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Unknown error: ${String(error)}`;
}
