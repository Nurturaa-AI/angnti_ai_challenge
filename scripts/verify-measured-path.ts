import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

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
 * Iteration 6 sharpened the structural half, because the original version was both too
 * loose and too tight at once, and the two flaws hid each other:
 *
 *   - **Too loose, in the place that mattered most.** `fixtures` sat in both lists, but
 *     fixtures are generated rather than committed — `git ls-files fixtures/` returns
 *     nothing, so `git diff -- fixtures` could never report anything and the strongest-
 *     sounding guarantee in the script had never once executed. The tracked source of
 *     truth for what the systems read is `scripts/build-fixtures.ts`, which was not on the
 *     measured path at all. It is now, and it is frozen by content.
 *   - **Too tight, in a place the specification explicitly permits.** Any *addition* under
 *     `evaluation/cases` or `packages/evaluator` failed, which forbids adding a benchmark
 *     case — something Iteration 6 §19 allows in as many words. Additions there are now
 *     classified as authorised, and modifications are what fail.
 *
 * The net trade is deliberately not a relaxation. It is stronger on fixtures, which were
 * unprotected in practice; stronger on the frozen case files and the scoring core, which
 * are now compared byte for byte rather than merely watched for a diff; unchanged
 * everywhere else; and weaker on exactly two named plumbing files, each listed below with
 * the reason its modification cannot move a score. `ALLOWED_MODIFICATIONS` is the only
 * escape hatch in the script, it names files rather than directories, and every use of it
 * prints its own justification — so a reviewer sees the exemption rather than inheriting it.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-measured-path.ts --ref <git-ref>
 *   pnpm exec tsx scripts/verify-measured-path.ts --compare before.json after.json
 *
 * The two modes are independent; pass both to do both.
 */

/** The paths a benchmark number depends on. Changing these means re-measuring. */
const MEASURED = [
  "advanced/src",
  "baseline/src",
  "evaluation/cases",
  "evaluation/src",
  // The manifest decides what a percentage is a percentage *of*. A later iteration that
  // edits a count here has changed every carried-forward figure, so it is watched like the
  // cases it describes.
  "evaluation/benchmark.json",
  "packages/evaluator",
  // Not `fixtures`: see the note above. This is the tracked file that decides what the
  // fixture repositories contain, and therefore what any question can be answered from.
  "scripts/build-fixtures.ts",
];

/**
 * Files that must be byte-identical to the ref, with no exemption available.
 *
 * Two groups. The frozen benchmark cases, because a score means nothing if the questions
 * moved under it. And the scoring core, because a carried-forward number is only carried
 * forward if the code that produced it is the same code.
 *
 * These are compared by content against the ref rather than by whether git reports a diff,
 * so a mode change, a rename or a path slipping out of `MEASURED` cannot let one through.
 * The absolute anchor lives elsewhere on purpose: `packages/evaluator/test/benchmark.test.ts`
 * holds literal SHA-256 digests of the two case files, which do not depend on any git ref
 * at all. This check catches drift from the baseline; that one catches drift from the
 * dataset as it was first published.
 */
const FROZEN_CONTENT = [
  "evaluation/cases/case-001-orders-api.json",
  "evaluation/cases/case-002-pyflow.json",
  "packages/evaluator/src/aggregate.ts",
  "packages/evaluator/src/case-schema.ts",
  "packages/evaluator/src/load.ts",
  "packages/evaluator/src/matching.ts",
  "packages/evaluator/src/report.ts",
  "packages/evaluator/src/score.ts",
  "scripts/build-fixtures.ts",
];

/**
 * Prefixes where an addition is authorised rather than suspicious.
 *
 * Iteration 6 §19: "Adding new benchmark cases is allowed. Adding benchmark infrastructure
 * is allowed. Changing the existing 14 expected cases is not." A new file cannot alter an
 * existing case, and the frozen files above are checked by content regardless, so an
 * addition here is reported and permitted.
 */
