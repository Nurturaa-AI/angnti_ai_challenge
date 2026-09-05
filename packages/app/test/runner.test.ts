import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLlmClient, type AnalysisConfig } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisEventBus, type AnalysisEvent } from "../src/lifecycle";
import { AnalysisRunner } from "../src/runner";
import { MEMORY_DATABASE, SqliteAnalysisStore } from "../src/store/sqlite";
import type { AnalysisPatch, AnalysisRecord, AnalysisStore } from "../src/store/types";

/**
 * The analysis lifecycle, offline.
 *
 * Iteration 4 ran the pipeline inline inside a request handler, which made "the
 * analysis succeeded" and "the client is still connected" the same fact. The runner
 * separates them, and these tests are about that separation rather than about the
 * analysis itself:
 *
 *  - The record exists **before** the work does, so a client that navigates away has
 *    not lost its analysis.
 *  - A failure is a `failed` **record**, not a rejected promise — by the time the
 *    pipeline runs, the caller that asked may be gone and there is nobody to catch.
 *  - The report the browser reads names the repository as the *caller* named it, not
 *    as this machine's filesystem does.
 *
 * The model is the offline mock provider, so a full run happens here — real tool
 * calls against a real temporary repository — at no cost and with no network.
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

function write(relativePath: string, contents: string): void {
  const target = path.join(workspace, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

interface Harness {
  runner: AnalysisRunner;
  store: SqliteAnalysisStore;
  events: AnalysisEventBus;
  logged: string[];
}

function harness(): Harness {
  const store = new SqliteAnalysisStore({ location: MEMORY_DATABASE });
  const events = new AnalysisEventBus();
  const logged: string[] = [];
  const runner = new AnalysisRunner({
    store,
    events,
    workspaceRoot: workspace,
    config,
    client: createLlmClient(config),
    logError: (message) => logged.push(message),
  });
  return { runner, store, events, logged };
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-runner-"));
  write("widget/README.md", "# widget\n\nA demo dispatcher.\n");
  write("widget/package.json", '{ "name": "widget", "dependencies": { "express": "^4.19.2" } }\n');
  write("widget/src/dispatch.js", "const REGISTRY = { extract, load };\n\nfunction dispatch(step) {\n  return REGISTRY[step.type];\n}\n");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("AnalysisRunner — the record exists before the work", () => {
  it("returns a durable queued record from start, before the pipeline finishes", async () => {
    const { runner, store } = harness();

    const started = await runner.start({ repository: "widget" });

    // The record handed to the caller is the `queued` one, and the row is already in
    // the database while the pipeline is still running — which is what makes a
    // disconnect survivable. It has usually advanced to `validating` by now: the
    // SQLite binding is synchronous, so `run` gets as far as its first status write
    // before `start` returns. What matters is that it exists and has not finished.
    expect(started.record.status).toBe("queued");
    const inFlight = await store.get(started.record.id);
    expect(inFlight).toBeDefined();
    expect(["queued", "validating", "analyzing"]).toContain(inFlight?.status);
    expect(started.record.repositoryName).toBe("widget");

    await started.completion;
    await store.close();
  });

  it("stores the repository as the caller named it, never as an absolute host path", async () => {
    const { runner, store } = harness();

    const started = await runner.start({ repository: "./widget/" });
    const completed = await started.completion;

    // A record holding a relative path can be opened by a process started somewhere
    // else; one holding an absolute path is a note about this machine.
    expect(completed.repositoryPath).toBe("widget");
    expect(JSON.stringify(completed)).not.toContain(workspace);
    await store.close();
  });

  it("mints ids that do not collide across restarts", async () => {
    const first = harness();
    const second = harness();

    const a = await first.runner.start({ repository: "widget" });
    const b = await second.runner.start({ repository: "widget" });

    // Both are the first analysis of their process. A bare counter would give both
    // `an-1`, which a durable store cannot tolerate.
    expect(a.record.id).not.toBe(b.record.id);
    await Promise.all([a.completion, b.completion]);
    await first.store.close();
    await second.store.close();
  });

  it("rejects a request the caller should fix before creating any record", async () => {
    const { runner, store } = harness();

    // A focus the baseline cannot honour is the caller's mistake, not an analysis
    // worth remembering. Nothing should be left in the list.
    await expect(runner.start({ repository: "widget", system: "baseline", focus: "the queue" })).rejects.toThrow(
      /only available to the "advanced" system/,
    );
    expect(await store.list()).toEqual([]);
    await store.close();
  });
});

describe("AnalysisRunner — ids are unique across runners, not just within one", () => {
  /**
   * The regression this guards is a primary-key collision in a durable store.
   *
   * Ids used to be `an-<now in base 36>-<counter>`, where the counter restarts at 1
   * in every runner. Two runners constructed in the same millisecond therefore
   * produced the same prefix and then the same ids — and once the store was durable,
   * the second `create` was writing over the first analysis rather than beside it.
   * A millisecond is a long time: two workers starting together, or two harnesses in
   * one test file, land inside it easily.
   */
  it("mints different ids from two runners constructed at the same instant", async () => {
    // A frozen clock is the point: it reproduces the collision exactly rather than
    // hoping two constructors land in the same millisecond by luck.
    const instant = new Date("2026-09-05T00:00:00.000Z");
    const stores = [
      new SqliteAnalysisStore({ location: MEMORY_DATABASE }),
      new SqliteAnalysisStore({ location: MEMORY_DATABASE }),
    ];
    const runners = stores.map(
      (store) =>
        new AnalysisRunner({
          store,
          events: new AnalysisEventBus(),
          workspaceRoot: workspace,
          config,
          client: createLlmClient(config),
          now: () => instant,
          logError: () => {},
        }),
    );

    const started = await Promise.all(runners.map((runner) => runner.start({ repository: "widget" })));
    const ids = started.map((start) => start.record.id);

    expect(ids[0]).not.toBe(ids[1]);
    // Still one opaque segment then a counter, because that shape is what the API
    // surface and the URLs a person reads already treat as the contract.
    for (const id of ids) expect(id).toMatch(/^an-[a-z0-9]+-\d+$/);

    await Promise.all(started.map((start) => start.completion));
    await Promise.all(stores.map((store) => store.close()));
  });

  it("keeps the counter ordering runs within one runner", async () => {
    const { runner, store } = harness();

    const first = await runner.start({ repository: "widget" });
    const second = await runner.start({ repository: "widget" });

    // Same prefix, successive counters: the prefix carries uniqueness, the counter
    // only orders. Losing that would make ids unreadable for no gain.
    const prefix = (id: string): string => id.slice(0, id.lastIndexOf("-"));
    expect(prefix(second.record.id)).toBe(prefix(first.record.id));
    expect(first.record.id).toMatch(/-1$/);
    expect(second.record.id).toMatch(/-2$/);

    await Promise.all([first.completion, second.completion]);
    await store.close();
  });
});

