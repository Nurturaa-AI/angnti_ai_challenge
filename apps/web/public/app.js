/*
 * The dashboard.
 *
 * Vanilla ES modules, no build step, no framework — the same choice the rest of this
 * repository makes, and for the same reason: a bundler and a component library would be
 * more infrastructure than the whole application layer it displays.
 *
 * Two rules run through the file:
 *
 *   1. Nothing is ever written with `innerHTML`. Every string on this page came out of
 *      an untrusted repository or a model, and `textContent` cannot be made to execute
 *      anything. That, plus the server's `default-src 'none'` CSP, means an injection has
 *      neither a way in nor anywhere to send what it found.
 *   2. A claim is never shown without its evidence. Wherever a claim appears, the chips
 *      beside it open the artefact it was read from — and a claim that lost its citations
 *      is marked, not quietly printed as though it were supported.
 *   3. The browser derives nothing. The architecture graph, every relationship in it and
 *      every citation come from the server; this file lays them out, filters them and
 *      draws them. There is no inference here, and there is no second analysis.
 *
 * Everything that decides *what* to show lives in `ui.js`, which is importable by a test.
 * What is left here is the part that needs a document: element construction, event
 * wiring, the SVG, the event stream and focus management.
 */

import {
  LARGE_GRAPH_NODES,
  NODE_COLOURS,
  SECTIONS,
  UNSUPPORTED_NOTICE,
  architectureOutline,
  countOmittedClaims,
  defaultGraphView,
  describeAnalysisRow,
  duration,
  edgeDetail,
  evidenceLineRange,
  evidenceLocationLabel,
  evidenceStrength,
  filterGraph,
  fmt,
  graphSummaryLabel,
  isRunningStatus,
  layoutGraph,
  nodeDetail,
  nodeMatchesSearch,
  phaseChecklist,
  progressLine,
  questionOutcome,
  relatedNodeIds,
  statusDescription,
  truncate,
} from "/ui.js";

/** Below this width the sidebar stacks and the graph opens as an outline. */
const NARROW_VIEWPORT = "(max-width: 860px)";

const state = {
  health: null,
  repositories: [],
  analyses: [],
  analysis: null,
  section: "overview",
  /** evidenceId -> payload from /evidence/:id, cached because the text is large. */
  evidence: new Map(),
  graph: {
    view: "diagram",
    scale: 1,
    x: 0,
    y: 0,
    /** `{ kind: "node" | "edge", id }`, because both are selectable now. */
    selected: null,
    search: "",
    hiddenTypes: new Set(),
    hiddenRelationships: new Set(),
    laidOut: null,
  },
  busy: false,
  /** The analysis list is a durable resource now, so it has its own load state. */
  list: { state: "loading", error: null },
  /** The open `EventSource`, and the id it is following. */
  stream: null,
  streamId: null,
  /** The last progress event for the open analysis, or `null`. */
  progress: null,
  /** The id whose delete button has been armed but not confirmed. */
  confirmDelete: null,
  /** A question that failed locally: never stored, so it lives only here. */
  questionError: null,
  narrow: false,
  /** What had focus before the drawer opened, so Escape can give it back. */
  drawerReturn: null,
};

// ------------------------------------------------------------------ helpers

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

function svgEl(tag, props, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "class") node.setAttribute("class", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "hidden") node.hidden = Boolean(value);
    // The server's CSP is `style-src 'self'` with no `'unsafe-inline'`, which covers the
    // style *attribute* too — so an inline style is silently dropped by the browser and
    // the element renders unstyled. Failing here instead turns that into something a
    // test catches, and keeps every colour and dimension in the stylesheet where the
    // rest of them already live. An SVG presentation attribute (`fill`, `stroke`) is not
    // a style and stays allowed.
    else if (key === "style") throw new Error("Inline styles are blocked by the CSP; add a class to styles.css.");
    else node.setAttribute(key, String(value));
  }
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const $ = (id) => document.getElementById(id);

/**
 * The status bar, and what a screen reader hears.
 *
 * Three elements, because a visual toast and an announcement have different
 * requirements. `#status` is the visible bar and is `aria-hidden`, so it is never read
 * twice. The two live regions beside it are always in the document and never hidden — a
 * region revealed in the same tick as its text changes is unreliably announced — and the
 * kind decides which one gets the text: an error goes to `role="alert"`, which interrupts,
 * and everything else to `role="status"`, which waits its turn.
 */
function toast(message, kind) {
  const bar = $("status");
  bar.textContent = message ?? "";
  bar.className = `status${kind ? ` ${kind}` : ""}`;
  bar.hidden = !message;

  const target = kind === "error" ? $("alert") : $("announce");
  const other = kind === "error" ? $("announce") : $("alert");
  other.textContent = "";
  // Same text twice is not re-announced, so clear first when it repeats.
  if (target.textContent === (message ?? "")) target.textContent = "";
  target.textContent = message ?? "";
}

// ---------------------------------------------------------------------- api

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const error = payload?.error;
    throw new Error(error ? `${error.message}${error.hint ? ` — ${error.hint}` : ""}` : `HTTP ${response.status}`);
  }
  return payload;
}

// --------------------------------------------------------------------- boot

async function boot() {
  $("analyse-form").addEventListener("submit", onAnalyse);
  $("drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  window.addEventListener("hashchange", () => {
    const next = location.hash.replace(/^#/, "");
    if (SECTIONS.some((section) => section.id === next)) {
      state.section = next;
      render();
    }
  });

  // The one place the layout breakpoint is read in JavaScript, and it decides exactly
  // one thing: which view the architecture section opens in. Everything else about the
  // narrow layout is CSS, because a stylesheet reflows without a repaint from here.
  const narrow = window.matchMedia(NARROW_VIEWPORT);
  state.narrow = narrow.matches;
  narrow.addEventListener("change", (event) => {
    state.narrow = event.matches;
  });

  // A live stream is a socket. Leaving the page should close it rather than leave the
  // server writing heartbeats into a response nobody will read.
  window.addEventListener("beforeunload", stopWatching);

  try {
    state.health = await api("/api/health");
    $("provider").textContent = `${state.health.provider} · ${state.health.model}`;
    const systems = $("system");
    for (const system of state.health.systems) {
      systems.append(el("option", { value: system, text: system, selected: system === state.health.defaultSystem }));
    }
  } catch (error) {
    toast(`Cannot reach the server: ${error.message}`, "error");
    return;
  }

  await Promise.all([loadRepositories(), loadAnalyses()]);
}

async function loadRepositories() {
  const { repositories } = await api("/api/repositories");
  state.repositories = repositories;
  const select = $("repository");
  clear(select);
  for (const repository of repositories) {
    select.append(
      el("option", {
        value: repository.path,
        text: `${repository.path === "." ? repository.name : repository.path}${repository.isGitRepository ? "" : "  (no .git)"}`,
      }),
    );
  }
}

// -------------------------------------------------------- the analysis list

/**
 * Reloads the durable analysis list.
 *
 * Fetch and render are separate because they fail differently. A list that could not be
 * fetched is an error the user needs to see and can retry; a list that is empty is a
 * normal state with its own words. Iteration 4 re-fetched on every `render()`, which was
 * affordable when the store was a Map in the same process and is not now that it is a
 * file — and which also meant a half-typed delete confirmation was wiped by an unrelated
 * repaint.
 */
async function loadAnalyses() {
  state.list = { state: state.analyses.length === 0 ? "loading" : "ready", error: null };
  renderAnalysisList();
  try {
    const { analyses } = await api("/api/analyses");
    state.analyses = analyses;
    state.list = { state: "ready", error: null };
  } catch (error) {
    state.list = { state: "error", error: error.message };
  }
  renderAnalysisList();
}

