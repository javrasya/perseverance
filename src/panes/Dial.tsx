import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  DETENTS,
  STEP,
  clamp,
  detentAt,
  fractionOf,
  namesFit,
  nextDetent,
  snap,
  type Detent,
  type Move,
} from "./dial";
import styles from "./Dial.module.css";

/**
 * The hand on the dial.
 *
 * Holds no arithmetic — every number it produces comes from `./dial` — and no
 * state beyond *is a pointer down on me*. Where the dial **is** lives in the UI
 * store, so a poll landing mid-drag cannot move it.
 *
 * It is a `separator` with a value rather than a slider, and that is not a
 * detail: a slider is a control over a quantity that something else consumes,
 * and this is the seam itself. The value is announced as the detent it is at,
 * so a screen reader hears *split* rather than *fifty*.
 *
 * The four detents are drawn on it as ticks, because a place a sighted operator
 * cannot see is a place only the screen reader knows about. The ladder runs down
 * the seam rather than across the body on purpose: a horizontal picture of the
 * split, spanning the window and growing as the dial moves, is a bar filling up,
 * and this app accounts for progress in exactly three integers. Ticks are places.
 *
 * The spring-loaded peek **borrows** this control rather than moving it: while
 * the spring is held the dial reads as `map`, because that is what is on screen,
 * and the position it is drawn from is untouched. A dial that announced the
 * remembered position while the map covered the window would be the one lie a
 * `role="separator"` with a value exists to prevent.
 */
export function Dial({
  position,
  width,
  peeking = false,
  elementRef,
  onMove,
}: {
  position: number;
  /** The measured body, so the ticks know whether their names fit. */
  width: number;
  /** Whether a peek has it at map width. Borrowed, never stored. */
  peeking?: boolean;
  /** The seam itself, for the shell that measures how wide its column is. */
  elementRef?: RefObject<HTMLDivElement | null>;
  /**
   * Where the operator has put it, and whether the hand is still on it.
   *
   * Called on every frame of a drag, as `"drag"`, and once more as `"settled"`
   * when the gesture ends — which is the occasion the shell remembers, because
   * a position written per frame is a row written thirty times a second for one
   * decision the operator made.
   */
  onMove: (position: number, move: Move) => void;
}) {
  const held = useRef(false);

  // What is on screen, which during a peek is not where the dial is remembered.
  const shown = peeking ? fractionOf("map") : position;
  const at = detentAt(shown);
  const percent = Math.round(clamp(shown) * 100);
  const named = namesFit(width);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (box === undefined || box.width < 1) return;
    onMove(clamp((event.clientX - box.left) / box.width), "drag");
  };

  // A key is a whole gesture: one press, one place, one thing to remember.
  const go = (detent: Detent) => onMove(fractionOf(detent), "settled");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows travel freely and detents are reachable without a pointer, which
    // is the whole of *keyboard operation*: a dial only a mouse can put on a
    // detent is a dial half the operators cannot use.
    switch (event.key) {
      case "ArrowRight":
        onMove(clamp(position + STEP), "settled");
        break;
      case "ArrowLeft":
        onMove(clamp(position - STEP), "settled");
        break;
      case "PageUp":
        go(nextDetent(position, 1));
        break;
      case "PageDown":
        go(nextDetent(position, -1));
        break;
      case "Home":
        go("terminal");
        break;
      case "End":
        go("map");
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={elementRef}
      className={styles.dial}
      data-named={named ? "true" : "false"}
      role="separator"
      tabIndex={0}
      aria-label="Dial: how much of the window the map has"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={at === null ? `${percent}% to the map` : at}
      data-detent={at ?? "free"}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        held.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!held.current) return;
        move(event);
      }}
      onPointerUp={(event) => {
        if (!held.current) return;
        held.current = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        // The near-miss lands on the detent it was aiming at; a position that
        // was nowhere near one stays exactly where the hand left it.
        onMove(snap(position), "settled");
      }}
      onPointerCancel={() => {
        if (!held.current) return;
        held.current = false;
        // A cancelled drag is still a gesture that ended, and the dial is
        // already where the last frame put it. Settling here is what stops that
        // position being the one thing a drag leaves unwritten.
        onMove(position, "settled");
      }}
    >
      {/*
        A grip and never a fill. Nothing here may read as a bar filling up: the
        map's work is three integers and a frontier, and a shell element that
        grew as the dial moved would be a fourth account of progress that is not
        even about the map.
      */}
      <span className={styles.grip} aria-hidden="true" />
      {/*
        The four places, and where the hand is among them. For the eye only: the
        detent is already announced on the separator itself by `aria-valuetext`,
        and a tick that were focusable would put four more stops in the tab order
        of a control that already reaches every one of them from the keyboard.
      */}
      <span className={styles.ladder} aria-hidden="true">
        {DETENTS.map((detent) => (
          <span
            key={detent}
            className={styles.tick}
            data-here={at === detent ? "true" : "false"}
            style={{ top: `${fractionOf(detent) * 100}%` }}
          >
            {named ? <span className={styles.name}>{detent}</span> : null}
          </span>
        ))}
        <span className={styles.hand} style={{ top: `${percent}%` }} />
      </span>
    </div>
  );
}
