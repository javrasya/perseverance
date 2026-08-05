import { useCallback, useEffect, useState } from "react";
import { DropRegion } from "./chrome/DropRegion";
import { NoMapChip } from "./chrome/NoMapChip";
import { FolderList } from "./launcher/FolderList";
import {
  bindRepo,
  chooseFolder,
  forgetFolder,
  loadLauncher,
  nothingListedYet,
  nowSeconds,
  refusalDetail,
  relocateFolder,
  rememberFolder,
  withFolder,
  withoutFolder,
  type FolderEntry,
  type LauncherNote,
  type LauncherOutcome,
  type LauncherView,
} from "./launcher/launcher";
import { loadSnapshot, noMapOpen, type Snapshot } from "./snapshot/snapshot";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { useTheme } from "./theme/useTheme";
import styles from "./App.module.css";

/**
 * The app opens on the folder list.
 *
 * Everything below is wiring: the launcher decides what a row says, the store
 * decides what is on the list, and this file only carries answers between them.
 */
export function App() {
  const [preference, chooseTheme] = useTheme();
  const [snapshot, setSnapshot] = useState<Snapshot>(noMapOpen);
  const [outcome, setOutcome] = useState<LauncherOutcome>(nothingListedYet);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState<LauncherNote | null>(null);

  useEffect(() => {
    let live = true;
    loadSnapshot().then((next) => {
      if (live) setSnapshot(next);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    loadLauncher().then((next) => {
      if (live) setOutcome(next);
    });
    return () => {
      live = false;
    };
  }, []);

  /* A refusal is not a list, so nothing edits one. */
  const updateList = useCallback((change: (view: LauncherView) => LauncherView) => {
    setOutcome((current) =>
      current.kind === "listed" ? { kind: "listed", view: change(current.view) } : current,
    );
  }, []);

  /*
   * A registry that declines an edit says why, and that sentence is the whole
   * answer to the click: the row the user aimed at is still exactly where it
   * was, and nothing else on screen has moved.
   */
  const refuse = useCallback((refusal: unknown) => {
    setNote({ kind: "refused", detail: refusalDetail(refusal) });
  }, []);

  /*
   * Opening a folder is what records that you opened it. Picking a row from the
   * list is the ordinary way that happens — far more often than picking a path
   * from the OS dialog — so the row you come back to every day is the row that
   * says so and the one at the front.
   */
  const openFolder = useCallback(
    (path: string) => {
      rememberFolder(path)
        .then((entry) => {
          updateList((view) => withFolder(view, entry));
          setSelectedId(entry.id);
          setNote(null);
          return bindRepo(entry.path).then((binding) =>
            setNote({ kind: "binding", binding }),
          );
        })
        .catch(refuse);
    },
    [updateList, refuse],
  );

  const onOpen = useCallback(
    (entry: FolderEntry) => {
      setSelectedId(entry.id);
      if (!entry.present) {
        // A folder whose path has gone is not a folder you opened, so the
        // row's place in the list is left exactly as it was.
        setNote({ kind: "pathGone", path: entry.path });
        return;
      }
      openFolder(entry.path);
    },
    [openFolder],
  );

  /* Re-pointing keeps the id, which is what carries the layout and the cache. */
  const onLocate = useCallback(
    (entry: FolderEntry) => {
      chooseFolder(`Where is ${entry.path} now?`).then((path) => {
        if (path === null) return;
        relocateFolder(entry.id, path)
          .then((moved) => {
            updateList((view) => withFolder(view, moved));
            setSelectedId(moved.id);
            setNote(null);
          })
          .catch(refuse);
      });
    },
    [updateList, refuse],
  );

  /* The only thing that ever takes a row off this list. */
  const onForget = useCallback(
    (entry: FolderEntry) => {
      forgetFolder(entry.id)
        .then(() => {
          updateList((view) => withoutFolder(view, entry.id));
          setSelectedId((chosen) => (chosen === entry.id ? null : chosen));
          setNote(null);
        })
        .catch(refuse);
    },
    [updateList, refuse],
  );

  const onOpenNew = useCallback(() => {
    chooseFolder("Which folder do you want to open?").then((path) => {
      if (path !== null) openFolder(path);
    });
  }, [openFolder]);

  /*
   * A dropped folder is a picked folder. Several at once join the list together
   * and the first is the one that opens, because one folder is what you pick.
   */
  const onFoldersDropped = useCallback(
    (paths: readonly string[]) => {
      paths.forEach((path, index) => {
        if (index === 0) {
          openFolder(path);
          return;
        }
        rememberFolder(path)
          .then((entry) => updateList((view) => withFolder(view, entry)))
          .catch(refuse);
      });
    },
    [openFolder, updateList, refuse],
  );

  return (
    <div className={styles.app}>
      <header className={styles.chrome}>
        <span className={styles.brand}>perseverance</span>
        <NoMapChip />
        <ThemeSwitch preference={preference} onChoose={chooseTheme} />
      </header>

      <div className={styles.body}>
        <DropRegion onFoldersDropped={onFoldersDropped}>
          <FolderList
            outcome={outcome}
            now={nowSeconds()}
            selectedId={selectedId}
            note={note}
            onOpen={onOpen}
            onLocate={onLocate}
            onForget={onForget}
            onOpenNew={onOpenNew}
          />
        </DropRegion>
      </div>

      <footer className={styles.readout}>
        <span>schema v{snapshot.schemaVersion}</span>
        <span>source: {snapshot.provenance.source}</span>
        <span>read: {snapshot.provenance.outcome.kind}</span>
        <span>age: {snapshot.provenance.fetchedAt ?? "—"}</span>
      </footer>
    </div>
  );
}
