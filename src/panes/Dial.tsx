import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { STEP, clamp, detentAt, fractionOf, nextDetent, snap, type Detent } from "./dial";
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
 * The spring-loaded peek is not here. It is the next slice of #52, and the seam
 * it will need is this component's one gesture-owning ref plus a position the
 * store already holds; nothing here has to move for it to arrive.
 */
export function Dial({
  position,
  onMove,
}: {
  position: number;
  /** Where the operator has put it. Called on every frame of a drag. */
  onMove: (position: number) => void;
}) {
  const held = useRef(false);

  const at = detentAt(position);
  const percent = Math.round(clamp(position) * 100);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (box === undefined || box.width < 1) return;
    onMove(clamp((event.clientX - box.left) / box.width));
  };

  const go = (detent: Detent) => onMove(fractionOf(detent));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows travel freely and detents are reachable without a pointer, which
    // is the whole of *keyboard operation*: a dial only a mouse can put on a
    // detent is a dial half the operators cannot use.
    switch (event.key) {
      case "ArrowRight":
        onMove(clamp(position + STEP));
        break;
      case "ArrowLeft":
        onMove(clamp(position - STEP));
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
      className={styles.dial}
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
        onMove(snap(position));
      }}
      onPointerCancel={() => {
        held.current = false;
      }}
    >
      {/*
        A grip and never a fill. Nothing here may read as a bar filling up: the
        map's work is three integers and a frontier, and a shell element that
        grew as the dial moved would be a fourth account of progress that is not
        even about the map.
      */}
      <span className={styles.grip} aria-hidden="true" />
    </div>
  );
}
