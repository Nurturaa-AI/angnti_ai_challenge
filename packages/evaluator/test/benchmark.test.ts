import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EvaluationError } from "@repo-arch/shared";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_CATEGORIES,
  BENCHMARK_DIFFICULTIES,
  categoryCounts,
  difficultyCounts,
  loadBenchmark,
  loadManifest,
  questionKey,
  unresolvedEvidenceReferences,
} from "../src/benchmark";
import { loadCases } from "../src/load";

/**
 * Benchmark integrity.
 *
 * The benchmark is the measurement instrument, so this file's job is to make it
 * expensive to change one by accident and impossible to change one quietly. It
 * is deliberately assertive rather than descriptive: the frozen expectations
 * below are duplicated *here*, away from the JSON, so that editing a case file
 * fails a test instead of moving a number.
 *
 * Four groups, matching the four ways the dataset and its description can drift:
 * the frozen set changing, the challenge set being malformed, the manifest
 * disagreeing with the files, and the category coverage claim being untested
 * documentation.
 */

// ---------------------------------------------------------------------------
// Regression Set v1 — the frozen control
// ---------------------------------------------------------------------------

/**
 * Canonical hashes of the two frozen case files.
 *
 * Canonical, not raw: the JSON is parsed and re-serialised with sorted keys
 * before hashing, so reindenting a file is not a failure but changing a single
 * keyword, question, expected answer or evidence path is. That is exactly the
 * "byte-equivalent in semantic content" standard the specification sets.
 *
 * If one of these fails, the correct response is to restore the case file. It is
 * never to update the hash.
 */
const FROZEN_FILE_HASHES: Readonly<Record<string, string>> = {
  "evaluation/cases/case-001-orders-api.json":
    "91ba0721ae48306e6c631deac169c8b58d833b4ac18cc4d82164be9ab8457330",
  "evaluation/cases/case-002-pyflow.json":
    "ee7332720305ce4f45a993ab26d80719599a0010599f52a95a29e0a598b3eb3b",
};

/**
 * Every scoring input of all fourteen frozen questions, restated independently
 * of the files. The hashes above catch any change; this catches it *readably*,
 * and it is the list a reviewer can check against the specification by eye.
 */
interface FrozenExpectation {
  field: string;
  expectedKeywords: readonly string[];
  anyOfKeywords: readonly (readonly string[])[];
  mustNotContain: readonly string[];
  expectedEvidence: readonly string[];
}

