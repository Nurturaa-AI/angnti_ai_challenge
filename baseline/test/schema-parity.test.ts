import {
  AnalysisBodySchema,
  ComponentSchema,
  DEPENDENCY_SCOPES,
  DependencySchema,
  EVIDENCE_TYPES,
  EvidenceSchema,
  FlowSchema,
  RecommendedReadingSchema,
  RiskSchema,
  SEVERITIES,
  TestingSchema,
} from "@repo-arch/shared";
import { describe, expect, it } from "vitest";
import { ANALYSIS_RESPONSE_SCHEMA } from "../src/prompt";

/**
 * Schema parity.
 *
 * The Gemini response schema is written by hand rather than generated from Zod,
 * because the two dialects drift and a silent mismatch is painful to debug. The
 * price of that choice is this file: if the two ever disagree, a test fails here
 * instead of a run failing in front of a user.
 */

type JsonSchema = Record<string, unknown>;

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema.properties ?? {}) as Record<string, JsonSchema>;
}

function propertyKeys(schema: JsonSchema): string[] {
  return Object.keys(properties(schema)).sort();
}

function requiredKeys(schema: JsonSchema): string[] {
  return [...((schema.required ?? []) as string[])].sort();
}

function items(schema: JsonSchema): JsonSchema {
  return schema.items as JsonSchema;
}

function enumValues(schema: JsonSchema): string[] {
  return (schema.enum ?? []) as string[];
}

function zodKeys(shape: Record<string, unknown>): string[] {
  return Object.keys(shape).sort();
}

/** Fields the grounding step writes onto evidence. The model must never see them. */
const HARNESS_WRITTEN_EVIDENCE_FIELDS = ["grounded", "groundingReason"];

const topLevel = properties(ANALYSIS_RESPONSE_SCHEMA);

describe("top-level parity with AnalysisBodySchema", () => {
  it("asks for exactly the fields the analysis body accepts", () => {
    expect(propertyKeys(ANALYSIS_RESPONSE_SCHEMA)).toEqual(zodKeys(AnalysisBodySchema.shape));
  });

  it("does not ask the model for repository metadata, which the harness supplies", () => {
    expect(propertyKeys(ANALYSIS_RESPONSE_SCHEMA)).not.toContain("repository");
  });

  it("requires every field, including the ones Zod would default to empty", () => {
    // Stricter than Zod on purpose: an explicit `"flows": []` is a statement that
    // the context showed none. A missing key is an accident.
    expect(requiredKeys(ANALYSIS_RESPONSE_SCHEMA)).toEqual(zodKeys(AnalysisBodySchema.shape));
  });

  it("requires at least everything Zod will reject as missing", () => {
    const mustBeSupplied = Object.entries(AnalysisBodySchema.shape)
      .filter(([, field]) => !(field as { safeParse: (value: unknown) => { success: boolean } }).safeParse(undefined).success)
      .map(([key]) => key)
      .sort();

    expect(mustBeSupplied).toEqual(["architecture", "confidence", "summary", "testing"]);
    for (const key of mustBeSupplied) expect(requiredKeys(ANALYSIS_RESPONSE_SCHEMA)).toContain(key);
  });

  it("keeps confidence on the same 0..1 scale as the schema", () => {
    expect(topLevel.confidence).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
  });
});

describe("nested object parity", () => {
  const cases: readonly { label: string; schema: JsonSchema; shape: Record<string, unknown> }[] = [
    { label: "components", schema: items(topLevel.components as JsonSchema), shape: ComponentSchema.shape },
    { label: "flows", schema: items(topLevel.flows as JsonSchema), shape: FlowSchema.shape },
    { label: "dependencies", schema: items(topLevel.dependencies as JsonSchema), shape: DependencySchema.shape },
    { label: "testing", schema: topLevel.testing as JsonSchema, shape: TestingSchema.shape },
    { label: "risks", schema: items(topLevel.risks as JsonSchema), shape: RiskSchema.shape },
    {
      label: "recommendedReading",
      schema: items(topLevel.recommendedReading as JsonSchema),
      shape: RecommendedReadingSchema.shape,
    },
  ];

  it.each(cases)("$label asks for exactly the fields its Zod schema accepts", ({ schema, shape }) => {
    expect(propertyKeys(schema)).toEqual(zodKeys(shape));
  });

  it.each(cases)("$label requires nothing the Zod schema does not know about", ({ schema, shape }) => {
    for (const key of requiredKeys(schema)) expect(zodKeys(shape)).toContain(key);
  });
});

describe("enum parity", () => {
  it("offers the dependency scopes the schema accepts, and no others", () => {
    const scope = properties(items(topLevel.dependencies as JsonSchema)).scope as JsonSchema;
    expect(enumValues(scope)).toEqual([...DEPENDENCY_SCOPES]);
  });

  it("offers the severities the schema accepts, and no others", () => {
    const severity = properties(items(topLevel.risks as JsonSchema)).severity as JsonSchema;
    expect(enumValues(severity)).toEqual([...SEVERITIES]);
  });

  it("restricts evidence types to the four the baseline can legitimately produce", () => {
    const evidenceType = properties(items(topLevel.evidence as JsonSchema)).type as JsonSchema;

    expect(enumValues(evidenceType)).toEqual(["tree", "readme", "manifest", "metadata"]);
    // Every offered type must still be one the schema knows.
    for (const value of enumValues(evidenceType)) expect(EVIDENCE_TYPES).toContain(value);
    // The tool-earned types belong to the advanced agent, which has to run something for them.
    for (const earned of ["file", "git", "test", "command", "dependency"]) {
      expect(enumValues(evidenceType)).not.toContain(earned);
    }
  });
});

describe("evidence parity", () => {
  const evidenceItem = items(topLevel.evidence as JsonSchema);

  it("asks for every model-authored evidence field", () => {
    const modelAuthored = zodKeys(EvidenceSchema.shape).filter(
      (key) => !HARNESS_WRITTEN_EVIDENCE_FIELDS.includes(key),
    );
    expect(propertyKeys(evidenceItem)).toEqual(modelAuthored);
  });

  it("never asks the model for the grounding verdict on its own evidence", () => {
    for (const field of HARNESS_WRITTEN_EVIDENCE_FIELDS) {
      expect(propertyKeys(evidenceItem)).not.toContain(field);
    }
  });

  it("requires a type and a source, since evidence with neither cannot be checked", () => {
    expect(requiredKeys(evidenceItem)).toEqual(["source", "type"]);
  });

  it("uses the same evidence shape everywhere it appears", () => {
    const nested = [
      items(properties(items(topLevel.components as JsonSchema)).evidence as JsonSchema),
      items(properties(items(topLevel.flows as JsonSchema)).evidence as JsonSchema),
      items(properties(items(topLevel.dependencies as JsonSchema)).evidence as JsonSchema),
      items(properties(items(topLevel.risks as JsonSchema)).evidence as JsonSchema),
      items(properties(topLevel.testing as JsonSchema).evidence as JsonSchema),
    ];

    for (const shape of nested) expect(shape).toEqual(evidenceItem);
  });

  it("does not attach evidence to reading order or open questions, which carry none", () => {
    expect(propertyKeys(items(topLevel.recommendedReading as JsonSchema))).not.toContain("evidence");
    expect(topLevel.openQuestions).toMatchObject({ type: "array", items: { type: "string" } });
  });
});
