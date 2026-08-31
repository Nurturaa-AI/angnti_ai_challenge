import { normalizeForMatch, type ContextSourceText } from "../context-format";
import type { Evidence, EvidenceType } from "../schemas";
import { meaningfulTokens, stem } from "../scout/terms";
import { CONTENT_EVIDENCE_TYPES } from "./score";
import type { PrecisionPolicy } from "./policy";

/**
 * Corroboration: attaching evidence the model had but did not cite.
 *
 * This is the half of the precision pass that can move the primary metric, and it
 * is the half that needs the most care, so the rules are narrow on purpose:
 *
 *   1. only sources already in the evidence ledger — nothing is opened here
 *   2. only content-bearing kinds; a directory tree is never corroboration,
 *      because a listing cannot show what code does
 *   3. only a source this claim does not already cite
 *   4. only where one line of that source shares at least `minCorroborationTerms`
 *      distinctive terms with the claim
 *   5. the excerpt is a verbatim slice of that line, so grounding re-verifies it
 *      against the ledger like any other citation
 *
 * What it is *not*: a way to make a claim look better supported than it is. The
 * excerpt is real text from a real artefact, the evidence `type` is the artefact's
 * own, and the grounding layer is still the thing that decides whether the
 * citation survives. A corroboration that cannot be verified is dropped exactly
 * like a hallucinated one — which is the point.
 */

/** Below this, a line is a brace or an import and cannot corroborate anything. */
const MIN_LINE_CHARS = 12;

/** Below this, a term collides too easily to count as distinctive. */
const MIN_TERM_CHARS = 4;

export interface Corroboration {
  evidence: Evidence;
  sourceId: string;
  matchedTerms: string[];
}

/**
 * Distinctive terms of a claim, normalised for substring matching.
 *
 * Stemmed on the claim side only: `dispatched` becomes `dispatch`, which then
 * matches both spellings in the artefact by plain substring. Stemming both sides
 * would need the artefact tokenised too, for no extra recall.
 */
export function claimTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const token of meaningfulTokens(text)) {
    const stemmed = stem(token);
    if (stemmed.length >= MIN_TERM_CHARS) seen.add(stemmed);
  }
  return [...seen].sort();
}

interface Candidate {
  source: ContextSourceText;
  line: string;
  matchedTerms: string[];
  /** True when this source's kind is not yet represented among the claim's citations. */
  addsNewKind: boolean;
}

export function findCorroborations(
  claimText: string,
  cited: readonly Evidence[],
  sources: readonly ContextSourceText[],
  policy: PrecisionPolicy,
): Corroboration[] {
  if (policy.maxCorroborations <= 0) return [];

  const terms = claimTerms(claimText);
  if (terms.length < policy.minCorroborationTerms) return [];

  const citedSources = new Set(cited.map((item) => normalizeSourceId(item.source)));
  const citedKinds = new Set(cited.map((item) => item.type));

  const candidates: Candidate[] = [];
  for (const source of sources) {
    if (!CONTENT_EVIDENCE_TYPES.has(source.type)) continue;
    if (citedSources.has(normalizeSourceId(source.id))) continue;

    const best = bestLine(source.text, terms, policy.minCorroborationTerms);
    if (!best) continue;

    candidates.push({
      source,
      line: best.line,
      matchedTerms: best.matchedTerms,
      addsNewKind: !citedKinds.has(source.type),
    });
  }

  // Most shared terms first; then a kind the claim does not already have, because
  // the doc that states a behaviour and the code that implements it are worth more
  // together than two files saying the same thing; then source id, for a total order.
  candidates.sort(
    (a, b) =>
      b.matchedTerms.length - a.matchedTerms.length ||
      Number(b.addsNewKind) - Number(a.addsNewKind) ||
      a.source.id.localeCompare(b.source.id),
  );

  return candidates.slice(0, policy.maxCorroborations).map((candidate) => ({
    sourceId: candidate.source.id,
    matchedTerms: candidate.matchedTerms,
    evidence: {
      type: candidate.source.type as EvidenceType,
      source: candidate.source.id,
      excerpt: truncateExcerpt(candidate.line, policy.maxCorroborationChars),
      // No `location`. The ledger holds a raw slice whose first line is not
      // necessarily line 1 of the file, and a second read appends to it, so any
      // line number this pass could compute would be a guess. The excerpt locates
      // itself and grounding checks it; a fabricated line number would not.
    },
  }));
}

interface LineMatch {
  line: string;
  matchedTerms: string[];
}

/** The line sharing the most distinct claim terms. Ties go to the earliest line. */
function bestLine(text: string, terms: readonly string[], minimum: number): LineMatch | undefined {
  let best: LineMatch | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < MIN_LINE_CHARS) continue;

    const haystack = normalizeForMatch(line);
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    if (matchedTerms.length < minimum) continue;
    if (best === undefined || matchedTerms.length > best.matchedTerms.length) {
      best = { line, matchedTerms };
    }
  }
  return best;
}

/**
 * A prefix of the line, so the result stays a verbatim substring of the source.
 *
 * Cutting at a word boundary where one is available keeps the quote readable
 * without changing a character of it.
 */
function truncateExcerpt(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const slice = line.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace >= maxChars / 2 ? slice.slice(0, lastSpace) : slice;
}

function normalizeSourceId(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
