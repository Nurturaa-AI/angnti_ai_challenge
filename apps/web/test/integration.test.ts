import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_EXPLORATION_BUDGET, DEFAULT_PRECISION_POLICY, createLlmClient, type AnalysisConfig } from "@repo-arch/shared";
import type { AnalysisReport, AnsweredQuestion, ArchitectureGraph } from "@repo-arch/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServer, type RunningServer } from "../src/server";

/**
 * The whole product, over a socket, offline.
 *
 * `api.test.ts` calls the routes as functions; this one starts the real server on a real
 * port and walks the flow a person walks: load the page, analyse a repository, read the
 * dashboard, ask a question, open a citation, download the PDF. Everything a browser
 * would do, done the way a browser does it, so the parts only HTTP can get wrong are
 * covered — the headers that make the page safe to render untrusted repository text in,
 * the `Host` and `Origin` checks that keep a web page on the internet from driving a file
 * reader on localhost, the body cap, and the download itself.
 *
 * The model is the deterministic mock provider, so no network is touched and the flow is
 * the same one `--mock` gives a user.
 */

const SECRET = "AKIAIOSFODNN7EXAMPLE";

let base: string;
let workspace: string;
let server: RunningServer;

const config: AnalysisConfig = {
  provider: "mock",
  model: "mock-integration-model",
  seed: 11,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
  apiKey: undefined,
};

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
  text: string;
}

interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * One HTTP request, with the headers under the test's control.
 *
 * `node:http` rather than `fetch`, for two reasons: `fetch` refuses to send a `Host` that
 * disagrees with the URL — which is the whole of the DNS-rebinding test — and its
 * connection pool outlives the request, which would leave `server.close()` waiting on an
 * idle socket. `agent: false` gives every request its own connection and closes it.
 */
function raw(target: RunningServer, urlPath: string, options: RawOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const request = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: options.method ?? "GET",
        path: urlPath,
        headers: options.headers ?? {},
        agent: false,
      },
      (response) => {
        responded = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes,
            text: bytes.toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    // A refused body is answered and then the socket is dropped, so a reset that arrives
    // after the response is not a failure — the answer is already in hand.
    request.on("error", (error) => {
      if (!responded) reject(error);
    });
    request.end(options.body);
  });
}

