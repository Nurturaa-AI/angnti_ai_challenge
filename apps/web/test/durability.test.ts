import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EXPLORATION_BUDGET,
  DEFAULT_PRECISION_POLICY,
  createLlmClient,
  type AnalysisConfig,
  type LlmClient,
} from "@repo-arch/shared";
import { SqliteAnalysisStore, resolveDatabaseLocation, type AnalysisStore } from "@repo-arch/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebServer, type RunningServer } from "../src/server";

/**
 * An analysis that outlives the request that asked for it, over HTTP, on disk.
 *
 * `integration.test.ts` walks the product's happy path against an in-memory store;
 * this one is narrower and lower to the ground. It exists because a bug shipped
 * that every existing test was structurally unable to see: the POST returned an
 * id, the browser believed it, and the detached run then failed against a record
 * that had stopped existing. In memory, with no separate lifetime for the record,
 * that is not reproducible.
 *
 * So: a real port, a real database file, a real background run, and — the part
 * that matters — a *second server process reading the same file*. If the record
 * only ever lived in the first server's memory, the reload finds nothing.
 */

const config: AnalysisConfig = {
  provider: "mock",
  model: "mock-durability-model",
  seed: 5,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
  apiKey: undefined,
};

let workspace: string;
let home: string;
let servers: RunningServer[] = [];
let stores: AnalysisStore[] = [];

function write(relativePath: string, contents: string): void {
  const target = path.join(workspace, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/** The mock provider, slowed so a request can arrive mid-run. */
function slowClient(perCallMs: number): LlmClient {
  const fast = createLlmClient(config);
  return {
    provider: fast.provider,
    model: fast.model,
    generateStructured: async (request) => {
      await sleep(perCallMs);
      return await fast.generateStructured(request);
    },
    generateWithTools: async (request) => {
      await sleep(perCallMs);
      if (fast.generateWithTools === undefined) throw new Error("the mock provider lost its tool support");
      return await fast.generateWithTools(request);
    },
  };
}

/**
 * A server wired the way `main.ts` wires one: a single application-scoped store,
 * on the path the application would actually resolve.
 *
 * `resolveDatabaseLocation` is used rather than a hand-built path, so that a change
 * to where the database lives is a change this test sees.
 */
async function startServer(options: { client?: LlmClient } = {}): Promise<{ base: string; server: RunningServer }> {
  const location = resolveDatabaseLocation({ workspaceRoot: workspace, env: {}, homeDirectory: home });
  const store = new SqliteAnalysisStore({ location });
  stores.push(store);
  const server = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot: workspace,
    config,
    budget: DEFAULT_EXPLORATION_BUDGET,
    precisionPolicy: DEFAULT_PRECISION_POLICY,
    client: options.client ?? createLlmClient(config),
    store,
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, server };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function api(base: string, urlPath: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(`${base}${urlPath}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Polls the list route until the analysis reaches a terminal status, or gives up. */
async function waitForTerminal(base: string, id: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api(base, `/api/analyses/${id}`);
    const status = body["status"];
    if (status === "completed" || status === "failed") return body;
    if (Date.now() > deadline) throw new Error(`analysis ${id} never finished; last status ${String(status)}`);
    await sleep(50);
  }
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-web-durability-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "repo-arch-web-durability-home-"));
  servers = [];
  stores = [];
  write("widget/README.md", "# widget\n\nA small dispatcher used by the tests.\n");
  write("widget/package.json", '{ "name": "widget", "version": "1.0.0" }\n');
  write("widget/src/dispatch.js", "export function dispatch(step) {\n  return step;\n}\n");
});

afterEach(async () => {
  // The thing this file is about: a run outlives the request that started it, so a
  // teardown that closes the store first would pull the database out from under it
  // — the same shape of bug, produced by the test rather than by the product.
  for (const server of servers) {
    await server.api.idle();
    await server.close();
  }
  for (const store of stores) await store.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("an analysis started over HTTP", () => {
  /**
   * The path the original failure took, end to end.
   *
   * POST returns an id and 202 — the work has not been done. The record is
   * immediately readable at that id, which is the promise the id represents. The
   * detached run then finishes and the terminal record is readable at the same id.
   */
  it("is readable at its id from the moment the POST returns until it completes", async () => {
    const { base } = await startServer({ client: slowClient(60) });

    const created = await api(base, "/api/analyses", {
      method: "POST",
      body: JSON.stringify({ repository: "widget" }),
    });
    expect(created.status).toBe(202);
    const id = String(created.body["id"]);
    expect(id).not.toBe("");

    // The id the client was just handed resolves, while the work is still going.
    const immediately = await api(base, `/api/analyses/${id}`);
    expect(immediately.status).toBe(200);

    const terminal = await waitForTerminal(base, id);
    expect(terminal["status"]).toBe("completed");
    expect(terminal["report"]).toBeTruthy();
  });

  /**
   * The record is in the database, not in the server.
   *
   * A second server, started against the same resolved path after the first has
   * stopped, must find the finished analysis. This is the reload a user does.
   */
  it("survives a full server restart", async () => {
    const first = await startServer();
    const created = await api(first.base, "/api/analyses", {
      method: "POST",
      body: JSON.stringify({ repository: "widget" }),
    });
    const id = String(created.body["id"]);
    await waitForTerminal(first.base, id);

    await first.server.api.idle();
    await first.server.close();
    for (const store of stores) await store.close();
    servers = [];
    stores = [];

    const second = await startServer();
    const reloaded = await api(second.base, `/api/analyses/${id}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body["status"]).toBe("completed");

    const listed = await api(second.base, "/api/analyses");
    expect((listed.body["analyses"] as unknown[]).length).toBe(1);
  });
});

