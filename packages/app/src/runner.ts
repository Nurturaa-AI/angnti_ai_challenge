import { randomUUID } from "node:crypto";
import { RequestError, type AnalysisConfig, type CollectOptions, type ExplorationBudget, type LlmClient, type PrecisionPolicy } from "@repo-arch/shared";
import { buildArchitectureGraph } from "./architecture";
import { AnalysisEventBus, PHASE_MESSAGES, logFailureMessage, safeFailureMessage } from "./lifecycle";
import { buildAnalysisReport, type AnalysisReport } from "./report";
import { analyzeRepository, DEFAULT_ANALYSIS_SYSTEM, systemSupportsFocus, type AnalysisSystem } from "./service";
import { projectEvidence } from "./store/projection";
import { AnalysisNotFoundError } from "./store/types";
import type { AnalysisPhase, AnalysisRecord, AnalysisStore } from "./store/types";
import { resolveRepositoryRequest } from "./workspace";

/**
 * The lifecycle of one analysis, from a request to a durable record.
 *
 * This is the only writer of analysis status, and that is the point. Iteration 4
 * ran the pipeline inline inside a request handler, which made "the analysis
 * succeeded" and "the client is still connected" the same fact. Separating them
 * costs one indirection and buys three things the product needs: a record that
 * exists before the work does (so a client that disconnects has not lost its
 * analysis), a status a second client can read, and a single place where failure
 * is turned into something safe to show.
 *
 * It deliberately does not queue, retry or schedule. One analysis per call, run
 * immediately, on this process. A queue would be the right answer to a problem
 * this product does not have — it serves one user on loopback — and the wrong
 * kind of complexity to add speculatively.
 */

/**
 * What a caller is told when its analysis was deleted while it was running.
 *
 * Safe by construction — it names no path, no provider and no internal state —
 * and it is the truth: nothing failed, someone removed the record on purpose.
 */
const DELETED_WHILE_RUNNING = "The analysis was deleted while it was running.";

export interface AnalysisRunnerDependencies {
  store: AnalysisStore;
  events: AnalysisEventBus;
  /** The workspace root every repository request is resolved against. */
  workspaceRoot: string;
  config: AnalysisConfig;
  client?: LlmClient | undefined;
  budget?: ExplorationBudget | undefined;
  precisionPolicy?: PrecisionPolicy | undefined;
  collectOptions?: CollectOptions | undefined;
  now?: (() => Date) | undefined;
  /** Where an unexpected failure is reported in full. Defaults to stderr. */
  logError?: ((message: string) => void) | undefined;
}

export interface StartAnalysisRequest {
  /** As the client wrote it: workspace-relative, unvalidated. */
  repository: string;
  system?: string | undefined;
  focus?: string | undefined;
}

export interface StartedAnalysis {
  /** The `queued` record, already durable. */
  record: AnalysisRecord;
  /**
   * Resolves when the analysis reaches a terminal state.
   *
   * Never rejects: a failure is a `failed` record, not an exception, because by
   * the time the pipeline runs the client that asked may be gone. A caller that
   * wants the synchronous behaviour awaits this and re-reads the record; one that
   * wants progress ignores it and subscribes to the event stream.
   */
  completion: Promise<AnalysisRecord>;
}

/**
 * The in-flight ledgers, by analysis id.
 *
 * A question needs the evidence *with its text*, and after a restart that comes
 * from the store. While the process is up it comes from here instead — not as a
 * cache, but because the two can differ: the store holds the redacted projection
 * and a freshly finished run holds the raw ledger, and questions asked in the
 * same process as the analysis should behave exactly like questions asked after a
 * restart. So this holds the *projected* evidence too, and the only thing it
 * saves is a database read.
 */
export class AnalysisRunner {
  private readonly now: () => Date;
  private readonly logError: (message: string) => void;
  private nextId = 1;
  /**
   * Identifies this runner, so the counter beside it only has to be unique within
   * one. A timestamp alone was not enough: two runners constructed in the same
   * millisecond — two workers starting together, two harnesses in one test — got
   * the same prefix and then the same ids, which a durable store cannot tolerate.
   * Four random characters close that without lengthening the id much, and without
   * a dependency. They join the timestamp inside one opaque segment rather than
   * adding a third, because the id's shape — one slug then a counter — is what
   * callers and the API surface already treat as the contract.
   */
  private readonly idPrefix: string;
  /** Analyses this runner is executing right now. */
  private readonly live = new Set<string>();
  /** Of those, the ones whose record has stopped existing under them. */
  private readonly abandoned = new Set<string>();

