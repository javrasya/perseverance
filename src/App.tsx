import { useCallback, useEffect, useState } from "react";
import { CacheStamp } from "./chrome/CacheStamp";
import { DropRegion } from "./chrome/DropRegion";
import { NoMapChip } from "./chrome/NoMapChip";
import {
  EnvironmentReadout,
  EnvironmentSummary,
} from "./environment/EnvironmentReadout";
import {
  loadEnvironment,
  settledOver,
  stillHarvesting,
  watchEnvironment,
} from "./environment/environment";
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
import { MapList } from "./maps/MapList";
import { loadMaps, nothingReadYet, refreshMaps, type MapsView } from "./maps/maps";
import { describeModel } from "./snapshot/readout";
import { loadSnapshot, noMapOpen, type Snapshot } from "./snapshot/snapshot";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { useTheme } from "./theme/useTheme";
/* `Route.jsx` rather than `Route`: it sits beside `route.ts`, and on a
   case-insensitive filesystem the extensionless specifier resolves to the
   arithmetic module instead of the component. */
import { Route } from "./views/route/Route.jsx";
import { useDefaultView } from "./views/useDefaultView";
import styles from "./App.module.css";

/**
 * The app opens on the folder list.
 *
 * Everything below is wiring: the launcher decides what a row says, the store
 * decides what is on the list, and this file only carries answers between them.
 */
export function App() {
  const [preference, chooseTheme] = useTheme();
  const [view] = useDefaultView();
  const [snapshot, setSnapshot] = useState<Snapshot>(noMapOpen);
  const [outcome, setOutcome] = useState<LauncherOutcome>(nothingListedYet);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [note, setNote] = useState<LauncherNote | null>(null);
  const [environment, setEnvironment] = useState(stillHarvesting);
  const [environmentShown, setEnvironmentShown] = useState(false);
  const [maps, setMaps] = useState<MapsView>(() => nothingReadYet(0));

  useEffect(() => {
    let live = true;
    loadSnapshot().then((next) => {
      if (live) setSnapshot(next);
    });
    return () => {
      live = false;
    };
  }, []);

  /*
   * Subscribe, then ask. A macOS harvest settles in about 187 ms and can be
   * over before this window exists, in which case the emit lands on nobody and
   * only the command has the answer; a Windows profile takes a second or two
   * and the command answers before the shell does. Both arrivals carry the same
   * readout, so the only ordering that can lose is asking first.
   */
  useEffect(() => {
    let live = true;
    let stop: () => void = () => {};

    // Whichever of the two arrives second must not undo the first.
    const arrived = (next: typeof environment) => {
      if (live) setEnvironment((current) => settledOver(current, next));
    };

    watchEnvironment(arrived).then((off) => {
      if (!live) {
        off();
        return;
      }
      stop = off;
      return loadEnvironment().then(arrived);
    });

    return () => {
      live = false;
      stop();
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
   * The cache first, then GitHub. Both, in that order, every time a folder is
   * opened: the first paint of a folder is the copy it already had — which is
   * what makes the stamp honest before anything has been reached — and the live
   * read is what replaces it and what may write.
   *
   * A read that lands after you have moved on is dropped on the folder id
   * rather than on a flag, because two folders opened quickly is the ordinary
   * case and the wrong maps under the right name is the worst of the outcomes.
   */
  const readMapsFor = useCallback((folderId: number) => {
    const forThisFolder = (next: MapsView) =>
      setMaps((current) => (current.folderId === folderId ? next : current));

    setMaps(nothingReadYet(folderId));
    loadMaps(folderId)
      .then(forThisFolder)
      .then(() => refreshMaps(folderId))
      .then(forThisFolder)
      // A read that could not even be asked for leaves what is on screen where
      // it is. The shell answers a failed read with the cached list and a stale
      // stamp, so arriving here at all means the call itself did not return.
      .catch(() => {});
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
          readMapsFor(entry.id);
          return bindRepo(entry.path).then((binding) =>
            setNote({ kind: "binding", binding }),
          );
        })
        .catch(refuse);
    },
    [updateList, refuse, readMapsFor],
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
          // The registry took its cache with it, so the screen may not go on
          // showing maps read for a folder that is no longer on the list.
          setMaps((current) =>
            current.folderId === entry.id ? nothingReadYet(0) : current,
          );
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
        {/*
          The graph is what the app is for; the launcher is how you got here.
          So the Route takes the room and the folder list keeps its own beside
          it, rather than one replacing the other — there is no mode to be in
          here either. Which view this is comes from the remembered default and
          not from what happens to be on screen.
        */}
        {view === "route" ? (
          <div className={styles.view}>
            <Route
              model={snapshot.model}
              selected={selectedNode}
              onSelect={setSelectedNode}
            />
          </div>
        ) : null}

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
          {/*
            The folder is what you pick; the maps in it are what you find once
            you are inside. So the list appears under the folder you picked
            rather than replacing the launcher — there is no mode to be in.
          */}
          {selectedId === null ? null : <MapList view={maps} />}
        </DropRegion>
      </div>

      <EnvironmentReadout readout={environment} shown={environmentShown} />

      <footer className={styles.readout}>
        <span>schema v{snapshot.schemaVersion}</span>
        {/*
          The derived model, as one line. A diagnostic beside the graph rather
          than a substitute for it: these are the numbers the graph is drawn
          from, spelled, so a graph that drew the wrong thing has something on
          screen to disagree with.
        */}
        <span>{describeModel(snapshot.model)}</span>
        {/*
          And how old that model is, beside it rather than anywhere else. The
          derivation is the same whether the poll landed or failed — a failed
          poll re-emits the last model with aged provenance rather than going
          silent — so the model alone cannot tell you which of the two you are
          looking at. Without this the two states are the same pixels.
        */}
        <CacheStamp what="model" provenance={snapshot.provenance} now={nowSeconds()} />
        {/*
          How old what you are reading is, on chrome that survives every state.
          It is here rather than beside the map list because it may never be a
          casualty of what else is on screen — the moment it is conditional is
          the moment a stale screen can look fresh.

          A second stamp rather than a merged one: the map list and the model
          are read by different commands and go stale independently, and one
          stamp covering both would have to report the fresher or the staler,
          either of which is a lie about the other.
        */}
        <CacheStamp what="maps" provenance={maps.provenance} now={nowSeconds()} />
        {/* One more field of the readout that already exists, rather than a
            second place to look for machine facts. */}
        <EnvironmentSummary
          readout={environment}
          shown={environmentShown}
          onToggle={() => setEnvironmentShown((open) => !open)}
        />
      </footer>
    </div>
  );
}
