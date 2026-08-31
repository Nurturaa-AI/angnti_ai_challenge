import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextSourceText } from "../src/context-format";
import {
  DEFAULT_EXPLORATION_BUDGET,
  EvidenceLedger,
  LIST_DIRECTORY_DEFINITION,
  READ_FILE_DEFINITION,
  SEARCH_CODE_DEFINITION,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  executeTool,
  isCandidateTextFile,
  listDirectory,
  looksBinary,
  readFileTool,
  resolveInsideRepository,
  searchCode,
  type ExplorationBudget,
  type ToolContext,
} from "../src/tools";

/**
 * The exploration tools, tested as an untrusted-input boundary.
 *
 * Every argument these functions receive was written by a language model, so the
 * cases that matter are the hostile and the malformed ones: absolute paths, `..`,
 * symlinks out of the tree, arguments of the wrong type, arguments missing
 * entirely. The happy path is checked mostly to pin the output format that the
 * agent's prompt promises and that grounding later verifies against.
 */

let root: string;
let outside: string;

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function contextWith(overrides: Partial<ExplorationBudget> = {}): ToolContext {
  return { repositoryRoot: root, budget: { ...DEFAULT_EXPLORATION_BUDGET, ...overrides } };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-tools-"));
  outside = mkdtempSync(path.join(tmpdir(), "repo-arch-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "PRIVATE\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("tool definitions", () => {
  it("exposes exactly the three tools this iteration allows", () => {
    expect(TOOL_NAMES).toEqual(["search_code", "read_file", "list_directory"]);
    expect(TOOL_DEFINITIONS).toHaveLength(3);
  });

  it("declares object schemas with the documented required arguments", () => {
    expect(SEARCH_CODE_DEFINITION.parameters.required).toEqual(["query"]);
    expect(READ_FILE_DEFINITION.parameters.required).toEqual(["path"]);
    // A listing with no arguments means "the root", so nothing is required.
    expect(LIST_DIRECTORY_DEFINITION.parameters.required).toEqual([]);
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.parameters.type).toBe("object");
      expect(definition.description.length).toBeGreaterThan(40);
    }
  });
});

describe("resolveInsideRepository", () => {
  it("accepts a relative path and the several spellings of the root", () => {
    expect(resolveInsideRepository(root, "src/index.ts").relative).toBe("src/index.ts");
    expect(resolveInsideRepository(root, "./src/index.ts").relative).toBe("src/index.ts");
    for (const spelling of ["", ".", "./", "/", undefined]) {
      expect(resolveInsideRepository(root, spelling).relative).toBe("");
    }
  });

  it("normalises separators and drops redundant segments", () => {
    expect(resolveInsideRepository(root, "src//./lib/").relative).toBe("src/lib");
    expect(resolveInsideRepository(root, "src\\lib").relative).toBe("src/lib");
  });

  it("rejects parent traversal wherever it appears", () => {
    for (const attempt of ["../secret.txt", "../../etc/passwd", "src/../../outside", "src/../.."]) {
      expect(() => resolveInsideRepository(root, attempt)).toThrow(/escapes the repository/i);
    }
  });

  it("rejects absolute paths, POSIX and Windows alike", () => {
    expect(() => resolveInsideRepository(root, "/etc/passwd")).toThrow(/absolute/i);
    expect(() => resolveInsideRepository(root, path.join(outside, "secret.txt"))).toThrow(/absolute/i);
    expect(() => resolveInsideRepository(root, "C:\\Windows\\system32")).toThrow(/absolute/i);
  });

  it("rejects a null byte", () => {
    expect(() => resolveInsideRepository(root, "src/index.ts\0.png")).toThrow(/null byte/i);
  });

  it("rejects a symlink whose target is outside the repository", () => {
    symlinkSync(outside, path.join(root, "escape"), "dir");
    expect(() => resolveInsideRepository(root, "escape")).toThrow(/outside the repository/i);
    expect(() => resolveInsideRepository(root, "escape/secret.txt")).toThrow(/outside the repository/i);
  });

  it("allows a symlink that stays inside the repository", () => {
    write("real/file.ts", "export const x = 1;\n");
    symlinkSync(path.join(root, "real"), path.join(root, "alias"), "dir");
    expect(resolveInsideRepository(root, "alias/file.ts").relative).toBe("alias/file.ts");
  });
});

describe("file candidacy", () => {
  it("skips binary extensions, lockfiles and oversized files", () => {
    expect(isCandidateTextFile("src/index.ts", 100)).toBe(true);
    expect(isCandidateTextFile("Makefile", 100)).toBe(true);
    expect(isCandidateTextFile("assets/logo.PNG", 100)).toBe(false);
    expect(isCandidateTextFile("pnpm-lock.yaml", 100)).toBe(false);
    expect(isCandidateTextFile("nested/poetry.lock", 100)).toBe(false);
    expect(isCandidateTextFile("data/huge.csv", 900 * 1024)).toBe(false);
  });

  it("detects binary content by a NUL byte near the start", () => {
    expect(looksBinary("plain text\n")).toBe(false);
    expect(looksBinary("PK\u0003\u0004\0\0")).toBe(true);
  });
});

describe("search_code", () => {
  beforeEach(() => {
    write("src/registry.ts", "export const REGISTRY = new Map();\nREGISTRY.set('extract', extract);\n");
    write("src/runner.ts", "import { REGISTRY } from './registry';\n\nexport function run() {}\n");
    write("docs/notes.md", "The step map connects a step type to a handler.\n");
    write("node_modules/pkg/index.js", "const REGISTRY = 1;\n");
    write("dist/bundle.js", "REGISTRY\n");
  });

  it("returns path, line number and the matching line, sorted", () => {
    const outcome = searchCode(contextWith(), { query: "REGISTRY" });

    expect(outcome.isError).toBe(false);
    const rows = outcome.output.split("\n").slice(1);
    expect(rows).toEqual([
      "src/registry.ts:1: export const REGISTRY = new Map();",
      "src/registry.ts:2: REGISTRY.set('extract', extract);",
      "src/runner.ts:1: import { REGISTRY } from './registry';",
    ]);
    expect(outcome.output).toMatch(/^3 match\(es\) for "REGISTRY" in 2 file\(s\)/);
  });

  it("matches case-insensitively and treats the query as a literal, never a regex", () => {
    expect(searchCode(contextWith(), { query: "registry" }).summary["totalMatches"]).toBe(3);
    // If this were a regex, `.*` would match every line in the repository.
    const literal = searchCode(contextWith(), { query: "REGISTRY.*" });
    expect(literal.summary["totalMatches"]).toBe(0);
    expect(literal.output).toMatch(/No match/);
  });

  it("requires every word of a multi-word query to appear on the line", () => {
    const outcome = searchCode(contextWith(), { query: "step handler" });
    expect(outcome.summary["totalMatches"]).toBe(1);
    expect(outcome.output).toContain("docs/notes.md:1:");
  });

  it("never searches generated or vendored directories", () => {
    const outcome = searchCode(contextWith(), { query: "REGISTRY" });
    expect(outcome.output).not.toContain("node_modules");
    expect(outcome.output).not.toContain("dist/");
  });

  it("restricts to a subtree or a single file when given a path", () => {
    expect(searchCode(contextWith(), { query: "REGISTRY", path: "docs" }).summary["totalMatches"]).toBe(0);
    const single = searchCode(contextWith(), { query: "REGISTRY", path: "src/runner.ts" });
    expect(single.summary["filesScanned"]).toBe(1);
    expect(single.summary["totalMatches"]).toBe(1);
  });

  it("caps rows at maxResults and says how many it withheld", () => {
    const outcome = searchCode(contextWith(), { query: "REGISTRY", maxResults: 2 });
    expect(outcome.summary["returned"]).toBe(2);
    expect(outcome.summary["truncated"]).toBe(true);
    expect(outcome.output).toContain("further shown-able match(es) omitted at maxResults=2");
  });

  it("clamps a request above the configured budget", () => {
    const outcome = searchCode(contextWith({ maxSearchResults: 1 }), { query: "REGISTRY", maxResults: 500 });
    expect(outcome.summary["returned"]).toBe(1);
  });

  it("trims very long matching lines rather than emitting them whole", () => {
    write("src/wide.ts", `const wide = "${"x".repeat(600)}"; // REGISTRY\n`);
    const outcome = searchCode(contextWith(), { query: "REGISTRY", path: "src/wide.ts" });
    const row = outcome.output.split("\n")[1] ?? "";
    expect(row.length).toBeLessThan(260);
    expect(row).toContain("[…]");
  });

  it("grants no citation rights: a hit is discovery, not evidence", () => {
    expect(searchCode(contextWith(), { query: "REGISTRY" }).artifacts).toEqual([]);
  });

  it("is deterministic across repeated calls", () => {
    const first = searchCode(contextWith(), { query: "e" }).output;
    const second = searchCode(contextWith(), { query: "e" }).output;
    expect(first).toBe(second);
  });

  it("rejects an empty query and a missing one with an actionable message", () => {
    expect(() => searchCode(contextWith(), { query: "   " })).toThrow(/non-empty query/i);
    expect(() => searchCode(contextWith(), {})).toThrow(/Missing required argument "query"/);
  });

  it("rejects arguments of the wrong type", () => {
    expect(() => searchCode(contextWith(), { query: 42 })).toThrow(/must be a string, received a number/);
    expect(() => searchCode(contextWith(), { query: "x", path: ["src"] })).toThrow(/must be a string, received an array/);
    expect(() => searchCode(contextWith(), { query: "x", maxResults: "many" })).toThrow(/must be an integer/);
  });

  it("reports a scope that does not exist instead of searching the whole repository", () => {
    expect(() => searchCode(contextWith(), { query: "x", path: "nope" })).toThrow(/No such path/);
  });
});

describe("read_file", () => {
  beforeEach(() => {
    write("src/app.ts", "line one\nline two\nline three\nline four\nline five\n");
  });

  it("returns line-numbered content with a header naming the region", () => {
    const outcome = readFileTool(contextWith(), { path: "src/app.ts" });
    const lines = outcome.output.split("\n");

    // The conventional trailing newline is not reported as a sixth line.
    expect(lines[0]).toBe("src/app.ts — lines 1-5 of 5");
    expect(lines[1]).toBe("1 | line one");
    expect(lines[3]).toBe("3 | line three");
    expect(lines).toHaveLength(6);
    expect(outcome.summary).toMatchObject({
      path: "src/app.ts",
      startLine: 1,
      endLine: 5,
      totalLines: 5,
      truncated: false,
      partialView: false,
    });
  });

  it("puts the raw slice — not the numbered form — into the citable artefact", () => {
    const outcome = readFileTool(contextWith(), { path: "src/app.ts", startLine: 2, endLine: 3 });
    const artifact = outcome.artifacts[0];

    expect(outcome.artifacts).toHaveLength(1);
    expect(artifact?.id).toBe("src/app.ts");
    expect(artifact?.type).toBe("file");
    // A model quoting two consecutive lines must verify character for character.
    expect(artifact?.text).toBe("line two\nline three");
    expect(artifact?.text).not.toContain("|");
    expect(artifact?.bytes).toBe(Buffer.byteLength("line two\nline three", "utf8"));
    // Read from line 2, so the source is a partial view of the file.
    expect(artifact?.truncated).toBe(true);
  });

  it("honours startLine and endLine without calling an obeyed range a truncation", () => {
    const outcome = readFileTool(contextWith(), { path: "src/app.ts", startLine: 3, endLine: 4 });
    const lines = outcome.output.split("\n");

    expect(lines[0]).toBe("src/app.ts — lines 3-4 of 5");
    expect(lines.slice(1, 3)).toEqual(["3 | line three", "4 | line four"]);
    // Still a partial view of the file, so the model is told what remains.
    expect(lines[3]).toBe("[... 1 more line(s). Call read_file again with startLine=5 for the rest ...]");
    expect(outcome.summary).toMatchObject({ truncated: false, partialView: true });
  });

  it("reads to the end of the file when endLine reaches it, with no continuation footer", () => {
    const outcome = readFileTool(contextWith(), { path: "src/app.ts", startLine: 4, endLine: 5 });
    expect(outcome.output.split("\n")).toEqual([
      "src/app.ts — lines 4-5 of 5",
      "4 | line four",
      "5 | line five",
    ]);
  });

  it("truncates at the line budget and tells the model how to continue", () => {
    const outcome = readFileTool(contextWith({ maxFileLines: 2 }), { path: "src/app.ts" });

    expect(outcome.summary["truncated"]).toBe(true);
    expect(outcome.summary["endLine"]).toBe(2);
    expect(outcome.output).toContain("(truncated: line budget reached)");
    expect(outcome.output).toContain("Call read_file again with startLine=3");
  });

  it("truncates at the byte budget on whole lines, so the artefact is never a half line", () => {
    const outcome = readFileTool(contextWith({ maxFileBytes: 20 }), { path: "src/app.ts" });

    expect(outcome.summary["truncated"]).toBe(true);
    expect(outcome.output).toContain("(truncated: byte budget reached)");
    expect(outcome.artifacts[0]?.text).toBe("line one\nline two");
  });

  it("normalises CRLF so a citation verifies on any checkout", () => {
    write("src/crlf.ts", "alpha\r\nbeta\r\n");
    const outcome = readFileTool(contextWith(), { path: "src/crlf.ts" });
    expect(outcome.artifacts[0]?.text).not.toContain("\r");
    expect(outcome.output).toContain("1 | alpha");
  });

  it("refuses a directory, a missing file, the root, and a binary file", () => {
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    writeFileSync(path.join(root, "blob.dat"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));

    expect(() => readFileTool(contextWith(), { path: "src/nested" })).toThrow(/is a directory/);
    expect(() => readFileTool(contextWith(), { path: "src/missing.ts" })).toThrow(/No such file/);
    expect(() => readFileTool(contextWith(), { path: "" })).toThrow(/Missing required argument "path"/);
    expect(() => readFileTool(contextWith(), { path: "." })).toThrow(/not the repository root/);
    expect(() => readFileTool(contextWith(), { path: "blob.dat" })).toThrow(/binary file/);
  });

  it("refuses to read outside the repository however the path is spelled", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt"), "file");

    expect(() => readFileTool(contextWith(), { path: "../secret.txt" })).toThrow(/escapes the repository/);
    expect(() => readFileTool(contextWith(), { path: path.join(outside, "secret.txt") })).toThrow(/Absolute/);
    expect(() => readFileTool(contextWith(), { path: "linked.txt" })).toThrow(/outside the repository/);
  });

  it("rejects an inverted line range", () => {
    expect(() => readFileTool(contextWith(), { path: "src/app.ts", startLine: 4, endLine: 2 })).toThrow(
      /endLine \(2\) is before startLine \(4\)/,
    );
  });

  it("clamps a startLine past the end of the file rather than returning nothing", () => {
    const outcome = readFileTool(contextWith(), { path: "src/app.ts", startLine: 900 });
    expect(outcome.summary["startLine"]).toBe(5);
    expect(outcome.output).toContain("5 | line five");
  });
});

