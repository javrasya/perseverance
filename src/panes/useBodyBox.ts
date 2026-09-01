import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

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
 * Nothing here observes a box. The app's one `ResizeObserver` is `Pane`'s and it
 * stays the only one, because that observer is the single path to a PTY resize
 * (`src/panes/geometry.ts` is why that path has to stay singular). This measures
 * on a window resize and after every render, which is every layout change the
 * shell itself can cause: the dial moving, a column shed, a view opened.
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
  const [box, setBox] = useState<BodyBox>(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    reach: 0,
  }));

  const measure = useCallback(() => {
    const measured = body.current?.getBoundingClientRect().width ?? 0;
    const seam = dial.current?.getBoundingClientRect().width ?? 0;
    /*
     * A box below a pixel is not a narrow box, it is a box nobody has laid out
     * yet — the first paint, and every jsdom test, where `getBoundingClientRect`
     * answers zero for everything. The window is the honest fallback there: it
     * is what the body is about to be worth, give or take the seam.
     */
    const next: BodyBox = { width: measured >= 1 ? measured : window.innerWidth, reach: seam };
    setBox((was) => (was.width === next.width && was.reach === next.reach ? was : next));
  }, [body, dial]);

  // No dependency list: after every render, because every layout change the
  // shell makes is a render. An unchanged measurement sets no state, so this
  // settles in one pass rather than looping.
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return box;
}