const FROZEN_QUESTIONS: Readonly<Record<string, FrozenExpectation>> = {
  "case-001-orders-api/q1-purpose": {
    field: "summary",
    expectedKeywords: ["order"],
    anyOfKeywords: [["write"], ["accept"], ["publish"]],
    mustNotContain: ["graphql", "reporting service in this repository"],
    expectedEvidence: ["README.md"],
  },
  "case-001-orders-api/q2-http-framework": {
    field: "dependencies",
    expectedKeywords: ["express"],
    anyOfKeywords: [],
    mustNotContain: ["fastify", "koa", "nestjs"],
    expectedEvidence: ["package.json"],
  },
  "case-001-orders-api/q3-event-publication": {
    field: "any",
    expectedKeywords: ["order.created"],
    anyOfKeywords: [["kafka"]],
    mustNotContain: ["rabbitmq", "sns", "webhook"],
    expectedEvidence: ["README.md", "package.json"],
  },
  "case-001-orders-api/q4-auth-boundary": {
    field: "any",
    expectedKeywords: ["health"],
    anyOfKeywords: [["jwt"], ["bearer"]],
    mustNotContain: ["oauth", "session cookie", "api key header"],
    expectedEvidence: ["README.md"],
  },
  "case-001-orders-api/q5-oversell-guard": {
    field: "any",
    expectedKeywords: ["for update"],
    anyOfKeywords: [],
    mustNotContain: ["optimistic locking", "redis lock"],
    expectedEvidence: ["src/services/inventory.js", "docs/incidents/2025-08-oversell.md"],
  },
  "case-001-orders-api/q6-testing-gap": {
    field: "testing",
    expectedKeywords: [],
    anyOfKeywords: [["integration"], ["postgres"], ["kafka"]],
    mustNotContain: ["full end-to-end coverage", "100% coverage"],
    expectedEvidence: ["README.md"],
  },
  "case-001-orders-api/q7-api-surface": {
    field: "any",
    expectedKeywords: [],
    anyOfKeywords: [["http"], ["rest"], ["express"]],
    mustNotContain: ["graphql", "grpc", "soap", "websocket"],
    expectedEvidence: ["README.md", "package.json"],
  },
  "case-002-pyflow/q1-purpose": {
    field: "summary",
    expectedKeywords: ["pipeline"],
    anyOfKeywords: [["command line"], ["cli"], ["etl"]],
    mustNotContain: ["web service", "http server", "django"],
    expectedEvidence: ["README.md"],
  },
  "case-002-pyflow/q2-cli-library": {
    field: "dependencies",
    expectedKeywords: ["click"],
    anyOfKeywords: [],
    mustNotContain: ["argparse", "typer", "fire"],
    expectedEvidence: ["pyproject.toml"],
  },
  "case-002-pyflow/q3-execution-order": {
    field: "any",
    expectedKeywords: ["topological"],
    anyOfKeywords: [["cycle"]],
    mustNotContain: ["alphabetical order", "parallel"],
    expectedEvidence: ["README.md"],
  },
  "case-002-pyflow/q4-state-store": {
    field: "any",
    expectedKeywords: ["sqlite"],
    anyOfKeywords: [["state.db"], ["store.py"], ["sqlalchemy"]],
    mustNotContain: ["postgres", "redis", "s3"],
    expectedEvidence: ["README.md", "pyproject.toml"],
  },
  "case-002-pyflow/q5-untested-steps": {
    field: "testing",
    expectedKeywords: ["extract"],
    anyOfKeywords: [["load"], ["not covered"], ["uncovered"]],
    mustNotContain: ["fully covered", "100% coverage"],
    expectedEvidence: ["README.md"],
  },
  "case-002-pyflow/q6-step-dispatch": {
    field: "any",
    expectedKeywords: ["registry"],
    anyOfKeywords: [],
    mustNotContain: ["entry point plugin", "importlib.metadata"],
    expectedEvidence: ["pyflow/steps/__init__.py", "pyflow/cli.py"],
  },
  "case-002-pyflow/q7-no-external-scheduler": {
    field: "any",
    expectedKeywords: [],
    anyOfKeywords: [["no scheduler"], ["single process"], ["one at a time"], ["sequential"]],
    mustNotContain: ["celery", "airflow", "kubernetes", "cron daemon"],
    expectedEvidence: ["README.md"],
  },
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
  }
  return value;
}

function canonicalHash(file: string): string {
  return createHash("sha256").update(JSON.stringify(canonical(JSON.parse(readFileSync(file, "utf8"))))).digest("hex");
}

const benchmark = loadBenchmark();

