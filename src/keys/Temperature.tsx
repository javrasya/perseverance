import { useUi } from "../stores/ui";
import { currentState } from "./router";
import { keysGo, warmReadout, type WarmRun } from "./temperature";
import styles from "./Temperature.module.css";

/**
 * Where the keystrokes go, beside the terminal, in every state.
 *
 * Present always and never conditional: a readout that appeared only when
 * something was warm would answer the question in exactly the states where the
 * answer is obvious and go quiet in the one where it is not. *Nothing is warm*
 * is an answer — the keys are on the map — and it is printed like any other.
 *
 * The component owns no opinion of its own. It subscribes to the UI store
 * because that is what changes the answer, hands [`keysGo`] the router's own
 * state, and prints what comes back; the readouts are passed in because naming
 * a run the way an operator recognises it needs the ticket and the kind, and
 * those arrive on the poll rather than in the UI store.
 */
export function Temperature({ readouts }: { readouts: readonly WarmRun[] }) {
  // Subscribed rather than read: `currentState` is a plain read, and without
  // this the sentence would be whatever it was at the last unrelated render.
  useUi();
  const state = currentState();
  // Through the same matcher the `Esc` line above uses, so the two sentences
  // are looking at one readout and cannot disagree about the run's child.
  const warm = warmReadout(state, readouts);

  return (
    <p className={styles.readout} data-temperature>
      <span className={styles.label}>keys go to</span>
      <span className={styles.destination}>{keysGo(state, warm)}</span>
    </p>
  );
}
