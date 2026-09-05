/**
 * The command line, executed.
 *
 * `apps/cli` had no tests at all. Its parser, its three commands and its error
 * handling were covered only transitively, by suites that import the libraries it
 * calls — which is to say the one file a user actually runs was the one file nothing
 * ran. A typo in module scope, a bad import, an entry point that exits 0 while
 * printing a stack trace: none of that is visible to `tsc --noEmit`, and none of it
 * was visible here.
 *
 * So every test below spawns the real binary as a child process and reads what it
 * printed and what it exited with — the two things a user and a CI job both depend on.
 *
 * **No paid call is made.** Startup, parsing and refusals never reach a provider, and
 * the one test that runs a full analysis passes `--mock`, which is the offline
 * deterministic provider. Proving the CLI starts is not worth an API bill, and a smoke
 * gate that costs money is a smoke gate people switch off.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  /** stderr with Node's own warnings removed; see the note on `run`. */
  readonly stderr: string;
}

/**
 * Runs the CLI to completion.
 *
 * `cwd` defaults to a scratch directory rather than the repository, because two of
 * these commands write files relative to the working directory — `reports/` and
 * `trajectories/`. A test suite that littered those would be a test suite that
 * modifies evaluation artefacts as a side effect of running.
 *
 * `GEMINI_API_KEY` is blanked for the same reason the provider is mocked: a developer
 * machine that happens to have a key must not turn `pnpm test` into a paid run.
 * Node's `ExperimentalWarning` for `node:sqlite` is filtered out of stderr so that
 * "the command said nothing" stays a meaningful assertion.
 */
function run(args: readonly string[], cwd: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, GEMINI_API_KEY: "", REPO_ARCHAEOLOGIST_PROVENANCE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      const said = stderr
        .split("\n")
        .filter((line) => !/^\(node:\d+\)/.test(line) && !line.startsWith("(Use `node"))
        .join("\n")
        .trim();
      resolve({ code, stdout, stderr: said });
    });
  });
}

let scratch: string;
let repository: string;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "repo-arch-cli-"));
  repository = path.join(scratch, "sprocket");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(path.join(repository, "README.md"), "# sprocket\n\nA small library that formats dates.\n");
  writeFileSync(path.join(repository, "src", "format.js"), "export const format = (d) => d.toISOString();\n");
  writeFileSync(path.join(repository, "package.json"), JSON.stringify({ name: "sprocket", version: "0.1.0" }, null, 2));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("repo-arch --help", () => {
  it("explains the three commands and exits cleanly", async () => {
    const result = await run(["--help"], scratch);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("repo-arch");
    expect(result.stdout).toContain("baseline");
    expect(result.stdout).toContain("advanced");
    expect(result.stdout).toContain("evaluate");
    expect(result.stdout).toContain("--mock");
    // Help is not an error, and printing it is not a failure.
    expect(result.stderr).toBe("");
  }, 60_000);

  it("prints usage and fails when told to do nothing at all", async () => {
    const result = await run([], scratch);

    // Usage on stdout, but a non-zero exit: a script that invoked this with an empty
    // argument list did not get what it asked for, and should be able to tell.
    expect(result.stdout).toContain("USAGE");
    expect(result.code).toBe(1);
  }, 60_000);
});

describe("when the command line is wrong", () => {
  it("names an unknown command instead of guessing one", async () => {
    const result = await run(["frobnicate"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
    expect(result.stderr).toContain("baseline");
    // An error, not a crash.
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain("node_modules");
  }, 60_000);

  it("names an unknown flag, and points at --help", async () => {
    const result = await run(["advanced", ".", "--turbo"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown flag "--turbo"');
    expect(result.stderr).toContain("--help");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  }, 60_000);

  it("refuses a flag with no value rather than swallowing the next one", async () => {
    const result = await run(["advanced", "--model", "--mock"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--model needs a value.");
  }, 60_000);

  it("refuses a numeric flag given something that is not a number", async () => {
    const result = await run(["advanced", ".", "--seed", "soon"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--seed/);
  }, 60_000);

  it("says which argument is missing when a command needs one", async () => {
    const result = await run(["advanced", "--mock"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No repository path given.");
    // The refusal carries the fix, not just the complaint.
    expect(result.stderr).toContain("pnpm repo:advanced");
  }, 60_000);

  it("refuses to point the evidence scout at the questions it is scored on", async () => {
    // The evaluation integrity guard, asserted at the entry point a person would use
    // to try it. Measured-path isolation is not a convention here; it is a refusal.
    const result = await run(["evaluate", "--mock", "--focus", "which module handles auth"], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--focus");
    expect(result.stderr).toContain("withholds the questions");
  }, 60_000);

  it("explains a missing API key instead of failing inside the provider", async () => {
    // No `--mock`, no key in the environment. This is the first thing a new user hits,
    // and it must be a sentence with a fix in it rather than a transport error.
    const result = await run(["advanced", repository], scratch);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("GEMINI_API_KEY");
    expect(result.stderr).toContain("--mock");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  }, 60_000);
});

describe("repo-arch advanced --mock", () => {
  it("analyses a repository end to end and writes what it says it wrote", async () => {
    const out = path.join(scratch, "reports");
    const result = await run(["advanced", repository, "--mock", "--out", out, "--quiet"], scratch);

    expect(result.code).toBe(0);
    // The run summary goes to stderr so that `--quiet` leaves stdout empty and the
    // briefing can be piped when it is not.
    expect(result.stderr).toContain("briefing:");
    expect(result.stderr).toContain("citations:");
    expect(result.stdout.trim()).toBe("");

    // Named files, actually on disk: a CLI that prints a path it did not write is
    // worse than one that fails.
    const written = readdirSync(out);
    expect(written.some((name) => name.endsWith(".md"))).toBe(true);
    expect(written.some((name) => name.endsWith(".json"))).toBe(true);
    // Written relative to the working directory, which is why that directory is a
    // scratch one and not the repository.
    expect(existsSync(path.join(scratch, "trajectories"))).toBe(true);
  }, 120_000);
});

/**
 * The same drift check the web entry point gets, against the help a user actually sees.
 *
 * Read from the printed output rather than from the source constant: what matters is
 * that the text `--help` produces lists the flags the parser accepts. Names only, so
 * rewording a description changes nothing here.
 */
describe("the CLI documents the flags it accepts", () => {
  const source = readFileSync(ENTRY, "utf8");
  const accepted = new Set(
    [...source.matchAll(/case "(--[a-z-]+)":/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );

  it("documents every flag it accepts, and accepts every flag it documents", async () => {
    const help = await run(["--help"], scratch);
    expect(help.code).toBe(0);

    const documented = new Set(help.stdout.match(/--[a-z][a-z-]*/g) ?? []);
    expect(accepted.size).toBeGreaterThan(10);
    expect([...accepted].filter((flag) => !documented.has(flag))).toEqual([]);
    expect([...documented].filter((flag) => !accepted.has(flag))).toEqual([]);
  }, 60_000);
});
