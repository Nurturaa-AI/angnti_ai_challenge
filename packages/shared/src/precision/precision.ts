import { normalizeForMatch, type ContextSourceText } from "../context-format";
import { createCitationVerifier } from "../grounding";
import type { AnalysisBody, Evidence } from "../schemas";
import { claimTerms, findCorroborations } from "./corroborate";
import { DEFAULT_PRECISION_POLICY, type PrecisionPolicy } from "./policy";
import { orderCitations } from "./score";

/**
 * The evidence precision pass: synthesis → validate → **here** → grounding.
 *
 * Iteration 2 reached 100% answer accuracy and 85.7% evidence-backed accuracy. Both
 * remaining failures were the same shape — a correct answer, a grounded citation,
 * and the citation pointing at a different source than the one the question was
 * written against. Neither was a retrieval failure. Both were citation-selection
 * failures.
 *
 * So this pass does two things to a claim's citations, and it is worth being precise
 * about which one is the experiment:
 *
 *   - **Removal** is hygiene. It deletes a citation only when another retained
 *     citation from the same source *and the same location* already contains it.
 *     That cannot change which (source, location) pairs a claim carries, so it
 *     cannot change whether the claim is evidence-backed. It exists because a
 *     briefing that quotes the same line three times is worse to read, not because
 *     it moves a number.
 *
 *   - **Corroboration** is the hypothesis. It attaches ledger evidence the model
 *     had available and did not cite, when that evidence verifiably speaks to the
 *     claim. This is the only part that can change the metric.
 *
 * Together they give the pass a one-way property worth stating plainly: **no
 * (source, location) pair present before the pass is absent after it.** Evidence is
 * added and reordered; nothing that could support a claim is taken away. That is
 * the guarantee that lets this ship on the last day without risking the result it
 * is trying to improve, and `precision.test.ts` asserts it directly.
 *
 * What the pass never does: open a file, call a model, invent an excerpt, or make a
 * citation stronger than the ledger proves. Existence evidence stays existence
 * evidence; grounding still has the final word on every citation, including the
 * ones added here. And it corroborates only a claim that already has at least one
 * citation grounding would accept — so a claim built on a hallucinated path stays
 * visibly unsupported instead of being quietly rescued by real evidence.
 */

export interface PrecisionSummary {
  claimsInspected: number;
  citationsBefore: number;
  citationsAfter: number;
  duplicatesRemoved: number;
  redundantRemoved: number;
  corroborationsAdded: number;
  claimsCorroborated: number;
  /** Sources newly cited by the pass, for auditing what it attached and why. */
  corroboratedSources: string[];
}

export interface PrecisionResult {
  body: AnalysisBody;
  summary: PrecisionSummary;
}

export function applyEvidencePrecision(
  body: AnalysisBody,
  sources: readonly ContextSourceText[],
  policy: PrecisionPolicy = DEFAULT_PRECISION_POLICY,
): PrecisionResult {
  const summary: PrecisionSummary = {
    claimsInspected: 0,
    citationsBefore: 0,
    citationsAfter: 0,
    duplicatesRemoved: 0,
    redundantRemoved: 0,
    corroborationsAdded: 0,
    claimsCorroborated: 0,
    corroboratedSources: [],
  };

  const isVerifiable = createCitationVerifier(sources);
  const refine = (evidence: readonly Evidence[], claimText: string): Evidence[] =>
    refineClaim(evidence, claimText, sources, policy, summary, isVerifiable);

  const refined: AnalysisBody = {
    ...body,
    components: body.components.map((component) => ({
      ...component,
      evidence: refine(component.evidence, [component.name, component.path ?? "", component.responsibility].join(" ")),
    })),
    flows: body.flows.map((flow) => ({
      ...flow,
      evidence: refine(flow.evidence, [flow.name, flow.description, ...flow.steps].join(" ")),
    })),
    dependencies: body.dependencies.map((dependency) => ({
      ...dependency,
      evidence: refine(
        dependency.evidence,
        [dependency.name, dependency.scope, dependency.purpose ?? ""].join(" "),
      ),
    })),
    testing: {
      ...body.testing,
      evidence: refine(
        body.testing.evidence,
        [body.testing.approach, ...body.testing.frameworks, ...body.testing.testPaths, ...body.testing.gaps].join(" "),
      ),
    },
    risks: body.risks.map((risk) => ({
      ...risk,
      evidence: refine(risk.evidence, [risk.title, risk.description].join(" ")),
    })),
    // The top-level pool is what backs the summary and the architecture prose, so
    // that is the claim text it is matched against.
    evidence: refine(body.evidence, [body.summary, body.architecture].join(" ")),
  };

  summary.corroboratedSources = [...new Set(summary.corroboratedSources)].sort();
  return { body: refined, summary };
}

