import { normalizeForMatch } from "../context-format";
import { composeClaims, withComposed } from "./build";
import type { AtomicClaim, ClaimKind, ClaimSet, ComposedClaim } from "./schema";

/**
 * Deciding which atomic claims to compose.
 *
 * This is the mechanism the iteration is testing, so it is worth being exact
 * about what it may and may not use.
 *
 * It may use: the claims' own kinds, subjects, texts and citations. That is all
 * derived from the briefing, which is derived from the repository.
 *
 * It may not use — and cannot, because none of it is in scope here: the
 * evaluation question, the expected answer, the expected evidence, a case id, a
 * category, or scorer notes. Composition is question-blind by construction. It
 * groups claims that are *about the same thing*, and that judgement is made from
 * the repository's own structure.
 *
 * Two grouping rules, both structural:
 *
 *  1. **Same-list composition.** Several claims of one kind that share a cited
 *     source form one claim about that list. The manifest lists dependencies; the
 *     dependencies claims individually name one package each; the composition
 *     names the set. Nothing about which packages, or which repository.
 *  2. **Shared-subject composition.** Claims of different kinds whose texts refer
 *     to each other's subjects describe one mechanism across files. A component
 *     that names another component's path, or a flow whose step names a
 *     component, is the same fact seen from two sides — composing them produces
 *     one assertion citing both files.
 *
 * Both rules are capped, because a composition of everything is a paragraph, not
 * a claim, and would make every keyword co-occur in one text regardless of
 * whether the briefing established the fact. The caps are the honesty constraint
 * on this mechanism and are asserted by test.
 */

/**
 * Most atomic claims a *cross-kind* composition may join.
 *
 * Beyond this it stops being one mechanism seen from several sides and becomes a
 * summary of the briefing, which is not a claim anyone can cite.
 *
 * A same-list composition is capped differently — by length, below — because
 * truncating a list is worse than not composing it: "taken together, these are the
 * dependencies" is false if a dependency was dropped to fit a cap. A list
 * composition is therefore all-or-nothing.
 */
export const MAX_COMPOSITION_PARTS = 6;
/** Most compositions a briefing may carry, so the claim set cannot be padded. */
export const MAX_COMPOSITIONS = 8;
/**
 * Longest a composed claim may be.
 *
 * A claim nobody will read is not worth the citations it carries, and an
 * arbitrarily long one would make every keyword in the briefing co-occur in a
 * single text — which would make the composition look informative without
 * asserting anything. Compositions over this are dropped, not trimmed.
 */
export const MAX_COMPOSITION_CHARS = 2_000;
/** A subject shorter than this matches too much text to mean anything. */
const MIN_SUBJECT_LENGTH = 4;

const LIST_KINDS: readonly ClaimKind[] = ["dependency", "component", "flow", "risk"];

export function composeClaimSet(set: ClaimSet): ClaimSet {
  const composed: ComposedClaim[] = [];

  for (const group of [...sameListGroups(set), ...sharedSubjectGroups(set)]) {
    if (composed.length >= MAX_COMPOSITIONS) break;

    const text = composedText(group.kind, group.parts);
    // Dropped rather than trimmed: a shortened composition asserts something its
    // parts do not, and there is no honest way to say "these are the entries" while
    // omitting one of them.
    if (text.length > MAX_COMPOSITION_CHARS) continue;

    composed.push(
      composeClaims(set, {
        kind: group.kind,
        text,
        claimIds: group.parts.map((part) => part.id),
        subject: group.subject,
      }),
    );
  }

  return withComposed(set, composed);
}

interface Group {
  kind: ClaimKind;
  subject: string;
  parts: AtomicClaim[];
}

/**
 * Claims of one kind that cite a common source.
 *
 * Grouping by cited source rather than by kind alone is what keeps this
 * meaningful: two dependencies both read out of one manifest belong to one list,
 * and two components in unrelated files do not.
 */