function renderAnalysisList() {
  const list = $("recent");
  if (!list) return;
  clear(list);

  if (state.list.state === "error") {
    list.append(
      el(
        "li",
        { class: "sidebar-note" },
        el("p", { class: "bad", text: `The analysis list could not be loaded: ${state.list.error}` }),
        el("button", { type: "button", class: "ghost", text: "Try again", onclick: () => void loadAnalyses() }),
      ),
    );
    return;
  }

  if (state.list.state === "loading" && state.analyses.length === 0) {
    list.append(el("li", { class: "sidebar-note", text: "Loading saved analyses…" }));
    return;
  }

  if (state.analyses.length === 0) {
    list.append(
      el("li", { class: "sidebar-note" }, el("p", { text: "No analyses yet." }), el("p", { text: "Run one above. It is saved to this workspace and will still be here after a restart." })),
    );
    return;
  }

  const now = Date.now();
  for (const summary of state.analyses) {
    const row = describeAnalysisRow(summary, now);
    const open = state.analysis?.id === row.id;

    list.append(
      el(
        "li",
        { class: `analysis-row${open ? " on" : ""}` },
        el(
          "button",
          {
            type: "button",
            class: "analysis-open",
            // `aria-current="true"`, not `aria-selected`: these are links to a page
            // region, not options in a listbox.
            "aria-current": open ? "true" : false,
            onclick: () => void openAnalysis(row.id),
          },
          el(
            "span",
            { class: "analysis-title" },
            el("span", { class: "analysis-name", text: row.name }),
            el("span", { class: `pill pill-${row.tone}`, text: row.statusLabel }),
          ),
          row.pathIsName ? null : el("span", { class: "analysis-path path", text: row.path }),
          el("span", { class: `analysis-summary${row.failed ? " bad" : ""}`, text: row.running ? row.progress : row.summary }),
          el(
            "span",
            { class: "analysis-times" },
            el("span", { title: row.createdAbsolute, text: `created ${row.created}` }),
            row.updatedSameAsCreated ? null : el("span", { title: row.updatedAbsolute, text: `updated ${row.updated}` }),
            el("span", { text: row.system }),
            row.questionCount === 0 ? null : el("span", { text: `${row.questionCount}q` }),
          ),
        ),
        deleteControl(row),
      ),
    );
  }
}

/**
 * Delete, in two steps.
 *
 * Deleting an analysis destroys its evidence — that is the point of it, and it is why a
 * single click is the wrong interaction. There is no `confirm()` dialog because the CSP
 * and the rest of this page keep every control in the document, and because a native
 * dialog is the one thing a keyboard user cannot navigate back out of. The armed state
 * lives in `state.confirmDelete`, so exactly one row can be armed at a time.
 */
function deleteControl(row) {
  if (state.confirmDelete !== row.id) {
    return el("button", {
      type: "button",
      class: "analysis-delete ghost",
      "aria-label": `Delete the analysis of ${row.name}`,
      text: "Delete",
      onclick: () => {
        state.confirmDelete = row.id;
        renderAnalysisList();
        // Focus follows the control the user was already on, so a keyboard user is not
        // dropped back at the top of the list.
        $("recent")?.querySelector(".analysis-confirm")?.focus();
      },
    });
  }

  return el(
    "span",
    { class: "analysis-confirm-group" },
    el("button", {
      type: "button",
      class: "analysis-confirm bad-button",
      "aria-label": `Confirm deleting the analysis of ${row.name}, and its evidence`,
      text: "Delete for good",
      onclick: () => void deleteAnalysis(row.id, row.name),
    }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Cancel",
      onclick: () => {
        state.confirmDelete = null;
        renderAnalysisList();
      },
    }),
  );
}

async function deleteAnalysis(id, name) {
  state.confirmDelete = null;
  try {
    const outcome = await api(`/api/analyses/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.analysis?.id === id) {
      // The record is gone, and so is the evidence its ids addressed. Dropping the
      // cache matters: a stale payload would let the drawer keep showing an excerpt
      // from an analysis the user just destroyed.
      stopWatching();
      state.analysis = null;
      state.evidence.clear();
      state.progress = null;
      closeDrawer();
    }
    // Deleting an analysis that is still running cancels it. Saying so matters:
    // the work stops and its result is discarded, and a user who deleted the wrong
    // row should learn that from the toast rather than from a run that never
    // appears.
    toast(
      outcome?.cancelled === true
        ? `Cancelled and deleted the analysis of ${name}. It was still running; its result was discarded.`
        : `Deleted the analysis of ${name}. Its evidence is no longer available.`,
    );
    setTimeout(() => toast(null), 6000);
    await loadAnalyses();
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

// ------------------------------------------------------- starting an analysis

async function onAnalyse(event) {
  event.preventDefault();
  if (state.busy) return;
  const repository = $("repository").value;
  const system = $("system").value;
  const focus = $("focus").value.trim();

  setBusy(true, `Starting an analysis of ${repository} with the ${system} system…`);
  try {
    // 202, and a durable record. The work continues on the server whether or not this
    // page stays open — which is the whole difference from Iteration 4, where closing
    // the tab abandoned the analysis mid-pipeline.
    const analysis = await api("/api/analyses", {
      method: "POST",
      body: { repository, system, ...(focus === "" ? {} : { focus }) },
    });
    adoptAnalysis(analysis);
    state.section = "overview";
    location.hash = "overview";
    toast(`Analysis ${analysis.id} queued. Progress appears below as each phase completes.`);
    watch(analysis.id);
    await loadAnalyses();
    render();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function openAnalysis(id) {
  setBusy(true, "Loading analysis…");
  try {
    adoptAnalysis(await api(`/api/analyses/${encodeURIComponent(id)}`));
    toast(null);
    // A running analysis opened from the list picks its stream up mid-flight: the
    // server replays the events it has already emitted before going live.
    if (isRunningStatus(state.analysis.status)) watch(id);
    render();
    await loadAnalyses();
    renderAnalysisList();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

/** Makes a fetched detail payload the open analysis, resetting everything derived. */
function adoptAnalysis(analysis) {
  stopWatching();
  state.analysis = analysis;
  state.evidence.clear();
  state.questionError = null;
  state.progress = analysis.phase === null ? null : { status: analysis.status, phase: analysis.phase, message: analysis.phaseMessage };
  resetGraphView();
  if (analysis.graph) state.graph.view = defaultGraphView(analysis.graph, state.narrow);
}

// ---------------------------------------------------------- progressive status

/**
 * Follows one analysis's event stream.
 *
 * `EventSource` and not a WebSocket, and not polling: the traffic is one-directional and
 * short-lived, the browser reconnects on its own, and the server can replay what a late
 * subscriber missed. Polling would have been simpler to write and would have made
 * "which phase is it in" a question answered up to an interval late.
 *
 * Each terminal event re-reads the analysis rather than assembling one from the event
 * payloads. The events say *what happened*; the record is what is true. Building a
 * report out of stream fragments is how a UI ends up showing something the store does
 * not contain.
 */
function watch(id) {
  stopWatching();
  if (typeof EventSource !== "function") return;

  const source = new EventSource(`/api/analyses/${encodeURIComponent(id)}/events`);
  state.stream = source;
  state.streamId = id;

  const on = (type, handler) => {
    source.addEventListener(type, (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      // A stream that outlived its analysis being closed, or a message for someone
      // else, is ignored rather than allowed to repaint the open record.
      if (payload.analysisId !== state.streamId) return;
      handler(payload);
    });
  };

  on("analysis.created", (payload) => {
    state.progress = { status: payload.status, phase: null, message: "Queued." };
    renderProgress();
  });

  on("analysis.started", (payload) => {
    state.progress = { status: payload.status, phase: null, message: "Checking the repository path." };
    if (state.analysis?.id === id) state.analysis = { ...state.analysis, status: payload.status };
    renderProgress();
    renderAnalysisList();
  });

  on("analysis.phase", (payload) => {
    state.progress = { status: "analyzing", phase: payload.phase, message: payload.message };
    if (state.analysis?.id === id) state.analysis = { ...state.analysis, status: "analyzing", phase: payload.phase, phaseMessage: payload.message };
    renderProgress();
    renderAnalysisList();
  });

  on("analysis.completed", (payload) => {
    stopWatching();
    toast(`Analysis finished in ${duration(payload.durationMs)}.`);
    setTimeout(() => toast(null), 8000);
    void refreshAfterTerminal(id);
  });

  on("analysis.failed", (payload) => {
    stopWatching();
    // The server's already-sanitised sentence, shown as it arrived. There is nothing
    // to add to it here, and anything this file appended would be a guess.
    toast(`Analysis failed: ${payload.error}`, "error");
    void refreshAfterTerminal(id);
  });

  source.addEventListener("error", () => {
    // `EventSource` retries by itself while the connection is merely interrupted; it
    // only reaches `CLOSED` when it has given up. Saying so beats a progress panel
    // that silently stops moving.
    if (source.readyState === EventSource.CLOSED && state.streamId === id) {
      state.stream = null;
      state.streamId = null;
      state.progress = state.progress === null ? null : { ...state.progress, disconnected: true };
      renderProgress();
    }
  });
}

function stopWatching() {
  if (state.stream) state.stream.close();
  state.stream = null;
  state.streamId = null;
}

/** Re-reads the record, the list and the page once an analysis reaches a terminal state. */
async function refreshAfterTerminal(id) {
  try {
    if (state.analysis?.id === id) {
      state.analysis = await api(`/api/analyses/${encodeURIComponent(id)}`);
      state.progress = null;
      resetGraphView();
      if (state.analysis.graph) state.graph.view = defaultGraphView(state.analysis.graph, state.narrow);
    }
    await loadAnalyses();
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The progress panel for a running analysis.
 *
 * Patched in place rather than through `render()`, because a phase arrives every few
 * seconds and rebuilding the page under the user each time would move the scroll
 * position and drop focus. It is a live region, so a screen reader hears each phase
 * without having to go looking for it.
 */
function renderProgress() {
  // The host is static in `index.html`, outside `<main>`, precisely so that `render()`
  // clearing the section body cannot take the progress panel with it.
  const host = $("progress");
  if (!host) return;
  clear(host);
  const progress = state.progress;
  if (progress === null) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const described = statusDescription(progress.status);
  host.append(
    el(
      "div",
      { class: "panel progress" },
      el(
        "h2",
        {},
        el("span", { class: `pill pill-${described.tone}`, text: described.label }),
        " ",
        el("span", { text: "Analysis in progress" }),
      ),
      el("p", { class: "prose", text: progressLine(progress.status, progress.phase, progress.message) }),
      el(
        "ol",
        { class: "phase-list" },
        phaseChecklist(progress.phase).map((step) =>
          el("li", {
            class: step.done ? "done" : step.active ? "active" : "",
            "aria-current": step.active ? "step" : false,
            text: step.label,
          }),
        ),
      ),
      progress.disconnected
        ? el("p", {
            class: "note",
            text:
              "The progress stream disconnected. The analysis is still running on the server — reopen it from the " +
              "list to pick the stream back up.",
          })
        : el("p", {
            class: "hint",
            text: "This analysis is saved already. You can close this page and open it again from the list.",
          }),
    ),
  );
}

function setBusy(busy, message) {
  state.busy = busy;
  $("analyse-button").disabled = busy;
  $("analyse-button").textContent = busy ? "Working…" : "Analyse";
  if (busy) toast(message, "busy");
}

// ------------------------------------------------------------------- render

function render() {
  renderNav();
  void loadAnalyses();
  const main = $("main");
  clear(main);

  if (!state.analysis) {
    main.append(
      el(
        "section",
        { class: "empty" },
        el("h1", { text: "Show me where you found it." }),
        el("p", {
          text:
            "Pick a repository and run an analysis. Every claim on the dashboard carries the citations " +
            "that support it, and every citation opens the artefact it was read from.",
        }),
      ),
    );
    return;
  }

  // A record that has not finished has no report, and every section renderer below
  // reads one. This is the ordinary state of a fresh run, not an edge case: both
  // submitting the form and opening a running analysis from the list adopt a record
  // whose `report` is null and then render. The progress panel has its own host
  // outside `<main>` and is already saying what is happening, so what belongs here is
  // a placeholder — not an empty dashboard, and not a report that does not exist.
  if (!state.analysis.report) {
    main.append(
      el(
        "section",
        { class: "empty" },
        el("h1", { text: "Reading the repository." }),
        el("p", {
          text:
            "The sections fill in as soon as the analysis finishes. This run is saved already — " +
            "closing the page will not stop it, and the list will still have it when you come back.",
        }),
      ),
    );
    return;
  }

  const renderer = {
    overview: renderOverview,
    architecture: renderArchitecture,
    components: renderComponents,
    flows: renderFlows,
    dependencies: renderDependencies,
    testing: renderTesting,
    evidence: renderEvidence,
    questions: renderQuestions,
    export: renderExport,
  }[state.section];
  main.append(...renderer(state.analysis));
}

function renderNav() {
  const nav = $("nav");
  clear(nav);
  const analysis = state.analysis;
  // Counts describe a finished report. While one is still running there is nothing to
  // count, and reaching for `report.components` here is what used to throw the moment
  // the form was submitted — the section labels still render, without their tallies.
  const counts =
    analysis && analysis.report
      ? {
          components: analysis.report.components.length,
          flows: analysis.report.flows.length,
          dependencies: analysis.report.dependencies.length,
          architecture: analysis.graph?.summary.nodeCount,
          evidence: analysis.report.evidence.length,
          questions: analysis.questions.length,
        }
      : {};

  for (const section of SECTIONS) {
    const count = counts[section.id];
    nav.append(
      el(
        "li",
        {},
        el(
          "a",
          {
            href: `#${section.id}`,
            class: state.section === section.id ? "on" : "",
            onclick: () => {
              state.section = section.id;
            },
          },
          el("span", { text: section.label }),
          count === undefined ? null : el("span", { class: "count", text: String(count) }),
        ),
      ),
    );
  }
}