function refineClaim(
  evidence: readonly Evidence[],
  claimText: string,
  sources: readonly ContextSourceText[],
  policy: PrecisionPolicy,
  summary: PrecisionSummary,
  isVerifiable: (item: Evidence) => boolean,
): Evidence[] {
  summary.claimsInspected += 1;
  summary.citationsBefore += evidence.length;

  const { kept, duplicates } = dedupe(evidence);
  summary.duplicatesRemoved += duplicates;

  const { kept: distinct, removed } = dropRedundant(kept);
  summary.redundantRemoved += removed;

  // Corroboration strengthens a claim the model already grounded. It never rescues
  // one it did not.
  //
  // Both halves of that matter. A claim the model cited nothing for is left
  // unsupported, because supplying its evidence would be answering on the model's
  // behalf. And a claim whose every citation is unverifiable — a hallucinated path, a
  // quote that appears in no artefact — is left unsupported too, which is the case
  // worth being explicit about: attaching real evidence to a fabricated claim would
  // let the pass launder a hallucination into a supported statement, and the
  // visible-unsupported-claim property is one of the few things this project can
  // actually promise. The predicate is grounding's own, so the pass and the
  // grounding layer cannot disagree about which citations count.
  const corroborations =
    distinct.some(isVerifiable) ? findCorroborations(claimText, distinct, sources, policy) : [];

  if (corroborations.length > 0) {
    summary.corroborationsAdded += corroborations.length;
    summary.claimsCorroborated += 1;
    for (const corroboration of corroborations) summary.corroboratedSources.push(corroboration.sourceId);
  }

  const combined = [...distinct, ...corroborations.map((corroboration) => corroboration.evidence)];
  const ordered = orderCitations(combined, claimTerms(claimText));
  summary.citationsAfter += ordered.length;
  return ordered;
}

/** Byte-identical citations. The first occurrence wins, so model order survives. */
function dedupe(evidence: readonly Evidence[]): { kept: Evidence[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: Evidence[] = [];
  let duplicates = 0;

  for (const item of evidence) {
    const key = [
      normalizeSourceId(item.source),
      normalizeForMatch(item.location ?? ""),
      normalizeForMatch(item.excerpt ?? ""),
      item.type,
    ].join("|");
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    kept.push(item);
  }

  return { kept, duplicates };
}

/**
 * Citations that add nothing another citation does not already carry.
 *
 * Redundancy is only claimed within one source *and* one location. Two quotes from
 * the same file at different locations are two facts, and a wider quote at the same
 * location strictly contains a narrower one — so the wider is kept and the narrower
 * dropped, which is the only direction that cannot lose information.
 *
 * Restricting the rule to a matching location is what makes the pass safe: the
 * evaluator credits evidence by (source, location), and this can never remove a
 * pair that was present.
 */
function dropRedundant(evidence: readonly Evidence[]): { kept: Evidence[]; removed: number } {
  const kept: Evidence[] = [];
  let removed = 0;

  for (const item of evidence) {
    const supersededBy = kept.findIndex((other) => covers(other, item));
    if (supersededBy !== -1) {
      removed += 1;
      continue;
    }

    // The reverse: this citation covers one already kept, so swap them rather than
    // holding both.
    const nowRedundant = kept.findIndex((other) => covers(item, other));
    if (nowRedundant !== -1) {
      kept[nowRedundant] = item;
      removed += 1;
      continue;
    }

    kept.push(item);
  }

  return { kept, removed };
}

/** True when `wider` carries everything `narrower` does. */
function covers(wider: Evidence, narrower: Evidence): boolean {
  if (normalizeSourceId(wider.source) !== normalizeSourceId(narrower.source)) return false;
  if (wider.type !== narrower.type) return false;
  if (normalizeForMatch(wider.location ?? "") !== normalizeForMatch(narrower.location ?? "")) return false;

  const wide = normalizeForMatch(wider.excerpt ?? "");
  const narrow = normalizeForMatch(narrower.excerpt ?? "");
  if (narrow === "") return true;
  if (wide === "") return false;
  return wide.includes(narrow);
}

function normalizeSourceId(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
