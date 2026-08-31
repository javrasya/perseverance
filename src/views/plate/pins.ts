import { useSyncExternalStore } from "react";
import { hasRustBehindIt } from "../../snapshot/snapshot";
import { readable } from "../../stores/readable";
import type { Cell } from "./plate";

/**
 * Where the stations of this map were put by hand, and the only place in this
 * app a node position may be named.
 *
 * **Rule 8's one exception, and it lives here.** No stored node positions,
 * except The Plate, which stores under its own key — so the key is this file's,
 * the two functions that reach the store are this file's, and the module sits
 * under `src/views/plate/` rather than beside `src/panes/position.ts`. A second
 * view cannot acquire a position by importing something general, because there
 * is nothing general to import: `ViewProps` carries no position and never will,
 * and the field a position arrives through on the Rust side — `MapLayout.plate`
 * — has exactly one writer, `remember_map_pins`.
 *
 * **Modelled on `src/panes/position.ts`, line for line**, and for the same
 * reasons: two Rust command names that are the Rust side's own, a
 * `localStorage` fallback for the window with no Rust behind it (`dev:web`,
 * where the encoding suite runs), one `usable` validator so the browser cell
 * and the store envelope cannot disagree about what a pin is, and every failure
 * on the way swallowed into *nothing pinned*. A registry that has gone bad
 * costs an operator an arrangement, not a drawing: the plate falls back to the
 * generated one, which is the picture they would have had anyway.
 *
 * **A store, not a prop.** The pins are read by the shell — which is the only
 * thing that knows which folder is open — and drawn by the view, and the two
 * are joined here rather than through `ViewProps`, because a prop carrying a
 * position would be a position every view can name. What a component holds is
 * [`usePins`], read-only.
 *
 * **One write per settled gesture, and none per frame.** [`pinStation`] is
 * called once, when the hand comes off. The drawing is re-derived from `plateOf`
 * on that write and on nothing in between.
 */

/** Cells and never pixels: `Plate.tsx` is the one place the two are converted,
 *  so a pin in pixels would mean something else at another scale. */
export type Pins = ReadonlyMap<number, Cell>;

export const NOTHING_PINNED: Pins = new Map<number, Cell>();

/** Both names are the Rust side's; neither is a string this file invented. */
const READ_COMMAND = "map_pins";
const REMEMBER_COMMAND = "remember_map_pins";

/** The Plate's own key, and deliberately not `perseverance.dial.`: one prefix
 *  per fact, so clearing an arrangement never clears a window. */
const PREFIX = "perseverance.plate.";

/** The furthest cell a pin may name, as `crates/app` bounds it too. Nothing
 *  about the size of a drawing — a bound on what a stored envelope may say. */
const FURTHEST_CELL = 4096;

function keyFor(folder: number | null, map: number | null): string | null {
  if (folder === null || map === null) return null;
  return `${PREFIX}${folder}#${map}`;
}

/**
 * A remembered arrangement, or `null` for anything that is not one.
 *
 * The one place *what a pin is* is decided, so the browser's cell and the
 * store's envelope cannot disagree about which values are nonsense. A pin that
 * is not sane is dropped rather than taking the arrangement with it: the
 * drawing that results is partly authored and partly generated, which `plateOf`
 * already has a word for — it stamps such a plate *provisional*.
 */
function usable(value: unknown): Pins | null {
  const written = typeof value === "string" ? parse(value) : value;
  if (!Array.isArray(written)) return null;

  const pins = new Map<number, Cell>();
  for (const pin of written) {
    if (typeof pin !== "object" || pin === null) continue;
    const { node, column, row } = pin as Record<string, unknown>;
    if (!whole(node) || node <= 0) continue;
    if (!whole(column) || !whole(row)) continue;
    if (column < 0 || column > FURTHEST_CELL || row < 0 || row > FURTHEST_CELL) continue;
    pins.set(node, { column, row });
  }
  return pins.size === 0 ? null : pins;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The wire shape, which is the Rust side's `Pin` and not a shape of ours. */
function written(pins: Pins): { node: number; column: number; row: number }[] {
  return [...pins].map(([node, cell]) => ({ node, column: cell.column, row: cell.row }));
}

async function askRust(folder: number, map: number): Promise<Pins | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return usable(await invoke<unknown>(READ_COMMAND, { folderId: folder, map }));
  } catch {
    return null;
  }
}

