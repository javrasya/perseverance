import { useMemo, type RefObject } from "react";
import { NOTHING, THE_WINDOW, useMeasuredWidth } from "./useMeasuredWidth";

/**
 * The box the dial divides, measured, and the width of the dial's own column.
 *
 * The dial's arithmetic is all *position × width*, and this is the width. It is
 * the **body** rather than the window on purpose, and that is the correction:
 * the position is applied as a flex-basis percentage of the body element, so a
 * shell that multiplied by `window.innerWidth` would print numbers about a box
 * that is not the box on screen — the stand-down's *needs 420, has 307* would be
 * arithmetic rather than measurement, and would be wrong by the dial's reach and
 * by whatever chrome the body grows later.
 *
 * Two boxes, one measurement: [`useMeasuredWidth`] holds the reading and the
 * rule for a box nobody has laid out yet, and this composes it twice. The two
 * pass different stand-ins on purpose, and the difference is the point of the
 * seam being separate — the body is about to be worth the window, and an
 * unmeasured seam is worth nothing, because a dial that has not been laid out
 * has divided nothing yet and a guess there would be reach the shell then
 * subtracts from a side.
 */
export interface BodyBox {
  /** The body, in pixels. */
  width: number;
  /** The dial's column, in pixels: between the two sides, belonging to neither. */
  reach: number;
}

export function useBodyBox(
  body: RefObject<HTMLElement | null>,
  dial: RefObject<HTMLElement | null>,
): BodyBox {
  const width = useMeasuredWidth(body, THE_WINDOW);
  const reach = useMeasuredWidth(dial, NOTHING);
  return useMemo(() => ({ width, reach }), [width, reach]);
}
