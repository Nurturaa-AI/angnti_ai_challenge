import type { AnalysisReport, ReportComponent, ReportDependency } from "./report";

/**
 * The architecture graph.
 *
 * Derived from the report, never from the repository directly: a node exists because
 * a claim in the briefing established it, and it carries the ids of the citations that
 * did so. That is the whole design constraint. A graph drawn by re-walking the
 * filesystem would be prettier and completely unfalsifiable — you could not click a
 * box and ask "where did you find this?", which is the one question this product is
 * for.
 *
 * Two rules follow from it and are enforced below:
 *
 *   1. No node and no edge is emitted without at least one evidence id. Anything that
 *      would have been unevidenced is *counted* in the summary rather than dropped
 *      silently, so a thin graph reads as thin evidence rather than as a thin repository.
 *   2. Node types and relationships are inferred from general vocabulary — "route",
 *      "queue", "publishes" — and never from anything specific to a repository this
 *      project happens to be evaluated against. A pattern list tuned to the fixtures
 *      would draw beautiful graphs of exactly two repositories.
 */

export const NODE_TYPES = [
  "application",
  "package",
  "module",
  "api",
  "database",
  "queue",
  "worker",
  "external-service",
  "cli",
  "configuration",
  "test-suite",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const RELATIONSHIPS = [
  "imports",
  "calls",
  "depends-on",
  "reads-from",
  "writes-to",
  "publishes",
  "consumes",
  "tests",
  "exposes",
  "configures",
] as const;

export type Relationship = (typeof RELATIONSHIPS)[number];

export interface ArchitectureNode {
  id: string;
  type: NodeType;
  label: string;
  /** Repository-relative path, when the claim named one. */
  path: string | undefined;
  description: string;
  /** The claim this node came from, so the UI can jump to it. */
  claimId: string;
  /** Never empty. See rule 1. */
  evidenceIds: string[];
}

export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  relationship: Relationship;
  /** Why this edge is drawn, in one phrase. */
  description: string;
  /** Never empty. See rule 1. */
  evidenceIds: string[];
}

export interface ArchitectureSummary {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
  edgesByRelationship: Record<string, number>;
  /** Claims that would have become nodes but cited nothing. */
  nodesSkippedWithoutEvidence: number;
  /** Relationships that would have become edges but cited nothing. */
  edgesSkippedWithoutEvidence: number;
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  summary: ArchitectureSummary;
}

/**
 * Rejects a relationship this model does not define.
 *
 * A `Relationship` is a closed vocabulary, and the closure has to be checked at
 * runtime rather than only by the compiler: an edge relationship can arrive from
 * inference over model prose, which the type system never sees.
 */
export function assertRelationship(value: string): Relationship {
  if ((RELATIONSHIPS as readonly string[]).includes(value)) return value as Relationship;
  throw new Error(
    `Unsupported relationship "${value}". Supported relationships: ${RELATIONSHIPS.join(", ")}.`,
  );
}

export function assertNodeType(value: string): NodeType {
  if ((NODE_TYPES as readonly string[]).includes(value)) return value as NodeType;
  throw new Error(`Unsupported node type "${value}". Supported node types: ${NODE_TYPES.join(", ")}.`);
}

