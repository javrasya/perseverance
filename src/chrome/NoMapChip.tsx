import styles from "./NoMapChip.module.css";

/**
 * First launch is not a mode.
 *
 * The chip establishes the chrome before it holds anything, so the socket the
 * map name will occupy is drawn empty rather than absent. Absence is never a
 * zero: this prints an em dash and a name, never a count.
 */
export function NoMapChip() {
  return (
    <div className={styles.chip} data-state="empty">
      <span className={styles.dash} aria-hidden="true">
        —
      </span>
      <span className={styles.label}>no map open</span>
    </div>
  );
}