const AUTHORISED_ADDITIONS = ["evaluation/cases/", "packages/evaluator/"];

/**
 * The only files on the measured path whose modification does not fail, each with the
 * reason. Files, never directories — a directory-shaped exemption is how a guard quietly
 * stops guarding.
 */
const ALLOWED_MODIFICATIONS: Record<string, string> = {
  "packages/evaluator/src/index.ts":
    "re-export list only; every scoring module it exports is compared by content above",
  "evaluation/src/run.ts":
    "threads provenance and the benchmark manifest through the harness; it calls the same " +
    "scorer and the same aggregator, both frozen by content above, and the empirical " +
    "--compare mode is what confirms the answers did not move",
};

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

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const ref = flag("--ref");
if (ref !== null) {
  console.log(`Structural integrity of the measured path against ${ref}`);

  // Content first, because it is the check with no exemption. A file here that differs is
  // a failure whatever the diff summary says about it.
  for (const file of FROZEN_CONTENT) {
    if (!existsSync(file)) {
      fail(`${file} is frozen but is not in the working tree; restore it`);
      continue;
    }
    let before: string;
    try {
      before = execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" });
    } catch {
      console.log(`  frozen ${file}: absent at ${ref} (new since then)`);
      continue;
    }
    const after = readFileSync(file, "utf8");
    if (sha256(before) === sha256(after)) {
      console.log(`  frozen ${file}: unchanged`);
    } else {
      fail(`${file} is frozen and its content differs from ${ref}; restore it rather than re-baselining`);
    }
  }

  const changes = execFileSync("git", ["diff", "--name-status", ref, "--", ...MEASURED], {
    encoding: "utf8",
  }).trim();
  // `git diff` against a ref cannot see a file git does not track yet, and this command is
  // most useful *before* a commit — so an uncommitted new benchmark case would otherwise be
  // invisible to the one check meant to notice it. Untracked files are folded in as
  // additions, which is what they are.
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...MEASURED],
    { encoding: "utf8" },
  ).trim();

  const counts = new Map<string, string>();
  const numstat = execFileSync("git", ["diff", "--numstat", ref, "--", ...MEASURED], {
    encoding: "utf8",
  }).trim();
  if (numstat !== "") {
    for (const line of numstat.split("\n")) {
      const [added = "0", removed = "0", file = ""] = line.split("\t");
      counts.set(file, `+${added} -${removed}`);
    }
  }

  const entries: { status: string; file: string }[] = [];
  if (changes !== "") {
    for (const line of changes.split("\n")) {
      const parts = line.split("\t");
      // A rename reports the old path then the new one; the new path is what exists now.
      entries.push({
        status: (parts[0] ?? "").charAt(0),
        file: (parts.length > 2 ? parts[2] : parts[1]) ?? "",
      });
    }
  }
  if (untracked !== "") {
    for (const file of untracked.split("\n")) entries.push({ status: "A", file });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));

  if (entries.length === 0) {
    console.log("  clean — no file under the measured path differs");
  } else {
    for (const { status, file } of entries) {
      const churn = counts.get(file) ?? "";
      console.log(`  ${file}: ${status}${churn === "" ? "" : ` ${churn}`}`);

      if (status === "D") {
        fail(`${file} was deleted from the measured path; a carried-forward score cannot survive that`);
        continue;
      }
      if (status === "A") {
        const authorised = AUTHORISED_ADDITIONS.find((prefix) => file.startsWith(prefix));
        console.log(
          authorised === undefined
            ? `        addition — not a failure, but read it before carrying a number forward`
            : `        addition under ${authorised} — authorised by §19 (new cases and new infrastructure)`,
        );
        continue;
      }
      if (FROZEN_CONTENT.includes(file)) continue; // Already failed by content, above.
      const reason = ALLOWED_MODIFICATIONS[file];
      if (reason === undefined) {
        fail(`${file} was modified on the measured path; re-measure or revert it`);
      } else {
        console.log(`        modification permitted — ${reason}`);
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
