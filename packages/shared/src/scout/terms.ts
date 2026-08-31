import type { ContextSourceText } from "../context-format";
import {
  CONCEPT_SEEDS,
  PATH_EXTENSIONS,
  PATH_NOISE,
  STOP_WORDS,
  SYNONYMS,
  TECHNICAL_VOCABULARY,
} from "./lexicon";

/**
 * Query extraction: text in, a small ordered set of search terms out.
 *
 * The method is the one the brief prescribes and nothing more — tokenise, drop
 * stop words, keep the technical words, pair a few of them into compounds, expand
 * through a fixed synonym table. No model call, no statistics, no learned weights.
 * The same input always produces the same list in the same order, which is the
 * property that makes the phase testable at all.
 *
 * Two inputs, and the difference between them matters:
 *
 *   focus    a question someone asked. Optional, and absent during evaluation —
 *            see the note on `ExtractTermsInput.focus`.
 *   sources  the reconnaissance context the baseline already collected. The scout
 *            mines the repository's own words: what its documentation puts in bold
 *            or backticks, and which known concepts appear in its directory names.
 *
 * The second is what makes the scout work with no question at all. A README that
 * says "**Each step is dispatched by type** to `pyflow/steps/`" has told you which
 * mechanism to go looking for, in the author's own emphasis.
 */

export type TermOrigin =
  | "focus"
  | "focus-compound"
  | "emphasis"
  | "emphasis-path"
  | "emphasis-compound"
  | "path"
  | "vocabulary"
  | "synonym"
  | "seed";

export interface SearchTerm {
  /** The literal query handed to `search_code`. Lowercase; a compound has one space. */
  term: string;
  origin: TermOrigin;
  /** Search order: higher first, ties broken alphabetically. */
  weight: number;
  /** The input word this was derived from. Recorded so a term can be traced back. */
  from: string;
}

/**
 * Weights, in one place so the search order can be argued with.
 *
 * One principle orders every tier: **how much does this term tell me that
 * reconnaissance has not already told me?** The question comes first, since it is
 * the only input describing what someone actually wants to know. Then a phrase the
 * author emphasised in prose. Then a mechanism word they used in prose. Then a
 * concept-shaped directory name. Last, a fragment of a backticked *path* — because
 * the directory tree already lists every path in the repository, so searching for
 * `store` because the README mentions `pyflow/store.py` mostly rediscovers a file
 * the model can already see. That tier was worth 60 in the first draft, and a probe
 * against the fixtures showed it crowding out `dispatch` — the one word that leads
 * to the answer the motivating failure needed.
 *
 * A synonym sits just below the word it came from: a guess at what the code calls
 * something is worth less than a word the author actually wrote, but "search for the
 * name you do not know yet" is the move this whole phase exists to enable.
 */
const WEIGHTS = {
  focusTechnical: 100,
  focusOther: 80,
  focusCompound: 90,
  emphasisTechnical: 60,
  emphasisOther: 45,
  emphasisCompound: 50,
  /** A known concept the documentation names in prose. */
  vocabulary: 40,
  /** A known concept appearing in the repository's own directory names. */
  path: 35,
  /** A fragment of a backticked path — largely redundant with the tree. */
  emphasisPath: 30,
  seed: 10,
  /** A synonym starts this far below its parent, then decays by list position. */
  synonymPenalty: 5,
} as const;

/** Caps that keep extraction bounded regardless of how large the input is. */
const MAX_EMPHASIS_SPANS = 60;
const MAX_COMPOUND_SOURCES = 3;
const MAX_SYNONYMS_PER_TERM = 3;
const MIN_TOKEN_LENGTH = 3;

export interface ExtractTermsInput {
  /**
   * A question to scout for, when the caller has one.
   *
   * Deliberately absent during evaluation. The harness never shows a system the
   * questions it is being scored on — a property two tests pin with sentinel
   * strings — so wiring evaluation questions in here would both break those tests
   * and hand the advanced system an advantage the baseline does not have. It is
   * reachable in ordinary use through `--focus`.
   */
  focus?: string | undefined;
  /** Reconnaissance sources. Their text is mined; they are never modified. */
  sources?: readonly ContextSourceText[];
  /** Filtered out: it matches most of its own repository and answers nothing. */
  repositoryName?: string | undefined;
  /** Hard ceiling on returned terms. */
  max: number;
}

