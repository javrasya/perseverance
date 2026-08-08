import { useState } from "react";
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
import {
  ASK_AGAIN_LABEL,
  OVERRIDE_FIELD_LABEL,
  OVERRIDE_SCOPE_NOTE,
  OVERRIDE_SPLIT_NOTE,
  OVERRIDE_SUBMIT_LABEL,
  PATH_SPLIT_NOTE,
  argvFrom,
  overrideAftermath,
  pathEntries,
  type FolderReadout,
} from "../environment/folder";
import { shellLine } from "../environment/environment";
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
  /** Both are the app's; this stays a view. */
  onOverride: (argv: string[]) => void;
  onAskAgain: () => void;
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
  onOverride,
  onAskAgain,
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
        <div
          className={styles.note}
          data-tone={
            note.kind === "binding" && note.binding.kind === "bound"
              ? "bound"
              : "plain"
          }
        >
          {/*
           * The note is the whole answer to picking a row, and focus stays on
           * the row that was picked — so it is announced where it appears
           * rather than being something you have to go and find.
           *
           * The live region is these two sentences and nothing else. What
           * follows is a `PATH` of a hundred entries wrapped around a text
           * field, and a polite region containing a field re-announces its
           * whole contents on every keystroke: the operator typing the fix
           * would hear the evidence read back to them, letter by letter, until
           * they stopped. The evidence is inside the same box because that is
           * where it belongs; it is outside the announcement because an
           * announcement is for what just changed.
           */}
          <div role="status" className={styles.said}>
            <span className={styles.noteHeadline}>{noteHeadline(note)}</span>
            <span className={styles.noteDetail}>{describeNote(note)}</span>
          </div>
          {note.kind === "cliMissing" ? (
            <MissingCli
              readout={note.readout}
              onOverride={onOverride}
              onAskAgain={onAskAgain}
            />
          ) : null}
        </div>
      )}

      <p className={styles.aside}>
        A folder stays on this list until you remove it, path or no path.
      </p>
    </section>
  );
}

interface MissingCliProps {
  readout: FolderReadout;
  onOverride: (argv: string[]) => void;
  onAskAgain: () => void;
}

/**
 * The evidence and the two ways out, inside the error itself.
 *
 * Four facts, none of them re-derived: the shell that ran in this folder, what
 * became of its harvest, the names that were tried — those are in the sentence
 * above — and the folder's own `PATH`, verbatim and scrollable. The last is what
 * makes *not found* falsifiable: if the program is on the `PATH` in your own
 * terminal and not in this box, the two shells are answering differently, and
 * that is the thing to look at.
 *
 * The override field is here rather than behind a settings screen because there
 * is no settings screen, and because a fix that needs navigating to is a fix
 * taken at the moment the evidence is off screen. Submitting it stores the
 * vector and resolves again immediately.
 */
function MissingCli({ readout, onOverride, onAskAgain }: MissingCliProps) {
  const [typed, setTyped] = useState("");
  const argv = argvFrom(typed);
  const entries = pathEntries(readout);
  const aftermath = overrideAftermath(readout);

  return (
    <div className={styles.missing}>
      <dl className={styles.facts}>
        <dt className={styles.factName}>Shell used</dt>
        <dd className={styles.factValue}>{shellLine(readout)}</dd>
        <dt className={styles.factName}>Harvest</dt>
        <dd className={styles.factValue}>
          {readout.harvest.kind === "harvested"
            ? "answered, and this folder is using what it sent back"
            : readout.harvest.kind === "harvesting"
              ? "still being asked"
              : readout.harvest.detail}
        </dd>
        <dt className={styles.factName}>Started in</dt>
        <dd className={styles.factValue}>{readout.spawnDirectory || "—"}</dd>
      </dl>

      {/*
       * Unsplit, unwrapped, scrolling inside its own box so the page body never
       * scrolls sideways — and focusable, because a region a keyboard cannot
       * reach is a region a keyboard user cannot read.
       */}
      <div
        className={styles.verbatim}
        role="group"
        tabIndex={0}
        aria-label="PATH, exactly as it arrived"
      >
        <code className={styles.path}>{readout.path ?? "—"}</code>
      </div>
      <p className={styles.missingNote}>{PATH_SPLIT_NOTE}</p>
      <ol className={styles.entries}>
        {entries.map((entry, index) => (
          <li key={`${index}-${entry}`} className={styles.entry}>
            {entry}
          </li>
        ))}
      </ol>

      <form
        className={styles.override}
        onSubmit={(event) => {
          event.preventDefault();
          onOverride(argv);
        }}
      >
        <label className={styles.factName} htmlFor="folder-override">
          {OVERRIDE_FIELD_LABEL}
        </label>
        <input
          id="folder-override"
          className={styles.field}
          type="text"
          value={typed}
          spellCheck={false}
          autoComplete="off"
          placeholder="claude"
          onChange={(event) => setTyped(event.target.value)}
        />
        <p className={styles.missingNote}>{OVERRIDE_SPLIT_NOTE}</p>
        {/* What the split produced, before anything uses it. */}
        <ol className={styles.parsed} data-parsed={argv.length}>
          {argv.map((word, index) => (
            <li key={`${index}-${word}`} className={styles.word}>
              {word === "" ? "(nothing)" : word}
            </li>
          ))}
        </ol>
        <p className={styles.missingNote}>{OVERRIDE_SCOPE_NOTE}</p>
        {/*
         * What became of the last vector submitted here, beside the field it
         * was submitted from. A vector naming no program changes nothing, and
         * one that could not be written down is in force only until this app
         * next starts — both are silent otherwise, and the panel that also says
         * so opens closed. This is a live region because it is the answer to a
         * click and it holds one sentence: no field, no PATH, nothing that
         * changes while somebody is typing.
         */}
        {aftermath === null ? null : (
          <p
            className={styles.aftermath}
            role="status"
            data-override={readout.override.kind}
          >
            {aftermath}
          </p>
        )}
        <div className={styles.actions}>
          <button type="submit" className={styles.action}>
            {OVERRIDE_SUBMIT_LABEL}
          </button>
          <button type="button" className={styles.action} onClick={onAskAgain}>
            {ASK_AGAIN_LABEL}
          </button>
        </div>
      </form>
    </div>
  );
}
