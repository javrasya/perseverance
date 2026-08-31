/**
 * The stack-level prohibitions and the contract registry's structural probe, as
 * pure functions over text.
 *
 * They are separated from the tests that call them so the checks themselves
 * can be tested against known-bad input. A check nobody has ever seen fail is
 * indistinguishable from a check that cannot fail.
 */

export interface Violation {
  line: number;
  detail: string;
}

/* ------------------------------------------------------ markup from text --- */

/**
 * Every route there is from a string to markup.
 *
 * The panel renders markdown lifted verbatim out of an issue body, and the only
 * defence it has against a `<script>` in one is that **no such route exists**:
 * the renderer builds React elements, React escapes the strings it is handed,
 * and text therefore stays text because nothing anywhere could have parsed it.
 * That property is a property of the whole of `src/` rather than of one file —
 * one `innerHTML` anywhere and the argument stops being structural and becomes
 * a promise about who touches what.
 *
 * `DOMParser` is on the list beside the assignments. It builds a document
 * rather than a string, so it defeats nothing on its own; what it does is make
 * *parse this text as markup* available in the codebase, one `adoptNode` away
 * from the DOM the app is rendering. `parseHTMLUnsafe` is there for the same
 * reason and by a shorter road.
 *
 * The assignment patterns take `+=` as well as `=`. `node.innerHTML += reason`
 * is the same route with the same consequence, and a check that read only `=`
 * would have called a file clean while it appended a `<script>` — the exact
 * shape a check that cannot fail takes. `setHTMLUnsafe` and
 * `createContextualFragment` are the two ways to reach a parser without ever
 * naming `innerHTML`: the first is the sanctioned no-sanitiser sibling of the
 * setter and is in the evergreen half of the declared browserslist floor, and
 * the second is `Range`'s parser, which returns a fragment already adopted
 * into the document that made the range. Every one of them is exercised
 * against known-bad input in `tests/no-raw-html.test.ts`.
 */
