import { redactSecrets } from "@repo-arch/shared";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "../architecture";
import type { AnsweredQuestionView } from "../questions";
import type { AnalysisReport, ReportEvidence } from "../report";
import { PDF_LETTER, PdfWriter, type PdfFont } from "./pdf/writer";
import type { ExportInput, ReportExporter } from "./types";

/**
 * The PDF exporter: layout only. Byte-level PDF concerns live in `pdf/writer.ts`.
 *
 * The document's job is to survive leaving the tool. Once exported it gets mailed,
 * quoted in a design review and pasted into a ticket, with nobody able to click through
 * to the file a sentence came from — so the export is deliberately stricter than the
 * dashboard, in two ways:
 *
 *   1. **A claim with no grounded citation is not printed.** Components, flows,
 *      dependencies, testing and risks are filtered on `evidenceIds.length > 0`. What
 *      is omitted is counted, and the counts appear in the audit section, so a thin
 *      report reads as thin evidence rather than as a small repository.
 *   2. **Every printed claim names its evidence, and the evidence is in the document.**
 *      The appendix lists each `ev-NNN` with its artefact, its origin and its verified
 *      excerpt, so the citations are checkable on paper.
 *
 * The one narrative exception is the overview. `summary` and `architecture` are the
 * frame the rest of the document hangs on, and grounding itself keeps a claim that lost
 * all its evidence rather than deleting it — so the overview is kept and stamped
 * UNVERIFIED when it has no grounded citation. A visible stamp warns a reader that
 * silence cannot.
 *
 * Everything printed here originates in a repository or a model, so every string is
 * bounded and passed through `redactSecrets` on the way in.
 */

const MARGIN_X = 54;
const CONTENT_TOP = 68;
const CONTENT_BOTTOM = 716;
const CONTENT_WIDTH = PDF_LETTER.width - MARGIN_X * 2;
const BODY_SIZE = 9.5;
const BODY_LEADING = 13;
const LABEL_COLUMN = 116;

const INK: readonly [number, number, number] = [0.11, 0.12, 0.14];
const MUTED: readonly [number, number, number] = [0.43, 0.45, 0.49];
const ACCENT: readonly [number, number, number] = [0.09, 0.35, 0.6];
const WARN: readonly [number, number, number] = [0.7, 0.28, 0.1];
const RULE: readonly [number, number, number] = [0.85, 0.86, 0.88];
const PAPER_TINT: readonly [number, number, number] = [0.96, 0.965, 0.97];
const WHITE: readonly [number, number, number] = [1, 1, 1];
/** The diagram's box fill and its border. Light enough to read black text on. */
const BOX_FILL: readonly [number, number, number] = [0.93, 0.95, 0.97];
const BOX_EDGE: readonly [number, number, number] = [0.62, 0.68, 0.75];
const WIRE: readonly [number, number, number] = [0.72, 0.76, 0.8];

/** Bounds on untrusted text. Generous enough to be useful, small enough to be finite. */
const MAX_EXCERPT_CHARS = 320;
const MAX_PROSE_CHARS = 6_000;
const MAX_ANSWER_CHARS = 4_000;
const MAX_LINE_CHARS = 400;
const MAX_LIST_ROWS = 80;

export interface PdfExporterOptions {
  /** Overrides the clock so a test can assert on byte-identical output. */
  now?: (() => Date) | undefined;
}

export class PdfReportExporter implements ReportExporter {
  readonly format = "pdf";
  readonly contentType = "application/pdf";

  private readonly now: () => Date;

  constructor(options: PdfExporterOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
  }

  export(input: ExportInput): Promise<Uint8Array> {
    return Promise.resolve(this.render(input));
  }

  filename(report: AnalysisReport): string {
    const name = slug(report.repository.name) || "repository";
    const id = slug(report.id).slice(0, 12) || "analysis";
    return `repo-analysis-${name}-${id}.pdf`;
  }