function sameListGroups(set: ClaimSet): Group[] {
  const claims = set.claims;
  const groups: Group[] = [];

  for (const kind of LIST_KINDS) {
    const ofKind = claims.filter((claim) => claim.kind === kind);
    if (ofKind.length < 2) continue;

    // Bucketed by cited *artefact*, not by citation. Two dependencies each quoting
    // their own line of one manifest are two citations of one file, and it is the
    // file that makes them one list.
    const bySource = new Map<string, AtomicClaim[]>();
    for (const claim of ofKind) {
      const artefacts = new Set(
        claim.evidenceIds.map((id) => sourceOf(set, id)).filter((source): source is string => source !== undefined),
      );
      for (const artefact of artefacts) {
        const bucket = bySource.get(artefact) ?? [];
        bucket.push(claim);
        bySource.set(artefact, bucket);
      }
    }

    // The source shared by the most claims of this kind is the list's own source.
    const ranked = [...bySource.entries()]
      .filter(([, bucket]) => bucket.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    const first = ranked[0];
    if (first === undefined) continue;

    // Every claim in the bucket, or none. A list composition asserts "taken
    // together, these are the entries drawn from this artefact"; dropping one to fit
    // a cap would make that assertion false. Length is bounded instead, by the
    // caller, which drops an over-long composition rather than truncating it.
    groups.push({ kind, subject: `${kind} set`, parts: [...first[1]] });
  }

  return groups;
}

/**
 * Claims whose texts name each other's subjects.
 *
 * Deliberately narrow: one claim's text must contain another claim's subject, and
 * both must be substantial enough that the match is not incidental. That is a
 * cross-reference the model itself wrote, which is why it can be read as
 * "these two claims are about one mechanism" without asking a model again.
 */
function sharedSubjectGroups(set: ClaimSet): Group[] {
  // Every claim with a subject is a candidate. The length floor lives in `mentions`,
  // where it belongs: a claim whose own subject is too short to match on can still be
  // the claim that *names* another one, and excluding it here would lose that
  // direction of the cross-reference entirely.
  const subjects = set.claims.filter((claim) => claim.subject !== undefined && claim.subject.trim() !== "");
  const groups: Group[] = [];
  const used = new Set<string>();

  for (const claim of subjects) {
    if (used.has(claim.id)) continue;

    const related = subjects.filter((other) => {
      if (other.id === claim.id) return false;
      if (used.has(other.id)) return false;
      if (other.kind === claim.kind) return false;
      return mentions(other.text, claim.subject) || mentions(claim.text, other.subject);
    });
    if (related.length === 0) continue;

    const parts = [claim, ...related].slice(0, MAX_COMPOSITION_PARTS);
    // A composition whose parts all cite the same single source adds nothing: the
    // point of composing across kinds is to carry citations to more than one place.
    if (distinctSources(set, parts) < 2) continue;

    for (const part of parts) used.add(part.id);
    groups.push({ kind: claim.kind, subject: claim.subject ?? "", parts });
  }

  return groups;
}

/** The artefact a claim-evidence id points at, or undefined if the ledger lacks it. */
function sourceOf(set: ClaimSet, id: string): string | undefined {
  return set.evidence[id]?.source;
}

function distinctSources(set: ClaimSet, parts: readonly AtomicClaim[]): number {
  const artefacts = new Set<string>();
  for (const part of parts) {
    for (const id of part.evidenceIds) {
      const source = sourceOf(set, id);
      if (source !== undefined) artefacts.add(source);
    }
  }
  return artefacts.size;
}

function mentions(text: string, subject: string | undefined): boolean {
  if (subject === undefined || subject.trim().length < MIN_SUBJECT_LENGTH) return false;
  return normalizeForMatch(text).includes(normalizeForMatch(subject));
}

/**
 * The composed assertion's text.
 *
 * It is the parts' own texts, joined. That is the conservative choice and the
 * only one available without a second model call: the composition asserts exactly
 * what its parts assert, together, and adds no words of its own beyond a lead-in
 * naming what is being composed. It cannot therefore claim more than the briefing
 * did.
 */
function composedText(kind: ClaimKind, parts: readonly AtomicClaim[]): string {
  return [`Taken together (${kind}):`, ...parts.map((part) => part.text)].join(" ");
}
