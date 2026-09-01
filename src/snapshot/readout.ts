/**
 * The derived model, as one line of text.
 *
 * Deliberately a **diagnostic and not the route**. The view is built — the
 * nodes, their four states, the singular frontier — and this stays beside it
 * rather than being replaced by it: these are the numbers the view is built
 * from, spelled, so a view that listed the wrong thing has something on screen
 * to disagree with. A list and a sentence derived from one model can only
 * differ if one of them is wrong, and one line of text is the cheapest witness
 * a rendering ticket can be held to.
 *
 * Every value in it was decided in Rust. Nothing on this side counts, filters,
 * ranks or resolves; the phase, the three counts and the frontier arrive
 * already settled, and this only spells them.
 *
 * The ledger is not spelled here. Its words and its numeral live in
 * `chrome/ledger.ts`, which is the one file in `src/` allowed to name a change
 * — the same rule `chrome/stamp.ts` holds the staleness vocabulary to.
 */

import type { Frontier, Model, Phase } from "./model.generated";

/**
 * What each rung of the ladder is called on screen.
 *
 * `satisfies Record<Phase, string>` and not a bare `as const`, for the reason
 * `STATE_NAMES` carries the same annotation: the union is erased before
 * runtime, so this object is the only exhaustive witness to the ladder that
 * survives into a test. A sixth rung cannot be added in Rust without this
 * failing to compile, and the fixture gate that crosses these keys with the
 * checked-in snapshots is then red until the fixture reaching that rung lands.
 * The `as const` stays in front of it so the values keep their literal types.
 */
export const PHASE_NAMES = {
  done: "done",
  unstarted: "unstarted",
  wayfinding: "wayfinding",
  specced: "specced",
  specReady: "spec-ready",
} as const satisfies Record<Phase, string>;

export const NO_MAP_OPEN = "no map open";

/**
 * *Nothing to start* rather than a number, because an absent frontier is a
 * state with its own reading — a map can have work left on it and still have
 * nothing an agent may be launched at.
 */
export const NO_FRONTIER = "nothing to start";

/**
 * The other reading of an empty frontier, and two sentences rather than one.
 *
 * A map with tickets left on it that *this machine* cannot start is a different
 * fact from a map with nothing left at all: the first is finished for you and
 * not for the project, and somebody reading *nothing to start* on it would
 * graduate the fog or compose the spec on the strength of it. One sentence for
 * both is exactly what makes the first read as the second.
 *
 * Neither phrase contains the other, so a test can tell them apart and so can
 * a person glancing at the line.
 */
export const NOTHING_FOR_THIS_MACHINE = "nothing for this machine";

/**
 * The three readings the model settled on, spelled. Which of them applies was
 * decided in Rust — this only picks the words.
 */
function describeFrontier(frontier: Frontier): string {
  switch (frontier.frontier) {
    case "designated":
      return `frontier #${frontier.number}`;
    case "notOnThisMachine":
      return NOTHING_FOR_THIS_MACHINE;
    case "nothingToStart":
      return NO_FRONTIER;
  }
}

export function describeModel(model: Model): string {
  const map = model.map;
  if (map === null) return NO_MAP_OPEN;

  const counts = map.counts;
  const frontier = describeFrontier(map.frontier);

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