export function extractSearchTerms(input: ExtractTermsInput): SearchTerm[] {
  const collected: SearchTerm[] = [];
  const banned = new Set<string>();
  if (input.repositoryName !== undefined) {
    for (const part of tokenize(input.repositoryName)) banned.add(part);
  }

  // 1. The question, when there is one.
  if (input.focus !== undefined && input.focus.trim() !== "") {
    const tokens = meaningfulTokens(input.focus);
    for (const token of tokens) {
      collected.push({
        term: token,
        origin: "focus",
        weight: isTechnical(token) ? WEIGHTS.focusTechnical : WEIGHTS.focusOther,
        from: token,
      });
    }
    // Compounds pair the question's *technical* words. `search_code` requires every
    // word of a query to appear on one line, so "step type" finds the line where
    // the two concepts actually meet — which a single-word search cannot.
    const technical = tokens.filter(isTechnical).slice(0, MAX_COMPOUND_SOURCES);
    for (const pair of pairsOf(technical)) {
      collected.push({ term: pair, origin: "focus-compound", weight: WEIGHTS.focusCompound, from: pair });
    }
  }

  // 2. The repository's own emphasis: what its documentation put in backticks or bold.
  const prose = (input.sources ?? []).filter((source) => source.type !== "tree" && source.type !== "metadata");
  for (const span of extractEmphasisSpans(prose.map((source) => source.text).join("\n"))) {
    const isPath = looksLikePath(span);
    for (const token of spanTokens(span)) {
      collected.push({
        term: token,
        origin: isPath ? "emphasis-path" : "emphasis",
        weight: isPath
          ? WEIGHTS.emphasisPath
          : isTechnical(token)
            ? WEIGHTS.emphasisTechnical
            : WEIGHTS.emphasisOther,
        from: span,
      });
    }
    // Only a prose span yields a compound. Pairing two segments of a path produces a
    // query that matches the path and nothing else — the tree already had that.
    if (isPath) continue;
    for (const pair of pairsOf(spanTokens(span).slice(0, MAX_COMPOUND_SOURCES))) {
      collected.push({ term: pair, origin: "emphasis-compound", weight: WEIGHTS.emphasisCompound, from: span });
    }
  }

  // 3. Concept names visible in the repository's own directory listing. A directory
  //    called `middleware/` is the repository telling you it has middleware.
  const tree = (input.sources ?? []).find((source) => source.type === "tree");
  if (tree) {
    for (const token of vocabularyIn(tree.text)) {
      collected.push({ term: token, origin: "path", weight: WEIGHTS.path, from: "tree" });
    }
  }

  // 4. Concept names anywhere in the prose. Weakest signal that is still a signal.
  for (const source of prose) {
    for (const token of vocabularyIn(source.text)) {
      collected.push({ term: token, origin: "vocabulary", weight: WEIGHTS.vocabulary, from: source.id });
    }
  }

  // 5. Synonyms, one level only, from everything gathered so far. This is the step
  //    that turns "dispatched by type" into a search for `registry`.
  for (const parent of [...collected]) {
    if (parent.term.includes(" ")) continue;
    const synonyms = SYNONYMS.get(parent.term);
    if (!synonyms) continue;
    for (const [index, synonym] of synonyms.slice(0, MAX_SYNONYMS_PER_TERM).entries()) {
      collected.push({
        term: synonym,
        origin: "synonym",
        weight: parent.weight - WEIGHTS.synonymPenalty - index,
        from: parent.term,
      });
    }
  }

  // 6. Fallback: a repository with no README, no emphasis and no recognisable
  //    directory names still gets scouted rather than skipped.
  if (collected.length === 0) {
    for (const seed of CONCEPT_SEEDS) {
      collected.push({ term: seed, origin: "seed", weight: WEIGHTS.seed, from: "seed" });
    }
  }

  return dedupe(collected, banned).slice(0, Math.max(input.max, 0));
}

