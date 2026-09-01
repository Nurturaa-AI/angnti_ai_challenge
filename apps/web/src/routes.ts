import { readdirSync } from "node:fs";
import path from "node:path";
import {
  ANALYSIS_SYSTEMS,
  DEFAULT_ANALYSIS_SYSTEM,
  DEFAULT_QUESTION_BUDGET,
  InMemoryAnalysisStore,
  MAX_QUESTION_CHARS,
  ObservabilityRecorder,
  PdfReportExporter,
  analyzeRepository,
  answerQuestion,
  buildAnalysisReport,
  buildArchitectureGraph,
  resolveRepositoryRequest,
  systemSupportsFocus,
  type AnalysisReport,
  type AnalysisStore,
  type AnsweredQuestion,
  type ArchitectureGraph,
  type QuestionCitation,
  type ReportEvidence,
  type ReportExporter,
  type StoredAnalysis,
} from "@repo-arch/app";
import {
  IGNORED_DIRECTORIES,
  RequestError,
  createLlmClient,
  statOrNull,
  type AnalysisConfig,
  type ContextSourceText,
  type ExplorationBudget,
  type LlmClient,
  type PrecisionPolicy,
} from "@repo-arch/shared";
import { z } from "zod";
import { jsonResponse, type ApiHandler, type ApiRequest, type ApiResponse } from "./api";

/**
 * The API.
 *
 * Eight routes, hand-dispatched. A router dependency would be more code than this and
 * would still need every one of the checks below, which are the parts that matter:
 *
 *   - a request body is parsed by a schema before anything reads a field from it,
 *   - a repository path crosses `resolveRepositoryRequest` before anything opens it,
 *   - an analysis id is looked up rather than trusted,
 *   - nothing in a response is assembled from a path the caller supplied.
 *
 * The routes orchestrate; they contain no analysis logic. Everything they call lives in
 * `@repo-arch/app`, which is the same code the CLI runs.
 */

/** The largest text the source viewer will return for one artefact. */
const MAX_SOURCE_TEXT_CHARS = 60_000;
/** Above this, the whitespace-tolerant excerpt search is skipped. */
const MAX_EXCERPT_SEARCH_CHARS = 200_000;
/** Entries returned by the repository picker. */
const MAX_REPOSITORY_ENTRIES = 200;

export interface ApiDependencies {
  /** Absolute path. Every repository a request may name lives inside it. */
  workspaceRoot: string;
  config: AnalysisConfig;
  budget: ExplorationBudget;
  precisionPolicy: PrecisionPolicy;
  /** Defaults to a fresh bounded in-memory store. */
  store?: AnalysisStore | undefined;
  /** Defaults to a client built from `config`; injected by tests. */
  client?: LlmClient | undefined;
  exporter?: ReportExporter | undefined;
  metrics?: ObservabilityRecorder | undefined;
  /** Bounds a question's own exploration. Separate from the analysis budget. */
  questionBudget?: ExplorationBudget | undefined;
  now?: (() => Date) | undefined;
}

export interface WebApi {
  handle: ApiHandler;
  store: AnalysisStore;
  metrics: ObservabilityRecorder;
}

const AnalyzeRequestSchema = z.strictObject({
  /** Workspace-relative path. `"."` is the workspace root. */
  repository: z.string().min(1).max(1024),
  system: z.string().min(1).max(64).optional(),
  /** Aims the evidence scout. Advanced only; see the note in `analyzeRepository`. */
  focus: z.string().min(1).max(500).optional(),
});

const QuestionRequestSchema = z.strictObject({
  analysisId: z.string().min(1).max(200),
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
});

