/**
 * The one walk over `waitsOn`, shared by every view that has to say what holds
 * a ticket up.
 *
 * It lives here rather than inside a view because two of them now ask the same
 * question — The Route prints `blocked by N` under a heading, Deep Field ranks
 * the same adjacency into columns and draws it — and a second walk written
 * beside the first is a second answer, free to disagree with it about the one
 * thing both are for. The tally is arithmetic over the model's own words, so it
 * is not view identity and belongs to neither of them.
 *
 * Nothing here is geometry. A rank, a coordinate and an edge's shape are each
 * the drawing view's own business and stay in it; what crosses this seam is
 * only *what does this node wait on, and is this map in a position to judge it*.
 */

import type { Node } from "../snapshot/model.generated";

/*
 * The model's `Map` shadows the built-in one wherever it is imported, and both
 * files that build tables over nodes spell the collection this way: the model's
 * vocabulary is the one worth keeping, and the container is the incidental
 * thing that gets renamed.
 */
const Lookup = globalThis.Map;


/**
 * What a node waits on, split by whether this map is in a position to judge it.
 */
export type BlockerTally = {
  /** Named blockers with a row on this map that this map does not show as resolved. */
  readonly unresolved: number;
  /** Named blockers with no row here, which this map cannot judge either way. */
  readonly beyondTheMap: number;
};

export const NOTHING_IN_THE_WAY: BlockerTally = { unresolved: 0, beyondTheMap: 0 };

/**
 * Every node's blockers, counted once against the states this map is showing.
 *
 * **This is why `waitsOn` crosses the seam at all.** The derived model carries
 * no per-node blocker count — [`Counts`] is tickets, open and specs, and
 * [`Node`] deliberately withholds the count GitHub decided the state from — so
 * these numbers are the only source for `blocked by N`, which is the whole of
 * what a blocked row says about what holds it up. They are also the only source
 * for the second fact, which is rarer and worse to lose: that a blocker names
 * an issue with no row here, so this map cannot say whether it is done.
 *
 * The two are counted apart rather than summed. A blocker this map can see and
 * a blocker it cannot are different claims, and adding them would print a
 * number the rows on screen cannot account for — the failure this whole file is
 * arranged around. A blocker this map shows as resolved is counted into
 * neither: it is out of the way, which is a fact rather than an absence.
 *
 * **A node this map shows as resolved waits on nothing**, whatever it still
 * names, and that is the same rule read from the other end. GitHub closes an
 * issue without clearing what it was blocked by, so a finished ticket arrives
 * carrying open blockers — the awkward fixture's *finished before the thing it
 * waited on* is exactly that — and tallying them would put `blocked by 1` on a
 * row under the heading *Resolved*. Nothing holds up work that is already done,
 * so the emptying happens here, where the arithmetic is, rather than in the
 * view: a row that reads its own tally can then say all of it.
 */
export function blockersOf(nodes: readonly Node[]): ReadonlyMap<number, BlockerTally> {
  const resolved = new Lookup<number, boolean>();
  for (const node of nodes) resolved.set(node.number, node.state === "resolved");

  const tallies = new Lookup<number, BlockerTally>();
  for (const node of nodes) {
    if (node.state === "resolved") {
      tallies.set(node.number, NOTHING_IN_THE_WAY);
      continue;
    }

    let unresolved = 0;
    let beyondTheMap = 0;
    for (const before of node.waitsOn) {
      const settled = resolved.get(before);
      if (settled === undefined) beyondTheMap += 1;
      else if (!settled) unresolved += 1;
    }
    tallies.set(node.number, { unresolved, beyondTheMap });
  }
  return tallies;
}