export function buildArchitectureGraph(report: AnalysisReport): ArchitectureGraph {
  const builder = new GraphBuilder();

  const applicationId = "app";
  builder.addNode({
    id: applicationId,
    type: "application",
    label: report.repository.name,
    path: undefined,
    description: firstSentence(report.summary),
    claimId: "overview",
    evidenceIds: report.overviewEvidenceIds,
  });

  // Components, dependencies and the testing claim become the vocabulary that flow
  // steps are later resolved against, so they are all added before any edge is drawn.
  const componentNodes = new Map<string, ReportComponent>();
  for (const [index, component] of report.components.entries()) {
    const id = `component:${index}`;
    const type = inferComponentType(component);
    builder.addNode({
      id,
      type,
      label: component.name,
      path: component.path,
      description: component.responsibility,
      claimId: component.id,
      evidenceIds: component.evidenceIds,
    });
    componentNodes.set(id, component);
  }

  const dependencyNodes = new Map<string, ReportDependency>();
  for (const [index, dependency] of report.dependencies.entries()) {
    const id = `dependency:${index}`;
    builder.addNode({
      id,
      type: inferDependencyType(dependency),
      label: dependency.name,
      path: undefined,
      description: dependency.purpose ?? `${dependency.scope} dependency`,
      claimId: dependency.id,
      evidenceIds: dependency.evidenceIds,
    });
    dependencyNodes.set(id, dependency);
  }

  const testingId = "testing";
  builder.addNode({
    id: testingId,
    type: "test-suite",
    label: "Test suite",
    path: report.testing.testPaths[0],
    description: report.testing.approach,
    claimId: report.testing.id,
    evidenceIds: report.testing.evidenceIds,
  });

  // 1. Structural edges: the application and the components it is made of. A
  //    component's own citations are what established that it exists in this
  //    repository, so they are what supports the containment edge.
  for (const [nodeId, component] of componentNodes) {
    const type = builder.typeOf(nodeId) ?? inferComponentType(component);
    if (type === "configuration") {
      builder.addEdge({
        from: nodeId,
        to: applicationId,
        relationship: "configures",
        description: `${component.name} configures ${report.repository.name}`,
        evidenceIds: component.evidenceIds,
      });
      continue;
    }
    builder.addEdge({
      from: applicationId,
      to: nodeId,
      relationship: type === "api" || type === "cli" ? "exposes" : "depends-on",
      description:
        type === "api" || type === "cli"
          ? `${report.repository.name} exposes ${component.name}`
          : `${report.repository.name} contains ${component.name}`,
      evidenceIds: component.evidenceIds,
    });
  }

  // 2. Component to dependency, where the component's own claim names it. The claim
  //    text is the assertion; the claim's citations are what backs it.
  for (const [componentId, component] of componentNodes) {
    const haystack = `${component.name} ${component.path ?? ""} ${component.responsibility}`.toLowerCase();
    for (const [dependencyId, dependency] of dependencyNodes) {
      if (!mentions(haystack, dependency.name)) continue;
      const dependencyType = builder.typeOf(dependencyId) ?? "package";
      builder.addEdge({
        from: componentId,
        to: dependencyId,
        relationship: relationshipForDependency(dependencyType),
        description: `${component.name} uses ${dependency.name}`,
        evidenceIds: component.evidenceIds,
      });
    }
  }

  // 3. Flow edges. A flow's steps are an ordered narrative; consecutive steps that
  //    each name a known node become an edge, and the *verb* of the later step decides
  //    the relationship. The flow's citations support every edge derived from it.
  const resolvable = [
    ...[...componentNodes].map(([id, component]) => ({
      id,
      terms: [component.name, component.path ?? ""].filter((term) => term !== ""),
    })),
    ...[...dependencyNodes].map(([id, dependency]) => ({ id, terms: [dependency.name] })),
  ];

  for (const flow of report.flows) {
    let previous: string | undefined;
    for (const step of flow.steps) {
      const matched = resolveStep(step, resolvable);
      if (matched === undefined) continue;
      if (previous !== undefined && previous !== matched) {
        builder.addEdge({
          from: previous,
          to: matched,
          relationship: inferRelationshipFromStep(step),
          description: `${flow.name}: ${truncate(step, 120)}`,
          evidenceIds: flow.evidenceIds,
        });
      }
      previous = matched;
    }
  }

  // 4. Test edges, where the testing claim itself names a component. Without executing
  //    anything, "what is covered" is only knowable from what the claim says — so this
  //    is drawn from the claim's own text and carries the claim's own citations.
  const testingHaystack = [
    report.testing.approach,
    ...report.testing.testPaths,
    ...report.testing.frameworks,
    ...report.testing.gaps,
  ]
    .join(" ")
    .toLowerCase();

  for (const [componentId, component] of componentNodes) {
    const named =
      mentions(testingHaystack, component.name) ||
      (component.path !== undefined && component.path !== "" && mentions(testingHaystack, component.path));
    if (!named) continue;
    builder.addEdge({
      from: testingId,
      to: componentId,
      relationship: "tests",
      description: `The testing claim names ${component.name}`,
      evidenceIds: report.testing.evidenceIds,
    });
  }

  return builder.build();
}

class GraphBuilder {
  private readonly nodes = new Map<string, ArchitectureNode>();
  private readonly edges = new Map<string, ArchitectureEdge>();
  private nodesSkipped = 0;
  private edgesSkipped = 0;

  addNode(node: Omit<ArchitectureNode, "type"> & { type: NodeType }): void {
    assertNodeType(node.type);
    if (node.evidenceIds.length === 0) {
      this.nodesSkipped += 1;
      return;
    }
    this.nodes.set(node.id, { ...node, evidenceIds: [...new Set(node.evidenceIds)] });
  }

  typeOf(nodeId: string): NodeType | undefined {
    return this.nodes.get(nodeId)?.type;
  }

