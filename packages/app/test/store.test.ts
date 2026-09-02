import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StorageError, type ContextSourceText } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph } from "../src/architecture";
import type { AnsweredQuestionView } from "../src/questions";
import {
  DATABASE_ENV_VAR,
  DEFAULT_DATABASE_DIRECTORY,
  DEFAULT_DATABASE_FILE,
  resolveDatabaseLocation,
} from "../src/store/location";
import { mergeQuestionEvidence, projectEvidence, toContextSources } from "../src/store/projection";
import { MEMORY_DATABASE, SCHEMA_VERSION, SqliteAnalysisStore } from "../src/store/sqlite";
import type { NewAnalysis, StoredEvidenceSource } from "../src/store/types";
import { report } from "./report-fixture";

/**
 * The durable store, and the three promises it exists to keep.
 *
 * Iteration 4's store was a bounded map, so "does it survive a restart" was not a
 * question anyone could ask. Now it is the whole point, and it brings two failure
 * modes a map never had: a file that outlives the code that wrote it, and a second
 * analysis whose rows sit in the same tables as the first. So the tests here are
 * weighted towards those rather than towards CRUD:
 *
 *  1. **It remembers.** A record written, closed and reopened is the same record —
 *     payloads included, not just the row.
 *  2. **Analyses do not leak into each other.** An evidence id is only ever
 *     resolvable through the analysis it belongs to, which is the property the
 *     evidence route depends on for its `404`.
 *  3. **A database it does not understand is refused, not guessed at.** Silently
 *     ignoring a column is how a durable store starts losing data.
 *
 * Nothing here goes near the evaluation fixtures: this is product storage, and a
 * storage test that only passed for `orders-api` would be measuring the wrong thing.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "repo-arch-store-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function memoryStore(): SqliteAnalysisStore {
  return new SqliteAnalysisStore({ location: MEMORY_DATABASE, now: fixedClock() });
}

/** A clock that advances a second per read, so `updatedAt` ordering is observable. */
function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + tick++ * 1000);
}

function newAnalysis(overrides: Partial<NewAnalysis> = {}): NewAnalysis {
  return {
    id: "an-1",
    repositoryPath: "widget",
    repositoryName: "widget",
    system: "advanced",
    provider: "mock",
    model: "test-model",
    ...overrides,
  };
}

function source(id: string, overrides: Partial<ContextSourceText> = {}): ContextSourceText {
  const text = overrides.text ?? `contents of ${id}`;
  return {
    id,
    type: "file",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: false,
    ...overrides,
  };
}

function question(id: string, overrides: Partial<AnsweredQuestionView> = {}): AnsweredQuestionView {
  return {
    id,
    question: "What dispatches a step?",
    askedAt: "2026-01-02T03:04:05.000Z",
    answer: "The registry in src/dispatch.js.",
    supported: true,
    modelReportedSufficient: true,
    confidence: 0.7,
    citations: [],
    inspectedSources: [],
    audit: { claimed: 0, grounded: 0, dropped: [] },
    metrics: {
      durationMs: 10,
      turns: 2,
      toolCalls: 1,
      failedToolCalls: 0,
      scoutFilesRead: 1,
      bytesFromTools: 100,
      budgetExhausted: false,
      inputTokens: 10,
      outputTokens: 5,
    },
    ...overrides,
  };
}

