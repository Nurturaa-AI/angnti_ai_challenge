import { readdirSync } from "node:fs";
import path from "node:path";
import {
  ANALYSIS_SYSTEMS,
  AnalysisEventBus,
  AnalysisRunner,
  DEFAULT_ANALYSIS_SYSTEM,
  DEFAULT_QUESTION_BUDGET,
  MAX_QUESTION_CHARS,
  ObservabilityRecorder,
  PdfReportExporter,
  answerQuestion,
  isTerminal,
  mergeQuestionEvidence,
  questionView,
  resolveRepositoryRequest,
  systemSupportsFocus,
  toContextSources,
  type AnalysisRecord,
  type AnalysisStore,
  type ReportExporter,
} from "@repo-arch/app";
import {
  IGNORED_DIRECTORIES,
  RequestError,
  createLlmClient,
  statOrNull,
  type AnalysisConfig,
  type ExplorationBudget,
  type LlmClient,
  type PrecisionPolicy,
} from "@repo-arch/shared";
import { z } from "zod";
import { jsonResponse, type ApiHandler, type ApiRequest, type ApiResponse } from "./api";
import { analysisDetailDto, analysisSummaryDto, evidenceViewDto, findCitation } from "./dto";

/**
 * The API.
 *
 * Hand-dispatched. A router dependency would be more code than this and would still
 * need every one of the checks below, which are the parts that matter:
 *
 *   - a request body is parsed by a schema before anything reads a field from it,
 *   - a repository path crosses `resolveRepositoryRequest` before anything opens it,
 *   - an analysis id is looked up rather than trusted,
 *   - every evidence lookup carries the analysis id as well as the evidence id,
 *   - nothing in a response is assembled from a path the caller supplied,
 *   - every response body is built by a named DTO function in `dto.ts`.
 *
 * The routes orchestrate; they contain no analysis logic. Everything they call lives in
 * `@repo-arch/app`, which is the same code the CLI runs.
 *
 * **Route naming.** Iteration 5 canonicalises on the plural, resource-shaped forms —
 * `/api/analyses`, `/api/analyses/:id`, `/api/analyses/:id/questions`. Iteration 4's
 * singular `/api/analysis/:id`, `/api/analyze` and `/api/questions` are kept as
 * permanent aliases rather than removed. That is not indecision: those forms are what
 * Iteration 4's forty-five API tests exercise, and keeping them passing *unmodified* is
 * the strongest available evidence that this iteration changed the product's shape
 * without changing its behaviour.
 */

/** Entries returned by the repository picker. */
const MAX_REPOSITORY_ENTRIES = 200;
/** How often an idle event stream writes a keep-alive comment. */
const STREAM_HEARTBEAT_MS = 15_000;

export interface ApiDependencies {
  /** Absolute path. Every repository a request may name lives inside it. */
  workspaceRoot: string;
  config: AnalysisConfig;
  budget: ExplorationBudget;
  precisionPolicy: PrecisionPolicy;
  /** The durable store. Required: there is no in-memory fallback any more. */
  store: AnalysisStore;
  /** Defaults to a client built from `config`; injected by tests. */
  client?: LlmClient | undefined;
  exporter?: ReportExporter | undefined;
  metrics?: ObservabilityRecorder | undefined;
  events?: AnalysisEventBus | undefined;
  /** Bounds a question's own exploration. Separate from the analysis budget. */
  questionBudget?: ExplorationBudget | undefined;
  /**
   * Where runs served by this API originated. Defaults to
   * `REPO_ARCHAEOLOGIST_PROVENANCE`, then to `unlabelled`.
   *
   * Recorded on every analysis and published on the detail view, so that a report
   * read months later still says where it came from. Validated in the runner's
   * constructor, which is what stops a mistyped value from becoming a stored row.
   */
  provenance?: string | undefined;
  now?: (() => Date) | undefined;
  /** Where an unexpected failure is reported in full. Defaults to stderr. */
  logError?: ((message: string) => void) | undefined;
}

export interface WebApi {
  handle: ApiHandler;
  store: AnalysisStore;
  metrics: ObservabilityRecorder;
  events: AnalysisEventBus;
  /**
   * Resolves when every analysis started through this API has finished.
   *
   * Tests and a graceful shutdown both need it: an analysis now outlives the
   * request that started it, so "the response arrived" no longer means "the work
   * is done" and something has to be able to wait.
   */
  idle: () => Promise<void>;
}

