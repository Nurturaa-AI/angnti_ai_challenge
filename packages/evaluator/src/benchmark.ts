import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EvaluationError } from "@repo-arch/shared";
import { z } from "zod";
import { loadCases, type LoadedCase } from "./load";
import type { AnswerField } from "./case-schema";

/**
 * The benchmark: two views over one dataset.
 *
 * `loadCases` produces the *scored* view — the only thing `scoreCase` ever sees,
 * and byte-for-byte the same code that produced the Iteration 3 numbers. This
 * module produces the *metadata* view: which set a case belongs to, what
 * category and difficulty each question is, why its expected evidence is the
 * right evidence. The two views read the same files and never touch.
 *
 * That separation is not stylistic. `EvalCaseSchema` is a `z.object`, so it
 * strips keys it does not declare; a challenge question can therefore carry
 * `category`, `difficulty`, `tags` and `evidenceRationale` inline in its JSON
 * and those keys provably cannot reach the scorer. Metadata cannot influence a
 * score because the scorer never receives it.
 *
 * The frozen set is the exception, and the asymmetry is deliberate. Regression
 * Set v1 must stay byte-identical, so its questions carry no inline metadata at
 * all; their classification lives in the manifest's `annotations` map instead.
 * Keys there are `caseId/questionId`, because the frozen ids predate the
 * global-uniqueness convention — `q1-purpose` exists in both frozen files, so a
 * bare question id is not a key.
 *
 * Counts are declared once, in the manifest, and re-derived here from the loaded
 * cases. A mismatch is an error rather than a silently-changed denominator.
 */

/** The reasoning demands a challenge question is built to exercise. */
export const BENCHMARK_CATEGORIES = [
  "direct-fact",
  "cross-file-reasoning",
  "indirect-evidence",
  "keyword-mismatch",
  "architecture-inference",
  "behavioral-flow",
  "configuration-dependency",
  "negative-absence",
  "competing-evidence",
  "evidence-precision",
  "multi-language",
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

export const BENCHMARK_DIFFICULTIES = ["easy", "medium", "hard"] as const;

export type BenchmarkDifficulty = (typeof BENCHMARK_DIFFICULTIES)[number];

/** Where the manifest lives, relative to the project root. */
export const DEFAULT_MANIFEST_FILE = "evaluation/benchmark.json";

/** Where the cases live, relative to the project root. Mirrors `evaluation/src/run.ts`. */
export const DEFAULT_CASES_DIRECTORY = "evaluation/cases";

const QuestionMetaSchema = z.object({
  category: z.enum(BENCHMARK_CATEGORIES),
  difficulty: z.enum(BENCHMARK_DIFFICULTIES),
  /** Free-form, but at least one: a question with no tags has not been thought about. */
  tags: z.array(z.string().min(1)).min(1),
  /** Why *that* evidence and not something adjacent. The reader's argument, not the scorer's. */
  evidenceRationale: z.string().min(1),
});

export type QuestionMeta = z.infer<typeof QuestionMetaSchema>;

const BenchmarkSetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /**
   * A frozen set is a control: its cases may not be modified, and its question
   * count is what "regression count" means. Non-frozen sets are the challenge
   * side. Nothing in this module hard-codes a set id.
   */
  frozen: z.boolean(),
  cases: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
});

export const BenchmarkManifestSchema = z.object({
  benchmarkName: z.string().min(1),
  benchmarkVersion: z.string().min(1),
  regressionCount: z.number().int().min(0),
  challengeCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  sets: z.array(BenchmarkSetSchema).min(1),
  categories: z
    .array(z.object({ id: z.enum(BENCHMARK_CATEGORIES), description: z.string().min(1) }))
    .min(1),
  difficulties: z.array(z.enum(BENCHMARK_DIFFICULTIES)).min(1),
  fixtureRepositories: z.array(z.string().min(1)).min(1),
  /** Per set id, the easy/medium/hard split. Cross-checked against the loaded cases. */
  difficultyDistribution: z.record(
    z.string(),
    z.record(z.enum(BENCHMARK_DIFFICULTIES), z.number().int().min(0)),
  ),
  /** Classification for frozen questions, keyed `caseId/questionId`. */
  annotations: z.record(z.string(), QuestionMetaSchema),
});

