import { normalizeForMatch, type AnalysisResult, type Evidence } from "@repo-arch/shared";
import type { AnswerField } from "./case-schema";

/**
 * Deterministic matching primitives.
 *
 * All of it is normalised substring and set logic. Nothing here calls a model,
 * so the same briefing always produces the same score.
 */

/**
 * One assertion in the briefing, paired with the evidence offered for it.
 *
 * Scoring works over claims rather than over the whole document, so that
 * "the answer is correct" and "the evidence supports *that* answer" stay
 * separate questions — a briefing cannot pass by putting the right conclusion in
 * one paragraph and an unrelated citation in another.
 */
export interface Claim {
  field: Exclude<AnswerField, "any">;
  text: string;
  evidence: Evidence[];
}

export function selectClaims(result: AnalysisResult, field: AnswerField): Claim[] {
  const claims: Claim[] = [];
  const want = (candidate: Exclude<AnswerField, "any">): boolean => field === "any" || field === candidate;

  // Summary and architecture are prose backed by the top-level evidence pool.
  if (want("summary")) {
    claims.push({ field: "summary", text: result.summary, evidence: result.evidence });
  }
  if (want("architecture")) {
    claims.push({ field: "architecture", text: result.architecture, evidence: result.evidence });
  }
  if (want("components")) {
    for (const component of result.components) {
      claims.push({
        field: "components",
        text: [component.name, component.path ?? "", component.responsibility].join(" \n "),
        evidence: component.evidence,
      });
    }
  }
  if (want("flows")) {
    for (const flow of result.flows) {
      claims.push({
        field: "flows",
        text: [flow.name, flow.description, ...flow.steps].join(" \n "),
        evidence: flow.evidence,
      });
    }
  }
  if (want("dependencies")) {
    for (const dependency of result.dependencies) {
      claims.push({
        field: "dependencies",
        text: [dependency.name, dependency.version ?? "", dependency.scope, dependency.purpose ?? ""].join(" \n "),
        evidence: dependency.evidence,
      });
    }
  }
  if (want("testing")) {
    claims.push({
      field: "testing",
      text: [
        result.testing.approach,
        ...result.testing.frameworks,
        ...result.testing.testPaths,
        ...result.testing.gaps,
      ].join(" \n "),
      evidence: result.testing.evidence,
    });
  }
  if (want("risks")) {
    for (const risk of result.risks) {
      claims.push({
        field: "risks",
        text: [risk.title, risk.description, risk.severity].join(" \n "),
        evidence: risk.evidence,
      });
    }
  }
  // Reading order and open questions carry no evidence by design, so they can be
  // scored for correctness but never for evidence-backing.
  if (want("recommendedReading")) {
    for (const item of result.recommendedReading) {
      claims.push({ field: "recommendedReading", text: [item.path, item.reason].join(" \n "), evidence: [] });
    }
  }
  if (want("openQuestions")) {
    for (const question of result.openQuestions) {
      claims.push({ field: "openQuestions", text: question, evidence: [] });
    }
  }

  return claims;
}

export interface KeywordRequirement {
  expectedKeywords: readonly string[];
  anyOfKeywords: readonly (readonly string[])[];
}

/** True when the text satisfies every required keyword and at least one alternative group. */
export function satisfiesKeywords(text: string, requirement: KeywordRequirement): boolean {
  const haystack = normalizeForMatch(text);
  const contains = (keyword: string): boolean => haystack.includes(normalizeForMatch(keyword));

  if (!requirement.expectedKeywords.every(contains)) return false;
  if (requirement.anyOfKeywords.length === 0) return true;
  return requirement.anyOfKeywords.some((group) => group.every(contains));
}

/** Keywords present in the text — reported so a failure says which one was missing. */
export function matchedKeywords(text: string, keywords: readonly string[]): string[] {
  const haystack = normalizeForMatch(text);
  return keywords.filter((keyword) => haystack.includes(normalizeForMatch(keyword)));
}

/**
 * How strongly a citation supports a claim about a specific location.
 *
 *  - `content`   — the cited artefact carries that location's actual content, so
 *                  the citation can support a claim about what the code *does*.
 *  - `existence` — the artefact only proves the location exists (a directory
 *                  tree, a file count). Partial credit: real, but not enough.
 */
export type EvidenceStrength = "content" | "existence";

/** Evidence kinds whose text is the cited artefact's own content. */
const CONTENT_TYPES = new Set(["readme", "manifest", "file", "git", "test", "command", "dependency"]);
const EXISTENCE_TYPES = new Set(["tree", "metadata"]);

export function evidenceStrengthFor(item: Evidence, expected: string): EvidenceStrength | null {
  const target = normalizePath(expected);
  const source = normalizePath(item.source);
  const location = item.location === undefined ? "" : normalizePath(item.location);

  // The cited artefact *is* the expected file: its content is in context.
  if (pathMatches(source, target)) return "content";

  // A tool-derived citation that names the expected path inside itself.
  if (CONTENT_TYPES.has(item.type) && location !== "" && pathMatches(location, target)) return "content";

  // The tree or the metadata block mentioning the path proves only that it exists.
  if (EXISTENCE_TYPES.has(item.type)) {
    if (location !== "" && pathMatches(location, target)) return "existence";
    // A tree citation with no location still points at the listing as a whole.
    if (location === "" && target.includes("/")) return null;
  }

  return null;
}

/** The best strength any citation reaches for any of the expected locations. */
export function bestEvidenceStrength(
  evidence: readonly Evidence[],
  expectedEvidence: readonly string[],
): EvidenceStrength | null {
  let best: EvidenceStrength | null = null;
  for (const item of evidence) {
    for (const expected of expectedEvidence) {
      const strength = evidenceStrengthFor(item, expected);
      if (strength === "content") return "content";
      if (strength === "existence") best = "existence";
    }
  }
  return best;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * Path equality that tolerates the ways a model may write the same location:
 * a bare basename, a repo-relative path, or a directory prefix.
 */
function pathMatches(candidate: string, target: string): boolean {
  if (candidate === "" || target === "") return false;
  if (candidate === target) return true;

  // Directory expectation ("src/auth/") matches anything beneath it.
  if (target.endsWith("/")) return candidate.startsWith(target) || `${candidate}/`.startsWith(target);

  if (candidate.endsWith(`/${target}`)) return true;
  if (target.endsWith(`/${candidate}`) && basename(candidate) === basename(target)) return true;

  // A location may quote a path with a suffix, e.g. "src/app.js:12" or "src/app.js (route table)".
  return candidate.startsWith(`${target}:`) || candidate.startsWith(`${target} `);
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}
