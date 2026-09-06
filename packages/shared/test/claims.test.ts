import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  COMPOSITE_MARKER,
  MAX_COMPOSITIONS,
  MAX_COMPOSITION_CHARS,
  MAX_COMPOSITION_PARTS,
  buildClaimSet,
  checkClaimIntegrity,
  claimId,
  composeClaimSet,
  composeClaims,
  evidenceId,
  materializeComposedClaims,
  resolveEvidence,
  type ClaimSet,
} from "../src/claims";
import { groundAnalysis } from "../src/grounding";
import type { ContextSourceText } from "../src/context-format";
import { AnalysisBodySchema, type AnalysisBody } from "../src/schemas";

/**
 * Atomic claims, composition, and materialization.
 *
 * The representation's value rests on four properties, and each is a way it could
 * quietly stop being true:
 *
 *   1. **Addressability.** `claim → evidenceId → ledger → Evidence` resolves, and a
 *      broken address is reported rather than ignored.
 *   2. **No invention.** A claim asserts only what the briefing asserts, and cites
 *      only what the briefing cited. Composition unions evidence; it never adds any.
 *   3. **Determinism.** Same briefing, same ids — no clock, no counter, no caller.
 *   4. **Question-blindness.** Nothing about a question, an expected answer or a
 *      benchmark case can reach this layer, because none of it is an input.
 *
 * Property 2 is the one most worth distrusting: a composition that could attach
 * evidence its parts never had would make an unsupported claim look supported, which
 * is exactly the failure this project cannot afford.
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
    id: "package.json",
    type: "manifest",
    text: '{"dependencies":{"toposort":"^2.0.2","better-sqlite3":"^9.0.0"},"devDependencies":{"vitest":"^1.0.0"}}',
    bytes: 101,
    truncated: false,
  },
  {
    id: "src/dispatch.js",
    type: "file",
    text: "import { toposort } from './graph.js';\nexport function dispatch(steps) {\n  const ordered = toposort(steps);\n}\n",
    bytes: 110,
    truncated: false,
  },
  {
    id: "src/store.js",
    type: "file",
    text: "import Database from 'better-sqlite3';\nexport function record(runId) {\n  db.prepare('INSERT INTO runs VALUES (?)').run(runId);\n}\n",
    bytes: 130,
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

/** Two dependencies read out of one manifest: the same-list composition case. */
function twoDependencyBody(): AnalysisBody {
  return body({
    dependencies: [
      {
        name: "toposort",
        scope: "runtime",
        purpose: "Orders steps.",
        evidence: [{ type: "manifest", source: "package.json", location: "L1-L1" }],
      },
      {
        name: "better-sqlite3",
        scope: "runtime",
        purpose: "Stores run state.",
        evidence: [{ type: "manifest", source: "package.json", location: "L1-L1" }],
      },
      {
        name: "vitest",
        scope: "dev",
        purpose: "Runs the tests.",
        evidence: [{ type: "manifest", source: "package.json", location: "L1-L1" }],
      },
    ],
  });
}

