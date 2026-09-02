import { RequestError, type AnalysisConfig, type CollectOptions, type ExplorationBudget, type LlmClient, type PrecisionPolicy } from "@repo-arch/shared";
import { buildArchitectureGraph } from "./architecture";
import { AnalysisEventBus, PHASE_MESSAGES, logFailureMessage, safeFailureMessage } from "./lifecycle";
import { buildAnalysisReport, type AnalysisReport } from "./report";
import { analyzeRepository, DEFAULT_ANALYSIS_SYSTEM, systemSupportsFocus, type AnalysisSystem } from "./service";
import { projectEvidence } from "./store/projection";
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

  constructor(private readonly dependencies: AnalysisRunnerDependencies) {
    this.now = dependencies.now ?? ((): Date => new Date());
    this.logError = dependencies.logError ?? ((message: string): void => console.error(message));
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

    return { record, completion: this.run(record) };
  }

  /** Runs the pipeline for an existing `queued` record. Never rejects. */
  private async run(created: AnalysisRecord): Promise<AnalysisRecord> {
    const id = created.id;
    const startedMs = Date.parse(created.createdAt);

    try {
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
      // Everything in full to the operator's log; one safe sentence to the record.
      this.logError(`analysis ${id} failed: ${logFailureMessage(error)}`);
      const message = safeFailureMessage(error);

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
    }
  }

  /** Persists the phase and announces it. A failed write must not fail the run. */
  private async recordPhase(id: string, phase: AnalysisPhase): Promise<void> {
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
      this.logError(`analysis ${id} phase ${phase} not recorded: ${logFailureMessage(error)}`);
    }
  }

  /**
   * `an-1`, `an-2`, …, with the process start time as a prefix.
   *
   * Ids have to be unique across restarts now that the store is durable, and they
   * have to stay short enough to appear in a URL a person reads. A timestamp plus
   * a counter gives both without a dependency: unique unless two processes start
   * in the same millisecond, and sortable by accident rather than by promise.
   */
  private mintId(): string {
    return `an-${this.now().getTime().toString(36)}-${this.nextId++}`;
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
