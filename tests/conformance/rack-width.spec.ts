import { expect, test, type Page } from "@playwright/test";
import { DETENTS, type Detent } from "../../src/panes/dial";
import {
  RACK_FLOOR,
  RACK_RESERVE,
  SHOWN,
  TIER_FLOORS,
  regionFor,
  tierFor,
  type Tier,
} from "../../src/rack/rack";
import { DEFAULT_FIXTURE } from "../../src/snapshot/fixtures";
import { DEFAULT_VIEW } from "../../src/views/views";
import { fixtureSpace, type FixtureState } from "../support/contract";
import { load } from "./support/drive";

/**
 * The rack's width, in a browser that actually lays it out.
 *
 * Every claim #56 makes about this region is a *layout* claim — three tiers
 * chosen from a measurement, a region that never closes to zero at the `map`
 * detent, a width that moves on a press and on nothing else — and none of them
 * can be settled where the boxes are imaginary. `tests/rack.test.tsx` stubs
 * `getBoundingClientRect` to a number of its own, which proves `tierFor` is a
 * pure function and nothing at all about what is drawn; jsdom answers zero for
 * every box, so a rack that had come loose from the terminal side would still
 * read as `studs` there and pass. Both of the defects this branch fixed — the
 * pane's content-derived flex basis, and a `max-width` cap that had drifted
 * from `sides()` — were invisible to a green suite for exactly that reason.
 *
 * So this file measures. It is deliberately not a contract rule and declares
 * none: the rack is chrome, it is not in `views.ts`, and
 * `tests/conformance-coverage.test.ts` counts rules rather than specs. What it
 * is instead is the one place where the arithmetic three files apart —
 * [`sides`] in `src/panes/dial.ts`, [`regionFor`] in `src/rack/rack.ts`, and
 * the flexbox those two describe — is asked whether the browser agrees.
 *
 * The dial is walked rather than written to. *The width changes only on a
 * press* is one of the things under test, so a spec that moved the store
 * directly would have skipped the mechanism it is here to check; every position
 * below is reached through the separator's own keyboard, which is a gesture an
 * operator has.
 */

/** The rack's address in the chrome. It is not a view, so no surface declares it. */
const RACK = 'section[aria-label="The rack"]';

/** One point of the fixture space, taken from the crossing rather than invented. */
function state(fixture: string): FixtureState {
  const found = fixtureSpace([fixture]).find(
    (point) => point.theme === "light" && point.motion === "full",
  );
  if (found === undefined) throw new Error(`no such fixture: ${fixture}`);
  return found;
}

const LIT = state(DEFAULT_FIXTURE);

/**
 * The window a developer opens the app in, and one narrower than that.
 *
 * The default is Playwright's own device width, so *what the rack is worth on
 * an ordinary window* is not a number this file made up. The narrow one is
 * there because a single width cannot tell a region sized by the dial apart
 * from a region sized by a constant.
 */
const WINDOWS = [
  { name: "a default window", width: 1280, height: 720 },
  { name: "a narrow window", width: 820, height: 720 },
] as const;

interface Measured {
  /** The region's own box, which is what `tierFor` is a function of. */
  readonly region: number;
  /** The terminal side the region sits in — the pane's box plus this one's. */
  readonly side: number;
  /** The tier the rack says it drew at. */
  readonly tier: Tier;
  /**
   * The pane's own two hairlines, which are the floor under `flex-basis: 0`.
   *
   * A flex item is never laid out narrower than its own border box, so on a
   * terminal side short enough to make the rack shrink at all, the pane keeps
   * these and the region is that much under what [`regionFor`] prints. Measured
   * rather than named: the point of reading it off the layout is that the spec
   * says *the region is the remainder, less whatever the pane cannot give up*
   * rather than *the region is the remainder, give or take a couple of pixels*.
   */
  readonly hairlines: number;
}

/**
 * The rack, its side, and the tier on it — read in one go from the real layout.
 *
 * The side is reached as the region's parent rather than by class name: the
 * class is a CSS-module hash, and a selector spelled from one is a spec that
 * breaks on a rename instead of on a regression.
 */
async function measure(page: Page): Promise<Measured> {
  return await page.locator(RACK).evaluate((rack) => {
    const side = rack.parentElement;
    if (side === null) throw new Error("the rack is not in the terminal side");
    const pane = rack.nextElementSibling;
    if (pane === null) throw new Error("the rack has no pane beside it");
    const edges = getComputedStyle(pane);
    return {
      region: rack.getBoundingClientRect().width,
      side: side.getBoundingClientRect().width,
      tier: rack.getAttribute("data-tier") as Tier,
      hairlines:
        parseFloat(edges.borderLeftWidth) + parseFloat(edges.borderRightWidth),
    };
  });
}