  /**
   * Synchronous by nature; `export` wraps it so the seam can host async exporters.
   *
   * The section order is the document's argument, and it is deliberate: what was
   * analysed, under what conditions, what it concluded, what the shape is, then the
   * detail, then the questions, then every citation. A reader who stops after page
   * three has the findings and knows how much to trust them.
   */
  private render(input: ExportInput): Uint8Array {
    const { report, graph, questions } = input;
    const pdf = new PdfWriter(
      {
        title: `Repository analysis — ${clean(report.repository.name)}`,
        author: `${clean(report.system)} ${clean(report.systemVersion)}`,
        subject: "Evidence-backed repository analysis",
        creator: "Repo Archaeologist",
        createdAt: this.now(),
      },
      PDF_LETTER,
    );

    const doc = new Doc(pdf, `${clean(report.repository.name)} — grounded evidence only`);
    doc.newPage();

    writeCover(doc, report, graph, questions);
    doc.newPage(); // The cover owns page one.
    writeRepositoryOverview(doc, report);
    writeAnalysisMetadata(doc, report, input);
    writeExecutiveBriefing(doc, report);
    writeArchitectureVisualization(doc, graph);
    writeKeyFindings(doc, report, graph);
    writeComponents(doc, report);
    writeFlows(doc, report);
    writeDependencies(doc, report);
    writeTesting(doc, report);
    writeRisks(doc, report);
    writeReading(doc, report);
    writeQuestions(doc, questions);
    writeEvidenceReferences(doc, report, graph);
    writeAudit(doc, report, graph);
    writeEvidenceAppendix(doc, report);
    writeSourceAppendix(doc, report);

    return pdf.build();
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Claims dropped for want of a grounded citation, tallied for the audit section. */
function omittedClaimCount(report: AnalysisReport): number {
  return (
    report.components.filter((claim) => claim.evidenceIds.length === 0).length +
    report.flows.filter((claim) => claim.evidenceIds.length === 0).length +
    report.dependencies.filter((claim) => claim.evidenceIds.length === 0).length +
    (report.testing.evidenceIds.length === 0 ? 1 : 0) +
    report.risks.filter((claim) => claim.evidenceIds.length === 0).length
  );
}

function writeCover(
  doc: Doc,
  report: AnalysisReport,
  graph: ArchitectureGraph,
  questions: readonly AnsweredQuestionView[],
): void {
  doc.accentBar();
  doc.eyebrow("REPOSITORY ANALYSIS");
  doc.title(clean(report.repository.name));

  const head = report.repository.head;
  doc.spacer(6);
  doc.keyValue("Repository", clean(report.repository.path));
  doc.keyValue(
    "Contents",
    `${count(report.repository.fileCount, "file")}, ${count(report.repository.directoryCount, "directory", "directories")}, ${bytes(report.repository.totalBytes)}`,
  );
  if (head) doc.keyValue("Commit", `${clean(head.commit).slice(0, 12)} on ${clean(head.branch)}`);
  doc.keyValue("Analysed by", `${clean(report.system)} ${clean(report.systemVersion)}`);
  doc.keyValue("Model", `${clean(report.provider)} / ${clean(report.model)}`);
  doc.keyValue("Finished", clean(report.finishedAt));
  doc.keyValue("Duration", duration(report.metrics.durationMs));
  doc.keyValue("Self-reported confidence", `${Math.round(report.confidence * 100)}%`);

  doc.spacer(14);
  doc.panel((panel) => {
    panel.eyebrow("EVIDENCE AT A GLANCE");
    panel.spacer(4);
    const m = report.metrics;
    panel.keyValue("Citations", `${m.citationsGrounded} grounded of ${m.citationsClaimed} claimed`);
    panel.keyValue("Dropped", count(m.citationsDropped, "citation"));
    panel.keyValue("Unsupported claims", String(m.unsupportedClaims));
    panel.keyValue("Files inspected", `${m.filesInspected} (${m.ledgerSources} artefacts in the ledger)`);
    panel.keyValue("Architecture", `${graph.summary.nodeCount} nodes, ${graph.summary.edgeCount} edges`);
    panel.keyValue("Questions answered", String(questions.length));
    panel.keyValue(
      "Tokens",
      `${m.inputTokens} in, ${m.outputTokens} out${m.estimatedCostUsd === null ? "" : ` (~$${m.estimatedCostUsd.toFixed(4)})`}`,
    );
  });

  doc.spacer(14);
  doc.paragraph(
    "Every claim in this document names the citations that support it, and every citation is listed in the evidence appendix with the excerpt that was verified against the repository. Claims that survived analysis without a grounded citation are omitted and counted in the audit section.",
    { size: 8.5, color: MUTED },
  );
}

/** What was analysed. Repeated from the cover because a cover gets detached. */
function writeRepositoryOverview(doc: Doc, report: AnalysisReport): void {
  const repository = report.repository;
  doc.heading("Repository overview", clean(repository.path));

  doc.keyValue("Name", clean(repository.name));
  doc.keyValue("Path", line(repository.path));
  doc.keyValue("Files", String(repository.fileCount));
  doc.keyValue("Directories", String(repository.directoryCount));
  doc.keyValue("Size on disk", bytes(repository.totalBytes));
  doc.keyValue("Version control", repository.isGitRepository ? "git" : "not a git working tree");
  const head = repository.head;
  if (head !== null) {
    doc.keyValue("Commit", clean(head.commit));
    doc.keyValue("Branch", clean(head.branch));
  }

  if (repository.languages.length > 0) {
    doc.spacer(6);
    doc.subheading("File types by count");
    for (const language of capped(repository.languages, 12)) {
      doc.row(clean(language.extension), count(language.files, "file"));
    }
  }
}

/**
 * Under what conditions. The part a reader needs to reproduce or date the analysis.
 *
 * The path printed here is the workspace-relative one the store holds, never the
 * absolute root — the same rule the API DTOs follow, for the same reason: this
 * document leaves the machine that made it.
 */
function writeAnalysisMetadata(doc: Doc, report: AnalysisReport, input: ExportInput): void {
  doc.heading("Analysis metadata");

  doc.keyValue("Analysis id", clean(input.analysisId ?? report.id));
  doc.keyValue("Report id", clean(report.id));
  doc.keyValue("System", `${clean(report.system)} ${clean(report.systemVersion)}`);
  doc.keyValue("Provider", clean(report.provider));
  doc.keyValue("Model", clean(report.model));
  if (input.repositoryPath !== undefined) {
    doc.keyValue("Workspace path", line(input.repositoryPath));
  }
  if (input.createdAt !== undefined) doc.keyValue("Requested", clean(input.createdAt));
  doc.keyValue("Started", clean(report.startedAt));
  doc.keyValue("Finished", clean(report.finishedAt));
  doc.keyValue("Pipeline duration", duration(report.metrics.durationMs));
  if (input.durationMs !== undefined && input.durationMs !== null) {
    doc.keyValue("Lifecycle duration", duration(input.durationMs));
  }
  doc.keyValue("Schema version", String(report.schemaVersion));

  doc.spacer(8);
  doc.panel((panel) => {
    panel.eyebrow("MEASUREMENT");
    panel.spacer(4);
    const m = report.metrics;
    panel.keyValue("Tool calls", String(m.toolCalls));
    panel.keyValue("Scout file reads", String(m.scoutFilesRead));
    panel.keyValue("Files inspected", String(m.filesInspected));
    panel.keyValue("Ledger artefacts", String(m.ledgerSources));
    panel.keyValue("Evidence items", String(m.evidenceCount));
    panel.keyValue("Tokens", `${m.inputTokens} in, ${m.outputTokens} out`);
    panel.keyValue(
      "Estimated cost",
      m.estimatedCostUsd === null ? "not priced for this model" : `$${m.estimatedCostUsd.toFixed(4)}`,
    );
  });
}

function writeExecutiveBriefing(doc: Doc, report: AnalysisReport): void {
  doc.heading("Executive briefing");
  if (report.overviewEvidenceIds.length === 0) {
    doc.stamp("UNVERIFIED — NO GROUNDED CITATION");
    doc.spacer(4);
  }
  doc.subheading("Summary");
  doc.paragraph(prose(report.summary));
  doc.spacer(8);
  doc.subheading("Architecture");
  doc.paragraph(prose(report.architecture));
  doc.evidence(report.overviewEvidenceIds);

  if (report.openQuestions.length > 0) {
    doc.spacer(8);
    doc.subheading("Open questions the analysis could not settle");
    for (const question of capped(report.openQuestions)) doc.bullet(line(question));
  }
}

/**
 * The digest: the highest-severity risks, the testing gaps, and the shape.
 *
 * Not a new claim — every line here is a claim printed in full further down, with the
 * same evidence ids. It exists because a fifteen-page document buries its findings,
 * and a reader who prints this and walks into a meeting needs page two to be the
 * findings rather than the table of contents.
 */
function writeKeyFindings(doc: Doc, report: AnalysisReport, graph: ArchitectureGraph): void {
  const risks = report.risks
    .filter((risk) => risk.evidenceIds.length > 0)
    .slice()
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  const gaps = report.testing.evidenceIds.length > 0 ? report.testing.gaps : [];

  doc.heading("Key findings", `${count(risks.length, "evidence-backed risk")}`);

  if (risks.length === 0 && gaps.length === 0) {
    doc.empty(
      "No risk or testing gap carried a grounded citation. The sections below list what the analysis did establish.",
    );
    return;
  }

  if (risks.length > 0) {
    doc.subheading("Risks, most severe first");
    for (const risk of capped(risks, 8)) {
      doc.row(`[${clean(risk.severity).toUpperCase()}] ${line(risk.title)}`, risk.evidenceIds.join(", "));
    }
  }

  if (gaps.length > 0) {
    doc.spacer(8);
    doc.subheading("Testing gaps");
    for (const gap of capped(gaps, 8)) doc.bullet(line(gap));
    doc.evidence(report.testing.evidenceIds);
  }

  doc.spacer(8);
  doc.paragraph(
    `The architecture graph derived from these claims has ${count(graph.summary.nodeCount, "node")} and ${count(graph.summary.edgeCount, "relationship")}. Each finding above is stated in full, with its evidence, in the sections that follow.`,
    { size: 8.5, color: MUTED },
  );
}

function severityRank(severity: string): number {
  const order = ["low", "medium", "high", "critical"];
  const index = order.indexOf(severity.toLowerCase());
  return index < 0 ? 0 : index;
}

function writeComponents(doc: Doc, report: AnalysisReport): void {
  const kept = report.components.filter((component) => component.evidenceIds.length > 0);
  doc.heading("Components", `${kept.length} of ${report.components.length} evidence-backed`);
  if (kept.length === 0) {
    doc.empty("No component claim carried a grounded citation.");
    return;
  }
  for (const component of capped(kept)) {
    doc.claim(clean(component.name), component.path === undefined ? undefined : line(component.path));
    doc.paragraph(prose(component.responsibility), { indent: 12 });
    doc.evidence(component.evidenceIds, 12);
    doc.spacer(6);
  }
}

function writeFlows(doc: Doc, report: AnalysisReport): void {
  const kept = report.flows.filter((flow) => flow.evidenceIds.length > 0);
  doc.heading("Data flows", `${kept.length} of ${report.flows.length} evidence-backed`);
  if (kept.length === 0) {
    doc.empty("No flow claim carried a grounded citation.");
    return;
  }
  for (const flow of capped(kept)) {
    doc.claim(clean(flow.name));
    doc.paragraph(prose(flow.description), { indent: 12 });
    for (const [index, step] of capped(flow.steps).entries()) {
      doc.numbered(index + 1, line(step), 12);
    }
    doc.evidence(flow.evidenceIds, 12);
    doc.spacer(6);
  }
}

function writeDependencies(doc: Doc, report: AnalysisReport): void {
  const kept = report.dependencies.filter((dependency) => dependency.evidenceIds.length > 0);
  doc.heading("Dependencies", `${kept.length} of ${report.dependencies.length} evidence-backed`);
  if (kept.length === 0) {
    doc.empty("No dependency claim carried a grounded citation.");
    return;
  }
  for (const dependency of capped(kept)) {
    const version = dependency.version === undefined ? "" : ` ${clean(dependency.version)}`;
    doc.claim(`${clean(dependency.name)}${version}`, clean(dependency.scope));
    if (dependency.purpose !== undefined) doc.paragraph(prose(dependency.purpose), { indent: 12 });
    doc.evidence(dependency.evidenceIds, 12);
    doc.spacer(4);
  }
}

function writeTesting(doc: Doc, report: AnalysisReport): void {
  const testing = report.testing;
  doc.heading("Testing");
  if (testing.evidenceIds.length === 0) {
    doc.empty("The testing claim carried no grounded citation.");
    return;
  }
  doc.paragraph(prose(testing.approach));
  doc.spacer(6);
  if (testing.frameworks.length > 0) doc.keyValue("Frameworks", capped(testing.frameworks).map(line).join(", "));
  if (testing.testPaths.length > 0) doc.keyValue("Test paths", capped(testing.testPaths).map(line).join(", "));
  if (testing.gaps.length > 0) {
    doc.spacer(6);
    doc.subheading("Gaps");
    for (const gap of capped(testing.gaps)) doc.bullet(line(gap));
  }
  doc.evidence(testing.evidenceIds);
}

function writeRisks(doc: Doc, report: AnalysisReport): void {
  const kept = report.risks.filter((risk) => risk.evidenceIds.length > 0);
  doc.heading("Risks", `${kept.length} of ${report.risks.length} evidence-backed`);
  if (kept.length === 0) {
    doc.empty("No risk claim carried a grounded citation.");
    return;
  }
  for (const risk of capped(kept)) {
    doc.claim(clean(risk.title), clean(risk.severity).toUpperCase());
    doc.paragraph(prose(risk.description), { indent: 12 });
    doc.evidence(risk.evidenceIds, 12);
    doc.spacer(6);
  }
}

/** Above this the diagram is skipped: see `writeArchitectureVisualization`. */
const MAX_DIAGRAM_NODES = 28;
const MAX_DIAGRAM_EDGES = 60;

function writeArchitectureVisualization(doc: Doc, graph: ArchitectureGraph): void {
  // The heading is Iteration 4's, deliberately. The section gained a drawn figure, but
  // it is the same section about the same graph, and renaming it would have broken a
  // test whose only job is to notice when the document loses the architecture.
  doc.heading("Architecture graph", `${graph.summary.nodeCount} nodes, ${graph.summary.edgeCount} edges`);
  if (graph.nodes.length === 0) {
    doc.empty("No node in the graph carried a grounded citation.");
    return;
  }

  doc.paragraph(
    "Nodes and edges are derived from the claims above, never from a second walk of the filesystem, so each one carries the citations that established it.",
    { size: 8.5, color: MUTED },
  );
  doc.spacer(8);

  const drawable = graph.nodes.length <= MAX_DIAGRAM_NODES && graph.edges.length <= MAX_DIAGRAM_EDGES;
  if (drawable) {
    doc.diagram(graph);
  } else {
    // Degradation, stated rather than silent. Thirty boxes on a Letter page is
    // 40pt of width each, which is not a diagram — it is a wall the reader has to
    // take on faith. The listing below is the same information, legibly.
    doc.spacer(2);
    doc.paragraph(
      `This graph is too large to draw legibly on one page (${graph.nodes.length} nodes, ${graph.edges.length} edges; the diagram is drawn up to ${MAX_DIAGRAM_NODES} nodes and ${MAX_DIAGRAM_EDGES} edges). The full structure is listed below, and the dashboard draws it interactively.`,
      { size: 8.5, color: WARN },
    );
    doc.spacer(6);
  }

  doc.subheading("Nodes");
  // Nodes arrive grouped by type already: `buildArchitectureGraph` sorts them by the
  // declared type order, so a change of type is a group boundary.
  let currentType = "";
  for (const node of capped(graph.nodes)) {
    if (node.type !== currentType) {
      currentType = node.type;
      doc.spacer(4);
      doc.eyebrow(currentType.replace(/-/g, " ").toUpperCase());
      doc.spacer(2);
    }
    const suffix = node.path === undefined ? "" : `  ${line(node.path)}`;
    doc.row(`${clean(node.label)}${suffix}`, node.evidenceIds.join(", "));
  }

  if (graph.edges.length > 0) {
    doc.spacer(10);
    doc.subheading("Relationships");
    const labels = new Map(graph.nodes.map((node) => [node.id, clean(node.label)]));
    for (const edge of capped(graph.edges)) doc.row(edgeLabel(edge, labels), edge.evidenceIds.join(", "));
  }
}

/**
 * `from -[relationship]-> to`.
 *
 * Deliberately ASCII: a real arrow (U+2192) is outside WinAnsi and the writer would
 * have to replace it with a question mark. Do not "improve" this into an arrow.
 */
function edgeLabel(edge: ArchitectureEdge, labels: Map<string, string>): string {
  const from = labels.get(edge.from) ?? edge.from;
  const to = labels.get(edge.to) ?? edge.to;
  return `${from} -[${edge.relationship}]-> ${to}`;
}

function writeReading(doc: Doc, report: AnalysisReport): void {
  if (report.recommendedReading.length === 0) return;
  doc.heading("Where to start reading");
  for (const entry of capped(report.recommendedReading)) {
    doc.claim(`${entry.order}. ${line(entry.path)}`);
    doc.paragraph(prose(entry.reason), { indent: 12 });
    doc.spacer(4);
  }
}

function writeQuestions(doc: Doc, questions: readonly AnsweredQuestionView[]): void {
  if (questions.length === 0) return;
  const supported = questions.filter((question) => question.supported).length;
  doc.heading("Questions", `${supported} of ${questions.length} answered from verified evidence`);

  for (const answered of capped(questions)) {
    doc.claim(line(answered.question));
    if (!answered.supported) {
      doc.spacer(2);
      doc.stamp("UNVERIFIED", 12);
    }
    doc.spacer(4);
    doc.paragraph(truncate(clean(answered.answer), MAX_ANSWER_CHARS), { indent: 12 });
    doc.spacer(4);
    doc.paragraph(
      `Confidence ${Math.round(answered.confidence * 100)}% · ${answered.audit.grounded} of ${answered.audit.claimed} citations grounded · ${count(answered.metrics.toolCalls, "tool call")}`,
      { indent: 12, size: 8, color: MUTED },
    );
    for (const citation of capped(answered.citations)) {
      doc.spacer(2);
      doc.row(`${line(citation.source)}${citation.location === undefined ? "" : `  ${line(citation.location)}`}`, citation.id, 12);
      if (citation.excerpt !== undefined) {
        doc.paragraph(`"${excerpt(citation.excerpt)}"`, { indent: 24, size: 8, font: "mono", color: MUTED });
      }
    }
    doc.spacer(8);
  }
}

/**
 * The index: every evidence id, what it points at, and what cites it.
 *
 * Distinct from Appendix A, which prints the excerpts. This is the lookup table — a
 * reader who sees `ev-014` beside a claim on page four should not have to read four
 * pages of excerpts to find out what it was. Nodes and edges are included because
 * §7's promise is that a graph element names its evidence, and a printed graph has to
 * keep it.
 */
function writeEvidenceReferences(doc: Doc, report: AnalysisReport, graph: ArchitectureGraph): void {
  doc.heading("Evidence references", count(report.evidence.length, "citation"));
  if (report.evidence.length === 0) {
    doc.empty("Nothing survived grounding, so there is nothing to index.");
    return;
  }

  const graphUse = new Map<string, string[]>();
  const note = (ids: readonly string[], label: string): void => {
    for (const id of ids) {
      const existing = graphUse.get(id);
      if (existing === undefined) graphUse.set(id, [label]);
      else if (existing.length < 4 && !existing.includes(label)) existing.push(label);
    }
  };
  for (const node of graph.nodes) note(node.evidenceIds, `node ${clean(node.label)}`);
  for (const edge of graph.edges) note(edge.evidenceIds, `edge ${edge.relationship}`);

  doc.paragraph(
    "Each row is one citation, the artefact it names, and what in this document rests on it. Excerpts are in Appendix A.",
    { size: 8.5, color: MUTED },
  );
  doc.spacer(6);

  for (const item of capped(report.evidence, MAX_LIST_ROWS)) {
    const uses = [...item.claimIds, ...(graphUse.get(item.id) ?? [])];
    doc.row(`${item.id}  ${line(item.source)}${item.location === undefined ? "" : `  ${line(item.location)}`}`, item.type);
    if (uses.length > 0) {
      doc.paragraph(`cited by ${uses.slice(0, 8).join(", ")}`, { indent: 24, size: 7.5, color: MUTED });
    }
  }
  const overflow = report.evidence.length - Math.min(report.evidence.length, MAX_LIST_ROWS);
  if (overflow > 0) {
    doc.spacer(4);
    doc.paragraph(`… and ${count(overflow, "further citation")}, listed in Appendix A.`, {
      size: 8.5,
      color: MUTED,
    });
  }
}

function writeAudit(doc: Doc, report: AnalysisReport, graph: ArchitectureGraph): void {
  doc.heading("Evidence audit");
  const audit = report.audit;

  doc.keyValue("Citations claimed", String(audit.claimed));
  doc.keyValue("Citations grounded", String(audit.grounded));
  doc.keyValue("Citations dropped", String(audit.dropped.length));
  doc.keyValue("Unsupported claims", String(audit.unsupportedClaims));
  doc.keyValue("Claims omitted from this document", String(omittedClaimCount(report)));
  doc.keyValue("Graph nodes without evidence", String(graph.summary.nodesSkippedWithoutEvidence));
  doc.keyValue("Graph edges without evidence", String(graph.summary.edgesSkippedWithoutEvidence));

  doc.spacer(8);
  // Counts only. A dropped citation names a source the system never saw, and reprinting
  // that name here would put an unverifiable path into the document — the one thing the
  // export exists to prevent.
  doc.paragraph(
    "Dropped citations are reported as a count. A dropped citation names an artefact the analysis never read, and reprinting that name in an evidence-backed document would give it the appearance of a finding. The dashboard shows each drop with its reason.",
    { size: 8.5, color: MUTED },
  );
}

function writeEvidenceAppendix(doc: Doc, report: AnalysisReport): void {
  doc.heading("Appendix A — Evidence", count(report.evidence.length, "citation"));
  if (report.evidence.length === 0) {
    doc.empty("Nothing survived grounding.");
    return;
  }
  doc.paragraph(
    "Excerpts below were verified to appear in the named artefact. Locations are reported by the model and are not independently verified; the excerpt is what carries the proof.",
    { size: 8.5, color: MUTED },
  );
  doc.spacer(8);

  for (const item of capped(report.evidence)) {
    doc.evidenceEntry(item);
  }
}

function writeSourceAppendix(doc: Doc, report: AnalysisReport): void {
  doc.heading("Appendix B — Artefacts inspected", count(report.sources.length, "artefact"));
  if (report.sources.length === 0) {
    doc.empty("The ledger is empty.");
    return;
  }
  for (const source of capped(report.sources, MAX_LIST_ROWS)) {
    const facts = [
      source.type,
      bytes(source.bytes),
      source.truncated ? "partial" : "whole",
      source.origins.length > 0 ? source.origins.join("+") : "unattributed",
      count(source.citationCount, "citation"),
    ].join(" · ");
    doc.row(line(source.id), facts);
  }
  const overflow = report.sources.length - Math.min(report.sources.length, MAX_LIST_ROWS);
  if (overflow > 0) {
    doc.spacer(4);
    doc.paragraph(`… and ${count(overflow, "further artefact")}. The dashboard lists all of them.`, {
      size: 8.5,
      color: MUTED,
    });
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface ParagraphOptions {
  indent?: number;
  size?: number;
  font?: PdfFont;
  color?: readonly [number, number, number];
}

/**
 * A cursor over pages.
 *
 * The writer has no concept of flow: it draws at coordinates on the current page. This
 * turns that into "put this next", breaking pages when the cursor runs out of room.
 * Every method that emits more than one line checks the remaining space per line, so a
 * paragraph longer than a page splits instead of running off the bottom.
 */
class Doc {
  private y = CONTENT_TOP;

  constructor(
    private readonly pdf: PdfWriter,
    private readonly runningHead: string,
  ) {}

  newPage(): void {
    const number = this.pdf.newPage();
    this.y = CONTENT_TOP;
    const footerY = PDF_LETTER.height - 40;
    this.pdf.rule(MARGIN_X, footerY - 10, CONTENT_WIDTH, 0.5, RULE);
    this.pdf.text(MARGIN_X, footerY, this.runningHead, { size: 7.5, color: MUTED });
    const label = `Page ${number}`;
    this.pdf.text(MARGIN_X + CONTENT_WIDTH - PdfWriter.measure(label, "regular", 7.5), footerY, label, {
      size: 7.5,
      color: MUTED,
    });
  }

  /** Breaks the page when `height` would not fit below the cursor. */
  private ensure(height: number): void {
    if (this.y + height > CONTENT_BOTTOM) this.newPage();
  }

  spacer(height: number): void {
    this.y += height;
  }

  accentBar(): void {
    this.pdf.rect(MARGIN_X, this.y, CONTENT_WIDTH, 3, ACCENT);
    this.y += 16;
  }

  eyebrow(value: string): void {
    this.ensure(12);
    this.pdf.text(MARGIN_X, this.y, spaced(value), { size: 7.5, font: "bold", color: MUTED });
    this.y += 12;
  }

  title(value: string): void {
    for (const part of PdfWriter.wrap(value, "bold", 22, CONTENT_WIDTH)) {
      this.ensure(28);
      this.pdf.text(MARGIN_X, this.y, part, { size: 22, font: "bold", color: INK });
      this.y += 28;
    }
  }

  /**
   * A top-level section.
   *
   * Breaks the page only when a heading would land with too little room to say anything
   * beneath it. Forcing every section onto its own page would give a small analysis a
   * dozen near-empty pages, which reads as padding.
   */
  heading(value: string, note?: string): void {
    if (this.y > CONTENT_TOP) {
      this.y += 18;
      this.ensure(130);
    }
    this.pdf.rect(MARGIN_X, this.y, 26, 3, ACCENT);
    this.y += 12;
    this.pdf.text(MARGIN_X, this.y, value, { size: 15, font: "bold", color: INK });
    this.y += 20;
    if (note !== undefined) {
      this.pdf.text(MARGIN_X, this.y, note, { size: 8.5, color: MUTED });
      this.y += 12;
    }
    this.pdf.rule(MARGIN_X, this.y, CONTENT_WIDTH, 0.5, RULE);
    this.y += 12;
  }

  subheading(value: string): void {
    this.ensure(34);
    this.pdf.text(MARGIN_X, this.y, value, { size: 10.5, font: "bold", color: INK });
    this.y += 15;
  }

  /** A claim's title line: name on the left, a qualifier on the right. */
  claim(value: string, qualifier?: string): void {
    this.ensure(40);
    const qualifierWidth =
      qualifier === undefined ? 0 : PdfWriter.measure(qualifier, "regular", 8) + 10;
    for (const [index, part] of PdfWriter.wrap(value, "bold", 10, CONTENT_WIDTH - qualifierWidth).entries()) {
      this.ensure(BODY_LEADING);
      this.pdf.text(MARGIN_X, this.y, part, { size: 10, font: "bold", color: INK });
      if (index === 0 && qualifier !== undefined) {
        this.pdf.text(MARGIN_X + CONTENT_WIDTH - qualifierWidth + 10, this.y + 1, qualifier, {
          size: 8,
          color: MUTED,
        });
      }
      this.y += BODY_LEADING;
    }
  }

  paragraph(value: string, options: ParagraphOptions = {}): void {
    const indent = options.indent ?? 0;
    const size = options.size ?? BODY_SIZE;
    const font = options.font ?? "regular";
    const leading = size + 3.5;
    for (const part of PdfWriter.wrap(value, font, size, CONTENT_WIDTH - indent)) {
      this.ensure(leading);
      this.pdf.text(MARGIN_X + indent, this.y, part, { size, font, color: options.color ?? INK });
      this.y += leading;
    }
  }

  bullet(value: string, indent = 0): void {
    const hang = 12;
    for (const [index, part] of PdfWriter.wrap(value, "regular", BODY_SIZE, CONTENT_WIDTH - indent - hang).entries()) {
      this.ensure(BODY_LEADING);
      if (index === 0) this.pdf.text(MARGIN_X + indent, this.y, "•", { size: BODY_SIZE, color: MUTED });
      this.pdf.text(MARGIN_X + indent + hang, this.y, part, { size: BODY_SIZE, color: INK });
      this.y += BODY_LEADING;
    }
  }

  numbered(number: number, value: string, indent = 0): void {
    const hang = 18;
    const marker = `${number}.`;
    for (const [index, part] of PdfWriter.wrap(value, "regular", BODY_SIZE, CONTENT_WIDTH - indent - hang).entries()) {
      this.ensure(BODY_LEADING);
      if (index === 0) this.pdf.text(MARGIN_X + indent, this.y, marker, { size: BODY_SIZE, color: ACCENT });
      this.pdf.text(MARGIN_X + indent + hang, this.y, part, { size: BODY_SIZE, color: INK });
      this.y += BODY_LEADING;
    }
  }

  keyValue(label: string, value: string): void {
    const width = CONTENT_WIDTH - LABEL_COLUMN;
    this.ensure(BODY_LEADING);
    this.pdf.text(MARGIN_X, this.y, label, { size: 8.5, font: "bold", color: MUTED });
    // `wrap` always yields at least one line, so the label is never left unpaired.
    for (const [index, part] of PdfWriter.wrap(value, "regular", BODY_SIZE, width).entries()) {
      if (index > 0) this.ensure(BODY_LEADING);
      this.pdf.text(MARGIN_X + LABEL_COLUMN, this.y, part, { size: BODY_SIZE, color: INK });
      this.y += BODY_LEADING;
    }
  }

  /** A left label with a right-aligned tag: the graph and artefact listings. */
  row(value: string, tag: string, indent = 0): void {
    const tagWidth = tag === "" ? 0 : PdfWriter.measure(tag, "mono", 7.5) + 12;
    const parts = PdfWriter.wrap(value, "mono", 8, CONTENT_WIDTH - indent - tagWidth);
    for (const [index, part] of parts.entries()) {
      this.ensure(12);
      this.pdf.text(MARGIN_X + indent, this.y, part, { size: 8, font: "mono", color: INK });
      if (index === 0 && tag !== "") {
        this.pdf.text(MARGIN_X + CONTENT_WIDTH - tagWidth + 12, this.y, tag, {
          size: 7.5,
          font: "mono",
          color: ACCENT,
        });
      }
      this.y += 12;
    }
  }

  /** The citation ids behind a claim. Nothing is drawn for a claim without any. */
  evidence(ids: readonly string[], indent = 0): void {
    if (ids.length === 0) return;
    this.paragraph(`Evidence: ${ids.join(", ")}`, { indent, size: 8, font: "mono", color: ACCENT });
  }

  evidenceEntry(item: ReportEvidence): void {
    this.ensure(46);
    this.pdf.text(MARGIN_X, this.y, item.id, { size: 9, font: "bold", color: ACCENT });
    const heading = `${item.type} · ${line(item.source)}${item.location === undefined ? "" : ` · ${line(item.location)}`}`;
    for (const [index, part] of PdfWriter.wrap(heading, "mono", 8, CONTENT_WIDTH - 52).entries()) {
      if (index > 0) this.ensure(12);
      this.pdf.text(MARGIN_X + 52, this.y, part, { size: 8, font: "mono", color: INK });
      this.y += 12;
    }
    const facts = [
      item.sourceId === null ? "unresolved artefact" : `artefact ${line(item.sourceId)}`,
      item.origins.length > 0 ? item.origins.join("+") : "unattributed",
      `supports ${item.claimIds.join(", ")}`,
    ].join(" · ");
    this.paragraph(facts, { indent: 52, size: 7.5, color: MUTED });
    if (item.supports !== undefined) {
      this.paragraph(line(item.supports), { indent: 52, size: 8.5 });
    }
    if (item.excerpt !== undefined) {
      this.paragraph(`"${excerpt(item.excerpt)}"`, { indent: 52, size: 8, font: "mono", color: MUTED });
    }
    this.spacer(8);
  }

  /** A warning stamp, for anything the repository did not verify. */
  stamp(value: string, indent = 0): void {
    const width = PdfWriter.measure(value, "bold", 7.5) + 12;
    this.ensure(16);
    this.pdf.rect(MARGIN_X + indent, this.y, width, 12, WARN);
    this.pdf.text(MARGIN_X + indent + 6, this.y + 2.5, value, { size: 7.5, font: "bold", color: WHITE });
    this.y += 16;
  }

  /**
   * Draws the architecture graph as boxes and wires.
   *
   * Layered by node type, in the graph's own declared type order, so a reader gets
   * applications above packages above modules rather than an arbitrary arrangement.
   * Within a band the nodes are spread evenly and wrapped onto further rows when the
   * band is wider than the page.
   *
   * **Nothing here can overlap text, by construction.** The whole figure is measured
   * first, the page is broken if it will not fit, and then it is painted in three
   * passes: wires, then filled boxes, then labels. PDF content streams paint in
   * document order, so a wire passing under a box is covered by the box, and a label
   * is always the last thing drawn in its own rectangle. Layout never consults the
   * text it is placing, so a long label is truncated to its box rather than allowed
   * to decide the geometry.
   */
  diagram(graph: ArchitectureGraph): void {
    const bands = groupByType(graph.nodes);
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(graph.nodes.length))));
    const gapX = 12;
    const gapY = 14;
    const boxWidth = (CONTENT_WIDTH - gapX * (columns - 1)) / columns;
    const boxHeight = 34;

    // Pass 0: geometry. Every box's rectangle is known before a byte is drawn.
    const placed = new Map<string, { x: number; y: number; width: number; height: number }>();
    let cursor = 0;
    const rows: { label: string; height: number }[] = [];
    for (const band of bands) {
      const bandRows = Math.ceil(band.nodes.length / columns);
      rows.push({ label: band.type, height: 12 + bandRows * (boxHeight + gapY) });
      for (const [index, node] of band.nodes.entries()) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        placed.set(node.id, {
          x: MARGIN_X + column * (boxWidth + gapX),
          y: cursor + 12 + row * (boxHeight + gapY),
          width: boxWidth,
          height: boxHeight,
        });
      }
      cursor += 12 + bandRows * (boxHeight + gapY);
    }
    const figureHeight = cursor;

    // A figure taller than a page cannot be broken without cutting a box in half,
    // so it gets its own page and the listing below carries the overflow.
    if (figureHeight > CONTENT_BOTTOM - CONTENT_TOP) {
      this.paragraph("The diagram does not fit one page; the listing below is complete.", {
        size: 8.5,
        color: WARN,
      });
      return;
    }
    this.ensure(figureHeight + 8);
    const top = this.y;

    // Pass 1: wires, first so every box paints over them.
    for (const edge of graph.edges) {
      const from = placed.get(edge.from);
      const to = placed.get(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      this.pdf.line(
        from.x + from.width / 2,
        top + from.y + from.height / 2,
        to.x + to.width / 2,
        top + to.y + to.height / 2,
        WIRE,
      );
    }

    // Pass 2: band labels and box fills.
    let bandTop = 0;
    for (const band of rows) {
      this.pdf.text(MARGIN_X, top + bandTop, spaced(band.label.replace(/-/g, " ").toUpperCase()), {
        size: 6.5,
        font: "bold",
        color: MUTED,
      });
      bandTop += band.height;
    }
    for (const box of placed.values()) {
      this.pdf.rect(box.x, top + box.y, box.width, box.height, BOX_FILL);
      this.pdf.rule(box.x, top + box.y, box.width, 0.6, BOX_EDGE);
    }

    // Pass 3: labels, last, clipped to their own box by construction — two lines of
    // wrapped text plus one of evidence ids, each measured against the box width.
    for (const band of bands) {
      for (const node of band.nodes) {
        const box = placed.get(node.id);
        if (box === undefined) continue;
        const inner = box.width - 10;
        const label = PdfWriter.wrap(clean(node.label), "bold", 7.5, inner).slice(0, 2);
        let textY = top + box.y + 6;
        for (const part of label) {
          this.pdf.text(box.x + 5, textY, part, { size: 7.5, font: "bold", color: INK });
          textY += 9.5;
        }
        const ids = PdfWriter.wrap(node.evidenceIds.join(" "), "mono", 6, inner)[0] ?? "";
        this.pdf.text(box.x + 5, top + box.y + box.height - 9, ids, { size: 6, font: "mono", color: ACCENT });
      }
    }

    this.y = top + figureHeight + 4;
    this.paragraph(
      `${count(graph.nodes.length, "node")} drawn, grouped by type; ${count(graph.edges.length, "relationship")} drawn as connecting lines. Each box shows the citations that established it.`,
      { size: 7.5, color: MUTED },
    );
    this.spacer(6);
  }

  empty(value: string): void {
    this.paragraph(value, { size: 9, color: MUTED });
  }

  /**
   * Draws a tinted panel behind whatever `body` emits.
   *
   * The rectangle has to be drawn first — PDF content streams paint in order, so a
   * background added afterwards would cover the text. The height is therefore needed
   * before the content exists, and is obtained by running `body` twice: once against a
   * throwaway `Doc` whose pages are discarded, then against this one. Cheap, and it
   * keeps callers from hand-computing heights that drift the moment a line of text
   * changes. This is why `body` receives its `Doc` as an argument instead of closing
   * over one — a closure over the outer document would draw the measuring pass for real.
   */
  panel(body: (doc: Doc) => void): void {
    const scratch = new Doc(new PdfWriter(SCRATCH_METADATA), this.runningHead);
    scratch.newPage();
    const start = scratch.y;
    body(scratch);
    const height = Math.min(scratch.y - start + 16, CONTENT_BOTTOM - CONTENT_TOP);

    this.ensure(height);
    this.pdf.rect(MARGIN_X - 10, this.y - 8, CONTENT_WIDTH + 20, height, PAPER_TINT);
    body(this);
    this.spacer(8);
  }
}

const SCRATCH_METADATA = {
  title: "scratch",
  author: "scratch",
  subject: "scratch",
  creator: "scratch",
  createdAt: new Date(0),
};

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/**
 * Redacts, then flattens whitespace.
 *
 * Redaction runs first: a secret split across a newline would survive a
 * pattern that assumed one line.
 */
function clean(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").trim();
}

/** A single line of untrusted text: cleaned and bounded. */
function line(value: string): string {
  return truncate(clean(value), MAX_LINE_CHARS);
}

/** Multi-paragraph prose: blank lines survive, everything else collapses. */
function prose(value: string): string {
  const redacted = redactSecrets(value)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
  return truncate(redacted, MAX_PROSE_CHARS);
}

function excerpt(value: string): string {
  return truncate(clean(value), MAX_EXCERPT_CHARS);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Letter-spaced small caps, faked by inserting thin gaps. */
function spaced(value: string): string {
  return [...value].join(" ");
}

function capped<T>(items: readonly T[], max = MAX_LIST_ROWS): T[] {
  return items.length <= max ? [...items] : items.slice(0, max);
}

/**
 * Splits nodes into contiguous bands of one type.
 *
 * `buildArchitectureGraph` already sorts by the declared type order, so this is a
 * single pass over the sorted list rather than a grouping — which matters: it means
 * the diagram's band order is the graph's own order, not a second opinion about
 * which node type belongs on top.
 */
function groupByType(nodes: readonly ArchitectureNode[]): { type: string; nodes: ArchitectureNode[] }[] {
  const bands: { type: string; nodes: ArchitectureNode[] }[] = [];
  for (const node of nodes) {
    const last = bands.at(-1);
    if (last !== undefined && last.type === node.type) last.nodes.push(node);
    else bands.push({ type: node.type, nodes: [node] });
  }
  return bands;
}

function count(value: number, singular: string, plural?: string): string {
  return `${value} ${value === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Filename-safe, so a repository name can never steer a download path. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
