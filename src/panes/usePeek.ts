import { useCallback, useEffect, useRef, useState } from "react";
import { rebound } from "../keys/router";
import { readUi, showPeek } from "../stores/ui";
import {
  REPEAT_GAP,
  RESTING,
  advance,
  labelOf,
  platformName,
  readChord,
  writeChord,
  type Chord,
  type Peek,
  type PeekEvent,
} from "./peek";

/**
 * The peek's wiring, and it binds no key.
 *
 * It used to: the summon chord was claimed here, at the window, in the capture
 * phase. #53 took that over — there is one chord→action table now, in
 * `src/keys/router.ts`, and the peek is a row of it like everything else. What
 * arrives here is [`PeekHandles.summoned`] and [`PeekHandles.letGoOfChord`],
 * already decided.
 *
 * The two window listeners that are left are not key listeners and are not the
 * router's business: a blur and a `visibilitychange` are the named defect's
 * paths — a hold whose keyup is never sent because the window stopped being in
 * front — and they belong to whoever is holding the spring.
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
  /** The router claimed the summon chord. */
  summoned: () => void;
  /** The router saw the summon chord come back up. */
  letGoOfChord: () => void;
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
   *
   * The timer is armed by the first keydown and by every repeat, but whether
   * its beat means anything is `advance`'s call, not this file's: a hold that
   * has never been heard to repeat — every ⌘-modified hold on macOS, where the
   * OS sends no repeats at all — is left alone by the beat, and comes back on
   * the keyup, the blur or the visibilitychange instead. See `REPEAT_GAP`.
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

  /*
   * The chord arrived, from the router and from nowhere else.
   *
   * The claim itself — `preventDefault`, `stopPropagation`, and the decision
   * that this keystroke is the app's — is the router's, made from the one
   * table. What is left here is the spring: one step, and the beat rearmed by
   * every repeat.
   */
  const summoned = useCallback(() => {
    step({ kind: "chord", at: Date.now(), position: readUi().position });
    watchBeat();
  }, [step, watchBeat]);

  const letGoOfChord = useCallback(() => {
    stopWatching();
    step({ kind: "chord-up" });
  }, [step, stopWatching]);

  useEffect(() => {
    const onBlur = () => {
      stopWatching();
      step({ kind: "blur" });
    };

    const onHidden = () => {
      if (!document.hidden) return;
      stopWatching();
      step({ kind: "hidden" });
    };

    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      stopWatching();
    };
  }, [step, stopWatching]);

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
      // The router remembers the bound chord rather than reading storage on
      // every keystroke, so the rebind has to say it changed.
      rebound();
      setChord(readChord(os));
    },
    [os],
  );

  return { chord, label: labelOf(chord, os), os, rebind, hold, letGo, summoned, letGoOfChord };
}
