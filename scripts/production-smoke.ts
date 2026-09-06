import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Production smoke: does the thing we ship actually work?
 *
 * `pnpm test` proves the modules work and — through `entry-smoke`, `cli-smoke` and
 * `browser-smoke` — that the entry points boot. What none of them does is walk the whole
 * release in one process, over a real socket, against a real file database, and then stop
 * it with a real signal and read the data back from a second process. That is the check a
 * release needs, because it is the only one that can fail on the seams *between* the
 * pieces: a store that does not survive a restart, a shutdown that corrupts a WAL, a route
 * the browser needs that answers only in a test harness.
 *
 * What it covers, in order:
 *
 *    1. start                — the shipped entry point, with production-shaped flags
 *    2. readiness            — `GET /api/health` reports the provider it actually started with
 *    3. assets               — the page and every file it asks for
 *    4. create               — `POST /api/analyses` is accepted (202) rather than blocking
 *    5. progress             — the record is readable at its id while the work is in flight
 *    6. complete             — it reaches `completed`
 *    7. read                 — the report, its components and its evidence come back
 *    8. architecture         — the graph has nodes, and every node cites evidence
 *    9. evidence             — a citation opens the artefact it was read from
 *   10. Q&A                  — a question is answered and appended to the record
 *   11. export               — the PDF is a PDF, named after the analysis
 *   12. restart durability   — SIGTERM, exit 0, then a second process reads the record back
 *   13. delete               — a finished analysis is removed and reports `cancelled: false`
 *   14. gone                 — it is 404 afterwards
 *   15. clean shutdown       — exit 0, and no WAL or shared-memory file left behind
 *
 * Deterministic and free: `--mock` and a blanked `GEMINI_API_KEY`, so a machine that
 * happens to have a key cannot turn a smoke test into a paid run. The provider is switched
 * the way any caller switches it, through the documented flag — nothing in the measured
 * path is touched to accommodate this script.
 *
 *   pnpm smoke
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "apps", "web", "src", "main.ts");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) {
    process.stdout.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
}

function step(label: string): void {
  process.stdout.write(`\n${label}\n`);
}

interface Server {
  child: ChildProcessWithoutNullStreams;
  url: string;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/** Starts the shipped entry point and waits until it says where it is. */
async function start(workspace: string, database: string): Promise<Server> {
  const child = spawn(
    TSX,
    [
      ENTRY,
      "--root",
      workspace,
      // Port 0: the OS picks, so two smoke runs never collide and neither collides with a
      // developer's own server on 4173.
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--db",
      database,
      "--mock",
      "--provenance",
      "production-smoke",
    ],
    { cwd: ROOT, env: { ...process.env, GEMINI_API_KEY: "", REPO_ARCHAEOLOGIST_PROVENANCE: "" } },
  ) as ChildProcessWithoutNullStreams;

  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += String(chunk);
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + 30_000;
  let url = "";
  while (Date.now() < deadline) {
    const match = /repo-arch web {2}(http:\/\/\S+)/.exec(out);
    if (match?.[1] !== undefined) {
      url = match[1];
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (url === "") {
    throw new Error(`the server never printed its URL.\nstdout:\n${out}\nstderr:\n${err}`);
  }

  return { child, url, stdout: () => out, stderr: () => err, exited };
}

/**
 * Ends a server the way an operator does, and reports what it did on the way out.
 *
 * The exit code is part of what is being smoke-tested: a shutdown that fails to close the
 * database must not report success, because a supervisor reads 0 as "stopped cleanly" and
 * restarts into a recovering WAL.
 */
async function stop(server: Server): Promise<{ code: number | null; noise: string }> {
  server.child.kill("SIGTERM");
  const raced = await Promise.race([
    server.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  if (raced === null) {
    server.child.kill("SIGKILL");
    return { code: null, noise: "did not exit within 15s of SIGTERM" };
  }
  return { code: raced.code, noise: appNoise(server.stderr()) };
}

/**
 * Node's own `ExperimentalWarning` for `node:sqlite` is not something this application
 * emits and not something it can suppress without also hiding warnings that would matter.
 * Filtering it here keeps "the app said nothing on the way out" a meaningful assertion.
 */
function appNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !line.startsWith("(Use `node"))
    .join("\n")
    .trim();
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: Buffer;
}

async function request(url: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(url, init);
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text: bytes.toString("utf8"), bytes };
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const answer = await request(url);
  return { status: answer.status, body: JSON.parse(answer.text) as T };
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const answer = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: answer.status, body: JSON.parse(answer.text) as T };
}

/** A workspace with one small repository in it. Not a fixture: fixtures are for the benchmark. */
function makeWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-smoke-"));
  const repository = path.join(workspace, "widget-service");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  writeFileSync(
    path.join(repository, "README.md"),
    "# widget-service\n\nAccepts widget orders over HTTP and writes them to Postgres.\n",
  );
  writeFileSync(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "widget-service", version: "1.0.0", dependencies: { express: "4.19.2", pg: "8.11.5" } }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(repository, "src", "server.js"),
    "import express from 'express';\nimport { save } from './store.js';\n\nexport const app = express();\napp.post('/widgets', async (request, response) => {\n  await save(request.body);\n  response.status(201).end();\n});\n",
  );
  writeFileSync(
    path.join(repository, "src", "store.js"),
    "import { Pool } from 'pg';\n\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\n\nexport async function save(widget) {\n  await pool.query('insert into widgets(body) values ($1)', [widget]);\n}\n",
  );
  return workspace;
}

