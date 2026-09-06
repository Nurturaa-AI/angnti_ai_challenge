/**
 * Offline diagnostic: would composition have made the control's failures citable?
 *
 * Replays the claim pass over briefings that already exist on disk and re-scores
 * them with the real, unmodified evaluator. It calls no model and reads no
 * benchmark data into the product pipeline — the claim pass here sees exactly what
 * it sees in production, a briefing and a ledger. The questions enter only
 * afterwards, in the scorer, which is where they belong.
 *
 * This is a diagnostic, not a measurement. It answers "is the mechanism capable of
 * moving these cases", so an expensive real run is not spent finding out. The
 * number that counts still comes from the evaluation runner against live model
 * output.
 *
 *   pnpm tsx scripts/diagnose-claim-composition.ts <trajectory.json> <case.json>
 */
import { readFileSync } from "node:fs";
import {
  buildClaimSet,
  checkClaimIntegrity,
  composeClaimSet,
  materializeComposedClaims,
  type AnalysisBody,
  type AnalysisResult,
  type RunRecord,
} from "../packages/shared/src/index";
import { scoreQuestion, type EvalCase } from "../packages/evaluator/src/index";

const [trajectoryPath, casePath] = process.argv.slice(2);
if (trajectoryPath === undefined || casePath === undefined) {
  console.error("usage: diagnose-claim-composition.ts <trajectory.json> <case.json>");
  process.exit(2);
}

const record = JSON.parse(readFileSync(trajectoryPath, "utf8")) as RunRecord;
const evalCase = JSON.parse(readFileSync(casePath, "utf8")) as EvalCase;

const before = record.result;
const body = before as unknown as AnalysisBody;

const set = composeClaimSet(buildClaimSet(body));
const integrity = checkClaimIntegrity(set);
const { body: materialized, materializedIds } = materializeComposedClaims(body, set);
const after: AnalysisResult = { ...materialized, repository: before.repository };

console.log(`atomic=${set.claims.length} composed=${set.composed.length} materialized=${materializedIds.length}`);
console.log(`integrityOk=${integrity.ok} unsupported=${integrity.unsupportedClaimIds.length}`);
for (const issue of integrity.issues) console.log(`  issue ${issue.kind}: ${issue.detail}`);
for (const composed of set.composed) {
  const sources = composed.evidenceIds
    .map((id) => set.evidence[id])
    .filter((item) => item !== undefined)
    .map((item) => `${item.source}${item.location === undefined ? "" : `@${item.location}`}`);
  console.log(`  composed ${composed.kind} "${composed.subject ?? ""}" parts=${composed.claimIds.length} sources=${[...new Set(sources)].join(", ")}`);
}
console.log();

let moved = 0;
let lost = 0;
for (const question of evalCase.questions) {
  const a = scoreQuestion(question, { ...record, result: before });
  const b = scoreQuestion(question, { ...record, result: after });
  const flag = (s: { answerCorrect: boolean; evidenceBacked: boolean }): string =>
    s.evidenceBacked ? "BACKED" : s.answerCorrect ? "UNCITED" : "FAIL";
  const from = flag(a);
  const to = flag(b);
  if (from !== to) {
    if (to === "BACKED") moved += 1;
    if (from === "BACKED") lost += 1;
    console.log(`${question.id.padEnd(34)} ${from} -> ${to}   matchedIn=${b.matchedIn ?? "-"}`);
  }
}
console.log(`\nrecovered=${moved} lost=${lost}`);
