import { readUi, settle, startGesture, type Geometry } from "../stores/ui";
import { settledGeometry } from "../terminal/runs";

/**
 * When a pane size may become a PTY resize, and when it may not.
 *
 * **Every reason a size arrives is named here, and exactly one of them is a
 * resize.** The list is the point: a size shows up when a divider is dragged,
 * when a run is bound to the pane, when a peek opens, when a window arrives at
 * its first layout, and on every frame in the middle of a drag — and only the
 * completed gesture may reach a PTY.
 *
 * The rule is *not* that a resize is cheap and a few extra are harmless. A
 * resize is a `SIGWINCH` on unix and a `ResizePseudoConsole` on Windows; an
 * agent redraws its composer in response, and one that arrives while the
 * operator is mid-sentence rewraps what they were typing. So the invariant is
 * *never resize on bind* rather than *resize rarely*, and it has to hold for a
 * run in a background worktree that nobody is even looking at.
 *
 * This is the WebView's half, because a drag is a thing only the WebView can
 * see. The other half is `crates/pty`'s [`Panes`], which has exactly one method
 * that yields a resize — so even a caller here that got the occasion wrong finds
 * nothing on that side to call.
 */
export type Occasion = "drag" | "settled" | "bind" | "peek" | "arrival";

/**
 * Whether an occasion may resize a PTY at all.
 *
 * Written as a table over every occasion rather than as a check at each call
 * site, so *which occasions resize* is one line to read and one line to change.
 */
export function resizes(occasion: Occasion): boolean {
  return occasion === "settled";
}

/**
 * How long after the last movement a gesture counts as over.
 *
 * A pointer that has stopped for this long has stopped; a drag produces dozens
 * of events a second and every one of them would otherwise be a
 * `ResizePseudoConsole` and a full repaint.
 */
export const SETTLES_AFTER = 200;

/**
 * Whether a geometry is one a terminal could actually live at.
 *
 * The dial has a detent that gives the terminal side the whole of nothing, and
 * a box with no width still measures — as zero, or as `NaN` once a font metric
 * is divided by it. A settled zero-column resize would reflow every live agent
 * session to a column count nothing can render, so a degenerate geometry is
 * refused *here*, at the one choke point every size passes through, rather than
 * at each call site that might produce one.
 */
export function habitable(geometry: Geometry): boolean {
  return (
    Number.isFinite(geometry.rows) &&
    Number.isFinite(geometry.cols) &&
    geometry.rows >= 1 &&
    geometry.cols >= 1
  );
}

/**
 * Whether a box has been collapsed out of the layout rather than resized.
 *
 * The pane at the `map` detent is still mounted, still holds every byte and is
 * still the same node — it is simply worth no pixels. Measuring it is not a
 * smaller size; it is no size at all, and the terminal keeps the geometry it
 * had until the dial gives it room again.
 */
export function collapsed(box: { width: number; height: number }): boolean {
  return !(box.width >= 1) || !(box.height >= 1);
}

/**
 * One pane's gesture, debounced into at most one resize.
 *
 * Holds no React state and re-renders nothing, which is deliberate: a drag that
 * re-rendered the window on every frame would be a drag that fights the terminal
 * for the same frames.
 */
export interface Gesture {
  /** A size arrived, for whatever reason. */
  measured(occasion: Occasion, geometry: Geometry): void;
  /** Stop waiting. Nothing pending is sent. */
  cancel(): void;
}

/**
 * @param resize what to do with a settled, changed geometry — the injection seam
 *   that lets a test count resizes without a Rust process, and the reason
 *   *exactly one per gesture* is assertable at all.
 */
export function gesture(
  resize: (geometry: Geometry) => void = (geometry) => void settledGeometry(geometry),
  settlesAfter: number = SETTLES_AFTER,
): Gesture {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let latest: Geometry | null = null;

  const stop = () => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  };

  return {
    measured(occasion, geometry) {
      // A size no terminal could live at is not a size. It reaches neither the
      // store nor a PTY, on any occasion, so the dial's collapsing detent
      // cannot become a resize by any route at all.
      if (!habitable(geometry)) return;

      if (!resizes(occasion)) {
        // Bind, peek and arrival are not gestures and start no clock: a run
        // arriving on the pane must not become a resize by waiting.
        if (occasion !== "drag") return;

        // A drag is movement, so it restarts the clock and sends nothing. The
        // falling edge below is the only thing that ever sends.
        startGesture();
        latest = geometry;
        stop();
        waiting = setTimeout(() => {
          waiting = null;
          const measured = latest;
          latest = null;
          if (measured !== null && settle(measured)) resize(measured);
        }, settlesAfter);
        return;
      }

      // An explicitly settled gesture skips the clock. `settle` is what answers
      // whether the size is new, so a gesture that ended where it began still
      // resizes nothing.
      stop();
      latest = null;
      if (settle(geometry)) resize(geometry);
    },
    cancel() {
      stop();
      latest = null;
      // The store stops waiting too, or a cancelled drag would leave the app
      // believing a hand was still down.
      settle(readUi().geometry);
    },
  };
}