export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

/** One question, with everything the metadata view knows about it. */
export interface BenchmarkQuestion extends QuestionMeta {
  /** `caseId/questionId`. Unique across the whole benchmark; the frozen ids are not. */
  key: string;
  caseId: string;
  questionId: string;
  setId: string;
  /** Repository path relative to the project root, from the case file. */
  repository: string;
  question: string;
  field: AnswerField;
  expectedEvidence: readonly string[];
  /** True when the classification came from the manifest rather than the case file. */
  annotated: boolean;
}

export interface BenchmarkSet {
  id: string;
  title: string;
  frozen: boolean;
  description: string;
  caseIds: readonly string[];
  questionCount: number;
}

export interface Benchmark {
  name: string;
  /** The dataset identity. Distinct from a system version and from a provenance label. */
  version: string;
  manifest: BenchmarkManifest;
  sets: readonly BenchmarkSet[];
  /** In load order, so two machines evaluate the same cases in the same order. */
  cases: readonly LoadedCase[];
  questions: readonly BenchmarkQuestion[];
  /** Derived from the loaded cases, then checked against the manifest's declarations. */
  counts: { regression: number; challenge: number; total: number };
}

/** The benchmark-wide identity of one question. */
export function questionKey(caseId: string, questionId: string): string {
  return `${caseId}/${questionId}`;
}

const RawCaseFileSchema = z.object({
  id: z.string().min(1),
  /** Present on challenge cases; frozen cases predate it and carry no set marker. */
  set: z.string().min(1).optional(),
  questions: z.array(z.record(z.string(), z.unknown())).min(1),
});

function readRawCase(file: string): z.infer<typeof RawCaseFileSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EvaluationError(
      `Could not read the metadata view of "${file}": ${error instanceof Error ? error.message : String(error)}`,
      "The benchmark reads each case file twice: once for scoring and once for its metadata.",
    );
  }
  const result = RawCaseFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvaluationError(
      `"${file}" is not shaped like a case file: ${result.error.issues.map((i) => i.message).join("; ")}`,
      "Every case file needs an id and a non-empty questions array.",
    );
  }
  return result.data;
}

export function loadManifest(file: string = DEFAULT_MANIFEST_FILE): BenchmarkManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EvaluationError(
      `Could not read the benchmark manifest "${file}": ${error instanceof Error ? error.message : String(error)}`,
      `The manifest declares the benchmark's name, version and counts. Expected at ${DEFAULT_MANIFEST_FILE}.`,
    );
  }
  const result = BenchmarkManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    throw new EvaluationError(
      `The benchmark manifest "${file}" does not match the manifest schema:\n  - ${issues.join("\n  - ")}`,
      "See docs/evaluation.md for the manifest contract.",
    );
  }
  return result.data;
}

export interface LoadBenchmarkOptions {
  casesDirectory?: string | undefined;
  manifestFile?: string | undefined;
}

/**
 * Loads the benchmark and validates the manifest against what is actually on
 * disk. Every check here is a way for the dataset and its description to drift
 * apart, and each one fails the load rather than being reported later: a run
 * that spends money on a benchmark whose denominators are wrong has wasted it.
 */
