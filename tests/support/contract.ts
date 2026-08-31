/**
 * The human half of the encoding contract, as pure functions over text.
 *
 * A judged rule is kept by a person, and the only artifact a person leaves is
 * prose. So the automation here is deliberately shallow: it settles *presence*
 * — that a view has written something falsifiable under every judged rule — and
 * it refuses to weigh the content, because a check that graded the content
 * would be the assertion the tier already said cannot exist.
 *
 * Two things it does read for. A **checkbox** is a form failure rather than a
 * bad answer: a box invites ticking, and a ticked box is a declaration that
 * says nothing about the view. And a paragraph opening `Deviation:` is the one
 * piece of structure the format has, so the worklist can lift a declared
 * deviation out verbatim rather than somebody maintaining a second list of them
 * beside the declarations.
 *
 * See `docs/adr/0020-the-contract-is-thirteen-rules-in-three-tiers.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleId } from "../../src/contract/rules";
import type { Violation } from "./checks";
import { REPO_ROOT } from "./sources";

export const DECLARATIONS_DIR = "docs/contract/declarations";
export const MATRIX_PATH = "docs/contract/matrix.md";

/** Repo-relative, forward-slashed, so a failure message is pasteable. */
export function declarationPath(view: string): string {
  return `${DECLARATIONS_DIR}/${view}.md`;
}

export interface DeclaredSection {
  readonly ruleId: RuleId;
  /** The heading line, verbatim, so a failure can quote what it read. */
  readonly heading: string;
  /** Everything under the heading, deviations included. */
  readonly body: string;
  /** Paragraphs opening `Deviation:`, verbatim and in document order. */
  readonly deviations: readonly string[];
  /** The body with the deviation paragraphs removed: what the view *does*. */
  readonly statement: string;
}

export interface ParsedDeclaration {
  readonly sections: readonly DeclaredSection[];
  /**
   * Present so a test can go red on the form. Not a warning — the format has
   * one prohibition and this is it.
   */
  readonly checkboxes: readonly Violation[];
}

const SECTION_HEADING = /^##\s+Rule\s+(\d{1,2})\b/;
/* A list item with a box, ticked or not, in any of markdown's three bullets or
   an ordered item — every form of the thing that must not be here. */
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]?\]/;
const DEVIATION_OPENER = /^Deviation:/;
/* A section ends at the next heading of its own depth or shallower, so a
   declaration can carry a preamble and a closing note without either being
   read as prose about a rule. */
const CLOSING_HEADING = /^#{1,2}\s/;

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export function parseDeclaration(text: string): ParsedDeclaration {
  const sections: DeclaredSection[] = [];
  const checkboxes: Violation[] = [];

  let heading: string | null = null;
  let ruleId = 0;
  let body: string[] = [];

  const close = (): void => {
    if (heading === null) return;
    const whole = body.join("\n").trim();
    const blocks = paragraphs(whole);
    sections.push({
      ruleId: ruleId as RuleId,
      heading,
      body: whole,
      deviations: blocks.filter((block) => DEVIATION_OPENER.test(block)),
      statement: blocks.filter((block) => !DEVIATION_OPENER.test(block)).join("\n\n"),
    });
    heading = null;
    body = [];
  };

  for (const [index, line] of text.split("\n").entries()) {
    if (CHECKBOX.test(line)) {
      checkboxes.push({
        line: index + 1,
        detail:
          "a checkbox in a declaration — a box gets ticked, and a ticked box declares nothing about the view",
      });
    }

    const match = SECTION_HEADING.exec(line);
    if (match) {
      close();
      heading = line.trim();
      ruleId = Number(match[1]);
      continue;
    }

    if (heading !== null && CLOSING_HEADING.test(line)) {
      close();
      continue;
    }

    if (heading !== null) body.push(line);
  }
  close();

  return { sections, checkboxes };
}

export interface ViewDeclaration {
  readonly view: string;
  readonly path: string;
  /** null where the file does not exist, which is the hole the gate closes. */
  readonly parsed: ParsedDeclaration | null;
}

export function readDeclaration(view: string): ViewDeclaration {
  const path = declarationPath(view);
  const full = join(REPO_ROOT, path);
  if (!existsSync(full)) return { view, path, parsed: null };
  return { view, path, parsed: parseDeclaration(readFileSync(full, "utf8")) };
}

export function sectionFor(
  declaration: ViewDeclaration,
  id: RuleId,
): DeclaredSection | undefined {
  return declaration.parsed?.sections.find((section) => section.ruleId === id);
}

/* ------------------------------------------------------- fixture space --- */

/**
 * The two axes that are not the fixtures.
 *
 * A theme is a `prefers-color-scheme` reassignment in `semantic.css` and motion
 * is the `prefers-reduced-motion` guard in `global.css`: two media queries,
 * each with exactly one alternative, and neither is a list that grows when a
 * state is added. The fixture names are, which is why they are read from
 * `FIXTURE_NAMES` and never written here.
 */
export const THEMES = ["light", "dark"] as const;
export const MOTION = ["full", "reduced"] as const;

export interface FixtureState {
  readonly fixture: string;
  readonly theme: (typeof THEMES)[number];
  readonly motion: (typeof MOTION)[number];
}

/**
 * Every state a render-bound rule has to hold in, derived from the fixtures.
 *
 * Deliberately *not* crossed with the rules. The unit of conformance is the
 * rule, and a rule × state product is a grid of cells nobody reads and everyone
 * maintains; #43 fans one assertion out over this space, and the rule stays one
 * row whatever the fan-out's size.
 */
export function fixtureSpace(names: readonly string[]): FixtureState[] {
  return names.flatMap((fixture) =>
    THEMES.flatMap((theme) => MOTION.map((motion) => ({ fixture, theme, motion }))),
  );
}