function head(title, sub) {
  return el("div", { class: "section-head" }, el("h1", { text: title }), sub ? el("p", { class: "sub", text: sub }) : null);
}

/**
 * The evidence row under a claim.
 *
 * An empty list is not silence: a claim whose citations all failed grounding is labelled,
 * because the alternative is a sentence that looks exactly as trustworthy as one that
 * passed. The report keeps such claims rather than deleting them, and so does this.
 */
function evidenceRow(ids) {
  if (!ids || ids.length === 0) {
    return el(
      "div",
      { class: "evidence-row" },
      el("span", { class: "unsupported", text: "no grounded evidence" }),
    );
  }
  return el(
    "div",
    { class: "evidence-row" },
    el("span", { text: "Evidence" }),
    ids.map((id) =>
      el("button", { type: "button", class: "chip", text: id, onclick: () => void openEvidence(id) }),
    ),
  );
}

function stat(label, value, kind) {
  return el("div", { class: `stat${kind ? ` ${kind}` : ""}` }, el("b", { text: value }), el("span", { text: label }));
}

// ---------------------------------------------------------------- overview

function renderOverview(analysis) {
  const report = analysis.report;
  const metrics = report.metrics;
  const audit = report.audit;

  return [
    head(report.repository.name, `${report.repository.path} · ${report.system} v${report.systemVersion} · ${report.model}`),
    el(
      "div",
      { class: "stats" },
      stat("citations grounded", fmt(metrics.citationsGrounded), "good"),
      stat("citations dropped", fmt(metrics.citationsDropped), metrics.citationsDropped > 0 ? "warn" : undefined),
      stat("unsupported claims", fmt(metrics.unsupportedClaims), metrics.unsupportedClaims > 0 ? "warn" : undefined),
      stat("files inspected", fmt(metrics.filesInspected)),
      stat("ledger artefacts", fmt(metrics.ledgerSources)),
      stat("tool calls", fmt(metrics.toolCalls)),
      stat("duration", duration(metrics.durationMs)),
      stat("confidence", `${Math.round(report.confidence * 100)}%`),
    ),
    el(
      "div",
      { class: "panel" },
      el("h2", { text: "Summary" }),
      el("p", { class: "prose", text: report.summary }),
      el("h2", { class: "spaced", text: "Architecture, in prose" }),
      el("p", { class: "prose", text: report.architecture }),
      evidenceRow(report.overviewEvidenceIds),
    ),
    report.recommendedReading.length === 0
      ? null
      : el(
          "div",
          { class: "panel" },
          el("h2", { text: "Read these first" }),
          el(
            "ol",
            {},
            report.recommendedReading.map((entry) =>
              el(
                "li",
                {},
                el("span", { class: "path", text: entry.path }),
                " — ",
                el("span", { text: entry.why }),
              ),
            ),
          ),
        ),
    report.openQuestions.length === 0
      ? null
      : el(
          "div",
          { class: "panel" },
          el("h2", { text: "The analysis could not settle these" }),
          el("ul", { class: "plain" }, report.openQuestions.map((question) => el("li", { text: question }))),
        ),
    el(
      "div",
      { class: "panel" },
      el("h2", { text: "Evidence audit" }),
      el(
        "dl",
        { class: "kv" },
        el("dt", { text: "Claimed" }),
        el("dd", { text: `${fmt(audit.claimed)} citations` }),
        el("dt", { text: "Grounded" }),
        el("dd", { text: `${fmt(audit.grounded)} citations` }),
        el("dt", { text: "Dropped" }),
        el("dd", { text: `${fmt(audit.dropped.length)} citations` }),
        el("dt", { text: "Unsupported claims" }),
        el("dd", { text: fmt(audit.unsupportedClaims ?? metrics.unsupportedClaims) }),
      ),
      audit.dropped.length === 0
        ? el("p", { class: "note plain", text: "Every citation the model wrote resolved to an artefact it had actually read." })
        : el(
            "div",
            {},
            el("p", {
              class: "note",
              text:
                "These citations named something the analysis never read, or quoted text that is not in the " +
                "artefact they named. They were removed from every claim.",
            }),
            el(
              "ul",
              { class: "plain" },
              audit.dropped.slice(0, 40).map((drop) =>
                el("li", {}, el("span", { class: "path", text: drop.source }), " — ", el("span", { text: drop.reason })),
              ),
            ),
          ),
    ),
  ];
}

