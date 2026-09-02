import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageError } from "@repo-arch/shared";
import { MEMORY_DATABASE } from "./sqlite";

/** The environment variable that overrides the database location. */
export const DATABASE_ENV_VAR = "REPO_ARCHAEOLOGIST_DB";

/** Where analyses live when nothing says otherwise. */
export const DEFAULT_DATABASE_DIRECTORY = ".repo-archaeologist";
export const DEFAULT_DATABASE_FILE = "analyses.db";

export interface ResolveDatabaseLocationOptions {
  /** An explicit `--db` value. Highest precedence. */
  explicit?: string | undefined;
  /** The workspace the server serves. The database may not live inside it. */
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  homeDirectory?: string | undefined;
}

/**
 * Decides where the analysis database lives, and refuses the one place it must not.
 *
 * The default is under the user's home directory rather than beside the code,
 * for the reason the specification gives: the workspace this server is pointed
 * at contains repositories nobody vetted, and a database inside one of them
 * would be a file the analysed repository can see, `git status` can notice, and
 * a later `git clean` can delete. It is also the wrong scope — one database per
 * user survives pointing the server at a different workspace tomorrow.
 *
 * The check is containment against the *resolved* workspace root, so `..` and a
 * symlinked home directory both land where they really point rather than where
 * they claim to.
 */
export function resolveDatabaseLocation(options: ResolveDatabaseLocationOptions): string {
  const env = options.env ?? process.env;
  const configured = options.explicit ?? env[DATABASE_ENV_VAR];

  if (configured === MEMORY_DATABASE) return MEMORY_DATABASE;

  const location =
    configured !== undefined && configured.trim() !== ""
      ? path.resolve(configured.trim())
      : path.join(
          options.homeDirectory ?? os.homedir(),
          DEFAULT_DATABASE_DIRECTORY,
          DEFAULT_DATABASE_FILE,
        );

  const workspace = realpathOrResolve(options.workspaceRoot);
  const candidate = realpathOrResolve(path.dirname(location));
  if (candidate === workspace || candidate.startsWith(workspace + path.sep)) {
    throw new StorageError(
      "The analysis database may not live inside the analysed workspace.",
      `${location} is inside ${options.workspaceRoot}. Set ${DATABASE_ENV_VAR} or pass --db to point it somewhere else.`,
    );
  }

  return location;
}

/**
 * Resolves symlinks where possible, falling back to a lexical resolve.
 *
 * The fallback matters: the database's directory legitimately may not exist yet
 * on a first run, and a path that cannot be stat'd is still a path whose
 * containment we need to judge.
 */
function realpathOrResolve(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
