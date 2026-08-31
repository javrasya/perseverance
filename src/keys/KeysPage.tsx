import { useEffect, useRef } from "react";
import { useUi } from "../stores/ui";
import { ENTRIES, currentState, escDestination, labelFor, type Entry } from "./router";
import styles from "./KeysPage.module.css";

/**
 * The keyboard, at full window, as something to read.
 *
 * **Why a page and not a corner.** The complaint this answers is that the keys
 * were only ever learnable from a strip crammed beside something else, which is
 * a place a sentence gets shortened until it stops teaching. A surface that
 * takes the window can print every row at full length, so nothing here is
 * abbreviated, truncated or put behind a hover.
 *
 * **Generated, exactly as the palette is.** The rows come out of the routing
 * table and print `labelFor` beside the row's own `verb`; a chord added by a
 * later ticket appears here with this file untouched. Two surfaces each keeping
 * a hand-written list of bindings would be two accounts of the keyboard, and the
 * one an operator is reading would be the one that went stale.
 *
 * **A reading surface and nothing else.** No buttons, no filter, no second
 * implementation of any verb — the palette is where a row is *pressed*, and a
 * page that also ran them would be a third copy of every action. It follows that
 * a row the table would not claim right now is still printed plainly rather than
 * greyed: an operator opens this to learn the dial's keys *before* the dial has
 * the keyboard, and a page that faded out everything not currently armed would
 * hide precisely what it was opened for.
 *
 * **It binds no key.** *Nothing else in the app binds a key* is a structural
 * claim (`tests/no-loose-keys.test.ts`), so this navigates by native Tab focus,
 * and the only key that acts on it is the router's own dismiss row.
 */
export function KeysPage({
  table = ENTRIES,
}: {
  /** The table to print. A parameter so a test can prove it is not hard-coded. */
  table?: readonly Entry[];
}) {
  /* Subscribed, not read: `currentState` is a plain read, and the `Esc` line
     would otherwise print whatever it said at the last unrelated render. */
  useUi();
  const page = useRef<HTMLElement>(null);

  /* Opening puts the keyboard on the page itself — there is no field to put it
     in, and a surface in front of the terminal that left the keys behind it
     would be a surface `Esc` could not reach. Handing them back when it closes
     is the shell's, beside the crossing's own focus decision: a surface that
     both took the keys and decided where they go afterwards decides it twice. */
  useEffect(() => {
    page.current?.focus();
  }, []);

  const state = currentState();

  /* The dismiss rows are the one thing this page does not print as a row. `Esc`
     has no static destination — that is the whole of it — and the readout line
     above already says where it goes right now, computed from these very rows.
     Printing them as bindings too would put two rival static answers directly
     under the line that says there is none. Filtering on `dismisses` rather
     than on the key keeps the page generated: a later dismissible surface joins
     the readout without this file being touched. */
  const printed = table.filter((entry) => entry.dismisses === undefined);

  return (
    <section
      ref={page}
      className={styles.page}
      role="dialog"
      aria-label="the keys this window binds"
      tabIndex={-1}
      data-keys
    >
      <h2 className={styles.title}>every key this window binds</h2>
      {/*
        `Esc` is a readout and not a row: it is bound to no chord of its own, its
        destination is whatever surface is in front, and the sentence comes from
        the same table the rows below do — including the row that put this page
        here, which is why it names this page without this file knowing it.
      */}
      <p className={styles.esc} data-esc-line>
        <kbd className={styles.key}>Esc</kbd>
        <span className={styles.verb}>{escDestination(state)}</span>
        <span className={styles.aside}>a readout, not a binding</span>
      </p>
      <ul className={styles.rows}>
        {printed.map((entry) => {
          const held = entry.held === true;
          return (
            <li
              key={entry.id}
              className={styles.row}
              data-row={entry.id}
              {...(held ? { "data-hold": true } : {})}
            >
              <kbd className={styles.key}>{labelFor(entry, state)}</kbd>
              <span className={styles.verb}>{entry.verb}</span>
              {/* A hold is printed as a hold. The whole of the peek is that it
                  lasts while the key is down, and a page that printed it like
                  the rows you tap would be teaching the wrong gesture. */}
              {held ? <span className={styles.aside}>hold it</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
