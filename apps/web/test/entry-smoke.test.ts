/**
 * The web entry point, started the way a user starts it.
 *
 * Everything else in this directory reaches the server through a function call:
 * `api.test.ts` builds an API object, `browser-smoke.test.ts` calls `startWebServer`
 * in-process. Both skip `main.ts` entirely — the flag parsing, the `.env` load, the
 * config and budget resolution, the database location, the store construction, the
 * bind, and the order those happen in. That file is where a broken start actually
 * lives, and none of it is exercised by a test that imports past it.
 *
 * So this suite spawns it: a real child process running the real entry module, with
 * real flags, printing the real banner, listening on a real socket that this process
 * connects to over TCP. `node --check` and `tsc --noEmit` both pass on an entry point
 * that throws on line one; a process that prints its URL and then answers a request
 * on it cannot.
 *
 * The provider is the offline mock throughout. Nothing here spends money, and nothing
 * here needs an API key — which is itself worth asserting, since a start that quietly
 * requires one is a start that fails on a fresh clone.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** The label this suite starts the server with, asserted end to end. */
const PROVENANCE = "entry-smoke";

interface Launch {
  /** stdin is `ignore`d — nothing here types at the process. */
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

/**
 * Starts the entry point and collects its output.
 *
 * Both streams are captured rather than inherited, because what the process *says* is
 * half of what this suite checks: the banner has to name the URL, and it has to not
 * name a secret.
 */
function launch(args: readonly string[], env: NodeJS.ProcessEnv = {}): Launch {
  const child = spawn(TSX, [ENTRY, ...args], {
    cwd: REPO_ROOT,
    // A clean-ish environment: the parent's, minus anything that would let a key on
    // the developer's machine turn a mock run into a paid one.
    env: { ...process.env, GEMINI_API_KEY: "", REPO_ARCHAEOLOGIST_PROVENANCE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  return { child, stdout: () => out, stderr: () => err, exited };
}

/** Waits for a condition on the child's output, or fails with everything it said. */
async function waitFor(run: Launch, label: string, ready: () => boolean, budgetMs = 45_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for ${label}.\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
  );
}

/**
 * What the application said on stderr, with the runtime's own remarks removed.
 *
 * `node:sqlite` is still flagged experimental, so every start prints an
 * `ExperimentalWarning` that no code here emits and none can suppress without also
 * hiding warnings that would matter. Filtering it at the assertion keeps "the app
 * said nothing" meaningful instead of permanently false — and keeps the day Node
 * stops printing it from being a day this file has to change.
 */
function saidByTheApp(run: Launch): string {
  return run
    .stderr()
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !line.startsWith("(Use `node"))
    .join("\n")
    .trim();
}

/** Ends a child and waits for it, so no test leaks a listening process. */
async function stop(run: Launch | undefined): Promise<void> {
  if (run === undefined || run.child.exitCode !== null) return;
  run.child.kill("SIGTERM");
  await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (run.child.exitCode === null) run.child.kill("SIGKILL");
}

let workspace: string;
let server: Launch;
let url: string;

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-entry-"));
  mkdirSync(path.join(workspace, "gadget", "src"), { recursive: true });
  writeFileSync(path.join(workspace, "gadget", "README.md"), "# gadget\n\nA queue consumer.\n");
  writeFileSync(path.join(workspace, "gadget", "src", "consume.js"), "export const consume = () => {};\n");

  server = launch([
    "--root",
    workspace,
    "--port",
    "0",
    "--host",
    "127.0.0.1",
    // Never the developer's real database, and never a file: an entry-point test that
    // writes to `~/.repo-archaeologist` would be a test with a side effect.
    "--db",
    ":memory:",
    "--mock",
    "--provenance",
    PROVENANCE,
  ]);

  await waitFor(server, "the server to print its URL", () => /repo-arch web {2}http:\/\/\S+/.test(server.stdout()));
  const match = /repo-arch web {2}(http:\/\/\S+)/.exec(server.stdout());
  url = match?.[1] ?? "";
}, 60_000);

