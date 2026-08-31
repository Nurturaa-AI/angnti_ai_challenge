import { SOURCE_EXTENSIONS } from "./lexicon";
import type { SearchTerm } from "./terms";

/**
 * Candidate ranking: many search hits in, a handful of files worth reading out.
 *
 * The scout can afford four reads. A search for six terms across a real repository
 * returns far more files than that, so something has to choose — and the choice has
 * to be deterministic, or the same repository would be scouted differently on two
 * runs and the measurement would mean nothing.
 *
 * The strategy is five additive signals and no tuning. It is not trying to be a
 * retrieval system; it is trying to beat "the model guessed a filename", which is
 * the bar Iteration 1 set.
 */

/** One line of `search_code` output, parsed back into structure. */
export interface SearchHit {
  path: string;
  line: number;
  /** The matched source line, as the tool rendered it (possibly clipped). */
  text: string;
  /** The term whose search produced this hit. */
  term: string;
}

export interface ScoutCandidate {
  path: string;
  /** Distinct terms that matched in this file, highest-weighted first. */
  matchedTerms: string[];
  /** Total hits across all terms. */
  matchCount: number;
  /** Line numbers that matched, ascending. Decides where the read window starts. */
  matchedLines: number[];
  /** The weight of the strongest term that matched here. */
  termWeight: number;
  score: number;
  /** Human-readable signals that produced the score, for the trajectory. */
  reasons: string[];
}

/**
 * Scoring weights.
 *
 * `termWeight` carries over from extraction, so a file found through the question's
 * own words starts ahead of one found through a generic concept word. Everything
 * else is a bonus on top of it.
 */
const SCORE = {
  /** Per additional distinct term matching the same file. Convergence is the strongest signal. */
  perExtraTerm: 25,
  /**
   * But convergence saturates. Beyond a few terms, a high match count stops meaning
   * "this file is where the concepts meet" and starts meaning "this file is long and
   * mentions everything" — which is what a test file or an entry point looks like.
   * Uncapped, this bonus reached +200 on the pyflow fixture and put the test suite
   * above every implementation file.
   */
  maxExtraTerms: 3,
  /** A matched term appearing in the path itself: `inventory` in `services/inventory.js`. */
  perPathMatch: 40,
  /** At most this many path matches count, so a long path cannot dominate. */
  maxPathMatches: 2,
  /** Implementation file rather than prose. */
  sourceExtension: 20,
  /** Two different terms matching within this many lines of each other. */
  proximity: 15,
  proximityWindow: 20,
  /**
   * Rarity: a term matching one or two files points at something; a term matching
   * every file points at nothing.
   *
   * Indexed by how many files the term hit across the whole scan, so `[0]` is unused
   * and `[1]` is "this term appears in exactly one file". This is the signal that
   * does the fine discrimination, and it is the reason extraction does not need to
   * guess which prose concepts matter: a word list cannot tell `dispatch` from
   * `load`, but their match counts can. It is computed after searching because
   * searching is nearly free — a filesystem walk, no tokens — while reading is what
   * costs prompt bytes.
   */
  rarity: [0, 30, 20, 10] as const,
} as const;

export interface RankOptions {
  /**
   * Files the reconnaissance context already supplied — README, manifest.
   *
   * Excluded outright. Their bytes are already in the prompt, so a read would spend
   * budget to duplicate what the model can see, and this is how the brief's
   * "implementation source over generic documentation" preference is implemented:
   * by removing the documentation that is already present, not by penalising
   * Markdown as a class. A design note the agent has never seen is still worth
   * reading, and one of them was Iteration 1's clearest win.
   */
  exclude?: readonly string[];
  /** Ceiling on returned candidates. */
  max: number;
}

export function rankCandidates(
  hits: readonly SearchHit[],
  terms: readonly SearchTerm[],
  options: RankOptions,
): ScoutCandidate[] {
  const weightOf = new Map(terms.map((term) => [term.term, term.weight]));
  const excluded = new Set((options.exclude ?? []).map(normalizePath));

  // How many distinct files each term reached, across the whole scan. Counted before
  // exclusions, because a term's breadth is a fact about the repository rather than
  // about which files this scout is allowed to read.
  const spread = new Map<string, Set<string>>();
  for (const hit of hits) {
    const seen = spread.get(hit.term);
    if (seen) seen.add(normalizePath(hit.path));
    else spread.set(hit.term, new Set([normalizePath(hit.path)]));
  }

  const byPath = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (excluded.has(normalizePath(hit.path))) continue;
    const existing = byPath.get(hit.path);
    if (existing) existing.push(hit);
    else byPath.set(hit.path, [hit]);
  }

  const candidates: ScoutCandidate[] = [];
  for (const [path, fileHits] of byPath) {
    candidates.push(scoreCandidate(path, fileHits, weightOf, spread));
  }

  candidates.sort((a, b) => (b.score - a.score) || comparePath(a.path, b.path));
  return candidates.slice(0, Math.max(options.max, 0));
}

