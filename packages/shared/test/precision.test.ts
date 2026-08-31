import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ContextSourceText } from "../src/context-format";
import { groundAnalysis } from "../src/grounding";
import { DEFAULT_PRECISION_POLICY, MAX_NON_CONTENT_SCORE, MIN_CONTENT_SCORE, applyEvidencePrecision, claimTerms, findCorroborations, isImplementationPath, orderCitations, scoreCitation } from "../src/precision";
import { AnalysisBodySchema, type AnalysisBody, type Evidence } from "../src/schemas";

/**
 * The evidence precision pass.
 *
 * The pass edits citations after the model has produced them, which makes it the
 * component with the most room to do quiet damage: every mistake here looks like a
 * better-supported briefing. So the tests are written around the two properties that
 * bound it, and those are the ones to distrust first —
 *
 *   1. nothing that could support a claim is taken away (the invariant, below), and
 *   2. nothing enters a briefing that grounding would not accept on its own.
 */

const sources: ContextSourceText[] = [
  {
    id: "tree",
    type: "tree",
    text: "src/\n  dispatch.js\n  store.js\nREADME.md\npackage.json\n",
    bytes: 52,
    truncated: false,
  },
  {
    id: "README.md",
    type: "readme",
    text: "# pipeline\n\nSteps run in topological order and run state is written to SQLite.\n",
    bytes: 76,
    truncated: false,
  },
  {
    id: "src/dispatch.js",
    type: "file",
    text: [
      "import { toposort } from './graph.js';",
      "",
      "export function dispatch(steps) {",
      "  const ordered = toposort(steps);",
      "  for (const step of ordered) runStep(step);",
      "}",
    ].join("\n"),
    bytes: 150,
    truncated: false,
  },
  {
    id: "src/store.js",
    type: "file",
    text: [
      "import Database from 'better-sqlite3';",
      "",
      "export function recordRunState(runId, status) {",
      "  db.prepare('INSERT INTO runs VALUES (?, ?)').run(runId, status);",
      "}",
    ].join("\n"),
    bytes: 160,
    truncated: false,
  },
];

function body(overrides: Partial<z.input<typeof AnalysisBodySchema>> = {}): AnalysisBody {
  return AnalysisBodySchema.parse({
    summary: "A pipeline runner.",
    architecture: "One process.",
    testing: { approach: "Vitest." },
    confidence: 0.4,
    ...overrides,
  });
}

/** A body with exactly one component claim, which is what most cases here need. */
function withComponent(responsibility: string, evidence: z.input<typeof AnalysisBodySchema>["components"] extends undefined ? never : Evidence[]): AnalysisBody {
  return body({
    components: [{ name: "dispatcher", path: "src/dispatch.js", responsibility, evidence }],
  });
}

function componentEvidence(analysis: AnalysisBody): Evidence[] {
  return analysis.components[0]?.evidence ?? [];
}

/** Every (source, location) pair a body carries, for the invariant check. */
function evidenceKeys(analysis: AnalysisBody): string[] {
  const claims = [
    ...analysis.components.map((component) => component.evidence),
    ...analysis.flows.map((flow) => flow.evidence),
    ...analysis.dependencies.map((dependency) => dependency.evidence),
    ...analysis.risks.map((risk) => risk.evidence),
    analysis.testing.evidence,
    analysis.evidence,
  ];
  return claims
    .flat()
    .map((item) => `${item.source.toLowerCase()}|${(item.location ?? "").toLowerCase()}`)
    .sort();
}

const HYGIENE_ONLY = { ...DEFAULT_PRECISION_POLICY, maxCorroborations: 0 };

