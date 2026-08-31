import type { ContextSourceText } from "../context-format";
import { readFileTool } from "../tools/read";
import { searchCode } from "../tools/search";
import type { ToolContext } from "../tools/types";
import { parseSearchHits, rankCandidates, type ScoutCandidate, type SearchHit } from "./rank";
import { extractSearchTerms, type SearchTerm, type TermOrigin } from "./terms";

/**
 * The Evidence Scout: a deterministic search pass that runs *before* the model
 * gets a turn.
 *
 * Iteration 1 gave the agent three tools and let it decide. Across two evaluation
 * cases it made seven tool calls, all seven were `read_file`, and it never searched
 * for anything — including on the question that motivated the whole iteration,
 * where the answer was one `search_code("registry")` away. An agent that *can*
 * search is not the same as one that *does*.
 *
 * So the search stops being optional. Term extraction, searching, ranking and
 * reading all happen here, with no model in the loop, and the results are in the
 * prompt before the first turn. The model keeps its tools and can still explore —
 * this is a floor on the evidence, not a ceiling.
 *
 * Three properties this phase is built to hold:
 *
 *   1. It goes through the same tools the model uses. `searchCode` and
 *      `readFileTool` are called unmodified, with the same `ToolContext`, so the
 *      repository boundary, the size limits and the refusals all apply unchanged.
 *      The scout cannot reach anything the model could not have reached itself.
 *   2. Its reads enter the evidence ledger through `recordAll`, the same single
 *      door as every other tool result. Nothing new can become citable.
 *   3. It is deterministic. Same repository, same terms, same searches, same files,
 *      same order — which is what makes an A/B measurement mean something.
 */

export interface ScoutInput {
  /**
   * A question to scout for, when the caller has one. Reaches the CLI as `--focus`.
   *
   * Not supplied during evaluation, deliberately: the harness never shows a system
   * the questions it is scored on, and giving the advanced system the question
   * while the baseline answers blind would be measuring the answer key. Without it
   * the scout works from the repository's own documentation instead.
   */
  focus?: string | undefined;
  /** Reconnaissance sources, read-only. The scout mines them; it never alters them. */
  sources: readonly ContextSourceText[];
  repositoryName: string;
}

/** One search the scout performed, and what it returned. */
export interface ScoutSearch {
  term: string;
  origin: TermOrigin;
  weight: number;
  filesWithMatches: number;
  totalMatches: number;
}

/** One file the scout read, and where in it. */
export interface ScoutRead {
  path: string;
  rank: number;
  score: number;
  matchedTerms: string[];
  startLine: number;
  endLine: number;
  bytes: number;
  truncated: boolean;
}

export interface ScoutSummary {
  termsExtracted: number;
  searches: number;
  searchesWithMatches: number;
  candidates: number;
  filesRead: number;
  bytesRead: number;
  /** True when ranked candidates were left unread because the file budget ran out. */
  candidatesSkipped: number;
}

export interface ScoutResult {
  terms: SearchTerm[];
  searches: ScoutSearch[];
  /**
   * Every ranked candidate, not just the ones read. What the scout *considered* and
   * rejected is the part of its reasoning a reader cannot reconstruct afterwards,
   * and it is what makes a bad read reviewable: the trajectory shows the file that
   * should have won and the score that kept it out.
   */
  candidates: ScoutCandidate[];
  reads: ScoutRead[];
  /** Ledger entries. Raw slices, exactly as `read_file` produced them. */
  artifacts: ContextSourceText[];
  /** The prompt section, or `""` when the scout found nothing worth reading. */
  evidence: string;
  summary: ScoutSummary;
}

/** Where a read starts when the first match sits past the line budget. */
const CONTEXT_LINES_BEFORE_MATCH = 20;

