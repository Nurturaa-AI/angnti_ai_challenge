/*
 * The dashboard's pure logic.
 *
 * Everything in this file is a function of its arguments: no DOM, no fetch, no
 * module-level state. That is not tidiness, it is the only way this layer gets tested.
 * The repository has no bundler and no jsdom, so `app.js` can only ever be read by a
 * human — while anything here can be imported by `apps/web/test/ui.test.ts` and
 * asserted against. The rule for deciding where a function belongs is therefore blunt:
 * if it touches `document`, it lives in `app.js`; if it decides *what* to show, it
 * lives here.
 *
 * `ui.d.ts` beside this file is its type declaration. The browser loads the `.js`
 * directly; TypeScript resolves the test's import to the `.d.ts`, which is what lets a
 * typechecked test call into a browser module in a project with no `allowJs` and no
 * build step.
 */

// ------------------------------------------------------------------ sections

export const SECTIONS = [
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

export const NODE_COLOURS = {
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

// ------------------------------------------------------------------ lifecycle

/**
 * The phase order, mirroring `ANALYSIS_PHASES` in `@repo-arch/app`, with a label each.
 *
 * Duplicated deliberately, and guarded by a test that compares the phase names to the
 * server's list. The alternative is shipping the constant to the browser over HTTP, which
 * would make the progress checklist a network dependency; the alternative to *that* is
 * not showing what is coming at all. A phase this list does not know still renders — it
 * just loses its place in the sequence, which is the right way for the duplication to
 * fail.
 *
 * The labels are this file's own. The server's `PHASE_MESSAGES` describe a phase that is
 * *happening* ("Reading the repository…"); these name a step that may not have started.
 */
export const PHASE_STEPS = [
  { phase: "collecting-context", label: "Collect context" },
  { phase: "scouting", label: "Scout for evidence" },
  { phase: "exploring", label: "Explore" },
  { phase: "synthesizing", label: "Synthesise" },
  { phase: "validating-schema", label: "Validate the schema" },
  { phase: "refining-evidence", label: "Refine evidence" },
  { phase: "grounding", label: "Ground citations" },
  { phase: "building-report", label: "Build the report" },
];

export const PHASES = PHASE_STEPS.map((step) => step.phase);

/** Where a phase sits in the sequence, or `-1`. `null` (not started) is also `-1`. */
export function phaseIndex(phase) {
  return phase === null || phase === undefined ? -1 : PHASES.indexOf(phase);
}

/**
 * How a status reads to someone watching the list.
 *
 * `tone` is a class name, not a colour: the stylesheet owns every colour, and a status
 * whose meaning changed would then change in one place. `running` means the record is
 * still moving on its own, which is what decides whether the row keeps a live stream
 * attached to it.
 */
const STATUS_DESCRIPTIONS = {
  queued: { label: "Queued", tone: "queued", running: true },
  validating: { label: "Validating", tone: "running", running: true },
  analyzing: { label: "Analyzing", tone: "running", running: true },
  completed: { label: "Completed", tone: "good", running: false },
  failed: { label: "Failed", tone: "bad", running: false },
};

export function statusDescription(status) {
  return (
    STATUS_DESCRIPTIONS[status] ?? {
      // A status this build does not know is not reported as fine. It is certainly
      // not `completed`, and saying so is safer than inventing a label.
      label: String(status ?? "unknown"),
      tone: "bad",
      running: false,
    }
  );
}

export function isRunningStatus(status) {
  return statusDescription(status).running;
}

/** `{ index, total }` for a known phase, `null` for one this build does not know. */
export function phaseStep(phase) {
  const index = phaseIndex(phase);
  return index < 0 ? null : { index: index + 1, total: PHASES.length };
}

/**
 * The progress checklist: every phase, and whether this analysis has passed it.
 *
 * `done` is "strictly before the current phase", so the phase being reported reads as
 * active rather than finished. Before the first phase arrives nothing is done and nothing
 * is active, which is exactly what `queued` means.
 */
export function phaseChecklist(phase) {
  const current = phaseIndex(phase);
  return PHASE_STEPS.map((step, index) => ({
    phase: step.phase,
    label: step.label,
    done: current > index,
    active: current === index,
  }));
}

/**
 * The one line a progress panel shows.
 *
 * Only ever facts the server sent: a phase name, its own message, and where that phase
 * sits in the sequence. No percentage and no estimate — the pipeline reports phases, not
 * progress, and a made-up bar would be the UI claiming something nobody measured.
 */
export function progressLine(status, phase, phaseMessage) {
  const described = statusDescription(status);
  if (phase === null || phase === undefined) return described.label;
  const step = phaseStep(phase);
  const message = phaseMessage ?? phase;
  return step === null ? message : `${message} (step ${step.index} of ${step.total})`;
}

// ------------------------------------------------------------------ formatting

export function fmt(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value ?? "—");
}

export function duration(ms) {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** ISO 8601 in UTC, to the minute. The absolute form, for a `title` and a tooltip. */
export function absoluteTime(iso) {
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * "4 min ago", and the absolute date once "ago" stops being useful.
 *
 * A list of durable analyses spans days, so a relative time that keeps counting hours
 * into the hundreds is worse than a date. Seven days is the switch.
 */
export function relativeTime(iso, nowMs) {
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.round((nowMs - ms) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} d ago`;
  return absoluteTime(iso).slice(0, 10);
}

// ------------------------------------------------------------------ list rows

/**
 * One row of the analysis list, as text.
 *
 * Every field the specification asks a list row to carry — repository path and name,
 * status, created, updated, summary — is decided here rather than in the DOM code, so
 * "what does a queued analysis with no summary yet look like?" is a question a test can
 * ask. `summary` falls back to the failure sentence, then to a placeholder: a row that
 * said nothing at all would be indistinguishable from a broken one.
 */
export function describeAnalysisRow(summary, nowMs) {
  const described = statusDescription(summary.status);
  const path = summary.repository?.path ?? ".";
  const name = summary.repository?.name ?? path;
  const line =
    summary.summary !== undefined && summary.summary !== null && summary.summary !== ""
      ? summary.summary
      : summary.error !== null && summary.error !== undefined && summary.error !== ""
        ? summary.error
        : described.running
          ? "Still working."
          : "No summary was recorded.";

  return {
    id: summary.id,
    name,
    path,
    /** True when the path adds nothing the name has not already said. */
    pathIsName: path === name || path === ".",
    status: summary.status,
    statusLabel: described.label,
    tone: described.tone,
    running: described.running,
    progress: progressLine(summary.status, summary.phase, summary.phaseMessage),
    created: relativeTime(summary.createdAt, nowMs),
    createdAbsolute: absoluteTime(summary.createdAt),
    updated: relativeTime(summary.updatedAt, nowMs),
    updatedAbsolute: absoluteTime(summary.updatedAt),
    /** True when nothing has happened since creation, so "updated" is noise. */
    updatedSameAsCreated: summary.createdAt === summary.updatedAt,
    summary: truncate(line, 160),
    system: summary.system,
    questionCount: summary.questionCount ?? 0,
    failed: summary.status === "failed",
    error: summary.error ?? null,
  };
}

// ------------------------------------------------------------------ the graph

export function nodeMatchesSearch(node, search) {
  if (search === "") return false;
  const haystack = `${node.label} ${node.type} ${node.path ?? ""} ${node.description}`.toLowerCase();
  return haystack.includes(search);
}

/**
 * The visible subgraph, after the type and relationship filters.
 *
 * An edge survives only if both its endpoints did. Drawing an edge to a hidden node
 * would put a line on the page with nothing on the end of it, which reads as a missing
 * node rather than as a filtered one.
 */
export function filterGraph(graph, hiddenTypes, hiddenRelationships) {
  const nodes = graph.nodes.filter((node) => !hiddenTypes.has(node.type));
  const visible = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => !hiddenRelationships.has(edge.relationship) && visible.has(edge.from) && visible.has(edge.to),
  );
  return { nodes, edges };
}

/** The nodes a selection keeps lit: itself and whatever it touches. */
export function relatedNodeIds(edges, selectedId) {
  const related = new Set();
  if (selectedId === null || selectedId === undefined) return related;
  related.add(selectedId);
  for (const edge of edges) {
    if (edge.from === selectedId) related.add(edge.to);
    if (edge.to === selectedId) related.add(edge.from);
  }
  return related;
}

/** One node's detail panel: what it is, and every relationship it takes part in. */
export function nodeDetail(graph, nodeId) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return null;
  return { node, relationships: relationshipsOf(graph, node.id) };
}

/**
 * One edge's detail panel.
 *
 * The specification asks an edge click to name its relationship, its source, its target,
 * its evidence ids and its supporting evidence. The first four are on the edge; the
 * fifth is why `from` and `to` are resolved to whole nodes here rather than left as ids
 * — "src/router.ts → src/store.ts" is an address, and "HTTP router (api) → record store
 * (database)" is the claim.
 */
export function edgeDetail(graph, edgeId) {
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) return null;
  return {
    edge,
    from: graph.nodes.find((node) => node.id === edge.from) ?? null,
    to: graph.nodes.find((node) => node.id === edge.to) ?? null,
  };
}

function relationshipsOf(graph, nodeId) {
  const label = (id) => graph.nodes.find((node) => node.id === id)?.label ?? id;
  return graph.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => ({
      edgeId: edge.id,
      direction: edge.from === nodeId ? "out" : "in",
      relationship: edge.relationship,
      otherId: edge.from === nodeId ? edge.to : edge.from,
      otherLabel: label(edge.from === nodeId ? edge.to : edge.from),
      description: edge.description,
      evidenceIds: edge.evidenceIds,
      /** How the row reads left to right, whichever end this node is. */
      phrase:
        edge.from === nodeId
          ? `this ${edge.relationship} ${label(edge.to)}`
          : `${label(edge.from)} ${edge.relationship} this`,
    }));
}

/**
 * The architecture as a list: Node, Type, Relationships, Evidence.
 *
 * The non-visual fallback the specification requires, and the narrow-screen view. It is
 * built from the same server-side graph the diagram is drawn from — not from a second
 * traversal — so the two cannot disagree about what the repository contains. A reader
 * who never sees the picture loses the layout and nothing else.
 */
export function architectureOutline(graph) {
  return graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    type: node.type,
    path: node.path ?? null,
    description: node.description,
    claimId: node.claimId,
    evidenceIds: node.evidenceIds,
    relationships: relationshipsOf(graph, node.id),
  }));
}

/** What a screen reader is told the diagram is, before being offered the outline. */
export function graphSummaryLabel(graph) {
  const summary = graph.summary;
  const types = Object.entries(summary.nodesByType)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  return (
    `Architecture diagram: ${summary.nodeCount} nodes and ${summary.edgeCount} relationships` +
    (types === "" ? "" : ` — ${types}`) +
    ". The same graph is available as a list; use the Outline view."
  );
}

/**
 * Layered layout.
 *
 * Computed here rather than on the server. The graph model is semantic on purpose —
 * nodes, edges, relationships, evidence — and pixels are a property of a viewport, not
 * of a repository. Depth is the longest path from a node with no incoming edge, which
 * for an architecture graph puts the entry points on the left and what they depend on to
 * the right. Within a layer, nodes keep the order the server emitted, so the picture is
 * stable across reloads: the same analysis always draws the same diagram.
 */
export function layoutGraph(nodes, edges) {
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

/**
 * Above this many nodes, the diagram opens as an outline instead.
 *
 * A layered SVG of four hundred boxes is not a visualisation, it is a wall. The outline
 * stays readable at any size, so that is what a very large graph opens as; the diagram
 * is still one click away for anyone who wants to pan around it.
 */
export const LARGE_GRAPH_NODES = 120;

export function defaultGraphView(graph, narrowViewport) {
  if (narrowViewport) return "outline";
  return graph.summary.nodeCount > LARGE_GRAPH_NODES ? "outline" : "diagram";
}

// ---------------------------------------------------------------- evidence

/**
 * The verified line range, or `null`.
 *
 * `null` has one meaning and it is not "line 1": either the excerpt could not be
 * located in the artefact, or the artefact reached the ledger truncated and its first
 * line is not known to be the file's first line. Numbering it anyway would be the
 * viewer inventing a citation, which is the one thing this product must not do.
 */
export function evidenceLineRange(payload) {
  const match = payload.source?.excerptMatch;
  if (!match || match.line === null || match.line === undefined) return null;
  const end = match.endLine ?? match.line;
  return end > match.line ? `${match.line}-${end}` : `${match.line}`;
}

/** `src/store.ts:4-9`, or just the path when the range is unknown. */
export function evidenceLocationLabel(payload) {
  const path = payload.evidence?.source ?? payload.source?.id ?? "unknown";
  const range = evidenceLineRange(payload);
  return range === null ? path : `${path}:${range}`;
}

/**
 * How strong this citation is, in the viewer's own words.
 *
 * Four states, because they mean four different things to a reader and collapsing any
 * two of them would flatter the weaker one. A quote that verified is the strong case; a
 * quote that could not be found again is a defect worth seeing; a citation that named an
 * artefact without quoting it is weaker evidence but not a defect; and a citation whose
 * artefact is not in the ledger at all is not evidence.
 */
export function evidenceStrength(payload) {
  if (!payload.source) return { label: "no artefact", tone: "bad" };
  if (payload.source.excerptMatch) return { label: "verified excerpt", tone: "good" };
  const excerpt = payload.evidence?.excerpt;
  if (excerpt !== undefined && excerpt !== null && excerpt !== "") {
    return { label: "excerpt not located", tone: "warn" };
  }
  return { label: "artefact cited, not quoted", tone: "dim" };
}

// ---------------------------------------------------------------- questions

/**
 * The sentence shown beside an answer the repository could not support.
 *
 * The specification's wording, deliberately used here and not in the answer itself. The
 * answer text comes from `UNSUPPORTED_ANSWER` in `@repo-arch/app`, which is part of the
 * measured question path and pinned by its tests; rewriting it would be editing measured
 * behaviour for a UI copy change. So the product layer says this, next to the answer,
 * where copy belongs. See `docs/improvement-changelog.md`.
 */
export const UNSUPPORTED_NOTICE =
  "I couldn't find enough evidence in the repository to answer this confidently.";

/** `supported`, `unsupported`, or `error` for a local failure that was never stored. */
export function questionOutcome(question) {
  if (question.failed === true) {
    return { state: "error", label: "could not be answered", tone: "bad" };
  }
  return question.supported
    ? { state: "supported", label: "verified against the repository", tone: "good" }
    : { state: "unsupported", label: "not verified", tone: "warn" };
}

// ---------------------------------------------------------------- export

export function countOmittedClaims(report) {
  const claims = [...report.components, ...report.flows, ...report.dependencies, ...report.risks, report.testing];
  return claims.filter((claim) => (claim.evidenceIds ?? []).length === 0).length;
}