describe("deleting an analysis over HTTP while it is running", () => {
  /**
   * The regression test for the reported failure, at the level it was reported.
   *
   * Before the fix this produced five `phase … not recorded: StorageError: No
   * analysis an-…` lines, a `failed:` line and a `could not be marked failed:`
   * line, because DELETE removed the row out from under a live run. The delete is
   * honoured — the analysis really is gone — but the run is told, so it stops
   * instead of writing into a hole.
   */
  it("cancels the run and leaves no storage errors in the log", async () => {
    const logged: string[] = [];
    const location = resolveDatabaseLocation({ workspaceRoot: workspace, env: {}, homeDirectory: home });
    const store = new SqliteAnalysisStore({ location });
    stores.push(store);
    const server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot: workspace,
      config,
      budget: DEFAULT_EXPLORATION_BUDGET,
      precisionPolicy: DEFAULT_PRECISION_POLICY,
      client: slowClient(120),
      store,
      logError: (message: string) => logged.push(message),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const created = await api(base, "/api/analyses", {
      method: "POST",
      body: JSON.stringify({ repository: "widget" }),
    });
    const id = String(created.body["id"]);

    await sleep(250);
    const deleted = await api(base, `/api/analyses/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body["deleted"]).toBe(id);
    // The route reports that something was actually running, so the UI can say so.
    expect(deleted.body["cancelled"]).toBe(true);

    // Let whatever was in flight finish and try, or decline, to write.
    await server.api.idle();
    await sleep(500);

    // The analysis is gone and stays gone.
    const gone = await api(base, `/api/analyses/${id}`);
    expect(gone.status).toBe(404);
    expect(await store.get(id)).toBeUndefined();
    expect(await store.list()).toEqual([]);

    // The log is the point.
    const log = logged.join("\n");
    expect(log).not.toContain("StorageError");
    expect(log).not.toContain("No analysis");
    expect(log).not.toContain("could not be marked failed");
    expect(log).toContain("was deleted while it was running");
  });

  /** Deleting a finished analysis is a plain delete, and reports no cancellation. */
  it("reports no cancellation when the analysis had already finished", async () => {
    const { base } = await startServer();
    const created = await api(base, "/api/analyses", {
      method: "POST",
      body: JSON.stringify({ repository: "widget" }),
    });
    const id = String(created.body["id"]);
    await waitForTerminal(base, id);

    const deleted = await api(base, `/api/analyses/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body["cancelled"]).toBe(false);
    expect((await api(base, `/api/analyses/${id}`)).status).toBe(404);
  });
});