describe("AnalysisRunner — a completed analysis", () => {
  it("records the report, the graph, the projected evidence and a duration", async () => {
    const { runner, store } = harness();

    const completed = await (await runner.start({ repository: "widget" })).completion;

    expect(completed.status).toBe("completed");
    expect(completed.phase).toBeNull();
    expect(completed.error).toBeNull();
    expect(completed.summary.length).toBeGreaterThan(0);
    expect(completed.report).not.toBeNull();
    expect(completed.graph?.nodes.length).toBeGreaterThan(0);
    expect(completed.evidence.length).toBeGreaterThan(0);
    expect(completed.metadata.durationMs).not.toBeNull();

    // The store is the record. Re-reading it must give the same thing the runner
    // returned rather than something assembled in memory and never persisted.
    expect(await store.get(completed.id)).toEqual(completed);
    await store.close();
  });

  it("rewrites the report's repository path to the one the caller can see", async () => {
    const { runner, store } = harness();

    const completed = await (await runner.start({ repository: "widget" })).completion;

    // `collectRepositoryContext` records a path relative to the process's own working
    // directory, which for a served workspace describes a machine the caller cannot see.
    expect(completed.report?.repository.path).toBe("widget");
    await store.close();
  });

  it("emits created, started, every phase, and completed — in that order", async () => {
    const { runner, events, store } = harness();
    const seen: AnalysisEvent[] = [];

    const started = await runner.start({ repository: "widget" });
    events.subscribe(started.record.id, (event) => seen.push(event));
    await started.completion;

    const types = seen.map((event) => event.type);
    expect(types[0]).toBe("analysis.created");
    expect(types[1]).toBe("analysis.started");
    expect(types[types.length - 1]).toBe("analysis.completed");
    // `building-report` belongs to the product layer, which performs it, and so is
    // reported alongside the pipeline's own phases.
    const phases = seen.flatMap((event) => (event.type === "analysis.phase" ? [event.phase] : []));
    expect(phases).toContain("collecting-context");
    expect(phases).toContain("building-report");
    expect(phases[phases.length - 1]).toBe("building-report");
    await store.close();
  });

  it("carries no model prose, tool result or trajectory into an event", async () => {
    const { runner, events, store } = harness();
    const seen: AnalysisEvent[] = [];

    const started = await runner.start({ repository: "widget" });
    events.subscribe(started.record.id, (event) => seen.push(event));
    await started.completion;

    // A phase event says the pipeline reached scouting. It must not say what the
    // scout searched for or what it found.
    for (const event of seen) {
      expect(Object.keys(event).sort()).not.toContain("trajectory");
      expect(JSON.stringify(event)).not.toContain("REGISTRY");
      expect(JSON.stringify(event)).not.toContain(workspace);
    }
    await store.close();
  });

  it("persists the phase while running, and clears it on completion", async () => {
    const { runner, events, store } = harness();
    const reads: Promise<string | null>[] = [];

    const started = await runner.start({ repository: "widget" });
    events.subscribe(started.record.id, (event) => {
      if (event.type !== "analysis.phase") return;
      // Read through the *store*, not the event: this asserts the phase write
      // happened, rather than that the emit did.
      reads.push(store.get(started.record.id).then((record) => record?.phase ?? null));
    });

    const completed = await started.completion;
    const observed = await Promise.all(reads);

    // A reload mid-run has to be able to say which phase it is in, so at least one
    // phase must have reached the database while the analysis was still running.
    expect(observed.some((phase) => phase !== null)).toBe(true);
    // And a finished analysis is not "in" a phase. Leaving the last one set would make
    // a completed record look like it were still working.
    expect(completed.phase).toBeNull();
    await store.close();
  });
});

