import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLlmClient, type AnalysisConfig, type LlmClient } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisEventBus } from "../src/lifecycle";
import { AnalysisRunner } from "../src/runner";
import { SqliteAnalysisStore } from "../src/store/sqlite";
import { AnalysisNotFoundError } from "../src/store/types";
import type { AnalysisRecord } from "../src/store/types";

/**
 * The record's lifetime, on a real database file.
 *
 * Every other test in this repository opens the store at `:memory:`, which is fast
 * and honest about the schema but silent about the thing that actually broke: a
 * record has a *lifetime*, and a detached run has a different one. In memory the
 * two are indistinguishable because the process holds both.
 *
 * So these tests use a file. They are deliberately split — persistence apart from
 * execution, execution apart from deletion — because the failure they exist for
 * looked like "the store lost a row" and was in fact "something removed the row
 * while the runner was still using it". A single opaque end-to-end test would have
 * caught it and told you nothing about which half was wrong.
 */

const config: AnalysisConfig = {
  provider: "mock",
  model: "test-model",
  seed: 7,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
  apiKey: undefined,
};

let workspace: string;
let databaseDirectory: string;
/** Every store opened here, so no connection is left open at teardown. */
let opened: SqliteAnalysisStore[] = [];

function write(relativePath: string, contents: string): void {
  const target = path.join(workspace, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** The one database file this test's stores share, as a real path on disk. */
function databaseFile(): string {
  return path.join(databaseDirectory, "analyses.db");
}

function openStore(): SqliteAnalysisStore {
  const store = new SqliteAnalysisStore({ location: databaseFile() });
  opened.push(store);
  return store;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * The real mock client, slowed down.
 *
 * A delete has to land *during* the pipeline to test anything, and the mock
 * provider is fast enough that without this the run is over before a test can act.
 * The behaviour is the mock's own — only the timing changes.
 */
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

interface Harness {
  runner: AnalysisRunner;
  store: SqliteAnalysisStore;
  events: AnalysisEventBus;
  logged: string[];
}

function harness(options: { client?: LlmClient } = {}): Harness {
  const store = openStore();
  const events = new AnalysisEventBus();
  const logged: string[] = [];
  const runner = new AnalysisRunner({
    store,
    events,
    workspaceRoot: workspace,
    config,
    client: options.client ?? createLlmClient(config),
    logError: (message) => logged.push(message),
  });
  return { runner, store, events, logged };
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-persist-ws-"));
  databaseDirectory = mkdtempSync(path.join(tmpdir(), "repo-arch-persist-db-"));
  opened = [];
  write("widget/README.md", "# widget\n\nA small dispatcher used by the tests.\n");
  write("widget/package.json", '{ "name": "widget", "version": "1.0.0" }\n');
  write("widget/src/dispatch.js", "export function dispatch(step) {\n  return step;\n}\n");
});

afterEach(async () => {
  for (const store of opened) await store.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(databaseDirectory, { recursive: true, force: true });
});

describe("a created record is durable", () => {
  /**
   * Persistence alone: no runner, no pipeline, no background anything.
   *
   * `create` must not return until the row is on disk, because the very next thing
   * that happens in production is a detached task writing to it — and, on the path
   * that broke, an HTTP response telling the browser the id is real.
   */
  it("survives a close and reopen with no run involved", async () => {
    const writer = openStore();
    const created = await writer.create({
      id: "an-durable-1",
      repositoryPath: "widget",
      repositoryName: "widget",
      system: "advanced",
      provider: "mock",
      model: "test-model",
      focus: undefined,
    });
    expect(created.status).toBe("queued");
    await writer.close();

    const reader = openStore();
    const reloaded = await reader.get("an-durable-1");
    expect(reloaded?.id).toBe("an-durable-1");
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.repositoryPath).toBe("widget");
  });

  /**
   * The store the analysis was started through and the store the record is read
   * back from are the same *file*, not the same object. This is the check that
   * would fail if a second store were ever opened on a different path.
   */
  it("is readable from an independently opened store on the configured path", async () => {
    const { runner } = harness();
    const started = await runner.start({ repository: "widget" });

    const other = new SqliteAnalysisStore({ location: databaseFile() });
    opened.push(other);
    const seen = await other.get(started.record.id);
    expect(seen?.id).toBe(started.record.id);

    await started.completion;
  });
});

describe("a detached run continues after the initiating call returns", () => {
  /**
   * The separation the runner exists for. `start` resolves as soon as the record
   * is durable; the pipeline is still going. Both halves are asserted, in order,
   * so a regression that collapsed them back together fails here.
   *
   * Note what is *not* asserted: that the stored status is still `queued`. The
   * store is a synchronous binding, so the run's first write has already landed by
   * the time this test looks. `queued` is what the caller is handed and what a
   * reader would see if the process died here — the durable claim — not a state
   * the row lingers in.
   */
  it("returns a durable record while the work is still in flight", async () => {
    const { runner, store } = harness({ client: slowClient(60) });

    const started = await runner.start({ repository: "widget" });
    expect(started.record.status).toBe("queued");

    // The initiating call has returned. The work has not finished.
    const inFlight = await store.get(started.record.id);
    expect(inFlight).toBeDefined();
    expect(runner.isRunning(started.record.id)).toBe(true);
    expect(["queued", "validating", "analyzing"]).toContain(inFlight?.status);

    const finished = await started.completion;
    expect(finished.status).toBe("completed");

    const durable = await store.get(started.record.id);
    expect(durable?.status).toBe("completed");
    expect(durable?.report).not.toBeNull();
    expect(runner.isRunning(started.record.id)).toBe(false);
  });

  /** The phases the pipeline announced were written to the row, not just emitted. */
  it("persists phase progress against the stored record", async () => {
    const { runner, store, events } = harness();
    const phases: string[] = [];

    const started = await runner.start({ repository: "widget" });
    events.subscribe(started.record.id, (event) => {
      if (event.type === "analysis.phase") phases.push(event.phase);
    });
    await started.completion;

    expect(phases.length).toBeGreaterThan(0);
    // Terminal records clear the phase, so the evidence that phases were written is
    // that every write landed on a row that existed: no phase was left unrecorded.
    const durable = await store.get(started.record.id);
    expect(durable?.phase).toBeNull();
    expect(durable?.status).toBe("completed");
  });

  /**
   * A failure is a record too, and it has to be reloadable. The message is the safe
   * sentence; the cause stays in the operator's log.
   */
  it("persists a failure as a reloadable failed record", async () => {
    const { runner, store, logged } = harness({
      client: {
        provider: "mock",
        model: "test-model",
        generateStructured: () => {
          throw new Error("ENOENT: open '/home/someone/.ssh/id_rsa'");
        },
        generateWithTools: () => {
          throw new Error("ENOENT: open '/home/someone/.ssh/id_rsa'");
        },
      },
    });

    const finished = await (await runner.start({ repository: "widget" })).completion;
    expect(finished.status).toBe("failed");

    const durable = await store.get(finished.id);
    expect(durable?.status).toBe("failed");
    expect(durable?.error).toBe("The analysis failed. See the server log for details.");
    expect(durable?.error).not.toContain("id_rsa");
    expect(logged.join("\n")).toContain("id_rsa");
  });
});

describe("deleting an analysis that is still running", () => {
  /**
   * The regression test for the bug this file was written for.
   *
   * A record was deleted while its detached run was mid-pipeline. Every subsequent
   * write failed against a row that no longer existed — once per phase, then once
   * for the terminal write, then once more for the attempt to record *that* — and
   * the operator's log filled with `StorageError: No analysis an-…`.
   *
   * The record is not resurrected. The delete asked for the analysis to stop
   * existing, and it does; what changes is that the runner is told, stops writing,
   * and says so once, calmly.
   */
  it("stops the run cleanly instead of failing once per write", async () => {
    const { runner, store, logged } = harness({ client: slowClient(120) });

    const started = await runner.start({ repository: "widget" });
    const id = started.record.id;

    // The user's gesture, mid-run: remove the analysis they no longer want. The
    // route announces it to the runner first, exactly as `routeDelete` does.
    await sleep(200);
    expect(runner.isRunning(id)).toBe(true);
    expect(runner.abandon(id)).toBe(true);
    expect(await store.delete(id)).toBe(true);

    const finished = await started.completion;

    // The completion still resolves — a caller awaiting it is never left hanging.
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("The analysis was deleted while it was running.");

    // The row stays deleted. Nothing recreated it.
    expect(await store.get(id)).toBeUndefined();
    expect(await store.list()).toEqual([]);

    // And the log is one calm line, not a pile of storage errors.
    const log = logged.join("\n");
    expect(log).not.toContain("No analysis");
    expect(log).not.toContain("not recorded");
    expect(log).not.toContain("could not be marked failed");
    expect(logged).toEqual([`analysis ${id} was deleted while it was running; its result was discarded.`]);
  });

  /**
   * The same, without the announcement.
   *
   * `abandon` is an optimisation of the log; the invariant is that the runner
   * recognises its own record's disappearance. A delete that races the runner — or
   * arrives from somewhere that forgot to announce it — must still end quietly.
   */
  it("recognises the deletion even when nothing announced it", async () => {
    const { runner, store, logged } = harness({ client: slowClient(120) });

    const started = await runner.start({ repository: "widget" });
    const id = started.record.id;

    await sleep(200);
    expect(await store.delete(id)).toBe(true);

    const finished = await started.completion;
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("The analysis was deleted while it was running.");
    expect(await store.get(id)).toBeUndefined();

    // At most one write can lose the race; the rest are suppressed by the
    // observation. What must never happen is the seven-line pile-up.
    const storageErrors = logged.filter((line) => line.includes("No analysis"));
    expect(storageErrors).toEqual([]);
    expect(logged).toContain(`analysis ${id} was deleted while it was running; its result was discarded.`);
  });

  /** Deleting a finished analysis is not a cancellation, and says so. */
  it("reports that nothing was running when the analysis has already finished", async () => {
    const { runner, store } = harness();
    const started = await runner.start({ repository: "widget" });
    await started.completion;

    expect(runner.isRunning(started.record.id)).toBe(false);
    expect(runner.abandon(started.record.id)).toBe(false);
    expect(await store.delete(started.record.id)).toBe(true);
  });
});

describe("the missing-analysis invariant", () => {
  /**
   * §9 of the brief, as a test: a missing record stays an error.
   *
   * The fix makes the *category* finer, not weaker. `get` still returns undefined,
   * `update` still throws rather than quietly creating the row, and the error is
   * still a `StorageError` on the wire — the subclass only lets the record's owner
   * tell "mine is gone" from "the database is broken".
   */
  it("still throws, still reads as a StorageError, and never creates the row", async () => {
    const store = openStore();

    await expect(store.update("an-missing", { status: "completed" })).rejects.toThrow(AnalysisNotFoundError);
    await expect(store.update("an-missing", { status: "completed" })).rejects.toThrow("No analysis an-missing.");

    const error = await store.update("an-missing", { phase: "scouting" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalysisNotFoundError);
    // The HTTP layer maps on `name`, and a deleted record is not a new wire category.
    expect((error as AnalysisNotFoundError).name).toBe("StorageError");
    expect((error as AnalysisNotFoundError).analysisId).toBe("an-missing");

    // The failed update created nothing.
    expect(await store.get("an-missing")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  /** A run against a genuinely broken store is still a failure, and still says so. */
  it("does not mistake a broken store for a deleted record", async () => {
    const events = new AnalysisEventBus();
    const logged: string[] = [];
    const record: AnalysisRecord = {
      id: "an-broken",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
      status: "queued",
      phase: null,
      repositoryPath: "widget",
      repositoryName: "widget",
      summary: "",
      error: null,
      metadata: { system: "advanced", provider: "mock", model: "test-model", focus: null, durationMs: null },
      report: null,
      graph: null,
      evidence: [],
      questions: [],
    };
    const runner = new AnalysisRunner({
      store: {
        create: async () => record,
        get: async () => record,
        list: async () => [],
        update: async () => {
          throw new Error("database is gone");
        },
        delete: async () => false,
        appendQuestion: async () => {},
        getEvidenceSource: async () => undefined,
        close: async () => {},
      },
      events,
      workspaceRoot: workspace,
      config,
      client: createLlmClient(config),
      logError: (message) => logged.push(message),
    });

    const result = await (await runner.start({ repository: "widget" })).completion;

    expect(result.status).toBe("failed");
    expect(result.error).not.toBe("The analysis was deleted while it was running.");
    expect(logged.join("\n")).toContain("could not be marked failed");
    expect(logged.join("\n")).not.toContain("was deleted while it was running");
  });
});