export function createApi(dependencies: ApiDependencies): WebApi {
  const store = dependencies.store ?? new InMemoryAnalysisStore();
  const metrics = dependencies.metrics ?? new ObservabilityRecorder();
  const exporter = dependencies.exporter ?? new PdfReportExporter({ now: dependencies.now });
  const now = dependencies.now ?? ((): Date => new Date());
  const client = dependencies.client ?? createLlmClient(dependencies.config);
  const questionBudget = dependencies.questionBudget ?? DEFAULT_QUESTION_BUDGET;
  const questionQueue = new KeyedQueue();

  const requireAnalysis = (id: string): StoredAnalysis => {
    const stored = store.get(id);
    if (!stored) {
      throw new RequestError(`No analysis with id "${id}".`, "Analyses are held in memory and are lost when the server restarts.", {
        notFound: true,
      });
    }
    return stored;
  };

  const routeAnalyze = async (request: ApiRequest): Promise<ApiResponse> => {
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

    // The one door: null bytes, absolute paths, `..`, symlink escapes and generated
    // directories are all rejected here, before any of it reaches the pipeline.
    const repository = resolveRepositoryRequest(dependencies.workspaceRoot, body.repository);

    const run = await analyzeRepository({
      repositoryPath: portablePath(repository.absolute),
      system,
      config: dependencies.config,
      budget: dependencies.budget,
      precisionPolicy: dependencies.precisionPolicy,
      client,
      now: dependencies.now,
      focus: body.focus,
    });

    // The client named this repository *inside the workspace*, so that is the name the
    // report carries. `collectRepositoryContext` records a path relative to the server's
    // own working directory, which is portable for a CLI run — the user typed it — but for
    // a served workspace it describes a machine the client cannot see, and when the
    // workspace sits outside the process tree `portablePath` cannot even keep it relative.
    // `widget` is both more useful to a reader and less revealing than `/srv/repos/widget`.
    const analysed = buildAnalysisReport(run);
    const report: AnalysisReport = {
      ...analysed,
      repository: { ...analysed.repository, path: repository.relative === "" ? "." : repository.relative },
    };
    const graph = buildArchitectureGraph(report);
    const stored: StoredAnalysis = {
      id: report.id,
      createdAt: report.finishedAt,
      report,
      graph,
      record: run.record,
      sources: run.sources,
      repositoryRoot: run.repositoryRoot,
      questions: [],
    };
    store.save(stored);

    metrics.analysisCompleted(
      {
        analysisId: report.id,
        system: report.system,
        model: report.model,
        durationMs: report.metrics.durationMs,
        filesInspected: report.metrics.filesInspected,
        ledgerSources: report.metrics.ledgerSources,
        evidenceCount: report.metrics.evidenceCount,
        citationsGrounded: report.metrics.citationsGrounded,
        citationsDropped: report.metrics.citationsDropped,
        unsupportedClaims: report.metrics.unsupportedClaims,
        nodeCount: graph.summary.nodeCount,
        edgeCount: graph.summary.edgeCount,
      },
      now(),
    );

    return jsonResponse(publicAnalysis(stored), 201);
  };

  const routeQuestion = async (request: ApiRequest): Promise<ApiResponse> => {
    const body = parseBody(QuestionRequestSchema, request.body);
    // Serialised per analysis: two questions answered concurrently would both read the
    // history, and the later one would overwrite the earlier one's place in it.
    return await questionQueue.run(body.analysisId, async () => {
      const stored = requireAnalysis(body.analysisId);
      const questionNumber = stored.questions.length + 1;

      const run = await answerQuestion({
        question: body.question,
        questionId: `q-${questionNumber}`,
        repositoryRoot: stored.repositoryRoot,
        repositoryName: stored.report.repository.name,
        sources: stored.sources,
        history: stored.questions,
        client,
        budget: questionBudget,
        now: dependencies.now,
      });

      // The question's own reads join the ledger so the source viewer can show them.
      // They do not become citable by a later question: `answerQuestion` seeds each
      // question's ledger from reconnaissance artefacts only.
      stored.sources.push(...run.newSources);
      stored.questions.push(run.answered);
      store.save(stored);

      metrics.questionAnswered(
        {
          analysisId: stored.id,
          questionNumber,
          durationMs: run.answered.metrics.durationMs,
          toolCalls: run.answered.metrics.toolCalls,
          scoutFilesRead: run.answered.metrics.scoutFilesRead,
          citationsClaimed: run.answered.audit.claimed,
          citationsGrounded: run.answered.audit.grounded,
          supported: run.answered.supported,
          followUp: questionNumber > 1,
        },
        now(),
      );

      return jsonResponse({ analysisId: stored.id, question: run.answered }, 201);
    });
  };

  const routeEvidence = (analysisId: string, evidenceId: string): ApiResponse => {
    const stored = requireAnalysis(analysisId);
    const found = findCitation(stored, evidenceId);
    if (!found) {
      throw new RequestError(
        `Analysis "${analysisId}" issued no evidence with id "${evidenceId}".`,
        "Evidence ids come from a report or an answered question; they cannot be constructed.",
        { notFound: true },
      );
    }
    return jsonResponse(evidenceView(stored, found.citation, found.origin));
  };

  const routeExport = async (analysisId: string, format: string): Promise<ApiResponse> => {
    const stored = requireAnalysis(analysisId);
    if (format !== exporter.format) {
      throw new RequestError(`No exporter for format "${format}".`, `Available: ${exporter.format}.`, {
        notFound: true,
      });
    }
    const startedAt = Date.now();
    const bytes = await exporter.export({
      report: stored.report,
      graph: stored.graph,
      questions: stored.questions,
    });
    metrics.exportGenerated(
      {
        analysisId: stored.id,
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
      filename: exporter.filename(stored.report),
    };
  };

  const handle: ApiHandler = async (request) => {
    try {
      return await dispatch(request);
    } catch (error) {
      return errorResponse(error);
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
      });
    }

    if (resource === "repositories" && rest.length === 0) {
      requireMethod(request, "GET");
      return jsonResponse({ repositories: listRepositories(dependencies.workspaceRoot) });
    }

    if (resource === "analyses" && rest.length === 0) {
      requireMethod(request, "GET");
      return jsonResponse({ analyses: store.list() });
    }

    if (resource === "analyze" && rest.length === 0) {
      requireMethod(request, "POST");
      return await routeAnalyze(request);
    }

    if (resource === "questions" && rest.length === 0) {
      requireMethod(request, "POST");
      return await routeQuestion(request);
    }

    if (resource === "analysis") {
      const id = rest[0];
      if (id === undefined) throw notFound(request);

      if (rest.length === 1) {
        requireMethod(request, "GET");
        return jsonResponse(publicAnalysis(requireAnalysis(id)));
      }
      if (rest.length === 3 && rest[1] === "evidence") {
        requireMethod(request, "GET");
        return routeEvidence(id, rest[2] as string);
      }
      if (rest.length === 3 && rest[1] === "export") {
        requireMethod(request, "GET");
        return await routeExport(id, rest[2] as string);
      }
      if (rest.length === 2 && rest[1] === "questions") {
        requireMethod(request, "GET");
        return jsonResponse({ questions: requireAnalysis(id).questions });
      }
    }

    throw notFound(request);
  };

  return { handle, store, metrics };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * What a client is allowed to see of a stored analysis.
 *
 * Two things are deliberately absent. `repositoryRoot` is an absolute path on this
 * machine and belongs to the tool boundary, not to a browser. `sources[].text` is the
 * whole of every artefact — served one at a time by the evidence route, where a caller
 * has named the citation they want to check, rather than shipped in every dashboard
 * load.
 */
