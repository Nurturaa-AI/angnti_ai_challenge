import { redactSecrets, type ContextSourceText } from "@repo-arch/shared";
import { RECONNAISSANCE_TYPES, type AnsweredQuestionView } from "../questions";
import type { AnalysisReport } from "../report";
import type { StoredEvidenceSource } from "./types";

/**
 * What the product persists, and why it is a projection rather than a dump.
 *
 * A `RunRecord` is a runtime object: it carries the model's prose, every tool
 * call's raw result, the prompts, and an absolute repository root. Serialising
 * it would be the shortest path to a durable store and the shortest path to a
 * leak, because from then on every consumer would have to remember to strip the
 * same four things. So the store takes a projection instead, and the projection
 * is defined by two questions:
 *
 *  1. **Does the product need this to answer a question after a restart?**
 *     `answerQuestion` seeds each question's ledger from the reconnaissance
 *     artefacts and nothing else, so those four have to survive.
 *  2. **Does the product need this to show an evidence excerpt?** The evidence
 *     viewer resolves an evidence id to a source and displays that source's
 *     text, so a source some citation points at has to survive.
 *
 * Everything else is dropped: the trajectory, the prompts, the model text, the
 * absolute root, and any ledger artefact nothing cites. An uncited scout read
 * still appears in `report.sources` as a row of metadata — that is a claim about
 * what was inspected, and it needs no bytes to make it.
 */

/**
 * Selects the evidence sources worth persisting and redacts them.
 *
 * Redaction happens *here*, on the way in, rather than only on the way out. Two
 * reasons, and the second is the one that matters:
 *
 *  - A restart must not change what the product shows. If the in-memory copy
 *    were raw and the stored copy redacted, an excerpt would render differently
 *    before and after a restart, which is exactly the kind of difference nobody
 *    notices until it is load-bearing.
 *  - The evidence viewer reports a line range and a character offset computed
 *    against the text it displays. Redacting *after* computing them would shift
 *    every offset past the first replacement. Redacting first means the offsets
 *    are correct by construction.
 *
 * This is downstream of everything measured: the ledger the pipeline grounds
 * against is the raw one, and this copy is taken after grounding has finished.
 * Grounding has to compare an excerpt with what the file really says, so the
 * ledger itself can never hold redacted text.
 */
export function projectEvidence(
  sources: readonly ContextSourceText[],
  report: AnalysisReport | null,
  questions: readonly AnsweredQuestionView[] = [],
): StoredEvidenceSource[] {
  const cited = citedSourceIds(report, questions);
  const projected: StoredEvidenceSource[] = [];

  for (const source of sources) {
    if (!RECONNAISSANCE_TYPES.has(source.type) && !cited.has(source.id)) continue;
    const text = redactSecrets(source.text);
    projected.push({
      id: source.id,
      type: source.type,
      text,
      // Recomputed, because redaction changes the length. The stored number
      // describes the stored text; the report's own `bytes` still describes what
      // was read, and the two are allowed to differ.
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: source.truncated,
    });
  }

  return projected;
}

/**
 * Adds one answered question's newly-read artefacts to the stored set.
 *
 * The same rule as `projectEvidence`, applied incrementally: an artefact this
 * answer cites has to be showable in the evidence viewer, so its redacted text is
 * kept; an artefact the question read without citing is a row in the answer's
 * `inspectedSources` and needs no bytes to say so.
 *
 * Existing rows are never rewritten. An id already in the store was projected when
 * the analysis finished and its text is the text whose offsets the viewer has
 * already computed against — replacing it with a fresh read would let a file
 * edited since the analysis make a grounded citation look wrong.
 */
export function mergeQuestionEvidence(
  stored: readonly StoredEvidenceSource[],
  newSources: readonly ContextSourceText[],
  question: AnsweredQuestionView,
): StoredEvidenceSource[] {
  const cited = citedSourceIds(null, [question]);
  const known = new Set(stored.map((source) => source.id));
  const merged = [...stored];

  for (const source of newSources) {
    if (known.has(source.id)) continue;
    if (!RECONNAISSANCE_TYPES.has(source.type) && !cited.has(source.id)) continue;
    const text = redactSecrets(source.text);
    known.add(source.id);
    merged.push({
      id: source.id,
      type: source.type,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: source.truncated,
    });
  }

  return merged;
}

/** Every ledger id some citation resolves to, from the report and every answer. */
function citedSourceIds(
  report: AnalysisReport | null,
  questions: readonly AnsweredQuestionView[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of report?.evidence ?? []) {
    if (item.sourceId !== null) ids.add(item.sourceId);
  }
  for (const question of questions) {
    for (const citation of question.citations) {
      if (citation.sourceId !== null) ids.add(citation.sourceId);
    }
  }
  return ids;
}

/**
 * Restores the shape `answerQuestion` and the grounding layer expect.
 *
 * A stored evidence source *is* a `ContextSourceText`; this exists so the
 * conversion is a named, single place rather than an implicit structural match
 * that a later field addition would break silently.
 */
export function toContextSources(stored: readonly StoredEvidenceSource[]): ContextSourceText[] {
  return stored.map((source) => ({
    id: source.id,
    type: source.type,
    text: source.text,
    bytes: source.bytes,
    truncated: source.truncated,
  }));
}
