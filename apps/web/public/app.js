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
 */

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "architecture", label: "Architecture" },
  { id: "components", label: "Components" },
  { id: "flows", label: "Data flow" },
  { id: "dependencies", label: "Dependencies" },
  { id: "testing", label: "Testing" },
  { id: "evidence", label: "Evidence" },
  { id: "questions", label: "Questions" },
  { id: "export", label: "Export" },
];

const NODE_COLOURS = {
  application: "#58a6ff",
  package: "#7ee787",
  module: "#a5d6ff",
  api: "#ffa657",
  database: "#d2a8ff",
  queue: "#f778ba",
  worker: "#ffdf5d",
  "external-service": "#8b949e",
  cli: "#79c0ff",
  configuration: "#e3b341",
  "test-suite": "#3fb950",
};

const state = {
  health: null,
  repositories: [],
  analyses: [],
  analysis: null,
  section: "overview",
  /** evidenceId -> payload from /evidence/:id, cached because the text is large. */
  evidence: new Map(),
  graph: {
    scale: 1,
    x: 0,
    y: 0,
    selected: null,
    search: "",
    hiddenTypes: new Set(),
    hiddenRelationships: new Set(),
    laidOut: null,
  },
  busy: false,
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

function status(message, kind) {
  const bar = $("status");
  bar.textContent = message ?? "";
  bar.className = `status${kind ? ` ${kind}` : ""}`;
  bar.hidden = !message;
}

function fmt(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value ?? "—");
}