describe("scoreCitation — content beats existence", () => {
  it("ranks a content citation above a tree citation for the same claim", () => {
    const terms = claimTerms("dispatch runs steps in topological order");
    const content = scoreCitation(
      { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
      terms,
    );
    const existence = scoreCitation({ type: "tree", source: "tree", excerpt: "src/dispatch.js" }, terms);

    expect(content.score).toBeGreaterThan(existence.score);
    expect(content.reasons).toContain("content");
    expect(existence.reasons).toContain("existence");
  });

  it("puts the content citation first even when the model listed the tree first", () => {
    const ordered = orderCitations(
      [
        { type: "tree", source: "tree", excerpt: "src/dispatch.js" },
        { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
      ],
      claimTerms("dispatch runs steps in topological order"),
    );

    expect(ordered[0]?.type).toBe("file");
    expect(ordered).toHaveLength(2);
  });

  it("keeps content above existence by more than any other signal can close", () => {
    // The scoring module states this as a design property, so it is asserted from the
    // constants rather than from one example: no combination of location, concision,
    // claim-term overlap and a code-shaped path can lift an existence citation above
    // the weakest content one.
    expect(MIN_CONTENT_SCORE).toBeGreaterThan(MAX_NON_CONTENT_SCORE);

    const terms = claimTerms("dispatch topological steps ordered");
    const dressedUpTree = scoreCitation(
      { type: "tree", source: "src/dispatch.js", location: "line 4", excerpt: "dispatch topological steps ordered" },
      terms,
    );
    const plainContent = scoreCitation({ type: "file", source: "notes", excerpt: "" }, terms);

    expect(dressedUpTree.score).toBeLessThanOrEqual(MAX_NON_CONTENT_SCORE);
    expect(plainContent.score).toBeGreaterThan(dressedUpTree.score);
  });
});

describe("scoreCitation — relevance and specificity", () => {
  it("ranks an excerpt sharing claim terms above one that shares none", () => {
    const terms = claimTerms("run state is written to SQLite");
    const relevant = scoreCitation({ type: "file", source: "src/store.js", excerpt: "recordRunState(runId, status)" }, terms);
    const unrelated = scoreCitation({ type: "file", source: "src/store.js", excerpt: "import Database from 'x';" }, terms);

    expect(relevant.score).toBeGreaterThan(unrelated.score);
    expect(relevant.reasons.some((reason) => reason.startsWith("terms:"))).toBe(true);
  });

  it("ranks a short excerpt above a long one, all else equal", () => {
    const short = scoreCitation({ type: "file", source: "a.js", excerpt: "x".repeat(100) }, []);
    const long = scoreCitation({ type: "file", source: "a.js", excerpt: "x".repeat(900) }, []);
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("prefers an implementation file over generic metadata when support is equivalent", () => {
    const terms = claimTerms("dispatch steps");
    const code = scoreCitation({ type: "file", source: "src/dispatch.js", excerpt: "dispatch steps" }, terms);
    const metadata = scoreCitation({ type: "file", source: "notes.txt", excerpt: "dispatch steps" }, terms);

    expect(code.score).toBeGreaterThan(metadata.score);
    expect(isImplementationPath("src/dispatch.js")).toBe(true);
    expect(isImplementationPath("notes.txt")).toBe(false);
  });

  it("orders deterministically, and falls back to the model's own order on a tie", () => {
    const items: Evidence[] = [
      { type: "file", source: "b.js", excerpt: "same length text" },
      { type: "file", source: "a.js", excerpt: "same length text" },
    ];
    const terms = claimTerms("nothing shared here at all");

    const first = orderCitations(items, terms);
    const second = orderCitations(items, terms);

    expect(first.map((item) => item.source)).toEqual(["b.js", "a.js"]);
    expect(second).toEqual(first);
  });
});

describe("applyEvidencePrecision — removal", () => {
  it("removes a duplicate citation", () => {
    const cited: Evidence = { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" };
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Runs steps in topological order.", [cited, { ...cited }]),
      sources,
      HYGIENE_ONLY,
    );

    expect(componentEvidence(refined)).toHaveLength(1);
    expect(summary.duplicatesRemoved).toBe(1);
  });

  it("removes a redundant citation contained by a wider quote of the same location", () => {
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Runs steps in topological order.", [
        { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "toposort(steps)" },
        { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
      HYGIENE_ONLY,
    );

    expect(componentEvidence(refined)).toHaveLength(1);
    expect(componentEvidence(refined)[0]?.excerpt).toBe("const ordered = toposort(steps);");
    expect(summary.redundantRemoved).toBe(1);
  });

  it("keeps two quotes from the same file at different locations", () => {
    // Different locations are different facts, so this is not redundancy — and
    // treating it as redundancy is how a precision pass loses a citation the
    // evaluator was crediting.
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Runs steps in topological order.", [
        { type: "file", source: "src/dispatch.js", location: "line 1", excerpt: "import { toposort }" },
        { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
      HYGIENE_ONLY,
    );

    expect(componentEvidence(refined)).toHaveLength(2);
    expect(summary.redundantRemoved).toBe(0);
  });

  it("retains several citations when each supports a different part of the claim", () => {
    // "topologically, and records run state in SQLite" is two facts in one sentence.
    // Minimising the citation count would drop one of them.
    const { body: refined } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [
        { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
        { type: "file", source: "src/store.js", excerpt: "db.prepare('INSERT INTO runs VALUES (?, ?)').run(runId, status);" },
      ]),
      sources,
      HYGIENE_ONLY,
    );

    expect(componentEvidence(refined).map((item) => item.source).sort()).toEqual([
      "src/dispatch.js",
      "src/store.js",
    ]);
  });

  it("leaves an empty citation set empty and valid", () => {
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Guessed, with nothing behind it.", []),
      sources,
    );

    expect(componentEvidence(refined)).toEqual([]);
    expect(summary.corroborationsAdded).toBe(0);
    // Still a valid body, so the schema gate after the pass cannot fail on its output.
    expect(() => AnalysisBodySchema.parse(refined)).not.toThrow();
  });
});

describe("applyEvidencePrecision — the invariant", () => {
  it("never loses a (source, location) pair the model produced", () => {
    const before = body({
      components: [
        {
          name: "dispatcher",
          responsibility: "Runs steps topologically.",
          evidence: [
            { type: "tree", source: "tree", excerpt: "src/dispatch.js" },
            { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "toposort(steps)" },
            { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "const ordered = toposort(steps);" },
            { type: "file", source: "src/dispatch.js", location: "line 4", excerpt: "toposort(steps)" },
          ],
        },
      ],
      risks: [
        {
          title: "Run state is not fsynced",
          description: "Records run state in SQLite without a durability guarantee.",
          severity: "medium",
          evidence: [{ type: "file", source: "src/store.js", excerpt: "recordRunState(runId, status)" }],
        },
      ],
      testing: { approach: "Vitest.", evidence: [{ type: "readme", source: "README.md" }] },
      evidence: [{ type: "readme", source: "README.md", excerpt: "Steps run in topological order" }],
    });

    const { body: after } = applyEvidencePrecision(before, sources);

    // Every pair present before is still present. Removal only ever collapses
    // citations that shared a source *and* a location with a retained one.
    for (const key of new Set(evidenceKeys(before))) {
      expect(evidenceKeys(after)).toContain(key);
    }
  });

  it("adds no citation whose source is outside the ledger", () => {
    const { body: refined } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [
        { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
    );

    const ledgerIds = new Set(sources.map((source) => source.id));
    for (const item of componentEvidence(refined)) expect(ledgerIds.has(item.source)).toBe(true);
  });

  it("never invents evidence for a claim the model cited nothing for", () => {
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", []),
      sources,
    );

    expect(componentEvidence(refined)).toEqual([]);
    expect(summary.claimsCorroborated).toBe(0);
  });

  it("never rescues a claim whose only citation grounding would reject", () => {
    // The integrity case. The model cited a file it never read; attaching real
    // corroboration would turn a hallucination into a supported claim.
    const { body: refined } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [
        { type: "file", source: "src/ghost.js", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
    );

    expect(componentEvidence(refined).map((item) => item.source)).toEqual(["src/ghost.js"]);

    const { body: grounded, audit } = groundAnalysis(refined, sources);
    expect(grounded.components[0]?.evidence).toEqual([]);
    expect(audit.unsupportedClaims).toBeGreaterThan(0);
  });
});

describe("applyEvidencePrecision — corroboration", () => {
  it("attaches an uncited ledger artefact that speaks to the claim", () => {
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [
        { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
    );

    const added = componentEvidence(refined).filter((item) => item.source !== "src/dispatch.js");
    expect(added.length).toBeGreaterThan(0);
    expect(summary.corroboratedSources.length).toBeGreaterThan(0);
    // Every excerpt it added is verbatim text from the artefact it names.
    for (const item of added) {
      const source = sources.find((candidate) => candidate.id === item.source);
      expect(source?.text).toContain(item.excerpt);
    }
  });

  it("quotes without claiming a line number it cannot know", () => {
    const { body: refined } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [
        { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
      ]),
      sources,
    );

    for (const item of componentEvidence(refined).filter((candidate) => candidate.source !== "src/dispatch.js")) {
      expect(item.location).toBeUndefined();
    }
  });

  it("never corroborates from an existence-only artefact", () => {
    const treeOnly: ContextSourceText[] = [
      { id: "tree", type: "tree", text: "src/\n  dispatch.js topological steps sqlite run state\n", bytes: 50, truncated: false },
      { id: "README.md", type: "readme", text: "# pipeline\n\nSteps run in topological order.\n", bytes: 44, truncated: false },
    ];

    const corroborations = findCorroborations(
      "Executes steps topologically and records run state in SQLite.",
      [{ type: "readme", source: "README.md", excerpt: "Steps run in topological order." }],
      treeOnly,
      DEFAULT_PRECISION_POLICY,
    );

    expect(corroborations.map((corroboration) => corroboration.sourceId)).not.toContain("tree");
  });

  it("respects the per-claim ceiling", () => {
    const corroborations = findCorroborations(
      "Executes steps topologically and records run state in SQLite.",
      [{ type: "readme", source: "README.md" }],
      sources,
      { ...DEFAULT_PRECISION_POLICY, maxCorroborations: 1 },
    );
    expect(corroborations).toHaveLength(1);
  });

  it("adds nothing at all when corroboration is switched off", () => {
    const cited: Evidence[] = [{ type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" }];
    const { body: refined, summary } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", cited),
      sources,
      HYGIENE_ONLY,
    );

    expect(componentEvidence(refined)).toEqual(cited);
    expect(summary.corroborationsAdded).toBe(0);
  });

  it("requires more than one shared term, so a single coincidence is not evidence", () => {
    const corroborations = findCorroborations(
      "Database migrations run on boot.",
      [{ type: "readme", source: "README.md" }],
      sources,
      { ...DEFAULT_PRECISION_POLICY, minCorroborationTerms: 2 },
    );

    for (const corroboration of corroborations) {
      expect(corroboration.matchedTerms.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("is deterministic: the same body and ledger give the same citations every time", () => {
    const input = withComponent("Executes steps topologically and records run state in SQLite.", [
      { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
    ]);

    const first = applyEvidencePrecision(input, sources);
    const second = applyEvidencePrecision(input, sources);

    expect(second.body).toEqual(first.body);
    expect(second.summary).toEqual(first.summary);
  });
});

describe("applyEvidencePrecision — the grounding contract", () => {
  it("produces a body whose every citation grounding accepts", () => {
    const { body: refined } = applyEvidencePrecision(
      body({
        components: [
          {
            name: "dispatcher",
            responsibility: "Executes steps topologically and records run state in SQLite.",
            evidence: [{ type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" }],
          },
        ],
        testing: { approach: "Vitest.", evidence: [{ type: "readme", source: "README.md" }] },
      }),
      sources,
    );

    const { audit } = groundAnalysis(refined, sources);
    expect(audit.dropped).toEqual([]);
    expect(audit.grounded).toBe(audit.claimed);
  });

  it("leaves grounding's own verdicts unchanged for the citations the model wrote", () => {
    const original = body({
      components: [
        {
          name: "dispatcher",
          responsibility: "Runs steps.",
          evidence: [
            { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" },
            { type: "file", source: "src/ghost.js", excerpt: "never opened this file" },
          ],
        },
      ],
    });

    const direct = groundAnalysis(original, sources);
    const throughPass = groundAnalysis(applyEvidencePrecision(original, sources, HYGIENE_ONLY).body, sources);

    expect(throughPass.audit.claimed).toBe(direct.audit.claimed);
    expect(throughPass.audit.grounded).toBe(direct.audit.grounded);
    expect(throughPass.audit.dropped).toEqual(direct.audit.dropped);
    expect(throughPass.audit.unsupportedClaims).toBe(direct.audit.unsupportedClaims);
  });
});

describe("applyEvidencePrecision — the summary", () => {
  it("accounts for every citation it removed or added", () => {
    const cited: Evidence = { type: "file", source: "src/dispatch.js", excerpt: "const ordered = toposort(steps);" };
    const { summary } = applyEvidencePrecision(
      withComponent("Executes steps topologically and records run state in SQLite.", [cited, { ...cited }]),
      sources,
    );

    expect(summary.citationsAfter).toBe(
      summary.citationsBefore - summary.duplicatesRemoved - summary.redundantRemoved + summary.corroborationsAdded,
    );
    // Six claim slots exist on every body: components, flows, dependencies, testing,
    // risks and the top-level pool. This body has one component and one of each empty.
    expect(summary.claimsInspected).toBeGreaterThanOrEqual(1);
  });
});

describe("the pass generalises", () => {
  it("names no evaluation fixture, case id or specific file anywhere in its logic", () => {
    // Iteration 3's constraint, asserted rather than promised: the pass must work on a
    // repository it has never seen, so nothing about the evaluation set may appear in
    // it. A hardcoded "README.md" here would score well and mean nothing.
    const dir = path.join(__dirname, "..", "src", "precision");
    const combined = ["corroborate.ts", "policy.ts", "precision.ts", "score.ts", "index.ts"]
      .map((file) => readFileSync(path.join(dir, file), "utf8"))
      .join("\n");

    // Strip comments: the prose explains the design and may legitimately mention a
    // filename, while the code may not.
    const code = combined.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const forbidden of ["README", "package.json", "case-00", "pyflow", "expectedEvidence", "expectedKeywords"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
