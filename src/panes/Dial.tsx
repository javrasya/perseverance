import { useRef, type PointerEvent, type RefObject } from "react";
import {
  DETENTS,
  clamp,
  detentAt,
  fractionOf,
  namesFit,
  snap,
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
 * It is a `separator` rather than a slider, and that is not a detail: a slider
 * is a control over a quantity that something else consumes, and this is the
 * seam itself.
 *
 * It carries **no `aria-valuenow`**, and no `aria-valuemin`, `aria-valuemax` or
 * `aria-valuetext` either — the four of them travel together, and the last
 * three are meaningless without the first. Contract rule 5 refuses a value
 * widget anywhere in the rendering, not merely one wrapped around the three
 * integers: the rule as written names one widget and there are a hundred ways
 * to build the same claim, so what the conformance suite refuses is the whole
 * family — `progress`, `meter`, a progressbar role, an `aria-valuenow`. That
 * this dial's proportion is the window's rather than the map's is a distinction
 * a locator cannot draw and an operator glancing at a percentage will not draw
 * either, and the app already accounts for its work in exactly three numerals.
 *
 * Nothing is lost by it, because a percentage was never what this control had
 * to say. Where the dial is is a *place* — one of four named detents, or the
 * stretch between two of them — and a place belongs in the accessible name.
 * So the name carries both what the control is and where it stands, and it is
 * rewritten on every move: a screen reader hears *split* rather than *fifty*,
 * which is what this dial wanted to say before rule 5 asked it to.
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
  // Where it stands, in the accessible name, because there is no value to put
  // it in. A detent is a place and says its own name; between two of them there
  // is nothing to name but the share, and a share in words is not a widget.
  const said = at ?? `${percent}% to the map`;

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (box === undefined || box.width < 1) return;
    onMove(clamp((event.clientX - box.left) / box.width), "drag");
  };

  return (
    <div
      ref={elementRef}
      className={styles.dial}
      data-named={named ? "true" : "false"}
      role="separator"
      tabIndex={0}
      aria-label={`Dial: how much of the window the map has — ${said}`}
      aria-orientation="vertical"
      data-detent={at ?? "free"}
      /*
       * The hook the one key router resolves this widget by.
       *
       * Arrows travel freely and detents are reachable without a pointer —
       * *keyboard operation*, unchanged; a dial only a mouse can put on a detent
       * is a dial half the operators cannot use. What moved is where those keys
       * are declared: they are rows of the single chord→action table in
       * `src/keys/router.ts`, live only while this element has the key, because
       * nothing outside that table binds a key in this app.
       */
      data-dial
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
        detent is already announced on the separator itself, in its name, and a
        tick that were focusable would put four more stops in the tab order of a
        control that already reaches every one of them from the keyboard.
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
