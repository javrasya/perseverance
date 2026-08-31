import { useSyncExternalStore } from "react";
import { readable } from "../stores/readable";

/**
 * What was typed at a run whose child has stopped.
 *
 * A stopped child is a write that goes nowhere: the descriptor may still take
 * bytes and nothing on the far side will ever read one. So the keystrokes stop
 * here instead — captured, counted, and readable back verbatim beside the run
 * they were aimed at — because what is worth recovering is the sentence the
 * operator had already typed before they knew the run was over.
 *
 * **Only printable text is kept.** An escape sequence or a control byte aimed at
 * a run that has ended means nothing: `Ctrl+C` interrupts no child, `Enter`
 * submits to nobody, and an arrow key moves a cursor nothing is drawing. Keeping
 * them would fill a register whose whole point is that a mistyped sentence is
 * recoverable with bytes nobody can read.
 *
 * A chunk with a control byte anywhere in it is dropped **whole**, rather than
 * having those bytes filtered out of it. What arrives here is what xterm.js
 * encoded — one press is one chunk — and an arrow key is `ESC [ A`, of which the
 * printable remainder is `[A`. A register that showed `[A` where somebody
 * pressed an arrow would be putting characters into the operator's own sentence
 * that the operator never typed, which is worse than keeping nothing. The cost
 * is stated rather than hidden: a multi-line paste is lost entirely, because a
 * newline is a control byte and this register recovers words rather than
 * transcribing a session.
 *
 * **One register per aimed-at run, not one global one.** The caret parks on the
 * run it was on, and what the pane prints has to be true of *that* run — a
 * single register would print run 3's half-typed sentence beside run 5's last
 * output and attribute it there. A run number is issued once and never reused,
 * so a register lasts exactly as long as the run it belongs to, and the press
 * that ends a run drops it with everything else that run held.
 *
 * **What is deliberately not here.** #57 owns the patchbay: offering this text to
 * the work run, the warm and cold surfaces it would be offered across, and the
 * read-only pane in general. This half captures and holds, and stops. Building
 * the offer here would mean deciding ahead of that ticket which run a spill is
 * worth moving to, and this slice has no way to answer that — there is no
 * temperature model yet to ask.
 */
export interface Spill {
  /** Every printable character kept, in the order it was typed. */
  readonly text: string;
  /**
   * How many characters that is.
   *
   * Counted once, here, rather than measured again wherever it is printed: a
   * reading that counted the string itself would be a second opinion about it,
   * and the two would part company the first time one of them decided a
   * surrogate pair was two things.
   */
  readonly characters: number;
}

const [store, replace] = readable<ReadonlyMap<number, Spill>>(new Map());

/**
 * Whether every character of a chunk is one a person could have meant to type.
 *
 * C0, `DEL` and C1 are all disqualifying. Walked character by character rather
 * than matched by regular expression, so the pass iterates code points and a
 * character from outside the basic plane is one thing rather than two.
 */
function whollyPrintable(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Keystrokes that had nowhere to land, kept against the run they were aimed at.
 *
 * A chunk that is not wholly printable changes nothing at all — not the
 * register, not its count, and so not the frame. An operator who pressed
 * `Ctrl+C` at a child that had already exited has caught nothing, and a pane
 * that said otherwise would be reading a keystroke back to the person who made
 * it.
 */
export function spillAtRun(run: number, text: string): void {
  if (text === "" || !whollyPrintable(text)) return;

  const held = store.read();
  const grown = (held.get(run)?.text ?? "") + text;
  const next = new Map(held);
  next.set(run, { text: grown, characters: [...grown].length });
  replace(next);
}

/** What this run has caught, or `null` for a run that has caught nothing. */
export function spilledAtRun(run: number): Spill | null {
  return store.read().get(run) ?? null;
}

/**
 * A run's register, dropped.
 *
 * Reached from the press that ends a run and from nowhere else, for the same
 * reason the terminal is: what a run held goes when the run does, and no poll,
 * tick or readout gets to decide the operator has finished reading their own
 * words.
 */
export function forgetSpill(run: number): void {
  const held = store.read();
  if (!held.has(run)) return;
  const next = new Map(held);
  next.delete(run);
  replace(next);
}

/** Every register, dropped. The window closing, and a test between two cases. */
export function forgetSpills(): void {
  if (store.read().size === 0) return;
  replace(new Map());
}

/**
 * One run's register, subscribed to.
 *
 * An entry keeps its identity while it is unchanged — a write replaces the map
 * and the single entry it touched, never the others — so a frame in which some
 * other run caught something re-renders nothing here.
 */
export function useSpill(run: number | null): Spill | null {
  const read = () => (run === null ? null : (store.read().get(run) ?? null));
  return useSyncExternalStore(store.subscribe, read, read);
}