describe("list_directory", () => {
  beforeEach(() => {
    write("README.md", "# demo\n");
    write("src/index.ts", "export {};\n");
    write("src/lib/deep/util.ts", "export {};\n");
    write("node_modules/pkg/index.js", "module.exports = 1;\n");
    write(".git/HEAD", "ref: refs/heads/main\n");
  });

  it("lists the root at depth 1 by default, marking directories and file sizes", () => {
    const outcome = listDirectory(contextWith(), {});
    const lines = outcome.output.split("\n");

    expect(lines[0]).toMatch(/^\. — depth 1, 2 entr\(ies\):$/);
    expect(lines.slice(1)).toEqual(["README.md (7 bytes)", "src/"]);
  });

  it("descends to the requested depth, indenting by level", () => {
    const outcome = listDirectory(contextWith(), { path: "src", depth: 2 });
    expect(outcome.output.split("\n")).toEqual([
      "src — depth 2, 3 entr(ies):",
      "index.ts (11 bytes)",
      "lib/",
      "  deep/",
    ]);
  });

  it("omits generated and vendored directories", () => {
    const outcome = listDirectory(contextWith(), { depth: 3 });
    expect(outcome.output).not.toContain("node_modules");
    expect(outcome.output).not.toContain(".git");
  });

  it("clamps depth to the configured maximum", () => {
    const outcome = listDirectory(contextWith({ maxListDepth: 1 }), { path: "src", depth: 9 });
    expect(outcome.summary["depth"]).toBe(1);
  });

  it("truncates at maxListEntries and says so", () => {
    const outcome = listDirectory(contextWith({ maxListEntries: 1 }), { depth: 2 });
    expect(outcome.summary["truncated"]).toBe(true);
    expect(outcome.output).toContain("more entr(ies) omitted at maxListEntries=1");
  });

  it("registers existence-level evidence only, under the tree source id", () => {
    const artifact = listDirectory(contextWith(), {}).artifacts[0];
    // Appended to `tree`, which the evaluator scores as existence, not content.
    expect(artifact?.id).toBe("tree");
    expect(artifact?.type).toBe("tree");
  });

  it("refuses a file, a missing directory, and anything outside the repository", () => {
    expect(() => listDirectory(contextWith(), { path: "README.md" })).toThrow(/is a file, not a directory/);
    expect(() => listDirectory(contextWith(), { path: "nope" })).toThrow(/No such directory/);
    expect(() => listDirectory(contextWith(), { path: ".." })).toThrow(/escapes the repository/);
  });

  it("reports an empty directory as empty", () => {
    mkdirSync(path.join(root, "empty"), { recursive: true });
    expect(listDirectory(contextWith(), { path: "empty" }).output).toContain("(empty)");
  });
});