async function tellRust(folder: number, map: number, pins: Pins): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(REMEMBER_COMMAND, { folderId: folder, map, pins: written(pins) });
  } catch {
    // The drawing is already showing the move; a registry that would not take
    // it costs the operator the *next* open's memory of it and nothing more.
  }
}

/**
 * @param folder the folder's id, as the store and the launcher both know it.
 */
export async function readPins(folder: number | null, map: number | null): Promise<Pins> {
  const key = keyFor(folder, map);
  if (key === null || folder === null || map === null) return NOTHING_PINNED;

  if (hasRustBehindIt()) {
    return (await askRust(folder, map)) ?? NOTHING_PINNED;
  }

  try {
    return usable(window.localStorage.getItem(key)) ?? NOTHING_PINNED;
  } catch {
    // A WebView with storage denied still gets a working plate; it is just the
    // generated one every time.
    return NOTHING_PINNED;
  }
}

export async function writePins(
  folder: number | null,
  map: number | null,
  pins: Pins,
): Promise<void> {
  const key = keyFor(folder, map);
  if (key === null || folder === null || map === null) return;

  if (hasRustBehindIt()) {
    await tellRust(folder, map, pins);
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(written(pins)));
  } catch {
    // Same as above: the arrangement lasts the session rather than forever.
  }
}

/* ------------------------------------------------ the pins on the screen --- */

const [store, replace] = readable<Pins>(NOTHING_PINNED);

/** Which map's plate is on screen, so a pin knows what it is a pin *of*. The
 *  view is handed no folder — rule 7 — so the shell says. */
let open: { folder: number | null; map: number | null } = { folder: null, map: null };

/**
 * How many maps have been opened. Not the key itself: the read below is
 * asynchronous, and *the pins I asked for arrived after the map had already
 * changed* is a fact about ordering rather than about values — the same rule
 * the dial's read keeps in `src/App.tsx`.
 */
let opened = 0;

/**
 * The shell, saying which map is open, and the pins following.
 *
 * The previous map's arrangement is dropped before the new one is asked for:
 * pins are per map, and a plate drawn for a moment with the last map's
 * positions would be a picture nobody's hand ever made.
 */
export function openPinsAt(folder: number | null, map: number | null): void {
  open = { folder, map };
  const asked = (opened += 1);
  replace(NOTHING_PINNED);
  void readPins(folder, map).then((pins) => {
    if (opened === asked) replace(pins);
  });
}

export function usePins(): Pins {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

export function readPinsOnScreen(): Pins {
  return store.read();
}

/**
 * One station, put where the hand left it: one publish and one write.
 *
 * The publish is what redraws the plate — `plateOf` honours the pin exactly and
 * every generated station gives way to it — and the write is the map
 * remembering. Both happen once, on the settled gesture.
 */
export function pinStation(node: number, cell: Cell): void {
  const next = new Map(store.read());
  next.set(node, cell);
  replace(next);
  void writePins(open.folder, open.map, next);
}

/**
 * One station, put back: the pin dropped and the rest of the arrangement kept.
 *
 * The undo the pointer never had. A drag can move a station anywhere but cannot
 * say *and now forget where I put this one* — there is no gesture for putting a
 * thing back where you never chose to have it — so the keyboard carries it, and
 * what it goes through is this same one seam and this same one write.
 *
 * Back to *generated* and not back to *where it was before the drag*: this
 * module remembers arrangements, not histories, and the cell `plateOf` gives an
 * unpinned station is the one the map itself would have drawn.
 */
export function unpinStation(node: number): void {
  const current = store.read();
  if (!current.has(node)) return;
  const next = new Map(current);
  next.delete(node);
  replace(next);
  void writePins(open.folder, open.map, next);
}

/**
 * The whole arrangement, given back to the plate.
 *
 * An empty list rather than a deleted key: the store already reads *nothing
 * pinned* off one, so clearing travels the same path a pin does and lands as a
 * fact somebody wrote rather than as an absence somebody has to interpret. The
 * drawing that comes back is `plateOf` with no pins in it, which is the picture
 * the map would have had before any hand touched it — and clearing a plate that
 * nobody arranged writes nothing at all.
 */
export function clearPins(): void {
  if (store.read().size === 0) return;
  replace(NOTHING_PINNED);
  void writePins(open.folder, open.map, NOTHING_PINNED);
}