function scoreCandidate(
  path: string,
  hits: readonly SearchHit[],
  weightOf: ReadonlyMap<string, number>,
  spread: ReadonlyMap<string, ReadonlySet<string>>,
): ScoutCandidate {
  const matchedTerms = [...new Set(hits.map((hit) => hit.term))].sort(
    (a, b) => (weightOf.get(b) ?? 0) - (weightOf.get(a) ?? 0) || comparePath(a, b),
  );
  const matchedLines = [...new Set(hits.map((hit) => hit.line))].sort((a, b) => a - b);
  const termWeight = Math.max(...matchedTerms.map((term) => weightOf.get(term) ?? 0), 0);

  const reasons: string[] = [];
  let score = termWeight;
  reasons.push(`term weight ${termWeight} (${matchedTerms[0] ?? "?"})`);

  if (matchedTerms.length > 1) {
    const counted = Math.min(matchedTerms.length - 1, SCORE.maxExtraTerms);
    const bonus = SCORE.perExtraTerm * counted;
    score += bonus;
    reasons.push(`+${bonus} for ${matchedTerms.length} distinct terms`);
  }

  const rarest = rarestTerm(matchedTerms, spread);
  if (rarest) {
    score += rarest.bonus;
    reasons.push(`+${rarest.bonus} for ${rarest.term} matching only ${rarest.files} file(s)`);
  }

  const inPath = matchedTerms.filter((term) => pathContainsTerm(path, term));
  if (inPath.length > 0) {
    const counted = Math.min(inPath.length, SCORE.maxPathMatches);
    const bonus = SCORE.perPathMatch * counted;
    score += bonus;
    reasons.push(`+${bonus} for ${inPath.slice(0, counted).join(", ")} in the path`);
  }

  if (isSourceFile(path)) {
    score += SCORE.sourceExtension;
    reasons.push(`+${SCORE.sourceExtension} for implementation source`);
  }

  if (hasNearbyDistinctTerms(hits)) {
    score += SCORE.proximity;
    reasons.push(`+${SCORE.proximity} for two terms within ${SCORE.proximityWindow} lines`);
  }

  return { path, matchedTerms, matchCount: hits.length, matchedLines, termWeight, score, reasons };
}

/** The narrowest term that reached this file, and what its rarity is worth. */
function rarestTerm(
  matchedTerms: readonly string[],
  spread: ReadonlyMap<string, ReadonlySet<string>>,
): { term: string; files: number; bonus: number } | undefined {
  let best: { term: string; files: number; bonus: number } | undefined;
  for (const term of matchedTerms) {
    const files = spread.get(term)?.size ?? 0;
    const bonus = SCORE.rarity[files] ?? 0;
    if (bonus === 0) continue;
    if (!best || bonus > best.bonus) best = { term, files, bonus };
  }
  return best;
}

/**
 * True when two *different* terms matched close together.
 *
 * The signal this is after: a file where the question's concepts meet, rather than a
 * file that mentions one of them in a comment at the top and the other 300 lines
 * later. `REGISTRY.get(step.type)` is the shape worth finding.
 */
function hasNearbyDistinctTerms(hits: readonly SearchHit[]): boolean {
  const sorted = [...hits].sort((a, b) => a.line - b.line);
  for (let i = 0; i < sorted.length; i += 1) {
    const left = sorted[i];
    if (!left) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const right = sorted[j];
      if (!right) continue;
      if (right.line - left.line > SCORE.proximityWindow) break;
      if (right.term !== left.term) return true;
    }
  }
  return false;
}

/** Whole-segment match, so `order` hits `orders.js` but `route` does not hit `router-x`. */
function pathContainsTerm(path: string, term: string): boolean {
  const segments = normalizePath(path)
    .split(/[/\\]/)
    .flatMap((segment) => segment.toLowerCase().split(/[^a-z0-9]+/))
    .filter((segment) => segment !== "");
  return term.split(" ").some((word) => segments.some((segment) => segment.includes(word)));
}

export function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reads `search_code`'s own output back into hits.
 *
 * The scout deliberately consumes the *tool's* text rather than calling the search
 * internals directly. That keeps one guarantee true: the scout can only see what
 * the model could have seen by making the same call. There is no privileged path
 * into the filesystem, and nothing enters the ledger that a tool did not produce.
 *
 * Rows are `path:line: text`. A row that does not parse is skipped rather than
 * guessed at — the header line and the "no match" line both land here, and a
 * malformed row should cost a candidate, not the whole scan.
 */
export function parseSearchHits(output: string, term: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of output.split("\n")) {
    const match = /^(.+?):(\d+): (.*)$/.exec(row);
    if (!match) continue;
    const [, path, line, text] = match;
    if (path === undefined || line === undefined || text === undefined) continue;
    const lineNumber = Number.parseInt(line, 10);
    if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
    hits.push({ path, line: lineNumber, text, term });
  }
  return hits;
}
