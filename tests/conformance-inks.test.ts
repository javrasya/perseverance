/**
 * The ink probe reads the ink the view actually paints with.
 *
 * Rule 3's first assertion — collapse every semantic token, then find one ink
 * across an unclassified row and a ticket's — is the experiment ADR 0020 names:
 * it proves colour is gone as a channel *before* the word distinction below it
 * is read. It only proves that over the properties it looks at. A probe holding
 * one fixed list of HTML colour properties reads `fill` and `stroke` nowhere,
 * so on a view that draws its marks in SVG it finds one ink whatever the marks
 * are painted — and would find one ink on a view that told every kind apart by
 * hue alone. That is a vacuous green in the one assertion whose whole job is to
 * make the rest non-vacuous.
 *
 * So each view names the properties its glyph carries ink on
 * (`ViewSurface.inks`), and this holds that declaration to the view's own
 * stylesheet: every property the view paints its glyph token in has to be one
 * the probe reads. It runs under vitest, over source text, because the question
 * is *what does this view paint in* — answerable without a browser, and so
 * answerable inside `npm run verify`, which is what a branch's greenness is
 * judged by. The browser suite then asks the other half: whether those
 * properties resolve to one ink once the tokens are collapsed.
 */

import { describe, expect, it } from "vitest";
import { VIEWS } from "../src/views/views";
import { surfaceOf } from "./conformance/support/views";
import { collectStylesheets } from "./support/sources";

/** The glyph token of any view: `--c-node-glyph`, `--c-plate-glyph`, the next one. */
const GLYPH_TOKEN = /var\(\s*--c-[a-z-]*glyph\b/;

/**
 * The computed property a shorthand lands the paint on, which is what
 * `getComputedStyle` will be asked for. `border: 1.5px solid var(…)` is read
 * back as `border-top-color`, and `background: var(…)` as `background-color`.
 */
const COMPUTED: Record<string, string> = {
  background: "background-color",
  "background-color": "background-color",
  border: "border-top-color",
  "border-color": "border-top-color",
  "border-top": "border-top-color",
  "border-top-color": "border-top-color",
  /* An edge painted on its own side lands on that side's colour, which is a
     different computed property from `border-top-color` and a different
     question for the probe: the Bench tells a kind apart on the stud's left
     edge alone. */
  "border-left": "border-left-color",
  "border-left-color": "border-left-color",
  "border-right": "border-right-color",
  "border-right-color": "border-right-color",
  "border-bottom": "border-bottom-color",
  "border-bottom-color": "border-bottom-color",
};

/** Every property one view's stylesheets paint the glyph token in. */
function paintedWith(view: string): string[] {
  const sheets = collectStylesheets().filter((file) =>
    file.path.startsWith(`src/views/${view}/`),
  );
  const properties = new Set<string>();
  for (const sheet of sheets) {
    /* Comments first: prose has colons and semicolons in it, and a sentence
       above a declaration would otherwise read as a property name. */
    const css = sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const declaration of css.split(";")) {
      const at = declaration.indexOf(":");
      if (at < 0) continue;
      const property = declaration.slice(0, at).trim().split(/\s/).pop() ?? "";
      if (property === "" || property.startsWith("--")) continue;
      if (!GLYPH_TOKEN.test(declaration.slice(at))) continue;
      properties.add(COMPUTED[property] ?? property);
    }
  }
  return [...properties].sort();
}

describe("rule 3's ink probe reads what each view paints in", () => {
  /* The counting has to be able to say no, so it is proved against a name
     nothing is painted under before it is trusted about the real ones. */
  it("finds no painted property in a view that does not exist", () => {
    expect(paintedWith("no-such-view")).toEqual([]);
  });

  for (const view of VIEWS) {
    it(`${view} declares every property it paints its glyph in`, () => {
      const painted = paintedWith(view);
      expect(painted.length, "this view paints its glyph token nowhere").toBeGreaterThan(0);
      expect(
        painted.filter((property) => !surfaceOf(view).inks.includes(property)),
        "properties this view carries a kind difference on that the ink probe never reads, so the collapse is satisfied without proving anything",
      ).toEqual([]);
    });
  }
});
