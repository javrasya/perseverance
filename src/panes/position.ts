import { hasRustBehindIt } from "../snapshot/snapshot";
import { DEFAULT_DETENT, clamp, fractionOf } from "./dial";

/**
 * Where the dial was, last time you were on this map.
 *
 * Per map, deliberately, and that is the one thing this module decides. The
 * view is app-global — see `src/views/views.ts`, which says why — but how much
 * window a map is worth is a fact about the map: a twelve-node map is read at a
 * glance and a hundred-node one is worked at, and coming back to a map you spent
 * an afternoon widening to find it back at the default is the app forgetting
 * what you were doing.
 *
 * **Two functions, and the storage is behind them.** Behind them now is the
 * registry's fourth table, `map_view`, keyed on the folder **id** the store's
 * foreign key is keyed on rather than on the path text — so a folder the
 * operator moves keeps the layouts of its maps. With no Rust behind it —
 * `dev:web`, where the encoding suite runs — the same two functions answer from
 * `localStorage`, which is the same shape (per key, survives a reload) and is
 * why nothing outside this file had to learn there is now a table, a command or
 * a key at all.
 *
 * A stored value that does not parse reads as **absence** and the caller gets
 * the default detent — never a throw, never a zero. Same house rule as
 * `agent_override` in `crates/app`, and it is kept on both sides of the seam: a
 * store that has gone bad, a command that refused, a registry that would not
 * open at all costs you a remembered position, not a working window.
 *
 * With no map open there is no row and no default of its own: the shell opens at
 * [`DEFAULT_DETENT`] and remembers nothing, because *nothing open* is not a
 * place you can come back to. The table says the same thing by having no row
 * that could hold it — `map_view.map_number` is `NOT NULL`.
 *
 * **One write per completed gesture, and none per frame.** That rule is the
 * caller's — `src/App.tsx` writes on a settled occasion only, the same falling
 * edge `src/panes/geometry.ts` uses for a resize — because this file cannot see
 * a hand. What this file guarantees is only that a write it is given goes to
 * exactly one place.
 */

/** Both names are the Rust side's; neither is a string this file invented. */
const READ_COMMAND = "map_position";
const REMEMBER_COMMAND = "remember_map_position";

const PREFIX = "perseverance.dial.";

function keyFor(folder: number | null, map: number | null): string | null {
  if (folder === null || map === null) return null;
  return `${PREFIX}${folder}#${map}`;
}

/**
 * A remembered position, or `null` for anything that is not one.
 *
 * The one place *what a position is* is decided, so the browser's cell and the
 * store's envelope cannot disagree about which values are nonsense.
 */
function usable(value: unknown): number | null {
  const position = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof position !== "number") return null;
  if (!Number.isFinite(position) || position < 0 || position > 1) return null;
  return clamp(position);
}

async function askRust(folder: number, map: number): Promise<number | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return usable(await invoke<number | null>(READ_COMMAND, { folderId: folder, map }));
  } catch {
    return null;
  }
}

async function tellRust(folder: number, map: number, position: number): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(REMEMBER_COMMAND, { folderId: folder, map, position });
  } catch {
    // The window is already showing the move; a registry that would not take it
    // costs the operator the *next* launch's memory of it and nothing more.
  }
}

/**
 * @param folder the folder's id, as the store and the launcher both know it.
 */
export async function readPosition(
  folder: number | null,
  map: number | null,
): Promise<number> {
  const key = keyFor(folder, map);
  if (key === null || folder === null || map === null) return fractionOf(DEFAULT_DETENT);

  if (hasRustBehindIt()) {
    return (await askRust(folder, map)) ?? fractionOf(DEFAULT_DETENT);
  }

  try {
    return usable(window.localStorage.getItem(key)) ?? fractionOf(DEFAULT_DETENT);
  } catch {
    // A WebView with storage denied still gets a working dial; it just opens at
    // the default every time.
    return fractionOf(DEFAULT_DETENT);
  }
}

export async function writePosition(
  folder: number | null,
  map: number | null,
  position: number,
): Promise<void> {
  const key = keyFor(folder, map);
  if (key === null || folder === null || map === null) return;
  const wanted = clamp(position);

  if (hasRustBehindIt()) {
    await tellRust(folder, map, wanted);
    return;
  }

  try {
    window.localStorage.setItem(key, String(wanted));
  } catch {
    // Same as above: the position lasts the session rather than forever.
  }
}