/**
 * Keeps the highest-weighted occurrence of each term, then orders by weight and
 * breaks ties alphabetically. Both halves matter: without the tie-break, term
 * order would depend on the order the sources happened to be collected in.
 */
function dedupe(terms: readonly SearchTerm[], banned: ReadonlySet<string>): SearchTerm[] {
  const best = new Map<string, SearchTerm>();
  for (const candidate of terms) {
    // Any banned word disqualifies the whole term. `pyflow cli` would return every
    // file that mentions the repository's own name, which is most of them.
    if (candidate.term.split(" ").some((word) => banned.has(word))) continue;
    const existing = best.get(candidate.term);
    if (!existing || candidate.weight > existing.weight) best.set(candidate.term, candidate);
  }
  return [...best.values()].sort((a, b) => (b.weight - a.weight) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

/**
 * All unordered pairs, in input order. At most 3 for 3 inputs.
 *
 * Skips a pair whose words contain one another. `order.created` already tokenises to
 * itself plus `order` and `created`, and pairing those back together yields
 * `order.created order` — a query that is strictly narrower than `order.created` and
 * finds nothing it would not have found. On the orders-api fixture that redundancy
 * spent three of fourteen search slots on one event name.
 */
function pairsOf(tokens: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const left = tokens[i];
      const right = tokens[j];
      if (left === undefined || right === undefined) continue;
      if (left.includes(right) || right.includes(left)) continue;
      pairs.push(`${left} ${right}`);
    }
  }
  return pairs;
}

/**
 * Spans the author emphasised: `code`, **bold**, __bold__.
 *
 * Markdown emphasis is the cheapest reliable importance signal a repository
 * offers — it is the author pointing at what matters, already written down.
 */
