import { displayName, isMissing, relativeAge, type FolderEntry } from "./launcher";
import styles from "./FolderRow.module.css";

interface FolderRowProps {
  entry: FolderEntry;
  /** Epoch seconds, passed in so a row never reads the clock itself. */
  now: number;
  selected: boolean;
  onOpen: (entry: FolderEntry) => void;
  onLocate: (entry: FolderEntry) => void;
  onForget: (entry: FolderEntry) => void;
}

/**
 * One remembered folder.
 *
 * A folder whose path has gone stays on the list, greyed and badged, and stays
 * selectable: unplugging a drive is not a reason to lose the row. The badge and
 * the *Locate…* action occupy their space whether or not they are showing, so
 * a folder going missing is a change of ink and never a change of layout.
 */
export function FolderRow({
  entry,
  now,
  selected,
  onOpen,
  onLocate,
  onForget,
}: FolderRowProps) {
  const missing = isMissing(entry);

  return (
    <li
      className={styles.row}
      data-state={missing ? "missing" : "present"}
      data-selected={selected ? "true" : "false"}
    >
      <button
        type="button"
        className={styles.choose}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(entry)}
      >
        <span className={styles.name}>{displayName(entry)}</span>
        <span
          className={styles.badge}
          data-shown={missing ? "true" : "false"}
          aria-hidden={missing ? undefined : true}
        >
          missing
        </span>
        <span className={styles.path}>{entry.path}</span>
        <span className={styles.age}>{relativeAge(entry.lastOpened, now)}</span>
      </button>

      <span className={styles.actions}>
        {missing ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => onLocate(entry)}
          >
            Locate…
          </button>
        ) : (
          <span className={styles.ghost} aria-hidden="true">
            Locate…
          </span>
        )}
        <button
          type="button"
          className={styles.action}
          onClick={() => onForget(entry)}
        >
          Remove from list
        </button>
      </span>
    </li>
  );
}