describe("SqliteAnalysisStore — it remembers", () => {
  it("returns a record written by a previous process, payloads and all", async () => {
    const location = path.join(directory, "analyses.db");
    const briefing = report();
    const graph = buildArchitectureGraph(briefing);

    const first = new SqliteAnalysisStore({ location });
    await first.create(newAnalysis());
    await first.update("an-1", {
      status: "completed",
      summary: briefing.summary,
      report: briefing,
      graph,
      evidence: [{ id: "file:src/router.ts", type: "file", text: "export const router = 1;", bytes: 24, truncated: false }],
    });
    await first.appendQuestion("an-1", question("q-1"));
    await first.close();

    // A different store object on the same file: the closest thing a test can get
    // to a restart without spawning a process.
    const second = new SqliteAnalysisStore({ location });
    const record = await second.get("an-1");

    expect(record?.status).toBe("completed");
    expect(record?.summary).toBe(briefing.summary);
    // The payloads survive as structure, not as strings that happen to round-trip.
    expect(record?.report?.evidence).toHaveLength(briefing.evidence.length);
    expect(record?.graph?.nodes.length).toBe(graph.nodes.length);
    expect(record?.evidence[0]?.id).toBe("file:src/router.ts");
    expect(record?.questions[0]?.answer).toBe("The registry in src/dispatch.js.");
    await second.close();
  });

  it("creates the database's parent directory rather than failing on a first run", async () => {
    const location = path.join(directory, "nested", "deeper", "analyses.db");
    const store = new SqliteAnalysisStore({ location });
    await store.create(newAnalysis());
    expect((await store.get("an-1"))?.status).toBe("queued");
    await store.close();
  });

  it("starts a new record queued, with no phase, no error and no payloads", async () => {
    const store = memoryStore();
    const record = await store.create(newAnalysis({ focus: "the queue consumer" }));

    expect(record.status).toBe("queued");
    expect(record.phase).toBeNull();
    expect(record.error).toBeNull();
    expect(record.report).toBeNull();
    expect(record.graph).toBeNull();
    expect(record.evidence).toEqual([]);
    expect(record.questions).toEqual([]);
    expect(record.metadata).toMatchObject({ system: "advanced", model: "test-model", focus: "the queue consumer", durationMs: null });
    await store.close();
  });

  it("refuses a duplicate id rather than overwriting an analysis", async () => {
    const store = memoryStore();
    await store.create(newAnalysis());
    await expect(store.create(newAnalysis())).rejects.toThrow(StorageError);
    await store.close();
  });

  it("leaves absent patch fields alone and treats null as a real value", async () => {
    const store = memoryStore();
    await store.create(newAnalysis());
    await store.update("an-1", { status: "analyzing", phase: "scouting", summary: "partial" });

    // `phase: null` has to clear the column; `summary` absent has to preserve it.
    const cleared = await store.update("an-1", { phase: null });
    expect(cleared.phase).toBeNull();
    expect(cleared.summary).toBe("partial");
    expect(cleared.status).toBe("analyzing");
    await store.close();
  });

  it("replaces the evidence set on update rather than appending to it", async () => {
    const store = memoryStore();
    await store.create(newAnalysis());
    const one: StoredEvidenceSource = { id: "a", type: "file", text: "a", bytes: 1, truncated: false };
    const two: StoredEvidenceSource = { id: "b", type: "file", text: "b", bytes: 1, truncated: false };

    await store.update("an-1", { evidence: [one] });
    const replaced = await store.update("an-1", { evidence: [two] });

    // Replace, not merge: the runner projects the whole ledger at once, so a merge
    // here would silently keep an artefact a later projection decided to drop.
    expect(replaced.evidence.map((entry) => entry.id)).toEqual(["b"]);
    await store.close();
  });

  it("rejects an update to an analysis that does not exist", async () => {
    const store = memoryStore();
    await expect(store.update("an-absent", { status: "failed" })).rejects.toThrow(StorageError);
    await store.close();
  });

  it("lists newest first, with a question count and no payload columns", async () => {
    const store = memoryStore();
    await store.create(newAnalysis({ id: "an-1", repositoryName: "first" }));
    await store.create(newAnalysis({ id: "an-2", repositoryName: "second" }));
    await store.update("an-1", { report: report(), graph: buildArchitectureGraph(report()) });
    await store.appendQuestion("an-1", question("q-1"));

    const listed = await store.list();

    expect(listed.map((row) => row.id)).toEqual(["an-2", "an-1"]);
    expect(listed.find((row) => row.id === "an-1")?.questionCount).toBe(1);
    // The list view is the one read that happens on every dashboard poll, so it
    // must not carry a report or a graph. Asserting on the *shape* keeps that true
    // if someone widens the query later.
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      "createdAt",
      "error",
      "id",
      "model",
      "phase",
      "questionCount",
      "repositoryName",
      "repositoryPath",
      "status",
      "summary",
      "system",
      "updatedAt",
    ]);
    await store.close();
  });

  it("honours a list limit", async () => {
    const store = memoryStore();
    for (let index = 1; index <= 5; index += 1) await store.create(newAnalysis({ id: `an-${index}` }));
    expect(await store.list({ limit: 2 })).toHaveLength(2);
    await store.close();
  });
});