export function loadBenchmark(options: LoadBenchmarkOptions = {}): Benchmark {
  const casesDirectory = options.casesDirectory ?? DEFAULT_CASES_DIRECTORY;
  const manifest = loadManifest(options.manifestFile ?? DEFAULT_MANIFEST_FILE);
  const cases = loadCases(casesDirectory);

  const problems: string[] = [];

  // --- every case belongs to exactly one declared set, and every declared case exists
  const setOfCase = new Map<string, string>();
  for (const set of manifest.sets) {
    for (const caseId of set.cases) {
      const already = setOfCase.get(caseId);
      if (already !== undefined) {
        problems.push(`case "${caseId}" is claimed by both set "${already}" and set "${set.id}"`);
        continue;
      }
      setOfCase.set(caseId, set.id);
    }
  }
  const loadedIds = new Set(cases.map((entry) => entry.case.id));
  for (const [caseId, setId] of setOfCase) {
    if (!loadedIds.has(caseId)) {
      problems.push(`set "${setId}" names case "${caseId}", which is not in ${casesDirectory}`);
    }
  }
  for (const entry of cases) {
    if (!setOfCase.has(entry.case.id)) {
      problems.push(
        `case "${entry.case.id}" (${entry.file}) belongs to no set; add it to a set in the manifest`,
      );
    }
  }

  // --- fixtures
  const fixtures = new Set(manifest.fixtureRepositories);
  for (const entry of cases) {
    if (!fixtures.has(entry.case.repository)) {
      problems.push(
        `case "${entry.case.id}" targets "${entry.case.repository}", which is not a declared fixture repository`,
      );
    }
  }

  // --- questions: one classification each, from exactly one source
  const frozenSets = new Set(manifest.sets.filter((set) => set.frozen).map((set) => set.id));
  const usedAnnotations = new Set<string>();
  const questions: BenchmarkQuestion[] = [];
  const seenKeys = new Set<string>();

  for (const entry of cases) {
    const setId = setOfCase.get(entry.case.id);
    if (setId === undefined) continue; // already reported above
    const frozen = frozenSets.has(setId);
    const raw = readRawCase(entry.file);

    if (raw.set !== undefined && raw.set !== setId) {
      problems.push(
        `case "${entry.case.id}" declares set "${raw.set}" but the manifest puts it in "${setId}"`,
      );
    }
    if (!frozen && raw.set === undefined) {
      problems.push(`case "${entry.case.id}" is not frozen and must declare its own "set"`);
    }

    const rawById = new Map(raw.questions.map((question) => [String(question["id"] ?? ""), question]));

    for (const question of entry.case.questions) {
      const key = questionKey(entry.case.id, question.id);
      if (seenKeys.has(key)) {
        problems.push(`duplicate question key "${key}"`);
        continue;
      }
      seenKeys.add(key);

      const inlineSource = rawById.get(question.id);
      const inline = inlineSource === undefined ? null : QuestionMetaSchema.safeParse(inlineSource);
      const annotation = manifest.annotations[key];

      let meta: QuestionMeta;
      if (frozen) {
        // A frozen question must stay byte-identical, so it carries no metadata of
        // its own. Its classification is a sidecar, and it is required.
        if (inline?.success === true) {
          problems.push(
            `frozen question "${key}" carries inline metadata; the frozen files must not change`,
          );
        }
        if (annotation === undefined) {
          problems.push(`frozen question "${key}" has no annotation in the manifest`);
          continue;
        }
        meta = annotation;
        usedAnnotations.add(key);
      } else {
        if (annotation !== undefined) {
          problems.push(
            `question "${key}" is annotated in the manifest and is not frozen; challenge questions classify themselves inline`,
          );
          usedAnnotations.add(key);
        }
        if (inline === null || !inline.success) {
          const detail =
            inline === null
              ? "no matching question in the raw case file"
              : inline.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
          problems.push(`challenge question "${key}" has no valid inline metadata (${detail})`);
          continue;
        }
        meta = inline.data;
      }

      questions.push({
        ...meta,
        key,
        caseId: entry.case.id,
        questionId: question.id,
        setId,
        repository: entry.case.repository,
        question: question.question,
        field: question.field,
        expectedEvidence: question.expectedEvidence,
        annotated: frozen,
      });
    }
  }

  for (const key of Object.keys(manifest.annotations)) {
    if (!usedAnnotations.has(key)) {
      problems.push(`manifest annotates "${key}", which is not a question in the benchmark`);
    }
  }

  // --- categories must all be declared, so the manifest stays the readable index
  const declaredCategories = new Set(manifest.categories.map((category) => category.id));
  for (const question of questions) {
    if (!declaredCategories.has(question.category)) {
      problems.push(`question "${question.key}" uses category "${question.category}", undeclared in the manifest`);
    }
  }

  // --- counts, derived here and checked against the declaration
  const sets: BenchmarkSet[] = manifest.sets.map((set) => ({
    id: set.id,
    title: set.title,
    frozen: set.frozen,
    description: set.description,
    caseIds: set.cases,
    questionCount: questions.filter((question) => question.setId === set.id).length,
  }));

  const regression = sets.filter((set) => set.frozen).reduce((sum, set) => sum + set.questionCount, 0);
  const challenge = sets.filter((set) => !set.frozen).reduce((sum, set) => sum + set.questionCount, 0);
  const total = questions.length;

  if (regression !== manifest.regressionCount) {
    problems.push(`manifest declares regressionCount ${manifest.regressionCount}; the frozen sets hold ${regression}`);
  }
  if (challenge !== manifest.challengeCount) {
    problems.push(`manifest declares challengeCount ${manifest.challengeCount}; the challenge sets hold ${challenge}`);
  }
  if (total !== manifest.totalCount) {
    problems.push(`manifest declares totalCount ${manifest.totalCount}; the benchmark holds ${total}`);
  }
  if (regression + challenge !== total) {
    problems.push(`sets hold ${regression} + ${challenge} questions but the benchmark holds ${total}`);
  }

  // --- difficulty distribution
  for (const [setId, declared] of Object.entries(manifest.difficultyDistribution)) {
    if (!sets.some((set) => set.id === setId)) {
      problems.push(`difficultyDistribution names set "${setId}", which is not declared`);
      continue;
    }
    for (const difficulty of BENCHMARK_DIFFICULTIES) {
      const actual = questions.filter((q) => q.setId === setId && q.difficulty === difficulty).length;
      if (declared[difficulty] !== actual) {
        problems.push(
          `difficultyDistribution["${setId}"].${difficulty} is ${declared[difficulty]}; the set holds ${actual}`,
        );
      }
    }
  }
  for (const set of sets) {
    if (manifest.difficultyDistribution[set.id] === undefined) {
      problems.push(`set "${set.id}" has no difficultyDistribution entry`);
    }
  }

  if (problems.length > 0) {
    throw new EvaluationError(
      `The benchmark manifest and ${casesDirectory} disagree:\n  - ${problems.join("\n  - ")}`,
      "The manifest is the declaration and the case files are the dataset. Fix whichever is wrong; do not adjust a count to match a mistake.",
    );
  }

  return {
    name: manifest.benchmarkName,
    version: manifest.benchmarkVersion,
    manifest,
    sets,
    cases,
    questions,
    counts: { regression, challenge, total },
  };
}

