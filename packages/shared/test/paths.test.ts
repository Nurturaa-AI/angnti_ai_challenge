import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  redactSecrets,
  slugify,
  timestampSlug,
  toPortablePath,
  writeJsonFile,
  writeTextFile,
} from "../src/paths";

/**
 * Two engineering requirements are enforced here rather than by convention:
 * nothing written to disk carries an absolute path from the machine that ran it,
 * and nothing written to disk carries anything shaped like a credential.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "repo-arch-paths-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("toPortablePath", () => {
  it("relativises an absolute path against the working directory", () => {
    expect(toPortablePath("/home/dev/project/fixtures/demo", "/home/dev/project")).toBe("fixtures/demo");
  });

  it("keeps a relative path as it was given", () => {
    expect(toPortablePath("fixtures/demo", "/home/dev/project")).toBe("fixtures/demo");
  });

  it("prefers an escaping relative path over leaking a home directory", () => {
    expect(toPortablePath("/home/dev/other-repo", "/home/dev/project")).toBe("../other-repo");
  });

  it("renders the working directory itself as a dot rather than an empty string", () => {
    expect(toPortablePath("/home/dev/project", "/home/dev/project")).toBe(".");
  });
});

describe("redactSecrets", () => {
  it("redacts a Google API key wherever it appears", () => {
    const redacted = redactSecrets("failed with key AIzaSyA1b2C3d4E5f6G7h8I9j0 while calling the API");

    expect(redacted).not.toContain("AIzaSyA1b2C3d4E5f6G7h8I9j0");
    expect(redacted).toContain("<redacted-api-key>");
  });

  it("redacts an assignment to a credential variable, whatever the value looks like", () => {
    expect(redactSecrets("GEMINI_API_KEY=not-even-key-shaped")).toBe("GEMINI_API_KEY=<redacted>");
  });

  it("redacts a credential that has been JSON-serialised, and keeps the JSON parseable", () => {
    const redacted = redactSecrets('{"GOOGLE_API_KEY": "abc123"}');

    expect(redacted).toBe('{"GOOGLE_API_KEY": "<redacted>"}');
    expect(JSON.parse(redacted)).toEqual({ GOOGLE_API_KEY: "<redacted>" });
  });

  it("catches the camelCase spelling a config object would use", () => {
    expect(redactSecrets('{"apiKey": "abc123"}')).toContain('"<redacted>"');
  });

  it("is case-insensitive about the variable name", () => {
    expect(redactSecrets("gemini_api_key = abc123")).toContain("<redacted>");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Evidence: package.json names express ^4.19.2 as a runtime dependency.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("writeJsonFile / writeTextFile", () => {
  it("writes pretty JSON with a trailing newline, creating parent directories", () => {
    const target = path.join(dir, "nested", "deeper", "report.json");
    writeJsonFile(target, { a: 1 });

    const contents = readFileSync(target, "utf8");
    expect(contents).toBe('{\n  "a": 1\n}\n');
  });

  it("strips a credential that reached a report by accident", () => {
    const target = path.join(dir, "report.json");
    writeJsonFile(target, { note: "used AIzaSyA1b2C3d4E5f6G7h8I9j0" });

    expect(readFileSync(target, "utf8")).not.toContain("AIzaSyA1b2C3d4E5f6G7h8I9j0");
  });

  it("strips a credential from written text as well as written JSON", () => {
    const target = path.join(dir, "briefing.md");
    writeTextFile(target, "# briefing\n\nGEMINI_API_KEY=AIzaSyA1b2C3d4E5f6G7h8I9j0\n");

    const contents = readFileSync(target, "utf8");
    expect(contents).not.toContain("AIzaSyA1b2C3d4E5f6G7h8I9j0");
    expect(contents).toContain("# briefing");
  });
});

describe("slugify", () => {
  it("produces a filesystem-safe slug", () => {
    expect(slugify("Orders API")).toBe("orders-api");
    expect(slugify("my.repo/v2")).toBe("my-repo-v2");
  });

  it("never returns an empty string, which would produce a hidden file", () => {
    expect(slugify("///")).toBe("unnamed");
    expect(slugify("")).toBe("unnamed");
  });
});

describe("timestampSlug", () => {
  it("is sortable and legal in a filename on every platform", () => {
    const slug = timestampSlug(new Date("2026-08-30T18:52:04.123Z"));

    expect(slug).toBe("2026-08-30T18-52-04Z");
    expect(slug).not.toMatch(/[/\\:*?"<>|]/);
  });

  it("sorts chronologically as a string", () => {
    const earlier = timestampSlug(new Date("2026-08-30T18:52:04.000Z"));
    const later = timestampSlug(new Date("2026-08-30T19:00:00.000Z"));

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});
