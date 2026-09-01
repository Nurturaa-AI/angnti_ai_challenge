import { normalizeForMatch, type ContextSourceText } from "./context-format";
import type { AnalysisBody, Evidence, EvidenceAudit } from "./schemas";

/**
 * Evidence grounding — the mechanism behind the product's central claim.
 *
 * A model can name any file it likes. Grounding checks each citation against the
 * context the system actually received:
 *
 *   1. the cited `source` must be an artefact that was in context
 *   2. if an `excerpt` is given, that text must really appear in that artefact
 *
 * Citations that fail are removed from the result and recorded in the audit, so
 * a briefing cannot contain evidence the system never saw. Claims left with no
 * surviving evidence are counted as unsupported rather than quietly deleted —
 * an unsupported claim is a finding about the system, not something to hide.
 */

/** Excerpts shorter than this are not worth verifying; "src" matches everything. */
const MIN_VERIFIABLE_EXCERPT = 8;

export interface GroundingResult {
  body: AnalysisBody;
  audit: EvidenceAudit;
}

export function groundAnalysis(body: AnalysisBody, sources: readonly ContextSourceText[]): GroundingResult {
  const index = buildSourceIndex(sources);
  const dropped: EvidenceAudit["dropped"] = [];
  let claimed = 0;
  let grounded = 0;

  const check = (items: readonly Evidence[]): Evidence[] => {
    const kept: Evidence[] = [];
    for (const item of items) {
      claimed += 1;
      const verdict = verify(item, index);
      if (verdict.grounded) {
        grounded += 1;
        kept.push({ ...item, grounded: true });
      } else {
        dropped.push({ source: item.source, reason: verdict.reason });
      }
    }
    return kept;
  };

  const groundedBody: AnalysisBody = {
    ...body,
    components: body.components.map((component) => ({ ...component, evidence: check(component.evidence) })),
    flows: body.flows.map((flow) => ({ ...flow, evidence: check(flow.evidence) })),
    dependencies: body.dependencies.map((dependency) => ({ ...dependency, evidence: check(dependency.evidence) })),
    testing: { ...body.testing, evidence: check(body.testing.evidence) },
    risks: body.risks.map((risk) => ({ ...risk, evidence: check(risk.evidence) })),
    evidence: check(body.evidence),
  };

  return {
    body: groundedBody,
    audit: {
      claimed,
      grounded,
      dropped,
      unsupportedClaims: countUnsupportedClaims(groundedBody),
    },
  };
}

/**
 * Claims with zero surviving evidence. `testing` counts as one claim; the
 * top-level `evidence` pool is not a claim and is excluded.
 */
export function countUnsupportedClaims(body: AnalysisBody): number {
  let count = 0;
  for (const component of body.components) if (component.evidence.length === 0) count += 1;
  for (const flow of body.flows) if (flow.evidence.length === 0) count += 1;
  for (const dependency of body.dependencies) if (dependency.evidence.length === 0) count += 1;
  for (const risk of body.risks) if (risk.evidence.length === 0) count += 1;
  if (body.testing.evidence.length === 0) count += 1;
  return count;
}

/** Total number of claim-bearing entities, for computing a rate. */
export function countClaims(body: AnalysisBody): number {
  return body.components.length + body.flows.length + body.dependencies.length + body.risks.length + 1;
}

/**
 * A reusable "would this citation survive grounding?" predicate over one set of
 * sources.
 *
 * Exported so that a caller running *before* `groundAnalysis` can ask the question
 * without answering it differently: the predicate is the same `verify` the grounding
 * layer uses, so the two can never drift into disagreeing about what the ledger
 * proves. It builds the source index once, which is why it returns a function rather
 * than taking a citation directly.
 *
 * It reports; it does not act. Dropping a citation and recording why remains
 * `groundAnalysis`'s job alone.
 */
export function createCitationVerifier(
  sources: readonly ContextSourceText[],
): (item: Evidence) => boolean {
  const index = buildSourceIndex(sources);
  return (item: Evidence): boolean => verify(item, index).grounded;
}

/**
 * The same source lookup grounding uses, exposed on its own.
 *
 * A citation's `source` is what the *model* wrote, and grounding accepts three
 * spellings of the same artefact — the exact id, a case-insensitive match, and a
 * bare basename. So a later layer that wants to know *which ledger artefact* a
 * surviving citation refers to — to show its text, or to count citations per
 * source — cannot simply compare strings: it would fail to link exactly the
 * citations grounding chose to accept.
 *
 * Exported for the same reason as `createCitationVerifier`: one resolver means the
 * layer that displays evidence and the layer that verifies it cannot disagree about
 * what a citation points at.
 */
export function createSourceResolver(
  sources: readonly ContextSourceText[],
): (source: string) => ContextSourceText | undefined {
  const index = buildSourceIndex(sources);
  return (source: string): ContextSourceText | undefined => resolveSource(source, index);
}

interface SourceIndex {
  byId: Map<string, ContextSourceText>;
  byLowerId: Map<string, ContextSourceText>;
  byBasename: Map<string, ContextSourceText>;
}

function buildSourceIndex(sources: readonly ContextSourceText[]): SourceIndex {
  const index: SourceIndex = { byId: new Map(), byLowerId: new Map(), byBasename: new Map() };
  for (const source of sources) {
    index.byId.set(source.id, source);
    index.byLowerId.set(source.id.toLowerCase(), source);
    const basename = source.id.slice(source.id.lastIndexOf("/") + 1).toLowerCase();
    if (!index.byBasename.has(basename)) index.byBasename.set(basename, source);
  }
  return index;
}

function resolveSource(rawSource: string, index: SourceIndex): ContextSourceText | undefined {
  const trimmed = rawSource.trim().replace(/^\.\//, "");
  return (
    index.byId.get(trimmed) ??
    index.byLowerId.get(trimmed.toLowerCase()) ??
    index.byBasename.get(trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase())
  );
}

function verify(item: Evidence, index: SourceIndex): { grounded: true } | { grounded: false; reason: string } {
  const source = resolveSource(item.source, index);
  if (!source) {
    return {
      grounded: false,
      reason: `source-not-in-context: the system never received "${item.source}"`,
    };
  }

  if (item.excerpt !== undefined && item.excerpt.trim().length >= MIN_VERIFIABLE_EXCERPT) {
    const haystack = normalizeForMatch(source.text);
    const needle = normalizeForMatch(item.excerpt);
    if (!haystack.includes(needle)) {
      return {
        grounded: false,
        reason: source.truncated
          ? `excerpt-not-found: not present in the retained portion of "${source.id}" (truncated)`
          : `excerpt-not-found: quoted text does not appear in "${source.id}"`,
      };
    }
  }

  return { grounded: true };
}
