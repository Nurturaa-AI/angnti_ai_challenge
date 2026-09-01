import { describe, expect, it } from "vitest";
import {
  assertNodeType,
  assertRelationship,
  buildArchitectureGraph,
  NODE_TYPES,
  RELATIONSHIPS,
} from "../src/architecture";
import { report } from "./report-fixture";

describe("architecture graph", () => {
  it("turns claims into nodes and draws the structural edges between them", () => {
    const graph = buildArchitectureGraph(report());

    // The application, two components, one dependency, the test suite.
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "app",
      "dependency:0",
      "component:0",
      "component:1",
      "testing",
    ]);
    expect(graph.summary.nodeCount).toBe(5);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    // `src/router.ts` is an api by path, `src/store.ts` a database by its responsibility.
    expect(byId.get("component:0")?.type).toBe("api");
    expect(byId.get("component:1")?.type).toBe("database");
    expect(byId.get("app")?.type).toBe("application");
    expect(byId.get("testing")?.type).toBe("test-suite");

    // An api is exposed by the application; anything else is contained by it.
    expect(graph.edges.map((edge) => `${edge.from} ${edge.relationship} ${edge.to}`)).toEqual([
      "app exposes component:0",
      "app depends-on component:1",
    ]);
    expect(graph.summary.edgesByRelationship).toEqual({ exposes: 1, "depends-on": 1 });
  });

  it("carries the citing evidence ids on every node and every edge", () => {
    const graph = buildArchitectureGraph(report());

    for (const node of graph.nodes) {
      expect(node.evidenceIds.length).toBeGreaterThan(0);
    }
    for (const edge of graph.edges) {
      expect(edge.evidenceIds.length).toBeGreaterThan(0);
    }

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get("component:0")?.evidenceIds).toEqual(["ev-001"]);
    expect(byId.get("component:1")?.evidenceIds).toEqual(["ev-002"]);
    expect(byId.get("testing")?.evidenceIds).toEqual(["ev-004"]);
    // A node names the claim it came from, so the UI can jump back to it.
    expect(byId.get("component:1")?.claimId).toBe("components-1");

    const exposes = graph.edges.find((edge) => edge.relationship === "exposes");
    expect(exposes?.evidenceIds).toEqual(["ev-001"]);
  });

  it("omits an unevidenced claim and counts the omission instead of hiding it", () => {
    const graph = buildArchitectureGraph(
      report({
        components: [
          {
            id: "components-0",
            section: "components",
            evidenceIds: [],
            name: "HTTP router",
            path: "src/router.ts",
            responsibility: "Exposes the request routes.",
          },
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.id)).not.toContain("component:0");
    expect(graph.summary.nodesSkippedWithoutEvidence).toBe(1);
    // The edge that would have hung off it is not double-counted as a second failure.
    expect(graph.summary.edgesSkippedWithoutEvidence).toBe(0);
    expect(graph.edges).toEqual([]);
  });

  it("counts an unevidenced relationship between two evidenced nodes", () => {
    // The flow's own claim cites nothing, so its edges have nothing to rest on.
    const graph = buildArchitectureGraph(
      report({
        flows: [
          {
            id: "flows-0",
            section: "flows",
            evidenceIds: [],
            name: "Write path",
            description: "A request becomes a record.",
            steps: ["src/router.ts receives the request", "src/store.ts writes the record"],
          },
        ],
      }),
    );

    expect(graph.summary.edgesSkippedWithoutEvidence).toBe(1);
    expect(graph.edges.some((edge) => edge.relationship === "writes-to")).toBe(false);
  });

  it("derives a flow edge and takes its relationship from the step's verb", () => {
    const graph = buildArchitectureGraph(
      report({
        flows: [
          {
            id: "flows-0",
            section: "flows",
            evidenceIds: ["ev-001"],
            name: "Write path",
            description: "A request becomes a record.",
            steps: ["src/router.ts receives the request", "src/store.ts writes the record"],
          },
        ],
      }),
    );

    const flowEdge = graph.edges.find((edge) => edge.from === "component:0" && edge.to === "component:1");
    expect(flowEdge?.relationship).toBe("writes-to");
    expect(flowEdge?.evidenceIds).toEqual(["ev-001"]);
    expect(flowEdge?.description).toContain("Write path");
  });

  it("draws a tests edge only where the testing claim names the component", () => {
    const graph = buildArchitectureGraph(
      report({ testing: { approach: "One vitest suite covering src/router.ts." } }),
    );

    const tested = graph.edges.filter((edge) => edge.relationship === "tests");
    expect(tested).toHaveLength(1);
    expect(tested[0]?.from).toBe("testing");
    expect(tested[0]?.to).toBe("component:0");
    expect(tested[0]?.evidenceIds).toEqual(["ev-004"]);
  });

  it("rejects a relationship outside the closed vocabulary", () => {
    expect(() => assertRelationship("orchestrates")).toThrowError(/Unsupported relationship "orchestrates"/);
    // The error names the supported set, because the caller is usually a human debugging.
    expect(() => assertRelationship("orchestrates")).toThrowError(/depends-on/);
    for (const relationship of RELATIONSHIPS) {
      expect(assertRelationship(relationship)).toBe(relationship);
    }
  });

  it("rejects a node type outside the closed vocabulary", () => {
    expect(() => assertNodeType("microservice")).toThrowError(/Unsupported node type "microservice"/);
    for (const type of NODE_TYPES) {
      expect(assertNodeType(type)).toBe(type);
    }
  });

  it("is deterministic: the same report yields byte-identical output", () => {
    const source = report({
      flows: [
        {
          id: "flows-0",
          section: "flows",
          evidenceIds: ["ev-001"],
          name: "Write path",
          description: "A request becomes a record.",
          steps: ["src/router.ts receives the request", "src/store.ts writes the record"],
        },
      ],
    });

    const first = buildArchitectureGraph(source);
    const second = buildArchitectureGraph(source);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // And insertion order must not leak: reversing the input claims changes the ids the
    // nodes get, but the *ordering* of the output stays the declared type layering.
    const reversed = buildArchitectureGraph({
      ...source,
      components: [...source.components].reverse(),
    });
    expect(reversed.nodes.map((node) => node.type)).toEqual(first.nodes.map((node) => node.type));
  });

  it("infers node types from general vocabulary rather than any particular repository", () => {
    const graph = buildArchitectureGraph(
      report({
        components: [
          { id: "components-0", section: "components", evidenceIds: ["ev-001"], name: "cli", path: "bin/tool.ts", responsibility: "Command line entry point." },
          { id: "components-1", section: "components", evidenceIds: ["ev-001"], name: "job runner", path: "src/worker.ts", responsibility: "Runs background jobs." },
          { id: "components-2", section: "components", evidenceIds: ["ev-001"], name: "settings", path: "config/app.yaml", responsibility: "Holds the settings." },
          { id: "components-3", section: "components", evidenceIds: ["ev-001"], name: "events", path: "src/events.ts", responsibility: "Publishes to the message bus topic." },
          { id: "components-4", section: "components", evidenceIds: ["ev-001"], name: "helpers", path: "src/helpers.ts", responsibility: "Small shared functions." },
        ],
        dependencies: [
          { id: "dependencies-0", section: "dependencies", evidenceIds: ["ev-003"], name: "pg", version: "^8", scope: "runtime", purpose: "Postgres driver." },
          { id: "dependencies-1", section: "dependencies", evidenceIds: ["ev-003"], name: "bullmq", version: "^5", scope: "runtime", purpose: "Job queue." },
          { id: "dependencies-2", section: "dependencies", evidenceIds: ["ev-003"], name: "stripe", version: "^14", scope: "runtime", purpose: "Payments." },
          { id: "dependencies-3", section: "dependencies", evidenceIds: ["ev-003"], name: "lodash", version: "^4", scope: "runtime", purpose: "Utilities." },
        ],
      }),
    );

    const typeOf = (id: string): string | undefined => graph.nodes.find((node) => node.id === id)?.type;
    expect(typeOf("component:0")).toBe("cli");
    expect(typeOf("component:1")).toBe("worker");
    expect(typeOf("component:2")).toBe("configuration");
    expect(typeOf("component:3")).toBe("queue");
    expect(typeOf("component:4")).toBe("module");
    expect(typeOf("dependency:0")).toBe("database");
    expect(typeOf("dependency:1")).toBe("queue");
    expect(typeOf("dependency:2")).toBe("external-service");
    expect(typeOf("dependency:3")).toBe("package");

    // A configuration component configures the application rather than being contained
    // by it, so the arrow points the other way.
    expect(
      graph.edges.some((edge) => edge.from === "component:2" && edge.to === "app" && edge.relationship === "configures"),
    ).toBe(true);
  });

  it("never invents a node from the filesystem: the graph is a function of the report", () => {
    // A repository claiming 4 files but no components yields the three claim-backed
    // nodes and nothing else — the builder has no way to reach a disk.
    const graph = buildArchitectureGraph(report({ components: [], dependencies: [] }));
    expect(graph.nodes.map((node) => node.id)).toEqual(["app", "testing"]);
    expect(graph.edges).toEqual([]);
  });
});