// ------------------------------------------------------------- architecture

/**
 * The architecture section: two views over one graph.
 *
 * The diagram is the default on a wide screen with a graph small enough to read; the
 * outline is the default otherwise, and either is always one click away. Both are built
 * from the same server-side `ReportGraph` — `architectureOutline` and `layoutGraph` are
 * two projections of it, not two traversals — so they cannot disagree about what the
 * repository contains. The filters and the search apply to both.
 */
function renderArchitecture(analysis) {
  const graph = analysis.graph;
  const summary = graph.summary;
  const outline = state.graph.view === "outline";

  const parts = [
    head(
      "Architecture",
      `${summary.nodeCount} nodes, ${summary.edgeCount} edges. Every one of them carries at least one grounded citation.`,
    ),
    summary.nodesSkippedWithoutEvidence + summary.edgesSkippedWithoutEvidence === 0
      ? null
      : el("p", {
          class: "note",
          text:
            `${summary.nodesSkippedWithoutEvidence} nodes and ${summary.edgesSkippedWithoutEvidence} edges were left out ` +
            "of this diagram because no grounded citation supported them. A diagram is a claim like any other.",
        }),
    viewToggle(analysis),
    outline && summary.nodeCount > LARGE_GRAPH_NODES
      ? el("p", {
          class: "hint",
          text:
            `This graph has more than ${LARGE_GRAPH_NODES} nodes, so it opens as an outline — a layered diagram of ` +
            "that many boxes is a wall, not a picture. The diagram is still one click away.",
        })
      : null,
    graphFilters(analysis),
  ];

  parts.push(...(outline ? outlineView(analysis) : diagramView(analysis)));
  parts.push(el("div", { id: "selection" }));
  return parts;
}

/** Diagram or outline. `aria-pressed` rather than a class, so the state is announced. */
function viewToggle(analysis) {
  const button = (view, label) =>
    el("button", {
      type: "button",
      text: label,
      "aria-pressed": state.graph.view === view ? "true" : "false",
      onclick: () => {
        if (state.graph.view === view) return;
        state.graph.view = view;
        render();
      },
    });
  return el(
    "div",
    { class: "graph-controls" },
    el("div", { class: "view-toggle" }, button("diagram", "Diagram"), button("outline", "Outline")),
    el("span", { class: "sr-only", text: graphSummaryLabel(analysis.graph) }),
  );
}

/**
 * Search and the two filter groups.
 *
 * Search only ever changes classes — `repaintGraph` toggles them on whichever view is
 * mounted — so a keystroke never rebuilds the container the search box lives in and the
 * caret stays where the user put it. A type or relationship filter changes which nodes
 * exist at all, so those do rebuild the view; the chips themselves sit outside it, which
 * is why the button keeps focus across the rebuild.
 */
function graphFilters(analysis) {
  const summary = analysis.graph.summary;

  const search = el(
    "div",
    { class: "graph-controls" },
    el("label", { class: "sr-only", for: "graph-search", text: "Search nodes" }),
    el("input", {
      type: "search",
      id: "graph-search",
      placeholder: "search nodes…",
      value: state.graph.search,
      oninput: (event) => {
        state.graph.search = event.target.value.trim().toLowerCase();
        repaintGraph();
      },
    }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Clear selection",
      onclick: () => {
        state.graph.selected = null;
        repaintGraph();
        renderSelection();
      },
    }),
  );

  const group = (label, counts, hidden, rebuild) =>
    el(
      "div",
      { class: "filter-group" },
      el("span", { text: label }),
      Object.entries(counts).map(([key, count]) =>
        el("button", {
          type: "button",
          class: `chip-toggle${hidden.has(key) ? "" : " on"}`,
          "aria-pressed": hidden.has(key) ? "false" : "true",
          text: `${key} ${count}`,
          onclick: (event) => {
            toggle(hidden, key);
            event.currentTarget.classList.toggle("on");
            event.currentTarget.setAttribute("aria-pressed", hidden.has(key) ? "false" : "true");
            rebuild();
          },
        }),
      ),
    );

  const rebuild = () => rebuildGraphView(analysis);
  return el(
    "div",
    {},
    search,
    group("Types", summary.nodesByType, state.graph.hiddenTypes, rebuild),
    group("Edges", summary.edgesByRelationship, state.graph.hiddenRelationships, rebuild),
  );
}

/** The visible subgraph: the filters applied, and nothing else decided here. */
function visibleGraph(analysis) {
  return filterGraph(analysis.graph, state.graph.hiddenTypes, state.graph.hiddenRelationships);
}

function diagramView(analysis) {
  const canvas = el("div", { class: "canvas" });
  const controls = el(
    "div",
    { class: "graph-controls" },
    el("button", { type: "button", class: "ghost", text: "Fit", onclick: () => fitGraph(canvas) }),
    el("button", { type: "button", class: "ghost", text: "Zoom in", onclick: () => zoomGraph(1.2, canvas) }),
    el("button", { type: "button", class: "ghost", text: "Zoom out", onclick: () => zoomGraph(1 / 1.2, canvas) }),
  );

  // The SVG needs the element measured, so draw after this frame is in the document.
  requestAnimationFrame(() => {
    drawGraph(canvas, analysis);
    fitGraph(canvas);
  });

  return [
    controls,
    canvas,
    el("p", {
      class: "hint",
      text:
        "Drag to pan, scroll to zoom. Click a node or an edge to select it and dim everything unrelated. " +
        "Tab reaches every node and edge, and Enter selects the focused one.",
    }),
    el(
      "div",
      { class: "legend" },
      Object.keys(analysis.graph.summary.nodesByType).map((type) =>
        // The swatch is an SVG rect, not a styled box: `fill` is a presentation
        // attribute, so the palette can stay in `NODE_COLOURS` and the legend draws
        // literally the same mark as the bar on a node.
        el(
          "span",
          {},
          svgEl(
            "svg",
            { class: "swatch", width: "8", height: "8", viewBox: "0 0 8 8", "aria-hidden": "true" },
            svgEl("rect", { width: "8", height: "8", rx: "2", fill: NODE_COLOURS[type] ?? "#8b949e" }),
          ),
          type,
        ),
      ),
    ),
  ];
}

/**
 * The architecture as a list: Node, Type, Relationships, Evidence.
 *
 * The non-visual fallback the specification requires, and the narrow-screen view. Every
 * row carries the same four things a node click shows in the diagram, and the evidence
 * ids are the same buttons — so a reader who never sees the picture loses the layout and
 * nothing else.
 */
function outlineView(analysis) {
  const host = el("div", { id: "outline-host" });
  const list = buildOutline(analysis);
  host.append(list);
  return [host];
}