  addEdge(edge: {
    from: string;
    to: string;
    relationship: Relationship | string;
    description: string;
    evidenceIds: readonly string[];
  }): void {
    const relationship = assertRelationship(
      typeof edge.relationship === "string" ? edge.relationship : String(edge.relationship),
    );
    // An edge to or from a node that was itself dropped for lack of evidence is not a
    // separate failure to report; the node's absence already says it.
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    if (edge.evidenceIds.length === 0) {
      this.edgesSkipped += 1;
      return;
    }
    const id = `${edge.from}->${edge.to}:${relationship}`;
    const existing = this.edges.get(id);
    if (existing) {
      for (const evidenceId of edge.evidenceIds) {
        if (!existing.evidenceIds.includes(evidenceId)) existing.evidenceIds.push(evidenceId);
      }
      return;
    }
    this.edges.set(id, {
      id,
      from: edge.from,
      to: edge.to,
      relationship,
      description: edge.description,
      evidenceIds: [...new Set(edge.evidenceIds)],
    });
  }

  build(): ArchitectureGraph {
    // Sorted so that the same report always yields byte-identical output. Node type
    // order is the declaration order in NODE_TYPES, which is also the layering the UI
    // draws: application at the top, infrastructure and tests at the bottom.
    const typeRank = new Map(NODE_TYPES.map((type, index) => [type, index]));
    const nodes = [...this.nodes.values()].sort((a, b) => {
      const rank = (typeRank.get(a.type) ?? 0) - (typeRank.get(b.type) ?? 0);
      return rank !== 0 ? rank : a.id.localeCompare(b.id);
    });
    const edges = [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id));

    const nodesByType: Record<string, number> = {};
    for (const node of nodes) nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    const edgesByRelationship: Record<string, number> = {};
    for (const edge of edges) {
      edgesByRelationship[edge.relationship] = (edgesByRelationship[edge.relationship] ?? 0) + 1;
    }

    return {
      nodes,
      edges,
      summary: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodesByType,
        edgesByRelationship,
        nodesSkippedWithoutEvidence: this.nodesSkipped,
        edgesSkippedWithoutEvidence: this.edgesSkipped,
      },
    };
  }
}

/*
 * Inference vocabulary.
 *
 * General engineering words only. The ordering is the precedence: a path under
 * `tests/` that also contains `config` is a test suite, because the more specific
 * signal is the directory it lives in.
 */