describe("buildClaimSet — one atomic claim per assertion", () => {
  it("creates a claim for a single component, addressed to its evidence", () => {
    const set = buildClaimSet(
      body({
        components: [
          {
            name: "dispatcher",
            path: "src/dispatch.js",
            responsibility: "Runs steps in topological order.",
            evidence: [{ type: "file", source: "src/dispatch.js", location: "L2-L4" }],
          },
        ],
      }),
    );

    const claim = set.claims.find((candidate) => candidate.kind === "component");
    expect(claim).toBeDefined();
    expect(claim?.subject).toBe("dispatcher");
    expect(claim?.text).toContain("topological order");
    expect(claim?.evidenceIds).toHaveLength(1);

    const resolved = resolveEvidence(set, claim?.evidenceIds ?? []);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.source).toBe("src/dispatch.js");
  });

  it("carries several pieces of evidence on one claim", () => {
    const set = buildClaimSet(
      body({
        components: [
          {
            name: "store",
            path: "src/store.js",
            responsibility: "Writes run state.",
            evidence: [
              { type: "file", source: "src/store.js", location: "L2-L4" },
              { type: "readme", source: "README.md" },
              { type: "manifest", source: "package.json" },
            ],
          },
        ],
      }),
    );

    const claim = set.claims.find((candidate) => candidate.subject === "store");
    expect(claim?.evidenceIds).toHaveLength(3);
    expect(resolveEvidence(set, claim?.evidenceIds ?? []).map((item) => item.source)).toEqual([
      "src/store.js",
      "README.md",
      "package.json",
    ]);
  });

  it("gives one ledger entry to a citation two claims share", () => {
    const set = buildClaimSet(twoDependencyBody());
    const ids = new Set(set.claims.flatMap((claim) => claim.evidenceIds));

    // Three dependencies citing the identical manifest line is one artefact, so the
    // ledger holds one entry and all three claims address it.
    const manifestIds = [...ids].filter((id) => set.evidence[id]?.source === "package.json");
    expect(manifestIds).toHaveLength(1);
  });

  it("records a claim with no evidence rather than dropping it", () => {
    const set = buildClaimSet(
      body({ components: [{ name: "orphan", responsibility: "Unsupported.", evidence: [] }] }),
    );

    const claim = set.claims.find((candidate) => candidate.subject === "orphan");
    expect(claim).toBeDefined();
    expect(claim?.evidenceIds).toEqual([]);
    expect(checkClaimIntegrity(set).unsupportedClaimIds).toContain(claim?.id);
    // An unsupported claim is a finding, not a broken set.
    expect(checkClaimIntegrity(set).ok).toBe(true);
  });

  it("asserts nothing the briefing does not: every claim's text comes from the body", () => {
    const source = body({
      components: [
        {
          name: "dispatcher",
          path: "src/dispatch.js",
          responsibility: "Runs steps in topological order.",
          evidence: [{ type: "file", source: "src/dispatch.js" }],
        },
      ],
    });
    const set = buildClaimSet(source);
    const haystack = JSON.stringify(source).toLowerCase();

    for (const claim of set.claims) {
      for (const word of claim.text.split(/[\s—]+/).filter((token) => token.length > 4)) {
        expect(haystack).toContain(word.toLowerCase());
      }
    }
  });
});

describe("determinism", () => {
  it("produces identical ids for identical briefings", () => {
    const first = buildClaimSet(twoDependencyBody());
    const second = buildClaimSet(twoDependencyBody());

    expect(first.claims.map((claim) => claim.id)).toEqual(second.claims.map((claim) => claim.id));
    expect(Object.keys(first.evidence).sort()).toEqual(Object.keys(second.evidence).sort());
  });

  it("produces identical compositions across runs", () => {
    const first = composeClaimSet(buildClaimSet(twoDependencyBody()));
    const second = composeClaimSet(buildClaimSet(twoDependencyBody()));

    expect(first.composed.map((claim) => claim.id)).toEqual(second.composed.map((claim) => claim.id));
    expect(first.composed[0]?.text).toBe(second.composed[0]?.text);
  });

  it("derives ids from content alone — no timestamp, counter or case id", () => {
    const evidence = { type: "file", source: "src/dispatch.js", location: "L2-L4" } as const;
    expect(evidenceId(evidence)).toBe(evidenceId({ ...evidence }));
    expect(claimId("component", "same text", ["a", "b"])).toBe(claimId("component", "same text", ["b", "a"]));
    // Different content, different id — otherwise addresses would collide.
    expect(claimId("component", "one text", ["a"])).not.toBe(claimId("component", "another text", ["a"]));
  });
});

