import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EXPLORATION_BUDGET,
  DEFAULT_PRECISION_POLICY,
  ConfigError,
  createLlmClient,
  type AnalysisConfig,
  type ExplorationBudget,
} from "@repo-arch/shared";
import {
  MEMORY_DATABASE,
  SYSTEM_VERSIONS,
  SqliteAnalysisStore,
  type AnalysisReport,
  type AnalysisStore,
  type AnsweredQuestion,
  type ArchitectureGraph,
  type MetricEvent,
  type ReportEvidence,
} from "@repo-arch/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeJson, type ApiRequest, type ApiResponse } from "../src/api";
import { createApi, type ApiDependencies, type WebApi } from "../src/routes";

/**
 * The API, over the real pipeline, offline.
 *
 * The model is the deterministic mock provider — the same one `--mock` gives a user — so
 * every analysis here runs the whole advanced pipeline (collect, scout, reconnaissance,
 * exploration, synthesis, validation, precision, grounding) against a real repository on
 * disk. Nothing is stubbed between the route and the evidence ledger, because the
 * properties worth checking are the ones that only exist when the parts are joined up:
 * that a path a caller invents never reaches the filesystem, that an evidence id a caller
 * invents never returns text, that a line number shown to a reader is one the ledger can
 * actually account for, and that a credential in a repository does not survive the trip
 * out through JSON.
 *
 * The routes are called as functions rather than over a socket. `integration.test.ts`
 * covers the transport; this covers the decisions.
 *
 * Iteration 5 note: this file is Iteration 4's suite, and the only edits are the ones the
 * durable store forces — a store passed to `createApi`, `await` on the store's now
 * promise-returning methods, `record.evidence` where the field used to be `sources`, and
 * the two assertions that had pinned the old id scheme. Every property being asserted is
 * the same property, which is the point of keeping the file rather than rewriting it.
 */

const SECRET = "AKIAIOSFODNN7EXAMPLE";

/** The workspace root: the only tree a request may name a repository inside. */
let workspace: string;
/** A sibling of the workspace, so an escape has somewhere to try to reach. */
let outside: string;
let api: WebApi;
let analysis: AnalysisView;
/** Every store opened here, so none is left holding a connection at teardown. */
const stores: AnalysisStore[] = [];

interface AnalysisView {
  id: string;
  createdAt: string;
  systemVersion: string | null;
  provenance: string | null;
  report: AnalysisReport;
  graph: ArchitectureGraph;
  questions: AnsweredQuestion[];
}

interface EvidenceView {
  analysisId: string;
  origin: { kind: string; questionId?: string; question?: string };
  evidence: ReportEvidence;
  source:
    | null
    | {
        id: string;
        type: string;
        bytes: number;
        truncated: boolean;
        origins: string[];
        citationCount: number;
        text: string;
        textTruncatedForDisplay: boolean;
        lineNumbersKnown: boolean;
        reportedLocation: string | null;
        excerptMatch: null | { start: number; end: number; line: number | null };
      };
  note?: string;
}

const config: AnalysisConfig = {
  provider: "mock",
  model: "mock-test-model",
  seed: 7,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
  apiKey: undefined,
};