function buildOutline(analysis) {
  const visible = visibleGraph(analysis);
  const rows = architectureOutline(visible);

  if (rows.length === 0) {
    return el("p", { class: "hint pad", id: "outline", text: "Every node type is filtered out." });
  }

  return el(
    "ul",
    { class: "outline", id: "outline" },
    rows.map((row) =>
      el(
        "li",
        { "data-node": row.id },
        el(
          "div",
          { class: "outline-head" },
          el("button", {
            type: "button",
            class: "label link",
            text: row.label,
            "aria-pressed": isSelected("node", row.id) ? "true" : "false",
            onclick: () => selectGraphItem("node", row.id),
          }),
          el("span", { class: "tag", text: row.type }),
          row.path === null ? null : el("span", { class: "path mono", text: row.path }),
        ),
        el("p", { class: "prose", text: row.description }),
        el(
          "dl",
          {},
          el("dt", { text: "From claim" }),
          el("dd", { class: "mono", text: row.claimId }),
          el("dt", { text: `Relationships (${row.relationships.length})` }),
          el(
            "dd",
            {},
            row.relationships.length === 0
              ? el("span", { class: "hint", text: "none in the filtered view" })
              : el(
                  "ul",
                  { class: "plain" },
                  row.relationships.map((rel) =>
                    el(
                      "li",
                      { class: "rel" },
                      el("span", { class: "tag", text: rel.relationship }),
                      " ",
                      el("button", {
                        type: "button",
                        class: "link",
                        text: rel.phrase,
                        onclick: () => selectGraphItem("edge", rel.edgeId),
                      }),
                      evidenceRow(rel.evidenceIds),
                    ),
                  ),
                ),
          ),
          el("dt", { text: "Evidence" }),
          el("dd", {}, evidenceRow(row.evidenceIds)),
        ),
      ),
    ),
  );
}

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function isSelected(kind, id) {
  const selected = state.graph.selected;
  return selected !== null && selected.kind === kind && selected.id === id;
}

/** One place decides what selecting something means, so both views agree. */
function selectGraphItem(kind, id) {
  state.graph.selected = isSelected(kind, id) ? null : { kind, id };
  repaintGraph();
  renderSelection();
}

/** A filter changed the set of nodes, so whichever view is mounted is rebuilt. */
function rebuildGraphView(analysis) {
  const canvas = document.querySelector(".canvas");
  if (canvas) {
    drawGraph(canvas, analysis);
    return;
  }
  const host = $("outline-host");
  if (host) {
    clear(host);
    host.append(buildOutline(analysis));
    repaintGraph();
  }
}

function resetGraphView() {
  state.graph.scale = 1;
  state.graph.x = 0;
  state.graph.y = 0;
  state.graph.selected = null;
  state.graph.search = "";
  state.graph.hiddenTypes.clear();
  state.graph.hiddenRelationships.clear();
  state.graph.laidOut = null;
}

function drawGraph(canvas, analysis) {
  const { nodes, edges } = visibleGraph(analysis);

  const layout = layoutGraph(nodes, edges);
  state.graph.laidOut = { layout, edges, nodes };

  clear(canvas);
  if (nodes.length === 0) {
    canvas.append(el("p", { class: "hint pad", text: "Every node type is filtered out." }));
    return;
  }

  const viewport = svgEl("svg", { xmlns: "http://www.w3.org/2000/svg" });
  const root = svgEl("g", { id: "graph-root" });

  const defs = svgEl("defs");
  defs.append(
    svgEl(
      "marker",
      { id: "arrow", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto" },
      svgEl("path", { d: "M0,0 L8,4 L0,8 z", fill: "#313c4a" }),
    ),
  );
  viewport.append(defs, root);

  const edgeLayer = svgEl("g", {});
  const nodeLayer = svgEl("g", {});
  root.append(edgeLayer, nodeLayer);

  for (const edge of edges) {
    const from = layout.placed.get(edge.from);
    const to = layout.placed.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const midX = (x1 + x2) / 2;
    const geometry =
      x2 >= x1
        ? `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`
        : // A back edge would otherwise be drawn straight through the nodes between.
          `M${x1},${y1} C${x1 + 60},${y1 - 46} ${x2 - 60},${y2 - 46} ${x2},${y2}`;
    const path = svgEl("path", {
      class: "edge",
      "data-edge": edge.id,
      "data-from": edge.from,
      "data-to": edge.to,
      "marker-end": "url(#arrow)",
      d: geometry,
    });
    path.append(svgEl("title", { text: `${edge.relationship}: ${edge.description}` }));
    edgeLayer.append(path);

    /*
     * The click and focus target for the edge.
     *
     * A one-pixel curve is not something anyone can reliably hit with a pointer, and it
     * is not something a keyboard can reach at all. This is the same curve drawn wide and
     * transparent: it takes the pointer and the tab stop, while the visible path above
     * stays thin. `pointer-events: stroke` means only the ribbon along the line is live,
     * not the whole bounding box, so it never steals a click meant for a node.
     */
    const hit = svgEl("path", {
      class: "edge-hit",
      "data-edge-hit": edge.id,
      d: geometry,
      fill: "none",
      stroke: "transparent",
      "stroke-width": "14",
      "pointer-events": "stroke",
      role: "button",
      tabindex: "0",
      "aria-label": `${labelOf(nodes, edge.from)} ${edge.relationship} ${labelOf(nodes, edge.to)}`,
      onclick: (event) => {
        event.stopPropagation();
        selectGraphItem("edge", edge.id);
      },
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        selectGraphItem("edge", edge.id);
      },
    });
    edgeLayer.append(hit);
    edgeLayer.append(
      svgEl("text", {
        class: "edge-label",
        "data-edge-label": edge.id,
        x: String(midX),
        y: String((y1 + y2) / 2 - 4),
        "text-anchor": "middle",
        text: edge.relationship,
      }),
    );
  }

  for (const node of nodes) {
    const box = layout.placed.get(node.id);
    if (!box) continue;
    const group = svgEl("g", {
      class: "node",
      "data-node": node.id,
      transform: `translate(${box.x},${box.y})`,
      // A diagram a keyboard cannot reach is a picture of an architecture, not a view of
      // one. `role="button"` plus `tabindex` puts every node in the tab order and in the
      // accessibility tree; `aria-label` is what a screen reader reads instead of the
      // three lines of SVG text, and `paintDiagram` keeps `aria-pressed` in step.
      role: "button",
      tabindex: "0",
      "aria-pressed": "false",
      "aria-label": `${node.label}, ${node.type}${node.path === null || node.path === undefined ? "" : `, ${node.path}`}`,
      onclick: (event) => {
        event.stopPropagation();
        selectGraphItem("node", node.id);
      },
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls a page by default, and this one is a viewport.
        event.preventDefault();
        event.stopPropagation();
        selectGraphItem("node", node.id);
      },
    });
    group.append(
      svgEl("rect", { width: String(box.w), height: String(box.h), rx: "4" }),
      svgEl("rect", { width: "3", height: String(box.h), rx: "2", fill: NODE_COLOURS[node.type] ?? "#8b949e" }),
      svgEl("text", { x: "12", y: "18", text: truncate(node.label, 24) }),
      svgEl("text", { class: "type", x: "12", y: "32", text: node.type }),
      svgEl("title", { text: `${node.label} (${node.type})\n${node.path ?? ""}\n${node.description}` }),
    );
    nodeLayer.append(group);
  }

  viewport.addEventListener("click", () => {
    if (state.graph.selected !== null) {
      state.graph.selected = null;
      repaintGraph();
      renderSelection();
    }
  });

  attachPanZoom(viewport, canvas);
  canvas.append(viewport);
  applyTransform(canvas);
  repaintGraph();
}

/** A node's label for an accessible name, falling back to its id. */
function labelOf(nodes, id) {
  return nodes.find((node) => node.id === id)?.label ?? id;
}

function attachPanZoom(viewport, canvas) {
  let dragging = false;
  let startX = 0;
  let startY = 0;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".node")) return;
    dragging = true;
    startX = event.clientX - state.graph.x;
    startY = event.clientY - state.graph.y;
    viewport.classList.add("panning");
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    state.graph.x = event.clientX - startX;
    state.graph.y = event.clientY - startY;
    applyTransform(canvas);
  });
  const stop = () => {
    dragging = false;
    viewport.classList.remove("panning");
  };
  viewport.addEventListener("pointerup", stop);
  viewport.addEventListener("pointercancel", stop);

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomGraph(event.deltaY < 0 ? 1.12 : 1 / 1.12, canvas, event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );
}

function zoomGraph(factor, canvas, originX, originY) {
  const rect = canvas.getBoundingClientRect();
  const cx = originX ?? rect.width / 2;
  const cy = originY ?? rect.height / 2;
  const next = Math.min(3, Math.max(0.15, state.graph.scale * factor));
  const ratio = next / state.graph.scale;
  // Keep the point under the cursor fixed while the scale changes.
  state.graph.x = cx - (cx - state.graph.x) * ratio;
  state.graph.y = cy - (cy - state.graph.y) * ratio;
  state.graph.scale = next;
  applyTransform(canvas);
}

