import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CacheStamp } from "./chrome/CacheStamp";
import { DropRegion } from "./chrome/DropRegion";
import { MapChip } from "./chrome/MapChip";
import { useNow } from "./chrome/useNow";
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
import { FolderReadout as FolderPanel } from "./environment/FolderReadout";
import {
  loadFolderEnvironment,
  missingCli,
  retryFolderEnvironment,
  useOverride,
  type FolderReadout,
} from "./environment/folder";
import { FolderList } from "./launcher/FolderList";
import {
  bindRepo,
  chooseFolder,
  forgetFolder,
  loadLauncher,
  nothingListedYet,
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
import {
  loadMaps,
  nothingReadYet,
  watchMaps,
  watching,
  type MapsView,
} from "./maps/maps";
import { describeModel } from "./snapshot/readout";
import { loadSnapshot, watchSnapshot } from "./snapshot/snapshot";
import { replaceSnapshot, useSnapshot } from "./stores/snapshots";
import { chooseDock, monitor, moveDial, readUi, select, useUi } from "./stores/ui";
/* `Dial.jsx` and `StandDown.jsx` for the same reason `Route.jsx` is spelled
   below: `panes/dial.ts` is the arithmetic and `panes/Dial.tsx` is the hand on
   it, and on a case-insensitive filesystem an extensionless specifier finds the
   first of the two. */
import { Dial } from "./panes/Dial.jsx";
import { PeekStud } from "./panes/PeekStud.jsx";
import { StandDown } from "./panes/StandDown.jsx";
import {
  DEFAULT_DETENT,
  STEP,
  VIEW_FLOORS,
  clamp,
  columnsAt,
  floorOf,
  fractionOf,
  honours,
  nextDetent,
  remembers,
  sides,
  standDown,
  surfaces,
  type Detent,
  type Move,
} from "./panes/dial";
import { install, type ActionId, type Handlers, type KeyState } from "./keys/router";
import { clearance, peekWidth } from "./panes/peek";
import { readPosition, writePosition } from "./panes/position";
import { useBodyBox } from "./panes/useBodyBox";
import { usePeek } from "./panes/usePeek";
import { ViewSwitcher } from "./views/ViewSwitcher.jsx";
import { DEFAULT_VIEW, VIEWS, type ViewName } from "./views/views";
import { Pane } from "./terminal/Pane.jsx";
import { promptFor } from "./terminal/prompts";
import {
  loadRunReadouts,
  openTerminalChannel,
  runTook,
  typedAtRun,
  watchRunReadouts,
  type RunReadout,
} from "./terminal/runs";
import { fixtureRunToOpenOn } from "./terminal/fixtures";
import { reparent } from "./terminal/reparent";
import { spillAtRun } from "./terminal/spill";
import { Terminals } from "./terminal/terminals";
import { xterm } from "./terminal/xterm";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { useTheme } from "./theme/useTheme";
/* `Route.jsx` rather than `Route`: it sits beside `route.ts`, and on a
   case-insensitive filesystem the extensionless specifier resolves to the
   arithmetic module instead of the component. */
import { Route } from "./views/route/Route.jsx";
/* `Ledger.jsx` for the same reason: `chrome/ledger.ts` is the words and the
   arithmetic, `chrome/Ledger.tsx` is the component, and an extensionless
   specifier finds the first of the two. */
import { Ledger } from "./chrome/Ledger.jsx";
/* `Sockets.jsx` for the third time and the same reason: `chrome/sockets.ts` is
   the derivation and `chrome/Sockets.tsx` is the rendering. */
import { Sockets } from "./chrome/Sockets.jsx";
/* `IdeaBox.jsx` for the fourth: `chrome/idea.ts` is the derivation. */
import { IdeaBox } from "./chrome/IdeaBox.jsx";
/* `Detail.jsx` for the fifth: `detail/detail.ts` is the join and the words. */
import { Detail } from "./detail/Detail.jsx";
/* `Dock.jsx` for the sixth: `detail/docks.ts` is the arithmetic of where the
   boarding pass is, and `Dock.tsx` is one address on screen. */
import { Dock } from "./detail/Dock.jsx";
import { effectiveDock } from "./detail/docks";
import { useDefaultView } from "./views/useDefaultView";
import styles from "./App.module.css";

/**
 * The app opens on the folder list.
 *
 * Everything below is wiring: the launcher decides what a row says, the store
 * decides what is on the list, and this file only carries answers between them.
 */
export function App() {
  /*
   * One clock for the window, and it is what makes every age on screen age.
   * Nothing else re-renders this component on its own: a poller that has
   * stopped emits nothing ever again, and the two conditions that stop it are
   * exactly the two whose stamps have a reason printed beside them. A stamp
   * frozen on *just now* while the sentence beside it says nothing newer has
   * turned up would be the one lie the stamp exists to prevent.
   */
  const now = useNow();
  const [preference, chooseTheme] = useTheme();
  const [view, chooseView] = useDefaultView();
  /*
   * The body, measured, because the dial's every answer is *position × width* —
   * what each side is worth, which columns are there for, and whether the open
   * view can be drawn at all. The box measured is the one the position is a
   * percentage *of*, so every pixel the shell prints is a pixel that is there.
   * Nothing here observes a box: the app's one `ResizeObserver` is the pane's,
   * and it stays the only one.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const { width: bodyWidth, reach: dialReach } = useBodyBox(bodyRef, dialRef);
  /*
   * The two stores, read here and written in two different places.
   *
   * The snapshot arrives from the poller, unprompted, and is replaced wholesale;
   * the UI state arrives from the operator and never round-trips through Rust.
   * Keeping them apart is what stops a poll landing mid-drag from resetting what
   * a hand was in the middle of — `tests/stores.test.ts` is the assertion.
   */
  const snapshot = useSnapshot();
  const { selection: selectedNode, monitored, position, peeking, dock: chosenDock } = useUi();
  /*
   * The spring, bound at the window. It writes `peeking` and nothing else — not
   * the position, not the per-map memory, not a geometry — which is the whole
   * of *a glance may not rearrange the room*.
   */
  const peek = usePeek();
  const [outcome, setOutcome] = useState<LauncherOutcome>(nothingListedYet);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [runs, setRuns] = useState<readonly RunReadout[]>([]);
  /*
   * The same readouts, reachable from a handler that was registered before they
   * arrived.
   *
   * The keystroke handler is installed once per bound run and must not be
   * re-installed when a poll lands — re-registering `onData` on every readout
   * tick would be the pane's one seam to the keyboard being torn down and
   * rebuilt several times a second. So the handler reads the readouts *at the
   * moment a key is pressed*, through this, rather than closing over the array
   * that happened to be current when it was made. A run that stopped a
   * millisecond ago is a run whose keystrokes must already be spilling, and a
   * stale closure is exactly how they would go on being written to a child that
   * is no longer there.
   */
  const readouts = useRef<readonly RunReadout[]>(runs);
  const [note, setNote] = useState<LauncherNote | null>(null);
  const [environment, setEnvironment] = useState(stillHarvesting);
  const [environmentShown, setEnvironmentShown] = useState(false);
  /*
   * What the folder you last opened resolves under, which is a different
   * question from what this process is running in — a version manager answers a
   * folder's pin inside its own process while your start-up files run, so two
   * folders on one machine can resolve one name to two different files.
   *
   * `null` until a folder has been opened. Nothing waits on it: the folder is
   * selected, its maps are read and its binding note lands before this is even
   * asked for, which is how a missing CLI can only ever add a sentence.
   */
  const [folderEnvironment, setFolderEnvironment] = useState<FolderReadout | null>(null);
  const [folderShown, setFolderShown] = useState(false);
  const [maps, setMaps] = useState<MapsView>(() => nothingReadYet(0));
  /*
   * Which map this window has declared it is watching. The poller asks GitHub
   * for the graph of exactly this map, so it is the difference between every
   * derived model being *no map open* and there being a route on screen.
   */
  const [openMap, setOpenMap] = useState<number | null>(null);
  /*
   * The highest ledger `seq` the operator has read, and **the whole of this
   * side's share of the announcement machinery**. Nothing here decides what is
   * worth announcing: `announce` arrives stamped on every clause, decided once
   * in Rust over the finished entry, and this side only subtracts what has been
   * read from what has arrived.
   *
   * It restarts with the map because the Rust log does: a different map is a
   * different `ChangeLog` with its sequence back at zero, and a marker carried
   * across would silently mark the new map's first rows as already read.
   */
  const [readThrough, setReadThrough] = useState(0);

  /*
   * Subscribe, then ask — the same ordering `watchEnvironment` uses, and for a
   * sharper reason here. The poller emits a snapshot on every tick it finishes,
   * landed or failed, and a window that only read the command at mount would
   * show the model as it stood at launch for the rest of the process while the
   * stamp beside it went on ageing. The command and the event carry the same
   * stored value, so neither can contradict the other about what was derived.
   */
  useEffect(() => {
    let live = true;
    let stop: () => void = () => {};
    let arrived = false;

    watchSnapshot((next) => {
      if (!live) return;
      arrived = true;
      replaceSnapshot(next);
    }).then((off) => {
      if (!live) {
        off();
        return;
      }
      stop = off;
      return loadSnapshot().then((next) => {
        // The command answers with the value stored when it was invoked, so a
        // tick that landed while it was in flight is the newer of the two and
        // the reply may not undo it.
        if (live && !arrived) replaceSnapshot(next);
      });
    });

    return () => {
      live = false;
      stop();
    };
  }, []);

  /*
   * Every run's terminal, for the life of the window.
   *
   * Created once, outside React's reconciler, and never re-created: the
   * registry is what owns the xterm instances, and a registry re-made on a
   * re-render would be every open terminal thrown away. `useState` with an
   * initialiser rather than `useRef` because the factory must run exactly once
   * and a ref's initial value is evaluated on every render.
   */
  const [terminals] = useState(() => new Terminals(xterm));

  /*
   * The byte channel, registered once at mount and never per run.
   *
   * Every delivery is applied and then confirmed, in that order and in the same
   * turn — the confirmation is what tells the harness this window is keeping up,
   * and one that went out before the bytes were written would be a window
   * claiming to be current while it was not.
   */
  useEffect(() => {
    let live = true;

    openTerminalChannel((delivery) => {
      if (!live) return;
      const run = readUi().monitored;
      // A delivery for a run this window has already moved off is dropped
      // rather than written into whatever is on the pane now. The harness will
      // replay it when that run is bound again.
      if (run === null) return;
      terminals.apply(run, delivery);
      void runTook(run, delivery.through);
    });

    return () => {
      live = false;
    };
  }, [terminals]);

  useEffect(() => {
    readouts.current = runs;
  }, [runs]);

  /*
   * Keystrokes go to the run on the pane, and to no other — and while that run's
   * child is still running, to no child at all.
   *
   * The caret is parked, not moved: a run whose child has stopped keeps the
   * keyboard, because moving it would land the next keystroke in a different
   * agent's conversation and nothing here is entitled to do that. What changes
   * is where the text goes. A dead child's descriptor may still accept bytes and
   * will never read one, so the text is kept in the run's own register instead
   * and printed back beside its last output — a mistyped sentence typed at a run
   * that had just ended is recoverable, rather than gone into a pipe.
   *
   * `over` is read and never re-derived. It is Rust's account of the child, off
   * the same readout the ending sentence is off, and a second opinion assembled
   * here out of the flags that happen to be beside it is the thing ADR 0022
   * exists to prevent. A run with no readout yet is typed at: nothing has said
   * its child has stopped, and refusing the keyboard on the strength of a
   * readout that has not arrived would silence a run that was just spawned.
   */
  useEffect(() => {
    if (monitored === null) return;
    terminals.types(monitored, (text) => {
      const readout = readouts.current.find((run) => run.run === monitored) ?? null;
      if (readout !== null && readout.over) {
        spillAtRun(monitored, text);
        return;
      }
      void typedAtRun(monitored, text);
    });
  }, [terminals, monitored]);

  /* Every run's readout, several times a second. Counts and flags, never bytes. */
  useEffect(() => {
    let live = true;
    let stop: () => void = () => {};

    watchRunReadouts((next) => {
      if (live) setRuns(next);
    }).then((off) => {
      if (!live) {
        off();
        return;
      }
      stop = off;
      return loadRunReadouts().then((next) => {
        if (!live) return;
        setRuns((current) => (current.length === 0 ? next : current));
        /* The one `monitor` call no press is behind, named as the exception on
           the mutator and in `docs/adr/0026`. `dev:web` only, and `null` the
           moment there is a harness behind the window: nothing in a browser
           spawns a run, so without this the fixture readouts would be held and
           never bound to anything, and with Rust behind it there is nothing
           here to move a caret onto. */
        const opening = fixtureRunToOpenOn(next);
        if (opening !== null && readUi().monitored === null) monitor(opening);
      });
    });

    return () => {
      live = false;
      stop();
    };
  }, []);

  /* Every terminal ends with the window. */
  useEffect(() => () => terminals.forgetAll(), [terminals]);

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
   * Every read the poller lands, for as long as this window is open.
   *
   * Subscribed once at mount rather than per folder, because the poller is one
   * loop reading one thing at a time and the folder id on each arrival is what
   * says which. A read that lands after you have moved on is dropped on that id
   * rather than on a flag, because two folders opened quickly is the ordinary
   * case and the wrong maps under the right name is the worst of the outcomes.
   */
  useEffect(() => {
    let live = true;
    let stop: () => void = () => {};

    watchMaps((next) => {
      if (!live) return;
      setMaps((current) => (current.folderId === next.folderId ? next : current));
    }).then((off) => {
      if (!live) {
        off();
        return;
      }
      stop = off;
    });

    return () => {
      live = false;
      stop();
    };
  }, []);

  /*
   * The cache first, then the poller. In that order, every time a folder is
   * opened: the first paint of a folder is the copy it already had — which is
   * what makes the stamp honest before anything has been reached — and the live
   * read is the poller's, which is now the only thing that may write.
   *
   * Opening a folder is one of the three off-cadence pokes, so this does not
   * wait for a rung: the loop reads a folder it has never read immediately.
   */
  const readMapsFor = useCallback((folderId: number) => {
    setMaps(nothingReadYet(folderId));
    // A folder is opened with no map open. Carrying the last folder's map
    // number over would declare a map this repository may not even have.
    setOpenMap(null);
    setReadThrough(0);
    loadMaps(folderId)
      .then((next) => setMaps((current) => (current.folderId === folderId ? next : current)))
      // A cache read that could not even be asked for leaves what is on screen
      // where it is; the poller's arrival is what replaces it either way.
      .catch(() => {});
    watching(folderId, null).catch(() => {});
  }, []);

  /*
   * Opening a map is a declaration and not a fetch.
   *
   * This says what the window is looking at and answers nothing; the graph
   * arrives on the poller's own channel whenever the cadence produced it, which
   * is the same rule the map list already lives by. A promise resolving with a
   * model here would be a second delivery path entitled to disagree with the
   * first about what is open.
   *
   * The read marker goes back to zero with it, because the Rust log restarts
   * its sequence when the watched map changes.
   */
  const onOpenMap = useCallback(
    (number: number) => {
      setOpenMap(number);
      setReadThrough(0);
      watching(selectedId, number).catch(() => {});
    },
    [selectedId],
  );

  /*
   * What one resolution comes to, wherever it was asked for: the readout is put
   * on screen and the not-found error is raised or withdrawn with it.
   */
  const settleFolder = useCallback((readout: FolderReadout) => {
    setFolderEnvironment(readout);
    setNote((current) => {
      if (missingCli(readout)) return { kind: "cliMissing", readout };
      // Only the note this replaced is cleared. The repository binding is a
      // fact about the folder that resolution had nothing to do with, and
      // wiping it here would make fixing a PATH look like losing a remote.
      return current?.kind === "cliMissing" ? null : current;
    });
  }, []);

  /*
   * Which resolution this window is still waiting for.
   *
   * A per-folder harvest is a real login shell with the operator's start-up
   * files in it, bounded in seconds rather than milliseconds, so opening one
   * folder and then another before the first has answered is the ordinary
   * sequence and not a race anyone has to try to hit. Every start takes a
   * ticket and only the current ticket may write: a readout names a folder, and
   * one that named the folder you left would put another folder's verbatim
   * `PATH` inside this folder's error and hand *Ask again* the wrong directory
   * to re-harvest.
   */
  const resolution = useRef(0);

  const resolveFolder = useCallback(
    (read: () => Promise<FolderReadout>) => {
      resolution.current += 1;
      const ticket = resolution.current;
      setFolderEnvironment(null);
      read()
        .then((readout) => {
          if (resolution.current === ticket) settleFolder(readout);
        })
        .catch(() => {});
    },
    [settleFolder],
  );

  /* Nothing is being waited for, and nothing in flight may land. */
  const dropResolution = useCallback(() => {
    resolution.current += 1;
    setFolderEnvironment(null);
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
          /*
           * Resolution is started here and never awaited before any of the
           * above. The folder is already selected, its maps are already being
           * read, and the binding note lands whatever this comes to — so a CLI
           * that is nowhere can only *add* a note. Its command carries no
           * `Result` on the Rust side either, which is the structural half of
           * the same claim.
           */
          resolveFolder(() => loadFolderEnvironment(entry.path));
          return bindRepo(entry.path).then((binding) =>
            setNote((current) =>
              // The binding is the ordinary answer to opening a folder, and a
              // missing CLI is the sharper one. Whichever lands second, the
              // sharper one stays: the binding is repeated in the panel, and
              // the not-found error is not repeated anywhere.
              current?.kind === "cliMissing" ? current : { kind: "binding", binding },
            ),
          );
        })
        .catch(refuse);
    },
    [updateList, refuse, readMapsFor, resolveFolder],
  );

  /*
   * The two ways out of the not-found error, both in place: no navigation, no
   * modal, and the row you picked stays exactly where it is.
   *
   * *Ask again* re-harvests this folder and then looks again — the re-harvest is
   * first, which is the whole of it, because an answer re-read from the cache
   * would be the same stale answer faster. Setting an override does not
   * re-harvest: an override is a different answer to *which program*, not a
   * claim that the folder's environment has changed.
   *
   * Both act on the folder that is **selected**, read off the list rather than
   * off the readout on screen: the readout is the thing that may not have
   * arrived yet, and a slow answer for a folder you have left is exactly what
   * could still be sitting in that slot. The row is what the operator pointed
   * at, so the row is what gets re-harvested and overridden.
   */
  const selectedPath =
    outcome.kind === "listed"
      ? outcome.view.folders.find((folder) => folder.id === selectedId)?.path
      : undefined;

  /*
   * The node under the pointer, found once.
   *
   * Two of the rail's facts come off it — what it reads and whether it is a
   * ticket at all — and two lookups would be two chances to answer about two
   * different nodes on one render.
   */
  const selectedChild =
    snapshot.model.map?.nodes.find((node) => node.number === selectedNode) ?? null;

  /*
   * Where the dial is, and where the map that is open will find it next time.
   *
   * The store holds the position and `src/panes/position.ts` holds it per map —
   * in the registry's `map_view` table, or in the browser when there is no Rust
   * behind the window — and these two are the only lines that join them. That
   * seam is two functions wide on purpose: nothing here knows there is a table,
   * a command or a key.
   *
   * What is mid-move but not yet written down. A drag is dozens of positions a
   * second and only the completed gesture is remembered, so this is what the
   * frames in between amount to — flushed when the map changes underneath them,
   * because a gesture interrupted by the map going away still happened.
   */
  const pending = useRef<{ folder: number | null; map: number | null; position: number } | null>(
    null,
  );
  /*
   * How many times the operator has moved the dial. Not a position: the read
   * below is asynchronous now, and *the position I asked for arrived after the
   * hand had already moved* is a fact about ordering rather than about values —
   * two moves that landed on the same number are still two moves.
   */
  const moves = useRef(0);

  const flush = useCallback(() => {
    const unwritten = pending.current;
    pending.current = null;
    if (unwritten === null) return;
    void writePosition(unwritten.folder, unwritten.map, unwritten.position);
  }, []);

  /*
   * How much window the map that is open was worth last time it was open.
   *
   * An effect on *which map*, rather than a line in `onOpenMap`, because a map
   * can become the open one without anybody clicking a row — a window restored,
   * a folder re-read — and the position belongs to the map either way. A map
   * with nothing remembered, one whose registry would not open and every map on
   * a machine whose storage is denied all come back at the default detent
   * rather than at whatever the last map happened to get.
   *
   * The answer is awaited, so a dial the operator has moved in the meantime is
   * the newer of the two and the reply may not undo it — the same rule the
   * snapshot's subscribe-then-ask has, counted here rather than flagged, since
   * this effect re-runs per map.
   */
  useEffect(() => {
    let live = true;
    const asked = moves.current;

    void readPosition(selectedId, openMap).then((position) => {
      if (live && moves.current === asked) moveDial(position);
    });

    return () => {
      live = false;
      // The map is going away and the hand may still be down on the dial. What
      // it did belongs to the map it did it on, which is the one this closure
      // still holds.
      flush();
    };
  }, [selectedId, openMap, flush]);

  /*
   * One write per completed gesture, and none per frame.
   *
   * The same falling edge `src/panes/geometry.ts` puts between a drag and a
   * `SIGWINCH`, for the same reason and one layer up: a `map_view` row written
   * on every `pointermove` is a SQLite transaction thirty times a second for a
   * single decision. Every caller that is not the dial's own hand is a press
   * rather than a drag, which is why `"settled"` is the default.
   */
  const moveTo = useCallback(
    (next: number, move: Move = "settled") => {
      moves.current += 1;
      moveDial(next);
      if (remembers(move)) {
        pending.current = null;
        void writePosition(selectedId, openMap, next);
        return;
      }
      pending.current = { folder: selectedId, map: openMap, position: next };
    },
    [selectedId, openMap],
  );

  /*
   * A cap on the switcher: surface *and* open, in that order, as one press.
   *
   * The move is the operator's doing — they pressed the cap that says it widens
   * the dial. Nothing anywhere else in this file changes which view is open,
   * because a shell that swapped a view for one that happened to fit would make
   * the picture on screen something nobody chose.
   */
  const onChooseView = useCallback(
    (wanted: ViewName) => {
      const floor = floorOf(wanted);
      if (!honours(floor, sides(position, bodyWidth, dialReach).map)) {
        const detent: Detent = surfaces(floor, bodyWidth, dialReach) ?? "map";
        moveTo(fractionOf(detent));
      }
      chooseView(wanted);
    },
    [position, bodyWidth, dialReach, moveTo, chooseView],
  );

  /*
   * What the one key router does when a row of its table is claimed.
   *
   * Held in a ref and refreshed every render rather than closed over by the
   * effect below, so the listener is installed **once, for the life of the
   * window** and still acts on the position, the view and the peek as they are
   * at the moment of the press. An effect that depended on these would tear the
   * window's only key listener down and put it back on every render.
   *
   * Nothing in here decides *whether* a key was the app's — that is the table's,
   * and it is the same table xterm's key handler asks, which is what makes the
   * key the terminal is refused the key the app acted on.
   */
  const pressed = useRef<Handlers>({ press: () => {}, release: () => {} });
  pressed.current = {
    press: (id: ActionId, state: KeyState) => {
      switch (id) {
        case "home": {
          // Home is the default view at the default detent — and the detent is
          // only restored where it can actually hold that view, so *home* never
          // lands on a stand-down.
          const wanted = fractionOf(DEFAULT_DETENT);
          if (honours(floorOf(DEFAULT_VIEW), sides(wanted, bodyWidth, dialReach).map)) {
            moveTo(wanted);
          }
          onChooseView(DEFAULT_VIEW);
          return;
        }
        case "cross": {
          /*
           * The room change `Esc` used to make, given its own chord.
           *
           * Focus crosses with the dial, in both directions: arriving at the
           * terminal puts the keyboard in it, and leaving takes the keyboard
           * off it — a window showing the map while every keystroke went to the
           * run underneath would be the worst of both rooms.
           */
          const toTerminal = position > fractionOf("terminal");
          moveTo(fractionOf(toTerminal ? "terminal" : "map"));
          if (toTerminal && monitored !== null) terminals.for(monitored).focus();
          else (document.activeElement as HTMLElement | null)?.blur();
          return;
        }
        case "open":
          // The same toggle the click makes: picking the node you already
          // picked puts it back.
          if (state.focusedNode !== null) {
            select(state.selection === state.focusedNode ? null : state.focusedNode);
          }
          return;
        case "peek":
          peek.summoned();
          return;
        case "dial-wider":
          moveTo(clamp(position + STEP));
          return;
        case "dial-narrower":
          moveTo(clamp(position - STEP));
          return;
        case "dial-next-detent":
          moveTo(fractionOf(nextDetent(position, 1)));
          return;
        case "dial-previous-detent":
          moveTo(fractionOf(nextDetent(position, -1)));
          return;
        case "dial-terminal":
          moveTo(fractionOf("terminal"));
          return;
        case "dial-map":
          moveTo(fractionOf("map"));
          return;
      }
    },
    release: (id: ActionId) => {
      if (id === "peek") peek.letGoOfChord();
    },
  };

  /* The one installation site in the app, and the whole of its lifetime. */
  useEffect(
    () =>
      install({
        press: (id, state) => pressed.current.press(id, state),
        release: (id) => pressed.current.release(id),
      }),
    [],
  );

  /*
   * The width the map side is *drawn at*, which is not always the width the
   * dial's position is worth.
   *
   * While the spring is held the same subtree is promoted over the terminal at
   * full map width, and the remembered position deliberately does not move — so
   * everything downstream of the map side's pixels has to read the width it is
   * being drawn at rather than the position it came from. A peek that shed the
   * rail, hid the launcher or stood the Route down would be a glance at the
   * detent the operator was already looking at, not a glance at the map; from
   * the `terminal` detent it would be a blank panel over the run.
   */
  const peeked = peeking.held !== null;
  const mapWidth = peeked
    ? peekWidth(bodyWidth, dialReach)
    : sides(position, bodyWidth, dialReach).map;
  const columns = columnsAt(mapWidth);
  /*
   * The boarding pass: one element, created once, outside React's reconciler.
   *
   * `useState` rather than `useRef` for the same reason `terminals` is —
   * deliberate, not a slip. The panel is rendered *into* this node by a portal
   * whose target never changes, so React never unmounts the subtree: after a
   * move between docks the DOM nodes and any text selection inside them are the
   * *same objects*. Node identity is the half a test can hold, and jsdom holds
   * only that much: it lays nothing out, so what it proves is that the same
   * nodes arrived, never that a real engine kept anything on them. Whether a
   * live text selection survives an `appendChild` is the browser's business,
   * and nothing on this side can vouch for it.
   *
   * The cap and the scrollbar are on this element rather than on the docks,
   * because the scroller has to be the thing that travels — a scroll offset
   * kept on a dock is an offset the next dock has never heard of. That is
   * necessary and not sufficient: the offset itself is carried across the move
   * by hand, in the effect below.
   */
  const [pass] = useState(() => {
    const held = document.createElement("div");
    held.className = styles.pass ?? "";
    return held;
  });
  const spineDock = useRef<HTMLDivElement>(null);
  const runBarDock = useRef<HTMLDivElement>(null);
  const rackDock = useRef<HTMLDivElement>(null);
  /*
   * Which dock actually holds the pass: the chosen one whenever it can be seen.
   *
   * Measured off the dial's *remembered* position and never off the peeked one.
   * A glance promotes the map side over the terminal for as long as a key is
   * held, and a pass that hopped docks and back on every glance would be a room
   * the glance rearranged — the one thing the peek is built not to do.
   */
  const occupant = effectiveDock(chosenDock, sides(position, bodyWidth, dialReach).terminal);
  /*
   * The move itself, and the whole of it. One effect, depending on the dock
   * alone — no snapshot, no readout, no geometry — the way `Pane`'s bind effect
   * depends on `monitored` alone, so nothing a poll lands can reach the panel's
   * address. `reparent` is the terminal's own primitive rather than a second
   * one: the app has one imperative-reparent mechanism, not two that drift.
   */
  useEffect(() => {
    const host = { spine: spineDock, runBar: runBarDock, rack: rackDock }[occupant];
    /*
     * The offset is carried by hand, because `reparent` is an `appendChild` and
     * an `appendChild` detaches before it re-inserts. A scroll offset lives on
     * the element's layout box, and an engine destroys that box the moment the
     * node leaves the tree — so *the scroller is the thing that travels* buys
     * one offset to carry and not the carrying.
     *
     * This is not the re-application ADR 0025 rejects. That one restores a
     * number a frame after a remount, into a box that was never the one being
     * read. These three lines are one task with no frame painted between them,
     * and the node is never unmounted, so there is nothing for the operator to
     * see happen.
     */
    const top = pass.scrollTop;
    const left = pass.scrollLeft;
    reparent(pass, host.current);
    pass.scrollTop = top;
    pass.scrollLeft = left;
  }, [pass, occupant]);
  /*
   * `null` means the open view can be drawn here. Anything else is the four
   * things the stand-down has to say, decided in the pure module and rendered
   * verbatim. A held peek is evaluated at the `map` detent, because that is
   * where the view is being drawn: at map width no view stands down, which is
   * the whole reason a peek shows the real view instead of a plate.
   */
  const standing = standDown(
    view,
    peeked ? fractionOf("map") : position,
    bodyWidth,
    VIEWS,
    VIEW_FLOORS,
    dialReach,
  );
  /*
   * Whether the map side draws anything where a view would go — and it is two
   * questions, because the stand-down is not part of the view column.
   *
   * The column is shed by width like every other column, and its floor is
   * *narrower* than any view's own floor. Gating the stand-down on the column
   * would therefore switch the stand-down off exactly where it is needed most:
   * from `COLUMN_FLOORS.view` down the open view is further below its floor
   * than it has ever been, the column that would have said so is gone, and what
   * is left is the blank rectangle #28's story 29 says never happens. So the
   * stand-down is gated on the map side being worth any pixels at all — four
   * lines of text and two buttons degrade where a rendering cannot — and the
   * view itself is gated on the column being there.
   */
  const viewColumn = columns.includes("view");
  const mapSideDraws =
    snapshot.model.map !== null && mapWidth > 0 && (viewColumn || standing !== null);
  /* The run whose bytes are on the pane, as the map side knows it — so a map
     rendered during a run and the run bar cannot disagree about which run. */
  const monitoredRun = runs.find((run) => run.run === monitored) ?? null;
  /* Whether the pane is drawing a prompt block, which is the second thing the
     peek has to stop short of — the first being the cursor's own rows. */
  const promptShown = monitored !== null && promptFor(monitored) !== null;

  const onAskAgain = useCallback(() => {
    if (selectedPath === undefined) return;
    resolveFolder(() => retryFolderEnvironment(selectedPath));
  }, [selectedPath, resolveFolder]);

  const onOverride = useCallback(
    (argv: string[]) => {
      if (selectedPath === undefined) return;
      resolveFolder(() => useOverride(selectedPath, argv));
    },
    [selectedPath, resolveFolder],
  );

  const onOpen = useCallback(
    (entry: FolderEntry) => {
      setSelectedId(entry.id);
      if (!entry.present) {
        // A folder whose path has gone is not a folder you opened, so the
        // row's place in the list is left exactly as it was. Nothing is being
        // resolved for it either, and an answer still out for the folder before
        // it may not land under this row's name.
        dropResolution();
        setNote({ kind: "pathGone", path: entry.path });
        return;
      }
      openFolder(entry.path);
    },
    [openFolder, dropResolution],
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
          // A row that is off the list has no environment on screen either,
          // and an answer still out for it may not arrive under nothing.
          if (entry.id === selectedId) dropResolution();
          // The registry took its cache with it, so the screen may not go on
          // showing maps read for a folder that is no longer on the list — and
          // the poller may not go on reading one either, which is what the
          // empty declaration says.
          if (maps.folderId === entry.id) {
            watching(null, null).catch(() => {});
            setMaps(nothingReadYet(0));
            setOpenMap(null);
            setReadThrough(0);
          }
          setNote(null);
        })
        .catch(refuse);
    },
    [updateList, refuse, maps.folderId, selectedId, dropResolution],
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
        {/* The same `model` the footer readout spells and the Route is drawn
            from. One value, three renderings, and no way for them to disagree. */}
        <MapChip model={snapshot.model} />
        {/*
          The change ledger, in one fixed slot.

          It is chrome at a fixed address, shared across every view and every
          dial position — no view renders it, and its snapshot field sits
          outside the type a view is handed, so that stays structural rather
          than a rule to remember. #52 builds the divider's spine and this
          record's address on it; relocating it from here is moving one element.

          `select` is passed straight through, which is what gives a
          reference its set-and-never-toggle behaviour for free: the Route's own
          rows toggle, and a record of things already true has no state to put
          back.
        */}
        <Ledger
          ledger={snapshot.ledger}
          readThrough={readThrough}
          onRead={setReadThrough}
          onSelectNode={select}
        />
        {/*
          The view switcher, on the spine and never inside a pane.

          It survives every position of the dial because it is drawn here, above
          the body the dial divides — and every registered view has a cap here at
          every detent, including the ones that cannot be drawn at this width.
          Those say so on the cap and are shaped differently, and pressing one
          both widens the dial to where it fits and opens it. What may never
          happen is the other order of events: this app does not swap a view for
          one that happens to fit.
        */}
        <ViewSwitcher view={view} mapWidth={mapWidth} onChoose={onChooseView} />
        <ThemeSwitch preference={preference} onChoose={chooseTheme} />
      </header>

      <div className={styles.body} ref={bodyRef}>
        {/*
          Both at once, and neither is a mode. A map being open is not a reason
          to take the launcher off the screen: the map list is the only way to
          open a different map, and the launcher is the only way to reach a
          different folder — so a shell that swapped the launcher out for the
          view would put open, locate, forget, *open a new folder* and every
          other map in this repository somewhere unreachable for the life of
          the process, and the view has no way back to any of them.

          How much window each of the two is worth is the dial's answer, and it
          is a share rather than a mode: the launcher and the view are columns of
          the map side, shed by measured width alone, and everything shed comes
          back by moving the one control that is on screen at every position.
        */}
        {/*
          The map side: everything the dial's position is a share *of*. Its
          columns are shed by measured width and by nothing else — never by
          which map is open and never by which view is up — and every shed
          column comes back by moving the dial, which is on screen at every
          position.
        */}
        <div
          className={styles.mapSide}
          style={{
            flexBasis: `${clamp(position) * 100}%`,
            /*
              The dial's own column, kept out of the map side's share — the same
              correction `sides()` makes to the number it prints, made to the box
              that number is about. At the `map` detent a basis of 100% puts the
              seam and the terminal's padding past the body's clip edge, and the
              column that goes over it is the dial's: the one control that brings
              back everything the position shed. Measured rather than named,
              because `--c-dial-reach` is declared on the dial and this box is
              not one of its descendants.
            */
            maxWidth: `calc(100% - ${dialReach}px)`,
          }}
        >
        {/*
          The peek promotes *this* box — the same element, the same children,
          the same view instance and the same model — over the terminal. There
          is no second rendering of the map anywhere in this file, because two
          renderings are two things that can disagree, and the one an operator
          glances at would be the one nobody is maintaining.
        */}
        <div
          className={peeking.held === null ? styles.inside : `${styles.inside} ${styles.peeking}`}
          data-peeking={peeking.held === null ? "false" : "true"}
          style={
            peeking.held === null
              ? undefined
              : { right: `${dialReach}px`, bottom: `${clearance(promptShown)}px` }
          }
        >
        {columns.includes("launcher") ? (
        <DropRegion onFoldersDropped={onFoldersDropped}>
          <FolderList
            outcome={outcome}
            now={now}
            selectedId={selectedId}
            note={note}
            onOpen={onOpen}
            onLocate={onLocate}
            onForget={onForget}
            onOpenNew={onOpenNew}
            onOverride={onOverride}
            onAskAgain={onAskAgain}
          />
          {/*
            What the folder you picked resolves under, beside the folder rather
            than in the footer: the app-global readout in the footer answers a
            different question — what *this process* is running in — and the
            whole of #45 is that the two can differ.
          */}
          {folderEnvironment === null ? null : (
            <FolderPanel
              readout={folderEnvironment}
              shown={folderShown}
              onToggle={() => setFolderShown((open) => !open)}
              onAskAgain={onAskAgain}
            />
          )}
          {/*
            The folder is what you pick; the maps in it are what you find once
            you are inside. So the list appears under the folder you picked
            rather than replacing the launcher — there is no mode to be in.
          */}
          {selectedId === null ? null : (
            <MapList
              view={maps}
              selected={openMap}
              onOpen={onOpenMap}
              /*
                The idea box, handed to the list rather than placed beside it:
                it belongs under the *no map in this repository* copy, which is
                the one sentence on screen that already says a charting session
                leaving no map behind is that session working correctly.
              */
              ideaBox={
                /* The same readouts the pane is given: the box recesses
                   while the session it started is running and re-arms once
                   that run is over, and these are how it learns which. */
                <IdeaBox
                  /* Keyed to the folder, because the single-press guard the box
                     holds is a fact about *this* folder and nothing takes the
                     box away between two mapless folders: the list draws it at
                     one position, so without a key one React instance would
                     carry a press made in one folder into the next — printing
                     *already running* where nothing runs, and losing the guard
                     on the folder that does have a session the moment a folder
                     with maps is visited in between. A folder change discards
                     the press, the idea and the pick together. */
                  key={selectedPath ?? "none"}
                  folder={selectedPath ?? null}
                  environment={folderEnvironment}
                  readouts={runs}
                />
              }
            />
          )}
        </DropRegion>
        ) : null}

        {!mapSideDraws ? null : (
          <div className={viewColumn ? styles.view : `${styles.view} ${styles.narrow}`}>
            {/*
              Which run's bytes are on the pane, said on the map side too. A map
              drawn while a run is going has the run's presence on it, so the
              picture and the bar under the terminal cannot disagree about which
              run this window is watching. Nothing about *running* is derived
              here — the model has no such bit — it is read off what is bound.
            */}
            {monitored === null ? null : (
              <p className={styles.run}>
                run #{monitored} is on the pane
                {monitoredRun?.over === true ? ", and it has ended" : ""}
              </p>
            )}
            {standing !== null ? (
              <StandDown
                standing={standing}
                model={snapshot.model}
                onWiden={(detent) => moveTo(fractionOf(detent))}
                onOpen={onChooseView}
                onTerminal={() => moveTo(fractionOf("terminal"))}
              />
            ) : view === "route" ? (
              <Route
                model={snapshot.model}
                selected={selectedNode}
                onSelect={select}
              />
            ) : null}
          </div>
        )}

        {/*
          The crossing, between what the map says and the run that answers it.

          Chrome at a fixed address, exactly like the ledger and for the same
          reason: the four verbs are true of every view, and no view is handed
          the folder's environment or a command to invoke. The rail reads the
          frontier off `model.map` — the one resolver's answer — and never off a
          row of whatever is on screen beside it.

          Two tickets cross, because two of the verbs are armed on different
          nodes: Start Working on the frontier, Resume on the selection, and only
          while the selection reads `claimed`. The state crosses rather than a
          verdict — the four states are derived once, in `derive.rs`, and the
          rail is not entitled to a softer opinion about what a claim is. The
          kind crosses beside it because the derivation reads state and never
          kind: the destination and the unclassified children are selectable
          rows too, and an assigned one of either reads `claimed`. The label that
          binds a ticket to another machine crosses for the same reason and in
          the same breath — it is invisible to the state, and the frontier's
          resolver asks it only for the node it designates.
        */}
        {columns.includes("rail") ? (
          <div className={styles.rail}>
            <Sockets
            frontier={snapshot.model.map?.frontier ?? null}
            selection={selectedNode}
            selectionReads={selectedChild?.state ?? null}
            selectionIsTicket={selectedChild?.kind.kind === "ticket"}
            selectionBoundElsewhere={selectedChild?.boundElsewhere ?? false}
            environment={folderEnvironment}
            folder={selectedPath ?? null}
            phase={snapshot.model.map?.phase ?? null}
            map={snapshot.model.map?.number ?? null}
            /* Which runs are still going, off the same readouts the pane
               draws — so the rail and the terminal beside it cannot disagree
               about whether the compose an operator is watching has ended. */
            liveRuns={runs.filter((readout) => !readout.over).map((readout) => readout.run)}
            runs={runs}
            onSelect={select}
            />
          </div>
        ) : null}
        </div>
        </div>

        {/*
          The terminal, on the far side of the dial.

          Mounted at every position, including `map`, where it is worth no pixels
          at all: a dial move collapses this box by width and never unmounts,
          remounts or reparents the node inside it. A terminal taken out of the
          tree is a screen the harness has no way to put back, so *collapsed* and
          *gone* have to be different things.

          It is outside `DropRegion` and outside the view slot because it belongs
          to neither: a run is not a folder and it is not a rendering of the map,
          and putting it inside either would make it disappear whenever that one
          did.
        */}
        <Dial
          position={position}
          width={bodyWidth}
          peeking={peeking.held !== null}
          elementRef={dialRef}
          onMove={moveTo}
        />

        <div className={styles.terminal}>
          {/*
            The run side, as a column: the run bar's dock, the pane, the rack's.
            The two docks are strips in the flow rather than anything positioned,
            because this box is deliberately not a containing block — and they
            are the reason the pane now sits in a slot of its own rather than
            directly in this box.

            Both are the panel's *addresses* and neither is the surface around
            them. The run bar's own contents are the pane's chrome strip, and the
            region this rack dock sits in is #56's to build; what lands here now
            is one dock apiece and the sentence a dock without the pass prints.
          */}
          <div className={styles.runSide}>
            <Dock
              dock="runBar"
              occupant={occupant}
              chosen={chosenDock}
              hostRef={runBarDock}
              onChoose={chooseDock}
            />
            <div className={styles.paneSlot}>
              <Pane terminals={terminals} readouts={runs} />
            </div>
            {/* #56 builds the rack around this. */}
            <Dock
              dock="rack"
              occupant={occupant}
              chosen={chosenDock}
              hostRef={rackDock}
              onChoose={chooseDock}
            />
          </div>
        </div>

        {/*
          The stud hangs off *the body* rather than off the terminal, and that is
          the whole of it being drawn at all.

          It may not sit in any flow — a strip that took width would narrow the
          pane, and a terminal narrowed by a piece of chrome is a live agent
          reflowed by a decoration — so it has to be absolutely positioned
          against something. The terminal is the wrong something: at the `map`
          detent the terminal's box is worth no pixels and clips its own
          overflow, so a stud hung there is clipped to nothing at exactly the
          position where the refusal it prints is the only feedback there is.
          The body is the box the dial cannot collapse, and it is already the
          peek overlay's containing block, so the stud and the overlay are
          measured against the same edges.
        */}
        <PeekStud
          label={peek.label}
          chord={peek.chord}
          os={peek.os}
          peeking={peeking}
          onHold={peek.hold}
          onLetGo={peek.letGo}
          onRebind={peek.rebind}
        />
      </div>

      {/*
        The node panel, at one fixed address on the spine.

        Chrome, exactly like the ledger and the rail: it describes the selection
        the UI store holds, no view is handed the job, and it survives every
        dial position because it is drawn outside the body the dial divides.
        Below the body rather than inside it, so it takes no share of the split
        — the dial's arithmetic is entirely about widths, and a column added to
        the map side would shed the view at widths the stand-down still calls
        fine.

        It is passed the same `selectedNode` the Route, the rail and the ledger
        are, and it writes nothing: selection lives in the store, and a panel
        with an opinion of its own about what is selected is a second answer to
        a question that has one.

        What the panel says is nine fields and five never-empty states, with the
        markdown rendered and sanitised on this side. Where it *is* is this
        dock's answer and the two on the run side: the panel is one element that
        moves between the three by `reparent`, never unmounted, so it arrives at
        each one holding the scroll offset it left the last one with.

        This dock is the one no dial position can take away, which is why it is
        also the one a collapsed dock's pass is borrowed onto.
      */}
      <Dock
        dock="spine"
        occupant={occupant}
        chosen={chosenDock}
        hostRef={spineDock}
        onChoose={chooseDock}
      />
      {/*
        The panel, rendered once into a target that never changes. The portal is
        written here — beside the dock it starts at — but where it appears on
        screen is not this line's doing and never can be: the pass is moved by
        the effect above, and React only ever sees the one host.
      */}
      {createPortal(<Detail model={snapshot.model} selection={selectedNode} />, pass)}

      <EnvironmentReadout readout={environment} shown={environmentShown} />

      <footer className={styles.readout}>
        <span>schema v{snapshot.schemaVersion}</span>
        {/*
          The derived model, as one line. A diagnostic beside the view rather
          than a substitute for it: these are the numbers the view is built
          from, spelled, so a view that listed the wrong thing has something on
          screen to disagree with.
        */}
        <span>{describeModel(snapshot.model)}</span>
        {/*
          The ledger is not spelled here. It has a slot of its own in the
          chrome above, and a second rendering of its numeral in the footer
          would be a second account of how much is unread — the one thing a
          single read marker exists to prevent.
        */}
        {/*
          And how old that model is, beside it rather than anywhere else. The
          derivation is the same whether the poll landed or failed — a failed
          poll re-emits the last model with aged provenance rather than going
          silent — so the model alone cannot tell you which of the two you are
          looking at. Without this the two states are the same pixels.
        */}
        <CacheStamp what="model" provenance={snapshot.provenance} now={now} />
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
        {/*
          And whether the poller is holding itself back to leave the rate limit
          alone, which is a fact about this stamp's subject and no other: the
          model has no poller behind it, so it is passed nothing to say.

          This is also where a read that did not land says what stopped it. The
          footer is the app's readout — the spine foot #52 will build is a
          different surface, and this is the one that exists — so the condition
          lands on chrome that survives every state rather than in a modal or a
          toast. There is no branch anywhere below that removes a stamp: a
          screen with no stamp on it is a screen whose age nobody can read, and
          that is the state a failed poll is most likely to be in.
        */}
        <CacheStamp
          what="maps"
          provenance={maps.provenance}
          now={now}
          yielding={maps.yieldingToRateLimit}
        />
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
