import type { RunKind } from "../terminal/runs";
import { ENTRIES, type Entry, type KeyState } from "./router";

/**
 * Where the keystrokes go, in words, in every state this window has.
 *
 * **Why the app says this out loud at all.** Watching and typing used to be one
 * path, so *which run is on the pane* answered both questions at once and there
 * was nothing to print. They came apart because the old model rested on a claim
 * that is false: that the terminal is the only place a run's activity is
 * visible. It is not — a research run nobody is watching is working the whole
 * time it is off the monitor — and once the operator can watch one run while
 * typing at another, *where do my keystrokes go* stops being answerable by
 * looking at the screen. A line that answers it is the price of the second
 * path, and it is not optional chrome: it is what keeps a keyed run the
 * operator cannot see from being typed into unawares.
 *
 * **Why a pure function over [`KeyState`], and not a `useUi` in a component.**
 * It is the same state value the router routes the press with, so this sentence
 * and the key's actual destination cannot drift into two opinions: if the state
 * says a surface is in front, that surface both holds the keys and is named
 * here. `escDestination` is built the same way and for the same reason, and the
 * surface's *name* is read off its own dismiss row rather than kept in a list
 * here — a surface added by a later ticket is picked up by a readout nobody
 * edited.
 *
 * Nothing here animates, blinks or transitions; a line that moved beside a
 * scrolling terminal would be competing with what the operator is reading.
 */

/**
 * What this readout needs to know about the warm run, and not one field more.
 *
 * A structural subset of `RunReadout`, so the caller passes the readout it
 * already has and this module never learns how readouts arrive. `null` is a
 * legitimate answer — a run can be warm before its first readout lands, and the
 * sentence then names the run itself rather than waiting to be sure.
 */
export interface WarmRun {
  run: number;
  ticket: number | null;
  kind: RunKind | null;
  /** The child has stopped. The caret is parked on it and has not moved. */
  over: boolean;
}

/**
 * How the operator picks this run out of a rack: its ticket, else its number.
 *
 * Exported because a second place now has to name a run to the operator — the
 * pane's press that offers a parked run's spill register to the work run beside
 * it, which prints where the words are going. Two spellings of a run's name
 * would be two vocabularies for one thing: a readout saying `#123 work` over a
 * button saying `run 9` names the same run twice and lets the operator believe
 * they are two. The parameter stays [`WarmRun`] — a structural subset that any
 * readout satisfies — so naming a run costs no import of how readouts arrive.
 */
export function nameOf(warm: WarmRun): string {
  const named = warm.ticket === null ? `run ${warm.run}` : `#${warm.ticket}`;
  return warm.kind === null ? named : `${named} ${warm.kind}`;
}

/**
 * The destination, as the phrase that follows *keys go to*.
 *
 * The three cases are the three the model has, in the order they take
 * precedence: a surface in front holds the keys while it is up, whatever is
 * warm underneath; a warm run has them next; and with nothing warm they are on
 * the map, which is a destination and not a failure to have one.
 *
 * The parked case is a fourth *sentence* and not a fourth state, deliberately.
 * A run whose child has died keeps the caret — moving it would drop the next
 * keystroke into a different agent's conversation — so the temperature is
 * unchanged and true, and what the readout owes the operator is the reason
 * their typing is not reaching anybody. Saying only *#123 work* there would be
 * the readout claiming a live agent on the other end of the keyboard.
 */
export function keysGo(
  state: KeyState,
  warm: WarmRun | null = null,
  table: readonly Entry[] = ENTRIES,
): string {
  if (state.inFront !== null) {
    const holding = table.find(
      (entry) =>
        entry.dismisses !== undefined &&
        entry.when(state) &&
        entry.chords(state).some((pressed) => pressed.key === "Escape"),
    );
    return holding?.dismisses ?? "the surface in front of the terminal";
  }

  if (state.warm === null) return "the map";
  /* A readout for some other run answers nothing about this one: it is matched
     rather than trusted, because the array it came out of is refreshed several
     times a second and the warm run may have changed between two of them. */
  const named = warm !== null && warm.run === state.warm ? warm : null;
  if (named === null) return `run ${state.warm}, on the monitor`;
  if (named.over) {
    return `${nameOf(named)} — its child has stopped, so keystrokes are held in its spill register`;
  }
  return `${nameOf(named)}, on the monitor`;
}
