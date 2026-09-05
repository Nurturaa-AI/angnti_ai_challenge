import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageError } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SqliteAnalysisStore } from "../src/store/sqlite";

/**
 * Opening a database written by an earlier build.
 *
 * Iteration 6 added two identity columns — `system_version` and `provenance` — and
 * the constraint on that change was that it must not break a file that already
 * exists. That is not a claim a unit test on the current schema can make: a store
 * opening a database it created a millisecond ago will pass whatever the migration
 * does, because both halves come from the same code.
 *
 * So these tests write a *version 1 database by hand*, using the version 1 DDL
 * copied literally below, and then open it with the current store. The duplication
 * is the point. If someone edits `SCHEMA` in `sqlite.ts` and the migration keeps
 * passing, it is because the migration genuinely handles the old shape — not
 * because the test moved with the code.
 *
 * What these tests deliberately do *not* do is assert a backfilled value. A row
 * written by version 1 does not record which build produced it or where the run
 * came from, and inventing a plausible answer at migration time would be
 * fabricating provenance. `null` is the correct reading, and it is asserted as
 * such.
 */

/**
 * The `analyses` table exactly as schema version 1 declared it.
 *
 * Frozen text. Do not update this to match a later schema; that would delete the
 * only record of what the migration has to cope with.
 */
const V1_ANALYSES = `CREATE TABLE analyses (
   id              TEXT PRIMARY KEY,
   created_at      TEXT NOT NULL,
   updated_at      TEXT NOT NULL,
   status          TEXT NOT NULL,
   phase           TEXT,
   repository_path TEXT NOT NULL,
   repository_name TEXT NOT NULL,
   summary         TEXT NOT NULL DEFAULT '',
   error           TEXT,
   system          TEXT NOT NULL,
   provider        TEXT NOT NULL,
   model           TEXT NOT NULL,
   focus           TEXT,
   duration_ms     INTEGER,
   report          TEXT,
   graph           TEXT
 )`;

