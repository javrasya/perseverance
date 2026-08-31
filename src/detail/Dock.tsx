import { borrowedBecause, dockedElsewhere, DOCK_PRESSES, type Dock as DockName } from "./docks";
import styles from "./Dock.module.css";

/**
 * One of the three addresses the boarding pass can be at.
 *
 * React renders the **frame** and never the panel, the way `Pane` renders the
 * frame and never the terminal: the host div below is appended to by
 * `reparent`, and nothing may be rendered inside it — React would reconcile
 * against a child it did not put there and remove it.
 *
 * The sentence and the press beside it are siblings of the host for exactly
 * that reason, and they exist at all because a dock without the pass may not be
 * a blank rectangle. It says where the panel went and offers to take it back,
 * which is the same argument the panel's five never-empty states rest on.
 */
export function Dock({
  dock,
  occupant,
  chosen,
  hostRef,
  onChoose,
}: {
  dock: DockName;
  /** Which dock is actually holding the pass right now. */
  occupant: DockName;
  /** Which dock the operator pressed for, which the width may have overridden. */
  chosen: DockName;
  hostRef: React.RefObject<HTMLDivElement | null>;
  onChoose: (dock: DockName) => void;
}) {
  const holding = dock === occupant;
  const borrowed = holding ? borrowedBecause(chosen, occupant) : null;

  return (
    <div className={styles.dock} data-dock={dock} data-holding={holding}>
      {/*
        The pass is appended here by `reparent` and is not a child React knows
        about. Nothing may be rendered inside it.
      */}
      <div className={styles.host} ref={hostRef} />
      {borrowed === null ? null : <p className={styles.borrowed}>{borrowed}</p>}
      {holding ? null : (
        <p className={styles.away}>
          <span>{dockedElsewhere(occupant)}</span>
          <button type="button" className={styles.press} onClick={() => onChoose(dock)}>
            {DOCK_PRESSES[dock]}
          </button>
        </p>
      )}
    </div>
  );
}