describe("Regression Set v1 is frozen", () => {
  it("holds exactly the two original cases and fourteen questions", () => {
    const frozen = benchmark.sets.filter((set) => set.frozen);
    expect(frozen.map((set) => set.id)).toEqual(["regression-v1"]);
    expect(frozen[0]?.caseIds).toEqual(["case-001-orders-api", "case-002-pyflow"]);
    expect(benchmark.counts.regression).toBe(14);
  });

  it.each(Object.keys(FROZEN_FILE_HASHES))("%s is semantically unchanged", (file) => {
    // A failure here means a frozen case file was edited. Restore the file.
    // Do not update the hash.
    expect(canonicalHash(file)).toBe(FROZEN_FILE_HASHES[file]);
  });

  it("preserves every question id", () => {
    const keys = benchmark.questions
      .filter((question) => benchmark.sets.some((set) => set.frozen && set.id === question.setId))
      .map((question) => question.key);
    expect(keys.sort()).toEqual(Object.keys(FROZEN_QUESTIONS).sort());
  });

  it("preserves every scoring input of every frozen question", () => {
    const loaded = loadCases("evaluation/cases", {
      filterIds: ["case-001-orders-api", "case-002-pyflow"],
    });
    let checked = 0;
    for (const { case: evalCase } of loaded) {
      for (const question of evalCase.questions) {
        const key = questionKey(evalCase.id, question.id);
        const expectation = FROZEN_QUESTIONS[key];
        expect(expectation, `${key} is not in the frozen expectation table`).toBeDefined();
        expect({
          field: question.field,
          expectedKeywords: question.expectedKeywords,
          anyOfKeywords: question.anyOfKeywords,
          mustNotContain: question.mustNotContain,
          expectedEvidence: question.expectedEvidence,
        }).toEqual(expectation);
        // A question that can never be satisfied would silently depress the metric.
        expect(question.expectedKeywords.length + question.anyOfKeywords.length).toBeGreaterThan(0);
        expect(question.expectedAnswer.length).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBe(14);
  });

  it("carries no inline metadata, so the frozen files never had to change", () => {
    for (const file of Object.keys(FROZEN_FILE_HASHES)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        set?: unknown;
        questions: Record<string, unknown>[];
      };
      expect(raw.set).toBeUndefined();
      for (const question of raw.questions) {
        for (const key of ["category", "difficulty", "tags", "evidenceRationale"]) {
          expect(question[key], `${file} question ${String(question["id"])} gained ${key}`).toBeUndefined();
        }
      }
    }
  });

  it("is classified by the manifest instead, one annotation per question and no more", () => {
    const manifest = loadManifest();
    const frozenKeys = benchmark.questions
      .filter((question) => question.annotated)
      .map((question) => question.key)
      .sort();
    expect(Object.keys(manifest.annotations).sort()).toEqual(frozenKeys);
  });
});

// ---------------------------------------------------------------------------
// Challenge Set v2
// ---------------------------------------------------------------------------

const challengeQuestions = benchmark.questions.filter((question) => question.setId === "challenge-v2");

describe("Challenge Set v2 integrity", () => {
  it("is additive: it adds cases rather than touching the frozen ones", () => {
    const challengeSets = benchmark.sets.filter((set) => !set.frozen);
    expect(challengeSets.map((set) => set.id)).toEqual(["challenge-v2"]);
    const challengeCaseIds = new Set(challengeSets.flatMap((set) => [...set.caseIds]));
    expect(challengeCaseIds.has("case-001-orders-api")).toBe(false);
    expect(challengeCaseIds.has("case-002-pyflow")).toBe(false);
    expect(benchmark.counts.total).toBe(benchmark.counts.regression + benchmark.counts.challenge);
  });

  it("keeps every question key unique across the whole benchmark", () => {
    const keys = benchmark.questions.map((question) => question.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every challenge question a globally unique bare id too", () => {
    // The frozen ids collide across cases ("q1-purpose" is in both). New ids do not
    // repeat that, so a challenge question can be named without its case.
    const ids = challengeQuestions.map((question) => question.questionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a set, a valid category and a valid difficulty on every question", () => {
    expect(challengeQuestions.length).toBeGreaterThan(0);
    for (const question of challengeQuestions) {
      expect(question.setId).toBe("challenge-v2");
      expect(BENCHMARK_CATEGORIES).toContain(question.category);
      expect(BENCHMARK_DIFFICULTIES).toContain(question.difficulty);
      expect(question.tags.length).toBeGreaterThan(0);
      expect(question.evidenceRationale.length).toBeGreaterThan(20);
      expect(question.annotated).toBe(false);
    }
  });

  it("targets only declared fixture repositories", () => {
    const declared = new Set(benchmark.manifest.fixtureRepositories);
    for (const question of benchmark.questions) expect(declared).toContain(question.repository);
    // Both fixtures are actually used, so the multi-language coverage is real.
    const used = new Set(benchmark.questions.map((question) => question.repository));
    expect(used).toEqual(declared);
  });

  it("resolves every expected evidence reference to a file that exists", () => {
    // Fixtures are generated and gitignored; run `pnpm fixtures:build` if this fails
    // with every reference unresolved at once.
    expect(unresolvedEvidenceReferences(benchmark)).toEqual([]);
  });

  it("expects source evidence far more often than documentation", () => {
    // The point of the challenge set. If this inverts, the set has drifted back
    // towards being answerable from a README and stopped discriminating.
    const documentation = /^(README|readme)|\.md$|^package\.json$|^pyproject\.toml$/;
    const sourceBacked = challengeQuestions.filter((question) =>
      question.expectedEvidence.some((reference) => !documentation.test(reference)),
    );
    expect(sourceBacked.length).toBeGreaterThan(challengeQuestions.length / 2);
  });

  it("never asks for evidence it did not think about", () => {
    for (const question of challengeQuestions) {
      expect(question.expectedEvidence.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("benchmark manifest integrity", () => {
  it("names and versions the dataset", () => {
    expect(benchmark.name).toBe("repo-archaeologist");
    expect(benchmark.version).toBe("v2");
  });

  it("declares counts that match the loaded cases", () => {
    const manifest = benchmark.manifest;
    expect(manifest.regressionCount).toBe(benchmark.counts.regression);
    expect(manifest.challengeCount).toBe(benchmark.counts.challenge);
    expect(manifest.totalCount).toBe(benchmark.counts.total);
    expect(manifest.totalCount).toBe(manifest.regressionCount + manifest.challengeCount);
  });

  it("declares a difficulty distribution that matches the loaded cases", () => {
    for (const set of benchmark.sets) {
      expect(benchmark.manifest.difficultyDistribution[set.id]).toEqual(difficultyCounts(benchmark, set.id));
    }
  });

  it("assigns every loaded case to exactly one set", () => {
    const assigned = benchmark.sets.flatMap((set) => [...set.caseIds]).sort();
    expect(assigned).toEqual(benchmark.cases.map((entry) => entry.case.id).sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("loads deterministically", () => {
    const again = loadBenchmark();
    expect(again.questions.map((question) => question.key)).toEqual(
      benchmark.questions.map((question) => question.key),
    );
    expect(again.counts).toEqual(benchmark.counts);
    expect(again.cases.map((entry) => entry.case.id)).toEqual(benchmark.cases.map((entry) => entry.case.id));
  });

  it("rejects a manifest whose counts do not match the dataset", () => {
    // The whole reason the manifest is validated rather than trusted.
    expect(() => loadBenchmark({ manifestFile: "package.json" })).toThrow(EvaluationError);
  });
});

// ---------------------------------------------------------------------------
// Category coverage — tested, not documented
// ---------------------------------------------------------------------------

describe("category coverage", () => {
  const challenge = categoryCounts(benchmark, "challenge-v2");

  it.each(BENCHMARK_CATEGORIES)("Challenge Set v2 covers %s", (category) => {
    expect(challenge[category]).toBeGreaterThan(0);
  });

  it("declares every category it uses", () => {
    const declared = new Set(benchmark.manifest.categories.map((category) => category.id));
    for (const question of benchmark.questions) expect(declared).toContain(question.category);
  });

  it("closes the five coverage gaps the regression set had", () => {
    // Measured, not assumed: these are the categories Regression Set v1 never
    // exercised, which is the reason Challenge Set v2 exists.
    const regression = categoryCounts(benchmark, "regression-v1");
    for (const category of [
      "architecture-inference",
      "behavioral-flow",
      "competing-evidence",
      "evidence-precision",
      "multi-language",
    ] as const) {
      expect(regression[category]).toBe(0);
      expect(challenge[category]).toBeGreaterThan(0);
    }
  });

  it("is not uniformly hard", () => {
    const difficulty = difficultyCounts(benchmark, "challenge-v2");
    for (const level of BENCHMARK_DIFFICULTIES) expect(difficulty[level]).toBeGreaterThan(0);
    expect(difficulty.hard).toBeLessThan(challengeQuestions.length);
  });
});

// ---------------------------------------------------------------------------
// The load-bearing claim: metadata cannot reach the scorer
// ---------------------------------------------------------------------------

describe("scoring isolation", () => {
  it("strips every metadata key before a question reaches the scorer", () => {
    // `EvalCaseSchema` is a z.object, so it drops what it does not declare. This
    // is why challenge cases can carry classification inline without the
    // classification being able to influence a score.
    const loaded = loadCases("evaluation/cases", { filterIds: ["case-003-orders-api-challenge"] });
    const question = loaded[0]?.case.questions[0];
    expect(question).toBeDefined();
    expect(Object.keys(question as object).sort()).toEqual([
      "anyOfKeywords",
      "expectedAnswer",
      "expectedEvidence",
      "expectedKeywords",
      "field",
      "id",
      "mustNotContain",
      "question",
    ]);
  });

  it("carries metadata in the raw file that the scored view never sees", () => {
    const raw = JSON.parse(readFileSync("evaluation/cases/case-003-orders-api-challenge.json", "utf8")) as {
      questions: Record<string, unknown>[];
    };
    expect(raw.questions[0]?.["category"]).toBeDefined();
    expect(raw.questions[0]?.["difficulty"]).toBeDefined();
  });
});