/** Question counts per category, for a set or across the whole benchmark. */
export function categoryCounts(
  benchmark: Benchmark,
  setId?: string,
): Record<BenchmarkCategory, number> {
  const counts = Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => [category, 0])) as Record<
    BenchmarkCategory,
    number
  >;
  for (const question of benchmark.questions) {
    if (setId !== undefined && question.setId !== setId) continue;
    counts[question.category] += 1;
  }
  return counts;
}

/** Question counts per difficulty, for a set or across the whole benchmark. */
export function difficultyCounts(
  benchmark: Benchmark,
  setId?: string,
): Record<BenchmarkDifficulty, number> {
  const counts = Object.fromEntries(BENCHMARK_DIFFICULTIES.map((level) => [level, 0])) as Record<
    BenchmarkDifficulty,
    number
  >;
  for (const question of benchmark.questions) {
    if (setId !== undefined && question.setId !== setId) continue;
    counts[question.difficulty] += 1;
  }
  return counts;
}

/** Looks a question up by its benchmark-wide key. */
export function findQuestion(benchmark: Benchmark, key: string): BenchmarkQuestion | undefined {
  return benchmark.questions.find((question) => question.key === key);
}

/**
 * What *kind* of evidence a question expects.
 *
 * The distinction the whole Challenge Set exists to make: a question whose
 * expected evidence is a README or a manifest can be answered by a system that
 * reads documentation, and one whose expected evidence is a source file cannot.
 * Grouping failures by this is how a retrieval weakness is told apart from a
 * reasoning weakness — a system that fails the `source` group and passes the
 * `documentation` group has a *looking* problem, not a *thinking* problem.
 *
 * `mixed` is its own bucket rather than being folded into either: a question that
 * needs both a readme and a source file is a different demand from one that needs
 * only one of them.
 */