export function runEvidenceScout(context: ToolContext, input: ScoutInput): ScoutResult {
  const { budget } = context;

  const terms = extractSearchTerms({
    focus: input.focus,
    sources: input.sources,
    repositoryName: input.repositoryName,
    max: budget.maxScoutTerms,
  });

  const searches: ScoutSearch[] = [];
  const hits: SearchHit[] = [];
  for (const term of terms.slice(0, budget.maxScoutSearches)) {
    const outcome = searchCode(context, { query: term.term });
    // A refused or empty search is a fact about the repository, not a failure.
    // It is recorded and the scan continues; one dead term must not end the phase.
    const found = outcome.isError ? [] : parseSearchHits(outcome.output, term.term);
    hits.push(...found);
    searches.push({
      term: term.term,
      origin: term.origin,
      weight: term.weight,
      filesWithMatches: new Set(found.map((hit) => hit.path)).size,
      totalMatches: found.length,
    });
  }

  const allCandidates = rankCandidates(hits, terms, {
    // Reconnaissance already put these in the prompt. Reading them again would spend
    // a scout slot to duplicate bytes the model can already see.
    exclude: input.sources.filter((source) => source.type !== "tree").map((source) => source.id),
    max: Number.MAX_SAFE_INTEGER,
  });
  const selected = allCandidates.slice(0, Math.max(budget.maxScoutFiles, 0));

  const reads: ScoutRead[] = [];
  const artifacts: ContextSourceText[] = [];
  const blocks: string[] = [];

  for (const [index, candidate] of selected.entries()) {
    const start = startLineFor(candidate, budget.maxFileLines);
    const outcome = readFileTool(context, { path: candidate.path, startLine: start });
    if (outcome.isError) continue;

    const artifact = outcome.artifacts[0];
    if (!artifact) continue;
    artifacts.push(artifact);

    const summary = outcome.summary;
    reads.push({
      path: candidate.path,
      rank: index + 1,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
      startLine: numberFrom(summary["startLine"], start),
      endLine: numberFrom(summary["endLine"], start),
      bytes: artifact.bytes,
      truncated: artifact.truncated,
    });
    blocks.push(renderScoutBlock(candidate, outcome.output));
  }

  return {
    terms,
    searches,
    candidates: allCandidates,
    reads,
    artifacts,
    evidence: blocks.length === 0 ? "" : renderScoutSection(terms, blocks),
    summary: {
      termsExtracted: terms.length,
      searches: searches.length,
      searchesWithMatches: searches.filter((search) => search.totalMatches > 0).length,
      candidates: allCandidates.length,
      filesRead: reads.length,
      bytesRead: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
      candidatesSkipped: Math.max(allCandidates.length - selected.length, 0),
    },
  };
}

/**
 * Where to start reading.
 *
 * From the top normally — a file's imports and its first definitions are usually
 * the orientation a reader wants. But when every match sits past the line budget,
 * starting at line 1 would return a window that provably does not contain what the
 * search found, so the window moves to the first match with a little context above it.
 */
function startLineFor(candidate: ScoutCandidate, maxFileLines: number): number {
  const first = candidate.matchedLines[0];
  if (first === undefined || first <= maxFileLines) return 1;
  return Math.max(1, first - CONTEXT_LINES_BEFORE_MATCH);
}

/**
 * The prompt section carrying scout findings.
 *
 * Appended to the reconnaissance prompt, never substituted for it. Iteration 1's
 * second failure was exactly that substitution: the agent went deep on one file and
 * dropped high-level facts the baseline had stated plainly, losing a question the
 * baseline got right. Reconnaissance is the breadth; this is the depth; the model
 * gets both.
 *
 * A deliberately distinct delimiter, not the `### SOURCE:` blocks reconnaissance
 * uses. Those are parsed elsewhere, and the text here is line-numbered — mixing the
 * two would put gutter markers into a source the grounding step then checks
 * quotations against, and truthful citations would be dropped for having the wrong
 * whitespace.
 */
function renderScoutSection(terms: readonly SearchTerm[], blocks: readonly string[]): string {
  const searched = terms.map((term) => `\`${term.term}\``).join(", ");
  return [
    "## Evidence found by repository search",
    "",
    "Before this turn the repository was searched for terms derived from its own documentation" +
      " and structure, the matching files were ranked, and the highest-scoring ones were read.",
    "",
    `Terms searched: ${searched}`,
    "",
    "Each block below is the verbatim output of a `read_file` call that has already been made." +
      " These files are already in your evidence: cite them by the path in the heading, and do" +
      " not spend a tool call re-reading one. This is a starting point, not a complete answer —" +
      " search and read further when the question you are answering needs more.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

function renderScoutBlock(candidate: ScoutCandidate, output: string): string {
  const matched = candidate.matchedTerms.join(", ");
  return [
    `### SCOUT EVIDENCE: ${candidate.path} (matched: ${matched})`,
    output,
    "### END SCOUT EVIDENCE",
  ].join("\n");
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