function write(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** A repository small enough to analyse in a test and real enough to have evidence. */
function writeRepository(root: string): void {
  write(root, "README.md", `# widget\n\nStores records. Key ${SECRET} lives here.\n`);
  write(root, "package.json", '{ "name": "widget", "dependencies": { "pg": "^8.11.3" } }\n');
  write(root, "src/router.ts", "import { write } from './store';\n\nexport function route(request) {\n  return write(request.body);\n}\n");
  write(
    root,
    "src/store.ts",
    "import { Pool } from 'pg';\nconst pool = new Pool();\nexport async function write(record) {\n  await pool.query('insert into records values ($1)', [record]);\n}\n",
  );
  write(root, "test/router.test.ts", "import { route } from '../src/router';\ntest('routes', () => {});\n");
}

/**
 * A fresh API over a fresh in-memory database.
 *
 * One store per API, and `:memory:` rather than a temporary file, because a
 * `node:sqlite` in-memory database belongs to its own connection: two stores built
 * here cannot see each other's rows even by accident, which is what several of the
 * isolation assertions below depend on.
 */
function newApi(budget: ExplorationBudget = DEFAULT_EXPLORATION_BUDGET): WebApi {
  return newApiWith({ budget });
}

/**
 * An API with one dependency varied.
 *
 * Separate from `newApi` so the common case stays a call with no arguments, and
 * so a test that cares about one dependency does not have to restate the other
 * seven — restating them is how a test ends up exercising a configuration the
 * product never runs.
 */
function newApiWith(overrides: Partial<ApiDependencies> = {}): WebApi {
  const store = new SqliteAnalysisStore({ location: MEMORY_DATABASE, now: fixedClock() });
  stores.push(store);
  return createApi({
    workspaceRoot: workspace,
    config,
    budget: DEFAULT_EXPLORATION_BUDGET,
    precisionPolicy: DEFAULT_PRECISION_POLICY,
    client: createLlmClient(config),
    store,
    now: fixedClock(),
    ...overrides,
  });
}

/** A fixed clock, so run ids and durations are deterministic. */
function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + tick++ * 1000);
}

async function call(target: WebApi, method: string, urlPath: string, body?: unknown): Promise<ApiResponse> {
  const url = new URL(urlPath, "http://localhost");
  const request: ApiRequest = { method, path: url.pathname, query: url.searchParams, body };
  return await target.handle(request);
}

function jsonValue(response: ApiResponse): unknown {
  if (response.kind !== "json") throw new Error(`Expected a JSON response, received "${response.kind}".`);
  return response.value;
}

/** Asserts a successful status and returns the body, typed by the caller. */
function ok<T>(response: ApiResponse, status = 200): T {
  const value = jsonValue(response);
  expect({ status: response.status, value }).toMatchObject({ status });
  return value as T;
}

function failure(response: ApiResponse, status: number): { name: string; message: string; hint?: string } {
  const value = jsonValue(response) as { error?: { name: string; message: string; hint?: string } };
  expect(response.status).toBe(status);
  expect(value.error).toBeDefined();
  return value.error as { name: string; message: string; hint?: string };
}

beforeAll(async () => {
  const base = mkdtempSync(path.join(tmpdir(), "repo-arch-web-"));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeRepository(path.join(workspace, "widget"));
  // A second, much smaller repository. Its analysis inspects fewer artefacts, so it
  // issues fewer evidence ids — which is what makes evidence-id scoping testable.
  write(path.join(workspace, "sparse"), "README.md", "# sparse\n\nOne file, nothing else.\n");
  write(outside, "secrets.txt", `${SECRET}\n`);
  // Things a request must not be able to name as a repository.
  mkdirSync(path.join(workspace, "node_modules", "left-pad"), { recursive: true });
  write(workspace, "notes.txt", "not a repository\n");
  symlinkSync(outside, path.join(workspace, "escape"), "dir");

  api = newApi();
  analysis = ok<AnalysisView>(await call(api, "POST", "/api/analyze", { repository: "widget" }), 201);
});

afterAll(async () => {
  for (const store of stores) await store.close();
  if (workspace) rmSync(path.dirname(workspace), { recursive: true, force: true });
});