describe("SqliteAnalysisStore — analyses do not leak into each other", () => {
  it("resolves an evidence id only through the analysis that owns it", async () => {
    const store = memoryStore();
    await store.create(newAnalysis({ id: "an-1" }));
    await store.create(newAnalysis({ id: "an-2" }));
    await store.update("an-1", {
      evidence: [{ id: "file:secret.ts", type: "file", text: "the first analysis's bytes", bytes: 26, truncated: false }],
    });

    // The property the evidence route's 404 rests on. Guessing another analysis's
    // id must not be a way to read its excerpts.
    expect(await store.getEvidenceSource("an-1", "file:secret.ts")).toBeDefined();
    expect(await store.getEvidenceSource("an-2", "file:secret.ts")).toBeUndefined();
    await store.close();
  });

  it("keeps the same evidence id in two analyses as two independent rows", async () => {
    const store = memoryStore();
    await store.create(newAnalysis({ id: "an-1" }));
    await store.create(newAnalysis({ id: "an-2" }));
    await store.update("an-1", { evidence: [{ id: "file:x.ts", type: "file", text: "from one", bytes: 8, truncated: false }] });
    await store.update("an-2", { evidence: [{ id: "file:x.ts", type: "file", text: "from two", bytes: 8, truncated: false }] });

    // Two repositories legitimately contain the same path. The primary key is the
    // pair, so this is not a conflict, and neither row may win.
    expect((await store.getEvidenceSource("an-1", "file:x.ts"))?.text).toBe("from one");
    expect((await store.getEvidenceSource("an-2", "file:x.ts"))?.text).toBe("from two");
    await store.close();
  });

  it("refuses a question for an analysis that does not exist", async () => {
    const store = memoryStore();
    // Otherwise a typo'd id would create an orphan history nothing could ever read.
    await expect(store.appendQuestion("an-absent", question("q-1"))).rejects.toThrow(StorageError);
    await store.close();
  });

  it("bounds question history per analysis, evicting the oldest", async () => {
    const store = new SqliteAnalysisStore({ location: MEMORY_DATABASE, maxQuestions: 3 });
    await store.create(newAnalysis({ id: "an-1" }));
    await store.create(newAnalysis({ id: "an-2" }));
    for (let index = 1; index <= 5; index += 1) await store.appendQuestion("an-1", question(`q-${index}`));
    await store.appendQuestion("an-2", question("q-only"));

    const chatty = await store.get("an-1");
    const quiet = await store.get("an-2");

    expect(chatty?.questions.map((entry) => entry.id)).toEqual(["q-3", "q-4", "q-5"]);
    // The bound is per analysis: a chatty analysis must not evict another's history.
    expect(quiet?.questions.map((entry) => entry.id)).toEqual(["q-only"]);
    await store.close();
  });

  it("deletes an analysis's evidence and questions with it", async () => {
    const store = memoryStore();
    await store.create(newAnalysis({ id: "an-1" }));
    await store.create(newAnalysis({ id: "an-2" }));
    await store.update("an-1", { evidence: [{ id: "file:x.ts", type: "file", text: "x", bytes: 1, truncated: false }] });
    await store.appendQuestion("an-1", question("q-1"));
    await store.appendQuestion("an-2", question("q-1"));

    expect(await store.delete("an-1")).toBe(true);
    expect(await store.get("an-1")).toBeUndefined();
    expect(await store.getEvidenceSource("an-1", "file:x.ts")).toBeUndefined();
    // The neighbour keeps its identically-named question.
    expect((await store.get("an-2"))?.questions).toHaveLength(1);

    // Deleting again is false rather than an error: the caller's goal is already met.
    expect(await store.delete("an-1")).toBe(false);
    await store.close();
  });
});

