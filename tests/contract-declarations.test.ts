import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RULES,
  type Rule,
  type RuleId,
  deviationFor,
  renderBoundRules,
} from "../src/contract/rules";
import { FIXTURE_NAMES } from "../src/snapshot/fixtures";
import { VIEWS } from "../src/views/views";
import {
  DECLARATIONS_DIR,
  declarationPath,
  fixtureSpace,
  parseDeclaration,
  readDeclaration,
  sectionFor,
} from "./support/contract";
import { worklist } from "./support/matrix";
import { REPO_ROOT, SRC_ROOT, collectFrom } from "./support/sources";

/**
 * The three gates, and the presence check they are built on.
 *
 * The registry says which rules a person keeps. It cannot say whether the
 * person did — that is what a declaration is for, and a declaration nobody
 * wrote is indistinguishable from a rule nobody has a problem with. So what is
 * asserted here is **presence, never content**: a judged rule × a registered
 * view must have prose under it, and the prose is free to say the view does not
 * comply. Grading the prose would be the assertion the tier said cannot exist.
 *
 * Each gate is keyed to what changed — a fixture, a view, a rule — and each is
 * driven off the list the change would have to touch, so the gate goes red on
 * the same commit rather than on the one that notices.
 */

const JUDGED = RULES.filter((rule) => deviationFor(rule).declarable);

/* Long enough that a stub cannot pass as an answer, short enough that a real
   one-paragraph answer is not being asked to pad. The registry test holds its
   own prose to the same shape. */
const STATEMENT_FLOOR = 200;

function judgedIds(): RuleId[] {
  return JUDGED.map((rule) => rule.id);
}

describe("the declaration parser, against input it has to reject", () => {
  const good = [
    "# A view — declarations",
    "",
    "## Rule 4 — Absence is never zero",
    "",
    "The region names itself and then counts itself.",
    "",
    "Deviation: the second absence is drawn as a numeral in a lighter face.",
    "",
    "## Rule 10 — Hover discloses nothing",
    "",
    "Nothing happens on hover.",
    "",
    "## Notes",
    "",
    "Not prose about a rule.",
  ].join("\n");

  it("keys sections by rule id and lifts deviations out verbatim", () => {
    const parsed = parseDeclaration(good);

    expect(parsed.sections.map((section) => section.ruleId)).toEqual([4, 10]);
    expect(parsed.checkboxes).toEqual([]);
    expect(parsed.sections[0]?.deviations).toEqual([
      "Deviation: the second absence is drawn as a numeral in a lighter face.",
    ]);
    expect(parsed.sections[0]?.statement).toBe(
      "The region names itself and then counts itself.",
    );

    // A closing heading ends the last section rather than being swallowed by
    // it, so a file can carry a preamble and a note without either reading as
    // an answer to rule 10.
    expect(parsed.sections[1]?.body).toBe("Nothing happens on hover.");
  });

  it("fires on a checkbox, in every form markdown spells one", () => {
    const ticked = [
      "## Rule 4 — Absence is never zero",
      "",
      "- [x] the region names itself",
      "* [ ] the count is not a zero",
      "1. [ ] and the dash is a dash",
    ].join("\n");

    expect(parseDeclaration(ticked).checkboxes.map((box) => box.line)).toEqual([
      3, 4, 5,
    ]);
    expect(parseDeclaration(ticked).checkboxes[0]?.detail).toMatch(/ticked box/);
  });

  it("fires on a section that was opened and never written", () => {
    const empty = "## Rule 11 — The field is not the label surface\n\n";
    const parsed = parseDeclaration(empty);

    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.statement).toBe("");
  });

  it("fires on a section deleted out of an otherwise complete file", () => {
    const deleted = good.replace(/## Rule 10[\s\S]*?(?=## Notes)/, "");

    expect(parseDeclaration(deleted).sections.map((s) => s.ruleId)).toEqual([4]);
  });

  it("does not read a deviation out of a paragraph that only mentions one", () => {
    const mentioned = [
      "## Rule 13 — Resolved stays locatable",
      "",
      "The floor is met, and this is not a Deviation: it is the answer.",
    ].join("\n");

    expect(parseDeclaration(mentioned).sections[0]?.deviations).toEqual([]);
  });
});

