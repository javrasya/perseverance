/**
 * The derived model, as one line of text.
 *
 * Deliberately a **diagnostic and not the route**. Drawing the graph — the
 * nodes, their four states, the spec as a destination, the receding resolved
 * ones — is the next tickets' work, and inventing it here would be building
 * their UI badly and early. What this is for is that `dev:web` has to show
 * *something* derived, or a fixture that boots proves nothing.
 *
 * Every value in it was decided in Rust. Nothing on this side counts, filters,
 * ranks or resolves; the phase, the three counts and the frontier arrive
 * already settled, and this only spells them.
 */

import type { Model } from "./model.generated";

/** What each rung of the ladder is called on screen. */
export const PHASE_NAMES = {
  done: "done",
  unstarted: "unstarted",
  wayfinding: "wayfinding",
  specced: "specced",
  specReady: "spec-ready",
} as const;

export const NO_MAP_OPEN = "no map open";

/**
 * *Nothing to start* rather than a number, because an absent frontier is a
 * state with its own reading — a map can have work left on it and still have
 * nothing an agent may be launched at.
 */
export const NO_FRONTIER = "nothing to start";

export function describeModel(model: Model): string {
  const map = model.map;
  if (map === null) return NO_MAP_OPEN;

  const counts = map.counts;
  const frontier = map.frontier === null ? NO_FRONTIER : `frontier #${map.frontier}`;

  return [
    `#${map.number}`,
    PHASE_NAMES[map.phase],
    // The spec children and any unclassified child are in `nodes` and not in
    // `tickets`, which is why both numbers are here: one is what is on the map
    // and the other is what the frontier can ever work through.
    `${counts.open}/${counts.tickets} tickets open`,
    `${counts.specs} spec${counts.specs === 1 ? "" : "s"}`,
    `${map.nodes.length} nodes`,
    frontier,
  ].join(" · ");
}
