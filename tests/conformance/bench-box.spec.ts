import { expect, test } from "@playwright/test";
import { BENCH_MAP_FLOOR, DEFAULT_DETENT, fractionOf } from "../../src/panes/dial";
import { BENCH_WIDTH_FLOOR } from "../../src/views/bench/bench";
import { fixtureSpace, type FixtureState } from "../support/contract";
import { load } from "./support/drive";

/**
 * The Bench's box, measured in a browser rather than asserted in arithmetic.
 *
 * `benchOf` reserves a height for every plate out of the plate's own content —
 * the title's clamped lines, the lines the chips wrap onto, the lines a cut's
 * reason takes — from constants in `bench.ts` that restate what
 * `Bench.module.css` and `src/styles/tokens/` say. A restatement is only as
 * good as what checks it, and nothing in `tests/` could: jsdom performs no
 * layout, so a view test reads back the `top` and `min-height` the view itself
 * wrote and learns nothing about whether the content fit in them.
 *
 * So this is the check, and it is deliberately two assertions and not a
 * screenshot. **Every plate fits the box it was reserved**, and **no two plates
 * overlap**. The second is the failure the first one prevents: a plate whose
 * facts wrapped onto a third line grows past its reserved height and lands on
 * the wrapped row underneath it, covering somebody else's ticket — which is
 * also what rule 13's floor, *hit-testable at its own centre point*, is asking
 * about, for the plate that ends up underneath.
 *
 * Two widths, because they are two different drawings: one where the first rank
 * wraps into short rows and one where it barely wraps at all. The narrow one is
 * the one that matters, since it is the one with rows below rows, and it is the
 * Bench's own [`BENCH_WIDTH_FLOOR`] — the narrowest canvas the view will draw a
 * map on at all, where three plates to a row is the whole of what fits.
 *
 * **Neither width is a number chosen here, and that is the one constraint this
 * file has to honour.** The Bench mounts only where the map side clears
 * [`BENCH_MAP_FLOOR`]; below it `App` draws its stand-down where the view should
 * be, the Bench's root never reaches the document, and `load` spends its timeout
 * waiting for a root that is not coming. So the viewport is computed back from
 * the floor rather than named — [`bodyFor`] turns a wanted canvas into the body
 * the opening detent needs for it, out of the same exported constants the shell
 * converts with — and a floor that moves moves these viewports with it. It is
 * also why this is the one file in the directory that sets a viewport at all:
 * `playwright.config.ts` gives every project a window wide enough for every
 * view's floor, and this check is the one that wants a Bench near its own.
 */

function state(fixture: string): FixtureState {
  const found = fixtureSpace([fixture]).find(
    (point) => point.theme === "light" && point.motion === "full",
  );
  if (found === undefined) throw new Error(`no such fixture: ${fixture}`);
  return found;
}

/** The map with a wrapped rank and a cut ticket carrying a forty-word reason. */
const WIDE_MAP = state("wide-map");

type Box = {
  readonly number: string;
  readonly reserved: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
};

/**
 * The map side a canvas of `canvas` pixels costs.
 *
 * [`BENCH_MAP_FLOOR`] is already the map side that [`BENCH_WIDTH_FLOOR`] of
 * canvas asks for — the rank rail, the view column's padding, the drop region's
 * own frame and the rail column are all inside it — so a wider canvas is that
 * floor plus the widening, and the widening is doubled because the launcher and
 * the view are both `flex: 1` and halve what is left of the map side between
 * them. Every one of those gutters is a fixed length that the floor has already
 * paid for, so the *widening* is the halving and nothing else. No length is
 * respelled here: both constants are imported, and the only number is that pair
 * of columns.
 */
const VIEW_COLUMNS = 2;

function mapFor(canvas: number): number {
  return BENCH_MAP_FLOOR + VIEW_COLUMNS * (canvas - BENCH_WIDTH_FLOOR);
}

/**
 * The window that canvas needs, at the detent a map with nothing remembered
 * about it opens on.
 *
 * The slack is there because a body is measured and not decreed: the viewport
 * is not the body box, and a run that landed exactly on the floor would leave a
 * scrollbar's width between this file and a stand-down.
 */
const BODY_SLACK = 64;

function bodyFor(canvas: number): number {
  return Math.ceil(mapFor(canvas) / fractionOf(DEFAULT_DETENT)) + BODY_SLACK;
}

for (const canvas of [BENCH_WIDTH_FLOOR, 1500]) {
  test(`every plate fits the box the arithmetic reserved — ${canvas}px of canvas`, async ({
    page,
  }) => {
    const width = bodyFor(canvas);
    await page.setViewportSize({ width, height: 1200 });
    const rendering = await load(page, "bench", WIDE_MAP);
    const root = rendering.root;
    if (root === null) {
      throw new Error(
        `the Bench is not on screen for wide-map at ${width}px of window: ` +
          `${canvas}px of canvas wants ${mapFor(canvas)}px of map side, and the ` +
          `shell's floor is ${BENCH_MAP_FLOOR}`,
      );
    }

    const boxes: Box[] = await root.evaluate((element) =>
      [...element.querySelectorAll("li[data-node]")].map((plate) => {
        const rect = plate.getBoundingClientRect();
        return {
          number: plate.getAttribute("data-node") ?? "?",
          reserved: Number.parseFloat(
            (plate as HTMLElement).style.minHeight.replace("px", ""),
          ),
          height: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        };
      }),
    );

    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.some((box) => box.height > 64)).toBe(true);

    for (const box of boxes) {
      expect(
        box.height,
        `#${box.number} is ${box.height}px in a box reserved at ${box.reserved}px`,
      ).toBeLessThanOrEqual(box.reserved);
    }

    for (const box of boxes) {
      for (const other of boxes) {
        if (other.number === box.number) continue;
        const over =
          box.left < other.right &&
          other.left < box.right &&
          box.top < other.bottom &&
          other.top < box.bottom;
        expect(over, `#${box.number} overlaps #${other.number}`).toBe(false);
      }
    }
  });
}
