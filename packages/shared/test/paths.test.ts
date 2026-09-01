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

  /**
   * The shape-based half, added when a report stopped being the only thing that leaves the
   * process: an HTTP response, a metric event and an exported PDF each carry excerpts from
   * files nobody vetted, and a token committed to a source file has no `API_KEY =` beside it
   * to give it away.
   *
   * Every value below is a published documentation example, not a real credential.
   */
  const CREDENTIAL_EXAMPLES: readonly [string, string][] = [
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a GitHub personal access token", `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`],
    ["a fine-grained GitHub token", `github_pat_${"1a2B3c4D5e6F7g8H9i0J".repeat(2)}`],
    ["a Slack bot token", "xoxb-123456789012-1234567890123-abcdefABCDEF1234"],
    ["a Stripe secret key", "sk_live_abcdefghijklmnopqrstuvwx"],
    ["an Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
  ];

  for (const [what, secret] of CREDENTIAL_EXAMPLES) {
    it(`redacts ${what} found in the middle of repository text`, () => {
      const redacted = redactSecrets(`  12 | const client = connect("${secret}");`);

      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("<redacted-credential>");
      // The surrounding line survives, because the excerpt is what makes evidence readable.
      expect(redacted).toContain("const client = connect(");
    });
  }

  it("redacts a whole private key block rather than picking at its body", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
      "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactSecrets(`key = """\n${pem}\n"""`);

    expect(redacted).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).toContain("<redacted-private-key>");
  });

  it("keeps the placeholder wording trajectories have used since the first iteration", () => {
    // A Google key is the one shape with its own placeholder, because the wording is pinned
    // above and by every trajectory already on disk.
    expect(redactSecrets("AIzaSyA1b2C3d4E5f6G7h8I9j0")).toBe("<redacted-api-key>");
  });

  /**
   * The deliberate non-matches. Each of these is a *reference* to a credential or a
   * high-entropy string that is not one, and redacting them would make evidence less
   * readable while protecting nothing.
   */
  it("leaves a reference to a credential readable", () => {
    for (const text of [
      "const jwtSecret = env.JWT_SECRET;",
      "password: process.env.DB_PASSWORD,",
      "token = readFileSync('/run/secrets/token', 'utf8')",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("does not mistake a hash, a uuid or a hex digest for a credential", () => {
    for (const text of [
      "commit 7ca9e3ad1f4b6c8e9a0b2c3d4e5f60718293a4b5",
      "id: 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("cannot recognise a bare high-entropy string, and this documents that limit", () => {
    // No prefix, no label, nothing to match on. A heuristic wide enough to catch this would
    // redact hashes, uuids and minified code — see the two tests above. Stated as a test so
    // the limit is a known property rather than a surprise.
    const bare = "h8Kq2mVx9pLt4RnZ7wSc";
    expect(redactSecrets(`const key = "${bare}";`)).toContain(bare);
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