function publicAnalysis(stored: StoredAnalysis): {
  id: string;
  createdAt: string;
  report: AnalysisReport;
  graph: ArchitectureGraph;
  questions: AnsweredQuestion[];
} {
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    report: stored.report,
    graph: stored.graph,
    questions: stored.questions,
  };
}

/** A citation, wherever in the analysis it was issued. */
interface FoundCitation {
  citation: ReportEvidence | QuestionCitation;
  origin: { kind: "report" } | { kind: "question"; questionId: string; question: string };
}

function findCitation(stored: StoredAnalysis, evidenceId: string): FoundCitation | undefined {
  const fromReport = stored.report.evidence.find((item) => item.id === evidenceId);
  if (fromReport) return { citation: fromReport, origin: { kind: "report" } };
  for (const answered of stored.questions) {
    const citation = answered.citations.find((item) => item.id === evidenceId);
    if (citation) {
      return {
        citation,
        origin: { kind: "question", questionId: answered.id, question: answered.question },
      };
    }
  }
  return undefined;
}

/**
 * The source viewer's payload.
 *
 * The text comes from the evidence ledger, never from a fresh read of the file. That is
 * a correctness decision before it is a security one: the ledger holds what was actually
 * verified, and a file edited since the analysis would make a grounded citation look
 * fabricated. It is also the strongest possible form of "never bypass
 * `resolveInsideRepository`" — this path touches no filesystem at all.
 *
 * `lineNumbersKnown` is false for a truncated artefact. A partial `read_file` view
 * carries no record of which line it started at, so numbering its first line `1` would
 * be a fabrication. The model's own `location` is passed through, labelled as its claim
 * rather than as a fact.
 */
