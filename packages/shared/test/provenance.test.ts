import { ConfigError } from "@repo-arch/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVENANCE,
  PROVENANCE_ENV_VAR,
  assertProvenance,
  isValidProvenance,
  resolveProvenance,
} from "../src/provenance";

/**
 * Provenance is persisted, printed into reports and returned over HTTP, so the
 * validator is a security boundary and not a formatting preference: it is the
 * thing that stops a shell mistake putting a secret or a host path into the
 * database and then into an API response.
 */

describe("isValidProvenance", () => {
  it.each([
    "iteration-6-baseline",
    "iteration-6-evidence-improvement",
    "i5",
    "release/0.6.2",
    "ci.nightly",
    "a",
    "0",
    "a".repeat(64),
  ])("accepts %s", (label) => {
    expect(isValidProvenance(label)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["a".repeat(65), "too long"],
    ["Iteration-6", "uppercase"],
    ["iteration 6", "a space"],
    ["-leading-dash", "a leading dash"],
    [".hidden", "a leading dot, which is how a dotfile starts"],
    ["/home/user/secret", "an absolute path"],
    ["C:\\Users\\me", "a Windows path"],
    ["provider:key", "a colon, which is how key=value secrets are written"],
    ["a=b", "an equals sign"],
    ["run#1", "a fragment marker"],
    ["<script>", "markup"],
    ["run\nlabel", "a newline"],
    ["run\ttab", "a tab"],
    ["café", "a non-ASCII character"],
  ])("rejects %j because it has %s", (label) => {
    expect(isValidProvenance(label)).toBe(false);
  });

  it("accepts the label the default uses, so the default is never itself invalid", () => {
    expect(isValidProvenance(DEFAULT_PROVENANCE)).toBe(true);
  });
});

describe("assertProvenance", () => {
  it("returns the label unchanged when it is usable", () => {
    expect(assertProvenance("iteration-6-baseline")).toBe("iteration-6-baseline");
  });

  it("throws a ConfigError rather than falling back", () => {
    // A run started with an explicit label that cannot be stored should stop. The
    // label is how the resulting numbers are found again.
    expect(() => assertProvenance("Iteration 6")).toThrow(ConfigError);
  });

  it("explains what a label may contain, in the hint the CLI prints", () => {
    let hint: string | undefined;
    try {
      assertProvenance("/tmp/run");
    } catch (error) {
      hint = (error as ConfigError).hint;
    }
    expect(hint).toMatch(/lowercase letters, digits/);
  });
});

describe("resolveProvenance", () => {
  it("prefers an explicit label over the environment", () => {
    expect(resolveProvenance("iteration-6-baseline", { [PROVENANCE_ENV_VAR]: "from-env" })).toBe(
      "iteration-6-baseline",
    );
  });

  it("falls back to the environment", () => {
    expect(resolveProvenance(undefined, { [PROVENANCE_ENV_VAR]: "ci-nightly" })).toBe("ci-nightly");
  });

  it("falls back to the default when nothing supplies a label", () => {
    expect(resolveProvenance(undefined, {})).toBe(DEFAULT_PROVENANCE);
  });

  it("treats an exported-but-empty variable as absent", () => {
    // `export REPO_ARCHAEOLOGIST_PROVENANCE=` is indistinguishable from unset in
    // intent, so it must not be an error.
    expect(resolveProvenance(undefined, { [PROVENANCE_ENV_VAR]: "   " })).toBe(DEFAULT_PROVENANCE);
  });

  it("trims a label rather than rejecting it for surrounding whitespace", () => {
    expect(resolveProvenance("  iteration-6-baseline\n", {})).toBe("iteration-6-baseline");
  });

  it("still throws on an environment value that is set and malformed", () => {
    // Set on purpose and wrong, which is different from unset.
    expect(() => resolveProvenance(undefined, { [PROVENANCE_ENV_VAR]: "/var/run" })).toThrow(ConfigError);
  });

  it("never lets an API-key-shaped value through", () => {
    expect(() => resolveProvenance("AIzaSyC-not-a-real-key_0123456789abcdefghij", {})).toThrow(ConfigError);
  });
});