function duration(ms) {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
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

  try {
    state.health = await api("/api/health");
    $("provider").textContent = `${state.health.provider} · ${state.health.model}`;
    const systems = $("system");
    for (const system of state.health.systems) {
      systems.append(el("option", { value: system, text: system, selected: system === state.health.defaultSystem }));
    }
  } catch (error) {
    status(`Cannot reach the server: ${error.message}`, "error");
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

async function loadAnalyses() {
  const { analyses } = await api("/api/analyses");
  state.analyses = analyses;
  const list = $("recent");
  clear(list);
  if (analyses.length === 0) {
    list.append(el("li", { class: "sidebar-note", text: "None yet." }));
    return;
  }
  for (const analysis of analyses) {
    list.append(
      el(
        "li",
        {},
        el("button", {
          type: "button",
          class: state.analysis?.id === analysis.id ? "on" : "",
          onclick: () => void open(analysis.id),
          text: `${analysis.repositoryName} · ${analysis.system}${analysis.questionCount > 0 ? ` · ${analysis.questionCount}q` : ""}`,
        }),
      ),
    );
  }
}

async function onAnalyse(event) {
  event.preventDefault();
  if (state.busy) return;
  const repository = $("repository").value;
  const system = $("system").value;
  const focus = $("focus").value.trim();

  setBusy(true, `Analysing ${repository} with the ${system} system…`);
  try {
    const analysis = await api("/api/analyze", {
      method: "POST",
      body: { repository, system, ...(focus === "" ? {} : { focus }) },
    });
    state.analysis = analysis;
    state.evidence.clear();
    resetGraphView();
    state.section = "overview";
    location.hash = "overview";
    status(
      `${analysis.report.repository.name}: ${analysis.report.metrics.citationsGrounded} citations grounded, ` +
        `${analysis.report.metrics.filesInspected} files inspected in ${duration(analysis.report.metrics.durationMs)}.`,
    );
    setTimeout(() => status(null), 8000);
    await loadAnalyses();
    render();
  } catch (error) {
    status(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function open(id) {
  setBusy(true, "Loading analysis…");
  try {
    state.analysis = await api(`/api/analysis/${encodeURIComponent(id)}`);
    state.evidence.clear();
    resetGraphView();
    await loadAnalyses();
    status(null);
    render();
  } catch (error) {
    status(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, message) {
  state.busy = busy;
  $("analyse-button").disabled = busy;
  $("analyse-button").textContent = busy ? "Working…" : "Analyse";
  if (busy) status(message, "busy");
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
  const counts = analysis
    ? {
        components: analysis.report.components.length,
        flows: analysis.report.flows.length,
        dependencies: analysis.report.dependencies.length,
        architecture: analysis.graph.summary.nodeCount,
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

function renderArchitecture(analysis) {
  const graph = analysis.graph;
  const summary = graph.summary;

  const canvas = el("div", { class: "canvas" });
  const controls = el(
    "div",
    { class: "graph-controls" },
    el("input", {
      type: "search",
      id: "graph-search",
      placeholder: "search nodes…",
      value: state.graph.search,
      oninput: (event) => {
        state.graph.search = event.target.value.trim().toLowerCase();
        paintGraph();
      },
    }),
    el("button", { type: "button", class: "ghost", text: "Fit", onclick: () => fitGraph(canvas) }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Zoom in",
      onclick: () => zoomGraph(1.2, canvas),
    }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Zoom out",
      onclick: () => zoomGraph(1 / 1.2, canvas),
    }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Clear selection",
      onclick: () => {
        state.graph.selected = null;
        paintGraph();
        renderSelection();
      },
    }),
  );

  const typeFilters = el(
    "div",
    { class: "filter-group" },
    el("span", { text: "Types" }),
    Object.entries(summary.nodesByType).map(([type, count]) =>
      el("button", {
        type: "button",
        class: `chip-toggle${state.graph.hiddenTypes.has(type) ? "" : " on"}`,
        text: `${type} ${count}`,
        onclick: (event) => {
          toggle(state.graph.hiddenTypes, type);
          event.target.classList.toggle("on");
          drawGraph(canvas, analysis);
        },
      }),
    ),
  );

  const relationshipFilters = el(
    "div",
    { class: "filter-group" },
    el("span", { text: "Edges" }),
    Object.entries(summary.edgesByRelationship).map(([relationship, count]) =>
      el("button", {
        type: "button",
        class: `chip-toggle${state.graph.hiddenRelationships.has(relationship) ? "" : " on"}`,
        text: `${relationship} ${count}`,
        onclick: (event) => {
          toggle(state.graph.hiddenRelationships, relationship);
          event.target.classList.toggle("on");
          drawGraph(canvas, analysis);
        },
      }),
    ),
  );

  const selection = el("div", { id: "selection" });

  const nodes = [
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
    controls,
    typeFilters,
    relationshipFilters,
    canvas,
    el("p", { class: "hint", text: "Drag to pan, scroll to zoom, click a node to select it and dim everything unrelated." }),
    el(
      "div",
      { class: "legend" },
      Object.keys(summary.nodesByType).map((type) =>
        // The swatch is an SVG rect, not a styled box: `fill` is a presentation
        // attribute, so the palette can stay in `NODE_COLOURS` and the legend draws
        // literally the same mark as the bar on a node.
        el(
          "span",
          {},
          svgEl(
            "svg",
            { class: "swatch", width: "8", height: "8", viewBox: "0 0 8 8" },
            svgEl("rect", { width: "8", height: "8", rx: "2", fill: NODE_COLOURS[type] ?? "#8b949e" }),
          ),
          type,
        ),
      ),
    ),
    selection,
  ];

  // The SVG needs the element measured, so draw after this frame is in the document.
  requestAnimationFrame(() => {
    drawGraph(canvas, analysis);
    fitGraph(canvas);
  });

  return nodes;
}

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
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

/**
 * Layered layout, computed here rather than on the server.
 *
 * The graph model is semantic on purpose — nodes, edges, relationships, evidence — and
 * pixels are a property of a viewport, not of a repository. Depth is the longest path
 * from a node with no incoming edge, which for an architecture graph puts the entry
 * points on the left and what they depend on to the right. Within a layer, nodes keep
 * the order the server emitted, so the picture is stable across reloads: the same
 * analysis always draws the same diagram.
 */
function layoutGraph(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }

  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    // A cycle is legal in an architecture graph; treat the back edge as depth 0.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const parent of incoming.get(id) ?? []) value = Math.max(value, depthOf(parent) + 1);
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) depthOf(node.id);

  const layers = [];
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    (layers[level] ??= []).push(node);
  }

  const NODE_W = 168;
  const NODE_H = 44;
  const GAP_X = 92;
  const GAP_Y = 20;

  const placed = new Map();
  const tallest = Math.max(1, ...layers.map((layer) => (layer ? layer.length : 0)));
  const height = tallest * (NODE_H + GAP_Y) + 40;

  layers.forEach((layer, level) => {
    if (!layer) return;
    const columnHeight = layer.length * (NODE_H + GAP_Y);
    const top = (height - columnHeight) / 2;
    layer.forEach((node, index) => {
      placed.set(node.id, {
        node,
        x: 24 + level * (NODE_W + GAP_X),
        y: top + index * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H,
      });
    });
  });

  const width = 48 + layers.length * (NODE_W + GAP_X);
  return { placed, width, height, layerCount: layers.length };
}

function drawGraph(canvas, analysis) {
  const graph = analysis.graph;
  const nodes = graph.nodes.filter((node) => !state.graph.hiddenTypes.has(node.type));
  const visible = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) =>
      !state.graph.hiddenRelationships.has(edge.relationship) && visible.has(edge.from) && visible.has(edge.to),
  );

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
    const path = svgEl("path", {
      class: "edge",
      "data-edge": edge.id,
      "data-from": edge.from,
      "data-to": edge.to,
      "marker-end": "url(#arrow)",
      d:
        x2 >= x1
          ? `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`
          : // A back edge would otherwise be drawn straight through the nodes between.
            `M${x1},${y1} C${x1 + 60},${y1 - 46} ${x2 - 60},${y2 - 46} ${x2},${y2}`,
    });
    path.append(svgEl("title", { text: `${edge.relationship}: ${edge.description}` }));
    edgeLayer.append(path);
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
      onclick: (event) => {
        event.stopPropagation();
        state.graph.selected = state.graph.selected === node.id ? null : node.id;
        paintGraph();
        renderSelection();
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
      paintGraph();
      renderSelection();
    }
  });

  attachPanZoom(viewport, canvas);
  canvas.append(viewport);
  applyTransform(canvas);
  paintGraph();
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