async function postJson(urlPath: string, body: unknown, extra: Record<string, string> = {}): Promise<RawResponse> {
  return await raw(server, urlPath, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

/** Asserts the status and parses the body, typed by the caller. */
function json<T>(response: RawResponse, status = 200): T {
  expect({ status: response.status, body: response.text.slice(0, 400) }).toMatchObject({ status });
  return JSON.parse(response.text) as T;
}

function write(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

beforeAll(async () => {
  base = mkdtempSync(path.join(tmpdir(), "repo-arch-integration-"));
  workspace = path.join(base, "workspace");
  const repository = path.join(workspace, "orders");

  write(repository, "README.md", `# orders\n\nAccepts orders and stores them. Key ${SECRET}\n`);
  write(repository, "package.json", '{ "name": "orders", "dependencies": { "pg": "^8.11.3" } }\n');
  write(repository, "src/router.ts", "export function route(request) {\n  return store.write(request.body);\n}\n");
  write(
    repository,
    "src/store.ts",
    "import { Pool } from 'pg';\n\nexport async function write(record) {\n  await pool.query('insert into records values ($1)', [record]);\n}\n",
  );
  write(repository, "test/router.test.ts", "import { route } from '../src/router';\ntest('routes', () => {});\n");

  server = await startWebServer({
    host: "127.0.0.1",
    port: 0, // The OS picks, so a developer's own server on 4173 is never in the way.
    workspaceRoot: workspace,
    config,
    budget: DEFAULT_EXPLORATION_BUDGET,
    precisionPolicy: DEFAULT_PRECISION_POLICY,
    client: createLlmClient(config),
  });
});

afterAll(async () => {
  if (server) await server.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("the web application over HTTP", () => {
  it("walks analyse → dashboard → question → evidence → export, over the wire", async () => {
    // 1. The page. A browser asks for the shell before it asks for anything else.
    const shell = await raw(server, "/");
    expect(shell.status).toBe(200);
    expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(shell.text).toContain("<title>Repo Archaeologist</title>");
    expect(shell.text).toContain('src="/app.js"');

    for (const [asset, contentType] of [
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/styles.css", "text/css; charset=utf-8"],
    ] as const) {
      const served = await raw(server, asset);
      expect(served.status).toBe(200);
      expect(served.headers["content-type"]).toBe(contentType);
      expect(served.bytes.byteLength).toBeGreaterThan(1_000);
    }

    // 2. What the UI needs to render its form: the workspace's repositories, and the
    // server's own description of its limits.
    const health = json<Record<string, unknown>>(await raw(server, "/api/health"));
    expect(health["status"]).toBe("ok");
    expect(health["provider"]).toBe("mock");
    expect(health["exportFormats"]).toEqual(["pdf"]);

    const listed = json<{ repositories: { path: string; name: string }[] }>(await raw(server, "/api/repositories"));
    expect(listed.repositories.map((entry) => entry.path)).toContain("orders");

    // 3. The analysis. The whole advanced pipeline, behind one POST.
    const created = json<{
      id: string;
      report: AnalysisReport;
      graph: ArchitectureGraph;
      questions: AnsweredQuestion[];
    }>(await postJson("/api/analyze", { repository: "orders" }), 201);

    expect(created.report.repository.name).toBe("orders");
    expect(created.report.repository.path).toBe("orders");
    expect(created.report.evidence.length).toBeGreaterThan(0);
    expect(created.graph.summary.nodeCount).toBeGreaterThan(1);
    for (const node of created.graph.nodes) expect(node.evidenceIds.length).toBeGreaterThan(0);

    // The repository's credential does not survive the trip out, and neither does the
    // path of the machine the server is running on.
    expect(shell.text).not.toContain(SECRET);
    const dashboardBody = (await raw(server, `/api/analysis/${created.id}`)).text;
    expect(dashboardBody).not.toContain(SECRET);
    expect(dashboardBody).not.toContain(workspace);
    expect(dashboardBody).not.toContain(tmpdir());

    // 4. The dashboard reload: analysed once, read back by id.
    const reloaded = json<{ id: string; report: AnalysisReport }>(await raw(server, `/api/analysis/${created.id}`));
    expect(reloaded.id).toBe(created.id);
    expect(reloaded.report.finishedAt).toBe(created.report.finishedAt);

    // 5. A question, answered against the analysis that is already in memory.
    const asked = json<{ analysisId: string; question: AnsweredQuestion }>(
      await postJson("/api/questions", {
        analysisId: created.id,
        question: "Which module writes records to the database?",
      }),
      201,
    );
    expect(asked.question.id).toBe("q-1");
    expect(asked.question.answer.length).toBeGreaterThan(0);
    for (const citation of asked.question.citations) {
      expect(citation.id.startsWith("q-1-ev-")).toBe(true);
      expect(asked.question.inspectedSources).toContain(citation.sourceId);
    }

    // The answer joins the analysis, so a reader arriving later sees the conversation.
    const withQuestion = json<{ questions: AnsweredQuestion[] }>(await raw(server, `/api/analysis/${created.id}`));
    expect(withQuestion.questions.map((question) => question.id)).toEqual(["q-1"]);

    // 6. A citation, opened. This is the point of the whole application: the claim leads
    // back to the text it came from.
    const cited = created.report.evidence.find((item) => item.sourceId !== null);
    expect(cited).toBeDefined();
    const evidence = json<{
      analysisId: string;
      evidence: { id: string };
      source: { id: string; text: string; excerptMatch: { start: number; end: number } | null } | null;
    }>(await raw(server, `/api/analysis/${created.id}/evidence/${cited?.id ?? ""}`));

    expect(evidence.analysisId).toBe(created.id);
    expect(evidence.evidence.id).toBe(cited?.id);
    expect(evidence.source?.text.length).toBeGreaterThan(0);
    if (cited?.excerpt !== undefined && evidence.source?.excerptMatch) {
      const { start, end } = evidence.source.excerptMatch;
      expect(evidence.source.text.slice(start, end).replace(/\s+/g, " ").trim().toLowerCase()).toBe(
        cited.excerpt.replace(/\s+/g, " ").trim().toLowerCase(),
      );
    }

    // 7. The download. The UI navigates to this URL, so it must answer a plain GET with
    // no `Origin` — a navigation sends none — and name the file itself.
    const pdf = await raw(server, `/api/analysis/${created.id}/export/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toMatch(/^attachment; filename="repo-analysis-orders-advanced-ord/);
    expect(pdf.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.bytes.byteLength).toBeGreaterThan(4_000);
    expect(pdf.bytes.toString("latin1")).not.toContain(SECRET);
    expect(Number(pdf.headers["content-length"])).toBe(pdf.bytes.byteLength);

    // 8. And the run is in the list the sidebar renders.
    const analyses = json<{ analyses: { id: string; questionCount: number }[] }>(await raw(server, "/api/analyses"));
    expect(analyses.analyses[0]).toMatchObject({ id: created.id, questionCount: 1 });
  });

  it("sends the headers that make untrusted repository text safe to render", async () => {
    // The dashboard prints names, paths and excerpts taken from a repository nobody
    // vetted. `default-src 'none'` is what makes a successful injection inert.
    for (const urlPath of ["/", "/app.js", "/api/health"]) {
      const response = await raw(server, urlPath);
      const csp = String(response.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
      // An analysis holds repository contents; a cached copy on disk is a copy nobody
      // asked for.
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers only to a loopback Host, so a rebound DNS name cannot reach it", async () => {
    const rebound = await raw(server, "/api/health", { headers: { host: "repo-arch.attacker.example" } });
    expect(rebound.status).toBe(421);
    expect(rebound.text).toContain("localhost only");

    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, "[::1]"]) {
      const allowed = await raw(server, "/api/health", { headers: { host } });
      expect(allowed.status).toBe(200);
    }
  });

  it("refuses a cross-origin request, and allows its own", async () => {
    const foreign = await postJson("/api/analyze", { repository: "orders" }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.text).toContain("Cross-origin requests are refused.");

    // Same origin: the UI's own fetch. Rejected later for a bad body, not at the door.
    const ours = await postJson("/api/analyze", {}, { origin: `http://127.0.0.1:${server.port}` });
    expect(ours.status).toBe(400);
    expect(ours.text).toContain("repository");
  });

  it("refuses a body larger than the cap without reading it", async () => {
    const oversized = await postJson("/api/questions", {
      analysisId: "advanced-orders",
      question: "x".repeat(1024 * 1024 + 64),
    });
    const body = json<{ error: { name: string; hint: string } }>(oversized, 413);
    expect(body.error.name).toBe("RequestError");
    expect(body.error.hint).toContain(String(1024 * 1024));
  });

  it("refuses a body that is not JSON, and a request that is not a route", async () => {
    const broken = await raw(server, "/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"repository": "orders"',
    });
    expect(json<{ error: { message: string } }>(broken, 400).error.message).toBe("The request body is not valid JSON.");

    const noRoute = await raw(server, "/api/nothing-here");
    expect(json<{ error: { message: string } }>(noRoute, 404).error.message).toContain("No route for GET");

    const wrongMethod = await postJson("/api/health", {});
    expect(json<{ error: { message: string } }>(wrongMethod, 400).error.message).toContain("not allowed");
  });

  it("serves no file the UI does not ship, and nothing outside its own directory", async () => {
    // The real asset directory has nothing to traverse to, so this check gets its own
    // server over a directory that does: a sibling of the assets, and a file with an
    // extension the UI never serves.
    const publicDir = path.join(base, "public");
    write(publicDir, "index.html", "<!doctype html><title>shell</title>\n");
    write(publicDir, "notes.env", "TOKEN=super-secret\n");
    write(base, "outside.html", "<!doctype html><title>outside</title>\n");

    const isolated = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      publicDir,
      workspaceRoot: workspace,
      config,
      budget: DEFAULT_EXPLORATION_BUDGET,
      precisionPolicy: DEFAULT_PRECISION_POLICY,
      client: createLlmClient(config),
    });

    try {
      expect((await raw(isolated, "/")).status).toBe(200);
      // An extension the UI does not ship is not served, whatever it holds.
      const env = await raw(isolated, "/notes.env");
      expect(env.status).toBe(404);
      expect(env.text).not.toContain("super-secret");

      for (const attempt of ["/..%2Foutside.html", "/%2e%2e/outside.html", "/missing.js", "/nested/deep.css"]) {
        const response = await raw(isolated, attempt);
        expect(response.status).toBe(404);
        expect(response.text).not.toContain("outside");
      }
      // An absolute path is a path outside the directory, and refused as one.
      expect((await raw(isolated, `/${path.join(base, "outside.html")}`)).status).toBe(404);
    } finally {
      await isolated.close();
    }
  });

  it("keeps the workspace boundary over HTTP, exactly as the route layer does", async () => {
    // The boundary lives in one place and is tested there; this is the check that the
    // transport does not decode, normalise or otherwise smuggle a path past it.
    for (const repository of ["../", "orders/../..", "/etc", "node_modules", "orders\u0000/etc/passwd"]) {
      const refused = await postJson("/api/analyze", { repository });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refused.text).not.toContain("passwd");
    }
    // A percent-encoded traversal is refused too, and for a plainer reason than the
    // others: the repository is a body field, so nothing anywhere decodes it, and
    // `%2e%2e` stays a directory name that does not exist.
    const encoded = await postJson("/api/analyze", { repository: "%2e%2e/outside" });
    expect(encoded.status).toBe(400);
  });

  it("records what the run cost, and nothing it read", async () => {
    const events = server.api.metrics.snapshot();
    expect(events.map((event) => event.kind)).toContain("analysis");
    expect(events.map((event) => event.kind)).toContain("question");
    expect(events.map((event) => event.kind)).toContain("export");

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("insert into records");
    expect(serialised).not.toContain(workspace);
  });
});