export function extractEmphasisSpans(text: string): string[] {
  const pattern = /`([^`\n]{1,120})`|\*\*([^*\n]{1,120})\*\*|__([^_\n]{1,120})__/g;
  const spans: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const span = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (span !== "") spans.push(span);
    if (spans.length >= MAX_EMPHASIS_SPANS) break;
  }
  return spans;
}

/**
 * Tokens from one emphasised span.
 *
 * A span that is a path gets treated as a path: `src/middleware/auth.js` yields
 * `middleware` and `auth`, not `src` — which appears in every path here and would
 * spend a search returning the repository.
 */
function spanTokens(span: string): string[] {
  if (looksLikePath(span)) {
    const parts = span
      .split(/[/\\]/)
      .map(stripExtension)
      .flatMap((part) => tokenize(part))
      .filter((part) => !PATH_NOISE.has(part));
    return unique(parts.flatMap(normalizeTokens));
  }
  return unique(meaningfulTokens(span));
}

function looksLikePath(span: string): boolean {
  if (span.includes("/") || span.includes("\\")) return true;
  return PATH_EXTENSIONS.some((extension) => span.toLowerCase().endsWith(extension));
}

function stripExtension(part: string): string {
  const lower = part.toLowerCase();
  const extension = PATH_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return extension === undefined ? part : part.slice(0, -extension.length);
}

/** Known concept words present in a block of text, deduped and ordered. */
function vocabularyIn(text: string): string[] {
  const found = new Set<string>();
  for (const token of tokenize(text)) {
    for (const normalized of normalizeTokens(token)) {
      if (TECHNICAL_VOCABULARY.has(normalized)) found.add(normalized);
    }
  }
  return [...found].sort();
}

/** The prescribed pipeline: tokenise, drop stop words, normalise, drop again. */
export function meaningfulTokens(text: string): string[] {
  return unique(tokenize(text).flatMap(normalizeTokens));
}

/**
 * Splits on anything that is not a word character, a dot or a hyphen, so a dotted
 * identifier like `order.created` survives as one token.
 *
 * camelCase and PascalCase are split *before* case is folded — `PipelineError`
 * becomes `pipeline` and `error`, both useful searches, where folding first would
 * have produced the unsearchable `pipelineerror`. One hump rule only: a lowercase
 * or digit followed by an uppercase. Adding a second rule for runs of capitals
 * fixes `JWTSecret` and breaks `SQLite`, which is a bad trade.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_.-]+/)
    .flatMap((token) => token.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((token) => token.toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, ""))
    .filter((token) => token !== "");
}

/**
 * One raw token to zero or more search terms.
 *
 * Returns a list because a compound identifier is worth searching whole *and* in
 * parts: `order.created` is the strongest possible query for the event, and
 * `snake_case_name` is worth splitting when the whole thing appears once.
 */
export function normalizeTokens(raw: string): string[] {
  if (raw === "" || /^\d+$/.test(raw)) return [];

  // A dotted or underscored identifier is high signal as written, unless the tail
  // is a file extension — in which case it is a filename and the stem is the term.
  if (/[._]/.test(raw)) {
    const withoutExtension = stripExtension(raw);
    const parts = withoutExtension
      .split(/[._]+/)
      .filter((part) => part !== "" && !/^\d+$/.test(part))
      .flatMap((part) => keepIfMeaningful(part));
    // The whole dotted form is kept *verbatim*, never stemmed. `order.created` is a
    // literal event name and the most precise query available; suffix-stripping it to
    // `order.creat` would trade that precision for nothing, since substring matching
    // already makes the longer form match every occurrence.
    const whole = withoutExtension.includes(".") && !PATH_NOISE.has(withoutExtension)
      ? keepVerbatim(withoutExtension)
      : [];
    return unique([...whole, ...parts]);
  }

  return keepIfMeaningful(raw);
}

function keepVerbatim(token: string): string[] {
  const lower = token.toLowerCase();
  return lower.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(lower) ? [] : [lower];
}

function keepIfMeaningful(token: string): string[] {
  const lower = token.toLowerCase();
  if (lower.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(lower)) return [];
  const stemmed = stem(lower);
  if (stemmed.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(stemmed)) return [];
  return [stemmed];
}

/**
 * A four-rule suffix normaliser, not a stemmer.
 *
 * The job is only to make "dispatched" and "dispatch" the same search, so the rule
 * set stops where a real stemmer would begin. A token already in the technical
 * vocabulary is left alone, which is what keeps `class` from becoming `clas` and
 * `status` from becoming `statu` without a list of exceptions.
 */
export function stem(token: string): string {
  if (TECHNICAL_VOCABULARY.has(token)) return token;

  const prefer = (...candidates: readonly string[]): string | undefined =>
    candidates.find((candidate) => candidate.length >= MIN_TOKEN_LENGTH && TECHNICAL_VOCABULARY.has(candidate));

  if (token.endsWith("ies") && token.length >= 5) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("sses") && token.length >= 6) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length >= 5) {
    const dropS = token.slice(0, -1);
    const dropEs = token.endsWith("es") ? token.slice(0, -2) : undefined;
    return prefer(dropEs ?? "", dropS) ?? dropS;
  }
  if (token.endsWith("ing") && token.length >= 7) {
    const base = undouble(token.slice(0, -3));
    return prefer(base, `${base}e`) ?? base;
  }
  if (token.endsWith("ed") && token.length >= 6) {
    const base = undouble(token.slice(0, -2));
    return prefer(base, `${base}e`) ?? base;
  }
  return token;
}

/** "mapped" -> "mapp" -> "map". Only for a doubled final consonant. */
function undouble(base: string): string {
  const last = base.at(-1);
  const previous = base.at(-2);
  if (last !== undefined && last === previous && !"aeiou".includes(last) && base.length > MIN_TOKEN_LENGTH) {
    return base.slice(0, -1);
  }
  return base;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isTechnical(token: string): boolean {
  return TECHNICAL_VOCABULARY.has(token);
}
