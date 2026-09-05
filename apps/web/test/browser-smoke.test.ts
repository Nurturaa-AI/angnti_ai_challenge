/**
 * The dashboard, executed.
 *
 * `wiring.test.ts` reads the shipped files as text and `ui.test.ts` imports the pure
 * helpers. Neither runs `app.js`. That gap is not theoretical — the defect
 * `wiring.test.ts` was written for was a blank page whose every unit test passed —
 * and static analysis can only ever narrow it: a check that a function is imported
 * and mentioned cannot tell you whether calling it throws.
 *
 * So this suite loads the real `index.html` into a DOM, evaluates the real `app.js`
 * against it, and lets it talk to the real API over a real HTTP socket, with the
 * real store behind it. From `boot()` onward nothing here is a stub except the model
 * provider, which is the same deterministic mock a user gets with `--mock`.
 *
 * **What this is not.** jsdom is a DOM implementation, not a browser. It has no
 * layout engine, so nothing here can prove an element is visible, positioned,
 * legible, or on screen; it does not apply the stylesheet, so a missing CSS rule
 * passes; it renders no SVG geometry; and it enforces no CSP, so the server's
 * `default-src 'none'` is asserted on the response header rather than observed. A
 * real browser gate — Playwright and a downloaded Chromium — would cover those. It
 * is not proportionate for a local, single-user, no-build-step dashboard, and
 * claiming this suite is equivalent to one would be false.
 *
 * Three browser APIs the page needs are missing from jsdom and are supplied below:
 * `matchMedia`, `fetch` and `EventSource`. Each is a transport or a viewport fact,
 * none is application logic, and the last two carry real HTTP to the real routes —
 * a stub there would have turned every assertion about what the server said into an
 * assertion about this file.
 *
 * What it does prove is the part that kept breaking: the entry module executes, the
 * page it builds is the page the server serves, the panels the product promises
 * appear with real data in them, and the interactions a keyboard user depends on
 * are wired to something that runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  DEFAULT_EXPLORATION_BUDGET,
  DEFAULT_PRECISION_POLICY,
  createLlmClient,
  loadConfig,
  type AnalysisConfig,
} from "@repo-arch/shared";
import { MEMORY_DATABASE, SqliteAnalysisStore, type AnalysisStore } from "@repo-arch/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServer } from "../src/server";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

let workspace: string;
let server: Awaited<ReturnType<typeof startWebServer>>;
let store: AnalysisStore;
let config: AnalysisConfig;

/** Errors the page threw while it was running. Empty is the assertion. */
let pageErrors: string[] = [];
let dom: JSDOM;

/**
 * The DOM types, taken from the jsdom window rather than from a global `lib`.
 *
 * The project compiles with `"lib": ["ES2023"]` and no DOM, which is correct for a
 * Node codebase: it is what stops a server module from reaching for `document` and
 * typechecking anyway. Widening the lib for one test file would remove that guard
 * everywhere, so the handful of element types this file needs are read off the
 * window instance instead — the same types, scoped to the one place with a DOM.
 */
type Win = JSDOM["window"];
type Doc = Win["document"];
type El = ReturnType<Doc["createElement"]>;

const doc = (): Doc => dom.window.document;
const $ = (id: string): El | null => doc().getElementById(id);
const text = (): string => doc().body.textContent ?? "";

/** Lets the page's own promise chain drain before the next assertion. */
async function settle(times = 6): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls until the page shows what was asked for, or gives up loudly. */
async function until(label: string, ready: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await settle(1);
  }
  throw new Error(
    `timed out waiting for ${label}.\n` +
      `Load error: ${(dom.window as { __loadError?: string }).__loadError ?? "none"}\n` +
      `Page errors: ${pageErrors.join(" | ") || "none"}\n` +
      `Body began: ${text().slice(0, 400)}`,
  );
}

