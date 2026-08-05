import { FolderRow } from "./FolderRow";
import {
  REGISTRY_REFUSED_COUNSEL,
  REGISTRY_REFUSED_HEADLINE,
  describeNote,
  noteHeadline,
  rowsFor,
  type FolderEntry,
  type LauncherNote,
  type LauncherOutcome,
} from "./launcher";
import styles from "./FolderList.module.css";

interface FolderListProps {
  outcome: LauncherOutcome;
  /** Epoch seconds, read once per paint rather than by every row. */
  now: number;
  selectedId: number | null;
  note: LauncherNote | null;
  onOpen: (entry: FolderEntry) => void;
  onLocate: (entry: FolderEntry) => void;
  onForget: (entry: FolderEntry) => void;
  onOpenNew: () => void;
}

/**
 * The launcher: the list you land on.
 *
 * The folder, not the map, is the top-level thing you pick, so a repository
 * that hosts several maps is one row here rather than several. *Open a new
 * folder* is the last row of that same list: going somewhere new is the same
 * act as going back somewhere, and an empty list is a normal first run rather
 * than a state that needs its own screen.
 *
 * Named for the rows rather than for the feature because `launcher.ts` already
 * holds the seam, and two files in one folder may not differ only in casing.
 */
export function FolderList({
  outcome,
  now,
  selectedId,
  note,
  onOpen,
  onLocate,
  onForget,
  onOpenNew,
}: FolderListProps) {
  if (outcome.kind === "refused") {
    return (
      <section className={styles.launcher} aria-label="Folders">
        <div className={styles.refusal} role="alert">
          <h2 className={styles.refusalHeadline}>{REGISTRY_REFUSED_HEADLINE}</h2>
          <p className={styles.refusalDetail}>{outcome.detail}</p>
          <p className={styles.refusalCounsel}>{REGISTRY_REFUSED_COUNSEL}</p>
        </div>
      </section>
    );
  }

  const rows = rowsFor(outcome.view);
  const empty = outcome.view.folders.length === 0;

  return (
    <section className={styles.launcher} aria-label="Folders">
      <h2 className={styles.heading}>Folders</h2>
      <p className={styles.preamble}>
        The folder is what you pick. Whatever maps live in it are found once you
        are inside.
      </p>

      <ul className={styles.list}>
        {rows.map((row) =>
          row.kind === "folder" ? (
            <FolderRow
              key={row.entry.id}
              entry={row.entry}
              now={now}
              selected={row.entry.id === selectedId}
              onOpen={onOpen}
              onLocate={onLocate}
              onForget={onForget}
            />
          ) : (
            <li key="open-new" className={styles.newRow}>
              <button type="button" className={styles.new} onClick={onOpenNew}>
                <span className={styles.newName}>Open a new folder…</span>
                <span className={styles.newHint}>
                  {empty
                    ? "Nothing has been opened yet. That is what a first run looks like."
                    : "Somewhere you have not been before."}
                </span>
              </button>
            </li>
          ),
        )}
      </ul>

      {note === null ? null : (
        /*
         * The note is the whole answer to picking a row, and focus stays on the
         * row that was picked — so it is announced where it appears rather than
         * being something you have to go and find.
         */
        <div
          role="status"
          className={styles.note}
          data-tone={
            note.kind === "binding" && note.binding.kind === "bound"
              ? "bound"
              : "plain"
          }
        >
          <span className={styles.noteHeadline}>{noteHeadline(note)}</span>
          <span className={styles.noteDetail}>{describeNote(note)}</span>
        </div>
      )}

      <p className={styles.aside}>
        A folder stays on this list until you remove it, path or no path.
      </p>
    </section>
  );
}
