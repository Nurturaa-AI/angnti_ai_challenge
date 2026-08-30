import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryError } from "../src/errors";
import { collectRepositoryContext } from "../src/repo";

/**
 * Context collection is the baseline's entire view of a repository, so these
 * tests pin down exactly what it can and cannot see — including the cases the
 * brief calls out: no readme, no manifest, and an empty repository.
 */

let root: string;

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function ids(sourceList: readonly { id: string }[]): string[] {
  return sourceList.map((source) => source.id);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-collect-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectRepositoryContext", () => {
  it("collects tree, readme, manifest and metadata for an ordinary project", () => {
    write("README.md", "# demo\n\nA demo project.\n");
    write("package.json", '{ "name": "demo", "dependencies": { "express": "^4.19.2" } }\n');
    write("src/index.js", "export const answer = 42;\n");
    write("test/index.test.js", "// tests\n");

    const context = collectRepositoryContext(root);

    expect(ids(context.sources)).toEqual(["tree", "README.md", "package.json", "metadata"]);
    expect(context.repository.fileCount).toBe(4);
    expect(context.repository.directoryCount).toBe(2);
    expect(context.sources[0]?.text).toContain("src/");
    expect(context.sources[0]?.text).toContain("index.js");
  });

  it("omits the readme source when the repository has no readme", () => {
    write("package.json", '{ "name": "demo" }\n');
    const context = collectRepositoryContext(root);
    expect(ids(context.sources)).toEqual(["tree", "package.json", "metadata"]);
  });

  it("omits the manifest source when the repository has no package manifest", () => {
    write("README.md", "# demo\n");
    const context = collectRepositoryContext(root);
    expect(ids(context.sources)).toEqual(["tree", "README.md", "metadata"]);
  });

  it("handles an empty repository without inventing content", () => {
    const context = collectRepositoryContext(root);

    expect(ids(context.sources)).toEqual(["tree", "metadata"]);
    expect(context.sources[0]?.text).toBe("(no files or directories found)");
    expect(context.repository.fileCount).toBe(0);
    expect(context.repository.directoryCount).toBe(0);
    expect(context.repository.totalBytes).toBe(0);
    expect(context.repository.languages).toEqual([]);
  });

  it("prefers README.md over other readme extensions", () => {
    write("README.txt", "plain text readme\n");
    write("README.md", "# markdown readme\n");
    const context = collectRepositoryContext(root);
    const readme = context.sources.find((source) => source.type === "readme");
    expect(readme?.id).toBe("README.md");
  });

  it("reads pyproject.toml as the manifest for a Python project", () => {
    write("pyproject.toml", '[project]\nname = "pyflow"\ndependencies = ["click>=8.1"]\n');
    const context = collectRepositoryContext(root);
    const manifest = context.sources.find((source) => source.type === "manifest");
    expect(manifest?.id).toBe("pyproject.toml");
    expect(manifest?.text).toContain("click");
  });

  it("skips .git, node_modules and other generated directories", () => {
    write("node_modules/left-pad/index.js", "module.exports = 1;\n");
    write(".git/HEAD", "ref: refs/heads/main\n");
    write("dist/bundle.js", "// built\n");
    write("src/app.js", "// source\n");

    const context = collectRepositoryContext(root);

    expect(context.sources[0]?.text).not.toContain("left-pad");
    expect(context.sources[0]?.text).not.toContain("bundle.js");
    expect(context.sources[0]?.text).toContain("app.js");
    expect(context.repository.fileCount).toBe(1);
  });

  it("is deterministic: the same directory produces byte-identical context", () => {
    write("README.md", "# demo\n");
    write("package.json", '{ "name": "demo" }\n');
    write("src/b.js", "// b\n");
    write("src/a.js", "// a\n");

    const first = collectRepositoryContext(root);
    const second = collectRepositoryContext(root);

    expect(second.sources).toEqual(first.sources);
    expect(second.repository).toEqual(first.repository);
  });

  it("marks a readme as truncated instead of silently shortening it", () => {
    write("README.md", "x".repeat(500));
    const context = collectRepositoryContext(root, { maxReadmeBytes: 100 });
    const readme = context.sources.find((source) => source.type === "readme");
    expect(readme?.truncated).toBe(true);
    expect(readme?.bytes).toBe(100);
  });

  it("reports how many tree entries were omitted at the listing limit", () => {
    for (let index = 0; index < 30; index += 1) write(`src/file-${index}.js`, "// x\n");
    const context = collectRepositoryContext(root, { maxTreeEntries: 10 });
    expect(context.sources[0]?.text).toContain("more entries omitted");
  });

  it("keeps git history out of the model's context", () => {
    write("README.md", "# demo\n");
    const context = collectRepositoryContext(root);
    const metadata = context.sources.find((source) => source.type === "metadata");

    expect(metadata?.text).toContain("name:");
    expect(metadata?.text).toContain("testFilesDetected:");
    expect(metadata?.text).not.toContain("commit");
    expect(metadata?.text).not.toContain("branch");
  });

  it("records a non-git directory as such, with no head", () => {
    const context = collectRepositoryContext(root);
    expect(context.repository.isGitRepository).toBe(false);
    expect(context.repository.head).toBeNull();
  });

  it("records the repository path relative to the working directory, so a result stays portable", () => {
    const context = collectRepositoryContext(root);
    expect(path.isAbsolute(context.repository.path)).toBe(false);
    expect(context.repository.path).toBe(path.relative(process.cwd(), root));
  });

  it("does not leak the absolute location of a repository below the working directory", () => {
    const inside = mkdtempSync(path.join(process.cwd(), "repo-arch-inside-"));
    try {
      const context = collectRepositoryContext(inside);
      expect(context.repository.path).toBe(path.basename(inside));
      expect(JSON.stringify(context.repository)).not.toContain(process.cwd());
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  });

  it("fails with a usable message when the path does not exist", () => {
    expect(() => collectRepositoryContext(path.join(root, "nope"))).toThrow(RepositoryError);
    try {
      collectRepositoryContext(path.join(root, "nope"));
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryError);
      expect((error as RepositoryError).hint).toContain("local repository");
    }
  });

  it("fails when handed a file instead of a directory", () => {
    write("README.md", "# demo\n");
    expect(() => collectRepositoryContext(path.join(root, "README.md"))).toThrow(/not a directory/);
  });
});