describe("POST /api/analyze", () => {
  it("analyses a repository in the workspace and returns a report with its graph", () => {
    // Iteration 5 mints the record id before the pipeline runs — an analysis has to be
    // addressable while it is still `queued` — so the id no longer carries the system
    // name. The system is asserted where it is now recorded, which is the report.
    expect(analysis.id).toMatch(/^an-[a-z0-9]+-\d+$/);
    expect(analysis.report.repository.name).toBe("widget");
    expect(analysis.report.system).toBe("advanced");
    expect(analysis.report.provider).toBe("mock");

    // The pipeline really ran: the ledger holds more than the reconnaissance context,
    // which is only true if the scout and the tool loop both executed.
    expect(analysis.report.sources.length).toBeGreaterThan(4);
    expect(analysis.report.evidence.length).toBeGreaterThan(0);
    expect(analysis.report.metrics.filesInspected).toBeGreaterThan(0);
    expect(analysis.graph.summary.nodeCount).toBeGreaterThan(1);
    expect(analysis.questions).toEqual([]);

    // Every graph node and edge is evidence-backed. This is the invariant the graph
    // exists to preserve, checked here against a report nobody hand-wrote.
    for (const node of analysis.graph.nodes) expect(node.evidenceIds.length).toBeGreaterThan(0);
    for (const edge of analysis.graph.edges) expect(edge.evidenceIds.length).toBeGreaterThan(0);
  });

  it("keeps the machine's own paths and the repository's bytes out of the response", () => {
    const serialised = serializeJson(analysis);
    // `repositoryRoot` is an absolute path on this machine; the ledger text is the
    // repository itself. Neither belongs in a dashboard payload.
    expect(serialised).not.toContain(workspace);
    expect(serialised).not.toContain("repositoryRoot");
    expect(analysis.report.repository.path).not.toContain(tmpdir());
    for (const source of analysis.report.sources) {
      expect(source).not.toHaveProperty("text");
    }
  });

  it("stores the analysis so it is analysed once and read back many times", async () => {
    const stored = await api.store.get(analysis.id);
    expect(stored).toBeDefined();
    // The record id and the pipeline's own run id are separate identities now: the
    // record was created before the run existed. Both must survive the round trip.
    expect(stored?.id).toBe(analysis.id);
    expect(stored?.report?.id).toBe(analysis.report.id);
    expect(stored?.status).toBe("completed");
    expect((await api.store.list()).map((entry) => entry.id)).toContain(analysis.id);
  });

  it("rejects a repository that is not in the workspace", async () => {
    const error = failure(await call(api, "POST", "/api/analyze", { repository: "absent" }), 400);
    expect(error.name).toBe("ToolError");
    expect(error.message).toMatch(/No such directory in the workspace/);
  });

  it.each([
    ["parent traversal", "../outside"],
    ["traversal through a real directory", "widget/../../outside"],
    ["an absolute path", "/etc"],
    ["a null byte", "widget\u0000/etc/passwd"],
    ["a symlink leaving the workspace", "escape"],
    ["a dependency directory", "node_modules"],
    ["a nested dependency directory", "widget/node_modules"],
    ["VCS internals", ".git"],
    ["a file rather than a directory", "notes.txt"],
  ])("refuses %s", async (_label, repository) => {
    const error = failure(await call(api, "POST", "/api/analyze", { repository }), 400);
    expect(error.name).toBe("ToolError");
    // Whatever the reason, nothing outside the workspace was opened to find it out.
    expect(error.message).not.toContain(outside);
  });

  it("refuses a body that is not the documented shape", async () => {
    for (const body of [
      undefined,
      {},
      { repository: "" },
      { repository: "widget", unexpected: true },
      { repository: 42 },
      { repository: "widget", focus: "" },
    ]) {
      const error = failure(await call(api, "POST", "/api/analyze", body), 400);
      expect(error.name).toBe("RequestError");
    }
  });

  it("refuses an unknown system, and a focus the chosen system cannot honour", async () => {
    const unknown = failure(await call(api, "POST", "/api/analyze", { repository: "widget", system: "clairvoyant" }), 400);
    expect(unknown.hint).toContain("advanced");

    const focused = failure(
      await call(api, "POST", "/api/analyze", { repository: "widget", system: "baseline", focus: "how does it store records" }),
      400,
    );
    expect(focused.message).toMatch(/focus is not available/);
  });

  it("insists on POST", async () => {
    const error = failure(await call(api, "GET", "/api/analyze"), 400);
    expect(error.hint).toBe("Use POST.");
  });
});