describe("AnalysisRunner — a failed analysis", () => {
  it("turns a bad repository into a failed record rather than a rejection", async () => {
    const { runner, store } = harness();

    const started = await runner.start({ repository: "absent" });
    // Never rejects. By the time the pipeline runs, the client that asked may be gone.
    const failed = await started.completion;

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("No such directory in the workspace");
    expect(failed.report).toBeNull();
    expect(failed.metadata.durationMs).not.toBeNull();
    // And it is in the list, which is the point of validating after the record exists:
    // "that directory is not in the workspace" is a result the user can see on reload.
    expect((await store.list()).map((row) => row.status)).toEqual(["failed"]);
    await store.close();
  });

  it("refuses a repository outside the workspace and says so safely", async () => {
    const { runner, store } = harness();

    const failed = await (await runner.start({ repository: "../../etc" })).completion;

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("escapes the repository");
    // Echoing back the path the caller typed is not a leak — they typed it. What must
    // not appear is anything about this machine's filesystem that they did not supply.
    expect(failed.error).not.toContain(workspace);
    await store.close();
  });

  it("emits a failed event so a watching client stops waiting", async () => {
    const { runner, events, store } = harness();
    const seen: AnalysisEvent[] = [];

    const started = await runner.start({ repository: "absent" });
    events.subscribe(started.record.id, (event) => seen.push(event));
    await started.completion;

    expect(seen[seen.length - 1]?.type).toBe("analysis.failed");
    await store.close();
  });

  it("logs the unexpected failure in full but records only the safe sentence", async () => {
    const store = new SqliteAnalysisStore({ location: MEMORY_DATABASE });
    const logged: string[] = [];
    const runner = new AnalysisRunner({
      store,
      events: new AnalysisEventBus(),
      workspaceRoot: workspace,
      config,
      // A client that throws something we never anticipated.
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
      logError: (message) => logged.push(message),
    });

    const failed = await (await runner.start({ repository: "widget" })).completion;

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("The analysis failed. See the server log for details.");
    expect(failed.error).not.toContain("id_rsa");
    // The operator still gets everything, on stderr.
    expect(logged.join("\n")).toContain("id_rsa");
    await store.close();
  });

  it("does not throw when the store itself is gone", async () => {
    const events = new AnalysisEventBus();
    const seen: AnalysisEvent[] = [];
    const logged: string[] = [];

    // A store that accepts the create and then refuses every update, which is what a
    // deleted or unwritable database file looks like mid-run.
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
      metadata: {
        system: "advanced",
        systemVersion: null,
        provenance: null,
        provider: "mock",
        model: "test-model",
        focus: null,
        durationMs: null,
      },
      report: null,
      graph: null,
      evidence: [],
      questions: [],
    };
    const store: AnalysisStore = {
      create: async () => record,
      get: async () => record,
      list: async () => [],
      update: async (_id: string, _patch: AnalysisPatch) => {
        throw new Error("database is gone");
      },
      delete: async () => false,
      appendQuestion: async () => {},
      getEvidenceSource: async () => undefined,
      close: async () => {},
    };

    const runner = new AnalysisRunner({
      store,
      events,
      workspaceRoot: workspace,
      config,
      client: createLlmClient(config),
      logError: (message) => logged.push(message),
    });

    const started = await runner.start({ repository: "widget" });
    events.subscribe(started.record.id, (event) => seen.push(event));
    const result = await started.completion;

    // Still resolves, still reports failure to the watcher, still hands back what it
    // last knew rather than throwing into a caller that has nowhere to put it.
    expect(result.status).toBe("failed");
    expect(seen.some((event) => event.type === "analysis.failed")).toBe(true);
    expect(logged.join("\n")).toContain("could not be marked failed");
  });
});