function fitGraph(canvas) {
  const laidOut = state.graph.laidOut;
  if (!laidOut) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(1.2, (rect.width - 32) / laidOut.layout.width, (rect.height - 32) / laidOut.layout.height);
  state.graph.scale = Math.max(0.15, scale);
  state.graph.x = (rect.width - laidOut.layout.width * state.graph.scale) / 2;
  state.graph.y = (rect.height - laidOut.layout.height * state.graph.scale) / 2;
  applyTransform(canvas);
}

function applyTransform(canvas) {
  const root = canvas.querySelector("#graph-root");
  if (root) {
    root.setAttribute("transform", `translate(${state.graph.x},${state.graph.y}) scale(${state.graph.scale})`);
  }
}

/**
 * Selection and search change classes and nothing else.
 *
 * The layout is never recomputed for them, which is what keeps a selection from moving
 * the diagram under the cursor. `repaintGraph` is the entry point both views share: the
 * work is the same question — what is related to the selection, and what matches the
 * search — asked of an SVG in one case and a list in the other.
 */
function repaintGraph() {
  paintDiagram();
  paintOutline();
}

/** The ids a selection keeps lit, whether a node or an edge is selected. */
function relatedToSelection(edges) {
  const selected = state.graph.selected;
  if (selected === null) return null;
  if (selected.kind === "node") return relatedNodeIds(edges, selected.id);
  const edge = edges.find((candidate) => candidate.id === selected.id);
  return new Set(edge ? [edge.from, edge.to] : []);
}

function paintDiagram() {
  const laidOut = state.graph.laidOut;
  if (!laidOut) return;
  const selected = state.graph.selected;
  const search = state.graph.search;
  const related = relatedToSelection(laidOut.edges);

  for (const group of document.querySelectorAll(".node")) {
    const id = group.dataset.node;
    const node = laidOut.nodes.find((candidate) => candidate.id === id);
    const matches = node !== undefined && nodeMatchesSearch(node, search);
    const isSel = isSelected("node", id);
    group.classList.toggle("selected", isSel);
    group.classList.toggle("match", matches);
    group.classList.toggle("dim", (related !== null && !related.has(id)) || (search !== "" && !matches));
    group.setAttribute("aria-pressed", isSel ? "true" : "false");
  }

  for (const path of document.querySelectorAll(".edge")) {
    const id = path.dataset.edge;
    const touches =
      related !== null && (related.has(path.dataset.from) || related.has(path.dataset.to));
    const isSel = isSelected("edge", id);
    path.classList.toggle("selected", isSel);
    path.classList.toggle("related", touches && !isSel);
    path.classList.toggle("dim", selected !== null && !touches && !isSel);
  }

  // The visible path shows the state; the hit path is the thing in the accessibility
  // tree, so it is the one that has to report it.
  for (const hit of document.querySelectorAll(".edge-hit")) {
    hit.setAttribute("aria-pressed", isSelected("edge", hit.dataset.edgeHit) ? "true" : "false");
  }
}

function paintOutline() {
  const list = $("outline");
  if (!list) return;
  const analysis = state.analysis;
  if (!analysis) return;
  const visible = visibleGraph(analysis);
  const search = state.graph.search;
  const related = relatedToSelection(visible.edges);

  for (const row of list.querySelectorAll("li[data-node]")) {
    const id = row.dataset.node;
    const node = visible.nodes.find((candidate) => candidate.id === id);
    const matches = node !== undefined && nodeMatchesSearch(node, search);
    row.classList.toggle("dim", (related !== null && !related.has(id)) || (search !== "" && !matches));
  }
  for (const button of list.querySelectorAll('button[aria-pressed]')) {
    const id = button.closest("li[data-node]")?.dataset.node;
    if (id !== undefined) button.setAttribute("aria-pressed", isSelected("node", id) ? "true" : "false");
  }
}

/**
 * The detail panel for whatever is selected.
 *
 * A node and an edge are different claims and get different panels — the specification
 * asks an edge to name its relationship, both endpoints and its supporting evidence, and
 * "src/router.ts → src/store.ts" is an address where "HTTP router (api) → record store
 * (database)" is the claim. `nodeDetail` and `edgeDetail` resolve that; nothing here
 * walks the graph again.
 */
