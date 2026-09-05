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

/**
 * The `hidden` attribute, against the stylesheet that has to let it work.
 *
 * `<aside class="drawer" id="drawer" hidden>` and `.drawer { display: flex }` are both
 * correct on their own and contradict each other in a browser: `[hidden] { display: none }`
 * comes from the user-agent stylesheet, and *any* author declaration outranks the entire
 * user-agent origin regardless of specificity. So the evidence drawer — a panel the page
 * opens on demand — was painted over the right-hand third of the workspace from boot, on
 * every load, empty, covering the top bar; `openEvidence` had nothing to reveal and
 * `closeDrawer` nothing to put away.
 *
 * Neither of the other two kinds of test here could see it. `browser-smoke.test.ts` runs
 * the real page, but jsdom resolves `hidden` ahead of the cascade, so its
 * `getAttribute("hidden")` assertions passed against a drawer that never closed — and it
 * does not apply the stylesheet at all. `ui.test.ts` imports pure functions and has no
 * document. A layout defect that only a rendering engine can observe is exactly the gap
 * this file exists for, so it is checked here, as text.
 */
describe("an element the page hides is actually hidden", () => {
  /** Every element that carries `hidden` in the shell, with the classes it also carries. */
  const hideable = [...indexHtml.matchAll(/<\w+([^>]*\bhidden\b[^>]*)>/g)].map((match) => {
    const attributes = match[1] ?? "";
    return {
      id: /\bid="([\w-]+)"/.exec(attributes)?.[1] ?? "(no id)",
      classes: (/\bclass="([^"]*)"/.exec(attributes)?.[1] ?? "").split(/\s+/).filter((name) => name !== ""),
    };
  });

  /**
   * `selector { body }` pairs, comments discarded and at-rules descended into.
   *
   * A regex over the whole file will not do here. The comments in `styles.css` quote CSS
   * — including the two rules this check is about — and would be read as rules, and the
   * narrow form of the drawer lives inside a `@media` block, so a parser that stopped at
   * the first `{` would skip the one selector most worth reading.
   */
  const rules = ((css: string): { selector: string; body: string }[] => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const found: { selector: string; body: string }[] = [];
    let prelude = "";
    for (let at = 0; at < source.length; at += 1) {
      const character = source[at];
      if (character === "}") {
        prelude = "";
        continue;
      }
      if (character !== "{") {
        prelude += character;
        continue;
      }
      const head = prelude.trim();
      prelude = "";
      // `@media`, `@supports`: a block of rules rather than a rule. Fall through into it.
      if (head.startsWith("@")) continue;
      let depth = 1;
      let end = at + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === "{") depth += 1;
        else if (source[end] === "}") depth -= 1;
        end += 1;
      }
      found.push({ selector: head, body: source.slice(at + 1, end - 1) });
      at = end - 1;
    }
    return found;
  })(stylesCss);

  it("finds the elements the page opens and closes", () => {
    // The drawer, the progress host and the status bar. If this drops to nothing the
    // checks below are vacuous rather than passing.
    expect(hideable.map((element) => element.id).sort()).toEqual(["drawer", "progress", "status"]);
  });

  /**
   * The blanket fix. `!important` is what makes it a fix rather than a race: the next
   * `display` written against one of these elements will be written by someone who has
   * not read any of this.
   */
  it("resets [hidden] with a rule no author declaration can outrank", () => {
    const reset = rules.find((rule) => rule.selector === "[hidden]");
    expect(reset).toBeDefined();
    expect(reset?.body.replace(/\s+/g, " ")).toContain("display: none !important");
  });

  /**
   * And the specific one, because a blanket rule is easy to delete by accident. A
   * `display` aimed at a hideable element has to say what it does about `hidden` — in
   * practice `.drawer:not([hidden])`, which reads as "the layout it has when it is open".
   *
   * Aimed *at* it: the subject of the selector, which is the rightmost compound. A
   * `display` on `.drawer > header` styles a child, and a child of a `display: none`
   * element is not rendered whatever it asks for; a `display` on a `::before` or
   * `::after` generates a box inside the element and is the same story. Neither can
   * resurrect the parent, and flagging them would make this check noise.
   */
  it.each(hideable.flatMap((element) => element.classes.map((name) => [element.id, name] as const)))(
    "#%s: no unguarded display on .%s",
    (_id, className) => {
      const aimsAt = (selector: string): boolean =>
        selector
          .split(",")
          .filter((part) => !part.includes("::"))
          .map((part) => part.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? "")
          .some((subject) => new RegExp(`\\.${className}(?![\\w-])`).test(subject));

      const unguarded = rules
        .filter((rule) => aimsAt(rule.selector))
        .filter((rule) => /(^|[;{\s])display\s*:/.test(rule.body))
        .filter((rule) => !rule.selector.includes("[hidden]"))
        .map((rule) => rule.selector);
      expect(unguarded).toEqual([]);
    },
  );
});

/**
 * §15: one empty state, not one per section.
 *
 * `render()` grew a second `.empty` block beside the shell's, both saying the same
 * generic sentence whichever section had been asked for — which is how `#architecture`,
 * the primary workspace, came to greet a reader with a landing page. The copy is per
 * section now and the shape is not: one builder, one class, one place to change how an
 * empty workspace looks. Counting the class is a cheap way to notice the third one.
 */