/** Two frames, so a layout effect's remeasure has been committed and painted. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

/**
 * The dial, put on a detent the way an operator puts it there.
 *
 * `Home` is the bottom of the ladder and `PageUp` is one detent up it, so every
 * position is reached by pressing the control rather than by writing the store
 * — and the walk passes through the detents between, which is what an operator
 * dragging past them does.
 */
async function turnTo(page: Page, detent: Detent): Promise<void> {
  const dial = page.getByRole("separator");
  await dial.focus();
  await dial.press("Home");
  for (let up = DETENTS.indexOf(detent); up > 0; up -= 1) await dial.press("PageUp");
  await expect(dial).toHaveAttribute("data-detent", detent);
  await settled(page);
}

test.describe("the rack's width, at every detent", () => {
  for (const window of WINDOWS) {
    for (const detent of ["terminal", "split", "map"] as const) {
      test(`stands on its floor at ${detent} — ${window.name}`, async ({ page }) => {
        /* Booted at the device's own width and resized afterwards, because the
           driver waits for the view root and the narrow window sheds the view
           column — a shed column is the map side's business and none of the
           rack's, and a spec that could not open a narrow window would be a
           spec that only ever measured one. */
        await load(page, DEFAULT_VIEW, LIT);
        await page.setViewportSize({ width: window.width, height: window.height });
        await settled(page);
        await turnTo(page, detent);

        const rack = await measure(page);

        /* The region never closes to zero, at any position of the control that
           can close it: at `map` the pane is worth nothing and this is what is
           left standing. */
        expect(rack.region).toBeGreaterThanOrEqual(RACK_FLOOR);

        /* And it is worth what the arithmetic says it is worth. This is the
           assertion the two fixed defects would have failed: a pane with a
           content-derived basis takes its share of the shrinkage and leaves the
           region hundreds of pixels short of `regionFor`, and a cap that
           disagrees with `sides()` hands the terminal side a width `regionFor`
           was never asked about. The slack below is the pane's two hairlines and
           the half-pixel a flexbox resolves fractions to — nothing that could
           absorb either defect, both of which move this by tiers. */
        expect(rack.region).toBeLessThanOrEqual(regionFor(rack.side) + 1);
        expect(rack.region).toBeGreaterThanOrEqual(
          regionFor(rack.side) - rack.hairlines - 1,
        );

        /* The tier that drew is the tier the measurement asks for — the rack
           reading its own box, rather than `tierFor` being pure in a vacuum. */
        expect(rack.tier).toBe(tierFor(rack.region));
      });
    }
  }

  test("is drawn at bays on an ordinary window", async ({ page }) => {
    /* The widest tier has to be somewhere an operator actually is, or the two
       tiers below it are the whole rack and `bays` is dead markup. */
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page, DEFAULT_VIEW, LIT);
    await turnTo(page, "split");

    const rack = await measure(page);

    expect(rack.region).toBeGreaterThanOrEqual(TIER_FLOORS.bays);
    expect(rack.tier).toBe("bays");
  });

  test("keeps the far detent's remainder, and spends it on studs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page, DEFAULT_VIEW, LIT);
    await turnTo(page, "map");

    const rack = await measure(page);

    /* `sides()` promises the terminal side exactly `RACK_RESERVE` here — the
       floor plus that box's own gutter — and the map side's `max-width` is
       supposed to be that same sentence. If the two ever spell it differently
       this is the number that moves. */
    expect(Math.round(rack.side)).toBe(RACK_RESERVE);
    expect(Math.round(rack.region)).toBe(RACK_FLOOR);
    expect(rack.tier).toBe("studs");
  });

  test("does not move when what it is showing grows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page, DEFAULT_VIEW, LIT);
    await turnTo(page, "split");

    const before = await measure(page);

    /*
     * A run arriving, and a row coming out longer than any the fixture holds —
     * done to the DOM because `dev:web` has no Rust behind it and therefore no
     * `run-readouts` event to fire: `loadRunReadouts` answers the checked-in
     * fixture once and nothing arrives afterwards. What an arrival *is* to this
     * region is the part that can be staged, and it is the whole of what the
     * region must be immune to — another row, and more text on one. If the
     * width were content-derived (the region's `min-width` floor gone, or the
     * pane's basis back on `auto`) this is where it would widen, with nobody's
     * hand on the dial.
     */
    await page.locator(RACK).evaluate((rack) => {
      const rows = rack.querySelector("ol");
      const first = rows?.firstElementChild ?? null;
      if (rows === null || first === null) throw new Error("the rack drew no rows");
      const arrived = first.cloneNode(true) as HTMLElement;
      arrived.textContent =
        "a run whose kind and ticket and unseen byte count all came out far longer than anything the fixture holds";
      rows.append(arrived);
    });
    await settled(page);

    const after = await measure(page);

    expect(after.region).toBe(before.region);
    expect(after.tier).toBe(before.tier);
  });
});

