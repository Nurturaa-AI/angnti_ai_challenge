import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ContextSourceText } from "../src/context-format";
import { countClaims, countUnsupportedClaims, groundAnalysis } from "../src/grounding";
import { AnalysisBodySchema, type AnalysisBody } from "../src/schemas";

/**
 * Grounding is the mechanism behind the product's central claim, so these tests
 * are the ones to distrust first. Each asserts one thing: an unverifiable citation
 * is removed from the briefing and recorded, rather than shown to a reader.
 */

const sources: ContextSourceText[] = [
  {
    id: "tree",
    type: "tree",
    text: "src/\n  server.js\nREADME.md\npackage.json\n",
    bytes: 40,
    truncated: false,
  },
  {
    id: "README.md",
    type: "readme",
    text: "# demo\n\nEvery route except /health requires a bearer JWT.\n",
    bytes: 56,
    truncated: false,
  },
  {
    id: "long.md",
    type: "readme",
    text: "start of the retained portion",
    bytes: 29,
    truncated: true,
  },
];

function body(overrides: Partial<z.input<typeof AnalysisBodySchema>> = {}): AnalysisBody {
  return AnalysisBodySchema.parse({
    summary: "A demo service.",
    architecture: "One process.",
    testing: { approach: "Vitest." },
    confidence: 0.3,
    ...overrides,
  });
}

describe("groundAnalysis", () => {
  it("keeps a citation whose source was in context and marks it grounded", () => {
    const { body: grounded, audit } = groundAnalysis(
      body({ evidence: [{ type: "readme", source: "README.md" }] }),
      sources,
    );

    expect(audit).toMatchObject({ claimed: 1, grounded: 1, dropped: [] });
    expect(grounded.evidence[0]?.grounded).toBe(true);
  });

  it("drops a citation naming a file the system never received", () => {
    const { body: grounded, audit } = groundAnalysis(
      body({
        components: [
          {
            name: "server",
            responsibility: "Boots the app.",
            evidence: [{ type: "file", source: "src/server.js", excerpt: "app.listen(port)" }],
          },
        ],
      }),
      sources,
    );

    expect(grounded.components[0]?.evidence).toEqual([]);
    expect(audit.grounded).toBe(0);
    expect(audit.dropped[0]?.reason).toContain("source-not-in-context");
    expect(audit.dropped[0]?.reason).toContain("src/server.js");
  });

  it("drops a citation whose excerpt does not appear in the cited source", () => {
    const { audit } = groundAnalysis(
      body({ evidence: [{ type: "readme", source: "README.md", excerpt: "rate limiting is enforced" }] }),
      sources,
    );

    expect(audit.grounded).toBe(0);
    expect(audit.dropped[0]?.reason).toContain("excerpt-not-found");
  });

  it("accepts an excerpt that differs only in whitespace and case", () => {
    const { audit } = groundAnalysis(
      body({
        evidence: [{ type: "readme", source: "README.md", excerpt: "every   route  EXCEPT /health\n requires" }],
      }),
      sources,
    );
    expect(audit.grounded).toBe(1);
  });

  it("says so when the excerpt may have been cut off by truncation", () => {
    const { audit } = groundAnalysis(
      body({ evidence: [{ type: "readme", source: "long.md", excerpt: "text far past the cut" }] }),
      sources,
    );
    expect(audit.dropped[0]?.reason).toContain("truncated");
  });

  it("does not attempt to verify an excerpt too short to be distinctive", () => {
    const { audit } = groundAnalysis(body({ evidence: [{ type: "tree", source: "tree", excerpt: "src" }] }), sources);
    expect(audit.grounded).toBe(1);
  });

  it("resolves a source id written with a ./ prefix or different case", () => {
    const { audit } = groundAnalysis(
      body({
        evidence: [
          { type: "readme", source: "./README.md" },
          { type: "readme", source: "readme.md" },
        ],
      }),
      sources,
    );
    expect(audit.grounded).toBe(2);
  });

  it("counts a claim left with no surviving evidence as unsupported", () => {
    const { audit } = groundAnalysis(
      body({
        components: [
          { name: "a", responsibility: "Invented.", evidence: [{ type: "file", source: "src/ghost.js" }] },
          { name: "b", responsibility: "Cited.", evidence: [{ type: "tree", source: "tree" }] },
        ],
      }),
      sources,
    );

    // Component "a" loses its only citation; testing was never cited at all.
    expect(audit.unsupportedClaims).toBe(2);
  });

  it("leaves the claim itself in place, so the reader sees an unsupported claim rather than nothing", () => {
    const { body: grounded } = groundAnalysis(
      body({
        risks: [
          {
            title: "Untested database layer",
            description: "Guessed.",
            severity: "high",
            evidence: [{ type: "file", source: "src/lib/db.js" }],
          },
        ],
      }),
      sources,
    );

    expect(grounded.risks).toHaveLength(1);
    expect(grounded.risks[0]?.evidence).toEqual([]);
  });

  it("checks every evidence array, not just the top-level pool", () => {
    const { audit } = groundAnalysis(
      body({
        components: [{ name: "a", responsibility: "x", evidence: [{ type: "file", source: "ghost-1" }] }],
        flows: [{ name: "f", description: "y", evidence: [{ type: "file", source: "ghost-2" }] }],
        dependencies: [{ name: "d", scope: "runtime", evidence: [{ type: "manifest", source: "ghost-3" }] }],
        risks: [{ title: "r", description: "z", severity: "low", evidence: [{ type: "file", source: "ghost-4" }] }],
        testing: { approach: "Vitest.", evidence: [{ type: "test", source: "ghost-5" }] },
        evidence: [{ type: "tree", source: "ghost-6" }],
      }),
      sources,
    );

    expect(audit.claimed).toBe(6);
    expect(audit.grounded).toBe(0);
    expect(audit.dropped).toHaveLength(6);
  });
});

describe("countUnsupportedClaims / countClaims", () => {
  it("treats testing as exactly one claim and ignores the top-level pool", () => {
    const analysis = body({ evidence: [] });
    expect(countUnsupportedClaims(analysis)).toBe(1);
    expect(countClaims(analysis)).toBe(1);
  });

  it("counts one claim per component, flow, dependency and risk", () => {
    const analysis = body({
      components: [{ name: "a", responsibility: "x", evidence: [{ type: "tree", source: "tree" }] }],
      flows: [{ name: "f", description: "y", evidence: [] }],
      dependencies: [{ name: "d", scope: "runtime", evidence: [] }],
      risks: [{ title: "r", description: "z", severity: "low", evidence: [] }],
      testing: { approach: "Vitest.", evidence: [{ type: "tree", source: "tree" }] },
    });

    expect(countClaims(analysis)).toBe(5);
    expect(countUnsupportedClaims(analysis)).toBe(3);
  });
});
