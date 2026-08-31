import { expect, test } from "@playwright/test";
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
 * the one that matters, since it is the one with rows below rows.
 *
 * **It shares one precondition with every other bench check in this directory,
 * and that precondition is not met yet.** `load(page, "bench", …)` seeds the
 * stored view and waits for the Bench's root, and on this branch the app opens
 * on The Route instead for every point of the space — the whole `bench` axis of
 * `rules.spec.ts` fails on the same wait. That is the view-floor coupling
 * between `BENCH_WIDTH_FLOOR` and `src/panes/dial.ts`, which is somebody else's
 * slice; this file is written against the harness as it is meant to work, and
 * goes green with the rest of the axis when the Bench can be opened.
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

for (const canvas of [{ width: 820, height: 1200 }, { width: 1500, height: 1200 }]) {
  test(`every plate fits the box the arithmetic reserved — ${canvas.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(canvas);
    const rendering = await load(page, "bench", WIDE_MAP);
    const root = rendering.root;
    if (root === null) throw new Error("the Bench is on screen for wide-map");

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
