import {
  ANALYSIS_PHASES,
  ANALYSIS_STATUSES,
  NODE_TYPES,
  PHASE_MESSAGES,
  UNSUPPORTED_ANSWER,
  type AnalysisReport,
  type ArchitectureEdge,
  type ArchitectureGraph,
  type ArchitectureNode,
} from "@repo-arch/app";
import { describe, expect, it } from "vitest";
import type { AnalysisSummaryDto, EvidenceViewDto } from "../src/dto";
import {
  LARGE_GRAPH_NODES,
  NODE_COLOURS,
  PHASES,
  PHASE_STEPS,
  SECTIONS,
  UNSUPPORTED_NOTICE,
  absoluteTime,
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
  phaseIndex,
  phaseStep,
  progressLine,
  questionOutcome,
  relatedNodeIds,
  relativeTime,
  statusDescription,
  truncate,
} from "../public/ui.js";

/**
 * The dashboard's pure logic, and the duplication it deliberately accepts.
 *
 * `ui.js` exists as a separate module for exactly one reason: `app.js` touches the
 * DOM and can therefore only be read by a human, while anything that merely
 * *decides what to show* can be imported and asserted. This file is what makes that
 * split worth having — without it the two files are a filing convention.
 *
 * Two kinds of test are here, and the second kind is the important one. The first
 * pins behaviour a reader depends on: a `null` line range is never rendered as line
 * 1, a status the build does not know never reads as fine, a filtered edge never
 * dangles. The second checks the places where the browser keeps its **own copy** of
 * something the server owns — the phase sequence, the status vocabulary, the node
 * palette. Each copy is deliberate (shipping the constants over HTTP would make the
 * progress checklist a network dependency) and each is a drift risk, so each is
 * compared to the server's list here rather than trusted.
 *
 * The module is imported through `../public/ui.js`, which resolves to `ui.d.ts` for
 * `tsc` and to the real file for Node. So these tests are typechecked against the
 * hand-written declarations while exercising the exact bytes the browser loads.
 */

// ------------------------------------------------------------------ fixtures

function node(overrides: Partial<ArchitectureNode> & Pick<ArchitectureNode, "id">): ArchitectureNode {
  return {
    type: "module",
    label: overrides.id,
    path: `src/${overrides.id}.ts`,
    description: "A module.",
    claimId: `component-${overrides.id}`,
    evidenceIds: ["ev-001"],
    ...overrides,
  };
}

function edge(from: string, to: string, overrides: Partial<ArchitectureEdge> = {}): ArchitectureEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    relationship: "imports",
    description: "It imports it.",
    evidenceIds: ["ev-002"],
    ...overrides,
  };
}

/** A three-node chain: `server` → `router` → `store`. */
function chain(): Pick<ArchitectureGraph, "nodes" | "edges"> {
  return {
    nodes: [node({ id: "server", type: "application", label: "HTTP server" }), node({ id: "router", type: "api", label: "Router" }), node({ id: "store", type: "database", label: "Record store" })],
    edges: [edge("server", "router"), edge("router", "store", { relationship: "writes-to" })],
  };
}

function summary(overrides: Partial<AnalysisSummaryDto> = {}): AnalysisSummaryDto {
  return {
    id: "an-m1x2y3-1",
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    status: "completed",
    phase: null,
    phaseMessage: null,
    repository: { path: "widget", name: "widget" },
    system: "advanced",
    model: "test-model",
    summary: "A demo dispatcher.",
    error: null,
    questionCount: 2,
    ...overrides,
  };
}

/** `nowMs` for the fixtures above, four minutes after they were created. */
const NOW = Date.parse("2026-09-02T12:04:00.000Z");

function evidenceView(overrides: {
  excerpt?: string | null;
  match?: { start: number; end: number; line: number | null; endLine: number | null } | null;
  source?: EvidenceViewDto["source"];
}): EvidenceViewDto {
  const source: EvidenceViewDto["source"] =
    overrides.source === undefined
      ? {
          id: "src/store.ts",
          type: "file",
          bytes: 400,
          truncated: false,
          origins: ["scout"],
          citationCount: 1,
          text: "const rows = [];\n",
          textTruncatedForDisplay: false,
          lineNumbersKnown: true,
          reportedLocation: null,
          lineCount: 1,
          excerptMatch: overrides.match ?? null,
        }
      : overrides.source;
  return {
    analysisId: "an-m1x2y3-1",
    origin: { kind: "report" },
    evidence: {
      id: "ev-001",
      type: "file",
      source: "src/store.ts",
      sourceId: "src/store.ts",
      location: undefined,
      excerpt: overrides.excerpt === null ? undefined : (overrides.excerpt ?? "const rows = [];"),
      supports: undefined,
      origins: [],
      claimIds: ["component-store"],
    },
    source,
  };
}