/**
 * The narrowest width each narrow tier is ever drawn at.
 *
 * `boards` starts at its own floor; `studs` is drawn from zero up, but the
 * narrowest the *region* is ever laid out at is `RACK_FLOOR`, which is the width
 * the `map` detent leaves it. So these are the two hardest rows in the app.
 */
const NARROW = [
  { tier: "boards", floor: TIER_FLOORS.boards },
  { tier: "studs", floor: RACK_FLOOR },
] as const;

/**
 * Narrower than any glyph worth drawing, and wider than an ellipsis.
 *
 * A field shrunk until only `…` is left still has a box and still has text in
 * it, so a spec that asked *is it there* would pass on one. This asks how wide
 * it came out; the clipping check beside it is the sharper of the two, and this
 * is the one that catches a field reduced to two characters of a word.
 */
const LEGIBLE = 12;

/** One field of one row, as the browser drew it. */
interface Said {
  readonly field: string;
  readonly width: number;
  /**
   * Its text is wider than its box — an ellipsis, or a word cut in half.
   *
   * A pixel of slack, because `scrollWidth` and `clientWidth` are integers
   * rounded off a fractional layout in opposite directions; an ellipsis costs
   * tens of pixels, so nothing this is looking for hides inside the rounding.
   */
  readonly clipped: boolean;
  /** How far past the row's bottom edge it ended up. */
  readonly below: number;
  /** How far past the row's right edge it ended up. */
  readonly beyond: number;
}

/**
 * The region held at exactly one tier's floor.
 *
 * The flex basis is overridden rather than a viewport width hunted for, and the
 * distinction matters: *how the region comes to be this wide* is what every
 * other test in this file measures, walking the dial and checking the number
 * against `regionFor`. This one is about what a row does once it is that wide,
 * and a floor reached by binary-searching a window size would be the same
 * question asked less exactly. The component measures its own box, so the tier
 * still comes from a measurement and the row still comes from the tier.
 */
async function pinTo(page: Page, floor: number): Promise<void> {
  await page.locator(RACK).evaluate((rack, width) => {
    rack.style.flex = `0 0 ${width}px`;
  }, floor);
  await settled(page);
}

/** Every field of every row, measured — the row's own box is the frame. */
async function fieldsOn(page: Page): Promise<Said[][]> {
  return await page.locator(RACK).evaluate((rack) => {
    const rows = [...rack.querySelectorAll("ol > li")];
    if (rows.length === 0) throw new Error("the rack drew no rows");
    return rows.map((row) => {
      const frame = row.getBoundingClientRect();
      return [...row.querySelectorAll("[data-field]")].map((span) => {
        const box = span.getBoundingClientRect();
        return {
          field: span.getAttribute("data-field") ?? "",
          width: box.width,
          clipped: span.scrollWidth > span.clientWidth + 1,
          below: box.bottom - frame.bottom,
          beyond: box.right - frame.right,
        };
      });
    });
  });
}

test.describe("what a tier claims, at that tier's floor", () => {
  for (const narrow of NARROW) {
    test(`draws every field it kept, whole, at the ${narrow.tier} floor`, async ({ page }) => {
      /*
       * The other half of *each narrow tier prints what it dropped*. The
       * sentence is derived from `SHOWN` and cannot name a field the tier draws
       * — `tests/rack.test.tsx` pins that — but nothing there can see that a
       * field the tier *kept* came out as an ellipsis or landed on a fourth flex
       * line under the row's `overflow: hidden`. jsdom lays nothing out, so both
       * read as present in `textContent` and neither is on the screen. A tier
       * that keeps a field it cannot draw is ADR 0025's falsifier from the other
       * end: the rack claiming something the operator cannot read.
       */
      await page.setViewportSize({ width: 1280, height: 720 });
      await load(page, DEFAULT_VIEW, LIT);
      await turnTo(page, "split");
      await pinTo(page, narrow.floor);

      await expect(page.locator(RACK)).toHaveAttribute("data-tier", narrow.tier);

      const rows = await fieldsOn(page);
      const drawn = [...new Set(rows.flat().map((said) => said.field))].sort();

      /* Everything the tier promises is on a row somewhere. `ticket` is on the
         rows that have one — a run staked on nothing draws no empty span, which
         is why this is the union across rows rather than one row's list. */
      expect(drawn).toEqual([...SHOWN[narrow.tier]].sort());

      for (const said of rows.flat()) {
        expect(said.clipped, `${said.field} came out clipped`).toBe(false);
        expect(said.width, `${said.field} is too narrow to read`).toBeGreaterThanOrEqual(
          LEGIBLE,
        );
        expect(said.below, `${said.field} is below the row`).toBeLessThanOrEqual(0.5);
        expect(said.beyond, `${said.field} is past the row's edge`).toBeLessThanOrEqual(0.5);
      }
    });
  }
});
