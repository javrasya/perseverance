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
 * **Two functions, and the storage is behind them.** `localStorage` is the same
 * shape the eventual store has (per-key, survives restart), so the later slice
 * of #52 that moves this into the Rust `map_view` table changes this file and
 * nothing else. The seam is deliberately this narrow: nothing outside here knows
 * the key format, and nothing outside here knows there is a key at all.
 *
 * A stored value that does not parse reads as **absence** and the caller gets
 * the default detent — never a throw, never a zero. Same house rule as
 * `agent_override` in `crates/app`: a store that has gone bad costs you a
 * remembered position, not a working window.
 *
 * With no map open there is no key and no default of its own: the shell opens at
 * [`DEFAULT_DETENT`] and remembers nothing, because *nothing open* is not a
 * place you can come back to.
 */

const PREFIX = "perseverance.dial.";

function keyFor(folder: string | null, map: number | null): string | null {
  if (folder === null || map === null) return null;
  return `${PREFIX}${folder}#${map}`;
}

export function readPosition(folder: string | null, map: number | null): number {
  const key = keyFor(folder, map);
  if (key === null) return fractionOf(DEFAULT_DETENT);
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fractionOf(DEFAULT_DETENT);
    const parsed = Number.parseFloat(stored);
    // Absence, not failure: anything that is not a fraction of a window is
    // something this app did not write, and the default is a working answer.
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return fractionOf(DEFAULT_DETENT);
    }
    return clamp(parsed);
  } catch {
    // A WebView with storage denied still gets a working dial; it just opens at
    // the default every time.
    return fractionOf(DEFAULT_DETENT);
  }
}

export function writePosition(
  folder: string | null,
  map: number | null,
  position: number,
): void {
  const key = keyFor(folder, map);
  if (key === null) return;
  try {
    window.localStorage.setItem(key, String(clamp(position)));
  } catch {
    // Same as above: the position lasts the session rather than forever.
  }
}
