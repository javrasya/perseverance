/**
 * The two stack-level prohibitions, as pure functions over text.
 *
 * They are separated from the tests that call them so the checks themselves
 * can be tested against known-bad input. A check nobody has ever seen fail is
 * indistinguishable from a check that cannot fail.
 */

export interface Violation {
  line: number;
  detail: string;
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

export function format(path: string, violations: readonly Violation[]): string {
  return violations.map((v) => `${path}:${v.line}  ${v.detail}`).join("\n");
}