const TYPE_PATTERNS: readonly { type: NodeType; pattern: RegExp }[] = [
  { type: "test-suite", pattern: /(^|[/\s_-])(tests?|__tests__|specs?|testing)([/\s_-]|$)|\.(test|spec)\.[a-z]+$/ },
  {
    type: "configuration",
    pattern: /(^|[/\s_-])(config|configs|configuration|settings|dotenv|env)([/\s_-]|$)|\.(json|ya?ml|toml|ini|cfg|conf|env)$/,
  },
  { type: "cli", pattern: /(^|[/\s_-])(cli|bin|cmd|command|commands|console|entrypoint)([/\s_-]|$)|command[\s-]?line/ },
  {
    type: "api",
    pattern:
      /(^|[/\s_-])(api|apis|route|routes|router|controller|controllers|handler|handlers|endpoint|endpoints|http|rest|graphql|server|web)([/\s_-]|$)/,
  },
  { type: "queue", pattern: /\b(queue|queues|broker|kafka|rabbitmq|amqp|sqs|pubsub|pub\/sub|topic|event bus|message bus)\b/ },
  {
    type: "database",
    pattern:
      /\b(database|db|sql|postgres|postgresql|mysql|sqlite|mongodb|mongo|redis|dynamodb|cassandra|persistence|migrations?|repository|dao)\b/,
  },
  { type: "worker", pattern: /\b(worker|workers|job|jobs|task queue|cron|scheduler|daemon|background)\b/ },
  { type: "package", pattern: /^(packages|apps|libs|lib|modules|services|crates)\// },
];

function inferComponentType(component: ReportComponent): NodeType {
  // Path first: where code lives is a stronger signal than how a sentence describes it.
  const path = (component.path ?? "").toLowerCase();
  const name = component.name.toLowerCase();
  const responsibility = component.responsibility.toLowerCase();

  for (const { type, pattern } of TYPE_PATTERNS) {
    if (path !== "" && pattern.test(path)) return type;
  }
  for (const { type, pattern } of TYPE_PATTERNS) {
    if (pattern.test(name)) return type;
  }
  for (const { type, pattern } of TYPE_PATTERNS) {
    if (pattern.test(responsibility)) return type;
  }
  return "module";
}

const DEPENDENCY_PATTERNS: readonly { type: NodeType; pattern: RegExp }[] = [
  { type: "queue", pattern: /\b(kafka|rabbit|amqp|sqs|pubsub|celery|bull|bullmq|nats|sidekiq|resque)\b/ },
  {
    type: "database",
    pattern:
      /\b(pg|postgres|postgresql|mysql|mysql2|sqlite|sqlite3|mongo|mongoose|mongodb|redis|ioredis|sequelize|prisma|typeorm|knex|sqlalchemy|psycopg2?|dynamodb|cassandra|neo4j)\b/,
  },
  {
    type: "external-service",
    pattern: /\b(aws|azure|gcp|google-cloud|stripe|twilio|sendgrid|axios|requests|httpx|node-fetch|got|okhttp|sdk|client)\b/,
  },
];

function inferDependencyType(dependency: ReportDependency): NodeType {
  const haystack = `${dependency.name} ${dependency.purpose ?? ""}`.toLowerCase();
  for (const { type, pattern } of DEPENDENCY_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return "package";
}

/** Which relationship a component has with a dependency of a given kind. */
function relationshipForDependency(dependencyType: NodeType): Relationship {
  switch (dependencyType) {
    case "database":
      return "reads-from";
    case "queue":
      return "publishes";
    case "external-service":
      return "calls";
    default:
      return "imports";
  }
}

const STEP_VERBS: readonly { relationship: Relationship; pattern: RegExp }[] = [
  { relationship: "publishes", pattern: /\b(publish|publishes|published|emit|emits|enqueue|enqueues|dispatch|dispatches|produce|produces)\b/ },
  { relationship: "consumes", pattern: /\b(consume|consumes|subscribe|subscribes|listen|listens|receive|receives|poll|polls|dequeue)\b/ },
  { relationship: "writes-to", pattern: /\b(write|writes|save|saves|persist|persists|insert|inserts|update|updates|store|stores|delete|deletes|commit|commits)\b/ },
  { relationship: "reads-from", pattern: /\b(read|reads|load|loads|fetch|fetches|query|queries|select|selects|retrieve|retrieves|lookup|looks up)\b/ },
  { relationship: "imports", pattern: /\b(import|imports|require|requires|include|includes)\b/ },
  { relationship: "tests", pattern: /\b(test|tests|asserts?|verif(y|ies))\b/ },
  { relationship: "configures", pattern: /\b(configure|configures|initialise|initialises|initialize|initializes|bootstrap|bootstraps)\b/ },
  { relationship: "calls", pattern: /\b(call|calls|invoke|invokes|request|requests|send|sends|forward|forwards|route|routes|dispatch to)\b/ },
];

/**
 * `calls` is the default rather than `depends-on`: a flow step describes something
 * happening at run time, and "A depends on B" is a statement about structure.
 */
function inferRelationshipFromStep(step: string): Relationship {
  const text = step.toLowerCase();
  for (const { relationship, pattern } of STEP_VERBS) {
    if (pattern.test(text)) return relationship;
  }
  return "calls";
}

/** The node a flow step is about, or `undefined` when it names none. */
function resolveStep(
  step: string,
  candidates: readonly { id: string; terms: string[] }[],
): string | undefined {
  const text = step.toLowerCase();
  let best: { id: string; length: number } | undefined;
  for (const candidate of candidates) {
    for (const term of candidate.terms) {
      if (!mentions(text, term)) continue;
      // Longest match wins, so "orders/service.js" beats "orders".
      if (best === undefined || term.length > best.length) best = { id: candidate.id, length: term.length };
    }
  }
  return best?.id;
}

/**
 * Word-boundary-ish containment.
 *
 * Plain `includes` would match "api" inside "rapid" and produce edges nobody claimed.
 * The boundary characters are deliberately generous — paths, dots and dashes all
 * count as separators — because the terms being matched are identifiers and paths.
 */
function mentions(haystack: string, rawTerm: string): boolean {
  const term = rawTerm.trim().toLowerCase().replace(/\/+$/, "");
  if (term.length < 3) return false;
  const index = haystack.indexOf(term);
  if (index === -1) return false;
  const before = index === 0 ? " " : haystack[index - 1] ?? " ";
  const after = haystack[index + term.length] ?? " ";
  const isBoundary = (character: string): boolean => !/[a-z0-9]/.test(character);
  return isBoundary(before) && isBoundary(after);
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return match?.[1] ?? truncate(text.trim(), 200);
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
