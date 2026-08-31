import { useEffect, useState } from "react";

/**
 * How wide this window is, in pixels, kept current.
 *
 * The dial's arithmetic is all *position × width*, and this is the width. It is
 * the window rather than a measured box on purpose: no `ResizeObserver` is
 * involved, so nothing here can become a second path to a PTY resize — the one
 * observer in the app is `Pane`'s, and it stays the only one.
 */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width;
}
