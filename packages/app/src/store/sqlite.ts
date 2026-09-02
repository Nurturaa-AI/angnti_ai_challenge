import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { StorageError } from "@repo-arch/shared";
import type { AnalysisReport } from "../report";
import type { ArchitectureGraph } from "../architecture";
import type { AnsweredQuestionView } from "../questions";
import type { AnalysisSystem } from "../service";
import { ANALYSIS_STATUSES, MAX_STORED_QUESTIONS } from "./types";
import type {
  AnalysisPatch,
  AnalysisPhase,
  AnalysisRecord,
  AnalysisStatus,
  AnalysisStore,
  AnalysisSummary,
  NewAnalysis,
  StoredEvidenceSource,
} from "./types";

/**
 * The durable analysis store, on SQLite.
 *
 * `node:sqlite` ships with Node 22, so this adds no dependency at all — which is
 * what "prefer a minimal dependency" has to mean when the alternative is a
 * driver, a pool and a migration tool for a single-user local file. The module
 * is still marked experimental in Node 22 and prints one warning on import; that
 * is left visible rather than suppressed, because it is true.
 *
 * The binding is synchronous, so every method here completes without yielding
 * and the `async` is interface-shaped (see `AnalysisStore`). That is also what
 * makes concurrency inside one process trivial: two callers cannot interleave
 * inside a method, so the only concurrency to defend against is another process
 * on the same file, which WAL plus `busy_timeout` plus `BEGIN IMMEDIATE`
 * handles.
 */

