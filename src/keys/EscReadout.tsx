import { useUi } from "../stores/ui";
import { currentState, escDestination } from "./router";
import { warmReadout, type WarmRun } from "./temperature";
import styles from "./EscReadout.module.css";

/**
 * Where `Esc` goes right now, written down.
 *
 * `Esc` is the one key whose destination the operator cannot work out by
 * looking — it is not in the table, because what it does depends on what is on
 * screen — so the app says it out loud instead. The sentence comes from
 * [`escDestination`], which reads the routing table itself: when a later ticket
 * puts a dismissible surface in front of the terminal, it declares that on its
 * own row and this component picks the new destination up **without being
 * edited**. That is the whole reason the readout and the router share a source.
 *
 * Standalone on purpose, and free of anything the pane knows: #52's stud and
 * ledge at the terminal's edge is where this eventually lives, and moving it
 * should be moving one element.
 *
 * It subscribes to the UI store because that is what changes the answer; the
 * state it prints from is the router's own, so there is no second reading of
 * *what is in front* anywhere.
 *
 * The readouts are the one thing it is handed, and for the one thing the store
 * cannot tell it: whether the warm run's child has stopped. That arrives on the
 * poll, and without it this line would name the agent CLI directly above a
 * temperature saying the child is gone and the keystrokes are being kept in a
 * register — the same promise of an interrupt that never arrives which is why
 * this sentence reads `warm` and not `monitored` in the first place. Required
 * and not defaulted, so a caller cannot make that promise by omission.
 */
export function EscReadout({ readouts }: { readouts: readonly WarmRun[] }) {
  // Subscribed rather than read: `currentState` is a plain read, and without
  // this the sentence would be whatever it was at the last unrelated render.
  useUi();
  const state = currentState();
  const destination = escDestination(state, warmReadout(state, readouts)?.over === true);

  return (
    <p className={styles.readout} data-esc>
      <kbd className={styles.key}>Esc</kbd>
      <span className={styles.destination}>{destination}</span>
    </p>
  );
}
