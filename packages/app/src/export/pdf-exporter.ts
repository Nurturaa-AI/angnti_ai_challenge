import { redactSecrets } from "@repo-arch/shared";
import type { ArchitectureEdge, ArchitectureGraph } from "../architecture";
import type { AnsweredQuestion } from "../questions";
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

  /** Synchronous by nature; `export` wraps it so the seam can host async exporters. */
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
    writeOverview(doc, report);
    writeComponents(doc, report);
    writeFlows(doc, report);
    writeDependencies(doc, report);
    writeTesting(doc, report);
    writeRisks(doc, report);
    writeArchitecture(doc, graph);
    writeReading(doc, report);
    writeQuestions(doc, questions);
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
  questions: readonly AnsweredQuestion[],
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

function writeOverview(doc: Doc, report: AnalysisReport): void {
  doc.heading("Overview");
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

function writeArchitecture(doc: Doc, graph: ArchitectureGraph): void {
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

function writeQuestions(doc: Doc, questions: readonly AnsweredQuestion[]): void {
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
