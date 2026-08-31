import { useCallback, useEffect, useRef, useState } from "react";
import { readUi, showPeek } from "../stores/ui";
import {
  REPEAT_GAP,
  RESTING,
  advance,
  labelOf,
  matches,
  platformName,
  readChord,
  writeChord,
  type Chord,
  type Peek,
  type PeekEvent,
} from "./peek";

/**
 * The one place a key is bound in this app, and it is bound for the peek only.
 *
 * #53 builds the single global key router — one chord→action table at the
 * window, in the capture phase, with nothing else in the app binding a key —
 * and **this module is what it absorbs**: the listener below is already at the
 * window and already in the capture phase, so the move is deleting this
 * `useEffect` and handing the same chord and the same two dispatches to the
 * table. Nothing else here has to change, and nothing else here may grow a
 * second binding in the meantime.
 *
 * `Esc` is never claimed, here or anywhere: it is the interrupt key of every
 * agent CLI, and an app that swallows it takes away the only way to stop a run.
 *
 * All the policy is in `./peek`. This file is the wiring: it turns real events
 * into that module's events, keeps its state in a ref — the auto-repeat beat
 * changes many times a second and nothing draws it — and writes only the three
 * drawn facts into the store.
 */
export interface PeekHandles {
  /** The chord that summons a peek: the operator's rebind, or the platform's. */
  chord: Chord;
  /** That chord, as it is written on screen. */
  label: string;
  /** Which platform answered, so the stud can spell the alternatives its way. */
  os: string;
  /** Bind a different one, for good. `null` goes back to the platform's. */
  rebind: (chord: Chord | null) => void;
  /** The stud went down under a pointer. */
  hold: () => void;
  /** The stud's pointer went up, was cancelled, or left. */
  letGo: (why: "stud-up" | "pointercancel" | "pointerleave") => void;
}

export function usePeek(): PeekHandles {
  const os = platformName();
  const [chord, setChord] = useState<Chord>(() => readChord(os));
  const spring = useRef<Peek>(RESTING);
  const beat = useRef<number | null>(null);

  /*
   * One step of the spring, from wherever the event came from. The dial's
   * position is read here rather than passed in, so a hold decides inertness
   * from where the dial is *at the moment of the press* and never from a value
   * a stale closure captured.
   */
  const step = useCallback((event: PeekEvent) => {
    const next = advance(spring.current, event);
    if (next === spring.current) return;
    spring.current = next;
    showPeek({ held: next.held, swallowed: next.swallowed, refused: next.refused });
  }, []);

  /*
   * The named defect's last path: auto-repeat keydowns arrive while a key is
   * held, and a window that lost focus stops receiving them along with the
   * keyup it will never send. A timer restarted by every repeat is what turns
   * *the repeats stopped* into a release.
   */
  const watchBeat = useCallback(() => {
    if (beat.current !== null) window.clearTimeout(beat.current);
    beat.current = window.setTimeout(() => {
      beat.current = null;
      step({ kind: "beat", at: Date.now() });
    }, REPEAT_GAP);
  }, [step]);

  const stopWatching = useCallback(() => {
    if (beat.current === null) return;
    window.clearTimeout(beat.current);
    beat.current = null;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(chord, event)) return;
      // Claimed: the run underneath does not see it. The swallow is marked on
      // screen by the stud, because a key that vanishes without a mark is a key
      // the operator will assume their agent received.
      event.preventDefault();
      event.stopPropagation();
      step({ kind: "chord", at: Date.now(), position: readUi().position });
      watchBeat();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      // Any part of the chord coming up ends the hold. Releasing the modifier
      // first is the common case, and its keyup carries `Meta` rather than the
      // chord's own key — a listener that waited for the letter would wait
      // forever.
      const part =
        event.key.toLowerCase() === chord.key.toLowerCase() ||
        ["Meta", "Alt", "Control", "Shift"].includes(event.key);
      if (!part) return;
      stopWatching();
      step({ kind: "chord-up" });
    };

    const onBlur = () => {
      stopWatching();
      step({ kind: "blur" });
    };

    const onHidden = () => {
      if (!document.hidden) return;
      stopWatching();
      step({ kind: "hidden" });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      stopWatching();
    };
  }, [chord, step, watchBeat, stopWatching]);

  const hold = useCallback(() => {
    step({ kind: "stud", position: readUi().position });
  }, [step]);

  const letGo = useCallback(
    (why: "stud-up" | "pointercancel" | "pointerleave") => step({ kind: why }),
    [step],
  );

  const rebind = useCallback(
    (wanted: Chord | null) => {
      writeChord(wanted);
      setChord(readChord(os));
    },
    [os],
  );

  return { chord, label: labelOf(chord, os), os, rebind, hold, letGo };
}