const AnalyzeRequestSchema = z.strictObject({
  /** Workspace-relative path. `"."` is the workspace root. */
  repository: z.string().min(1).max(1024),
  system: z.string().min(1).max(64).optional(),
  /** Aims the evidence scout. Advanced only; see the note in `analyzeRepository`. */
  focus: z.string().min(1).max(500).optional(),
});

/** The legacy body, which names the analysis inside the body rather than the path. */
const QuestionRequestSchema = z.strictObject({
  analysisId: z.string().min(1).max(200),
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
});

/** The canonical body: the analysis is in the path, so it is not in the body. */
const ScopedQuestionRequestSchema = z.strictObject({
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
});

/**
 * What an analysis id may look like.
 *
 * Checked before the store sees it, so a malformed id is a 400 with a stable
 * message rather than a query that happens to return nothing. The store is
 * parameterised and would be safe either way; this is about giving the caller an
 * answer that distinguishes "you sent nonsense" from "that analysis is gone".
 */
const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function createApi(dependencies: ApiDependencies): WebApi {
  const store = dependencies.store;
  const metrics = dependencies.metrics ?? new ObservabilityRecorder();
  const events = dependencies.events ?? new AnalysisEventBus();
  const exporter = dependencies.exporter ?? new PdfReportExporter({ now: dependencies.now });
  const now = dependencies.now ?? ((): Date => new Date());
  const client = dependencies.client ?? createLlmClient(dependencies.config);
  const questionBudget = dependencies.questionBudget ?? DEFAULT_QUESTION_BUDGET;
  const questionQueue = new KeyedQueue();
  const inFlight = new Set<Promise<unknown>>();

  const runner = new AnalysisRunner({
    store,
    events,
    workspaceRoot: dependencies.workspaceRoot,
    config: dependencies.config,
    client,
    budget: dependencies.budget,
    precisionPolicy: dependencies.precisionPolicy,
    provenance: dependencies.provenance,
    now: dependencies.now,
    logError: dependencies.logError,
  });

  const requireId = (id: string): string => {
    if (!ANALYSIS_ID_PATTERN.test(id)) {
      throw new RequestError(
        "That is not a valid analysis id.",
        "An id looks like \"an-m1x2y3-1\". Ids come from the analysis list; they cannot be constructed.",
      );
    }
    return id;
  };

  const requireAnalysis = async (id: string): Promise<AnalysisRecord> => {
    const record = await store.get(requireId(id));
    if (record === undefined) {
      throw new RequestError(
        `No analysis with id "${id}".`,
        "It may have been deleted. The analysis list shows what this workspace still holds.",
        { notFound: true },
      );
    }
    return record;
  };

  /** A record that has a report and a graph, or an error explaining why not. */
  const requireCompleted = async (id: string): Promise<AnalysisRecord> => {
    const record = await requireAnalysis(id);
    if (record.status === "failed") {
      throw new RequestError(
        `Analysis "${id}" failed and has no report.`,
        record.error ?? undefined,
      );
    }
    if (record.report === null || record.graph === null) {
      throw new RequestError(
        `Analysis "${id}" is still ${record.status}.`,
        "Wait for it to complete. Progress is on /api/analyses/:id/events.",
      );
    }
    return record;
  };

  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      () => inFlight.delete(work),
    );
    return work;
  };

  const routeAnalyze = async (request: ApiRequest, wait: boolean): Promise<ApiResponse> => {
    const body = parseBody(AnalyzeRequestSchema, request.body);
    const system = body.system ?? DEFAULT_ANALYSIS_SYSTEM;
    if (!ANALYSIS_SYSTEMS.includes(system)) {
      throw new RequestError(
        `Unknown system "${system}".`,
        `Expected one of: ${ANALYSIS_SYSTEMS.join(", ")}.`,
      );
    }
    if (body.focus !== undefined && !systemSupportsFocus(system)) {
      throw new RequestError(
        `A scout focus is not available to the "${system}" system.`,
        "Only a system that runs the evidence scout can be aimed at a question.",
      );
    }

    // Fail fast on a repository the workspace does not offer. The runner checks
    // this again under `validating` — that is the authoritative check and the one
    // a restored record depends on — but answering a bad path with a 400 now is
    // more useful than a queued analysis that fails a moment later.
    resolveRepositoryRequest(dependencies.workspaceRoot, body.repository);

    const started = await runner.start({
      repository: body.repository,
      system,
      focus: body.focus,
    });
    const completion = track(started.completion);

    if (!wait) {
      // 202: the record exists and is durable; the work has not finished.
      return jsonResponse(analysisDetailDto(started.record), 202);
    }

    const finished = await completion;
    if (finished.status === "failed") {
      throw new RequestError(finished.error ?? "The analysis failed.");
    }
    recordAnalysisMetrics(finished);
    return jsonResponse(analysisDetailDto(finished), 201);
  };

  const recordAnalysisMetrics = (record: AnalysisRecord): void => {
    if (record.report === null || record.graph === null) return;
    const report = record.report;
    metrics.analysisCompleted(
      {
        analysisId: record.id,
        system: report.system,
        model: report.model,
        durationMs: report.metrics.durationMs,
        filesInspected: report.metrics.filesInspected,
        ledgerSources: report.metrics.ledgerSources,
        evidenceCount: report.metrics.evidenceCount,
        citationsGrounded: report.metrics.citationsGrounded,
        citationsDropped: report.metrics.citationsDropped,
        unsupportedClaims: report.metrics.unsupportedClaims,
        nodeCount: record.graph.summary.nodeCount,
        edgeCount: record.graph.summary.edgeCount,
      },
      now(),
    );
  };

  const routeQuestion = async (analysisId: string, question: string): Promise<ApiResponse> => {
    // Serialised per analysis: two questions answered concurrently would both read
    // the history, and the later one would overwrite the earlier one's place in it.
    return await questionQueue.run(analysisId, async () => {
      const record = await requireCompleted(analysisId);
      const report = record.report;
      if (report === null) throw new RequestError(`Analysis "${analysisId}" has no report.`);
      const questionNumber = record.questions.length + 1;

      // The stored relative path back through the same boundary. A question asked
      // after a restart resolves its root exactly the way the analysis did, and
      // there is no absolute path anywhere in between for anyone to tamper with.
      const repository = resolveRepositoryRequest(
        dependencies.workspaceRoot,
        record.repositoryPath,
      );

      const run = await answerQuestion({
        question,
        questionId: `q-${questionNumber}`,
        repositoryRoot: repository.absolute,
        repositoryName: report.repository.name,
        // The redacted projection, which is also what a question asked after a
        // restart would see. One behaviour, not two.
        sources: toContextSources(record.evidence),
        history: record.questions,
        client,
        budget: questionBudget,
        now: dependencies.now,
      });

      const answered = questionView(run.answered);
      await store.appendQuestion(record.id, answered);

      // The question's own reads join the stored evidence, so the viewer can serve
      // the artefacts its citations name. They do not become citable by a later
      // question: `answerQuestion` seeds each question's ledger from reconnaissance
      // artefacts only, which is what keeps a conversation from becoming evidence.
      const merged = await store.get(record.id);
      if (merged !== undefined) {
        await store.update(record.id, {
          evidence: mergeQuestionEvidence(merged.evidence, run.newSources, answered),
        });
      }

      metrics.questionAnswered(
        {
          analysisId: record.id,
          questionNumber,
          durationMs: answered.metrics.durationMs,
          toolCalls: answered.metrics.toolCalls,
          scoutFilesRead: answered.metrics.scoutFilesRead,
          citationsClaimed: answered.audit.claimed,
          citationsGrounded: answered.audit.grounded,
          supported: answered.supported,
          followUp: questionNumber > 1,
        },
        now(),
      );

      return jsonResponse({ analysisId: record.id, question: answered }, 201);
    });
  };

  const routeEvidence = async (analysisId: string, evidenceId: string): Promise<ApiResponse> => {
    const record = await requireAnalysis(analysisId);
    const found = findCitation(record, evidenceId);
    if (!found) {
      throw new RequestError(
        `Analysis "${analysisId}" issued no evidence with id "${evidenceId}".`,
        "Evidence ids come from a report or an answered question; they cannot be constructed.",
        { notFound: true },
      );
    }
    // Both ids, always. An evidence id from another analysis reaches a query that
    // is scoped to this one and finds nothing.
    const source =
      found.citation.sourceId === null
        ? undefined
        : await store.getEvidenceSource(record.id, found.citation.sourceId);
    const reportSource = record.report?.sources.find((item) => item.id === found.citation.sourceId);
    return jsonResponse(evidenceViewDto(record.id, found.citation, found.origin, source, reportSource));
  };

  const routeExport = async (analysisId: string, format: string): Promise<ApiResponse> => {
    const record = await requireCompleted(analysisId);
    if (record.report === null || record.graph === null) {
      throw new RequestError(`Analysis "${analysisId}" has no report to export.`);
    }
    if (format !== exporter.format) {
      throw new RequestError(`No exporter for format "${format}".`, `Available: ${exporter.format}.`, {
        notFound: true,
      });
    }
    const startedAt = Date.now();
    const bytes = await exporter.export({
      report: record.report,
      graph: record.graph,
      questions: record.questions,
      repositoryPath: record.repositoryPath === "" ? "." : record.repositoryPath,
      analysisId: record.id,
      createdAt: record.createdAt,
      durationMs: record.metadata.durationMs,
    });
    metrics.exportGenerated(
      {
        analysisId: record.id,
        format: exporter.format,
        bytes: bytes.length,
        durationMs: Date.now() - startedAt,
      },
      now(),
    );
    return {
      kind: "bytes",
      status: 200,
      contentType: exporter.contentType,
      bytes,
      filename: exporter.filename(record.report),
    };
  };

  const routeDelete = async (analysisId: string): Promise<ApiResponse> => {
    const id = requireId(analysisId);
    // Tell the runner before the row goes, not after.
    //
    // A run outlives the request that started it, so this is the one route that
    // can destroy a record while something is still writing to it. Announcing the
    // delete first turns "the row vanished under me" into "I was told to stop":
    // the run stops at its next boundary and discards its result, instead of
    // failing against a missing row once per phase and then failing again trying
    // to record that failure. The runner also recognises the deletion on its own
    // if the two race, so this is an optimisation of the log, not the invariant.
    const cancelled = runner.abandon(id);
    const removed = await store.delete(id);
    if (!removed) {
      throw new RequestError(`No analysis with id "${id}".`, undefined, { notFound: true });
    }
    // Progress for an id that no longer exists is not progress. Forgetting it also
    // closes the door on a subscriber holding a stream open for a deleted analysis.
    events.forget(id);
    return jsonResponse({ deleted: id, cancelled }, 200);
  };

  /**
   * The progress stream.
   *
   * Replay first, then live: the bus hands a new subscriber everything it has
   * already emitted for this analysis, so a browser that posts and then connects
   * sees the same sequence as one that was already listening. The stream closes
   * itself once a terminal event has been delivered, which means the browser never
   * has to decide when to stop waiting.
   */
  const routeEvents = async (analysisId: string): Promise<ApiResponse> => {
    const record = await requireAnalysis(analysisId);

    return {
      kind: "stream",
      status: 200,
      contentType: "text/event-stream",
      open: (channel) => {
        let closed = false;
        const finish = (): void => {
          if (closed) return;
          closed = true;
          channel.close();
        };

        const unsubscribe = events.subscribe(record.id, (event) => {
          if (closed) return;
          channel.send(event.type, event);
          if (event.type === "analysis.completed" || event.type === "analysis.failed") finish();
        });

        // A record that reached a terminal state before this connection opened, and
        // whose events the bus has since evicted, still has to end the stream.
        if (!closed && isTerminal(record.status) && events.replay(record.id).length === 0) {
          channel.send(
            record.status === "completed" ? "analysis.completed" : "analysis.failed",
            record.status === "completed"
              ? { type: "analysis.completed", analysisId: record.id, at: record.updatedAt, durationMs: record.metadata.durationMs ?? 0 }
              : { type: "analysis.failed", analysisId: record.id, at: record.updatedAt, error: record.error ?? "The analysis failed." },
          );
          finish();
        }

        const heartbeat = setInterval(() => {
          if (!closed) channel.comment("keep-alive");
        }, STREAM_HEARTBEAT_MS);
        // Never the reason a process stays alive.
        heartbeat.unref?.();

        return () => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        };
      },
    };
  };

  const handle: ApiHandler = async (request) => {
    try {
      return await dispatch(request);
    } catch (error) {
      return errorResponse(error, dependencies.logError);
    }
  };

  const dispatch = async (request: ApiRequest): Promise<ApiResponse> => {
    const segments = request.path.split("/").filter((segment) => segment !== "");
    if (segments[0] !== "api") throw notFound(request);
    const [, resource, ...rest] = segments;

    if (resource === "health" && rest.length === 0) {
      requireMethod(request, "GET");
      return jsonResponse({
        status: "ok",
        workspace: path.basename(dependencies.workspaceRoot),
        provider: dependencies.config.provider,
        model: dependencies.config.model,
        defaultSystem: DEFAULT_ANALYSIS_SYSTEM,
        systems: ANALYSIS_SYSTEMS,
        maxQuestionChars: MAX_QUESTION_CHARS,
        exportFormats: [exporter.format],
        /** Durable now. The browser says so in the sidebar. */
        durableAnalyses: true,
      });
    }

    if (resource === "repositories" && rest.length === 0) {
      requireMethod(request, "GET");
      return jsonResponse({ repositories: listRepositories(dependencies.workspaceRoot) });
    }

    // ---- canonical: /api/analyses ----
    if (resource === "analyses") {
      if (rest.length === 0) {
        if (request.method === "POST") return await routeAnalyze(request, false);
        requireMethod(request, "GET");
        const summaries = await store.list();
        return jsonResponse({ analyses: summaries.map(analysisSummaryDto) });
      }

      const id = rest[0];
      if (id === undefined) throw notFound(request);

      if (rest.length === 1) {
        if (request.method === "DELETE") return await routeDelete(id);
        requireMethod(request, "GET");
        return jsonResponse(analysisDetailDto(await requireAnalysis(id)));
      }
      if (rest.length === 2 && rest[1] === "events") {
        requireMethod(request, "GET");
        return await routeEvents(id);
      }
      if (rest.length === 2 && rest[1] === "questions") {
        if (request.method === "POST") {
          const body = parseBody(ScopedQuestionRequestSchema, request.body);
          return await routeQuestion(id, body.question);
        }
        requireMethod(request, "GET");
        const record = await requireAnalysis(id);
        return jsonResponse({ analysisId: record.id, questions: record.questions });
      }
      if (rest.length === 3 && rest[1] === "evidence") {
        requireMethod(request, "GET");
        return await routeEvidence(id, rest[2] as string);
      }
      if (rest.length === 3 && rest[1] === "export") {
        requireMethod(request, "GET");
        return await routeExport(id, rest[2] as string);
      }
      throw notFound(request);
    }

    // ---- Iteration 4 aliases, kept so its tests keep passing unmodified ----
    if (resource === "analyze" && rest.length === 0) {
      requireMethod(request, "POST");
      // The legacy contract is synchronous: it returns the finished analysis.
      return await routeAnalyze(request, true);
    }

    if (resource === "questions" && rest.length === 0) {
      requireMethod(request, "POST");
      const body = parseBody(QuestionRequestSchema, request.body);
      return await routeQuestion(body.analysisId, body.question);
    }

    if (resource === "analysis") {
      const id = rest[0];
      if (id === undefined) throw notFound(request);

      if (rest.length === 1) {
        if (request.method === "DELETE") return await routeDelete(id);
        requireMethod(request, "GET");
        return jsonResponse(analysisDetailDto(await requireAnalysis(id)));
      }
      if (rest.length === 3 && rest[1] === "evidence") {
        requireMethod(request, "GET");
        return await routeEvidence(id, rest[2] as string);
      }
      if (rest.length === 3 && rest[1] === "export") {
        requireMethod(request, "GET");
        return await routeExport(id, rest[2] as string);
      }
      if (rest.length === 2 && rest[1] === "questions") {
        requireMethod(request, "GET");
        const record = await requireAnalysis(id);
        return jsonResponse({ questions: record.questions });
      }
      if (rest.length === 2 && rest[1] === "events") {
        requireMethod(request, "GET");
        return await routeEvents(id);
      }
    }

    throw notFound(request);
  };

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };

  return { handle, store, metrics, events, idle };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialises work by key.
 *
 * Two questions asked against one analysis at the same time would each read the history,
 * answer against it, and append — and the second write would land on a snapshot taken
 * before the first. Different analyses never contend.
 */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    // Keep the chain alive on failure, and drop the key once it drains.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return await result;
  }
}

