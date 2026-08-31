import { normalizeForMatch } from "../context-format";
import type { Evidence } from "../schemas";
import { SOURCE_EXTENSIONS } from "../scout/lexicon";

/**
 * Deterministic citation scoring.
 *
 * Used only to *order* a claim's citations, never to decide the metric. That is a
 * deliberate limit: ordering is visible to a human reading the briefing and is
 * free of risk, whereas dropping a citation on the strength of a lexical score is
 * how a precision pass would quietly delete the one piece of evidence that
 * mattered. Removal here is governed by redundancy, which is provable, rather
 * than by score, which is a heuristic.
 *
 * No model call, no embedding, no index. Six signals over text already in hand.
 */

/** Evidence kinds whose text is the artefact's own content. */
export const CONTENT_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "readme",
  "manifest",
  "file",
  "git",
  "test",
  "command",
  "dependency",
]);

/** Kinds that prove a location exists without showing what it does. */
export const EXISTENCE_EVIDENCE_TYPES: ReadonlySet<string> = new Set(["tree", "metadata"]);

const SCORE = {
  /**
   * Content beats existence by more than every other signal combined.
   *
   * Deliberate, and the arithmetic has to hold for it to mean anything: the other
   * signals top out at `maxClaimTerms × perClaimTerm + concise + hasLocation +
   * implementationFile` = 115, so this sits above that. A directory listing that
   * happens to mention four of the claim's words must not outrank the code that
   * implements it, however well it scores on everything else.
   */
  content: 200,
  perClaimTerm: 15,
  maxClaimTerms: 4,
  concise: 20,
  moderate: 10,
  concisionCeiling: 240,
  moderateCeiling: 600,
  hasLocation: 15,
  implementationFile: 20,
} as const;

/** The most a citation can score without being content. Asserted in the tests. */
export const MAX_NON_CONTENT_SCORE =
  SCORE.maxClaimTerms * SCORE.perClaimTerm + SCORE.concise + SCORE.hasLocation + SCORE.implementationFile;

/** The least a content citation can score. Above `MAX_NON_CONTENT_SCORE`, by design. */
export const MIN_CONTENT_SCORE = SCORE.content;

export interface CitationScore {
  score: number;
  reasons: string[];
}

/**
 * @param terms Distinctive terms of the claim this citation is offered for,
 *   already normalised and deduplicated.
 */
export function scoreCitation(item: Evidence, terms: readonly string[]): CitationScore {
  const reasons: string[] = [];
  let score = 0;

  if (CONTENT_EVIDENCE_TYPES.has(item.type)) {
    score += SCORE.content;
    reasons.push("content");
  } else {
    reasons.push("existence");
  }

  const excerpt = item.excerpt ?? "";
  if (excerpt !== "") {
    const haystack = normalizeForMatch(excerpt);
    const matched = terms.filter((term) => haystack.includes(term)).slice(0, SCORE.maxClaimTerms);
    if (matched.length > 0) {
      score += matched.length * SCORE.perClaimTerm;
      reasons.push(`terms:${matched.join("+")}`);
    }

    // Short and specific beats a wall of quoted file. A reader can check a line;
    // nobody checks forty of them.
    if (excerpt.length <= SCORE.concisionCeiling) {
      score += SCORE.concise;
      reasons.push("concise");
    } else if (excerpt.length <= SCORE.moderateCeiling) {
      score += SCORE.moderate;
      reasons.push("moderate");
    }
  }

  if (item.location !== undefined && item.location.trim() !== "") {
    score += SCORE.hasLocation;
    reasons.push("located");
  }

  if (isImplementationPath(item.source)) {
    score += SCORE.implementationFile;
    reasons.push("implementation");
  }

  return { score, reasons };
}

export function isImplementationPath(source: string): boolean {
  const lower = source.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Stable, total ordering: score descending, then the order the model produced them.
 *
 * The index tiebreak is what makes the pass deterministic without discarding the
 * model's own sense of which citation it considered primary.
 */
export function orderCitations(items: readonly Evidence[], terms: readonly string[]): Evidence[] {
  return items
    .map((item, index) => ({ item, index, score: scoreCitation(item, terms).score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