const MARKUP_SINKS: readonly { pattern: RegExp; detail: string }[] = [
  { pattern: /dangerouslySetInnerHTML/g, detail: "dangerouslySetInnerHTML" },
  { pattern: /\.(?:inner|outer)HTML\s*\+?=/g, detail: "innerHTML/outerHTML assignment" },
  { pattern: /insertAdjacentHTML\s*\(/g, detail: "insertAdjacentHTML" },
  { pattern: /setHTMLUnsafe\s*\(/g, detail: "setHTMLUnsafe" },
  { pattern: /createContextualFragment\s*\(/g, detail: "createContextualFragment" },
  { pattern: /new\s+DOMParser\s*\(/g, detail: "DOMParser" },
  { pattern: /parseHTMLUnsafe\s*\(/g, detail: "parseHTMLUnsafe" },
  { pattern: /document\.write(?:ln)?\s*\(/g, detail: "document.write" },
];

export function findMarkupSinks(text: string): Violation[] {
  const violations: Violation[] = [];

  text.split("\n").forEach((line, index) => {
    for (const sink of MARKUP_SINKS) {
      sink.pattern.lastIndex = 0;
      if (sink.pattern.test(line)) {
        violations.push({ line: index + 1, detail: `${sink.detail} makes markup out of text` });
      }
    }
  });

  return violations;
}

/* ------------------------------------------------------------ Key binds --- */

/**
 * Every way this stack has of binding a key.
 *
 * A React key prop — bubble or capture, since `onKeyDownCapture` and its two
 * siblings are ordinary props and fire *before* the target sees the key, which
 * makes them the loose binding most able to take a chord out from under the
 * router — a key listener on any target, a handler assigned straight onto an
 * element's `onkeydown` property, xterm's own custom key hook, and xterm's
 * `onKey` stream. There is one router (`src/keys/router.ts`) and
 * one seam into the emulator (`src/terminal/xterm.ts`); a fifth binding
 * anywhere else is a key the router's table does not know about, which is a
 * chord the command palette and the keys page would print the wrong answer for
 * — or worse, one taken out from under an agent CLI without anything on screen
 * saying so.
 */
const KEY_BINDINGS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bon(?:KeyDown|KeyUp|KeyPress)(?:Capture)?\b/g, what: "a React key prop" },
  {
    pattern: /addEventListener\s*\(\s*["'`]key(?:down|up|press)["'`]/g,
    what: "a key listener",
  },
  {
    pattern: /\.on(?:keydown|keyup|keypress)\s*=/g,
    what: "a key handler assigned onto an element",
  },
  { pattern: /\battachCustomKeyEventHandler\b/g, what: "xterm's custom key handler" },
  { pattern: /\.onKey\s*\(/g, what: "xterm's key stream" },
];

/**
 * The two files allowed to name any of them, and why — the same shape
 * `scripts/check-agent-solitude.mjs` uses, where one package in the tree is the
 * whole rule. The exception is one line long and visible from the check.
 */
export const KEY_BINDING_EXCEPTIONS: Readonly<Record<string, string>> = {
  "src/keys/router.ts": "the one router: the window listener itself",
  "src/terminal/xterm.ts": "the one seam into xterm, which asks that same router",
};

export function findKeyBindings(text: string): Violation[] {
  const violations: Violation[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const { pattern, what } of KEY_BINDINGS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        violations.push({
          line: index + 1,
          detail: `${what} (${match[0].trim()}) — put the chord in src/keys/router.ts instead`,
        });
      }
    }
  }
  return violations;
}

/* ---------------------------------------------------------------- SMIL --- */

/**
 * SMIL animation elements. `prefers-reduced-motion` does not touch SMIL, so a
 * liveness pulse authored this way survives the media query silently and
 * breaks the still-state rule in the one state that matters. CSS animation and
 * transitions only.
 */
const SMIL_ELEMENTS = [
  "animate",
  "animateTransform",
  "animateMotion",
  "animateColor",
  "set",
  "mpath",
] as const;

const SMIL_TAG = new RegExp(`<(${SMIL_ELEMENTS.join("|")})(?=[\\s/>])`, "g");

const SMIL_CREATED = new RegExp(
  `createElementNS\\s*\\([^)]*["'](${SMIL_ELEMENTS.join("|")})["']`,
  "g",
);

export function findSmil(text: string): Violation[] {
  const violations: Violation[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const pattern of [SMIL_TAG, SMIL_CREATED]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        violations.push({
          line: index + 1,
          detail: `SMIL <${match[1]}> — use a CSS animation or transition instead`,
        });
      }
    }
  }
  return violations;
}

/* --------------------------------------------------------- Token tiers --- */

/*
 * A custom property is *defined* where a declaration starts: at the top of a
 * line, or after a `{` or `;`. Anchoring to the line alone would miss
 * `.node { --p-local: 4px; }`, which is exactly how a tier-1 definition sneaks
 * back into a view.
 */
const DEFINITION_START = "(?:^|[{;])\\s*";
const PRIMITIVE_DEFINITION = new RegExp(`${DEFINITION_START}(--p-[a-z0-9-]+)\\s*:`, "gm");
const COMPONENT_DEFINITION = new RegExp(`${DEFINITION_START}(--c-[a-z0-9-]+)\\s*:`, "gm");
const SEMANTIC_DEFINITION = new RegExp(`${DEFINITION_START}(--s-[a-z0-9-]+)\\s*:`, "gm");
const CONSUMED = /var\(\s*(--[a-z0-9-]+)/g;

function matchAll(pattern: RegExp, text: string): string[] {
  pattern.lastIndex = 0;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

const COLOUR_LITERAL =
  /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\()/g;

export interface TierContext {
  /** The one file allowed to define `--p-*`. */
  primitivePath: string;
  /** The one file allowed to read a `--p-*`. */
  semanticPath: string;
  /** Every `--s-*` the semantic tier defines. */
  semanticTokens: ReadonlySet<string>;
}

export function definedTokens(text: string, kind: "p" | "s" | "c"): Set<string> {
  const pattern =
    kind === "p"
      ? PRIMITIVE_DEFINITION
      : kind === "s"
        ? SEMANTIC_DEFINITION
        : COMPONENT_DEFINITION;
  return new Set(matchAll(pattern, text));
}

/**
 * Views and chrome may consume semantic tokens only.
 *
 * Five rules, each of which is a way the middle tier stops being the rule:
 * a primitive defined outside the primitive file, a primitive read outside the
 * semantic file, a semantic token that does not exist (which fails silently at
 * runtime), a component token used where it is not defined, and a raw colour
 * literal, which is a retheme that will not land.
 */
export function findTierViolations(
  file: { path: string; text: string },
  context: TierContext,
): Violation[] {
  const violations: Violation[] = [];
  const isPrimitiveFile = file.path === context.primitivePath;
  const isSemanticFile = file.path === context.semanticPath;
  const localComponentTokens = definedTokens(file.text, "c");

  for (const [index, line] of file.text.split("\n").entries()) {
    const at = index + 1;

    if (!isPrimitiveFile) {
      for (const token of matchAll(PRIMITIVE_DEFINITION, line)) {
        violations.push({
          line: at,
          detail: `defines the tier-1 token ${token} outside ${context.primitivePath}`,
        });
      }
    }

    CONSUMED.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CONSUMED.exec(line)) !== null) {
      const token = match[1]!;
      if (token.startsWith("--p-") && !isSemanticFile) {
        violations.push({
          line: at,
          detail: `reads the tier-1 token ${token}; views may consume semantic tokens only`,
        });
      }
      if (token.startsWith("--s-") && !context.semanticTokens.has(token)) {
        violations.push({
          line: at,
          detail: `reads ${token}, which the semantic tier does not define`,
        });
      }
      if (token.startsWith("--c-") && !localComponentTokens.has(token)) {
        violations.push({
          line: at,
          detail: `reads the tier-3 token ${token}, which this file does not define`,
        });
      }
    }

    if (!isPrimitiveFile) {
      COLOUR_LITERAL.lastIndex = 0;
      let colour: RegExpExecArray | null;
      while ((colour = COLOUR_LITERAL.exec(line)) !== null) {
        violations.push({
          line: at,
          detail: `raw colour literal \`${colour[0]}\` — a retheme cannot reach it`,
        });
      }
    }
  }

  return violations;
}

/* -------------------------------------------------------------- Motion --- */

/**
 * A CSS block, with the preludes of the blocks enclosing it.
 *
 * Rule 9's ration is enumerable only because SMIL is banned
 * (`tests/no-smil.test.ts`): every animation in this app is CSS text, so
 * reading the text is reading the whole motion surface. This is the smallest
 * parser that can say *what a declaration is written on* — which selector, and
 * inside which at-rule — and both halves of the motion policy turn on that: an
 * animation is licensed by the selector it lands on, and a declaration inside
 * a `prefers-reduced-motion` guard means the opposite of the same declaration
 * outside one.
 */
interface CssDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly line: number;
}

interface CssBlock {
  readonly prelude: string;
  readonly line: number;
  /** Preludes of the enclosing blocks, outermost first. */
  readonly ancestors: readonly string[];
  readonly declarations: readonly CssDeclaration[];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseBlocks(text: string): CssBlock[] {
  /* Comments are blanked rather than deleted so every line number reported
     below is the line number a person will read in the file. */
  const source = text.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const blocks: CssBlock[] = [];
  const open: { prelude: string; line: number; declarations: CssDeclaration[] }[] = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;

  const flush = () => {
    const declaration = collapse(buffer);
    buffer = "";
    const enclosing = open[open.length - 1];
    if (declaration.length === 0 || enclosing === undefined) return;
    const colon = declaration.indexOf(":");
    if (colon === -1) return;
    const raw = declaration.slice(colon + 1).trim();
    enclosing.declarations.push({
      property: declaration.slice(0, colon).trim().toLowerCase(),
      value: raw.replace(/!\s*important$/i, "").trim(),
      important: /!\s*important$/i.test(raw),
      line: bufferLine,
    });
  };

  for (const char of source) {
    if (char === "{") {
      open.push({ prelude: collapse(buffer), line: bufferLine, declarations: [] });
      buffer = "";
    } else if (char === "}") {
      flush();
      const closed = open.pop();
      if (closed !== undefined) {
        blocks.push({ ...closed, ancestors: open.map((block) => block.prelude) });
      }
      buffer = "";
    } else if (char === ";") {
      flush();
    } else {
      if (buffer.trim().length === 0 && !/\s/.test(char)) bufferLine = line;
      buffer += char;
    }
    if (char === "\n") line += 1;
  }
  return blocks;
}

/** A declaration that spends motion: `animation`, shorthand or longhand. */
export interface MotionDeclaration {
  readonly line: number;
  /** The selector as authored, e.g. `.markClaimed::after`. */
  readonly selector: string;
  readonly property: string;
  readonly value: string;
  /** Keyframes names the declaration references, where it names any. */
  readonly names: readonly string[];
}

export interface KeyframesBlock {
  readonly line: number;
  readonly name: string;
}

export interface ReducedMotionBlock {
  readonly line: number;
  readonly selector: string;
  readonly declarations: readonly CssDeclaration[];
}

/**
 * The motion one stylesheet spends, and what it says under reduced motion.
 *
 * `transition` is absent by construction: a crossfade on colour, border or
 * opacity is not motion spent and is not rationed. What is counted is
 * `animation`, the only way a rendering moves on its own.
 */
export interface MotionSurface {
  readonly animations: readonly MotionDeclaration[];
  readonly keyframes: readonly KeyframesBlock[];
  readonly reducedMotion: readonly ReducedMotionBlock[];
}

const SUPPRESSION = /^(none|initial|unset|revert|revert-layer|inherit)$/i;

const ANIMATION_KEYWORDS = new Set([
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "none",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "infinite",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "initial",
  "inherit",
  "unset",
  "revert",
]);

/* Functional values — `var(--s-motion-ease)`, `cubic-bezier(…)`, `steps(…)` —
   are dropped whole: a token inside one is never a keyframes name, and a
   custom property's own name looks exactly like one. */
function keyframeNames(value: string): string[] {
  return value
    .replace(/[\w-]+\([^()]*\)/g, " ")
    .split(/[\s,]+/)
    .filter(
      (token) =>
        /^-?[a-zA-Z_][\w-]*$/.test(token) && !ANIMATION_KEYWORDS.has(token.toLowerCase()),
    );
}

function isReducedMotionGuard(prelude: string): boolean {
  return /@media[^{]*prefers-reduced-motion/i.test(prelude);
}

export function readMotion(text: string): MotionSurface {
  const animations: MotionDeclaration[] = [];
  const keyframes: KeyframesBlock[] = [];
  const reducedMotion: ReducedMotionBlock[] = [];

  for (const block of parseBlocks(text)) {
    const named = /^@(?:-[a-z]+-)?keyframes\s+("?)([\w-]+)\1/i.exec(block.prelude);
    if (named?.[2] !== undefined) keyframes.push({ line: block.line, name: named[2] });

    if (block.ancestors.some(isReducedMotionGuard)) {
      reducedMotion.push({
        line: block.line,
        selector: block.prelude,
        declarations: block.declarations,
      });
    }

    for (const declaration of block.declarations) {
      if (!declaration.property.startsWith("animation")) continue;
      if (SUPPRESSION.test(declaration.value)) continue;
      animations.push({
        line: declaration.line,
        selector: block.prelude,
        property: declaration.property,
        value: declaration.value,
        names: keyframeNames(declaration.value),
      });
    }
  }
  return { animations, keyframes, reducedMotion };
}

/**
 * One animation this app is allowed to run, and the claim it carries.
 *
 * The reason is a field rather than a comment because rule 9's tier is
 * asserted: there is no deviation route, so an animation is either licensed
 * with its claim written down or it comes out of the stylesheet.
 */
export interface LicensedMotion {
  readonly path: string;
  readonly selector: string;
  readonly keyframes: string;
  /** The liveness claim the motion is spent on. */
  readonly carries: string;
}

/**
 * Motion spent anywhere the ration does not reach.
 *
 * Three ways past the ration, and the licence is per selector *and* per
 * keyframes name so none of them is a rename away: a second `@keyframes`
 * block, an `animation` declaration on any other selector, and the licensed
 * selector quietly driving different keyframes.
 */
export function findMotionViolations(
  file: { path: string; text: string },
  licensed: readonly LicensedMotion[],
): Violation[] {
  const violations: Violation[] = [];
  const here = licensed.filter((entry) => entry.path === file.path);
  const surface = readMotion(file.text);

  for (const animation of surface.animations) {
    const entry = here.find((candidate) => candidate.selector === animation.selector);
    if (entry === undefined) {
      violations.push({
        line: animation.line,
        detail: `\`${animation.property}\` on \`${animation.selector}\` — motion is rationed to the running-vs-stale claim, and this selector carries none`,
      });
      continue;
    }
    for (const name of animation.names) {
      if (name !== entry.keyframes) {
        violations.push({
          line: animation.line,
          detail: `\`${animation.selector}\` runs \`${name}\`; its licence is for \`${entry.keyframes}\` — ${entry.carries}`,
        });
      }
    }
  }

  for (const block of surface.keyframes) {
    if (!here.some((entry) => entry.keyframes === block.name)) {
      violations.push({
        line: block.line,
        detail: `\`@keyframes ${block.name}\` is motion no view is licensed to spend`,
      });
    }
  }

  return violations;
}

/* ------------------------------------------ motion outside the ration --- */

/**
 * Motion spent where the ration's enumeration cannot see it.
 *
 * `findMotionViolations` reads CSS text, and the ration is only ever as wide
 * as the walk that feeds it: the `.css` files under `src/`. Nothing in this
 * repo forbids an inline style, a `<style>` block inside an `.svg`, a
 * `@keyframes` in the root `index.html`, or an animation started from script
 * through the Web Animations API — which writes no CSS text at all — so motion
 * authored any of those ways would be licensed by nobody and caught by nothing
 * — and rule 12's still-form obligation, which is derived from the same walk,
 * would not reach it either.
 *
 * This is the companion guard that closes the gap, over the same wider net
 * `tests/no-smil.test.ts` already establishes as this repo's motion surface
 * (`collectMarkupAndStyles`). Outside a rationed stylesheet an animation is not
 * licensable at all, so this is a flat prohibition rather than a list: the fix
 * for a red is to move the motion into a stylesheet and argue for its licence
 * there, which is where an argument about spending the ration belongs.
 */
const RATIONED_STYLESHEET = /^src\/.*\.css$/;

const STRAY_MOTION: readonly { readonly pattern: RegExp; readonly detail: string }[] = [
  {
    /* The name is required, not decoration: `@keyframes` with nothing after it
       is not a keyframes block, and demanding the name is what keeps the check
       off the registry's own prose, which names the construct in backticks. */
    pattern: /@(?:-[a-z]+-)?keyframes\s+[A-Za-z_-][\w-]*/gi,
    detail: "a keyframes block outside a rationed stylesheet — motion the ration cannot enumerate",
  },
  {
    pattern: /\banimation(?:-name|Name)?\s*:/g,
    detail: "an `animation` declaration outside a rationed stylesheet — motion no licence covers",
  },
  {
    pattern: /\.style\s*\.\s*animation(?:Name)?\b|setProperty\(\s*["']animation(?:-name)?["']/g,
    detail: "an `animation` assigned from script — motion written past the stylesheets entirely",
  },
  {
    /* The Web Animations API, which spends motion with no CSS text anywhere:
       `element.animate([...], {...})`, an `Animation` constructed by hand, or a
       handle taken with `getAnimations()` and played. The three patterns above
       all read as CSS in the end — a keyframes block, a declaration, a property
       written onto a style attribute — and none of them sees this one. It is
       the most idiomatic way to move something from script, so leaving it out
       would be the widest hole in the net: motion unlicensed by rule 9, and
       owing no still form under rule 12, whose obligation is derived from the
       same stylesheet walk. */
    pattern: /\.animate\s*\(|new\s+Animation\s*\(|getAnimations\s*\(/g,
    detail:
      "the Web Animations API driven from script — motion written past the stylesheets entirely",
  },
];

export function findStrayMotion(file: { path: string; text: string }): Violation[] {
  if (RATIONED_STYLESHEET.test(file.path)) return [];

  const violations: Violation[] = [];
  for (const [index, line] of file.text.split("\n").entries()) {
    for (const { pattern, detail } of STRAY_MOTION) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) violations.push({ line: index + 1, detail });
    }
  }
  return violations;
}

/*
 * Travel is displacement and size, never colour. The roots are matched as
 * prefixes so `margin-top` and `inset-inline-start` need no listing, and
 * `border-right-color` — a colour, and one that survives — matches none of
 * them.
 */
const TRAVEL_ROOTS = [
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "offset",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "margin",
  "padding",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "gap",
  "row-gap",
  "column-gap",
  "flex-basis",
];

function isTravel(property: string): boolean {
  return TRAVEL_ROOTS.some((root) => property === root || property.startsWith(`${root}-`));
}

/** The first token of each comma-separated part: `opacity 200ms ease` → `opacity`. */
export function transitionedProperties(value: string): string[] {
  return value
    .split(",")
    .map((part) => collapse(part).split(" ")[0]?.toLowerCase() ?? "")
    .filter((property) => property.length > 0 && !/^[\d.]/.test(property));
}

/**
 * A reduced-motion block that says the wrong thing.
 *
 * The default this app owes is *travel suppressed, colour kept*: the trigger
 * is movement, so looping animation and transform-driven travel go, and
 * opacity, colour and stroke crossfades stay. Both failures are here — travel
 * let back in, and the blanket `transition: none` that takes the crossfades
 * with it — plus the structural one: a second guard elsewhere under `src/`,
 * which is how either failure arrives without anyone touching the global
 * block.
 *
 * This walks CSS text. It settles what the stylesheets declare under the media
 * query, not what a browser computes with the query on; that reading is rule
 * 12's, over a rendering.
 */
export function findReducedMotionViolations(
  file: { path: string; text: string },
  guardPath: string,
): Violation[] {
  const violations: Violation[] = [];

  for (const block of readMotion(file.text).reducedMotion) {
    if (file.path !== guardPath) {
      violations.push({
        line: block.line,
        detail: `opens its own \`prefers-reduced-motion\` block on \`${block.selector}\`; the default is global (${guardPath}) and a second one either lets travel back in or blankets the crossfades`,
      });
    }

    for (const { property, value, line } of block.declarations) {
      if (property === "transition" || property === "transition-property") {
        for (const transitioned of transitionedProperties(value)) {
          if (transitioned === "none") {
            violations.push({
              line,
              detail:
                "turns transitions off wholesale; a crossfade on opacity, colour or stroke is not travel and is not what reduced motion asks to lose",
            });
          } else if (transitioned === "all") {
            violations.push({
              line,
              detail: "`all` under reduced motion lets transform and geometry keep travelling",
            });
          } else if (isTravel(transitioned)) {
            violations.push({
              line,
              detail: `keeps \`${transitioned}\` transitioning under reduced motion; the trigger is travel, not colour`,
            });
          }
        }
      }

      if (property === "transition-duration" && /^0m?s$/i.test(value)) {
        violations.push({
          line,
          detail: "zeroes every transition; the crossfades are meant to survive",
        });
      }

      if (property.startsWith("animation") && !SUPPRESSION.test(value)) {
        violations.push({
          line,
          detail: `\`${property}: ${value}\` runs under reduced motion; looping animation is what the guard exists to kill`,
        });
      }

      if (isTravel(property) && !/^(none|auto|0|0px|initial|unset|revert)$/i.test(value)) {
        violations.push({
          line,
          detail: `\`${property}: ${value}\` puts travel back under reduced motion`,
        });
      }
    }
  }

  return violations;
}

/* ------------------------------------------------------- View prop type --- */

/**
 * The fields of the one `ViewProps` declaration, or `null` where there is none.
 *
 * Rule 7 of the encoding contract is structural *because of this declaration*:
 * a registry entry that names a mechanism nobody re-reads is a claim about the
 * day it was written. `tests/views.test.ts` asserts the same shape from the
 * other side — it is the rule's own test — and this is the registry checking
 * that the mechanism it points at is still there.
 *
 * The declaration only, never the file: the file has to import the type it
 * names and that import path spells `snapshot`, so a scan of the file would
 * fail on the import and pass on a `snapshot: Snapshot` field, which is the
 * whole of the distance between a structural exclusion and a rule.
 */
export function viewPropsFields(text: string): string[] | null {
  const body = /export interface ViewProps \{([^}]*)\}/.exec(text)?.[1];
  if (body === undefined) return null;
  return body
    .split(";")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

export function format(path: string, violations: readonly Violation[]): string {
  return violations.map((v) => `${path}:${v.line}  ${v.detail}`).join("\n");
}
