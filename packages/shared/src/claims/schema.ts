import { z } from "zod";
import { EvidenceSchema } from "../schemas";

/**
 * Atomic, evidence-addressable claims.
 *
 * An atomic claim is one assertion, addressed to the evidence that establishes
 * it. It exists because the briefing's sections cannot express a fact that rests
 * on more than one place:
 *
 *  - a component claim describes one component
 *  - a dependency claim describes one dependency
 *  - a flow claim describes one flow
 *
 * A fact spanning two of those — "reserving stock is atomic", which is
 * `withTransaction` in `src/lib/db.js` *and* the per-line loop in
 * `src/services/inventory.js`; "these four dependencies are runtime and those
 * three are development", which is several entries of one manifest list — has no
 * section it fits in. The model can write it as prose in two places, and it does,
 * but then no single assertion carries both halves and no citation is attached to
 * the whole fact.
 *
 * So a claim here is deliberately *not* a section. It is a piece of text plus the
 * ids of the evidence it rests on, and it may rest on several. Grouping several
 * atomic claims into one composed claim is how a multi-source fact becomes one
 * assertion with all of its citations.
 *
 * Two properties this file is responsible for, both tested:
 *
 *  - **Addressability.** A claim names evidence by id. The ids must resolve
 *    against a ledger that was actually built from repository bytes, which is
 *    what makes `claim → evidence → file` a real chain rather than a formatting
 *    convention. A claim citing an id no ledger knows is an integrity failure,
 *    not a soft warning.
 *  - **Determinism.** Ids are derived from the claim's own content, so the same
 *    briefing produces the same ids on every run. Nothing about the caller, the
 *    clock, or the question being asked enters an id.
 */

/** Where a claim's subject sits in the briefing, so it can be materialized back. */
export const CLAIM_KINDS = ["component", "flow", "dependency", "testing", "risk", "overview"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const EvidenceRefSchema = z.object({
  /** Id of an entry in the claim set's evidence ledger. */
  evidenceId: z.string().min(1),
  /** Why this evidence bears on the claim. Prose, for a reader. */
  role: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const AtomicClaimSchema = z.object({
  /** Deterministic, content-derived. Stable within an analysis. */
  id: z.string().min(1),
  kind: z.enum(CLAIM_KINDS),
  /** The assertion itself, as one self-contained statement. */
  text: z.string().min(1),
  /** Evidence this claim rests on, by id. Empty means unsupported. */
  evidenceIds: z.array(z.string().min(1)).default([]),
  /** Subject of the claim — a component name, a dependency name, a flow name. */
  subject: z.string().optional(),
});
export type AtomicClaim = z.infer<typeof AtomicClaimSchema>;

/**
 * Several atomic claims asserted as one.
 *
 * The composition is the point: `text` states the whole fact, and `evidenceIds`
 * is the union of what its parts rest on. A composed claim spanning two files
 * carries citations to both, so an assertion about a two-file mechanism can be
 * evidenced as one thing.
 */
export const ComposedClaimSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CLAIM_KINDS),
  /** The composed assertion. Must stand alone without its parts. */
  text: z.string().min(1),
  /** Ids of the atomic claims this composes. At least two, or it is not a composition. */
  claimIds: z.array(z.string().min(1)).default([]),
  /** Union of the parts' evidence, plus any evidence for the composition itself. */
  evidenceIds: z.array(z.string().min(1)).default([]),
  subject: z.string().optional(),
});
export type ComposedClaim = z.infer<typeof ComposedClaimSchema>;

/**
 * A claim set: the ledger, the atomic claims, and the compositions over them.
 *
 * The ledger is keyed by id so a claim's `evidenceIds` resolve to real
 * `Evidence` — the same `Evidence` grounding verifies, not a parallel copy of it.
 */
export const ClaimSetSchema = z.object({
  evidence: z.record(z.string(), EvidenceSchema).default({}),
  claims: z.array(AtomicClaimSchema).default([]),
  composed: z.array(ComposedClaimSchema).default([]),
});
export type ClaimSet = z.infer<typeof ClaimSetSchema>;

export const EMPTY_CLAIM_SET: ClaimSet = { evidence: {}, claims: [], composed: [] };