interface Detail {
  id: string;
  status: string;
  summary: string | null;
  report: {
    components: unknown[];
    evidence: { id: string; sourceId: string | null; excerpt?: string }[];
  } | null;
  graph: { summary: { nodeCount: number }; nodes: { id: string; evidenceIds: string[] }[] } | null;
  questions: { id: string; answer: string }[];
}

async function main(): Promise<number> {
  if (!existsSync(TSX)) {
    process.stderr.write("tsx is not installed. Run `pnpm install` first.\n");
    return 1;
  }

  const workspace = makeWorkspace();
  const databaseDirectory = mkdtempSync(path.join(tmpdir(), "repo-arch-smoke-db-"));
  const database = path.join(databaseDirectory, "analyses.db");

  process.stdout.write(`Production smoke\n  workspace: ${workspace}\n  database:  ${database}\n`);

  let server: Server | undefined;
  let analysisId = "";

  try {
    step("1. start the shipped entry point");
    server = await start(workspace, database);
    check("binds a port and says where it is", /^http:\/\/127\.0\.0\.1:\d+$/.test(server.url), server.url);
    check("prints no error on the way up", appNoise(server.stderr()) === "", appNoise(server.stderr()));
    check(
      "reports its api key as set-or-absent, never as a value",
      /api key: {4}(<[^>]+>|not set)/.test(server.stdout()),
      server.stdout().split("\n").find((line) => line.startsWith("api key:")),
    );

    step("2. readiness");
    const health = await getJson<{ status: string; provider: string; model: string; durableAnalyses: boolean }>(
      `${server.url}/api/health`,
    );
    check("GET /api/health answers 200", health.status === 200, String(health.status));
    check("status is ok", health.body.status === "ok");
    check("reports the provider it started with", health.body.provider === "mock", health.body.provider);
    check("declares analyses durable", health.body.durableAnalyses === true);

    step("3. the page and the files it asks for");
    const shell = await request(`${server.url}/`);
    check("GET / answers 200 html", shell.status === 200 && shell.headers["content-type"] === "text/html; charset=utf-8");
    check("the shell asks for the entry module", shell.text.includes('src="/app.js"'));
    for (const asset of ["/app.js", "/ui.js", "/styles.css"]) {
      const served = await request(`${server.url}${asset}`);
      check(`GET ${asset} answers 200`, served.status === 200 && served.bytes.byteLength > 1_000, String(served.status));
    }
    check(
      "serves under a policy that forbids running anything it did not ship",
      (shell.headers["content-security-policy"] ?? "").includes("default-src 'none'"),
    );

    step("4. create an analysis");
    const repositories = await getJson<{ repositories: { path: string }[] }>(`${server.url}/api/repositories`);
    check(
      "the workspace's repository is offered",
      repositories.body.repositories.some((entry) => entry.path === "widget-service"),
      JSON.stringify(repositories.body.repositories.map((entry) => entry.path)),
    );
    const created = await postJson<{ id: string; status: string }>(`${server.url}/api/analyses`, {
      repository: "widget-service",
      system: "advanced",
    });
    check("POST /api/analyses is accepted, not awaited", created.status === 202, String(created.status));
    analysisId = created.body.id;
    check("it names the analysis it created", /^an-/.test(analysisId), analysisId);

    step("5. it is readable while the work is in flight");
    const inFlight = await getJson<Detail>(`${server.url}/api/analyses/${analysisId}`);
    check("readable at its id immediately", inFlight.status === 200, String(inFlight.status));
    check(
      "and it is doing something",
      ["queued", "running", "completed"].includes(inFlight.body.status),
      inFlight.body.status,
    );

    step("6. it completes");
    const deadline = Date.now() + 120_000;
    let detail: Detail | undefined;
    while (Date.now() < deadline) {
      const polled = await getJson<Detail>(`${server.url}/api/analyses/${analysisId}`);
      if (polled.body.status === "completed" || polled.body.status === "failed") {
        detail = polled.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("reaches a terminal status", detail !== undefined, "still running after 120s");
    check("and that status is completed", detail?.status === "completed", detail?.status ?? "(none)");

    step("7. the report reads back");
    check("it has a summary", (detail?.summary ?? "").length > 0);
    check("it has components", (detail?.report?.components.length ?? 0) > 0);
    check("it has evidence", (detail?.report?.evidence.length ?? 0) > 0);

    step("8. the architecture graph");
    check("the graph has more than one node", (detail?.graph?.summary.nodeCount ?? 0) > 1);
    check(
      "every node cites evidence",
      (detail?.graph?.nodes ?? []).every((node) => node.evidenceIds.length > 0),
    );

    step("9. a citation opens the artefact it came from");
    const cited = detail?.report?.evidence.find((item) => item.sourceId !== null);
    check("at least one citation has a source", cited !== undefined);
    if (cited !== undefined) {
      const opened = await getJson<{ analysisId: string; evidence: { id: string }; source: { text: string } | null }>(
        `${server.url}/api/analyses/${analysisId}/evidence/${cited.id}`,
      );
      check("the evidence route answers 200", opened.status === 200, String(opened.status));
      check("scoped to its owning analysis", opened.body.analysisId === analysisId);
      check("and it returns the artefact's text", (opened.body.source?.text.length ?? 0) > 0);
    }
    const foreign = await request(`${server.url}/api/analyses/${analysisId}/evidence/ev-not-issued-here`);
    check("an evidence id this analysis never issued is not served", foreign.status === 404, String(foreign.status));

    step("10. a question, answered and appended");
    const asked = await postJson<{ question: { id: string; answer: string } }>(
      `${server.url}/api/analyses/${analysisId}/questions`,
      { question: "Which module writes widgets to the database?" },
    );
    check("POST a question answers 201", asked.status === 201, String(asked.status));
    check("the answer is not empty", (asked.body.question?.answer ?? "").length > 0);
    const withQuestion = await getJson<Detail>(`${server.url}/api/analyses/${analysisId}`);
    check(
      "and it joined the record",
      withQuestion.body.questions.map((question) => question.id).includes(asked.body.question.id),
    );

    step("11. the PDF");
    const pdf = await request(`${server.url}/api/analyses/${analysisId}/export/pdf`);
    check("the export answers 200 as a pdf", pdf.status === 200 && pdf.headers["content-type"] === "application/pdf");
    check("it is a PDF", pdf.bytes.subarray(0, 5).toString("latin1") === "%PDF-", pdf.bytes.subarray(0, 8).toString("latin1"));
    check("and it names the file", (pdf.headers["content-disposition"] ?? "").startsWith("attachment; filename="));

    step("12. shutdown, then a restart that can still read it");
    const first = await stop(server);
    check("SIGTERM exits 0", first.code === 0, `exit ${String(first.code)}`);
    check("and says nothing on the way out", first.noise === "", first.noise);
    check(
      "leaves no WAL or shared-memory file behind",
      readdirSync(databaseDirectory).every((entry) => !entry.endsWith("-wal") && !entry.endsWith("-shm")),
      readdirSync(databaseDirectory).join(", "),
    );

    server = await start(workspace, database);
    const survived = await getJson<Detail>(`${server.url}/api/analyses/${analysisId}`);
    check("a second process reads the analysis back", survived.status === 200, String(survived.status));
    check("with its status intact", survived.body.status === "completed", survived.body.status);
    check("and its questions intact", survived.body.questions.length > 0, String(survived.body.questions.length));

    step("13. delete a finished analysis");
    const deleted = await request(`${server.url}/api/analyses/${analysisId}`, { method: "DELETE" });
    const deletedBody = JSON.parse(deleted.text) as { deleted: string; cancelled: boolean };
    check("DELETE answers 200", deleted.status === 200, String(deleted.status));
    check("it names what it deleted", deletedBody.deleted === analysisId);
    check(
      "and reports no cancellation, because nothing was running",
      deletedBody.cancelled === false,
      String(deletedBody.cancelled),
    );

    step("14. it is gone");
    const gone = await request(`${server.url}/api/analyses/${analysisId}`);
    check("the analysis is 404 afterwards", gone.status === 404, String(gone.status));
    check("and the message does not leak a path", !gone.text.includes(databaseDirectory));

    step("15. clean shutdown");
    const second = await stop(server);
    server = undefined;
    check("SIGTERM exits 0", second.code === 0, `exit ${String(second.code)}`);
    check("and says nothing on the way out", second.noise === "", second.noise);
    check(
      "leaves no WAL or shared-memory file behind",
      readdirSync(databaseDirectory).every((entry) => !entry.endsWith("-wal") && !entry.endsWith("-shm")),
      readdirSync(databaseDirectory).join(", "),
    );
  } finally {
    if (server !== undefined) await stop(server);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(databaseDirectory, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${failures === 0 ? "OK" : "FAILED"} — ${String(checks - failures)}/${String(checks)} checks passed\n`,
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\nproduction smoke could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
