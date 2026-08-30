import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvaluationError } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCaseFile, loadCases } from "../src/load";

/**
 * Case loading fails loudly on purpose. A case that silently fails to load would
 * quietly shrink the denominator of the primary metric, which is the one way this
 * harness could flatter the system it measures without anyone noticing.
 */

let dir: string;

const validCase = {
  id: "case-001",
  title: "Orders API",
  repository: "fixtures/orders-api",
  questions: [
    {
      id: "q1",
      question: "What does this service do?",
      expectedAnswer: "Accepts and prices orders.",
      expectedKeywords: ["order"],
    },
  ],
};

function writeCase(name: string, value: unknown): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "repo-arch-cases-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadCaseFile", () => {
  it("loads a valid case and applies schema defaults", () => {
    const loaded = loadCaseFile(writeCase("case-001.json", validCase));

    expect(loaded.id).toBe("case-001");
    expect(loaded.questions[0]?.field).toBe("any");
    expect(loaded.questions[0]?.expectedEvidence).toEqual([]);
    expect(loaded.questions[0]?.mustNotContain).toEqual([]);
  });

  it("explains where an unreadable file was expected", () => {
    try {
      loadCaseFile(path.join(dir, "absent.json"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationError);
      expect((error as EvaluationError).message).toContain("absent.json");
    }
  });

  it("rejects invalid JSON without pretending the case is empty", () => {
    expect(() => loadCaseFile(writeCase("broken.json", "{ not json"))).toThrow(/not valid JSON/);
  });

  it("lists every schema violation with its path", () => {
    const filePath = writeCase("bad.json", {
      id: "case-001",
      title: "Orders API",
      questions: [{ id: "q1", question: "?", expectedAnswer: "x", expectedKeywords: ["order"] }],
    });

    try {
      loadCaseFile(filePath);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as EvaluationError).message).toContain("repository");
    }
  });

  it("rejects a question with no keywords at all, since it could not be scored", () => {
    const filePath = writeCase("unscorable.json", {
      ...validCase,
      questions: [{ id: "q1", question: "?", expectedAnswer: "x" }],
    });

    expect(() => loadCaseFile(filePath)).toThrow(/cannot be scored|expectedKeywords/);
  });

  it("rejects a case with no questions", () => {
    expect(() => loadCaseFile(writeCase("empty.json", { ...validCase, questions: [] }))).toThrow(EvaluationError);
  });
});

describe("loadCases", () => {
  it("loads every case in filename order", () => {
    writeCase("case-002.json", { ...validCase, id: "case-002" });
    writeCase("case-001.json", validCase);

    const loaded = loadCases(dir);

    expect(loaded.map((entry) => entry.case.id)).toEqual(["case-001", "case-002"]);
  });

  it("records each case's file path relative to the working directory", () => {
    writeCase("case-001.json", validCase);
    const loaded = loadCases(dir);

    expect(path.isAbsolute(loaded[0]?.file ?? "/")).toBe(false);
    expect(loaded[0]?.file).toContain("case-001.json");
  });

  it("ignores files that are not .json", () => {
    writeCase("case-001.json", validCase);
    writeCase("notes.md", "# not a case");

    expect(loadCases(dir)).toHaveLength(1);
  });

  it("refuses to report a zero-case run as a run", () => {
    try {
      loadCases(dir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationError);
      expect((error as EvaluationError).hint).toContain("fixtures:build");
    }
  });

  it("explains a missing case directory rather than reporting no cases", () => {
    expect(() => loadCases(path.join(dir, "nope"))).toThrow(/Could not read the evaluation case directory/);
  });

  it("rejects duplicate case ids, which would collide in the results file", () => {
    writeCase("a.json", validCase);
    writeCase("b.json", validCase);

    expect(() => loadCases(dir)).toThrow(/Duplicate case id "case-001"/);
  });

  it("selects only the requested ids", () => {
    writeCase("case-001.json", validCase);
    writeCase("case-002.json", { ...validCase, id: "case-002" });

    const loaded = loadCases(dir, { filterIds: ["case-002"] });

    expect(loaded.map((entry) => entry.case.id)).toEqual(["case-002"]);
  });

  it("fails on an unknown requested id and lists what is available", () => {
    writeCase("case-001.json", validCase);

    try {
      loadCases(dir, { filterIds: ["case-999"] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as EvaluationError).message).toContain("case-999");
      expect((error as EvaluationError).hint).toContain("case-001");
    }
  });

  it("treats an empty filter as no filter", () => {
    writeCase("case-001.json", validCase);
    expect(loadCases(dir, { filterIds: [] })).toHaveLength(1);
  });
});
