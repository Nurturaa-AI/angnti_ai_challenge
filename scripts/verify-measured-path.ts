import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Is the measured path still the measured path?
 *
 * Every iteration since the first has claimed the benchmark numbers it did not re-run are
 * still valid, and until now that claim was an argument in a document. This turns it into
 * a command with an exit code.
 *
 * Two questions, because either one alone can be satisfied by a broken tree:
 *
 *   1. Structural — what changed under the directories that decide a score? A deletion or
 *      a modification there invalidates a carried-forward number outright. A pure addition
 *      might not, but it has to be looked at, so it is printed rather than waved through.
 *   2. Empirical — do two mock runs still agree once the run id and the wall clock are
 *      stripped? The mock provider is deterministic at a fixed seed, so any difference in
 *      what the systems answered is a behaviour change, wherever it came from.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-measured-path.ts --ref <git-ref>
 *   pnpm exec tsx scripts/verify-measured-path.ts --compare before.json after.json
 *
 * The two modes are independent; pass both to do both.
 */

/** The directories a benchmark number depends on. Changing these means re-measuring. */
const MEASURED = [
  "advanced/src",
  "baseline/src",
  "evaluation/cases",
  "evaluation/src",
  "packages/evaluator",
  "fixtures",
];

/** Of those, the ones the specification puts off limits entirely. */
const FROZEN = ["evaluation/cases", "evaluation/src", "packages/evaluator", "fixtures"];

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

let failures = 0;
const fail = (message: string): void => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

const ref = flag("--ref");
if (ref !== null) {
  console.log(`Structural integrity of the measured path against ${ref}`);

  const numstat = execFileSync("git", ["diff", "--numstat", ref, "--", ...MEASURED], {
    encoding: "utf8",
  }).trim();

  if (numstat === "") {
    console.log("  clean — no file under the measured path differs");
  } else {
    for (const line of numstat.split("\n")) {
      const [added = "0", removed = "0", file = ""] = line.split("\t");
      console.log(`  ${file}: +${added} -${removed}`);
      if (removed !== "0") {
        fail(`${file} has deletions; a carried-forward score cannot survive those unexamined`);
      }
      if (FROZEN.some((frozen) => file.startsWith(`${frozen}/`))) {
        fail(`${file} is under ${FROZEN.join(", ")} — off limits to a product iteration`);
      }
    }
  }

  // The version constants are the promise that the measured behaviour is the one the
  // recorded numbers were taken from. If they moved, the numbers need to move too.
  for (const [file, constant] of [
    ["advanced/src/index.ts", "ADVANCED_VERSION"],
    ["baseline/src/index.ts", "BASELINE_VERSION"],
  ] as const) {
    const version = (source: string): string =>
      new RegExp(`${constant} = "([^"]+)"`).exec(source)?.[1] ?? "<absent>";
    const before = version(execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }));
    const after = version(readFileSync(file, "utf8"));
    console.log(`  ${constant}: ${before} -> ${after}`);
    if (before !== after) fail(`${constant} moved; re-run the evaluation before claiming a number`);
  }
}

const compare = flag("--compare");
if (compare !== null) {
  const other = argv[argv.indexOf("--compare") + 2];
  if (other === undefined) {
    console.log("--compare needs two result files");
    process.exit(2);
  }
  console.log(`\nEmpirical agreement: ${compare} vs ${other}`);

  // Run identity and wall clock are the only things allowed to differ. Everything that
  // describes what a system answered stays in the comparison — that is the comparison.
  const VOLATILE = /^(runId|startedAt|finishedAt|durationMs|generatedAt|timestamp)$/;
  const RUN_ID = /eval-(advanced|baseline)-\d{4}-\d{2}-\d{2}T[\d-]+Z/g;
  const ISO = /\d{4}-\d{2}-\d{2}T[\d:.\-]+Z/g;

  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (VOLATILE.test(key)) continue;
        out[key] = normalize(source[key]);
      }
      return out;
    }
    if (typeof value === "string") return value.replace(RUN_ID, "<run>").replace(ISO, "<time>");
    return value;
  };

  const load = (file: string): string =>
    JSON.stringify(normalize(JSON.parse(readFileSync(file, "utf8"))), null, 2);

  if (load(compare) === load(other)) {
    console.log("  identical after normalization — the systems answered exactly the same thing");
  } else {
    fail("the two runs disagree; the measured behaviour changed");
  }
}

if (ref === null && compare === null) {
  console.log("nothing to do: pass --ref <git-ref> and/or --compare <before.json> <after.json>");
  process.exit(2);
}

console.log(failures === 0 ? "\nOK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
