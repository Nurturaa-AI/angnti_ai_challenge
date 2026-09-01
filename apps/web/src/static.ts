import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveInsideRepository, statOrNull } from "@repo-arch/shared";

/**
 * The UI's own files.
 *
 * `resolveInsideRepository` is reused here rather than replaced. It is not a repository
 * being constrained, but it is exactly the same operation — hold a caller-supplied
 * relative path inside one directory, rejecting null bytes, absolute paths, `..` and
 * anything whose real path leaves the tree via a symlink — and the rule is that there is
 * one implementation of that. A second one written for "just the static files" is how a
 * traversal bug reaches production: nobody audits the asset server.
 *
 * The consequence of reuse is that the checks are stricter than a static server needs.
 * That is the right direction to be wrong in.
 */

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
]);

export interface StaticAsset {
  bytes: Buffer;
  contentType: string;
}

/**
 * Resolves a URL path to a file under `root`, or `undefined`.
 *
 * `undefined` covers every failure — outside the root, absent, a directory, an
 * unrecognised extension — because a static server that distinguishes "not allowed" from
 * "not there" tells a caller what exists outside the tree.
 */
export function readStaticAsset(root: string, urlPath: string): StaticAsset | undefined {
  // "/" serves the shell. Every other path is a file request: the UI routes by hash, so
  // there is no deep link for this to have to invent a page for.
  const requested = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");

  let absolute: string;
  try {
    absolute = resolveInsideRepository(root, requested).absolute;
  } catch {
    return undefined;
  }

  const stats = statOrNull(absolute);
  if (!stats?.isFile) return undefined;

  const contentType = CONTENT_TYPES.get(path.extname(absolute).toLowerCase());
  // An extension nobody asked for is not served. The UI ships four kinds of file, and an
  // asset directory that will serve anything is a way to publish a stray `.env`.
  if (contentType === undefined) return undefined;

  return { bytes: readFileSync(absolute), contentType };
}
