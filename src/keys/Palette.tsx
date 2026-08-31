import { useEffect, useRef, useState } from "react";
import { focusPicker as focusTheOnePicker } from "../chrome/Sockets.jsx";
import { useUi } from "../stores/ui";
import {
  ENTRIES,
  currentState,
  escDestination,
  labelFor,
  type ActionId,
  type Entry,
} from "./router";
import styles from "./Palette.module.css";

/** The picker row's own sentence, in the shape the table's verbs are written. */
export const PICK_AGENT = "choose which agent a run starts with";

/**
 * Everything this window binds, in one list, read out of the routing table.
 *
 * **Generated and never written down.** The rows come from the table itself and
 * print `labelFor` beside the row's own `verb`, so a chord added by a later
 * ticket appears here with this file untouched — which is the whole reason
 * `Entry` carries a sentence at all. A palette with a hand-kept list would be a
 * second account of the keyboard, and the one an operator reads is the one that
 * would go stale first.
 *
 * **No key handler anywhere in it.** *Nothing else in the app binds a key* is a
 * structural claim (`tests/no-loose-keys.test.ts`), so this navigates by native
 * Tab focus and native button activation, and the only key that acts on it is
 * the router's own dismiss row. A palette that bound its own arrows would be the
 * third place a keystroke is claimed and the first one the palette could not
 * describe.
 *
 * **And activating a row presses the row.** Every activation goes back through
 * the same handler the chord goes through, so there is exactly one
 * implementation of every verb — a palette carrying its own copy of *cross* is a
 * palette that can cross differently.
 */
export function Palette({
  onRun,
  onDismiss,
  table = ENTRIES,
  focusPicker = focusTheOnePicker,
}: {
  /** Press a row, through the app's one handler. Never a second verb. */
  onRun: (id: ActionId) => void;
  /** Put the palette away, for the row that dismisses it without a keystroke. */
  onDismiss: () => void;
  /** The table to print. A parameter so a test can prove it is not hard-coded. */
  table?: readonly Entry[];
  /** The seam onto the crossing rail's picker, injectable for the same reason. */
  focusPicker?: () => string | null;
}) {
  /* Subscribed, not read: `currentState` is a plain read, and the `Esc` line
     would otherwise print whatever it said at the last unrelated render. */
  useUi();
  const [filter, setFilter] = useState("");
  /* Why the agent could not be picked, when it could not. Cleared by the next
     press, because a stale refusal beside a picker that has since appeared is a
     sentence about a screen that is gone. */
  const [refused, setRefused] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  /* Opening puts the keyboard in the filter. Returning it is the shell's, next
     to the crossing's own focus decision — a surface that both took the keys and
     decided where they go afterwards would be deciding it twice. */
  useEffect(() => {
    field.current?.focus();
  }, []);

  const state = currentState();
  const matching = (text: string) => text.toLowerCase().includes(filter.trim().toLowerCase());

  const pickAgent = () => {
    const why = focusPicker();
    setRefused(why);
    /* Silence would be the one unacceptable answer: a row that focused nothing
       and said nothing is a row an operator presses twice. */
    if (why === null) onDismiss();
  };

  return (
    <div className={styles.scrim}>
      <section className={styles.palette} role="dialog" aria-label="command palette" data-palette>
        <input
          ref={field}
          className={styles.filter}
          type="text"
          value={filter}
          aria-label="filter the commands"
          placeholder="filter"
          onChange={(event) => setFilter(event.target.value)}
        />
        {/*
          `Esc` is a readout and not a row: it is bound to no chord of its own,
          its destination is whatever surface is in front, and the sentence comes
          from the same table the rows below do.
        */}
        <p className={styles.esc} data-esc-line>
          <kbd className={styles.key}>Esc</kbd>
          <span className={styles.verb}>{escDestination(state)}</span>
          <span className={styles.aside}>a readout, not a binding</span>
        </p>
        <ul className={styles.rows}>
          {table
            .filter((entry) => matching(entry.verb) || matching(labelFor(entry, state)))
            .map((entry) => {
              const label = labelFor(entry, state);
              /* A hold cannot be pressed by a click — the whole of the peek is
                 that it lasts while the key is down — so it is printed as what
                 it is rather than offered as a button that would lie. */
              if (entry.held === true) {
                return (
                  <li key={entry.id} className={styles.row} data-row={entry.id} data-hold>
                    <p className={styles.held}>
                      <kbd className={styles.key}>{label}</kbd>
                      <span className={styles.verb}>{entry.verb}</span>
                      <span className={styles.aside}>hold it</span>
                    </p>
                  </li>
                );
              }
              /* A row the table would not claim right now is printed and not
                 offered: the palette is an account of the keyboard, and a row it
                 ran where the chord would not is a palette disagreeing with the
                 table it was generated from. */
              const applies = entry.when(state);
              return (
                <li key={entry.id} className={styles.row} data-row={entry.id}>
                  <button
                    type="button"
                    className={styles.press}
                    aria-disabled={!applies}
                    onClick={() => {
                      if (applies) onRun(entry.id);
                    }}
                  >
                    <kbd className={styles.key}>{label}</kbd>
                    <span className={styles.verb}>{entry.verb}</span>
                  </button>
                </li>
              );
            })}
          {/*
            Which agent a run starts with, and the one row here that is not a
            chord: it has none, because it does not act — it puts the keyboard on
            the picker the crossing rail already draws. A menu of its own would be
            a second answer to *which agent* on one screen, and the answer a press
            actually reads is the rail's.
          */}
          {matching(PICK_AGENT) ? (
            <li className={styles.row} data-row="agent">
              <button type="button" className={styles.press} onClick={pickAgent}>
                <span className={styles.key} aria-hidden="true">
                  —
                </span>
                <span className={styles.verb}>{PICK_AGENT}</span>
              </button>
            </li>
          ) : null}
        </ul>
        {/*
          The refusal as visible text, never a `title`: this row exists to send a
          keyboard somewhere, and a reason a keyboard cannot reach is no reason.
        */}
        {refused === null ? null : (
          <p className={styles.refused} data-refused>
            {refused}
          </p>
        )}
      </section>
    </div>
  );
}
