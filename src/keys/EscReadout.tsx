import { useUi } from "../stores/ui";
import { currentState, escDestination } from "./router";
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
 */
export function EscReadout() {
  // Subscribed rather than read: `currentState` is a plain read, and without
  // this the sentence would be whatever it was at the last unrelated render.
  useUi();
  const destination = escDestination(currentState());

  return (
    <p className={styles.readout} data-esc>
      <kbd className={styles.key}>Esc</kbd>
      <span className={styles.destination}>{destination}</span>
    </p>
  );
}