describe("SqliteAnalysisStore — a database it does not understand", () => {
  it("refuses a schema version newer than the build understands", async () => {
    const location = path.join(directory, "future.db");
    const raw = new DatabaseSync(location);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION + 1));
    raw.close();

    // Refusing is the safe direction. An older binary cannot know which columns it
    // is about to ignore, and ignoring one is how a store starts losing data.
    expect(() => new SqliteAnalysisStore({ location })).toThrow(StorageError);
  });

  it("refuses a schema version it cannot parse", () => {
    const location = path.join(directory, "garbled.db");
    const raw = new DatabaseSync(location);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', 'banana')").run();
    raw.close();

    expect(() => new SqliteAnalysisStore({ location })).toThrow(StorageError);
  });

  it("stamps its own schema version on a database it created", async () => {
    const location = path.join(directory, "fresh.db");
    const store = new SqliteAnalysisStore({ location });
    await store.close();

    const raw = new DatabaseSync(location);
    const found = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    raw.close();
    expect(found.value).toBe(String(SCHEMA_VERSION));
  });

  it("reads a row with an unrecognised status as failed", async () => {
    const location = path.join(directory, "odd.db");
    const store = new SqliteAnalysisStore({ location });
    await store.create(newAnalysis());
    await store.close();

    const raw = new DatabaseSync(location);
    raw.prepare("UPDATE analyses SET status = 'transcending' WHERE id = ?").run("an-1");
    raw.close();

    // Not `completed`, whatever else it might be. The safe reading of a status this
    // build does not know is the one that promises nothing about the payloads.
    const reopened = new SqliteAnalysisStore({ location });
    expect((await reopened.get("an-1"))?.status).toBe("failed");
    await reopened.close();
  });

  it("discards an unreadable payload without losing the record", async () => {
    const location = path.join(directory, "corrupt.db");
    const store = new SqliteAnalysisStore({ location });
    await store.create(newAnalysis());
    await store.update("an-1", { status: "completed", summary: "still here", report: report() });
    await store.close();

    const raw = new DatabaseSync(location);
    raw.prepare("UPDATE analyses SET report = '{not json' WHERE id = ?").run("an-1");
    raw.close();

    // One corrupt row costs that analysis its report, not the dashboard its list.
    const reopened = new SqliteAnalysisStore({ location });
    const record = await reopened.get("an-1");
    expect(record?.report).toBeNull();
    expect(record?.summary).toBe("still here");
    expect(await reopened.list()).toHaveLength(1);
    await reopened.close();
  });

  it("refuses every operation once closed", async () => {
    const store = memoryStore();
    await store.create(newAnalysis());
    await store.close();

    await expect(store.get("an-1")).rejects.toThrow(StorageError);
    await expect(store.list()).rejects.toThrow(StorageError);
    await expect(store.create(newAnalysis({ id: "an-2" }))).rejects.toThrow(StorageError);
    // Closing twice is not an error: shutdown paths run more than once.
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("returns undefined for an absent analysis rather than throwing", async () => {
    const store = memoryStore();
    expect(await store.get("an-absent")).toBeUndefined();
    await store.close();
  });
});

