import { resolveEvidence } from "./build";
import type { ClaimSet, ComposedClaim } from "./schema";
import type { AnalysisBody, Component, Dependency, Evidence, Flow, Risk } from "../schemas";

/**
 * Putting composed claims back into the briefing.
 *
 * A claim set is a projection of the briefing, so a composition over it is
 * initially invisible to everything downstream — grounding walks the briefing's
 * arrays, the report renders them, and the evaluator reads them. Materializing is
 * how a composed claim becomes a real assertion in the document rather than
 * metadata beside it.
 *
 * The rules, in the order they matter:
 *
 *  1. **Evidence is never invented.** A materialized entry carries exactly the
 *     `Evidence` its parts cited, resolved from the ledger. Grounding runs
 *     *after* this and still has the last word on every citation, so a composition
 *     cannot smuggle in support the repository does not give.
 *  2. **No entry is displaced.** Materializing appends; it never edits or removes
 *     what the model wrote. A briefing that was correct before is still correct,
 *     with more in it.
 *  3. **It is written to be read.** A composed entry names itself as a composite
 *     and reads as prose, because this briefing is a document for a human, not a
 *     scoring artefact. A composition that would be unreadable is not worth the
 *     citation it carries.
 *  4. **Nothing question-shaped enters.** The text comes from the parts. There is
 *     no question here to shape it around, and there must not be.
 */

/** Marker prefix on materialized entries, so a reader and a test can both find them. */
export const COMPOSITE_MARKER = "Composite:";

export interface MaterializeResult {
  body: AnalysisBody;
  /** Ids of the compositions that reached the briefing. */
  materializedIds: string[];
}

export function materializeComposedClaims(body: AnalysisBody, set: ClaimSet): MaterializeResult {
  const materializedIds: string[] = [];
  const components: Component[] = [...body.components];
  const flows: Flow[] = [...body.flows];
  const dependencies: Dependency[] = [...body.dependencies];
  const risks: Risk[] = [...body.risks];

  for (const composed of set.composed) {
    const evidence = resolveEvidence(set, composed.evidenceIds);
    // A composition with nothing behind it would be an unsupported claim the model
    // never made. Composing is for carrying evidence; with none, there is nothing
    // to carry.
    if (evidence.length === 0) continue;

    switch (composed.kind) {
      case "component":
        components.push(asComponent(composed, evidence));
        break;
      case "flow":
        flows.push(asFlow(composed, evidence));
        break;
      case "dependency":
        dependencies.push(asDependency(composed, evidence));
        break;
      case "risk":
        risks.push(asRisk(composed, evidence));
        break;
      // `testing` is a single object and `overview` is prose: neither is a list an
      // entry can be appended to, so a composition of those kinds stays in the
      // claim set and is reported there rather than rewriting the model's text.
      case "testing":
      case "overview":
        continue;
    }
    materializedIds.push(composed.id);
  }

  return {
    body: { ...body, components, flows, dependencies, risks },
    materializedIds,
  };
}

function label(composed: ComposedClaim): string {
  const subject = composed.subject === undefined || composed.subject === "" ? composed.kind : composed.subject;
  return `${COMPOSITE_MARKER} ${subject}`;
}

function asComponent(composed: ComposedClaim, evidence: Evidence[]): Component {
  return { name: label(composed), responsibility: composed.text, evidence };
}

function asFlow(composed: ComposedClaim, evidence: Evidence[]): Flow {
  return { name: label(composed), description: composed.text, steps: [], evidence };
}

function asDependency(composed: ComposedClaim, evidence: Evidence[]): Dependency {
  // `scope: "unknown"` is the honest value: a composition spans entries whose
  // scopes differ, and asserting one of them would be asserting something false.
  return { name: label(composed), scope: "unknown", purpose: composed.text, evidence };
}

function asRisk(composed: ComposedClaim, evidence: Evidence[]): Risk {
  return { title: label(composed), description: composed.text, severity: "low", evidence };
}
