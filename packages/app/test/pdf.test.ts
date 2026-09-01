import { describe, expect, it } from "vitest";
import { buildArchitectureGraph } from "../src/architecture";
import { PdfReportExporter } from "../src/export/pdf-exporter";
import type { AnsweredQuestion } from "../src/questions";
import { UNSUPPORTED_ANSWER } from "../src/questions";
import { evidence, report } from "./report-fixture";

/**
 * The PDF export.
 *
 * The document is the one artefact that leaves the tool, so it is checked the way a
 * reader would check it: by reading the words on the page. `extractText` below pulls the
 * text-showing operators back out of the file, which works because the writer emits
 * uncompressed content streams — a deliberate choice, and this is what it buys.
 */

const exporter = new PdfReportExporter({ now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 6)) });

function exportPdf(overrides: Parameters<typeof report>[0] = {}, questions: AnsweredQuestion[] = []) {
  const analysis = report(overrides);
  const graph = buildArchitectureGraph(analysis);
  return exporter.export({ report: analysis, graph, questions });
}

/** The document's text, in drawing order. */
function extractText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString("latin1");
  const parts: string[] = [];
  // `(...) Tj`, with `\(`, `\)` and `\\` escaped by the writer.
  const pattern = /\(((?:\\.|[^\\()])*)\) Tj/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    parts.push((match[1] ?? "").replace(/\\([()\\])/g, "$1"));
  }
  return parts.join("\n");
}

function answered(overrides: Partial<AnsweredQuestion> = {}): AnsweredQuestion {
  return {
    id: "q-1",
    question: "Which module writes records?",
    askedAt: "2026-01-02T03:04:05.000Z",
    answer: "The record store writes them.",
    supported: true,
    modelReportedSufficient: true,
    confidence: 0.8,
    citations: [
      {
        id: "q-1-ev-001",
        type: "file",
        source: "src/store.ts",
        sourceId: "file:src/store.ts",
        location: "src/store.ts:4",
        excerpt: "insert into records",
        supports: "The store writes records.",
      },
    ],
    inspectedSources: ["tree", "file:src/store.ts"],
    audit: { claimed: 1, grounded: 1, dropped: [] },
    metrics: {
      durationMs: 120,
      turns: 2,
      toolCalls: 1,
      failedToolCalls: 0,
      scoutFilesRead: 1,
      bytesFromTools: 200,
      budgetExhausted: false,
      inputTokens: 20,
      outputTokens: 10,
    },
    trajectory: [],
    ...overrides,
  };
}