/**
 * `EventSource`, over the real stream.
 *
 * jsdom does not implement it, and `app.js` returns early without one — deliberately,
 * since a browser that lacks it should degrade rather than throw. Leaving the gap
 * there would have quietly excused this suite from the product's headline behaviour:
 * the progress panel, the phase messages and the re-read that follows a terminal
 * event are all reached through this class and through nothing else. `watch()` is
 * `EventSource` or nothing — there is no polling fallback to fall back to.
 *
 * So it is implemented rather than skipped. What it does is parse `text/event-stream`
 * off a real socket: connect, split frames on the blank line, read `event:` and
 * `data:`, deliver. It decides nothing about analyses and synthesises no event; every
 * frame it dispatches was written by `routeEvents`. `close()` aborts the request, as
 * the real one does, and reaching the end of the body moves it to `CLOSED` and fires
 * `error`, which is the state `app.js` checks before it reports a dropped connection.
 *
 * Two things it is not: it does not reconnect (the spec's retry behaviour is the
 * browser's, and no test here severs a connection mid-run), and it exposes no
 * `onmessage`, because the page uses `addEventListener` for its named events.
 */
class StreamBridge {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = StreamBridge.CONNECTING;

  readonly #listeners = new Map<string, ((event: { type: string; data: string }) => void)[]>();
  readonly #abort = new AbortController();

  constructor(url: string) {
    void this.#pump(url);
  }

  addEventListener(type: string, handler: (event: { type: string; data: string }) => void): void {
    const existing = this.#listeners.get(type);
    if (existing) existing.push(handler);
    else this.#listeners.set(type, [handler]);
  }

  close(): void {
    this.readyState = StreamBridge.CLOSED;
    this.#abort.abort();
  }