/** Selection and search only change classes — the layout is never recomputed for them. */
function paintGraph() {
  const selected = state.graph.selected;
  const search = state.graph.search;
  const laidOut = state.graph.laidOut;
  if (!laidOut) return;

  const related = new Set();
  if (selected) {
    related.add(selected);
    for (const edge of laidOut.edges) {
      if (edge.from === selected) related.add(edge.to);
      if (edge.to === selected) related.add(edge.from);
    }
  }

  for (const group of document.querySelectorAll(".node")) {
    const id = group.dataset.node;
    const node = laidOut.nodes.find((candidate) => candidate.id === id);
    const matches =
      search !== "" &&
      node &&
      `${node.label} ${node.type} ${node.path ?? ""} ${node.description}`.toLowerCase().includes(search);
    group.classList.toggle("selected", id === selected);
    group.classList.toggle("match", Boolean(matches));
    group.classList.toggle("dim", (selected !== null && !related.has(id)) || (search !== "" && !matches));
  }

  for (const path of document.querySelectorAll(".edge")) {
    const touches = selected !== null && (path.dataset.from === selected || path.dataset.to === selected);
    path.classList.toggle("related", touches);
    path.classList.toggle("dim", selected !== null && !touches);
  }
}

function renderSelection() {
  const host = $("selection");
  if (!host) return;
  clear(host);
  const selected = state.graph.selected;
  if (!selected || !state.analysis) return;

  const node = state.analysis.graph.nodes.find((candidate) => candidate.id === selected);
  if (!node) return;
  const edges = state.analysis.graph.edges.filter((edge) => edge.from === selected || edge.to === selected);

  host.append(
    el(
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
        el("dd", { text: node.claimId }),
      ),
      el("p", { text: node.description }),
      evidenceRow(node.evidenceIds),
      edges.length === 0
        ? null
        : el(
            "div",
            {},
            el("h2", { class: "spaced", text: `Relationships (${edges.length})` }),
            el(
              "ul",
              { class: "plain" },
              edges.map((edge) =>
                el(
                  "li",
                  {},
                  el("span", { class: "tag", text: edge.relationship }),
                  " ",
                  el("span", { class: "mono", text: `${edge.from} → ${edge.to}` }),
                  el("div", { text: edge.description }),
                  evidenceRow(edge.evidenceIds),
                ),
              ),
            ),
          ),
    ),
  );
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    ...analysis.questions
      .slice()
      .reverse()
      .map((question) =>
        el(
          "div",
          { class: `answer${question.supported ? "" : " unverified"}` },
          el("div", { class: "q", text: question.question }),
          el("div", { class: "a", text: question.answer }),
          el(
            "div",
            { class: "meta" },
            el("span", { text: question.id }),
            el("span", { text: question.supported ? "verified against the repository" : "not verified" }),
            el("span", { text: `confidence ${Math.round(question.confidence * 100)}%` }),
            el("span", { text: `${question.metrics.toolCalls} tool calls` }),
            el("span", { text: `${question.metrics.scoutFilesRead} scout reads` }),
            el("span", { text: duration(question.metrics.durationMs) }),
            question.audit.dropped.length > 0
              ? el("span", { text: `${question.audit.dropped.length} citations dropped` })
              : null,
          ),
          evidenceRow(question.citations.map((citation) => citation.id)),
        ),
      ),
  ];
}

