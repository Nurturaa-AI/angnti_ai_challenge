/**
 * Does the product actually use the logic we tested?
 *
 * `ui.test.ts` passed fifty assertions against `ui.js` while `app.js` — the only file the
 * browser loads — was a hard `SyntaxError`, because three functions had been extracted
 * into `ui.js`, imported back, and never deleted from the original. Every claim the
 * dashboard makes was tested. The dashboard was blank.
 *
 * That is not a gap in coverage, it is a gap in *kind*. A unit test imports a module and
 * proves the module works; nothing in it can prove the module is reached. The checks here
 * are the other kind — they read the shipped files as text and assert the seams between
 * them hold:
 *
 *   - the entry point parses at all;
 *   - nothing imported is also declared locally (the exact bug above);
 *   - nothing imported is unused (the extraction's other half — a helper wired into the
 *     import list and never called, which is how §7's node detail, §17's outline and
 *     §18's degradation all sat inert while their tests passed);
 *   - every element the code looks up exists somewhere that creates it;
 *   - every class and custom property it applies has a rule;
 *   - the browser addresses evidence only through its owning analysis, and asks for
 *     nothing internal.
 *
 * These are cheap, they need no DOM, and each one corresponds to a defect that shipped.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const read = (name: string): string => readFileSync(path.join(PUBLIC_DIR, name), "utf8");

const appJs = read("app.js");
const uiJs = read("ui.js");
const indexHtml = read("index.html");
const stylesCss = read("styles.css");

/** Everything after the import block: where a name has to be *used* to count. */
const IMPORT_BLOCK = /import \{([^}]+)\} from "\/ui\.js";/;
const importMatch = IMPORT_BLOCK.exec(appJs);
const importedNames = (importMatch?.[1] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const appBody = appJs.replace(IMPORT_BLOCK, "");

const matchAll = (source: string, pattern: RegExp): string[] => {
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const captured = match[1];
    if (captured !== undefined) found.push(captured);
  }
  return found;
};

describe("the files the browser loads", () => {
  // `apps/web/package.json` is `"type": "module"`, so `--check` parses these as ESM —
  // which is the point: a CommonJS parse would reject the import block outright, and this
  // check has to see the same grammar the browser does.
  it.each(["app.js", "ui.js"])("%s parses as an ES module", (name) => {
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(PUBLIC_DIR, name)], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });

  it("imports at least the helpers ui.js is worth having for", () => {
    expect(importedNames.length).toBeGreaterThan(20);
  });

  it("imports only names ui.js exports", () => {
    const exported = new Set([
      ...matchAll(uiJs, /export function (\w+)/g),
      ...matchAll(uiJs, /export const (\w+)/g),
    ]);
    expect(importedNames.filter((name) => !exported.has(name))).toEqual([]);
  });

  /**
   * The bug itself. A local declaration shadows the import for the whole module scope in
   * the lucky case and is a `SyntaxError` in this one; either way the tested version is
   * not the running version.
   */
  it("declares nothing it also imports", () => {
    const shadowed = importedNames.filter((name) =>
      new RegExp(`^\\s*(?:function|const|let|var|class)\\s+${name}\\b`, "m").test(appBody),
    );
    expect(shadowed).toEqual([]);
  });

  /** The other half: a helper in the import list that nothing ever calls. */
  it("uses every name it imports", () => {
    const unused = importedNames.filter((name) => !new RegExp(`\\b${name}\\b`).test(appBody));
    expect(unused).toEqual([]);
  });
});