describe("executeTool", () => {
  beforeEach(() => {
    write("src/app.ts", "export const answer = 42;\n");
  });

  it("dispatches a well-formed call", () => {
    const outcome = executeTool(contextWith(), { id: "c1", name: "read_file", arguments: { path: "src/app.ts" } });
    expect(outcome.isError).toBe(false);
    expect(outcome.artifacts).toHaveLength(1);
  });

  it("accepts arguments delivered as a JSON string, which providers do", () => {
    const outcome = executeTool(contextWith(), {
      id: "c1",
      name: "read_file",
      arguments: '{"path": "src/app.ts"}',
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.summary["path"]).toBe("src/app.ts");
  });

  it("treats absent arguments as an empty object", () => {
    for (const args of [undefined, null, ""]) {
      const outcome = executeTool(contextWith(), { id: "c1", name: "list_directory", arguments: args });
      expect(outcome.isError).toBe(false);
    }
  });

  it("never throws: an unknown tool comes back as a tool error naming the real tools", () => {
    const outcome = executeTool(contextWith(), { id: "c1", name: "run_tests", arguments: {} });

    expect(outcome.isError).toBe(true);
    expect(outcome.output).toContain('Unknown tool "run_tests"');
    expect(outcome.output).toContain("search_code, read_file, list_directory");
    expect(outcome.artifacts).toEqual([]);
    expect(outcome.summary["reason"]).toBe("unknown-tool");
  });

  it("never throws: malformed arguments come back as a tool error", () => {
    for (const args of ["not json at all", "[1,2,3]", 42, ["a"], true]) {
      const outcome = executeTool(contextWith(), { id: "c1", name: "read_file", arguments: args });
      expect(outcome.isError).toBe(true);
      expect(outcome.summary["reason"]).toBe("malformed-arguments");
      expect(outcome.artifacts).toEqual([]);
    }
  });

  it("never throws: a rejected path comes back as a tool error with the hint attached", () => {
    const outcome = executeTool(contextWith(), {
      id: "c1",
      name: "read_file",
      arguments: { path: "../../etc/passwd" },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.output).toMatch(/^ERROR: Path escapes the repository/);
    expect(outcome.output).toContain("Only paths inside the analysed repository can be read.");
    expect(outcome.summary["reason"]).toBe("rejected");
  });

  it("never throws: an invalid argument type comes back as a tool error", () => {
    const outcome = executeTool(contextWith(), { id: "c1", name: "search_code", arguments: { query: { a: 1 } } });
    expect(outcome.isError).toBe(true);
    expect(outcome.output).toContain('Argument "query" must be a string, received a object');
  });

  it("prefixes every error output with ERROR so the model cannot mistake it for content", () => {
    const outcome = executeTool(contextWith(), { id: "c1", name: "read_file", arguments: { path: "gone.ts" } });
    expect(outcome.output.startsWith("ERROR: ")).toBe(true);
  });
});

describe("EvidenceLedger", () => {
  const source = (id: string, text: string, truncated = false): ContextSourceText => ({
    id,
    type: "file",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated,
  });

  it("starts from the reconnaissance context and preserves insertion order", () => {
    const ledger = new EvidenceLedger([source("tree", "a"), source("README.md", "b")]);
    ledger.record(source("src/app.ts", "c"));

    expect(ledger.toArray().map((entry) => entry.id)).toEqual(["tree", "README.md", "src/app.ts"]);
    expect(ledger.size).toBe(3);
    expect(ledger.has("src/app.ts")).toBe(true);
    expect(ledger.has("src/other.ts")).toBe(false);
  });

  it("appends a second region of the same file rather than replacing it", () => {
    const ledger = new EvidenceLedger([source("src/app.ts", "first region")]);
    ledger.record(source("src/app.ts", "second region"));

    const entry = ledger.toArray()[0];
    // An earlier citation must not stop verifying because a later call happened.
    expect(entry?.text).toBe("first region\nsecond region");
    expect(entry?.bytes).toBe(Buffer.byteLength("first region\nsecond region", "utf8"));
    expect(ledger.size).toBe(1);
  });

  it("does not duplicate text it already contains, but keeps a truncation flag", () => {
    const ledger = new EvidenceLedger([source("src/app.ts", "alpha beta gamma")]);
    ledger.record(source("src/app.ts", "beta", true));

    const entry = ledger.toArray()[0];
    expect(entry?.text).toBe("alpha beta gamma");
    expect(entry?.truncated).toBe(true);
  });

  it("copies on record, so a later mutation of the caller's object cannot rewrite history", () => {
    const original = source("src/app.ts", "original");
    const ledger = new EvidenceLedger([original]);
    original.text = "rewritten";

    expect(ledger.toArray()[0]?.text).toBe("original");
  });

  it("grows only through record: tool artefacts are its single input", () => {
    const ledger = new EvidenceLedger();
    expect(ledger.size).toBe(0);

    ledger.recordAll(executeTool(contextWith(), { id: "c1", name: "search_code", arguments: { query: "x" } }).artifacts);
    // A search returned no artefacts, so nothing became citable.
    expect(ledger.size).toBe(0);

    write("src/app.ts", "export const answer = 42;\n");
    ledger.recordAll(
      executeTool(contextWith(), { id: "c2", name: "read_file", arguments: { path: "src/app.ts" } }).artifacts,
    );
    expect(ledger.size).toBe(1);
  });
});
