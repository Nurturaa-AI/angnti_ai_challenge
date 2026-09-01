import { IGNORED_DIRECTORIES, ToolError, resolveInsideRepository, statOrNull } from "@repo-arch/shared";

/**
 * The workspace boundary — where an HTTP request names a repository.
 *
 * This is a *different* trust boundary from the tool boundary, and that is the only
 * reason it exists. `resolveInsideRepository` protects one repository from the model
 * exploring it; this protects the machine from a request naming a directory the
 * operator never offered. So rather than write a second path checker, it calls the
 * existing one with a different root: the workspace the server was started against.
 *
 * The result is that both boundaries share one implementation of "reject null bytes,
 * absolute paths, `..`, and symlinks that leave the tree" — and a fix to that logic
 * fixes both. What this adds on top is specific to the new boundary: a request may not
 * name a generated, vendored or VCS-internal directory as a repository, because those
 * are not repositories, and `.git` in particular holds objects the analyser has no
 * business reading.
 */

export interface ResolvedRepository {
  /** Absolute path on this machine. Never serialised into a report. */
  absolute: string;
  /** Workspace-relative, forward-slashed. `""` is the workspace root itself. */
  relative: string;
}

export function resolveRepositoryRequest(workspaceRoot: string, requested: string): ResolvedRepository {
  // Null bytes, absolute paths, `..` traversal and symlink escapes: all handled by the
  // one implementation the tools use, against the workspace root instead.
  const resolved = resolveInsideRepository(workspaceRoot, requested);

  const segments = resolved.relative.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (IGNORED_DIRECTORIES.has(segment)) {
      throw new ToolError(
        `"${resolved.relative}" is inside "${segment}", which is generated or vendored rather than a repository.`,
        "Point at a source repository. Build output, dependencies and VCS internals are never analysed.",
      );
    }
  }

  const stat = statOrNull(resolved.absolute);
  if (!stat) {
    throw new ToolError(
      `No such directory in the workspace: "${resolved.relative === "" ? "." : resolved.relative}".`,
      "The path is resolved relative to the workspace the server was started in.",
    );
  }
  if (!stat.isDirectory) {
    throw new ToolError(
      `"${resolved.relative}" is a file, not a repository directory.`,
      "Pass the directory that contains the repository.",
    );
  }

  return { absolute: resolved.absolute, relative: resolved.relative };
}