describe("PDF export", () => {
  it("generates a structurally valid PDF", async () => {
    const bytes = await exportPdf();
    const raw = Buffer.from(bytes).toString("latin1");

    expect(bytes.byteLength).toBeGreaterThan(4_000);
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Type /Catalog");
    // Anchored on `/Parent`, because a bare `/Type /Page` also matches `/Type /Pages`.
    expect(raw).toContain("<< /Type /Page /Parent");
    expect(raw).toContain("/BaseFont /Helvetica");
    expect(raw).toContain("/Encoding /WinAnsiEncoding");

    // The xref offsets must land exactly on their objects, or a reader rejects the file.
    const startxref = /startxref\n(\d+)\n%%EOF/.exec(raw);
    expect(startxref).not.toBeNull();
    const xrefStart = Number(startxref?.[1]);
    expect(raw.slice(xrefStart, xrefStart + 4)).toBe("xref");

    const offsets = [...raw.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(4);
    for (const [index, offset] of offsets.entries()) {
      expect(raw.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    }
  });

  it("carries the analysis in its metadata, and encodes a non-ASCII title correctly", async () => {
    const bytes = await exportPdf();
    const raw = Buffer.from(bytes).toString("latin1");

    expect(raw).toContain("/Subject (Evidence-backed repository analysis)");
    expect(raw).toContain("/Author (advanced 0.1.0)");
    expect(raw).toContain("/Creator (Repo Archaeologist)");
    expect(raw).toContain("/CreationDate (D:20260102030406Z)");

    // The title holds an em dash, so `/Info` must carry it as a UTF-16BE hex string —
    // a WinAnsi 0x97 there would show up as `Š` in a viewer's title bar.
    const title = /\/Title <([0-9A-F]+)>/.exec(raw);
    expect(title).not.toBeNull();
    // Big-endian bytes, so they must be swapped before Node will read them as UTF-16;
    // the leading unit is the byte-order mark the string is required to open with.
    const decoded = Buffer.from(title?.[1] ?? "", "hex").swap16().toString("utf16le");
    expect(decoded.charCodeAt(0)).toBe(0xfeff);
    expect(decoded.slice(1)).toBe("Repository analysis — widget");
  });

  it("names the download after the repository and the analysis, safely", () => {
    const analysis = report();
    expect(exporter.filename(analysis)).toBe("repo-analysis-widget-advanced-wid.pdf");

    // A repository name can never steer a download path.
    const hostile = { ...analysis, repository: { ...analysis.repository, name: "../../etc/pa sswd" } };
    expect(exporter.filename(hostile)).toBe("repo-analysis-etc-pa-sswd-advanced-wid.pdf");
    expect(exporter.filename(hostile)).not.toContain("/");
    expect(exporter.filename({ ...analysis, repository: { ...analysis.repository, name: "///" }, id: "***" })).toBe(
      "repo-analysis-repository-analysis.pdf",
    );
  });

  it("prints the analysis, its architecture and its citations", async () => {
    const bytes = await exportPdf({
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
      risks: [
        {
          id: "risks-0",
          section: "risks",
          evidenceIds: ["ev-002"],
          title: "No integration coverage",
          description: "Only unit tests are present.",
          severity: "medium",
        },
      ],
    });
    const text = extractText(bytes);

    // Every dashboard section reaches the page.
    for (const heading of [
      "Overview",
      "Components",
      "Data flows",
      "Dependencies",
      "Testing",
      "Risks",
      "Architecture graph",
      "Where to start reading",
      "Evidence audit",
      "Appendix A - Evidence",
      "Appendix B - Artefacts inspected",
    ]) {
      // The em dash in the appendix headings is WinAnsi 0x97, which latin1 reads as a
      // control character; compare against the ASCII skeleton instead.
      expect(text.replace(/[\x80-\x9f]/g, "-")).toContain(heading);
    }

    // The claims themselves.
    expect(text).toContain("HTTP router");
    expect(text).toContain("record store");
    expect(text).toContain("express");
    expect(text).toContain("No integration coverage");
    expect(text).toContain("Write path");

    // The architecture, node labels and typed relationships included.
    expect(text).toContain("depends-on");
    expect(text).toContain("Relationships");
    expect(text).toMatch(/HTTP router -\[/);

    // The citations: on the claims, and again in the appendix with their excerpts.
    expect(text).toContain("Evidence: ev-001");
    expect(text).toContain("ev-004");
    expect(text).toContain("src/router.ts");
    expect(text).toContain("supports overview, components-0");
  });

  it("prints a verified excerpt in the appendix so a citation is checkable on paper", async () => {
    const bytes = await exportPdf({
      evidence: [
        evidence("ev-001", {
          source: "src/router.ts",
          sourceId: "file:src/router.ts",
          location: "src/router.ts:2",
          excerpt: "return store.write(request.body)",
          supports: "The router forwards to the store.",
          origins: ["reconnaissance", "scout"],
          claimIds: ["overview", "components-0"],
        }),
      ],
    });
    const text = extractText(bytes);

    expect(text).toContain('"return store.write(request.body)"');
    expect(text).toContain("The router forwards to the store.");
    expect(text).toContain("reconnaissance+scout");
    expect(text).toContain("artefact file:src/router.ts");
    // Locations are printed but labelled as unverified model output.
    expect(text).toContain("Locations are reported by the model and are not independently verified");
  });

  it("omits a claim with no grounded citation, and counts the omission", async () => {
    const bytes = await exportPdf({
      components: [
        {
          id: "components-0",
          section: "components",
          evidenceIds: ["ev-001"],
          name: "HTTP router",
          path: "src/router.ts",
          responsibility: "Exposes the request routes.",
        },
        {
          id: "components-1",
          section: "components",
          evidenceIds: [],
          name: "speculative cache",
          path: "src/cache.ts",
          responsibility: "There is probably a cache.",
        },
      ],
      risks: [
        {
          id: "risks-0",
          section: "risks",
          evidenceIds: [],
          title: "unverifiable risk",
          description: "A guess.",
          severity: "high",
        },
      ],
      audit: { claimed: 4, grounded: 3, dropped: [{ source: "src/cache.ts", reason: "source not in context" }], unsupportedClaims: 2 },
    });
    const text = extractText(bytes);

    expect(text).toContain("HTTP router");
    expect(text).not.toContain("speculative cache");
    expect(text).not.toContain("There is probably a cache");
    expect(text).not.toContain("unverifiable risk");
    expect(text).toContain("1 of 2 evidence-backed");
    expect(text).toContain("Claims omitted from this document");

    // A dropped citation is a count, never a reprinted path: printing the name would
    // give an artefact nobody read the appearance of a finding.
    expect(text).toContain("Citations dropped");
    expect(text).not.toContain("src/cache.ts");
    expect(text).toContain("Unsupported claims");
  });

  it("stamps the overview UNVERIFIED rather than deleting it", async () => {
    const bytes = await exportPdf({ overviewEvidenceIds: [] });
    const text = extractText(bytes);

    expect(text.replace(/[\x80-\x9f]/g, "-")).toContain("UNVERIFIED - NO GROUNDED CITATION");
    // The narrative frame survives; the stamp is what warns the reader.
    expect(text).toContain("A small service.");
  });

  it("includes answered questions, and stamps an unverified answer", async () => {
    const bytes = await exportPdf({}, [
      answered(),
      answered({
        id: "q-2",
        question: "Does it use a queue?",
        answer: UNSUPPORTED_ANSWER,
        supported: false,
        modelReportedSufficient: false,
        confidence: 0,
        citations: [],
        audit: { claimed: 1, grounded: 0, dropped: [{ source: "src/queue.ts", reason: "source not in context" }] },
      }),
    ]);
    const text = extractText(bytes);

    expect(text).toContain("Questions");
    expect(text).toContain("1 of 2 answered from verified evidence");
    expect(text).toContain("Which module writes records?");
    expect(text).toContain("The record store writes them.");
    expect(text).toContain("q-1-ev-001");
    expect(text).toContain("insert into records");
    expect(text).toContain("Confidence 80%");

    expect(text).toContain("Does it use a queue?");
    expect(text).toContain("I couldn't verify this from the repository evidence I inspected.");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("Questions answered");
  });

  it("redacts a secret-shaped value on the way into the document", async () => {
    const bytes = await exportPdf({
      summary: "The client authenticates with AKIAIOSFODNN7EXAMPLE and a bearer token.",
      components: [
        {
          id: "components-0",
          section: "components",
          evidenceIds: ["ev-001"],
          name: "auth",
          path: "src/auth.ts",
          responsibility: 'Reads api_key = "sk_live_51H8xYzAbCdEfGhIjKlMnOpQr" from the environment.',
        },
      ],
      evidence: [
        evidence("ev-001", {
          source: "src/auth.ts",
          sourceId: "file:src/auth.ts",
          excerpt: 'const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";',
          claimIds: ["overview", "components-0"],
        }),
      ],
    });
    const text = extractText(bytes);

    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("sk_live_51H8xYzAbCdEfGhIjKlMnOpQr");
    expect(text).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    // The reader is told something was removed rather than shown a silent gap.
    expect(text).toContain("<redacted-credential>");
    // The surrounding prose survives, so the reader still learns what the claim said.
    expect(text).toContain("The client authenticates with");
  });

  it("bounds an oversized excerpt instead of emitting an unbounded document", async () => {
    const bytes = await exportPdf({
      evidence: [
        evidence("ev-001", {
          source: "src/router.ts",
          sourceId: "file:src/router.ts",
          excerpt: "x".repeat(5_000),
          claimIds: ["overview"],
        }),
      ],
    });
    const text = extractText(bytes);

    const longest = text.split("\n").reduce((max, part) => Math.max(max, part.length), 0);
    expect(longest).toBeLessThan(400);
    expect(text).not.toContain("x".repeat(400));
  });

  it("is deterministic for a fixed clock", async () => {
    const [first, second] = await Promise.all([exportPdf(), exportPdf()]);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("declares itself through the exporter interface, so the app never sees the writer", () => {
    expect(exporter.format).toBe("pdf");
    expect(exporter.contentType).toBe("application/pdf");
  });
});