  async #pump(url: string): Promise<void> {
    try {
      const response = await fetch(new URL(url, server.url), {
        headers: { accept: "text/event-stream" },
        signal: this.#abort.signal,
      });
      this.readyState = StreamBridge.OPEN;

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("the event stream had no body");

      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          this.#dispatch(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      // An abort is this class closing itself and is not worth reporting; anything
      // else is a transport failure the page would have seen too.
      if (this.readyState !== StreamBridge.CLOSED) pageErrors.push(`stream: ${String(error)}`);
    } finally {
      const wasOpen = this.readyState !== StreamBridge.CLOSED;
      this.readyState = StreamBridge.CLOSED;
      if (wasOpen) this.#emit("error", "");
    }
  }

  /** One frame: `event: <name>` and one or more `data:` lines, comments ignored. */
  #dispatch(frame: string): void {
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) type = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) this.#emit(type, data.join("\n"));
  }

  #emit(type: string, data: string): void {
    for (const handler of this.#listeners.get(type) ?? []) {
      // A handler is page code. Letting it throw into `#pump` would bury a real
      // defect in this class's catch and turn a broken page into a quiet one.
      try {
        handler({ type, data });
      } catch (error) {
        pageErrors.push(`stream handler (${type}): ${String(error)}`);
      }
    }
  }
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "repo-arch-browser-"));
  mkdirSync(path.join(workspace, "widget", "src"), { recursive: true });
  writeFileSync(
    path.join(workspace, "widget", "README.md"),
    "# widget\n\nA dispatcher that routes commands to handlers.\n",
  );
  writeFileSync(
    path.join(workspace, "widget", "src", "dispatch.js"),
    "export function dispatch(command) {\n  return handlers[command.type](command);\n}\n",
  );
  writeFileSync(
    path.join(workspace, "widget", "package.json"),
    JSON.stringify({ name: "widget", version: "1.0.0" }, null, 2),
  );

  config = loadConfig({ provider: "mock" });
  store = new SqliteAnalysisStore({ location: MEMORY_DATABASE });
  server = await startWebServer({
    workspaceRoot: workspace,
    config,
    budget: DEFAULT_EXPLORATION_BUDGET,
    precisionPolicy: DEFAULT_PRECISION_POLICY,
    client: createLlmClient(config),
    store,
    host: "127.0.0.1",
    port: 0,
    provenance: "browser-smoke",
  });

  // The page as the server serves it, not a copy: if the shell and the script ever
  // disagree about what exists, that disagreement is what this suite should see.
  const shell = await (await fetch(server.url)).text();

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => pageErrors.push(String(error.message)));
  virtualConsole.on("error", (...args: unknown[]) => pageErrors.push(args.map(String).join(" ")));

  dom = new JSDOM(shell, {
    url: server.url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });

  // Two things jsdom does not implement that the page legitimately uses. Both are
  // stubbed as narrowly as possible: `matchMedia` reports a wide viewport because
  // that is the layout the assertions below describe, and `scrollIntoView` does
  // nothing because there is nothing to scroll. Neither stubs any application logic.
  Object.defineProperty(dom.window, "matchMedia", {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      addListener: (): void => {},
      removeListener: (): void => {},
      onchange: null,
      dispatchEvent: (): boolean => false,
    }),
  });
  Object.defineProperty(dom.window.Element.prototype, "scrollIntoView", { value: (): void => {} });

  // jsdom implements no `fetch`, so the page is given Node's — pointed at the running
  // server, with relative paths resolved against its origin, which is what a browser
  // does with the same call. This is a transport shim and nothing more: the requests
  // are real HTTP over a real socket to the real routes, and no response is
  // synthesised. Had it been stubbed instead, every assertion below about what the
  // server said would have been an assertion about this file.
  Object.defineProperty(dom.window, "fetch", {
    value: (input: string | { url: string }, init?: RequestInit): Promise<Response> => {
      const target = typeof input === "string" ? input : input.url;
      return fetch(new URL(target, server.url), init);
    },
  });
  Object.defineProperty(dom.window, "EventSource", { value: StreamBridge });

  // Two shapes jsdom delivers to these listeners. Declared inline rather than
  // pulled from a DOM lib, for the reason `jsdom.d.ts` sets out at length.
  dom.window.addEventListener("error", (event: { message?: unknown }) =>
    pageErrors.push(String(event.message)),
  );
  dom.window.addEventListener("unhandledrejection", (event: { reason?: unknown }) =>
    pageErrors.push(String(event.reason)),
  );

  // jsdom will not execute `<script type="module">`, and its classic scripts have no
  // dynamic-import callback either, so the two modules are linked by hand: `ui.js`
  // with its `export` keywords removed, followed by `app.js` with its import
  // statement removed, evaluated as one classic script.
  //
  // The transformation is mechanical and is the whole of it — no function body, no
  // call, no constant is touched, and both files are read from the directory the
  // server serves. What it costs is module semantics: this is one shared scope
  // rather than two linked ones, so a name collision between the files would be
  // masked here. That exact defect is what `wiring.test.ts` checks statically, which
  // is why the two suites are worth having together.
  const uiJs = await readFile(path.join(PUBLIC_DIR, "ui.js"), "utf8");
  const appJs = await readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const linked = [
    uiJs.replace(/^export (function|const|class|let|var) /gm, "$1 "),
    appJs.replace(/import \{[^}]+\} from "\/ui\.js";/, ""),
  ].join("\n\n");

  const loader = doc().createElement("script");
  loader.textContent =
    `try {\n${linked}\n} catch (error) { window.__loadError = String((error && error.stack) || error); }`;
  doc().body.append(loader);
  // Then taken straight back out. An inline script runs synchronously on insertion,
  // so by here it has already executed — but a script node's source counts towards
  // `body.textContent`, and leaving it in the tree makes every text assertion in this
  // file match the program's own source instead of the page. That is not a small
  // detail: with the node in place, waiting for the word "Evidence" or "widget"
  // succeeds before the server has been asked for anything at all.
  loader.remove();

  // `boot()` fills `#provider` from `/api/health` and only then awaits the repository
  // and analysis lists, so waiting on the health line alone returns while the
  // repository `<select>` is still empty — which is what an earlier version of this
  // wait did, and it made the next test look like a product defect.
  await until(
    "the dashboard to finish booting",
    () =>
      $("provider")?.textContent !== "" && doc().querySelectorAll("#repository option").length > 0,
  );
}, 60_000);