describe("composition — joining claims that are about one thing", () => {
  it("composes dependencies drawn from one manifest into a single claim", () => {
    const set = composeClaimSet(buildClaimSet(twoDependencyBody()));
    const composed = set.composed.find((claim) => claim.kind === "dependency");

    expect(composed).toBeDefined();
    expect(composed?.claimIds.length).toBeGreaterThanOrEqual(2);
    // The composition is one claim naming several packages — the shape no per-entry
    // claim can have, because a dependency entry describes one package.
    expect(composed?.text).toContain("toposort");
    expect(composed?.text).toContain("better-sqlite3");
  });

  it("composes a fact resting on two files, carrying a citation to each", () => {
    const set = composeClaimSet(
      buildClaimSet(
        body({
          components: [
            {
              name: "dispatcher",
              path: "src/dispatch.js",
              responsibility: "Runs steps in order and hands each to the store.",
              evidence: [{ type: "file", source: "src/dispatch.js", location: "L2-L4" }],
            },
          ],
          flows: [
            {
              name: "run",
              description: "The dispatcher orders the steps, then the store records the result.",
              steps: [],
              evidence: [{ type: "file", source: "src/store.js", location: "L2-L4" }],
            },
          ],
        }),
      ),
    );

    const composed = set.composed[0];
    expect(composed).toBeDefined();
    const cited = resolveEvidence(set, composed?.evidenceIds ?? []).map((item) => item.source);
    expect(new Set(cited)).toEqual(new Set(["src/dispatch.js", "src/store.js"]));
  });

  it("unions its parts' evidence and adds none of its own", () => {
    const set = buildClaimSet(twoDependencyBody());
    const parts = set.claims.filter((claim) => claim.kind === "dependency").slice(0, 2);
    const composed = composeClaims(set, {
      kind: "dependency",
      text: "two packages",
      claimIds: parts.map((part) => part.id),
    });

    const expected = new Set(parts.flatMap((part) => part.evidenceIds));
    expect(new Set(composed.evidenceIds)).toEqual(expected);
  });

  it("refuses to compose fewer than two claims", () => {
    const set = buildClaimSet(twoDependencyBody());
    const one = set.claims[0];
    expect(() => composeClaims(set, { kind: "dependency", text: "x", claimIds: [one?.id ?? ""] })).toThrow(
      /at least two/,
    );
  });

  it("refuses to compose a claim the set does not contain", () => {
    const set = buildClaimSet(twoDependencyBody());
    const one = set.claims[0];
    expect(() =>
      composeClaims(set, { kind: "dependency", text: "x", claimIds: [one?.id ?? "", "clm-nonexistent"] }),
    ).toThrow(/unknown claim/);
  });

  it("caps how many compositions a briefing may carry", () => {
    const many = body({
      components: Array.from({ length: 40 }, (_, index) => ({
        name: `component-${index}`,
        path: `src/file-${index}.js`,
        responsibility: `Does thing ${index} and talks to component-${index + 1}.`,
        evidence: [{ type: "file" as const, source: `src/file-${index}.js` }],
      })),
    });
    const set = composeClaimSet(buildClaimSet(many));
    expect(set.composed.length).toBeLessThanOrEqual(MAX_COMPOSITIONS);
    for (const composed of set.composed) {
      expect(composed.text.length).toBeLessThanOrEqual(MAX_COMPOSITION_CHARS);
    }
  });

  it("caps how many claims a cross-kind composition may join", () => {
    const set = composeClaimSet(
      buildClaimSet(
        body({
          components: Array.from({ length: 12 }, (_, index) => ({
            name: `service-${index}`,
            path: `src/service-${index}.js`,
            responsibility: "Part of the shared pipeline mechanism.",
            evidence: [{ type: "file" as const, source: `src/service-${index}.js` }],
          })),
          flows: [
            {
              name: "pipeline",
              description: Array.from({ length: 12 }, (_, index) => `service-${index}`).join(" then "),
              steps: [],
              evidence: [{ type: "file", source: "src/dispatch.js" }],
            },
          ],
        }),
      ),
    );

    for (const composed of set.composed) {
      if (composed.subject === `${composed.kind} set`) continue;
      expect(composed.claimIds.length).toBeLessThanOrEqual(MAX_COMPOSITION_PARTS);
    }
  });

  it("does not compose claims that all rest on one artefact", () => {
    // Two claims of different kinds citing only the readme have nothing to join: the
    // point of composing across kinds is to carry citations to more than one place.
    const set = composeClaimSet(
      buildClaimSet(
        body({
          components: [
            {
              name: "dispatcher",
              responsibility: "Mentioned in the runner flow.",
              evidence: [{ type: "readme", source: "README.md" }],
            },
          ],
          flows: [
            {
              name: "runner",
              description: "Calls the dispatcher.",
              steps: [],
              evidence: [{ type: "readme", source: "README.md" }],
            },
          ],
        }),
      ),
    );

    expect(set.composed.filter((claim) => claim.subject !== `${claim.kind} set`)).toEqual([]);
  });
});

