import { useSyncExternalStore } from "react";
import { readable } from "../stores/readable";
import type { RunReadout } from "./runs";

/**
 * What was typed at a run that was never going to read it.
 *
 * A stopped child is a write that goes nowhere: the descriptor may still take
 * bytes and nothing on the far side will ever read one. So the keystrokes stop
 * here instead — captured, counted, and readable back verbatim beside the run
 * they were aimed at — because what is worth recovering is the sentence the
 * operator had already typed before they knew the run was over.
 *
 * A refused write is the same loss by another route, and lands in the same
 * register: the harness turns away keystrokes aimed at a research run, which is
 * spawned unattended and whose brief forbids it to wait for anybody. Such a run
 * is watchable — it binds the pane like every other — so it is a run somebody
 * can type at, and typing that vanished with no word about it is the thing this
 * file exists to prevent. `reason` is how the two are told apart in the reading.
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
 * **Bounded, at the last few hundred characters.** The register grows on every
 * press and nothing but the End press empties it, so an operator who keeps
 * typing at a parked run would otherwise grow one string with no ceiling — and
 * the pane prints that string, so an unbounded register is a chrome that
 * squeezes the terminal whose last output the parking rule exists to keep
 * readable. What is kept is the *tail*: the sentence somebody is in the middle
 * of typing is the recent end of it, and the beginning is what they would have
 * retyped anyway. A trimmed register says so rather than passing the tail off as
 * the whole of it.
 *
 * **One register per aimed-at run, not one global one.** The caret parks on the
 * run it was on, and what the pane prints has to be true of *that* run — a
 * single register would print run 3's half-typed sentence beside run 5's last
 * output and attribute it there. A run number is issued once and never reused,
 * so a register lasts exactly as long as the run it belongs to, and the press
 * that ends a run drops it with everything else that run held.
 *
 * **The offer is the second half, and it is [`offeredTo`].** Capturing without
 * offering would be a register that promises a sentence is recoverable and gives
 * the operator no way to recover it — retyping from a box they can read is not
 * recovery, it is transcription. What the register still refuses to do is decide
 * on its own: nothing here moves text anywhere, and the only thing that empties
 * a register is a press. A poll that drained a register into a live agent would
 * be putting words into somebody's conversation that nobody pressed anything to
 * send.
 */
export interface Spill {
  /**
   * The printable characters kept, in the order they were typed — the last
   * `KEPT_CHARACTERS` of them, and nothing before that.
   */
  readonly text: string;
  /**
   * How many characters that is — of what is *retained*, not of what was typed.
   *
   * A register that counted presses would print a number the words beside it
   * could not account for, and the count is there to describe the words. When
   * the two ever differ, `elided` is the one that says so.
   *
   * Counted once, here, rather than measured again wherever it is printed: a
   * reading that counted the string itself would be a second opinion about it,
   * and the two would part company the first time one of them decided a
   * surrogate pair was two things.
   */
  readonly characters: number;
  /**
   * Whether earlier characters were dropped to make room for these.
   *
   * Printed, because a tail offered as the whole sentence is the register
   * telling the operator something untrue about their own typing.
   */
  readonly elided: boolean;
  /**
   * Why these characters stopped here, in the words of whoever refused them, or
   * `null` for the case this register was built for — a child that has stopped,
   * which the pane's own reading already says.
   *
   * A second reason exists because a second refusal does: the harness turns away
   * keystrokes aimed at a research run, which runs unattended, and it answers
   * with a sentence rather than a silent drop. That sentence is carried here so
   * the pane prints the operator's words under the reason they were kept, and
   * never under the wrong one — a register that said *this run has ended* over a
   * run that is still going would be telling the operator something untrue about
   * their own session.
   *
   * The latest reason wins, because the register holds a sentence being typed
   * and the last press is the one the operator is in the middle of.
   */
  readonly reason: string | null;
}

/**
 * How much of one run's typing is kept.
 *
 * Wide enough for any sentence a person types at a prompt in one go, and narrow
 * enough that the reading stays a line of chrome rather than a page of it. The
 * bound is on the register rather than only on the printing so there is one
 * ceiling to reason about: nothing downstream can hold more than this.
 */
export const KEPT_CHARACTERS = 240;

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
 * Past `KEPT_CHARACTERS` the register keeps the tail and drops the head, which
 * is the one place text is lost on purpose: a bound with no forgetting would be
 * a register that stops listening mid-sentence, and the half of a sentence
 * worth recovering is the half not yet retyped.
 *
 * A chunk that is not wholly printable changes nothing at all — not the
 * register, not its count, and so not the frame. An operator who pressed
 * `Ctrl+C` at a child that had already exited has caught nothing, and a pane
 * that said otherwise would be reading a keystroke back to the person who made
 * it.
 */
export function spillAtRun(run: number, text: string, reason?: string): void {
  if (text === "" || !whollyPrintable(text)) return;

  const held = store.read();
  const previous = held.get(run) ?? null;
  const grown = [...((previous?.text ?? "") + text)];
  const kept = grown.slice(Math.max(0, grown.length - KEPT_CHARACTERS));
  const next = new Map(held);
  next.set(run, {
    text: kept.join(""),
    characters: kept.length,
    elided: (previous?.elided ?? false) || kept.length < grown.length,
    reason: reason ?? previous?.reason ?? null,
  });
  replace(next);
}

/**
 * The run a parked register's words would be offered to, or `null` for none.
 *
 * **The join is the folder, and never the run number alone.** This window holds
 * every folder's runs at once, so *some other run is still going* is a question
 * that has to be asked inside one repository or it is not the question anybody
 * meant: an offer matched on liveness alone would hand a half-typed sentence to
 * an agent working in a different checkout, on a ticket the operator has never
 * read, and the text would be gone from here by the time they saw where it went.
 * `liveRunOn` and `runningIn` in `src/chrome/sockets.ts` match on the same pair
 * for the same reason, and Rust's `live_run_on` is where the convention starts.
 *
 * A parked run whose `folder` is `null` — a run this window was never told the
 * folder of — can be joined to nothing, and so is offered nothing. The absence
 * is the honest answer: an offer that fell back to *any live work run* would be
 * exactly the cross-repository hand-off the join exists to prevent.
 *
 * **`work` and still going, and not the parked run itself.** A compose or a
 * research run is not what a sentence typed at a stopped work run was meant for,
 * a run that is over is the same dead descriptor this register exists because of,
 * and a run cannot be offered its own spill. The spec's one-foreground-HITL-run
 * invariant means at most one run survives all three, so this picks nothing: the
 * first match is the only match, and a rule that chose among several would be a
 * rule deciding which agent hears the operator without being asked.
 */
export function offeredTo(
  readouts: readonly RunReadout[],
  parked: number,
): RunReadout | null {
  const held = readouts.find((run) => run.run === parked) ?? null;
  if (held === null || held.folder === null) return null;
  return (
    readouts.find(
      (run) =>
        run.run !== parked && run.kind === "work" && !run.over && run.folder === held.folder,
    ) ?? null
  );
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