describe("resolveDatabaseLocation", () => {
  it("refuses to put the database inside the analysed workspace", () => {
    // The argument the function's comment makes: a database inside a repository is a
    // file that repository can see, `git status` can notice and `git clean` can delete.
    expect(() =>
      resolveDatabaseLocation({ explicit: path.join(directory, "analyses.db"), workspaceRoot: directory }),
    ).toThrow(StorageError);
  });

  it("refuses a nested path inside the workspace too", () => {
    expect(() =>
      resolveDatabaseLocation({ explicit: path.join(directory, "deep", "nest", "analyses.db"), workspaceRoot: directory }),
    ).toThrow(StorageError);
  });

  it("keeps the offending path out of the message and in the hint", () => {
    try {
      resolveDatabaseLocation({ explicit: path.join(directory, "analyses.db"), workspaceRoot: directory });
      expect.unreachable("expected a StorageError");
    } catch (error) {
      // The message reaches a browser; the hint reaches a terminal. A host path
      // belongs only in the second.
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).message).not.toContain(directory);
      expect((error as StorageError).hint).toContain(directory);
    }
  });

  it("allows a sibling directory whose name merely starts like the workspace", () => {
    const workspace = path.join(directory, "work");
    // `…/work-db` is not inside `…/work`, and a prefix comparison without the
    // separator would wrongly say it was.
    const resolved = resolveDatabaseLocation({
      explicit: path.join(directory, "work-db", "analyses.db"),
      workspaceRoot: workspace,
    });
    expect(resolved).toBe(path.join(directory, "work-db", "analyses.db"));
  });

  it("prefers an explicit path over the environment, and the environment over the default", () => {
    const outside = path.join(directory, "outside");
    const env = { [DATABASE_ENV_VAR]: path.join(outside, "from-env.db") };

    expect(resolveDatabaseLocation({ explicit: path.join(outside, "from-flag.db"), workspaceRoot: path.join(directory, "ws"), env })).toBe(
      path.join(outside, "from-flag.db"),
    );
    expect(resolveDatabaseLocation({ workspaceRoot: path.join(directory, "ws"), env })).toBe(path.join(outside, "from-env.db"));
  });

  it("defaults to a per-user database under the home directory", () => {
    const home = path.join(directory, "home");
    const resolved = resolveDatabaseLocation({ workspaceRoot: path.join(directory, "ws"), env: {}, homeDirectory: home });
    // One database per user, not one per workspace: it has to survive pointing the
    // server somewhere else tomorrow.
    expect(resolved).toBe(path.join(home, DEFAULT_DATABASE_DIRECTORY, DEFAULT_DATABASE_FILE));
  });

  it("treats an empty or blank setting as unset", () => {
    const home = path.join(directory, "home");
    const expected = path.join(home, DEFAULT_DATABASE_DIRECTORY, DEFAULT_DATABASE_FILE);
    expect(resolveDatabaseLocation({ explicit: "   ", workspaceRoot: path.join(directory, "ws"), env: {}, homeDirectory: home })).toBe(expected);
    expect(
      resolveDatabaseLocation({ workspaceRoot: path.join(directory, "ws"), env: { [DATABASE_ENV_VAR]: "" }, homeDirectory: home }),
    ).toBe(expected);
  });

  it("lets :memory: through, workspace or not", () => {
    // There is no file, so there is nothing for the containment rule to protect.
    expect(resolveDatabaseLocation({ explicit: MEMORY_DATABASE, workspaceRoot: directory })).toBe(MEMORY_DATABASE);
  });
});