describe("integrity", () => {
  it("rejects a claim citing an evidence id the ledger does not hold", () => {
    const set = buildClaimSet(twoDependencyBody());
    const broken: ClaimSet = {
      ...set,
      claims: set.claims.map((claim, index) =>
        index === 0 ? { ...claim, evidenceIds: ["ev-does-not-exist"] } : claim,
      ),
    };

    const report = checkClaimIntegrity(broken);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain("unknown-evidence");
  });

  it("rejects duplicate claim ids", () => {
    const set = buildClaimSet(twoDependencyBody());
    const first = set.claims[0];
    expect(first).toBeDefined();
    const report = checkClaimIntegrity({ ...set, claims: [...set.claims, first!] });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain("duplicate-claim-id");
  });

  it("detects a composition naming a claim that does not exist", () => {
    const set = composeClaimSet(buildClaimSet(twoDependencyBody()));
    const composed = set.composed[0];
    expect(composed).toBeDefined();
    const report = checkClaimIntegrity({
      ...set,
      composed: [{ ...composed!, claimIds: ["clm-orphan", ...composed!.claimIds] }],
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain("orphaned-composition");
  });

  it("detects a composition citing evidence none of its parts cite", () => {
    const set = composeClaimSet(buildClaimSet(twoDependencyBody()));
    const composed = set.composed[0];
    const strayId = evidenceId({ type: "file", source: "src/store.js" });
    const report = checkClaimIntegrity({
      ...set,
      evidence: { ...set.evidence, [strayId]: { type: "file", source: "src/store.js" } },
      composed: [{ ...composed!, evidenceIds: [...composed!.evidenceIds, strayId] }],
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain("composition-evidence-escape");
  });

  it("passes a set built and composed by the real pass", () => {
    const report = checkClaimIntegrity(composeClaimSet(buildClaimSet(twoDependencyBody())));
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });
});

describe("materialization — composed claims reach the briefing", () => {
  it("appends a composed dependency entry without displacing what the model wrote", () => {
    const original = twoDependencyBody();
    const set = composeClaimSet(buildClaimSet(original));
    const { body: after, materializedIds } = materializeComposedClaims(original, set);

    expect(materializedIds.length).toBeGreaterThan(0);
    expect(after.dependencies.length).toBe(original.dependencies.length + 1);
    // Every original entry survives, unedited.
    for (const dependency of original.dependencies) {
      expect(after.dependencies).toContainEqual(dependency);
    }
  });

  it("marks a composed entry so a reader can tell it apart", () => {
    const original = twoDependencyBody();
    const { body: after } = materializeComposedClaims(original, composeClaimSet(buildClaimSet(original)));
    const composite = after.dependencies.find((dependency) => dependency.name.startsWith(COMPOSITE_MARKER));

    expect(composite).toBeDefined();
    // `unknown` scope is the honest value: the composition spans entries whose scopes
    // differ, so asserting one of them would assert something false.
    expect(composite?.scope).toBe("unknown");
  });

  it("carries no citation the parts did not already carry", () => {
    const original = twoDependencyBody();
    const { body: after } = materializeComposedClaims(original, composeClaimSet(buildClaimSet(original)));

    const before = new Set(
      [
        ...original.components.flatMap((component) => component.evidence),
        ...original.flows.flatMap((flow) => flow.evidence),
        ...original.dependencies.flatMap((dependency) => dependency.evidence),
        ...original.risks.flatMap((risk) => risk.evidence),
        ...original.testing.evidence,
        ...original.evidence,
      ].map((item) => `${item.source}|${item.location ?? ""}`),
    );

    for (const dependency of after.dependencies) {
      for (const item of dependency.evidence) {
        expect(before.has(`${item.source}|${item.location ?? ""}`)).toBe(true);
      }
    }
  });

  it("drops a composition whose evidence does not resolve rather than emitting it bare", () => {
    const original = twoDependencyBody();
    const set = composeClaimSet(buildClaimSet(original));
    const stripped: ClaimSet = {
      ...set,
      composed: set.composed.map((claim) => ({ ...claim, evidenceIds: [] })),
    };

    const { body: after, materializedIds } = materializeComposedClaims(original, stripped);
    expect(materializedIds).toEqual([]);
    expect(after.dependencies).toEqual(original.dependencies);
  });

  it("leaves a composed citation to be verified by grounding like any other", () => {
    const original = twoDependencyBody();
    const { body: materialized } = materializeComposedClaims(
      original,
      composeClaimSet(buildClaimSet(original)),
    );
    const { body: grounded } = groundAnalysis(materialized, sources);
    const composite = grounded.dependencies.find((dependency) => dependency.name.startsWith(COMPOSITE_MARKER));

    // Grounding, not composition, is what marks a citation grounded.
    for (const item of composite?.evidence ?? []) {
      expect(item.grounded).toBe(true);
    }
  });

  it("drops a composed citation grounding rejects, exactly as it would elsewhere", () => {
    const invented = body({
      dependencies: [
        {
          name: "toposort",
          scope: "runtime",
          purpose: "Orders steps.",
          evidence: [{ type: "manifest", source: "not-a-real-file.json" }],
        },
        {
          name: "better-sqlite3",
          scope: "runtime",
          purpose: "Stores state.",
          evidence: [{ type: "manifest", source: "not-a-real-file.json" }],
        },
      ],
    });
    const { body: materialized } = materializeComposedClaims(invented, composeClaimSet(buildClaimSet(invented)));
    const { body: grounded, audit } = groundAnalysis(materialized, sources);
    const composite = grounded.dependencies.find((dependency) => dependency.name.startsWith(COMPOSITE_MARKER));

    expect(composite?.evidence).toEqual([]);
    expect(audit.dropped.length).toBeGreaterThan(0);
    // A composition over unsupported claims stays visibly unsupported rather than
    // being rescued by the composition.
    expect(audit.unsupportedClaims).toBeGreaterThan(0);
  });

  it("leaves testing and overview compositions out of the briefing", () => {
    // Neither is a list an entry can be appended to, so a composition of those kinds
    // is reported in the claim set rather than rewriting the model's prose.
    const original = twoDependencyBody();
    const set = composeClaimSet(buildClaimSet(original));
    const asOverview: ClaimSet = {
      ...set,
      composed: set.composed.map((claim) => ({ ...claim, kind: "overview" as const })),
    };

    const { body: after, materializedIds } = materializeComposedClaims(original, asOverview);
    expect(materializedIds).toEqual([]);
    expect(after.summary).toBe(original.summary);
    expect(after.architecture).toBe(original.architecture);
  });
});

describe("anti-overfitting — the claim layer names no benchmark answer", () => {
  it("takes no question, expected answer or case identifier as input", () => {
    // The signature is the guarantee: there is no parameter through which a question
    // could arrive. This test fails to compile, not merely to pass, if that changes.
    const set = buildClaimSet(twoDependencyBody());
    expect(composeClaimSet(set)).toBeDefined();
    expect(buildClaimSet.length).toBe(1);
    expect(composeClaimSet.length).toBe(1);
  });

  it("composes a repository whose contents the benchmark never mentions", () => {
    // Same structural shape as the fixtures — several entries from one manifest — with
    // none of their names. If composition worked only on the fixtures, it would be
    // fixture-shaped logic rather than a mechanism.
    const unrelated = body({
      dependencies: [
        {
          name: "libfoo",
          scope: "runtime",
          purpose: "Does the foo.",
          evidence: [{ type: "manifest", source: "package.json" }],
        },
        {
          name: "libbar",
          scope: "dev",
          purpose: "Does the bar.",
          evidence: [{ type: "manifest", source: "package.json" }],
        },
      ],
    });
    const set = composeClaimSet(buildClaimSet(unrelated));
    const composed = set.composed.find((claim) => claim.kind === "dependency");

    expect(composed?.text).toContain("libfoo");
    expect(composed?.text).toContain("libbar");
  });
});