afterAll(async () => {
  dom?.window.close();
  await server?.close();
  await store?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("the shipped page loads and runs", () => {
  it("executes the entry module without a startup error", () => {
    const loadError = (dom.window as unknown as { __loadError?: string }).__loadError;
    expect(loadError).toBeUndefined();
    // The check `wiring.test.ts` can only approximate. A duplicate declaration, a
    // missing export or a throw in module scope all land here.
    expect(pageErrors).toEqual([]);
  });

  it("reaches the API and reports what the server actually said", () => {
    // Rendered from `GET /api/health`, so a page that painted without the server
    // answering cannot pass this.
    expect($("provider")?.textContent).toContain("mock");
    const systems = $("system")?.textContent ?? "";
    expect(systems).toContain("advanced");
    expect(systems).toContain("baseline");
  });

  it("offers the workspace's repositories, and only those", () => {
    const options = [...doc().querySelectorAll("#repository option")].map((node) => node.textContent);
    expect(options.join(" ")).toContain("widget");
    // The workspace is named in the shell, never located on this machine.
    expect(doc().documentElement.outerHTML).not.toContain(workspace);
  });

  it("serves the page under a policy that forbids running anything it did not ship", async () => {
    // jsdom does not enforce CSP, so this is asserted on the wire rather than
    // observed in the page — a limitation, stated where it applies.
    const response = await fetch(server.url);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("analysing a repository from the browser", () => {
  beforeAll(async () => {
    const form = $("analyse-form");
    expect(form).not.toBeNull();
    const repository = $("repository");
    expect(repository).not.toBeNull();
    if (repository !== null) repository.value = "widget";

    // A real submit event through the real listener. Nothing calls an internal
    // function: if the form is not wired, nothing happens and the wait below fails.
    form?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    // A signal the static shell cannot produce, and one only a completed run reaches.
    // An earlier version waited for the word "Evidence", which `index.html` already
    // carries twice as drawer labels, so it returned before the run had started and
    // made the assertions below look like product defects. "citations grounded" is a
    // stat label written by `renderOverview`, which runs only after the stream's
    // terminal event has made `refreshAfterTerminal` re-read a completed record.
    await until(
      "the analysis to finish and render",
      () => text().includes("citations grounded"),
      45_000,
    );
  }, 90_000);

  it("shows the finished analysis, with its evidence", () => {
    expect(pageErrors).toEqual([]);
    const body = text();
    // Written by `renderOverview` from the stored record: the repository it read, the
    // build that read it, and the model. A page that painted a shell cannot have these.
    expect(body).toContain("widget");
    expect(body).toContain("advanced v");
    expect(body).toContain("citations grounded");
    // The ledger the summary was checked against, rendered as the chips that open it.
    expect(doc().querySelectorAll("button.chip").length).toBeGreaterThan(0);
  });

  it("lists the analysis it just created", async () => {
    // Scoped to the list, because "widget" is also the heading of the open report and
    // a body-wide search would pass on that alone.
    await until(
      "the recent list to include the new analysis",
      () => ($("recent")?.textContent ?? "").includes("widget"),
    );
    expect($("recent")?.textContent ?? "").toContain("widget");
  });

  it("opens an evidence artefact in the drawer, and Escape closes it", async () => {
    // Asserted rather than skipped. The provider is the deterministic mock, so the
    // report it produces either cites artefacts or it does not; a suite that quietly
    // returns when the selector finds nothing is a gate that stops gating on the day
    // the chips disappear.
    const chip = doc().querySelector("button.chip");
    expect(chip).not.toBeNull();

    chip?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await until("the drawer to open", () => $("drawer")?.getAttribute("hidden") === null);
    // What the drawer opened on has to be the artefact, not an empty shell.
    expect($("drawer-body")?.textContent ?? "").not.toBe("");

    doc().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until("the drawer to close", () => $("drawer")?.getAttribute("hidden") !== null);
    expect(pageErrors).toEqual([]);
  });

  it("keeps a live region for the things a screen reader needs told", () => {
    // Wired in `index.html` and written to by `announce()`; asserted here because a
    // status message that never reaches a live region is one a screen-reader user
    // never hears, and nothing else in the suite would notice.
    const announce = $("announce");
    expect(announce).not.toBeNull();
    expect(announce?.getAttribute("aria-live")).toBeTruthy();
  });
});

describe("when the server says no", () => {
  it("shows the error rather than a blank panel or a fabricated answer", async () => {
    const before = text();
    // A repository the workspace does not contain: a real 400 from the real route.
    const response = await fetch(new URL("/api/analyses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "../outside" }),
    });
    expect(response.status).toBe(400);

    const failure = (await response.json()) as { error?: { message?: string } };
    // The page renders what the server said. What matters for the browser gate is
    // that the message is safe to render at all: no path, no stack, no provider.
    expect(failure.error?.message ?? "").not.toContain(workspace);
    expect(before.length).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });
});