describe("every element the app reaches for exists", () => {
  const looksUp = new Set([
    ...matchAll(appJs, /\$\("([\w-]+)"\)/g),
    ...matchAll(appJs, /getElementById\("([\w-]+)"\)/g),
  ]);
  /** Either static in the page, or built by `el(..., { id })` before it is read. */
  const provided = new Set([
    ...matchAll(indexHtml, /\bid="([\w-]+)"/g),
    ...matchAll(appJs, /\bid: "([\w-]+)"/g),
  ]);

  it("looks up the elements you would expect a dashboard to have", () => {
    expect(looksUp.size).toBeGreaterThan(10);
  });

  it("has a host for each one", () => {
    expect([...looksUp].filter((id) => !provided.has(id)).sort()).toEqual([]);
  });

  /**
   * Named explicitly rather than left to the check above, because these three are the
   * ones whose absence is silent: `toast()` threw a `TypeError` on every status message
   * for an entire iteration, and the progress panel — a deliverable — never painted,
   * because its host was described in a comment and never added to the page.
   */
  it.each(["announce", "alert", "status", "progress", "main", "drawer"])(
    "index.html carries #%s",
    (id) => {
      expect(indexHtml).toContain(`id="${id}"`);
    },
  );

  it("keeps the progress host outside <main>, which render() clears", () => {
    const progressAt = indexHtml.indexOf('id="progress"');
    const mainAt = indexHtml.indexOf('id="main"');
    expect(progressAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    expect(progressAt).toBeLessThan(mainAt);
  });
});

describe("every class and token the app applies has a rule", () => {
  /**
   * The defined set is deliberately over-approximated — any `.name` anywhere in the
   * stylesheet counts. Over-approximating can only cause a false pass, never a false
   * failure, and a check that cries wolf gets deleted.
   */
  const defined = new Set(matchAll(stylesCss, /\.([a-z][a-z0-9-]*)/g));

  /**
   * Interpolations come out innermost-first, repeatedly, because they nest: one class
   * expression in `app.js` is a template inside a template, and a single non-greedy pass
   * would stop at the inner backtick and report the fragment as a missing class.
   */
  let flattened = appJs;
  for (;;) {
    const next = flattened.replace(/\$\{[^{}]*\}/g, "");
    if (next === flattened) break;
    flattened = next;
  }

  const used = new Set<string>();
  for (const literal of [
    ...matchAll(flattened, /class: "([^"]*)"/g),
    ...matchAll(flattened, /class: `([^`]*)`/g),
  ]) {
    // `pill pill-${tone}` has become `pill pill-`: the prefix is what can be checked.
    for (const token of literal.split(/\s+/)) {
      if (token !== "") used.add(token);
    }
  }
  for (const token of [
    ...matchAll(appJs, /classList\.(?:add|remove|toggle)\("([a-z0-9-]+)"/g),
    ...matchAll(appJs, /querySelector(?:All)?\("\.([a-z0-9-]+)/g),
  ]) {
    used.add(token);
  }

  it("applies the classes you would expect", () => {
    expect(used.size).toBeGreaterThan(30);
  });

  /**
   * A class the stylesheet has never heard of is either a typo or a rule that was renamed
   * out from under the code, and both look identical in a browser: nothing happens. This
   * caught the whole recent-analyses list, whose eleven classes arrived with the durable
   * store and were never styled, and both pill families — a status the page reported in
   * plain body text because `.pill` did not exist.
   *
   * A class used purely as a JavaScript hook still has to appear here. That is the point:
   * the two files share one vocabulary, and a name only one of them knows is a seam
   * waiting to come apart.
   */
  it("styles all of them", () => {
    const missing = [...used].filter((token) =>
      token.endsWith("-")
        ? ![...defined].some((name) => name.startsWith(token))
        : !defined.has(token),
    );
    expect(missing.sort()).toEqual([]);
  });

  it("defines every custom property it reads", () => {
    const declared = new Set(matchAll(stylesCss, /(--[a-z0-9-]+):/g));
    const referenced = new Set([
      ...matchAll(stylesCss, /var\((--[a-z0-9-]+)/g),
      ...matchAll(appJs, /var\((--[a-z0-9-]+)/g),
    ]);
    expect([...referenced].filter((token) => !declared.has(token)).sort()).toEqual([]);
  });
});

describe("what the browser is allowed to ask for", () => {
  const routes = [
    ...matchAll(appJs, /`(\/api\/[^`]*)`/g),
    ...matchAll(appJs, /"(\/api\/[^"]*)"/g),
  ];

  it("builds routes at all", () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  /** The Iteration 4 aliases stay on the server for its tests; the browser is off them. */
  it("uses only the canonical /api/analyses routes", () => {
    expect(routes.filter((route) => route.startsWith("/api/analysis/"))).toEqual([]);
    expect(routes.filter((route) => route.startsWith("/api/questions"))).toEqual([]);
    expect(routes.filter((route) => route.startsWith("/api/analyze"))).toEqual([]);
  });

  /**
   * §2.3: evidence from analysis A must not be reachable through analysis B. The server
   * enforces it; this asserts the client never even builds the shape that would ask —
   * there is no `/api/evidence/:id` for it to drift towards.
   */
  it("only ever addresses evidence through its owning analysis", () => {
    const evidenceRoutes = routes.filter((route) => route.includes("/evidence"));
    expect(evidenceRoutes.length).toBeGreaterThan(0);
    for (const route of evidenceRoutes) {
      expect(route).toMatch(/^\/api\/analyses\/\$\{[^}]+\}\/evidence\/\$\{[^}]+\}$/);
    }
  });

  /** §15: the projection exists so these never cross the wire. Nor should the client name them. */
  it.each(["repositoryRoot", "trajectory", "apiKey"])("never mentions %s", (internal) => {
    expect(appJs).not.toContain(internal);
  });
});