describe("presence is asserted, content is judged", () => {
  it("gives every registered view a declaration file", () => {
    for (const view of VIEWS) {
      const declaration = readDeclaration(view);
      expect(declaration.parsed, `missing ${declaration.path}`).not.toBeNull();
      expect(declaration.parsed?.checkboxes ?? []).toEqual([]);
    }
  });

  it("gives every judged rule prose that could say the view does not comply", () => {
    for (const view of VIEWS) {
      const declaration = readDeclaration(view);
      for (const rule of JUDGED) {
        const section = sectionFor(declaration, rule.id);
        expect(section, `${declaration.path} declares nothing under rule ${rule.id}`)
          .toBeDefined();
        expect(
          section?.statement.length ?? 0,
          `${declaration.path} rule ${rule.id} is a stub`,
        ).toBeGreaterThan(STATEMENT_FLOOR);
      }
    }
  });

  it("leaves structural and asserted rules no section and no route", () => {
    const declarable = new Set<number>(judgedIds());

    for (const rule of RULES) {
      if (declarable.has(rule.id)) continue;
      expect(deviationFor(rule).declarable).toBe(false);
      for (const view of VIEWS) {
        expect(
          sectionFor(readDeclaration(view), rule.id),
          `${declarationPath(view)} declares under ${rule.tier} rule ${rule.id}`,
        ).toBeUndefined();
      }
    }
  });

  it("keeps no declaration file for a view that is not registered", () => {
    const registered = new Set(VIEWS.map((view) => declarationPath(view)));
    const found = collectFrom(join(REPO_ROOT, DECLARATIONS_DIR), [".md"]);

    expect(found.map((file) => file.path).sort()).toEqual([...registered].sort());
  });
});

describe("gate: adding a state ships one fixture", () => {
  it("derives the fixture space rather than keeping a list beside it", () => {
    const space = fixtureSpace(FIXTURE_NAMES);

    expect(space).toHaveLength(FIXTURE_NAMES.length * 4);
    for (const name of FIXTURE_NAMES) {
      expect(space.filter((state) => state.fixture === name)).toHaveLength(4);
    }

    // States, not cells: the space has no rule dimension, because the unit of
    // conformance is the rule and a rule × state product is a grid nobody reads
    // and everybody maintains. #43 fans one assertion out over this.
    expect(Object.keys(space[0] ?? {})).toEqual(["fixture", "theme", "motion"]);
    expect(renderBoundRules().length).toBeGreaterThan(0);
  });

  it("finds no second enumeration a new fixture would have to be added to", () => {
    const enumerating = [
      ...collectFrom(SRC_ROOT, [".ts", ".tsx"]),
      ...collectFrom(join(REPO_ROOT, "tests"), [".ts", ".tsx"]),
      ...collectFrom(join(REPO_ROOT, "docs", "contract"), [".md"]),
    ].filter((file) => FIXTURE_NAMES.every((name) => file.text.includes(name)));

    // Naming some fixtures is using them; naming all of them is a parallel
    // list, and a parallel list is the thing that silently stays one fixture
    // behind. Exactly one file is allowed to be complete.
    expect(enumerating.map((file) => file.path)).toEqual(["src/snapshot/fixtures.ts"]);
  });
});

describe("gate: adding a view brings the fixture space and the declarations with it", () => {
  it("registers red for any view without a full declaration, from VIEWS", () => {
    expect(VIEWS.length).toBeGreaterThan(0);

    const missing = VIEWS.flatMap((view) => {
      const declaration = readDeclaration(view);
      return JUDGED.filter(
        (rule) => (sectionFor(declaration, rule.id)?.statement.length ?? 0) === 0,
      ).map((rule) => `${declaration.path}: rule ${rule.id}`);
    });

    expect(missing).toEqual([]);
  });

  it("counts a second view as a hole the moment it is registered", () => {
    // The gate is driven off `VIEWS`, so this is what the assertion above does
    // on the commit that adds one: a name with no file is a missing
    // declaration for every judged rule, immediately and without an edit here.
    const unregistered = readDeclaration("deep-field");

    expect(unregistered.parsed).toBeNull();
    expect(sectionFor(unregistered, 13)).toBeUndefined();
  });
});

describe("gate: adding a rule declares its tier, and a judged one retro-fits", () => {
  it("keeps the count pinned so a fourteenth rule is a deliberate edit", () => {
    expect(RULES).toHaveLength(13);
    expect(RULES.map((rule) => rule.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    for (const rule of RULES) {
      expect(["structural", "asserted", "judged"]).toContain(rule.tier);
    }
  });

  it("asserts every judged rule against every registered view, from the rules", () => {
    expect(judgedIds()).toEqual([4, 10, 11, 12, 13]);

    const holes = JUDGED.flatMap((rule: Rule) =>
      VIEWS.filter(
        (view) => (sectionFor(readDeclaration(view), rule.id)?.statement.length ?? 0) === 0,
      ).map((view) => `rule ${rule.id} × ${view}`),
    );

    expect(holes).toEqual([]);
  });
});

describe("declared deviations are a worklist, never a carve-out", () => {
  const declarations = VIEWS.map((view) => readDeclaration(view));

  it("collects each declared deviation verbatim from the file that declares it", () => {
    const items = worklist(RULES, declarations);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.text.startsWith("Deviation:")).toBe(true);
      expect(deviationFor(item.rule).declarable).toBe(true);

      const body = sectionFor(readDeclaration(item.view), item.rule.id)?.body ?? "";
      expect(body).toContain(item.text);
    }
  });

  it("finds none under a rule whose tier grants no appeal", () => {
    const withoutRoute = RULES.filter((rule) => !deviationFor(rule).declarable);

    expect(worklist(withoutRoute, declarations)).toEqual([]);
  });
});
