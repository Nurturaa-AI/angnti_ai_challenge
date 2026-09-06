import type { ClaimSet } from "./schema";

/**
 * Integrity of a claim set.
 *
 * A claim representation is only worth having if its addresses resolve. These are
 * the ways they can fail to, each reported rather than thrown, so a caller can
 * record a broken set as a finding instead of losing the whole analysis to it:
 *
 *  - a claim citing an evidence id the ledger does not hold — the address points
 *    nowhere, so the claim's support cannot be checked
 *  - two claims sharing an id — an address that resolves to two things
 *  - a composed claim naming an atomic claim that does not exist — an orphan
 *  - a composed claim citing evidence none of its parts cite — evidence appearing
 *    from outside the composition, which is how a claim would acquire support its
 *    parts never had
 *
 * A claim with no evidence at all is *not* an integrity failure. It is an
 * unsupported claim, which this system reports rather than hides.
 */

export interface ClaimIntegrityIssue {
  kind: "unknown-evidence" | "duplicate-claim-id" | "orphaned-composition" | "composition-evidence-escape";
  claimId: string;
  detail: string;
}

export interface ClaimIntegrityReport {
  ok: boolean;
  issues: ClaimIntegrityIssue[];
  /** Claims with no surviving evidence. Reported, not an error. */
  unsupportedClaimIds: string[];
}

export function checkClaimIntegrity(set: ClaimSet): ClaimIntegrityReport {
  const issues: ClaimIntegrityIssue[] = [];
  const unsupportedClaimIds: string[] = [];
  const seen = new Set<string>();
  const byId = new Map<string, (typeof set.claims)[number]>();

  for (const claim of set.claims) {
    if (seen.has(claim.id)) {
      issues.push({
        kind: "duplicate-claim-id",
        claimId: claim.id,
        detail: `claim id "${claim.id}" is used more than once`,
      });
    }
    seen.add(claim.id);
    byId.set(claim.id, claim);

    for (const id of claim.evidenceIds) {
      if (set.evidence[id] === undefined) {
        issues.push({
          kind: "unknown-evidence",
          claimId: claim.id,
          detail: `cites evidence "${id}", which is not in the ledger`,
        });
      }
    }

    if (claim.evidenceIds.length === 0) unsupportedClaimIds.push(claim.id);
  }

  for (const composed of set.composed) {
    if (seen.has(composed.id)) {
      issues.push({
        kind: "duplicate-claim-id",
        claimId: composed.id,
        detail: `composed claim id "${composed.id}" collides with another claim`,
      });
    }
    seen.add(composed.id);

    const partEvidence = new Set<string>();
    for (const partId of composed.claimIds) {
      const part = byId.get(partId);
      if (part === undefined) {
        issues.push({
          kind: "orphaned-composition",
          claimId: composed.id,
          detail: `composes "${partId}", which is not an atomic claim in this set`,
        });
        continue;
      }
      for (const id of part.evidenceIds) partEvidence.add(id);
    }

    for (const id of composed.evidenceIds) {
      if (set.evidence[id] === undefined) {
        issues.push({
          kind: "unknown-evidence",
          claimId: composed.id,
          detail: `cites evidence "${id}", which is not in the ledger`,
        });
        continue;
      }
      if (!partEvidence.has(id)) {
        issues.push({
          kind: "composition-evidence-escape",
          claimId: composed.id,
          detail: `cites evidence "${id}", which none of its parts cite`,
        });
      }
    }

    if (composed.evidenceIds.length === 0) unsupportedClaimIds.push(composed.id);
  }

  return { ok: issues.length === 0, issues, unsupportedClaimIds };
}