describe("GET /api/analysis/:id", () => {
  it("returns the stored analysis unchanged", async () => {
    const again = ok<AnalysisView>(await call(api, "GET", `/api/analysis/${analysis.id}`));
    expect(again.report).toEqual(analysis.report);
    expect(again.graph).toEqual(analysis.graph);
  });

  it("says which build produced the analysis and where the run came from", async () => {
    const detail = ok<Record<string, unknown>>(await call(api, "GET", `/api/analysis/${analysis.id}`));

    // Three identities, and the two that belong to an analysis are here. The
    // version is the advanced pipeline's own constant, not a restatement, so it
    // cannot drift from the code that ran.
    expect(detail["system"]).toBe("advanced");
    expect(detail["systemVersion"]).toBe(SYSTEM_VERSIONS["advanced"]);
    // Whatever this environment labels its runs, it is a slug and never a path.
    expect(String(detail["provenance"])).toMatch(/^[a-z0-9][a-z0-9._/-]{0,63}$/);

    // The third identity is not an analysis's to claim. A benchmark version
    // describes an evaluation dataset, and this endpoint never ran one.
    expect(detail).not.toHaveProperty("benchmarkVersion");
    // And publishing an identity did not open a door to the rest of the run.
    const serialised = serializeJson(detail);
    expect(serialised).not.toContain(workspace);
    for (const forbidden of ["repositoryRoot", "trajectory", "apiKey", "prompt"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("labels a run whose provenance was given explicitly", async () => {
    const labelled = newApiWith({ provenance: "iteration-6-baseline" });
    const started = ok<AnalysisView>(
      await call(labelled, "POST", "/api/analyze", { repository: "sparse" }),
      201,
    );
    expect(started.provenance).toBe("iteration-6-baseline");
    expect(started.systemVersion).toBe(SYSTEM_VERSIONS["advanced"]);
  });

  it("refuses to start at all rather than store a provenance label it cannot vouch for", () => {
    // The value is persisted and then served, so a shell mistake like
    // `--provenance "$(cat .env)"` has to fail here — before it becomes a row in
    // the database and then a field in this very response.
    expect(() => newApiWith({ provenance: "AKIA-SECRET-LOOKING-VALUE" })).toThrow(ConfigError);
  });

  it("reports a missing analysis as missing, and says why it might be gone", async () => {
    const error = failure(await call(api, "GET", "/api/analysis/advanced-widget-never-ran"), 404);
    expect(error.name).toBe("RequestError");
    // Iteration 4 said the analysis was "held in memory", which a durable store makes
    // untrue. The hint now points at the list, which is the thing that can answer it.
    expect(error.hint).toMatch(/may have been deleted/);
  });

  it("has no route for an unknown path", async () => {
    expect((await call(api, "GET", "/api/nonsense")).status).toBe(404);
    expect((await call(api, "GET", `/api/analysis/${analysis.id}/nonsense`)).status).toBe(404);
    expect((await call(api, "GET", "/not-api")).status).toBe(404);
  });
});

describe("GET /api/analysis/:id/evidence/:evidenceId", () => {
  /** The report's own id for the citation naming `sourceId`. */
  function evidenceCiting(sourceId: string): ReportEvidence {
    const found = analysis.report.evidence.find((item) => item.sourceId === sourceId);
    if (!found) throw new Error(`No evidence cites "${sourceId}".`);
    return found;
  }

  it("returns the cited artefact's text from the ledger", async () => {
    const cited = evidenceCiting("README.md");
    const view = ok<EvidenceView>(await call(api, "GET", `/api/analysis/${analysis.id}/evidence/${cited.id}`));

    expect(view.analysisId).toBe(analysis.id);
    expect(view.origin.kind).toBe("report");
    expect(view.evidence.id).toBe(cited.id);
    expect(view.source?.id).toBe("README.md");
    expect(view.source?.text).toContain("Stores records.");
    // The origins are what the evidence explorer groups by.
    expect(view.source?.origins).toContain("reconnaissance");
    expect(view.source?.citationCount).toBeGreaterThan(0);
  });

  it("locates a verified excerpt on the line it is really on", async () => {
    const cited = analysis.report.evidence.find(
      (item) => item.excerpt !== undefined && item.sourceId === "src/store.ts",
    );
    expect(cited?.excerpt).toBeDefined();

    const view = ok<EvidenceView>(await call(api, "GET", `/api/analysis/${analysis.id}/evidence/${cited?.id ?? ""}`));
    const source = view.source;
    expect(source?.truncated).toBe(false);
    expect(source?.lineNumbersKnown).toBe(true);

    const match = source?.excerptMatch;
    expect(match).not.toBeNull();
    expect(match?.line).toBeGreaterThan(0);

    // The highlight is checked against the text, not taken on trust: the line the
    // response points at must be the line the excerpt is on.
    const lines = (source?.text ?? "").split("\n");
    const line = lines[(match?.line ?? 0) - 1] ?? "";
    expect(collapse(line)).toContain(collapse(cited?.excerpt ?? ""));
    // And the offsets must cut the excerpt out of the text.
    expect(collapse((source?.text ?? "").slice(match?.start ?? 0, match?.end ?? 0))).toBe(
      collapse(cited?.excerpt ?? ""),
    );
  });

  it("declines to number the lines of a partially read artefact", async () => {
    // A `read_file` capped mid-file carries no record of which line it began at, so a
    // line number here would be invented. The excerpt is still located; only the
    // numbering is withheld.
    const bounded = newApi({ ...DEFAULT_EXPLORATION_BUDGET, maxFileBytes: 90, maxFileLines: 2 });
    const run = ok<AnalysisView>(await call(bounded, "POST", "/api/analyze", { repository: "widget" }), 201);

    const truncated = (await bounded.store.get(run.id))?.evidence
      .filter((source) => source.truncated)
      .map((source) => source.id);
    expect(truncated?.length).toBeGreaterThan(0);

    const cited = run.report.evidence.find(
      (item) => item.excerpt !== undefined && truncated?.includes(item.sourceId ?? ""),
    );
    expect(cited).toBeDefined();

    const view = ok<EvidenceView>(await call(bounded, "GET", `/api/analysis/${run.id}/evidence/${cited?.id ?? ""}`));
    expect(view.source?.truncated).toBe(true);
    expect(view.source?.lineNumbersKnown).toBe(false);
    expect(view.source?.excerptMatch).not.toBeNull();
    expect(view.source?.excerptMatch?.line).toBeNull();
    // The model's own claim about the location is passed through, labelled as a claim.
    expect(view.source?.reportedLocation).toBe(cited?.location ?? null);
  });

  it("redacts a credential on the way out, and never persists it in the first place", async () => {
    const cited = analysis.report.evidence.find((item) => item.excerpt?.includes(SECRET));
    // The mock quoted the README line the key is on, so this is the real case: a
    // grounded citation whose excerpt is a credential.
    expect(cited).toBeDefined();

    const response = await call(api, "GET", `/api/analysis/${analysis.id}/evidence/${cited?.id ?? ""}`);
    const serialised = serializeJson(jsonValue(response));
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain("<redacted-credential>");
    // Redaction is a property of the boundary, not of the ledger: grounding has to
    // compare an excerpt against what the file really says. The *store* is a boundary
    // too, so what it holds is already redacted — which is what makes an evidence
    // viewer safe to serve from a database rather than from a live re-read.
    expect(
      (await api.store.get(analysis.id))?.evidence.find((source) => source.id === "README.md")?.text,
    ).not.toContain(SECRET);
    expect(
      (await api.store.get(analysis.id))?.evidence.find((source) => source.id === "README.md")?.text,
    ).toContain("<redacted-credential>");
  });

  it("returns nothing for an evidence id this analysis never issued", async () => {
    // A plausible id, a traversal attempt, a real filename, and an id from a question
    // that was never asked. An evidence id is a key into this analysis, nothing more.
    for (const id of ["ev-999", "..%2F..%2Fetc%2Fpasswd", "README.md", "q-9-ev-001"]) {
      const error = failure(await call(api, "GET", `/api/analysis/${analysis.id}/evidence/${id}`), 404);
      expect(error.hint).toMatch(/cannot be constructed/);
      expect(error.message).toContain(analysis.id);
    }

    // An empty id is not a bad evidence id but a different path, and is refused as one.
    const noRoute = failure(await call(api, "GET", `/api/analysis/${analysis.id}/evidence/`), 404);
    expect(noRoute.message).toMatch(/No route for GET/);
  });

  it("scopes an evidence id to the analysis that issued it", async () => {
    // Two analyses in one store. Evidence ids are per-analysis counters, so the same
    // string means different things in each — which is exactly the confusion a lookup
    // that ignored the analysis id would introduce.
    const isolated = newApi();
    const widget = ok<AnalysisView>(await call(isolated, "POST", "/api/analyze", { repository: "widget" }), 201);
    const sparse = ok<AnalysisView>(await call(isolated, "POST", "/api/analyze", { repository: "sparse" }), 201);
    expect(sparse.id).not.toBe(widget.id);

    const foreign = widget.report.evidence
      .map((item) => item.id)
      .find((id) => !sparse.report.evidence.some((item) => item.id === id));
    expect(foreign).toBeDefined();

    const denied = failure(await call(isolated, "GET", `/api/analysis/${sparse.id}/evidence/${foreign ?? ""}`), 404);
    expect(denied.message).toContain(sparse.id);
    // The same id resolves against the analysis that issued it.
    const served = ok<EvidenceView>(await call(isolated, "GET", `/api/analysis/${widget.id}/evidence/${foreign ?? ""}`));
    expect(served.evidence.id).toBe(foreign);
  });
});

describe("POST /api/questions", () => {
  it("answers a question against the stored analysis and appends it", async () => {
    const asked = ok<{ analysisId: string; question: AnsweredQuestion }>(
      await call(api, "POST", "/api/questions", {
        analysisId: analysis.id,
        question: "Which module writes records to the database?",
      }),
      201,
    );

    expect(asked.analysisId).toBe(analysis.id);
    expect(asked.question.id).toBe("q-1");
    expect(asked.question.metrics.durationMs).toBeGreaterThanOrEqual(0);
    // Whatever the mock said, a citation that survived is namespaced to this question
    // and names an artefact the question actually inspected.
    for (const citation of asked.question.citations) {
      expect(citation.id.startsWith("q-1-ev-")).toBe(true);
      expect(asked.question.inspectedSources).toContain(citation.sourceId);
    }

    const stored = ok<AnalysisView>(await call(api, "GET", `/api/analysis/${analysis.id}`));
    expect(stored.questions.map((question) => question.id)).toEqual(["q-1"]);
  });

  it("numbers a follow-up and keeps the earlier answer", async () => {
    const asked = ok<{ question: AnsweredQuestion }>(
      await call(api, "POST", "/api/questions", { analysisId: analysis.id, question: "And what does it insert?" }),
      201,
    );
    expect(asked.question.id).toBe("q-2");

    const listed = ok<{ questions: AnsweredQuestion[] }>(
      await call(api, "GET", `/api/analysis/${analysis.id}/questions`),
    );
    expect(listed.questions.map((question) => question.id)).toEqual(["q-1", "q-2"]);
  });

  it("answers questions asked at the same time one at a time, so neither loses its place", async () => {
    const target = newApi();
    const created = ok<AnalysisView>(await call(target, "POST", "/api/analyze", { repository: "widget" }), 201);

    const [first, second] = await Promise.all([
      call(target, "POST", "/api/questions", { analysisId: created.id, question: "What does the router do?" }),
      call(target, "POST", "/api/questions", { analysisId: created.id, question: "What does the store do?" }),
    ]);

    const ids = [first, second].map((response) => ok<{ question: AnsweredQuestion }>(response, 201).question.id);
    expect(ids.sort()).toEqual(["q-1", "q-2"]);
    expect((await target.store.get(created.id))?.questions).toHaveLength(2);
  });

  it("refuses a question against an analysis that does not exist, and one that is out of bounds", async () => {
    expect((await call(api, "POST", "/api/questions", { analysisId: "nope", question: "why?" })).status).toBe(404);
    for (const body of [
      { analysisId: analysis.id, question: "" },
      { analysisId: analysis.id, question: "x".repeat(4001) },
      { analysisId: analysis.id },
      { analysisId: analysis.id, question: "why?", extra: 1 },
    ]) {
      expect(failure(await call(api, "POST", "/api/questions", body), 400).name).toBe("RequestError");
    }
  });
});

describe("GET /api/analysis/:id/export/pdf", () => {
  it("exports the analysis as a PDF with a safe filename", async () => {
    const response = await call(api, "GET", `/api/analysis/${analysis.id}/export/pdf`);
    if (response.kind !== "bytes") throw new Error("Expected bytes.");

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/pdf");
    expect(Buffer.from(response.bytes).toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    expect(response.bytes.byteLength).toBeGreaterThan(4_000);
    expect(response.filename).toMatch(/^repo-analysis-widget-advanced-wid[a-z0-9-]*\.pdf$/);
    expect(response.filename).not.toContain("/");
  });

  it("carries the questions and the architecture into the document", async () => {
    const response = await call(api, "GET", `/api/analysis/${analysis.id}/export/pdf`);
    if (response.kind !== "bytes") throw new Error("Expected bytes.");
    const text = Buffer.from(response.bytes).toString("latin1");

    expect(text).toContain("Architecture graph");
    expect(text).toContain("Questions");
    // And the credential in the evidence does not reach the file.
    expect(text).not.toContain(SECRET);
  });

  it("has no exporter for a format it does not implement", async () => {
    const error = failure(await call(api, "GET", `/api/analysis/${analysis.id}/export/docx`), 404);
    expect(error.hint).toContain("pdf");
  });
});

describe("the rest of the surface", () => {
  it("describes itself, so the UI does not hard-code the systems or the limits", async () => {
    const health = ok<Record<string, unknown>>(await call(api, "GET", "/api/health"));
    expect(health["status"]).toBe("ok");
    expect(health["provider"]).toBe("mock");
    expect(health["systems"]).toEqual(["advanced", "baseline"]);
    expect(health["defaultSystem"]).toBe("advanced");
    expect(health["exportFormats"]).toEqual(["pdf"]);
    expect(health["maxQuestionChars"]).toBe(1000);
    // The workspace is named, never located.
    expect(String(health["workspace"])).toBe(path.basename(workspace));
  });

  it("lists the workspace's repositories without offering anything generated", async () => {
    const listed = ok<{ repositories: { path: string; name: string; isGitRepository: boolean }[] }>(
      await call(api, "GET", "/api/repositories"),
    );
    const paths = listed.repositories.map((entry) => entry.path);
    expect(paths).toContain(".");
    expect(paths).toContain("widget");
    expect(paths).not.toContain("node_modules");
    // A listing is not a search: nothing below the top level is offered.
    expect(paths.some((entry) => entry.includes("/"))).toBe(false);
  });

  it("lists stored analyses newest first", async () => {
    const listed = ok<{ analyses: { id: string; questionCount: number }[] }>(await call(api, "GET", "/api/analyses"));
    expect(listed.analyses[0]?.id).toBe(analysis.id);
    expect(listed.analyses[0]?.questionCount).toBe(2);
  });
});

describe("observability", () => {
  it("records what a run cost without recording what it read", async () => {
    const target = newApi();
    const created = ok<AnalysisView>(await call(target, "POST", "/api/analyze", { repository: "widget" }), 201);
    await call(target, "POST", "/api/questions", { analysisId: created.id, question: "What writes records?" });
    await call(target, "GET", `/api/analysis/${created.id}/export/pdf`);

    const events: MetricEvent[] = target.metrics.snapshot();
    expect(events.map((event) => event.kind)).toEqual(["analysis", "question", "export"]);

    const analysisEvent = events[0];
    expect(analysisEvent?.fields).toMatchObject({ system: "advanced", model: "mock-test-model" });
    for (const field of ["durationMs", "filesInspected", "evidenceCount", "nodeCount", "edgeCount"]) {
      expect(typeof analysisEvent?.fields[field]).toBe("number");
    }
    expect(events[1]?.fields).toMatchObject({ questionNumber: 1, followUp: false });
    expect(typeof events[2]?.fields["bytes"]).toBe("number");

    // Counts, durations and identifiers only: no excerpt, no question text, no answer,
    // and nothing that a repository could have put there.
    const serialised = serializeJson(events);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("What writes records?");
    expect(serialised).not.toContain("insert into records");
    expect(serialised).not.toContain(workspace);
  });
});

/** Whitespace-insensitive comparison, the same normalisation grounding uses. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