async function ask(textarea) {
  const question = textarea.value.trim();
  if (question === "" || state.busy) return;
  setBusy(true, "Exploring the repository for an answer…");
  try {
    await api("/api/questions", {
      method: "POST",
      body: { analysisId: state.analysis.id, question },
    });
    // Re-read the analysis so the ledger, the citation list and the questions all move
    // together. Patching the local copy would let the three drift apart.
    state.analysis = await api(`/api/analysis/${encodeURIComponent(state.analysis.id)}`);
    status(null);
    render();
  } catch (error) {
    status(error.message, "error");
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
          location.href = `/api/analysis/${encodeURIComponent(analysis.id)}/export/pdf`;
        },
      }),
    ),
  ];
}

function countOmittedClaims(report) {
  const claims = [
    ...report.components,
    ...report.flows,
    ...report.dependencies,
    ...report.risks,
    report.testing,
  ];
  return claims.filter((claim) => (claim.evidenceIds ?? []).length === 0).length;
}

// -------------------------------------------------------------------- drawer

async function openEvidence(evidenceId) {
  const drawer = $("drawer");
  drawer.hidden = false;
  $("drawer-eyebrow").textContent = "Evidence";
  $("drawer-title").textContent = evidenceId;
  const body = $("drawer-body");
  clear(body);
  body.append(el("p", { class: "hint", text: "Loading the artefact…" }));

  try {
    let payload = state.evidence.get(evidenceId);
    if (!payload) {
      payload = await api(`/api/analysis/${encodeURIComponent(state.analysis.id)}/evidence/${encodeURIComponent(evidenceId)}`);
      state.evidence.set(evidenceId, payload);
    }
    clear(body);
    body.append(...evidenceDetail(payload));
  } catch (error) {
    clear(body);
    body.append(el("p", { class: "note", text: error.message }));
  }
}

function closeDrawer() {
  $("drawer").hidden = true;
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