export const EVIDENCE_KINDS = ["documentation", "source", "mixed", "none"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const DOCUMENTATION_REFERENCE = /(^|\/)(readme|changelog|contributing)[^/]*$|\.md$|(^|\/)(package\.json|pyproject\.toml|setup\.cfg|requirements\.txt)$/i;

export function evidenceKind(expectedEvidence: readonly string[]): EvidenceKind {
  if (expectedEvidence.length === 0) return "none";
  let documentation = 0;
  let source = 0;
  for (const reference of expectedEvidence) {
    const bare = bareReference(reference);
    if (DOCUMENTATION_REFERENCE.test(bare)) documentation += 1;
    else source += 1;
  }
  if (documentation > 0 && source > 0) return "mixed";
  return source > 0 ? "source" : "documentation";
}

/** Question counts per evidence kind, for a set or across the whole benchmark. */
export function evidenceKindCounts(benchmark: Benchmark, setId?: string): Record<EvidenceKind, number> {
  const counts = Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, 0])) as Record<EvidenceKind, number>;
  for (const question of benchmark.questions) {
    if (setId !== undefined && question.setId !== setId) continue;
    counts[evidenceKind(question.expectedEvidence)] += 1;
  }
  return counts;
}

/**
 * Strips the `:line` and ` (note)` decorations an evidence reference may carry,
 * the same way the evidence matcher does, leaving a repository-relative path.
 */
function bareReference(reference: string): string {
  return (reference.split(":")[0] ?? "").split(" (")[0]?.trim() ?? "";
}

/**
 * Every `expectedEvidence` reference that does not resolve to a file on disk.
 *
 * Deliberately not part of `loadBenchmark`: the fixtures are generated and
 * gitignored (`pnpm fixtures:build`), so a missing path can mean "the reference
 * is wrong" or "the fixtures are not built yet", and only the caller knows
 * which. The integrity test builds fixtures first and then requires this to be
 * empty. A reference may carry a `:line` or ` (note)` suffix, which is stripped
 * the same way the evidence matcher strips it.
 */
export function unresolvedEvidenceReferences(
  benchmark: Benchmark,
  projectRoot = process.cwd(),
): { key: string; reference: string; resolved: string }[] {
  const unresolved: { key: string; reference: string; resolved: string }[] = [];
  for (const question of benchmark.questions) {
    for (const reference of question.expectedEvidence) {
      const resolved = path.resolve(projectRoot, question.repository, bareReference(reference));
      if (!existsSync(resolved)) unresolved.push({ key: question.key, reference, resolved });
    }
  }
  return unresolved;
}

/** One line naming the dataset, for a report header or a run log. */
export function describeBenchmark(benchmark: Benchmark): string {
  const parts = benchmark.sets.map((set) => `${set.title} ${set.questionCount}`);
  return `${benchmark.name} ${benchmark.version} — ${parts.join(", ")}, total ${benchmark.counts.total}`;
}
