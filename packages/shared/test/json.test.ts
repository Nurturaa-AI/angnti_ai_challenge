import { describe, expect, it } from "vitest";
import { ModelError, SchemaError } from "../src/errors";
import { parseModelJson, validateWithSchema } from "../src/json";
import { AnalysisBodySchema } from "../src/schemas";

/**
 * Malformed model output. A structured-output request reduces these cases but does
 * not eliminate them, and the difference between "the model produced garbage" and
 * "the model produced JSON that breaks the contract" is worth keeping visible.
 */

const validBody = {
  summary: "A service.",
  architecture: "One process.",
  testing: { approach: "Vitest." },
  confidence: 0.4,
};

describe("parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in a markdown fence", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in an unlabelled fence", () => {
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object surrounded by prose", () => {
    expect(parseModelJson('Sure! Here is the briefing:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("rejects an empty response with a hint about the token limit", () => {
    expect(() => parseModelJson("")).toThrow(ModelError);
    try {
      parseModelJson("   ");
    } catch (error) {
      expect((error as ModelError).hint).toContain("MAX_OUTPUT_TOKENS");
    }
  });

  it("rejects prose with no JSON in it, quoting what it received", () => {
    try {
      parseModelJson("I am unable to analyse this repository.");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).message).toContain("unable to analyse");
    }
  });

  it("rejects JSON truncated mid-object", () => {
    expect(() => parseModelJson('{"summary": "A service", "components": [{"name": "a"')).toThrow(ModelError);
  });

  it("truncates a very long unparseable response in the error message", () => {
    const noise = `not json ${"x".repeat(5_000)}`;
    try {
      parseModelJson(noise);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ModelError).message.length).toBeLessThan(500);
    }
  });
});

describe("validateWithSchema", () => {
  it("returns parsed data on success", () => {
    expect(validateWithSchema(AnalysisBodySchema, validBody, "model analysis").summary).toBe("A service.");
  });

  it("reports every violation with its path", () => {
    try {
      validateWithSchema(AnalysisBodySchema, { ...validBody, confidence: 9, summary: "" }, "model analysis");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const issues = (error as SchemaError).issues;
      expect(issues.join("\n")).toContain("confidence");
      expect(issues.join("\n")).toContain("summary");
    }
  });

  it("labels which artefact failed, so the message says where to look", () => {
    try {
      validateWithSchema(AnalysisBodySchema, {}, "model analysis");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SchemaError).message).toContain("model analysis");
    }
  });

  it("rejects a well-formed JSON array where an object is required", () => {
    expect(() => validateWithSchema(AnalysisBodySchema, [], "model analysis")).toThrow(SchemaError);
  });

  it("rejects evidence whose source is empty, since it could never be verified", () => {
    expect(() =>
      validateWithSchema(
        AnalysisBodySchema,
        { ...validBody, evidence: [{ type: "tree", source: "" }] },
        "model analysis",
      ),
    ).toThrow(SchemaError);
  });
});