const V1_REST = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE evidence_sources (
     analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     source_id   TEXT NOT NULL,
     type        TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     truncated   INTEGER NOT NULL,
     text        TEXT NOT NULL,
     ordinal     INTEGER NOT NULL,
     PRIMARY KEY (analysis_id, source_id)
   )`,
  `CREATE TABLE questions (
     analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     question_id TEXT NOT NULL,
     asked_at    TEXT NOT NULL,
     ordinal     INTEGER NOT NULL,
     payload     TEXT NOT NULL,
     PRIMARY KEY (analysis_id, question_id)
   )`,
] as const;

let databaseDirectory: string;
let opened: SqliteAnalysisStore[] = [];

function databaseFile(): string {
  return path.join(databaseDirectory, "analyses.db");
}

function openStore(): SqliteAnalysisStore {
  const store = new SqliteAnalysisStore({ location: databaseFile() });
  opened.push(store);
  return store;
}

/** Reads the raw file, outside the store, to check what is actually on disk. */
function inspect<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile());
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Writes a schema-version-1 database holding one completed analysis.
 *
 * The row carries a report and an evidence source as well, because a migration
 * that preserved the `analyses` row but lost its children would still be a
 * migration that lost data.
 */
function writeVersion1Database(): void {
  const db = new DatabaseSync(databaseFile());
  try {
    db.exec(V1_ANALYSES);
    for (const statement of V1_REST) db.exec(statement);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    db.prepare(
      `INSERT INTO analyses
         (id, created_at, updated_at, status, phase, repository_path, repository_name,
          summary, error, system, provider, model, focus, duration_ms, report, graph)
       VALUES (?, ?, ?, 'completed', NULL, ?, ?, ?, NULL, 'advanced', 'mock', 'test-model',
               NULL, 1234, ?, NULL)`,
    ).run(
      "an-legacy-1",
      "2026-01-02T03:04:05.000Z",
      "2026-01-02T03:04:06.000Z",
      "widget",
      "widget",
      "A dispatcher with one entry point.",
      JSON.stringify({ summary: "A dispatcher with one entry point." }),
    );
    db.prepare(
      `INSERT INTO evidence_sources (analysis_id, source_id, type, bytes, truncated, text, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("an-legacy-1", "src/dispatch.js", "file", 42, 0, "export function dispatch() {}", 0);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  databaseDirectory = mkdtempSync(path.join(tmpdir(), "repo-arch-migrate-"));
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

describe("opening a schema version 1 database", () => {
  it("is a database the current build did not write", () => {
    writeVersion1Database();

    // Guards the premise of every test below. If this ever fails, the hand-written
    // DDL has drifted into the current shape and the migration is untested.
    const columns = inspect((db) =>
      (db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map((row) => row.name),
    );
    expect(columns).not.toContain("system_version");
    expect(columns).not.toContain("provenance");
    expect(SCHEMA_VERSION).toBeGreaterThan(1);
  });

  it("adds the identity columns and records the new schema version", async () => {
    writeVersion1Database();

    const store = openStore();
    await store.close();

    const state = inspect((db) => ({
      columns: (db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map(
        (row) => row.name,
      ),
      version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value,
    }));

    expect(state.columns).toContain("system_version");
    expect(state.columns).toContain("provenance");
    expect(state.version).toBe(String(SCHEMA_VERSION));
  });

  it("still reads the analysis that was already there", async () => {
    writeVersion1Database();

    const store = openStore();
    const record = await store.get("an-legacy-1");

    // The whole point of the migration: an existing analysis is still an analysis.
    expect(record).toBeDefined();
    expect(record?.status).toBe("completed");
    expect(record?.repositoryName).toBe("widget");
    expect(record?.summary).toBe("A dispatcher with one entry point.");
    expect(record?.metadata.system).toBe("advanced");
    expect(record?.metadata.model).toBe("test-model");
    expect(record?.metadata.durationMs).toBe(1234);
    expect(record?.report).not.toBeNull();
    expect(record?.evidence).toHaveLength(1);
    expect(record?.evidence[0]?.id).toBe("src/dispatch.js");
  });

  it("reports the identities of a pre-migration row as unrecorded, not as a guess", async () => {
    writeVersion1Database();

    const store = openStore();
    const record = await store.get("an-legacy-1");

    // `null` because the row genuinely does not know. Backfilling the running
    // build's version here would claim this analysis was produced by code that did
    // not exist when it ran, and backfilling a provenance label would invent a
    // fact about where the run came from.
    expect(record?.metadata.systemVersion).toBeNull();
    expect(record?.metadata.provenance).toBeNull();
  });

  it("records both identities on an analysis created after the migration", async () => {
    writeVersion1Database();

    const store = openStore();
    await store.create({
      id: "an-new-1",
      repositoryPath: "widget",
      repositoryName: "widget",
      system: "advanced",
      systemVersion: "9.9.9",
      provenance: "iteration-6-test",
      provider: "mock",
      model: "test-model",
    });

    const created = await store.get("an-new-1");
    expect(created?.metadata.systemVersion).toBe("9.9.9");
    expect(created?.metadata.provenance).toBe("iteration-6-test");

    // And the old row is untouched by the new one's arrival.
    const legacy = await store.get("an-legacy-1");
    expect(legacy?.metadata.provenance).toBeNull();
  });

  it("is idempotent across repeated opens", async () => {
    writeVersion1Database();

    // Three separate stores over the same file. `ALTER TABLE ADD COLUMN` has no
    // `IF NOT EXISTS` in SQLite, so a migration that did not check would throw on
    // the second open — and an upgrade that cannot be run twice is one nobody dares
    // run at all.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = openStore();
      const record = await store.get("an-legacy-1");
      expect(record?.id).toBe("an-legacy-1");
      await store.close();
    }
  });

  it("preserves the row through a migration that happens under a transaction", async () => {
    writeVersion1Database();

    // The version bump and the column additions are in one transaction, so there is
    // no observable state where the file claims version 2 without the columns.
    const store = openStore();
    await store.close();

    const mismatch = inspect((db) => {
      const version = Number(
        (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
          value: string;
        }).value,
      );
      const columns = (db.prepare("PRAGMA table_info(analyses)").all() as { name: string }[]).map(
        (row) => row.name,
      );
      return version >= 2 && !columns.includes("provenance");
    });
    expect(mismatch).toBe(false);
  });
});

describe("opening a database from the future", () => {
  it("refuses rather than silently ignoring columns it does not know about", () => {
    writeVersion1Database();
    const db = new DatabaseSync(databaseFile());
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();

    // Refusing is the safe direction, and it stays the safe direction now that
    // migrations exist: a build that cannot name the columns it is ignoring cannot
    // promise not to lose them.
    expect(() => openStore()).toThrow(StorageError);
  });
});
