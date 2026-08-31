import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * How wide one element is, measured off the element itself.
 *
 * **Measured and never observed.** The app's one `ResizeObserver` is `Pane`'s
 * and it stays the only one, because that observer is the single path to a PTY
 * resize (`src/panes/geometry.ts` is why that path has to stay singular). So
 * this reads the box on a window resize and after every render, which between
 * them are every layout change the shell itself can cause: the dial moving, a
 * column shed, a view opened.
 *
 * There is one of these rather than one per caller. Two hooks with the same
 * body are two answers to *how wide is this*, free to drift apart on the one
 * question both exist for — the same reason `src/views/graph.ts` holds one walk
 * over `waitsOn` for the two views that ask it.
 *
 * No dependency list on the layout effect: after every render, because every
 * layout change the shell makes is a render. An unchanged measurement sets no
 * state, so this settles in one pass rather than looping.
 */
export function useMeasuredWidth(
  element: RefObject<HTMLElement | null>,
  unlaidOut: UnlaidOut,
): number {
  const [width, setWidth] = useState(() => unlaidOut());

  const measure = useCallback(() => {
    const measured = element.current?.getBoundingClientRect().width ?? 0;
    const next = measured >= 1 ? measured : unlaidOut();
    setWidth((was) => (was === next ? was : next));
  }, [element, unlaidOut]);

  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return width;
}

/**
 * What an element that nobody has laid out yet is worth, said by the caller.
 *
 * **A box below a pixel is not a narrow box, it is a box with no layout behind
 * it** — the first paint, and every jsdom test, where `getBoundingClientRect`
 * answers zero for everything. That rule is the hook's and is written once,
 * here. What such a box is *worth* is not the hook's to decide, because the two
 * honest answers differ: for a box that is about to be the width of the window,
 * the window is the number it is about to have; for a box that is a fraction of
 * one, the window is a wild over-report and only the least-wrong stand-in that
 * keeps a first paint from acting on a zero.
 *
 * It is a function rather than a number because it is read at measure time: a
 * value captured during render would be the width of the window as it was
 * before the resize that just fired.
 *
 * A caller passing [`THE_WINDOW`] is saying *treat me as the window until the
 * layout says otherwise*, and one that means it exactly — the body — should say
 * so; one that only means *do not stand down on a zero* is accepting a number
 * it will be wrong about, and its tests have to drive the element's own box
 * rather than the window, or they assert against the stand-in.
 */
export type UnlaidOut = () => number;

/** The window's width, or nothing at all where there is no window. */
export const THE_WINDOW: UnlaidOut = () =>
  typeof window === "undefined" ? 0 : window.innerWidth;

/** Zero, for a box whose absence is the honest reading — a seam nobody drew. */
export const NOTHING: UnlaidOut = () => 0;