/**
 * The repository picker's list: the workspace root's immediate children.
 *
 * Not a search and not recursive. The one directory read is the workspace root itself,
 * whose path comes from the operator's own command line — nothing here is steered by a
 * request, which is what keeps "no arbitrary filesystem access" true while still letting
 * someone click a repository instead of typing its path.
 */
function listRepositories(workspaceRoot: string): {
  path: string;
  name: string;
  isGitRepository: boolean;
}[] {
  const entries: { path: string; name: string; isGitRepository: boolean }[] = [];

  const describe = (relative: string, absolute: string, name: string): void => {
    entries.push({
      path: relative,
      name,
      isGitRepository: statOrNull(path.join(absolute, ".git")) !== null,
    });
  };

  describe(".", workspaceRoot, path.basename(workspaceRoot));

  let children: string[] = [];
  try {
    children = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // An unreadable workspace root is a listing of one: the root itself.
    return entries;
  }

  for (const child of children.slice(0, MAX_REPOSITORY_ENTRIES)) {
    describe(child, path.join(workspaceRoot, child), child);
  }
  return entries;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  if (body === undefined) {
    throw new RequestError("A JSON request body is required.", "Send Content-Type: application/json.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`,
    );
    throw new RequestError("The request body is not valid.", issues.join("; "));
  }
  return parsed.data;
}

