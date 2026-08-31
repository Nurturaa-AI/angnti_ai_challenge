import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextSourceText } from "../src/context-format";
import {
  extractSearchTerms,
  parseSearchHits,
  rankCandidates,
  runEvidenceScout,
  stem,
  tokenize,
  type SearchHit,
} from "../src/scout";
import {
  DEFAULT_EXPLORATION_BUDGET,
  EvidenceLedger,
  type ExplorationBudget,
  type ToolContext,
} from "../src/tools";

/**
 * The Evidence Scout.
 *
 * The scout exists because of a measured failure: iteration 1 gave the agent a
 * search tool and it made seven tool calls, none of them a search, on a question
 * whose answer one search would have found. So these tests are mostly about
 * *behaviour under a budget* rather than about the shape of a return value — did a
 * search actually happen, did the right file win the ranking, did the read land in
 * the ledger, and would the same repository be scouted identically twice.
 *
 * The last block is that specific regression: the pyflow dispatch question,
 * reproduced in miniature.
 */

let root: string;

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function contextWith(overrides: Partial<ExplorationBudget> = {}): ToolContext {
  return { repositoryRoot: root, budget: { ...DEFAULT_EXPLORATION_BUDGET, ...overrides } };
}

function source(id: string, type: ContextSourceText["type"], text: string): ContextSourceText {
  return { id, type, text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
}

/** A hit as `search_code` would have produced it, for the ranking tests. */
function hit(pathName: string, line: number, text: string, term: string): SearchHit {
  return { path: pathName, line, text, term };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-scout-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Query extraction
// ---------------------------------------------------------------------------

describe("query extraction", () => {
  const DISPATCH_QUESTION = "How is a step's declared type mapped to the function that runs it?";

  it("removes stop words and keeps the technical terms", () => {
    const terms = extractSearchTerms({ focus: DISPATCH_QUESTION, max: 20 });
    const words = terms.map((term) => term.term);

    for (const stopWord of ["how", "is", "a", "to", "that", "it", "runs", "the"]) {
      expect(words).not.toContain(stopWord);
    }
    for (const technical of ["step", "type", "map", "function"]) {
      expect(words).toContain(technical);
    }
  });

  it("weights a known technical concept above an ordinary word from the same question", () => {
    const terms = extractSearchTerms({ focus: DISPATCH_QUESTION, max: 20 });
    const weightOf = new Map(terms.map((term) => [term.term, term.weight]));

    // "step" is in the technical vocabulary; "declared" is just a word in the
    // question. Both are kept — one is worth searching for first.
    expect(weightOf.get("declar") ?? 0).toBeGreaterThan(0);
    expect(weightOf.get("step") ?? 0).toBeGreaterThan(weightOf.get("declar") ?? 0);
  });

  it("produces multi-word terms for concepts that only co-occur on one line", () => {
    const terms = extractSearchTerms({ focus: "how is a step type dispatched", max: 20 });
    const compounds = terms.filter((term) => term.term.includes(" ")).map((term) => term.term);

    // search_code ANDs the words of a query within a line, so a compound is the only
    // way to ask "where do these two concepts meet" rather than "where is either".
    expect(compounds.length).toBeGreaterThan(0);
    expect(compounds).toContain("step type");
  });

  it("expands a concept into the names code actually uses for it", () => {
    const terms = extractSearchTerms({ focus: DISPATCH_QUESTION, max: 25 });
    const words = terms.map((term) => term.term);

    // The whole point of the phase: the question never says "registry", and the
    // answer is a dict called REGISTRY.
    expect(words).toContain("registry");
    const registry = terms.find((term) => term.term === "registry");
    expect(registry?.origin).toBe("synonym");
    expect(registry?.from).toBe("map");
  });

  it("is deterministic: same input, same terms in the same order", () => {
    const input = { focus: "where are customer orders persisted and how is the event published", max: 14 };
    const first = extractSearchTerms(input);
    const second = extractSearchTerms(input);
    expect(second).toEqual(first);
  });

  it("orders terms by weight, breaking ties alphabetically", () => {
    const terms = extractSearchTerms({
      focus: "how does the router dispatch a request to a handler and persist the order",
      max: 30,
    });
    for (let index = 1; index < terms.length; index += 1) {
      const previous = terms[index - 1];
      const current = terms[index];
      if (!previous || !current) continue;
      expect(previous.weight).toBeGreaterThanOrEqual(current.weight);
      if (previous.weight === current.weight) {
        expect(previous.term < current.term).toBe(true);
      }
    }
  });

  it("falls back to a fixed seed list when a question yields nothing", () => {
    // An empty question is not an error and must not silently disable the phase:
    // a generic sweep for config, errors, handlers, routes and tests is still worth
    // more than no search at all.
    for (const focus of ["", "   ", "how does it do that"]) {
      const terms = extractSearchTerms({ focus, max: 10 });
      expect(terms.length).toBeGreaterThan(0);
      expect(terms.every((term) => term.origin === "seed")).toBe(true);
    }
  });

  it("drops tokens too short to discriminate", () => {
    const terms = extractSearchTerms({ focus: "is db ok for a step", max: 10 });
    const words = terms.map((term) => term.term);

    expect(words).toContain("step");
    // Two characters would match half the repository on a substring search.
    expect(words).not.toContain("db");
    expect(words).not.toContain("ok");
  });

  it("never exceeds the maximum it was given", () => {
    const focus = "how does the router dispatch a request to the handler that persists a customer order event";
    expect(extractSearchTerms({ focus, max: 4 })).toHaveLength(4);
    // A zero budget is the one case that really does return nothing.
    expect(extractSearchTerms({ focus, max: 0 })).toEqual([]);
  });

  it("mines the repository's own documentation when there is no question at all", () => {
    // This is the configuration evaluation runs in: no question is ever supplied,
    // because the harness does not show a system the questions it is scored on.
    const terms = extractSearchTerms({
      sources: [
        source("tree", "tree", "src/\n  middleware/\n    auth.js\n"),
        source("README.md", "readme", "Each step is dispatched by type to `pyflow/steps/`."),
      ],
      max: 20,
    });
    const words = terms.map((term) => term.term);

    expect(words).toContain("dispatch");
    expect(words).toContain("registry");
    expect(words).toContain("middleware");
  });

  it("excludes the repository's own name, which matches most of its own files", () => {
    const terms = extractSearchTerms({
      sources: [source("README.md", "readme", "`pyflow run pipeline.yaml` starts the `pyflow/cli.py` entry point.")],
      repositoryName: "pyflow",
      max: 20,
    });

    for (const term of terms) {
      expect(term.term.split(" ")).not.toContain("pyflow");
    }
    // The rest of the same line still yields terms, so this is an exclusion and not
    // a short circuit.
    expect(terms.map((term) => term.term)).toContain("pipeline");
  });

  it("splits camelCase before folding case, so both halves stay searchable", () => {
    expect(tokenize("PipelineError")).toEqual(["pipeline", "error"]);
    expect(tokenize("handleStepType")).toEqual(["handle", "step", "type"]);
    // One hump rule only: a second rule for capital runs would break SQLite.
    expect(tokenize("SQLite")).toEqual(["sqlite"]);
  });

  it("normalises suffixes without mangling words that end in s", () => {
    expect(stem("dispatched")).toBe("dispatch");
    expect(stem("mapped")).toBe("map");
    expect(stem("handlers")).toBe("handler");
    expect(stem("dependencies")).toBe("dependency");
    // Vocabulary membership short-circuits the normaliser, which is what keeps
    // these from becoming "clas" and "statu".
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("scout search", () => {
  beforeEach(() => {
    write("README.md", "A pipeline runner. Each step is dispatched by type. State is persisted to a database.\n");
    write("src/registry.js", "const REGISTRY = { extract, load };\nmodule.exports = { REGISTRY };\n");
    write("src/pipeline.js", "const { REGISTRY } = require('./registry');\nconst handler = REGISTRY[step.type];\n");
    write("src/store.js", "function persist(row) { return db.insert(row); }\n");
  });

  it("actually searches, and reads only what a search found", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", "Each step is dispatched by type.")],
      repositoryName: "mini",
    });

    // The failure this phase exists to fix was zero searches out of seven calls.
    expect(result.searches.length).toBeGreaterThan(0);
    expect(result.summary.searches).toBe(result.searches.length);
    expect(result.summary.searchesWithMatches).toBeGreaterThan(0);
    expect(result.reads.length).toBeGreaterThan(0);
  });

  it("searches for several distinct terms, not just the first", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", "Steps are dispatched by type. Rows are persisted to a database.")],
      repositoryName: "mini",
    });
    const searched = result.searches.map((search) => search.term);
    expect(new Set(searched).size).toBeGreaterThanOrEqual(3);
  });

  it("reports a term that matched nothing rather than stopping the scan", () => {
    const result = runEvidenceScout(contextWith(), {
      focus: "where is the kubernetes operator reconcile loop and how are steps dispatched",
      sources: [],
      repositoryName: "mini",
    });

    // A dead term is a fact about the repository. The scan continues past it.
    expect(result.searches.some((search) => search.totalMatches === 0)).toBe(true);
    expect(result.searches.some((search) => search.totalMatches > 0)).toBe(true);
    expect(result.summary.searchesWithMatches).toBeLessThan(result.summary.searches);
  });

  it("collapses many hits in one file into a single candidate", () => {
    write("src/busy.js", Array.from({ length: 12 }, () => "const handler = REGISTRY[step.type];").join("\n"));
    const result = runEvidenceScout(contextWith(), {
      focus: "how is a step type dispatched to a handler",
      sources: [],
      repositoryName: "mini",
    });

    const paths = result.candidates.map((candidate) => candidate.path);
    expect(new Set(paths).size).toBe(paths.length);
    const busy = result.candidates.find((candidate) => candidate.path === "src/busy.js");
    expect(busy?.matchCount).toBeGreaterThan(1);
  });

  it("honours the search budget", () => {
    const result = runEvidenceScout(contextWith({ maxScoutTerms: 20, maxScoutSearches: 2 }), {
      focus: "how is a step type dispatched to the handler that persists a customer order",
      sources: [],
      repositoryName: "mini",
    });
    expect(result.searches).toHaveLength(2);
  });

  it("performs no search and reads nothing when the budget is zero", () => {
    const result = runEvidenceScout(contextWith({ maxScoutSearches: 0, maxScoutFiles: 0 }), {
      focus: "how is a step type dispatched",
      sources: [],
      repositoryName: "mini",
    });
    expect(result.searches).toEqual([]);
    expect(result.reads).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.evidence).toBe("");
  });

  it("stays inside the repository", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "repo-arch-scout-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "PRIVATE registry dispatch handler step\n", "utf8");
    try {
      const result = runEvidenceScout(contextWith(), {
        focus: "where is the registry that dispatches to a handler",
        sources: [],
        repositoryName: "mini",
      });

      for (const read of result.reads) {
        expect(path.isAbsolute(read.path)).toBe(false);
        expect(read.path).not.toContain("..");
        expect(path.resolve(root, read.path).startsWith(root)).toBe(true);
      }
      expect(result.evidence).not.toContain("PRIVATE");
      for (const artifact of result.artifacts) expect(artifact.text).not.toContain("PRIVATE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("goes through the tool layer, so a hit is only what search_code would have shown", () => {
    // The scout parses `search_code`'s rendered rows rather than reaching into the
    // search internals. This pins that contract: if the row or header format changed,
    // the scout would quietly see nothing, and it must be this test that says so.
    expect(parseSearchHits("src/pipeline.js:2: const handler = REGISTRY[step.type];", "registry")).toEqual([
      { path: "src/pipeline.js", line: 2, text: "const handler = REGISTRY[step.type];", term: "registry" },
    ]);
    expect(
      parseSearchHits('6 match(es) for "registry" in 2 file(s) under the repository. Showing 6:', "registry"),
    ).toEqual([]);
    expect(parseSearchHits('No match for "nope" in the repository.', "nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("candidate ranking", () => {
  const terms = [
    { term: "registry", origin: "synonym" as const, weight: 90, from: "dispatch" },
    { term: "dispatch", origin: "vocabulary" as const, weight: 40, from: "README.md" },
    { term: "step", origin: "vocabulary" as const, weight: 40, from: "README.md" },
  ];

  it("ranks a file matched by a heavier term above one matched by a lighter term", () => {
    const ranked = rankCandidates(
      [hit("a.js", 1, "REGISTRY = {}", "registry"), hit("b.js", 1, "step order", "step")],
      terms,
      { max: 10 },
    );
    expect(ranked[0]?.path).toBe("a.js");
  });

  it("ranks a file where several terms converge above one with a single term", () => {
    const ranked = rankCandidates(
      [
        hit("many.js", 4, "REGISTRY[step.type]", "registry"),
        hit("many.js", 4, "REGISTRY[step.type]", "step"),
        hit("many.js", 9, "dispatch(step)", "dispatch"),
        hit("one.js", 1, "REGISTRY = {}", "registry"),
        hit("other.js", 1, "REGISTRY = {}", "registry"),
        hit("third.js", 1, "REGISTRY = {}", "registry"),
      ],
      terms,
      { max: 10 },
    );
    expect(ranked[0]?.path).toBe("many.js");
    // Matched terms are reported heaviest first, which is also the order a reader
    // needs them in to see why the file won.
    expect(ranked[0]?.matchedTerms).toEqual(["registry", "dispatch", "step"]);
  });

  it("rewards a term that matched few files over one that matched many", () => {
    const spread = [
      hit("rare.js", 1, "dispatch(step)", "dispatch"),
      hit("common.js", 1, "step one", "step"),
      hit("common2.js", 1, "step two", "step"),
      hit("common3.js", 1, "step three", "step"),
      hit("common4.js", 1, "step four", "step"),
    ];
    const ranked = rankCandidates(spread, terms, { max: 10 });
    // Both files match one equally-weighted term; `dispatch` reached one file and
    // `step` reached four, so `dispatch` is the one that points somewhere.
    expect(ranked[0]?.path).toBe("rare.js");
    expect(ranked[0]?.reasons.join(" ")).toContain("dispatch");
  });

  it("rewards a matched term appearing in the path", () => {
    const ranked = rankCandidates(
      [hit("src/registry.js", 1, "const x = 1", "registry"), hit("src/other.js", 1, "const x = 1", "registry")],
      terms,
      { max: 10 },
    );
    expect(ranked[0]?.path).toBe("src/registry.js");
  });

  it("rewards two different terms appearing close together", () => {
    const near = rankCandidates(
      [hit("near.js", 10, "REGISTRY[step.type]", "registry"), hit("near.js", 12, "step", "step")],
      terms,
      { max: 10 },
    );
    const far = rankCandidates(
      [hit("far.js", 1, "REGISTRY = {}", "registry"), hit("far.js", 400, "step", "step")],
      terms,
      { max: 10 },
    );
    expect(near[0]?.score).toBeGreaterThan(far[0]?.score ?? 0);
  });

  it("prefers implementation source to prose, all else equal", () => {
    const ranked = rankCandidates(
      [hit("notes.md", 1, "the registry", "registry"), hit("impl.js", 1, "the registry", "registry")],
      terms,
      { max: 10 },
    );
    expect(ranked[0]?.path).toBe("impl.js");
  });

  it("excludes files reconnaissance already put in the prompt", () => {
    const ranked = rankCandidates(
      [hit("README.md", 1, "the registry dispatches", "registry"), hit("impl.js", 9, "REGISTRY = {}", "registry")],
      terms,
      { exclude: ["README.md"], max: 10 },
    );
    expect(ranked.map((candidate) => candidate.path)).toEqual(["impl.js"]);
  });

  it("still lets a documentation file the agent has not seen become a candidate", () => {
    // Documentation is not penalised as a class — only the specific files already in
    // the prompt are removed. A design note the agent has never seen is worth reading.
    const ranked = rankCandidates(
      [hit("docs/design.md", 3, "the registry maps a step type to a handler", "registry")],
      terms,
      { exclude: ["README.md"], max: 10 },
    );
    expect(ranked.map((candidate) => candidate.path)).toEqual(["docs/design.md"]);
  });

  it("caps the convergence bonus so a long file cannot win on breadth alone", () => {
    const wideTerms = Array.from({ length: 9 }, (_, index) => ({
      term: `t${index}`,
      origin: "vocabulary" as const,
      weight: 40,
      from: "README.md",
    }));
    const wide = wideTerms.map((term, index) => hit("tests/everything.test.js", index + 1, "mentions it", term.term));
    const ranked = rankCandidates(
      [
        ...wide,
        hit("src/registry.js", 4, "REGISTRY[step.type]", "registry"),
        hit("src/registry.js", 5, "dispatch(step)", "dispatch"),
      ],
      [...terms, ...wideTerms],
      { max: 10 },
    );
    expect(ranked[0]?.path).toBe("src/registry.js");
  });

  it("is deterministic, and breaks score ties by path", () => {
    const hits = [
      hit("z.js", 1, "REGISTRY = {}", "registry"),
      hit("a.js", 1, "REGISTRY = {}", "registry"),
      hit("m.js", 1, "REGISTRY = {}", "registry"),
    ];
    const first = rankCandidates(hits, terms, { max: 10 });
    const second = rankCandidates([...hits].reverse(), terms, { max: 10 });
    expect(second).toEqual(first);
    expect(first.map((candidate) => candidate.path)).toEqual(["a.js", "m.js", "z.js"]);
  });

  it("honours the candidate ceiling", () => {
    const hits = Array.from({ length: 20 }, (_, index) => hit(`f${index}.js`, 1, "REGISTRY", "registry"));
    expect(rankCandidates(hits, terms, { max: 3 })).toHaveLength(3);
    expect(rankCandidates(hits, terms, { max: 0 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("scout reading", () => {
  const README = "Steps are dispatched by type. Rows are persisted to a database.";

  beforeEach(() => {
    write("README.md", `${README}\n`);
    write("src/registry.js", "const REGISTRY = { extract, load };\n");
    write("src/pipeline.js", "const handler = REGISTRY[step.type];\n");
    write("src/store.js", "function persist(row) { return db.insert(row); }\n");
    write("src/validate.js", "function validate(order) { return order.id != null; }\n");
    write("src/events.js", "function publish(topic, payload) { return broker.emit(topic, payload); }\n");
  });

  it("reads at most the file budget, however many candidates ranked", () => {
    const result = runEvidenceScout(contextWith({ maxScoutFiles: 2 }), {
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    });

    expect(result.reads.length).toBeLessThanOrEqual(2);
    expect(result.summary.filesRead).toBe(result.reads.length);
    // The point of a budget: more was found than was read, and the count of what was
    // left on the table is reported rather than hidden.
    expect(result.candidates.length).toBeGreaterThan(result.reads.length);
    expect(result.summary.candidatesSkipped).toBe(result.candidates.length - result.reads.length);
  });

  it("reads the highest-ranked candidates, in rank order", () => {
    const result = runEvidenceScout(contextWith({ maxScoutFiles: 3 }), {
      focus: "which registry maps a step type to a handler",
      sources: [],
      repositoryName: "mini",
    });

    expect(result.reads).toHaveLength(3);
    const expected = result.candidates.slice(0, result.reads.length).map((candidate) => candidate.path);
    expect(result.reads.map((read) => read.path)).toEqual(expected);
    expect(result.reads.map((read) => read.rank)).toEqual([1, 2, 3]);
  });

  it("keeps the existing read limits, and records truncation honestly", () => {
    write("src/long.js", Array.from({ length: 400 }, (_, index) => `// registry line ${index} dispatch step`).join("\n"));
    const result = runEvidenceScout(contextWith({ maxScoutFiles: 4, maxFileLines: 20 }), {
      focus: "which registry dispatches a step",
      sources: [],
      repositoryName: "mini",
    });

    const long = result.reads.find((read) => read.path === "src/long.js");
    expect(long).toBeDefined();
    expect(long?.truncated).toBe(true);
    expect((long?.endLine ?? 0) - (long?.startLine ?? 0) + 1).toBeLessThanOrEqual(20);
  });

  it("does not re-read a file already in the reconnaissance context", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    });
    expect(result.reads.map((read) => read.path)).not.toContain("README.md");
  });

  it("puts what it read into the evidence ledger, and nothing else", () => {
    const result = runEvidenceScout(contextWith({ maxScoutFiles: 2 }), {
      focus: "which registry maps a step type to a handler",
      sources: [],
      repositoryName: "mini",
    });

    const ledger = new EvidenceLedger([]);
    ledger.recordAll(result.artifacts);
    const entries = ledger.toArray();

    expect(result.artifacts).toHaveLength(result.reads.length);
    expect(entries.map((entry) => entry.id)).toEqual(result.reads.map((read) => read.path));
    for (const entry of entries) {
      expect(entry.type).toBe("file");
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });

  it("renders scout findings as their own section, leaving reconnaissance blocks alone", () => {
    const result = runEvidenceScout(contextWith({ maxScoutFiles: 2 }), {
      focus: "which registry maps a step type to a handler",
      sources: [],
      repositoryName: "mini",
    });

    expect(result.evidence).toContain("## Evidence found by repository search");
    expect(result.evidence).toContain("### END SCOUT EVIDENCE");
    for (const read of result.reads) expect(result.evidence).toContain(`### SCOUT EVIDENCE: ${read.path}`);
    // Not "### SOURCE:" — reconnaissance blocks are parsed elsewhere and carry no
    // line-number gutter. Rendering both under one heading would make grounding
    // compare a gutter-bearing quote against a raw slice and drop truthful citations.
    expect(result.evidence).not.toContain("### SOURCE:");
  });

  it("is deterministic end to end: same repository, same reads in the same order", () => {
    const input = {
      focus: "which registry maps a step type to a handler",
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    };
    const first = runEvidenceScout(contextWith(), input);
    const second = runEvidenceScout(contextWith(), input);

    expect(second.terms).toEqual(first.terms);
    expect(second.searches).toEqual(first.searches);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.reads).toEqual(first.reads);
    expect(second.evidence).toBe(first.evidence);
  });
});

// ---------------------------------------------------------------------------
// The iteration 1 failure, in miniature
// ---------------------------------------------------------------------------

describe("regression: the dispatch question iteration 1 got wrong", () => {
  /**
   * `pyflow/q6-step-dispatch`: "How is a step's declared type mapped to the function
   * that runs it?", expected keyword `registry`.
   *
   * In iteration 1 the agent made seven tool calls, all `read_file`, and never
   * searched for `registry` — the word that names the answer and appears nowhere in
   * the question. This reproduces the shape of that repository and asserts the path
   * the scout is supposed to take: search finds the file, ranking selects it, a read
   * puts it in the ledger, and the evidence a synthesis turn sees contains the
   * dispatch line itself.
   */
  const README = "A tiny pipeline runner. Each step is dispatched by type to `steps/`.";

  beforeEach(() => {
    write("README.md", `${README}\n`);
    write("steps/__init__.py", 'REGISTRY = {"extract": extract, "transform": transform, "load": load}\n');
    write(
      "cli.py",
      "from steps import REGISTRY\n\ndef run(step):\n    handler = REGISTRY.get(step.type)\n    return handler(step)\n",
    );
    write("unrelated.py", "def helper():\n    return 1\n");
  });

  it("searches for `registry` without being told the word", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    });

    // "dispatched" is in the README; "registry" is the name the code uses. Nothing
    // in the input says so — the synonym table does.
    expect(result.searches.map((search) => search.term)).toContain("registry");
    const registry = result.searches.find((search) => search.term === "registry");
    expect(registry?.filesWithMatches).toBeGreaterThan(0);
  });

  it("finds and reads the file holding the dispatch, and the file holding the table", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    });

    const readPaths = result.reads.map((read) => read.path);
    expect(readPaths).toContain("cli.py");
    expect(readPaths).toContain("steps/__init__.py");
    expect(readPaths).not.toContain("unrelated.py");

    // The literal answer, in the evidence, before the model has had a turn.
    expect(result.evidence).toContain("REGISTRY.get(step.type)");
    expect(result.evidence).toContain('REGISTRY = {"extract"');
  });

  it("works from the question too, when a question is available", () => {
    // Reachable through `--focus`, never during evaluation.
    const result = runEvidenceScout(contextWith(), {
      focus: "How is a step's declared type mapped to the function that runs it?",
      sources: [],
      repositoryName: "mini",
    });

    expect(result.searches.map((search) => search.term)).toContain("registry");
    expect(result.reads.map((read) => read.path)).toContain("cli.py");
    expect(result.evidence).toContain("REGISTRY.get(step.type)");
  });

  it("hands the ledger evidence whose text a citation can be verified against", () => {
    const result = runEvidenceScout(contextWith(), {
      sources: [source("README.md", "readme", README)],
      repositoryName: "mini",
    });

    const ledger = new EvidenceLedger([source("README.md", "readme", README)]);
    ledger.recordAll(result.artifacts);
    const cli = ledger.toArray().find((entry) => entry.id === "cli.py");

    expect(cli).toBeDefined();
    // The raw slice, with no line-number gutter: exactly what grounding compares an
    // excerpt against, and the reason the scout section is rendered separately.
    expect(cli?.text).toContain("handler = REGISTRY.get(step.type)");
    expect(cli?.text).not.toContain(" | ");
  });
});