/** Bumped when the schema changes in a way `migrate` has to know about. */
export const SCHEMA_VERSION = 1;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS analyses (
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
   )`,
  `CREATE TABLE IF NOT EXISTS evidence_sources (
     analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     source_id   TEXT NOT NULL,
     type        TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     truncated   INTEGER NOT NULL,
     text        TEXT NOT NULL,
     ordinal     INTEGER NOT NULL,
     PRIMARY KEY (analysis_id, source_id)
   )`,
  `CREATE TABLE IF NOT EXISTS questions (
     analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     question_id TEXT NOT NULL,
     asked_at    TEXT NOT NULL,
     ordinal     INTEGER NOT NULL,
     payload     TEXT NOT NULL,
     PRIMARY KEY (analysis_id, question_id)
   )`,
  `CREATE INDEX IF NOT EXISTS analyses_created_at ON analyses (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS questions_order ON questions (analysis_id, ordinal)`,
] as const;

/** An in-memory database. Real SQL semantics, nothing on disk. */
export const MEMORY_DATABASE = ":memory:";

export interface SqliteAnalysisStoreOptions {
  /** A file path, or `MEMORY_DATABASE`. Parent directories are created. */
  location: string;
  now?: (() => Date) | undefined;
  /** Per-analysis question history bound. */
  maxQuestions?: number | undefined;
}

interface AnalysisRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  phase: string | null;
  repository_path: string;
  repository_name: string;
  summary: string;
  error: string | null;
  system: string;
  provider: string;
  model: string;
  focus: string | null;
  duration_ms: number | null;
  report: string | null;
  graph: string | null;
}

export class SqliteAnalysisStore implements AnalysisStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly maxQuestions: number;
  private closed = false;

  constructor(options: SqliteAnalysisStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxQuestions = options.maxQuestions ?? MAX_STORED_QUESTIONS;
    this.db = openDatabase(options.location);
    try {
      this.initialize();
    } catch (error) {
      this.db.close();
      throw new StorageError(
        "The analysis database could not be initialised.",
        describeCause(error),
      );
    }
  }

  /**
   * Creates the schema if absent and refuses a database from the future.
   *
   * Refusing is the safe direction: an older binary opening a newer file cannot
   * know which columns it is about to ignore, and silently ignoring a column is
   * how a durable store starts losing data. An *older* file is upgraded in
   * place, which for version 1 means there is nothing to do.
   */
  private initialize(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.transaction(() => {
      for (const statement of SCHEMA) this.db.exec(statement);

      const found = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;

      if (found === undefined) {
        this.db
          .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
          .run(String(SCHEMA_VERSION));
        return;
      }

      const version = Number.parseInt(found.value, 10);
      if (!Number.isFinite(version) || version < 1) {
        throw new Error(`unreadable schema version ${JSON.stringify(found.value)}`);
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `database schema version ${version} is newer than this build understands (${SCHEMA_VERSION})`,
        );
      }
      // version < SCHEMA_VERSION: run the migrations between them. None yet.
      if (version < SCHEMA_VERSION) {
        this.db
          .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
          .run(String(SCHEMA_VERSION));
      }
    });
  }

  /**
   * Runs `body` inside `BEGIN IMMEDIATE`, rolling back on any throw.
   *
   * `IMMEDIATE` rather than the default deferred transaction: it takes the write
   * lock up front, so two processes contend at `BEGIN` where `busy_timeout` can
   * wait for them, instead of at the first write where SQLite would have to fail
   * an upgrade with SQLITE_BUSY.
   */
  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed rollback means the transaction was already gone. The original
        // error is the one worth reporting.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError("The analysis database is closed.");
  }

  async create(input: NewAnalysis): Promise<AnalysisRecord> {
    this.assertOpen();
    const timestamp = this.now().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO analyses
             (id, created_at, updated_at, status, phase, repository_path, repository_name,
              summary, error, system, provider, model, focus, duration_ms, report, graph)
           VALUES (?, ?, ?, 'queued', NULL, ?, ?, '', NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          input.id,
          timestamp,
          timestamp,
          input.repositoryPath,
          input.repositoryName,
          input.system,
          input.provider,
          input.model,
          input.focus ?? null,
        );
    } catch (error) {
      throw new StorageError("The analysis could not be recorded.", describeCause(error));
    }
    const created = await this.get(input.id);
    if (created === undefined) throw new StorageError("The analysis could not be recorded.");
    return created;
  }

  async get(id: string): Promise<AnalysisRecord | undefined> {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as
      | AnalysisRow
      | undefined;
    if (row === undefined) return undefined;

    const evidence = this.db
      .prepare(
        `SELECT source_id, type, bytes, truncated, text
           FROM evidence_sources WHERE analysis_id = ? ORDER BY ordinal`,
      )
      .all(id) as { source_id: string; type: string; bytes: number; truncated: number; text: string }[];

    const questions = this.db
      .prepare("SELECT payload FROM questions WHERE analysis_id = ? ORDER BY ordinal")
      .all(id) as { payload: string }[];

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: parseStatus(row.status),
      phase: row.phase as AnalysisPhase | null,
      repositoryPath: row.repository_path,
      repositoryName: row.repository_name,
      summary: row.summary,
      error: row.error,
      metadata: {
        system: row.system as AnalysisSystem,
        provider: row.provider,
        model: row.model,
        focus: row.focus,
        durationMs: row.duration_ms,
      },
      report: parseJson<AnalysisReport>(row.report, `analysis ${id} report`),
      graph: parseJson<ArchitectureGraph>(row.graph, `analysis ${id} graph`),
      evidence: evidence.map((source) => ({
        id: source.source_id,
        type: source.type as StoredEvidenceSource["type"],
        bytes: source.bytes,
        truncated: source.truncated === 1,
        text: source.text,
      })),
      questions: questions.flatMap((entry) => {
        const parsed = parseJson<AnsweredQuestionView>(entry.payload, `analysis ${id} question`);
        return parsed === null ? [] : [parsed];
      }),
    };
  }

  async list(options?: { limit?: number | undefined }): Promise<AnalysisSummary[]> {
    this.assertOpen();
    const limit = options?.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT a.id, a.created_at, a.updated_at, a.status, a.phase, a.repository_path,
                a.repository_name, a.summary, a.error, a.system, a.model,
                (SELECT COUNT(*) FROM questions q WHERE q.analysis_id = a.id) AS question_count
           FROM analyses a
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ?`,
      )
      .all(limit) as (Omit<AnalysisRow, "provider" | "focus" | "duration_ms" | "report" | "graph"> & {
      question_count: number;
    })[];

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: parseStatus(row.status),
      phase: row.phase as AnalysisPhase | null,
      repositoryPath: row.repository_path,
      repositoryName: row.repository_name,
      summary: row.summary,
      error: row.error,
      system: row.system as AnalysisSystem,
      model: row.model,
      questionCount: row.question_count,
    }));
  }

  async update(id: string, patch: AnalysisPatch): Promise<AnalysisRecord> {
    this.assertOpen();
    const timestamp = this.now().toISOString();

    try {
      this.transaction(() => {
        const exists = this.db.prepare("SELECT 1 FROM analyses WHERE id = ?").get(id);
        if (exists === undefined) throw new StorageError(`No analysis ${id}.`);

        const assignments: string[] = ["updated_at = ?"];
        const values: (string | number | null)[] = [timestamp];

        const set = (column: string, value: string | number | null): void => {
          assignments.push(`${column} = ?`);
          values.push(value);
        };

        if (patch.status !== undefined) set("status", patch.status);
        if (patch.phase !== undefined) set("phase", patch.phase);
        if (patch.summary !== undefined) set("summary", patch.summary);
        if (patch.error !== undefined) set("error", patch.error);
        if (patch.durationMs !== undefined) set("duration_ms", patch.durationMs);
        if (patch.report !== undefined) {
          set("report", patch.report === null ? null : JSON.stringify(patch.report));
        }
        if (patch.graph !== undefined) {
          set("graph", patch.graph === null ? null : JSON.stringify(patch.graph));
        }

        values.push(id);
        this.db
          .prepare(`UPDATE analyses SET ${assignments.join(", ")} WHERE id = ?`)
          .run(...values);

        if (patch.evidence !== undefined) {
          this.db.prepare("DELETE FROM evidence_sources WHERE analysis_id = ?").run(id);
          const insert = this.db.prepare(
            `INSERT INTO evidence_sources
               (analysis_id, source_id, type, bytes, truncated, text, ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
          patch.evidence.forEach((source, index) => {
            insert.run(
              id,
              source.id,
              source.type,
              source.bytes,
              source.truncated ? 1 : 0,
              source.text,
              index,
            );
          });
        }
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("The analysis could not be updated.", describeCause(error));
    }

    const updated = await this.get(id);
    if (updated === undefined) throw new StorageError(`No analysis ${id}.`);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    try {
      return this.transaction(() => {
        // The foreign keys cascade, but the deletes are explicit so that the
        // guarantee holds even on a database opened without `foreign_keys = ON`
        // — which is what an older file, or a future caller, might hand us.
        this.db.prepare("DELETE FROM evidence_sources WHERE analysis_id = ?").run(id);
        this.db.prepare("DELETE FROM questions WHERE analysis_id = ?").run(id);
        const result = this.db.prepare("DELETE FROM analyses WHERE id = ?").run(id);
        return Number(result.changes) > 0;
      });
    } catch (error) {
      throw new StorageError("The analysis could not be deleted.", describeCause(error));
    }
  }

  async appendQuestion(analysisId: string, question: AnsweredQuestionView): Promise<void> {
    this.assertOpen();
    const timestamp = this.now().toISOString();
    try {
      this.transaction(() => {
        const exists = this.db.prepare("SELECT 1 FROM analyses WHERE id = ?").get(analysisId);
        if (exists === undefined) throw new StorageError(`No analysis ${analysisId}.`);

        const next = this.db
          .prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM questions WHERE analysis_id = ?")
          .get(analysisId) as { next: number };

        this.db
          .prepare(
            `INSERT INTO questions (analysis_id, question_id, asked_at, ordinal, payload)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (analysis_id, question_id)
             DO UPDATE SET asked_at = excluded.asked_at, payload = excluded.payload`,
          )
          .run(analysisId, question.id, question.askedAt, next.next, JSON.stringify(question));

        // Bounded history: drop the oldest beyond the bound. The bound is per
        // analysis, so a chatty analysis cannot evict another one's history.
        this.db
          .prepare(
            `DELETE FROM questions
              WHERE analysis_id = ?
                AND question_id NOT IN (
                  SELECT question_id FROM questions WHERE analysis_id = ?
                   ORDER BY ordinal DESC LIMIT ?
                )`,
          )
          .run(analysisId, analysisId, this.maxQuestions);

        this.db.prepare("UPDATE analyses SET updated_at = ? WHERE id = ?").run(timestamp, analysisId);
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("The answer could not be recorded.", describeCause(error));
    }
  }

  async getEvidenceSource(
    analysisId: string,
    sourceId: string,
  ): Promise<StoredEvidenceSource | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT source_id, type, bytes, truncated, text
           FROM evidence_sources WHERE analysis_id = ? AND source_id = ?`,
      )
      .get(analysisId, sourceId) as
      | { source_id: string; type: string; bytes: number; truncated: number; text: string }
      | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.source_id,
      type: row.type as StoredEvidenceSource["type"],
      bytes: row.bytes,
      truncated: row.truncated === 1,
      text: row.text,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Opens the database file, creating its directory.
 *
 * Every failure here becomes a `StorageError` with the path in the *hint* rather
 * than the message, because the message reaches a browser and the hint does not.
 */
function openDatabase(location: string): DatabaseSync {
  if (location !== MEMORY_DATABASE) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
    } catch (error) {
      throw new StorageError(
        "The analysis database directory could not be created.",
        `${path.dirname(path.resolve(location))}: ${describeCause(error)}`,
      );
    }
  }
  try {
    return new DatabaseSync(location);
  } catch (error) {
    throw new StorageError("The analysis database could not be opened.", describeCause(error));
  }
}

function parseStatus(value: string): AnalysisStatus {
  const found = ANALYSIS_STATUSES.find((status) => status === value);
  // A row with an unrecognised status is a database written by something else.
  // Reporting it as failed is the safe reading: it is certainly not completed.
  return found ?? "failed";
}

/**
 * Parses a JSON column, treating malformed content as absent.
 *
 * A single corrupt row should cost that analysis its payload, not the whole
 * list view. The caller sees `null`, which every consumer already handles
 * because a queued analysis has no report either.
 */
function parseJson<T>(value: string | null, what: string): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    process.emitWarning(`Discarding unreadable stored ${what}.`);
    return null;
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