afterAll(async () => {
  await stop(server);
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("pnpm web", () => {
  it("starts, binds a port the OS chose, and says where it is", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
    // Port 0 means "any free port". A banner that still said 0 would be a banner
    // printed from the request rather than from the socket.
    expect(url).not.toContain(":0/");
    expect(server.child.exitCode).toBeNull();
  });

  it("answers on that socket with the page it ships", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/html");

    const html = await response.text();
    // The shell the browser gate then executes. If these three disagree with what
    // `public/` contains, one of the two suites is testing a file nobody serves.
    expect(html).toContain('id="main"');
    expect(html).toContain('id="analyse-form"');
    expect(html).toContain("/app.js");
  });

  it("serves the entry module the page asks for", async () => {
    const response = await fetch(new URL("/app.js", url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("javascript");
    const source = await response.text();
    // Served, not generated: the file on disk is the file on the wire.
    expect(source).toContain("function boot(");
  });

  it("reports the configuration it actually started with", async () => {
    const response = await fetch(new URL("/api/health", url));
    expect(response.status).toBe(200);
    const health = (await response.json()) as { provider?: string; systems?: unknown };
    expect(health.provider).toBe("mock");
    expect(Array.isArray(health.systems)).toBe(true);
  });

  it("labels its runs, and prints the label it will store", () => {
    expect(server.stdout()).toContain(`provenance: ${PROVENANCE}`);
  });

  it("prints where it is and what it is, and no secret", () => {
    const banner = server.stdout();
    expect(banner).toContain("workspace:");
    expect(banner).toContain(workspace);
    expect(banner).toContain("in memory");
    // `describeConfig` redacts, and the banner prints its redaction rather than the
    // value. With no key set at all this says `<unset>`; with one set it must still
    // never be the key itself.
    expect(banner).toMatch(/api key: {4}<(unset|set, redacted)>/);
    expect(banner).not.toContain("GEMINI_API_KEY=");
  });

  it("records the build and the provenance on an analysis started through it", async () => {
    const created = await fetch(new URL("/api/analyses", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "gadget", system: "advanced" }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };

    // The run is asynchronous by design, so this waits on the record rather than on
    // the response — the same thing the browser does through the event stream.
    const deadline = Date.now() + 40_000;
    let detail: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const response = await fetch(new URL(`/api/analysis/${id}`, url));
      detail = (await response.json()) as Record<string, unknown>;
      if (detail["status"] === "completed" || detail["status"] === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(detail["status"]).toBe("completed");
    // The three identities, as they survive a real process boundary: what ran, and
    // where the run came from. The dataset identity is not an analysis's to claim.
    expect(detail["provenance"]).toBe(PROVENANCE);
    expect(String(detail["systemVersion"])).toMatch(/^\d+\.\d+\.\d+$/);
    expect(detail).not.toHaveProperty("benchmarkVersion");

    // Whatever else the payload carries, it does not carry the host.
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain(workspace);
    expect(serialised).not.toContain("repositoryRoot");
  }, 60_000);
});

describe("pnpm web -- --help", () => {
  it("explains itself, exits cleanly, and binds nothing", async () => {
    const run = launch(["--help"]);
    const code = await run.exited;

    expect(code).toBe(0);
    const usage = run.stdout();
    expect(usage).toContain("repo-arch web");
    expect(usage).toContain("--root");
    expect(usage).toContain("--provenance");
    // Help is help. A process that started a server to print it would have said so.
    expect(usage).not.toContain("Open the URL above");
    expect(saidByTheApp(run)).toBe("");
  }, 60_000);
});

describe("when the command line is wrong", () => {
  it("refuses an unknown flag with a sentence, not a stack trace", async () => {
    const run = launch(["--not-a-flag"]);
    const code = await run.exited;

    expect(code).toBe(1);
    expect(saidByTheApp(run)).toContain("Unknown flag: --not-a-flag");
    // The difference between an error and a crash: no frames, no internal paths.
    expect(saidByTheApp(run)).not.toMatch(/^\s+at /m);
    expect(saidByTheApp(run)).not.toContain("node_modules");
  }, 60_000);

  it("refuses a flag whose value is missing or the wrong shape", async () => {
    const missing = launch(["--root"]);
    expect(await missing.exited).toBe(1);
    expect(saidByTheApp(missing)).toContain("--root needs a value.");

    const notANumber = launch(["--port", "http"]);
    expect(await notANumber.exited).toBe(1);
    expect(saidByTheApp(notANumber)).toContain("--port needs a number.");
  }, 60_000);

  it("refuses a provenance label it could not vouch for, before binding anything", async () => {
    // The guard that keeps a shell expansion out of a stored row and an HTTP body.
    // `--mock` because this is a test about the label. Without it the run fails
    // earlier, on the missing API key, and would pass while proving nothing.
    const run = launch(["--mock", "--provenance", "NOT A LABEL"]);
    expect(await run.exited).toBe(1);
    expect(saidByTheApp(run)).toContain("is not a usable provenance label");
    expect(run.stdout()).not.toContain("repo-arch web  http");
  }, 60_000);

  it("refuses an unknown system rather than starting with a default it invented", async () => {
    const run = launch(["--system", "clairvoyant"]);
    expect(await run.exited).toBe(1);
    expect(saidByTheApp(run)).toContain('Unknown --system "clairvoyant"');
  }, 60_000);
});