describe("projectEvidence — what the store is allowed to keep", () => {
  it("keeps reconnaissance artefacts whether or not anything cites them", () => {
    const projected = projectEvidence(
      [source("tree", { type: "tree" }), source("README.md", { type: "readme" }), source("file:uncited.ts")],
      null,
    );

    // A question asked after a restart seeds its ledger from the reconnaissance
    // artefacts and nothing else, so those four have to survive regardless.
    expect(projected.map((entry) => entry.id)).toEqual(["tree", "README.md"]);
  });

  it("keeps a non-reconnaissance artefact exactly when a citation resolves to it", () => {
    const briefing = report();
    const projected = projectEvidence(
      [source("file:src/router.ts"), source("file:src/unread.ts")],
      briefing,
    );

    expect(projected.map((entry) => entry.id)).toEqual(["file:src/router.ts"]);
  });

  it("redacts on the way in, so a restart cannot change what an excerpt shows", () => {
    const secret = "AIzaSyDEADBEEFdeadbeef1234567890xx";
    const projected = projectEvidence([source("config.ts", { type: "readme", text: `const key = "${secret}";` })], null);

    expect(projected[0]?.text).not.toContain(secret);
    expect(projected[0]?.text).toContain("<redacted-api-key>");
  });

  it("recomputes bytes against the redacted text it actually stored", () => {
    const projected = projectEvidence(
      [source("README.md", { type: "readme", text: "AIzaSyDEADBEEFdeadbeef1234567890xx", bytes: 9_999 })],
      null,
    );

    // The stored number describes the stored text. The report's own `bytes` still
    // describes what was read, and the two are allowed to differ.
    expect(projected[0]?.bytes).toBe(Buffer.byteLength(projected[0]?.text ?? "", "utf8"));
    expect(projected[0]?.bytes).not.toBe(9_999);
  });

  it("keeps an artefact a question cited, not only one the briefing cited", () => {
    const cited = question("q-1", {
      citations: [
        { id: "q-1-ev-001", type: "file", source: "src/late.ts", sourceId: "file:src/late.ts", location: undefined, excerpt: undefined, supports: undefined },
      ],
    });

    const projected = projectEvidence([source("file:src/late.ts")], null, [cited]);
    expect(projected.map((entry) => entry.id)).toEqual(["file:src/late.ts"]);
  });

  it("ignores a citation that resolved to nothing", () => {
    const ungrounded = question("q-1", {
      citations: [
        { id: "q-1-ev-001", type: "file", source: "src/invented.ts", sourceId: null, location: undefined, excerpt: undefined, supports: undefined },
      ],
    });

    // A dropped citation has no `sourceId`, so it cannot pull bytes into the store.
    expect(projectEvidence([source("file:src/other.ts")], null, [ungrounded])).toEqual([]);
  });
});

describe("mergeQuestionEvidence", () => {
  it("adds what an answer cited and leaves what it merely read", () => {
    const answered = question("q-1", {
      citations: [
        { id: "q-1-ev-001", type: "file", source: "src/cited.ts", sourceId: "file:src/cited.ts", location: undefined, excerpt: undefined, supports: undefined },
      ],
    });

    const merged = mergeQuestionEvidence([], [source("file:src/cited.ts"), source("file:src/skimmed.ts")], answered);
    expect(merged.map((entry) => entry.id)).toEqual(["file:src/cited.ts"]);
  });

  it("never rewrites an id already in the store", () => {
    const stored: StoredEvidenceSource[] = [{ id: "file:src/cited.ts", type: "file", text: "as analysed", bytes: 11, truncated: false }];
    const answered = question("q-1", {
      citations: [
        { id: "q-1-ev-001", type: "file", source: "src/cited.ts", sourceId: "file:src/cited.ts", location: undefined, excerpt: undefined, supports: undefined },
      ],
    });

    const merged = mergeQuestionEvidence(stored, [source("file:src/cited.ts", { text: "edited since" })], answered);

    // The viewer has already computed line ranges against the stored text. Replacing
    // it with a fresh read would let a file edited since the analysis make a grounded
    // citation look wrong.
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("as analysed");
  });

  it("redacts what it adds", () => {
    const answered = question("q-1", {
      citations: [
        { id: "q-1-ev-001", type: "file", source: ".env", sourceId: "file:.env", location: undefined, excerpt: undefined, supports: undefined },
      ],
    });

    const merged = mergeQuestionEvidence([], [source("file:.env", { text: "GEMINI_API_KEY=abc123xyz" })], answered);
    expect(merged[0]?.text).not.toContain("abc123xyz");
  });
});

describe("toContextSources", () => {
  it("restores the shape the question loop and grounding expect", () => {
    const stored: StoredEvidenceSource[] = [{ id: "tree", type: "tree", text: "src/\n", bytes: 5, truncated: true }];
    expect(toContextSources(stored)).toEqual([{ id: "tree", type: "tree", text: "src/\n", bytes: 5, truncated: true }]);
  });
});