  constructor(private readonly dependencies: AnalysisRunnerDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date());
    this.logError = dependencies.logError ?? ((message: string): void => console.error(message));
    this.idPrefix = `${this.now().getTime().toString(36)}${randomUUID().slice(0, 4)}`;
  }

  /** True while this runner is executing the analysis. */
  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * Stops persisting an analysis, because its record is about to stop existing.
   *
   * A run outlives the request that started it, so a delete is the one thing that
   * can pull a record out from under work that is still going. Whoever removes a
   * record must say so here *first*: the run then stops writing at its next
   * boundary and discards its result, instead of failing once per phase against a
   * row that is gone and finishing with a failure it cannot record either.
   *
   * Cooperative on purpose. The pipeline itself is not interrupted — that would
   * mean reaching into the measured analysis path — so an already-issued model
   * call still finishes; only its persistence stops. Returns `true` if an
   * analysis was in fact running, which lets a caller tell "deleted a finished
   * record" from "cancelled a running one".
   */
  abandon(id: string): boolean {
    if (!this.live.has(id)) return false;
    this.abandoned.add(id);
    return true;
  }

  /**
   * Creates the record, then starts the work.
   *
   * The validation that happens *before* the record exists is deliberately
   * minimal: the system name and the focus/system pairing, both of which are
   * request errors the client should fix rather than analysis failures worth
   * remembering. The repository path is validated *after*, under `validating`,
   * because "that directory is not in the workspace" is a result the user should
   * be able to see in the list rather than a 400 that vanishes on reload.
   */
  async start(request: StartAnalysisRequest): Promise<StartedAnalysis> {
    const system = (request.system ?? DEFAULT_ANALYSIS_SYSTEM) as AnalysisSystem;
    if (request.focus !== undefined && !systemSupportsFocus(system)) {
      throw new RequestError(
        `A scout focus is only available to the "advanced" system, not "${system}".`,
        "The baseline makes one call over shallow context and does not search.",
      );
    }

    const id = this.mintId();
    const record = await this.dependencies.store.create({
      id,
      // Stored as requested and re-resolved on use. A record that holds a
      // relative path can be opened by a process started somewhere else; one
      // that holds an absolute path is a note about this machine.
      repositoryPath: normalizeRequestedPath(request.repository),
      repositoryName: repositoryNameOf(request.repository, this.dependencies.workspaceRoot),
      system,
      provider: this.dependencies.config.provider,
      model: this.dependencies.config.model,
      focus: request.focus,
    });

    this.dependencies.events.emit({
      type: "analysis.created",
      analysisId: id,
      at: record.createdAt,
      repositoryPath: record.repositoryPath,
      status: record.status,
    });

    this.live.add(id);
    return { record, completion: this.run(record) };
  }

  /** Runs the pipeline for an existing `queued` record. Never rejects. */
  private async run(created: AnalysisRecord): Promise<AnalysisRecord> {
    const id = created.id;
    const startedMs = Date.parse(created.createdAt);

    try {
      if (this.abandoned.has(id)) return this.discard(created);
      await this.dependencies.store.update(id, { status: "validating" });
      this.dependencies.events.emit({
        type: "analysis.started",
        analysisId: id,
        at: this.now().toISOString(),
        status: "validating",
      });

      // The boundary, once, here. Everything downstream gets an absolute path it
      // did not construct — including the question path, which re-resolves the
      // same stored relative path through the same function.
      const resolved = resolveRepositoryRequest(
        this.dependencies.workspaceRoot,
        created.repositoryPath,
      );

      if (this.abandoned.has(id)) return this.discard(created);
      await this.dependencies.store.update(id, { status: "analyzing" });

      const run = await analyzeRepository({
        repositoryPath: resolved.absolute,
        system: created.metadata.system,
        config: this.dependencies.config,
        client: this.dependencies.client,
        budget: this.dependencies.budget,
        precisionPolicy: this.dependencies.precisionPolicy,
        collectOptions: this.dependencies.collectOptions,
        focus: created.metadata.focus ?? undefined,
        onPhase: (phase) => {
          void this.recordPhase(id, phase);
        },
      });

      // The record may have gone while the pipeline ran. It is not recreated: a
      // delete asked for this analysis to stop existing, and resurrecting the row
      // here would be the runner overruling the person who deleted it.
      if (this.abandoned.has(id)) return this.discard(created);

      await this.recordPhase(id, "building-report");
      // The caller named this repository *inside the workspace*, so that is the path
      // the report carries. `collectRepositoryContext` records a path relative to the
      // process's own working directory, which is portable for a CLI run — the user
      // typed it — but for a served workspace it describes a machine the caller cannot
      // see, and when the workspace sits outside the process tree it cannot stay
      // relative at all. `widget` is both more useful to a reader and less revealing
      // than `/srv/repos/widget` or `../../../tmp/xyz/workspace/widget`.
      //
      // This is the same rewrite Iteration 4 did in its analyse route. It moved here
      // because the runner is now the only thing that builds a report for the web, and
      // a rewrite that lives in one route is a rewrite the next route forgets.
      const analysed = buildAnalysisReport(run);
      const report: AnalysisReport = {
        ...analysed,
        repository: {
          ...analysed.repository,
          path: resolved.relative === "" ? "." : resolved.relative,
        },
      };
      const graph = buildArchitectureGraph(report);

      const completed = await this.dependencies.store.update(id, {
        status: "completed",
        phase: null,
        summary: report.summary,
        error: null,
        durationMs: Number.isFinite(startedMs) ? this.now().getTime() - startedMs : null,
        report,
        graph,
        evidence: projectEvidence(run.sources, report),
      });

      this.dependencies.events.emit({
        type: "analysis.completed",
        analysisId: id,
        at: completed.updatedAt,
        durationMs: completed.metadata.durationMs ?? 0,
      });
      return completed;
    } catch (error) {
      // A record that no longer exists is not a failed analysis. There is nothing
      // to write the failure to, nobody left watching it, and "failed" would be a
      // claim about a row that is gone.
      const gone = this.abandoned.has(id) || this.observeDeletion(id, error);
      if (gone && error instanceof AnalysisNotFoundError) return this.discard(created);

      // Everything in full to the operator's log; one safe sentence to the record.
      this.logError(`analysis ${id} failed: ${logFailureMessage(error)}`);
      const message = safeFailureMessage(error);
      if (gone) return this.discard(created);

      try {
        const failed = await this.dependencies.store.update(id, {
          status: "failed",
          phase: null,
          error: message,
          durationMs: Number.isFinite(startedMs) ? this.now().getTime() - startedMs : null,
        });
        this.dependencies.events.emit({
          type: "analysis.failed",
          analysisId: id,
          at: failed.updatedAt,
          error: message,
        });
        return failed;
      } catch (storeError) {
        // Deleted between the failure and the attempt to record it: the delete wins.
        if (this.observeDeletion(id, storeError)) return this.discard(created);
        // The store is gone as well. Report the progress event anyway, so a
        // watching client stops waiting, and hand back what we last knew.
        this.logError(`analysis ${id} could not be marked failed: ${logFailureMessage(storeError)}`);
        this.dependencies.events.emit({
          type: "analysis.failed",
          analysisId: id,
          at: this.now().toISOString(),
          error: message,
        });
        return { ...created, status: "failed", error: message };
      }
    } finally {
      this.live.delete(id);
      this.abandoned.delete(id);
    }
  }

  /**
   * Notices that the record has been destroyed, and remembers it.
   *
   * Remembering is the point: without it a run whose row vanished mid-pipeline
   * fails once per remaining phase, then once more at the end, then once again
   * trying to record *that* — the seven-line log this fixed. One observation
   * stops all of them.
   */
  private observeDeletion(id: string, error: unknown): boolean {
    if (!(error instanceof AnalysisNotFoundError) || error.analysisId !== id) return false;
    this.abandoned.add(id);
    return true;
  }

  /**
   * The terminal outcome of a run whose record was deleted underneath it.
   *
   * Nothing is written, because there is nowhere to write it. The returned record
   * is the last state this runner knew, marked failed so that a caller awaiting
   * `completion` — the synchronous alias — gets an answer rather than a report
   * about a repository the user has already thrown away.
   */
  private discard(created: AnalysisRecord): AnalysisRecord {
    this.logError(`analysis ${created.id} was deleted while it was running; its result was discarded.`);
    return { ...created, status: "failed", error: DELETED_WHILE_RUNNING };
  }

  /** Persists the phase and announces it. A failed write must not fail the run. */
  private async recordPhase(id: string, phase: AnalysisPhase): Promise<void> {
    // A deleted analysis has no progress to report and no row to report it in.
    if (this.abandoned.has(id)) return;
    this.dependencies.events.emit({
      type: "analysis.phase",
      analysisId: id,
      at: this.now().toISOString(),
      phase,
      message: PHASE_MESSAGES[phase],
    });
    try {
      await this.dependencies.store.update(id, { phase });
    } catch (error) {
      // The run's own boundary check reports the deletion once, in one place.
      if (this.observeDeletion(id, error)) return;
      this.logError(`analysis ${id} phase ${phase} not recorded: ${logFailureMessage(error)}`);
    }
  }

  /**
   * `an-1`, `an-2`, …, prefixed by an identifier for this runner.
   *
   * Ids have to be unique across restarts now that the store is durable, and they
   * have to stay short enough to appear in a URL a person reads. The prefix is
   * where uniqueness comes from and the counter only orders within one runner, so
   * two runners started in the same millisecond mint different ids.
   */
  private mintId(): string {
    return `an-${this.idPrefix}-${this.nextId++}`;
  }
}

/** Empty, `.` and `./x` all mean the same workspace-relative thing. */
function normalizeRequestedPath(requested: string): string {
  const trimmed = requested.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  return trimmed === "." ? "" : trimmed;
}

/** The last segment, or the workspace's own name for the root itself. */
function repositoryNameOf(requested: string, workspaceRoot: string): string {
  const normalized = normalizeRequestedPath(requested);
  if (normalized === "") {
    const segments = workspaceRoot.split(/[/\\]/).filter((segment) => segment !== "");
    return segments[segments.length - 1] ?? "workspace";
  }
  const segments = normalized.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? normalized;
}