describe("the empty state has one implementation", () => {
  it("builds .empty in exactly one place in app.js", () => {
    expect(matchAll(appJs, /class: "(empty)"/g)).toEqual(["empty"]);
  });

  it("gives each section its own words rather than one shared sentence", () => {
    // Read out of `ui.js`, so adding a tenth section fails here until it has been given
    // something to say — rather than silently falling back to the overview's sentence.
    const sections = matchAll(uiJs.slice(uiJs.indexOf("export const SECTIONS")), /\{ id: "([\w-]+)"/g);
    expect(sections.length).toBeGreaterThan(5);
    const table = appJs.slice(appJs.indexOf("const NOTHING_OPEN = {"));
    for (const section of sections) expect(table).toContain(`${section}: {`);
  });
});

describe("the destructive control is not the default one", () => {
  const armed = appJs.slice(appJs.indexOf("function deleteControl("), appJs.indexOf("async function deleteAnalysis("));

  /**
   * Arming the confirm step used to focus *"Delete for good"*. The armed row replaces
   * the button the user had just activated, so an Enter already in flight — or a second
   * one from a keyboard user who reached Delete deliberately — destroyed an analysis and
   * its evidence. A confirmation whose destructive half is what the next keypress fires
   * is a speed bump wearing a safeguard's clothes.
   */
  it("moves focus to Cancel rather than to the delete confirmation", () => {
    expect(armed).toContain(".analysis-cancel");
    expect(armed).not.toMatch(/querySelector\("\.analysis-confirm"\)\?\.focus\(\)/);
    const focused = /querySelector\("\.([a-z0-9-]+)"\)\?\.focus\(\)/.exec(armed);
    expect(focused?.[1]).toBe("analysis-cancel");
  });

  /** Source order is the tab order and the reading order: safe control first in both. */
  it("puts Cancel ahead of the confirmation in the DOM", () => {
    const cancel = armed.indexOf("analysis-cancel");
    const confirm = armed.indexOf("analysis-confirm bad-button");
    expect(cancel).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(confirm);
  });
});

describe("painting does not fetch", () => {
  /** The body of a top-level `function name(...)`, up to the next one. */
  const bodyOf = (name: string): string => {
    const start = appJs.indexOf(`\nfunction ${name}(`);
    expect(start, `${name} should be a top-level function in app.js`).toBeGreaterThan(-1);
    const rest = appJs.slice(start + 1);
    const next = rest.search(/\n(?:async function|function|const|\/\*\*) /);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /**
   * `render()` is called from a hashchange, a graph toggle, a stream event and four
   * request handlers. Fetching from inside it meant every one of those issued an HTTP
   * `GET` for the analysis list, un-awaited: a rejection with nowhere to go, and — as
   * the browser smoke suite found — a promise still resolving against a document that
   * had gone away. The callers that change the list `await loadAnalyses()` themselves.
   */
  it("keeps the list fetch out of render()", () => {
    const render = bodyOf("render");
    expect(render).toContain("renderAnalysisList()");
    expect(render).not.toContain("loadAnalyses");
  });

  /** Same rule, one level down: the row painter must not fetch either. */
  it("keeps the list fetch out of renderAnalysisList()", () => {
    const list = bodyOf("renderAnalysisList");
    expect(list).toContain("state.analyses");
    // The error state's retry button is the one permitted mention, and it is a
    // handler rather than a call made while painting.
    for (const mention of matchAll(list, /(.{0,6}loadAnalyses\(\))/g)) {
      expect(mention.trim()).toBe("void loadAnalyses()");
    }
  });

  /**
   * Every un-awaited `loadAnalyses()` in the file is an event handler. A bare
   * `loadAnalyses()` inside an async path is a fetch nobody waits for and whose
   * failure nobody sees, which is the defect this whole block exists for.
   */
  it("awaits the list fetch everywhere it is not a handler", () => {
    for (const call of matchAll(appJs, /([\w.>= ]{0,10})loadAnalyses\(\)/g)) {
      expect(call.trim() === "" || /await |void |function |\* /.test(call)).toBe(true);
    }
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

/**
 * The entry point's flags and the help it prints.
 *
 * `main.ts` hand-rolls both: a `switch` that accepts flags and a template literal that
 * documents them, with nothing connecting the two. Adding `--provenance` in Iteration 6
 * meant editing both halves, and forgetting either half is silent — an accepted flag
 * nobody can discover, or a documented flag that errors out as unknown.
 *
 * Names only. This asserts that the two lists agree, not how the help is worded, so
 * rewording a description or reordering the block breaks nothing.
 */
describe("the web entry point documents the flags it accepts", () => {
  const mainTs = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  const usage = mainTs.slice(mainTs.indexOf("const USAGE = `"), mainTs.indexOf("\n`;\n"));

  // `--` on its own is the `pnpm web --` separator, which the parser skips and the help
  // shows as syntax; the pattern requires a letter after the dashes, so it matches neither.
  const documented = new Set(usage.match(/--[a-z][a-z-]*/g) ?? []);
  const accepted = new Set(matchAll(mainTs, /case "(--[a-z-]+)":/g));

  it("accepts flags, and enough of them to be worth checking", () => {
    expect(accepted.size).toBeGreaterThan(10);
  });

  it("documents every flag it accepts", () => {
    expect([...accepted].filter((flag) => !documented.has(flag))).toEqual([]);
  });

  it("accepts every flag it documents", () => {
    expect([...documented].filter((flag) => !accepted.has(flag))).toEqual([]);
  });

  it("hands the run's provenance to the server rather than resolving it twice", () => {
    // The identity has one source on this path. A second `resolveProvenance` call at a
    // later layer could disagree with the label the banner printed.
    expect(mainTs).toContain("const provenance = resolveProvenance(args.provenance)");
    expect(mainTs).toContain("provenance,");
    expect(mainTs).toContain("`provenance: ${provenance}`");
  });
});