function renderSelection() {
  const host = $("selection");
  if (!host) return;
  clear(host);
  const selected = state.graph.selected;
  if (selected === null || !state.analysis) return;
  const graph = state.analysis.graph;

  const panel =
    selected.kind === "node"
      ? nodeSelectionPanel(nodeDetail(graph, selected.id))
      : edgeSelectionPanel(edgeDetail(graph, selected.id));
  if (panel === null) return;
  host.append(panel);
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function nodeSelectionPanel(detail) {
  if (detail === null) return null;
  const { node, relationships } = detail;
  return el(
    "div",
    { class: "panel" },
    el("h2", { text: "Selected node" }),
    el(
      "dl",
      { class: "kv" },
      el("dt", { text: "Label" }),
      el("dd", { text: node.label }),
      el("dt", { text: "Type" }),
      el("dd", { text: node.type }),
      el("dt", { text: "Path" }),
      el("dd", { class: "path", text: node.path ?? "—" }),
      el("dt", { text: "From claim" }),
      el("dd", { class: "mono", text: node.claimId }),
    ),
    el("p", { class: "prose", text: node.description }),
    evidenceRow(node.evidenceIds),
    relationships.length === 0
      ? null
      : el(
          "div",
          {},
          el("h2", { class: "spaced", text: `Relationships (${relationships.length})` }),
          el(
            "ul",
            { class: "plain" },
            relationships.map((rel) =>
              el(
                "li",
                {},
                el("span", { class: "tag", text: rel.relationship }),
                " ",
                el("button", {
                  type: "button",
                  class: "link",
                  text: rel.phrase,
                  onclick: () => selectGraphItem("edge", rel.edgeId),
                }),
                el("div", { class: "prose", text: rel.description }),
                evidenceRow(rel.evidenceIds),
              ),
            ),
          ),
        ),
  );
}

function edgeSelectionPanel(detail) {
  if (detail === null) return null;
  const { edge, from, to } = detail;
  const endpoint = (node, id) =>
    node === null
      ? el("dd", { class: "mono", text: id })
      : el(
          "dd",
          {},
          el("button", {
            type: "button",
            class: "link",
            text: `${node.label} (${node.type})`,
            onclick: () => selectGraphItem("node", node.id),
          }),
        );
  return el(
    "div",
    { class: "panel" },
    el("h2", { text: "Selected relationship" }),
    el(
      "dl",
      { class: "kv" },
      el("dt", { text: "Relationship" }),
      el("dd", {}, el("span", { class: "tag", text: edge.relationship })),
      el("dt", { text: "Source" }),
      endpoint(from, edge.from),
      el("dt", { text: "Target" }),
      endpoint(to, edge.to),
    ),
    el("p", { class: "prose", text: edge.description }),
    evidenceRow(edge.evidenceIds),
  );
}

// ---------------------------------------------------------------- sections

function renderComponents(analysis) {
  const components = analysis.report.components;
  return [
    head("Components", `${components.length} components the analysis could evidence.`),
    components.length === 0
      ? el("p", { class: "note plain", text: "The analysis named no components." })
      : el(
          "div",
          { class: "grid" },
          components.map((component) =>
            el(
              "div",
              { class: "card" },
              el("h3", {}, component.name, component.path ? el("span", { class: "path", text: component.path }) : null),
              el("p", { text: component.responsibility }),
              evidenceRow(component.evidenceIds),
            ),
          ),
        ),
  ];
}

function renderFlows(analysis) {
  const flows = analysis.report.flows;
  return [
    head("Data flow", `${flows.length} traced flows.`),
    flows.length === 0
      ? el("p", {
          class: "note plain",
          text: "The analysis traced no data flow it could support with evidence. That is a finding, not a blank.",
        })
      : flows.map((flow) =>
          el(
            "div",
            { class: "panel" },
            el("h2", { text: flow.name }),
            el("p", { text: flow.description }),
            el("ol", {}, flow.steps.map((step) => el("li", { text: step }))),
            evidenceRow(flow.evidenceIds),
          ),
        ),
  ];
}

function renderDependencies(analysis) {
  const dependencies = analysis.report.dependencies;
  return [
    head("Dependencies", `${dependencies.length} dependencies, as the manifests declare them.`),
    el(
      "div",
      { class: "grid" },
      dependencies.map((dependency) =>
        el(
          "div",
          { class: "card" },
          el(
            "h3",
            {},
            dependency.name,
            dependency.version ? el("span", { class: "tag", text: dependency.version }) : null,
            el("span", { class: "tag", text: dependency.scope }),
          ),
          dependency.purpose ? el("p", { text: dependency.purpose }) : null,
          evidenceRow(dependency.evidenceIds),
        ),
      ),
    ),
  ];
}

function renderTesting(analysis) {
  const testing = analysis.report.testing;
  const risks = analysis.report.risks;
  return [
    head("Testing and risks"),
    el(
      "div",
      { class: "panel" },
      el("h2", { text: "Approach" }),
      el("p", { class: "prose", text: testing.approach }),
      el(
        "dl",
        { class: "kv spaced" },
        el("dt", { text: "Frameworks" }),
        el("dd", { text: testing.frameworks.join(", ") || "—" }),
        el("dt", { text: "Test paths" }),
        el("dd", { text: testing.testPaths.join(", ") || "—" }),
      ),
      testing.gaps.length === 0
        ? null
        : el("div", {}, el("h2", { class: "spaced", text: "Gaps" }), el("ul", { class: "plain" }, testing.gaps.map((gap) => el("li", { text: gap })))),
      evidenceRow(testing.evidenceIds),
    ),
    el(
      "div",
      { class: "panel" },
      el("h2", { text: `Risks (${risks.length})` }),
      risks.length === 0
        ? el("p", { class: "note plain", text: "No risks were raised with evidence behind them." })
        : risks.map((risk) =>
            el(
              "div",
              { class: "card stack" },
              el("h3", {}, risk.title, el("span", { class: `tag sev-${risk.severity}`, text: risk.severity })),
              el("p", { text: risk.description }),
              evidenceRow(risk.evidenceIds),
            ),
          ),
    ),
  ];
}

// ---------------------------------------------------------------- evidence

function renderEvidence(analysis) {
  const report = analysis.report;
  const byOrigin = {};
  for (const source of report.sources) {
    for (const origin of source.origins.length === 0 ? ["reconnaissance"] : source.origins) {
      (byOrigin[origin] ??= []).push(source);
    }
  }

  const questionCitations = analysis.questions.flatMap((question) =>
    question.citations.map((citation) => ({ question, citation })),
  );

  return [
    head(
      "Evidence",
      `${report.sources.length} artefacts entered the ledger; ${report.evidence.length} distinct citations survived grounding.`,
    ),
    el("p", {
      class: "note plain",
      text:
        "How an artefact reached the ledger — reconnaissance collected it, the scout searched it out, the model " +
        "asked for it, or the precision pass attached it to a claim afterwards. Provenance is recorded by the " +
        "harness, not self-reported by the model.",
    }),
    ...["reconnaissance", "scout", "model-tool", "corroboration"].map((origin) => {
      const sources = byOrigin[origin] ?? [];
      return el(
        "div",
        { class: "panel" },
        el(
          "h2",
          {},
          el("span", { class: `tag origin-${origin}`, text: origin }),
          ` — ${sources.length} artefact${sources.length === 1 ? "" : "s"}`,
        ),
        sources.length === 0
          ? el("p", { class: "hint", text: "Nothing reached the ledger this way." })
          : el(
              "ul",
              { class: "plain" },
              sources.map((source) => {
                const citations = report.evidence.filter((item) => item.sourceId === source.id);
                return el(
                  "li",
                  {},
                  el(
                    "div",
                    { class: "row" },
                    el("span", { class: "path", text: source.id }),
                    el("span", { class: "tag", text: source.type }),
                    source.truncated ? el("span", { class: "tag warn", text: "partial view" }) : null,
                    el("span", { class: "count mono", text: `${fmt(source.bytes)} B` }),
                  ),
                  citations.length === 0
                    ? el("div", { class: "hint", text: "Inspected, never cited." })
                    : evidenceRow(citations.map((citation) => citation.id)),
                );
              }),
            ),
      );
    }),
    questionCitations.length === 0
      ? null
      : el(
          "div",
          { class: "panel" },
          el("h2", { text: `Citations from questions (${questionCitations.length})` }),
          el(
            "ul",
            { class: "plain" },
            questionCitations.map(({ question, citation }) =>
              el(
                "li",
                {},
                el("div", { class: "hint", text: `${question.id}: ${question.question}` }),
                evidenceRow([citation.id]),
              ),
            ),
          ),
        ),
  ];
}

// ---------------------------------------------------------------- questions

function renderQuestions(analysis) {
  const form = el(
    "form",
    {
      class: "panel",
      onsubmit: (event) => {
        event.preventDefault();
        void ask(event.target.querySelector("textarea"));
      },
    },
    el("h2", { text: "Ask this repository a question" }),
    el(
      "div",
      { class: "ask" },
      el("textarea", {
        maxlength: String(state.health?.maxQuestionChars ?? 1000),
        placeholder: "Where is authentication enforced? What happens when a request fails validation?",
        required: "required",
      }),
      el("button", { class: "primary", type: "submit", text: "Ask" }),
    ),
    el("p", {
      class: "hint",
      text:
        "The question gets its own bounded exploration of the repository. Earlier answers are replayed as " +
        "context but are never evidence: only the repository can support a citation.",
    }),
  );

  return [
    head("Questions", `${analysis.questions.length} asked against this analysis.`),
    form,
    // A question that failed locally is a state of this page, not of the analysis. It is
    // shown, and it is never written into the history, because the repository did not say
    // it. §10: never fabricate an answer to make the UI look successful.
    state.questionError === null
      ? null
      : el(
          "div",
          { class: "answer unverified", role: "alert" },
          el("div", { class: "q", text: "That question could not be answered." }),
          el("div", { class: "a", text: state.questionError }),
          el("div", { class: "meta" }, el("span", { class: "pill pill-bad", text: "error" })),
        ),
    ...analysis.questions
      .slice()
      .reverse()
      .map((question) => {
        const outcome = questionOutcome(question);
        return el(
          "div",
          { class: `answer${outcome.state === "supported" ? "" : " unverified"}` },
          el("div", { class: "q", text: question.question }),
          el("div", { class: "a", text: question.answer }),
          outcome.state === "unsupported"
            ? el("p", { class: "note", text: UNSUPPORTED_NOTICE })
            : null,
          el(
            "div",
            { class: "meta" },
            el("span", { text: question.id }),
            el("span", { class: `pill pill-${outcome.tone}`, text: outcome.label }),
            el("span", { text: `confidence ${Math.round(question.confidence * 100)}%` }),
            el("span", { text: `${question.metrics.toolCalls} tool calls` }),
            el("span", { text: `${question.metrics.scoutFilesRead} scout reads` }),
            el("span", { text: duration(question.metrics.durationMs) }),
            question.audit.dropped.length > 0
              ? el("span", { text: `${question.audit.dropped.length} citations dropped` })
              : null,
          ),
          evidenceRow(question.citations.map((citation) => citation.id)),
        );
      }),
  ];
}

async function ask(textarea) {
  const question = textarea.value.trim();
  if (question === "" || state.busy) return;
  state.questionError = null;
  setBusy(true, "Exploring the repository for an answer…");
  try {
    await api(`/api/analyses/${encodeURIComponent(state.analysis.id)}/questions`, {
      method: "POST",
      body: { question },
    });
    // Re-read the analysis so the ledger, the citation list and the questions all move
    // together. Patching the local copy would let the three drift apart.
    state.analysis = await api(`/api/analyses/${encodeURIComponent(state.analysis.id)}`);
    toast(null);
    render();
  } catch (error) {
    // Never stored, because it is not something the repository said. It lives on the page
    // until the next attempt, and it is never dressed up as an answer.
    state.questionError = error.message;
    toast(error.message, "error");
    render();
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------- export

function renderExport(analysis) {
  const report = analysis.report;
  const omitted = countOmittedClaims(report);
  return [
    head("Export", "A PDF that carries its own evidence."),
    el(
      "div",
      { class: "panel" },
      el("h2", { text: "What the PDF contains" }),
      el(
        "ul",
        { class: "plain" },
        el("li", { text: "The summary and architecture prose, with their citations." }),
        el("li", { text: "Components, data flow, dependencies, testing and risks — every printed claim naming its evidence." }),
        el("li", { text: `The architecture graph as a node and relationship listing (${analysis.graph.summary.nodeCount} nodes, ${analysis.graph.summary.edgeCount} edges).` }),
        el("li", { text: `Every question asked and answered (${analysis.questions.length}).` }),
        el("li", { text: "An evidence appendix: each citation, its artefact, and the excerpt that grounded it." }),
      ),
      el("p", {
        class: omitted > 0 ? "note" : "note plain",
        text:
          omitted > 0
            ? `${omitted} claim${omitted === 1 ? "" : "s"} will be left out of the PDF because no citation survived ` +
              "grounding for them. The document counts what it omitted, on its audit page."
            : "Every claim in this analysis has a grounded citation, so nothing will be omitted.",
      }),
      el("button", {
        class: "primary",
        type: "button",
        text: "Download PDF",
        onclick: () => {
          // A plain navigation: the server sets Content-Disposition, and the browser saves it.
          location.href = `/api/analyses/${encodeURIComponent(analysis.id)}/export/pdf`;
        },
      }),
    ),
  ];
}

// -------------------------------------------------------------------- drawer

async function openEvidence(evidenceId) {
  const drawer = $("drawer");
  // Remember where focus came from before taking it, so Escape can hand it back. A
  // keyboard user who opens a citation from a graph node has to land back on that node.
  state.drawerReturn = document.activeElement;
  drawer.hidden = false;
  $("drawer-eyebrow").textContent = "Evidence";
  $("drawer-title").textContent = evidenceId;
  $("drawer-close").focus();
  const body = $("drawer-body");
  clear(body);
  body.append(el("p", { class: "hint", text: "Loading the artefact…" }));

  try {
    let payload = state.evidence.get(evidenceId);
    if (!payload) {
      payload = await api(
        `/api/analyses/${encodeURIComponent(state.analysis.id)}/evidence/${encodeURIComponent(evidenceId)}`,
      );
      state.evidence.set(evidenceId, payload);
    }
    clear(body);
    $("drawer-eyebrow").textContent = evidenceLocationLabel(payload);
    body.append(...evidenceDetail(payload));
  } catch (error) {
    clear(body);
    body.append(el("p", { class: "note", text: error.message }));
  }
}

function closeDrawer() {
  const drawer = $("drawer");
  if (drawer.hidden) return;
  drawer.hidden = true;
  // Focus inside a hidden element is focus nowhere: without this, Escape leaves the
  // keyboard at the top of the document and the user has to tab back to where they were.
  const returnTo = state.drawerReturn;
  state.drawerReturn = null;
  if (returnTo && typeof returnTo.focus === "function" && returnTo.isConnected) returnTo.focus();
}

function evidenceDetail(payload) {
  const evidence = payload.evidence;
  const source = payload.source;
  const origin = payload.origin;

  const nodes = [
    origin.kind === "question"
      ? el("p", { class: "note plain", text: `Cited while answering ${origin.questionId}: “${origin.question}”` })
      : null,
    el(
      "dl",
      { class: "kv" },
      el("dt", { text: "Cited as" }),
      el("dd", { class: "path", text: evidence.source }),
      el("dt", { text: "Artefact" }),
      el("dd", { class: "path", text: evidence.sourceId ?? "unresolved" }),
      el("dt", { text: "Type" }),
      el("dd", { text: evidence.type }),
      el("dt", { text: "Reported location" }),
      el("dd", { text: source?.reportedLocation ?? evidence.location ?? "—" }),
      // The model's claim is directly above; this is what the viewer could actually
      // verify. Keeping them adjacent and separately labelled is the whole point: one is
      // a claim about the repository, the other is a measurement of it.
      el("dt", { text: "Verified lines" }),
      el("dd", { text: evidenceLineRange(payload) ?? "not located" }),
      el("dt", { text: "Strength" }),
      el(
        "dd",
        {},
        el("span", {
          class: `pill pill-${evidenceStrength(payload).tone}`,
          text: evidenceStrength(payload).label,
        }),
      ),
      el("dt", { text: "Supports" }),
      el("dd", { text: evidence.supports ?? "—" }),
      evidence.claimIds?.length ? el("dt", { text: "Cited by claims" }) : null,
      evidence.claimIds?.length ? el("dd", { text: evidence.claimIds.join(", ") }) : null,
    ),
  ];

  if (!source) {
    nodes.push(el("p", { class: "note", text: payload.note ?? "This citation resolves to no artefact in the ledger." }));
    return nodes;
  }

  nodes.push(
    el(
      "dl",
      { class: "kv" },
      el("dt", { text: "Provenance" }),
      el(
        "dd",
        { class: "tags" },
        (source.origins.length === 0 ? ["unrecorded"] : source.origins).map((item) =>
          el("span", { class: `tag origin-${item}`, text: item }),
        ),
      ),
      el("dt", { text: "Ledger size" }),
      el("dd", { text: `${fmt(source.bytes)} bytes${source.truncated ? " (partial view)" : ""}` }),
      el("dt", { text: "Cited by" }),
      el("dd", { text: `${fmt(source.citationCount)} citation${source.citationCount === 1 ? "" : "s"}` }),
    ),
  );

  nodes.push(
    el("p", {
      class: "note plain",
      text: source.lineNumbersKnown
        ? "Line numbers are counted from the artefact as it entered the ledger. The reported location above is the " +
          "model's own claim and is not verified — the excerpt is what carries the proof."
        : "Only part of this artefact reached the ledger, so its first line is not necessarily line 1. Line numbers " +
          "are withheld rather than guessed.",
    }),
  );

  if (source.textTruncatedForDisplay) {
    nodes.push(el("p", { class: "note", text: "The artefact is longer than the viewer shows; the rest is not displayed." }));
  }

  // Nothing highlighted below has two very different causes, and a reader staring at an
  // unmarked file cannot tell them apart. Say which it is: a citation that quoted nothing
  // is weaker evidence, while a quote the viewer could not locate is a defect worth
  // seeing — and the second must never be dressed up as the first.
  if (!source.excerptMatch) {
    const quoted = evidence.excerpt !== undefined && evidence.excerpt !== null && evidence.excerpt !== "";
    nodes.push(
      el("p", {
        class: quoted ? "note" : "note plain",
        text: quoted
          ? "The quoted excerpt could not be located in the artefact, so nothing is highlighted rather than an " +
            "approximate span being invented."
          : "This citation names the artefact without quoting from it, so there is nothing to highlight. " +
            "The artefact below is the whole of what the analysis read.",
      }),
    );
  }

  nodes.push(sourceTable(source));
  return nodes;
}

/**
 * The artefact, with the grounded excerpt highlighted.
 *
 * The text is the ledger's copy, not a fresh read of the file. That is what grounding
 * actually checked, and a file edited since the analysis would otherwise make a good
 * citation look invented.
 */
function sourceTable(source) {
  const lines = source.text.split("\n");
  const match = source.excerptMatch;
  const table = el("table");

  // Character offsets are per-artefact; convert them to per-line spans once.
  let cursor = 0;
  lines.forEach((line, index) => {
    const start = cursor;
    const end = cursor + line.length;
    cursor = end + 1;

    const row = el("tr", {});
    row.append(el("td", { class: "n", text: source.lineNumbersKnown ? String(index + 1) : "·" }));

    if (match && match.end > start && match.start < end) {
      const from = Math.max(0, match.start - start);
      const to = Math.min(line.length, match.end - start);
      row.className = "hit";
      row.append(
        el(
          "td",
          {},
          line.slice(0, from),
          el("mark", { text: line.slice(from, to) }),
          line.slice(to),
        ),
      );
    } else {
      row.append(el("td", { text: line }));
    }
    table.append(row);
  });

  const wrapper = el("div", { class: "source" }, table);
  if (match) {
    requestAnimationFrame(() => {
      const hit = wrapper.querySelector("tr.hit");
      if (hit) hit.scrollIntoView({ block: "center" });
    });
  }
  return wrapper;
}

// ---------------------------------------------------------------------- run

const initial = location.hash.replace(/^#/, "");
if (SECTIONS.some((section) => section.id === initial)) state.section = initial;

void boot();
