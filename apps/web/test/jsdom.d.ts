/**
 * The slice of jsdom this repository uses, declared locally.
 *
 * `@types/jsdom` would be the obvious answer, and it was tried. Its first two lines
 * are `/// <reference lib="dom" />` and `/// <reference lib="dom.iterable" />`,
 * which put every DOM global into scope for the *whole* project — verified, not
 * assumed: with it installed, `const probe = document.title;` compiles inside
 * `packages/shared/src`.
 *
 * That is a guard this codebase deliberately has. `tsconfig.json` sets
 * `"lib": ["ES2023"]` with no DOM, so a server module that reaches for `document`
 * or `window` fails to compile rather than failing at runtime in front of a user.
 * Trading that away across nine packages to type one test file is the wrong trade,
 * and it would be an invisible one: nothing would announce that the guard had gone.
 *
 * So the types are written out here instead. They are narrow on purpose — only what
 * `browser-smoke.test.ts` actually calls — and structural, so a jsdom upgrade that
 * changed one of these signatures would show up as a type error in the test rather
 * than as a silent pass. If the smoke test needs more of the DOM later, the right
 * move is to add the member here, not to reach for the global lib.
 */
declare module "jsdom" {
  /** A DOM event, as far as the smoke test is concerned. */
  interface DomEvent {
    readonly type: string;
  }

  /** One element. Narrow by design; see the note above. */
  interface DomElement {
    textContent: string | null;
    className: string;
    readonly outerHTML: string;
    /** Present on the form controls the test drives; absent elsewhere at runtime. */
    value: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    append(...nodes: (DomElement | string)[]): void;
    remove(): void;
    dispatchEvent(event: DomEvent): boolean;
    querySelector(selectors: string): DomElement | null;
    querySelectorAll(selectors: string): ArrayLike<DomElement> & Iterable<DomElement>;
    addEventListener(type: string, listener: (event: DomEvent) => void): void;
  }

  interface DomDocument {
    readonly body: DomElement;
    readonly documentElement: DomElement;
    createElement(tagName: string): DomElement;
    getElementById(id: string): DomElement | null;
    querySelector(selectors: string): DomElement | null;
    querySelectorAll(selectors: string): ArrayLike<DomElement> & Iterable<DomElement>;
    addEventListener(type: string, listener: (event: DomEvent) => void): void;
    dispatchEvent(event: DomEvent): boolean;
  }

  interface EventConstructors {
    new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }): DomEvent;
  }

  interface KeyboardEventConstructor {
    new (type: string, init?: { key?: string; bubbles?: boolean }): DomEvent;
  }

  interface DomWindow {
    readonly document: DomDocument;
    readonly Element: { prototype: object };
    readonly Event: EventConstructors;
    readonly MouseEvent: EventConstructors;
    readonly KeyboardEvent: KeyboardEventConstructor;
    addEventListener(type: string, listener: (event: never) => void): void;
    close(): void;
  }

  export interface ConstructorOptions {
    url?: string | undefined;
    runScripts?: "dangerously" | "outside-only" | undefined;
    pretendToBeVisual?: boolean | undefined;
    virtualConsole?: VirtualConsole | undefined;
  }

  export class VirtualConsole {
    on(event: string, handler: (...args: never[]) => void): this;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: DomWindow;
  }
}