function requireMethod(request: ApiRequest, method: string): void {
  if (request.method !== method) {
    throw new RequestError(`${request.method} is not allowed on ${request.path}.`, `Use ${method}.`);
  }
}

function notFound(request: ApiRequest): RequestError {
  return new RequestError(`No route for ${request.method} ${request.path}.`, undefined, { notFound: true });
}

/**
 * Maps a thrown error onto a status.
 *
 * The categories are the ones the error hierarchy already draws, which is why it is
 * worth having: a `RequestError` is the caller's, a `ToolError` is a boundary refusing a
 * path, a `ModelError` is upstream, and anything unrecognised is ours.
 *
 * The last branch is the one that changed in Iteration 5. It used to pass the
 * exception's own `message` through as a hint, which for an unanticipated error is
 * as likely to be `ENOENT: no such file or directory, open '/home/…'` as it is to
 * be an explanation — an absolute host path in an HTTP response, reachable by
 * anything that could provoke an unhandled throw. Now the message goes to the
 * operator's log and the caller gets a sentence with nothing in it.
 */
function errorResponse(error: unknown, logError?: ((message: string) => void) | undefined): ApiResponse {
  const shape = (status: number, name: string, message: string, hint?: string | undefined): ApiResponse =>
    jsonResponse({ error: { name, message, ...(hint === undefined ? {} : { hint }) } }, status);

  if (error instanceof RequestError) {
    return shape(error.notFound ? 404 : 400, error.name, error.message, error.hint);
  }
  if (isNamed(error, "ToolError") || isNamed(error, "RepositoryError")) {
    return shape(400, error.name, error.message, hintOf(error));
  }
  if (isNamed(error, "SchemaError") || isNamed(error, "ModelError")) {
    return shape(502, error.name, error.message, hintOf(error));
  }
  if (isNamed(error, "ConfigError")) {
    return shape(500, error.name, error.message, hintOf(error));
  }
  if (isNamed(error, "StorageError")) {
    // The message is ours and safe; the hint holds the database path and is not.
    return shape(500, error.name, error.message);
  }

  const report = logError ?? ((message: string): void => console.error(message));
  report(`unhandled API error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return shape(500, "InternalError", "The request failed.");
}

function isNamed(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function hintOf(error: unknown): string | undefined {
  const hint = (error as { hint?: unknown }).hint;
  return typeof hint === "string" ? hint : undefined;
}
