import type { PointerEvent } from "react";
import type { Peeking } from "../stores/ui";
import { chordChoices, labelOf, type Chord } from "./peek";
import styles from "./PeekStud.module.css";

/**
 * The physical affordance that teaches the hold.
 *
 * Discoverability is the peek's weak joint: a spring-loaded gesture with no
 * visible handle is a gesture only the operator who read the changelog knows
 * about. Exactly two places teach it — this stud and the keys page #53 builds —
 * so **cutting either is cutting the gesture**, and the stud is not decoration.
 *
 * It sits over the terminal side of the window, hung on the *body* rather than
 * on the terminal's own box: the dial narrows that box to the rack's floor and
 * every pixel of it is the rack's, and a stud clipped to that strip at the `map`
 * detent takes the refusal with it — the one place the refusal is the only
 * feedback there is. It names
 * the chord it teaches — the live one, including a rebound one, so an operator
 * who changed the chord is never taught the wrong keys.
 *
 * It is also where the swallow is marked. When the app claims the chord, the
 * run underneath never sees the keystroke; saying so here is what stops the
 * operator concluding their agent received it and did nothing.
 */
export function PeekStud({
  label,
  chord,
  os,
  peeking,
  onHold,
  onLetGo,
  onRebind,
}: {
  label: string;
  chord: Chord;
  os: string;
  peeking: Peeking;
  onHold: () => void;
  onLetGo: (why: "stud-up" | "pointercancel" | "pointerleave") => void;
  onRebind: (chord: Chord) => void;
}) {
  const choices = chordChoices(os);
  const bound = choices.findIndex((choice) => labelOf(choice, os) === label);

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    /*
     * No pointer capture, unlike the dial's drag. Capture would retarget every
     * later pointer event to this button, and *the pointer left the stud* is
     * one of the releases this spring has to have: a hold whose pointer wanders
     * off and whose `pointerup` lands somewhere else would stick open.
     */
    event.preventDefault();
    onHold();
  };

  return (
    <div className={styles.stud} data-peeking={peeking.held === null ? "false" : "true"}>
      <button
        type="button"
        className={styles.grip}
        aria-label={`Peek at the map: hold ${label}`}
        onPointerDown={down}
        onPointerUp={() => onLetGo("stud-up")}
        onPointerCancel={() => onLetGo("pointercancel")}
        onPointerLeave={() => onLetGo("pointerleave")}
      >
        <span className={styles.chord}>{label}</span>
        <span className={styles.hint}>hold to peek</span>
      </button>

      {/*
        A rebind, offered rather than captured: reading *press the keys you
        want* means a second key listener, and #53 owns key listening. Every
        offered chord carries a modifier no shell reads as a control character.
      */}
      <label className={styles.rebind}>
        <span className={styles.rebindLabel}>chord</span>
        <select
          className={styles.choices}
          aria-label="Which chord summons the peek"
          value={bound < 0 ? 0 : bound}
          onChange={(event) => onRebind(choices[Number(event.target.value)] ?? chord)}
        >
          {choices.map((choice, index) => (
            <option key={labelOf(choice, os)} value={index}>
              {labelOf(choice, os)}
            </option>
          ))}
        </select>
      </label>

      {/*
        Never silence. A hold that gave nothing says why, and a chord this app
        claimed says that it was claimed — the two things an operator would
        otherwise have to guess at from a screen that did not change.

        A plain paragraph and never a live region: nothing in this app may
        interrupt a screen reader that is reading a run, and `tests/dev-web`
        holds the whole window to that. It is a readout on chrome that was
        already there, which is how every other fact here is announced.
      */}
      <p className={styles.readout}>
        {peeking.refused ??
          (peeking.swallowed ? `${label} held here — the run did not see it` : "")}
      </p>
    </div>
  );
}