// -------------------------------------------------- the copies of server state

describe("ui.js — constants the browser duplicates from the server", () => {
  it("knows exactly the phases the server can report, in the server's order", () => {
    // The progress checklist shows what is *coming*, which it can only do from a
    // local list. This assertion is the whole licence for that duplication: a phase
    // added to `ANALYSIS_PHASES` and not to `PHASE_STEPS` fails here rather than
    // silently losing its place in the sequence in a browser.
    expect(PHASES).toEqual([...ANALYSIS_PHASES]);
    expect(PHASE_STEPS.map((step) => step.phase)).toEqual([...ANALYSIS_PHASES]);
  });

  it("labels every phase with prose of its own, distinct from the server's message", () => {
    for (const step of PHASE_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      // The server's message describes a phase that is happening ("Reading the
      // repository…"); a checklist row names a step that may not have started.
      // Identical text would mean one of the two is lying about tense.
      expect(step.label).not.toBe(PHASE_MESSAGES[step.phase as (typeof ANALYSIS_PHASES)[number]]);
    }
  });

  it("describes every status the server can store", () => {
    for (const status of ANALYSIS_STATUSES) {
      const described = statusDescription(status);
      expect(described.label.length).toBeGreaterThan(0);
      expect(["queued", "running", "good", "bad"]).toContain(described.tone);
    }
    // And agrees with the server about which ones are still moving.
    expect(ANALYSIS_STATUSES.filter(isRunningStatus)).toEqual(["queued", "validating", "analyzing"]);
  });

  it("has a colour for every node type the graph can contain", () => {
    // A missing entry renders a box with no fill, which reads as a different kind
    // of node rather than as a missing palette entry.
    expect(Object.keys(NODE_COLOURS).sort()).toEqual([...NODE_TYPES].sort());
  });

  it("offers one section per dashboard view, with unique ids", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("evidence");
    expect(ids).toContain("architecture");
  });

  it("keeps the unsupported *notice* separate from the measured answer text", () => {
    // `UNSUPPORTED_ANSWER` is part of the measured question path and pinned by its
    // own tests. Rewriting it for a copy change would be editing measured
    // behaviour, so the product layer says its piece next to the answer instead.
    expect(UNSUPPORTED_NOTICE).not.toBe(UNSUPPORTED_ANSWER);
    expect(UNSUPPORTED_NOTICE.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------- lifecycle

describe("ui.js — phases and progress", () => {
  it("places a known phase and refuses to place an unknown one", () => {
    expect(phaseIndex("collecting-context")).toBe(0);
    expect(phaseIndex("building-report")).toBe(PHASES.length - 1);
    expect(phaseIndex("teleporting")).toBe(-1);
    // `null` is "not started", which is not a position in the sequence either.
    expect(phaseIndex(null)).toBe(-1);
    expect(phaseIndex(undefined)).toBe(-1);
    expect(phaseStep("teleporting")).toBeNull();
    expect(phaseStep("scouting")).toEqual({ index: 2, total: PHASES.length });
  });

  it("treats an unknown status as bad rather than as fine", () => {
    const described = statusDescription("half-done");
    expect(described.tone).toBe("bad");
    expect(described.running).toBe(false);
    expect(described.label).toBe("half-done");
  });

  it("marks the reported phase active and only earlier ones done", () => {
    const checklist = phaseChecklist("synthesizing");
    const active = checklist.filter((row) => row.active);

    expect(active).toHaveLength(1);
    expect(active[0]?.phase).toBe("synthesizing");
    // Strictly before, so the phase being reported reads as in progress. Showing it
    // as done would claim a step finished that is still running.
    expect(checklist.filter((row) => row.done).map((row) => row.phase)).toEqual([
      "collecting-context",
      "scouting",
      "exploring",
    ]);
  });

  it("has nothing done and nothing active before the first phase arrives", () => {
    const checklist = phaseChecklist(null);
    expect(checklist).toHaveLength(PHASES.length);
    expect(checklist.some((row) => row.done || row.active)).toBe(false);
  });

  it("still renders a phase it does not know, just without a place in the sequence", () => {
    const checklist = phaseChecklist("teleporting");
    expect(checklist.some((row) => row.done || row.active)).toBe(false);
    // The line falls back to the phase's own name rather than to nothing.
    expect(progressLine("analyzing", "teleporting")).toBe("teleporting");
  });

  it("shows only facts the server sent — no percentage, no estimate", () => {
    const line = progressLine("analyzing", "scouting", "Searching for evidence…");

    expect(line).toBe("Searching for evidence… (step 2 of 8)");
    // The pipeline reports phases, not progress. A bar or an ETA would be the UI
    // claiming something nobody measured.
    expect(line).not.toMatch(/%|remaining|eta/i);
  });

  it("falls back to the status label when there is no phase at all", () => {
    expect(progressLine("queued")).toBe("Queued");
    expect(progressLine("completed", null)).toBe("Completed");
  });
});

// ------------------------------------------------------------------ formatting

describe("ui.js — formatting", () => {
  it("formats numbers, missing values and durations", () => {
    expect(fmt(1234567)).toBe("1,234,567");
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
    expect(fmt("text")).toBe("text");

    expect(duration(null)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration(412)).toBe("412 ms");
    expect(duration(2500)).toBe("2.5 s");
    expect(duration(95_000)).toBe("1m 35s");
  });

  it("truncates with an ellipsis, and leaves short text exactly alone", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    // The ellipsis counts towards the budget, so the result never exceeds it.
    expect(truncate("abcdef", 4)).toHaveLength(4);
    expect(truncate(null, 4)).toBe("");
  });

  it("renders an absolute time to the minute in UTC, and says so", () => {
    expect(absoluteTime("2026-09-02T12:34:56.000Z")).toBe("2026-09-02 12:34 UTC");
    // An unparseable timestamp is a dash, never `Invalid Date` and never today.
    expect(absoluteTime("not a date")).toBe("—");
  });

  it("switches from relative to absolute once ago stops being useful", () => {
    const at = (iso: string, from: string): string => relativeTime(iso, Date.parse(from));

    expect(at("2026-09-02T12:00:00.000Z", "2026-09-02T12:00:20.000Z")).toBe("just now");
    expect(at("2026-09-02T12:00:00.000Z", "2026-09-02T12:01:10.000Z")).toBe("1 min ago");
    expect(at("2026-09-02T12:00:00.000Z", "2026-09-02T12:40:00.000Z")).toBe("40 min ago");
    expect(at("2026-09-02T12:00:00.000Z", "2026-09-02T15:00:00.000Z")).toBe("3 h ago");
    expect(at("2026-09-02T12:00:00.000Z", "2026-09-05T12:00:00.000Z")).toBe("3 d ago");
    // A durable list spans weeks, and "412 h ago" is worse than a date.
    expect(at("2026-09-02T12:00:00.000Z", "2026-09-30T12:00:00.000Z")).toBe("2026-09-02");
    expect(at("not a date", "2026-09-02T12:00:00.000Z")).toBe("—");
  });

  it("does not count into the future when a clock disagrees", () => {
    // The list timestamps come from the server and `nowMs` from the browser, so a
    // skewed client must not produce "in 3 minutes".
    expect(relativeTime("2026-09-02T12:05:00.000Z", Date.parse("2026-09-02T12:00:00.000Z"))).toBe("just now");
  });
});

// ------------------------------------------------------------------- list rows

describe("ui.js — describeAnalysisRow", () => {
  it("describes a completed analysis", () => {
    const row = describeAnalysisRow(summary(), NOW);

    expect(row.statusLabel).toBe("Completed");
    expect(row.tone).toBe("good");
    expect(row.running).toBe(false);
    expect(row.failed).toBe(false);
    expect(row.summary).toBe("A demo dispatcher.");
    expect(row.created).toBe("4 min ago");
    expect(row.createdAbsolute).toBe("2026-09-02 12:00 UTC");
    expect(row.updatedSameAsCreated).toBe(true);
    expect(row.questionCount).toBe(2);
  });

  it("says something rather than nothing for an analysis with no summary yet", () => {
    const row = describeAnalysisRow(summary({ status: "analyzing", phase: "scouting", phaseMessage: "Searching…", summary: "" }), NOW);

    // A blank row is indistinguishable from a broken one, so a running analysis
    // says it is still working and the progress line carries the detail.
    expect(row.summary).toBe("Still working.");
    expect(row.running).toBe(true);
    expect(row.progress).toBe("Searching… (step 2 of 8)");
  });

  it("uses the failure sentence as the summary of a failed analysis", () => {
    const row = describeAnalysisRow(
      summary({ status: "failed", summary: "", error: "No such directory in the workspace: \"absent\"." }),
      NOW,
    );

    expect(row.failed).toBe(true);
    expect(row.tone).toBe("bad");
    expect(row.summary).toContain("No such directory");
    expect(row.error).toContain("No such directory");
  });

  it("falls back to a placeholder when a finished analysis recorded nothing", () => {
    const row = describeAnalysisRow(summary({ summary: "", error: null }), NOW);
    expect(row.summary).toBe("No summary was recorded.");
  });

  it("suppresses a path that repeats the name or names the workspace root", () => {
    expect(describeAnalysisRow(summary(), NOW).pathIsName).toBe(true);
    expect(describeAnalysisRow(summary({ repository: { path: ".", name: "workspace" } }), NOW).pathIsName).toBe(true);
    expect(
      describeAnalysisRow(summary({ repository: { path: "packages/widget", name: "widget" } }), NOW).pathIsName,
    ).toBe(false);
  });

  it("truncates a very long summary so one row cannot take the list over", () => {
    const row = describeAnalysisRow(summary({ summary: "x".repeat(400) }), NOW);
    expect(row.summary).toHaveLength(160);
    expect(row.summary.endsWith("…")).toBe(true);
  });
});

// ------------------------------------------------------------------- the graph

describe("ui.js — the graph", () => {
  it("matches a search against label, type, path and description — but never on empty", () => {
    const target = node({ id: "store", type: "database", label: "Record store", description: "Holds analyses." });

    expect(nodeMatchesSearch(target, "record")).toBe(true);
    expect(nodeMatchesSearch(target, "database")).toBe(true);
    expect(nodeMatchesSearch(target, "src/store")).toBe(true);
    expect(nodeMatchesSearch(target, "analyses")).toBe(true);
    expect(nodeMatchesSearch(target, "queue")).toBe(false);
    // An empty box matches nothing rather than everything: highlighting the whole
    // diagram is the same as highlighting none of it, but looks like a bug.
    expect(nodeMatchesSearch(target, "")).toBe(false);
  });

  it("drops an edge whose endpoint was filtered out", () => {
    const filtered = filterGraph(chain(), new Set(["database"]), new Set());

    expect(filtered.nodes.map((entry) => entry.id)).toEqual(["server", "router"]);
    // A line to a hidden node reads as a missing node rather than a filtered one.
    expect(filtered.edges.map((entry) => entry.id)).toEqual(["server->router"]);
  });

  it("filters by relationship without removing the nodes it joined", () => {
    const filtered = filterGraph(chain(), new Set(), new Set(["writes-to"]));

    expect(filtered.nodes).toHaveLength(3);
    expect(filtered.edges.map((entry) => entry.relationship)).toEqual(["imports"]);
  });

  it("lights a selection and its neighbours in both directions", () => {
    const graph = chain();

    expect([...relatedNodeIds(graph.edges, "router")].sort()).toEqual(["router", "server", "store"]);
    expect([...relatedNodeIds(graph.edges, "server")].sort()).toEqual(["router", "server"]);
    expect(relatedNodeIds(graph.edges, null).size).toBe(0);
    expect(relatedNodeIds(graph.edges, undefined).size).toBe(0);
  });

  it("reads a node's relationships left to right whichever end it is", () => {
    const detail = nodeDetail(chain(), "router");

    expect(detail?.node.label).toBe("Router");
    expect(detail?.relationships.map((relationship) => relationship.phrase)).toEqual([
      "HTTP server imports this",
      "this writes-to Record store",
    ]);
    expect(detail?.relationships.map((relationship) => relationship.direction)).toEqual(["in", "out"]);
    expect(detail?.relationships[0]?.evidenceIds).toEqual(["ev-002"]);
  });

  it("returns null for a node or edge that is not in the graph", () => {
    expect(nodeDetail(chain(), "absent")).toBeNull();
    expect(edgeDetail(chain(), "absent")).toBeNull();
  });

  it("resolves an edge's endpoints to whole nodes, not to ids", () => {
    const detail = edgeDetail(chain(), "router->store");

    // "src/router.ts → src/store.ts" is an address; "Router → Record store" is the
    // claim, and the claim is what the panel is for.
    expect(detail?.from?.label).toBe("Router");
    expect(detail?.to?.label).toBe("Record store");
    expect(detail?.edge.relationship).toBe("writes-to");
  });

  it("keeps an edge whose endpoint is missing, and reports the gap as null", () => {
    const broken = { nodes: [node({ id: "server" })], edges: [edge("server", "ghost")] };
    const detail = edgeDetail(broken, "server->ghost");

    expect(detail?.edge.to).toBe("ghost");
    expect(detail?.to).toBeNull();
  });

  it("builds the outline from the same graph the diagram is drawn from", () => {
    const graph = chain();
    const outline = architectureOutline(graph);

    // Not a second traversal: a reader who never sees the picture loses the layout
    // and nothing else, so the two views cannot disagree about what is there.
    expect(outline.map((row) => row.id)).toEqual(graph.nodes.map((entry) => entry.id));
    expect(outline[1]?.relationships).toEqual(nodeDetail(graph, "router")?.relationships);
    expect(outline[0]?.claimId).toBe("component-server");
    expect(outline[2]?.path).toBe("src/store.ts");
  });

  it("gives a node with no path an explicit null rather than undefined", () => {
    const outline = architectureOutline({ nodes: [node({ id: "svc", path: undefined })], edges: [] });
    expect(outline[0]?.path).toBeNull();
  });

  it("tells a screen reader what the diagram is and offers the outline", () => {
    const graph: ArchitectureGraph = {
      ...chain(),
      summary: {
        nodeCount: 3,
        edgeCount: 2,
        nodesByType: { application: 1, api: 1, database: 1 },
        edgesByRelationship: { imports: 1, "writes-to": 1 },
        nodesSkippedWithoutEvidence: 0,
        edgesSkippedWithoutEvidence: 0,
      },
    };

    const label = graphSummaryLabel(graph);
    expect(label).toContain("3 nodes and 2 relationships");
    expect(label).toContain("1 application, 1 api, 1 database");
    expect(label).toContain("Outline view");
  });

  it("lays out a chain left to right, one layer per step", () => {
    const graph = chain();
    const layout = layoutGraph(graph.nodes, graph.edges);

    expect(layout.layerCount).toBe(3);
    const xs = ["server", "router", "store"].map((id) => layout.placed.get(id)?.x ?? -1);
    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
    expect(xs[1]).toBeLessThan(xs[2] ?? 0);
    expect(layout.width).toBeGreaterThan(xs[2] ?? 0);
  });

  it("is deterministic, so the same analysis draws the same diagram twice", () => {
    const graph = chain();
    const first = layoutGraph(graph.nodes, graph.edges);
    const second = layoutGraph(graph.nodes, graph.edges);

    expect([...second.placed.entries()]).toEqual([...first.placed.entries()]);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it("lays out a cycle without recursing forever", () => {
    // A cycle is legal in an architecture graph — two modules importing each other
    // is a real thing a repository does — so the layout treats the back edge as
    // depth 0 rather than refusing to draw.
    const nodes = [node({ id: "a" }), node({ id: "b" })];
    const layout = layoutGraph(nodes, [edge("a", "b"), edge("b", "a")]);

    expect(layout.placed.size).toBe(2);
    expect(Number.isFinite(layout.width)).toBe(true);
  });

  it("ignores an edge that names a node it was not given", () => {
    const layout = layoutGraph([node({ id: "a" })], [edge("a", "ghost")]);
    expect(layout.placed.size).toBe(1);
  });

  it("places every node, and lays out an empty graph without dividing by zero", () => {
    const graph = chain();
    const layout = layoutGraph(graph.nodes, graph.edges);
    for (const entry of graph.nodes) expect(layout.placed.has(entry.id)).toBe(true);

    const empty = layoutGraph([], []);
    expect(empty.placed.size).toBe(0);
    expect(Number.isFinite(empty.height)).toBe(true);
    expect(empty.height).toBeGreaterThan(0);
  });

  it("opens a very large graph, or a narrow viewport, as an outline", () => {
    const graph = (nodeCount: number): ArchitectureGraph => ({
      nodes: [],
      edges: [],
      summary: {
        nodeCount,
        edgeCount: 0,
        nodesByType: {},
        edgesByRelationship: {},
        nodesSkippedWithoutEvidence: 0,
        edgesSkippedWithoutEvidence: 0,
      },
    });

    expect(defaultGraphView(graph(19), false)).toBe("diagram");
    expect(defaultGraphView(graph(LARGE_GRAPH_NODES), false)).toBe("diagram");
    // A layered SVG of four hundred boxes is a wall, not a visualisation.
    expect(defaultGraphView(graph(LARGE_GRAPH_NODES + 1), false)).toBe("outline");
    // And a phone gets the outline whatever the size, because panning a diagram
    // there is worse than reading a list.
    expect(defaultGraphView(graph(3), true)).toBe("outline");
  });
});

// -------------------------------------------------------------------- evidence

describe("ui.js — the evidence viewer", () => {
  it("renders a single line and a range differently", () => {
    expect(evidenceLineRange(evidenceView({ match: { start: 0, end: 16, line: 4, endLine: 4 } }))).toBe("4");
    expect(evidenceLineRange(evidenceView({ match: { start: 0, end: 90, line: 4, endLine: 9 } }))).toBe("4-9");
  });

  it("refuses to number a citation it could not locate", () => {
    // `null` does not mean line 1. Either the excerpt was not found in the
    // artefact, or the artefact reached the ledger truncated and its first line is
    // not known to be the file's first — and numbering it anyway would be the
    // viewer inventing the one thing this product exists not to invent.
    expect(evidenceLineRange(evidenceView({ match: null }))).toBeNull();
    expect(evidenceLineRange(evidenceView({ match: { start: 0, end: 16, line: null, endLine: null } }))).toBeNull();
    expect(evidenceLocationLabel(evidenceView({ match: null }))).toBe("src/store.ts");
  });

  it("labels a located citation as path:range", () => {
    expect(evidenceLocationLabel(evidenceView({ match: { start: 0, end: 90, line: 4, endLine: 9 } }))).toBe(
      "src/store.ts:4-9",
    );
  });

  it("names the artefact even when the ledger has no source for it", () => {
    const label = evidenceLocationLabel(evidenceView({ source: null }));
    expect(label).toBe("src/store.ts");
  });

  it("distinguishes all four strengths of citation", () => {
    // Four states, because they mean four different things and collapsing any two
    // would flatter the weaker one.
    expect(evidenceStrength(evidenceView({ match: { start: 0, end: 16, line: 1, endLine: 1 } }))).toEqual({
      label: "verified excerpt",
      tone: "good",
    });
    expect(evidenceStrength(evidenceView({ match: null }))).toEqual({
      label: "excerpt not located",
      tone: "warn",
    });
    expect(evidenceStrength(evidenceView({ match: null, excerpt: null }))).toEqual({
      label: "artefact cited, not quoted",
      tone: "dim",
    });
    expect(evidenceStrength(evidenceView({ source: null }))).toEqual({ label: "no artefact", tone: "bad" });
  });

  it("does not call an unquoted citation a defect", () => {
    // Naming an artefact without quoting it is weaker evidence. It is not a
    // failure, and a red badge would say it was.
    expect(evidenceStrength(evidenceView({ match: null, excerpt: null })).tone).not.toBe("bad");
    expect(evidenceStrength(evidenceView({ match: null, excerpt: null })).tone).not.toBe("warn");
  });
});

// ------------------------------------------------------------------- questions

describe("ui.js — questions and export", () => {
  it("separates an unsupported answer from one that could not be answered at all", () => {
    expect(questionOutcome({ supported: true })).toEqual({
      state: "supported",
      label: "verified against the repository",
      tone: "good",
    });
    expect(questionOutcome({ supported: false })).toMatchObject({ state: "unsupported", tone: "warn" });
    // A local failure was never stored, so it is neither a verified answer nor an
    // unsupported one — it is not an answer.
    expect(questionOutcome({ supported: true, failed: true })).toMatchObject({ state: "error", tone: "bad" });
  });

  it("counts the claims a reader will find nothing behind", () => {
    const report = {
      components: [{ evidenceIds: ["ev-001"] }, { evidenceIds: [] }],
      flows: [{ evidenceIds: [] }],
      dependencies: [{ evidenceIds: ["ev-002"] }],
      risks: [{ evidenceIds: [] }],
      testing: { evidenceIds: ["ev-003"] },
    } as unknown as AnalysisReport;

    expect(countOmittedClaims(report)).toBe(3);
  });

  it("counts a claim whose evidence list is absent as omitted", () => {
    const report = {
      components: [{}],
      flows: [],
      dependencies: [],
      risks: [],
      testing: {},
    } as unknown as AnalysisReport;

    expect(countOmittedClaims(report)).toBe(2);
  });
});