function evidenceView(
  stored: StoredAnalysis,
  citation: ReportEvidence | QuestionCitation,
  origin: FoundCitation["origin"],
): unknown {
  const source = citation.sourceId === null ? undefined : findSource(stored.sources, citation.sourceId);
  const reportSource = stored.report.sources.find((item) => item.id === citation.sourceId);

  if (!source) {
    return {
      analysisId: stored.id,
      origin,
      evidence: citation,
      source: null,
      note: "This citation names no artefact in the evidence ledger.",
    };
  }

  const full = source.text;
  const text = full.length > MAX_SOURCE_TEXT_CHARS ? full.slice(0, MAX_SOURCE_TEXT_CHARS) : full;
  const located = citation.excerpt === undefined ? null : locateExcerpt(text, citation.excerpt);

  return {
    analysisId: stored.id,
    origin,
    evidence: citation,
    source: {
      id: source.id,
      type: source.type,
      bytes: source.bytes,
      /** True when only part of the artefact reached the ledger. */
      truncated: source.truncated,
      origins: reportSource?.origins ?? [],
      citationCount: reportSource?.citationCount ?? 0,
      text,
      textTruncatedForDisplay: full.length > text.length,
      /** See the note above: a partial view has no line-number origin. */
      lineNumbersKnown: !source.truncated,
      /** The model's claim about where in the file this is. Not verified. */
      reportedLocation: citation.location ?? null,
      excerptMatch:
        located === null
          ? null
          : {
              start: located.start,
              end: located.end,
              line: source.truncated ? null : lineOf(text, located.start),
            },
    },
  };
}

function findSource(sources: readonly ContextSourceText[], id: string): ContextSourceText | undefined {
  return sources.find((source) => source.id === id);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

/**
 * Finds a verified excerpt in its artefact so the viewer can highlight it.
 *
 * Grounding compares whitespace-collapsed, lowercased text, so an excerpt that passed
 * verification need not appear verbatim: a model may have normalised indentation or a
 * line break. An exact match is tried first, then a scan that tolerates any run of
 * whitespace wherever the excerpt has one. Returning `null` costs only a highlight.
 */
function locateExcerpt(text: string, excerpt: string): { start: number; end: number } | null {
  const direct = text.indexOf(excerpt);
  if (direct >= 0) return { start: direct, end: direct + excerpt.length };
  if (text.length > MAX_EXCERPT_SEARCH_CHARS) return null;

  const needle = excerpt.replace(/\s+/g, " ").trim().toLowerCase();
  if (needle === "") return null;

  for (let start = 0; start < text.length; start += 1) {
    if (isSpace(text[start])) continue;
    let needleIndex = 0;
    let cursor = start;
    let end = start;
    while (needleIndex < needle.length && cursor < text.length) {
      const wanted = needle[needleIndex] as string;
      const actual = (text[cursor] as string).toLowerCase();
      if (wanted === " ") {
        if (!isSpace(actual)) break;
        while (cursor < text.length && isSpace(text[cursor])) cursor += 1;
        needleIndex += 1;
        continue;
      }
      if (isSpace(actual) || actual !== wanted) break;
      cursor += 1;
      needleIndex += 1;
      end = cursor;
    }
    if (needleIndex === needle.length) return { start, end };
  }
  return null;
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
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

// ---------------------------------------------------------------------------
// Plumbing
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
 * A path for the run record: relative to the process, when that is possible.
 *
 * `RepositoryInfo.path` is kept relative so a report stays portable, and an absolute
 * host path in a shared briefing tells a reader where somebody's home directory is. A
 * workspace outside the process's own tree falls back to the absolute path, which is
 * still bounded — `resolveRepositoryRequest` has already established that the target is
 * inside the workspace the operator named.
 */
function portablePath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
  return relative;
}

/**
 * Maps a thrown error onto a status.
 *
 * The categories are the ones the error hierarchy already draws, which is why it is
 * worth having: a `RequestError` is the caller's, a `ToolError` is a boundary refusing a
 * path, a `ModelError` is upstream, and anything unrecognised is ours and says so
 * without a stack trace or an internal message.
 */
function errorResponse(error: unknown): ApiResponse {
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
  return shape(
    500,
    "InternalError",
    "The request failed.",
    error instanceof Error ? error.message : undefined,
  );
}

function isNamed(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function hintOf(error: unknown): string | undefined {
  const hint = (error as { hint?: unknown }).hint;
  return typeof hint === "string" ? hint : undefined;
}
