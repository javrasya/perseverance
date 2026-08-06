/**
 * The Route's arithmetic: how far along each ticket sits, how many it opens up,
 * and where every box lands.
 *
 * A pure module, and deliberately so. Nothing here imports React, touches the
 * DOM, reads a clock or a store, or asks anything a second time — `routeOf`
 * called twice on the same model answers with the same numbers, which is what
 * buys the layout the right not to be stored anywhere. There are no node
 * positions in this app; there are only these constants and this arithmetic.
 *
 * The failure it exists to prevent is a ranking the map cannot justify. Two
 * halves of that. **Rank comes from an explicit edge set**, so a rank on screen
 * is always *this ticket waits on that one* and never a heuristic — and the
 * edge set is the model's own, transposed rather than inferred, so a column
 * that cannot be justified from the map is a column that cannot be drawn.
 * **Intra-rank order comes from `map.nodes` and nothing else**, walked once in
 * array order into buckets:
 * there is no comparator in this file, no sort call, and no crossing
 * minimisation, because the operator dragged these into this order in GitHub's
 * own UI and re-arranging their rows to make lines cross less is answering a
 * question nobody asked with an authority nobody granted.
 */

import type { Map, Node, NodeState } from "../../snapshot/model.generated";

/*
 * `Map` above is the derived model's map, which shadows the built-in one for
 * the whole of this file. The alias is how the lookup tables here are built —
 * the model's vocabulary is the one worth keeping, and the collection is the
 * incidental thing that gets renamed.
 */
const Lookup = globalThis.Map;

/* -------------------------------------------------------- dependencies --- */

/**
 * One dependency, as the graph reads it: `before` must be resolved first and
 * `after` is the one waiting. Issue numbers on both ends, never indices —
 * `map.nodes` order is the operator's and an index into it is a fact about an
 * array rather than about the work.
 */
export type RouteEdge = { readonly before: number; readonly after: number };

/**
 * The dependency edges of a map, read off the nodes that carry them.
 *
 * A transposition and not a derivation. The derived [`Node`] arrives with
 * `waitsOn` — every blocker GitHub named for it, decided in Rust, filtered
 * there to this repository and carried verbatim — so all this does is turn a
 * list hanging off the one waiting into a pair naming both ends. Nothing here
 * judges an edge: an edge naming something with no row on this map is counted
 * by `rankNodes` and said in words by the view, because dropping it silently
 * would move a rank with nothing on screen to account for the move.
 *
 * There is deliberately no *nobody read them* case. Adjacency crosses the seam
 * beside the node it belongs to, so the numbers arrive with the model or the
 * model did not arrive — and a node that waits on nothing is a source, which
 * is a fact rather than an absence.
 */
export function edgesOf(map: Map): readonly RouteEdge[] {
  const edges: RouteEdge[] = [];
  for (const node of map.nodes) {
    for (const before of node.waitsOn) edges.push({ before, after: node.number });
  }
  return edges;
}

/* ------------------------------------------------------------- ranking --- */

/**
 * A ranking, with what it could not do reported beside what it could.
 *
 * `unsettled` and `beyondTheMap` are here rather than swallowed because both
 * are ways a rank can be quietly wrong: a cycle has no longest path, and an
 * edge to a node with no row changes a rank while being invisible on screen.
 * A ranker that dropped either would answer confidently and be unjustifiable
 * from what is drawn.
 */
export type Ranking = {
  readonly ranks: ReadonlyMap<number, number>;
  /** Both ends of every back edge, de-duplicated and in map order. */
  readonly unsettled: readonly number[];
  /** Edges naming a number that is not a child of this map, counted. */
  readonly beyondTheMap: number;
};

/**
 * Longest path, which is the only ranking that reads as *how far along*.
 *
 * A node with nothing before it is rank 0; anything else is one past the
 * furthest thing it waits on. Longest and not shortest, because a ticket that
 * waits on both a source and a four-deep chain is four deep — the short way in
 * says nothing about when it can start.
 *
 * A memoised descent with a grey set, so a cycle terminates instead of
 * recursing forever: re-entering a node that is still on the stack contributes
 * nothing for that edge and puts both of its ends in `unsettled`. Terminating
 * quietly with a plausible number would be the worse failure of the two.
 */
export function rankNodes(nodes: readonly Node[], edges: readonly RouteEdge[]): Ranking {
  const waitedOn = new Lookup<number, number[]>();
  for (const node of nodes) waitedOn.set(node.number, []);

  let beyondTheMap = 0;
  for (const edge of edges) {
    const after = waitedOn.get(edge.after);
    if (after === undefined || !waitedOn.has(edge.before)) {
      // A node with no row is not drawable, and an edge to one would move a
      // rank with nothing on screen to account for the move.
      beyondTheMap += 1;
      continue;
    }
    after.push(edge.before);
  }

  const ranks = new Lookup<number, number>();
  const onTheStack = new Set<number>();
  const unsettled = new Set<number>();

  function rankOf(number: number): number {
    const settled = ranks.get(number);
    if (settled !== undefined) return settled;

    onTheStack.add(number);
    let rank = 0;
    for (const predecessor of waitedOn.get(number) ?? []) {
      if (onTheStack.has(predecessor)) {
        // A back edge. Descending would not terminate, so it contributes
        // nothing and both ends are reported rather than silently mis-ranked.
        unsettled.add(predecessor);
        unsettled.add(number);
        continue;
      }
      rank = Math.max(rank, 1 + rankOf(predecessor));
    }
    onTheStack.delete(number);

    ranks.set(number, rank);
    return rank;
  }

  for (const node of nodes) rankOf(node.number);

  return {
    ranks,
    // Map order, because every list this app puts on screen is in map order and
    // a numerically sorted one would be the only exception.
    unsettled: nodes.map((node) => node.number).filter((number) => unsettled.has(number)),
    beyondTheMap,
  };
}

/**
 * How many tickets each node opens up: out-degree over distinct on-map
 * successors.
 *
 * Distinct, because two edges saying the same thing are one thing being
 * unlocked. On-map, because a number with no row here is not something this
 * screen can claim to unlock.
 */
export function unlocksFrom(
  nodes: readonly Node[],
  edges: readonly RouteEdge[],
): ReadonlyMap<number, number> {
  const opened = new Lookup<number, Set<number>>();
  for (const node of nodes) opened.set(node.number, new Set());

  for (const edge of edges) {
    const from = opened.get(edge.before);
    if (from === undefined || !opened.has(edge.after)) continue;
    from.add(edge.after);
  }

  const counts = new Lookup<number, number>();
  for (const node of nodes) counts.set(node.number, opened.get(node.number)?.size ?? 0);
  return counts;
}

/* ------------------------------------------------------------ geometry --- */

/*
 * Six numbers, and the layout is all of them. Ranks are columns left to right;
 * nodes stack top to bottom inside a column, in map order. Rank 0 being
 * structurally wide — a charting session produces a burst of independent
 * tickets — is therefore a long first column that scrolls, which is a shape
 * this is indifferent to rather than one it has to cope with.
 */

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 56;
export const RANK_GAP = 96;
export const ROW_GAP = 16;
export const MARGIN = 24;

/**
 * How much title fits on a node. SVG text does not wrap, so a budget is the
 * whole of the wrapping story — there is no second measure and no ellipsis
 * that the browser applies for us.
 */
export const TITLE_BUDGET = 34;

export function elide(title: string, budget = TITLE_BUDGET): string {
  if (title.length <= budget) return title;
  return `${title.slice(0, budget - 1)}…`;
}

/** One node, ranked, placed and labelled. Nothing here is stored anywhere. */
export type RouteNode = {
  readonly node: Node;
  readonly rank: number;
  /** `map.frontier` said so. Never re-resolved on this side. */
  readonly frontier: boolean;
  /**
   * How many tickets this one opens up, over distinct on-map successors. Zero
   * is *this opens nothing up* — a fact, and one worth no ink, which is why
   * the view draws the number only when there is something to draw.
   */
  readonly unlocks: number;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type RouteRow = { readonly rank: number; readonly nodes: readonly RouteNode[] };

/**
 * One drawable edge. Computed for every on-map dependency; **which of them get
 * drawn is the view's decision, and the Route's answer is almost none of
 * them** — see `Route.tsx` and ADR 0005.
 */
export type RouteLink = {
  readonly before: number;
  readonly after: number;
  readonly path: string;
};

export type Route = {
  readonly rows: readonly RouteRow[];
  readonly links: readonly RouteLink[];
  readonly width: number;
  readonly height: number;
  /**
   * What the columns cannot account for, carried out beside them: tickets that
   * wait on each other, and edges naming something with no row here. Both are
   * the caller's to say in words — rows that are quietly a guess are the one
   * thing this may not hand back.
   */
  readonly unsettled: readonly number[];
  readonly beyondTheMap: number;
};

/**
 * The whole layout, computed from the model and six constants, every call.
 *
 * One argument, because there is nothing else to give it: the edges are the
 * map's own and the geometry is these constants, so the picture is a function
 * of the derived model and of nothing a caller could vary.
 *
 * The rows are built by walking `map.nodes` exactly once in array order and
 * appending into the bucket for each node's rank. That single pass is the
 * entirety of intra-rank ordering: no comparator, no second pass, nothing that
 * could reorder a row the operator arranged.
 */
export function routeOf(map: Map): Route {
  const edges = edgesOf(map);

  const ranking = rankNodes(map.nodes, edges);
  const unlocks = unlocksFrom(map.nodes, edges);

  const buckets = new Lookup<number, RouteNode[]>();
  const placed = new Lookup<number, RouteNode>();
  let deepest = -1;

  for (const node of map.nodes) {
    const rank = ranking.ranks.get(node.number) ?? 0;

    let bucket = buckets.get(rank);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(rank, bucket);
    }

    const placedNode: RouteNode = {
      node,
      rank,
      frontier: node.number === map.frontier,
      unlocks: unlocks.get(node.number) ?? 0,
      label: elide(node.title),
      x: MARGIN + rank * (NODE_WIDTH + RANK_GAP),
      y: MARGIN + bucket.length * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };

    bucket.push(placedNode);
    placed.set(node.number, placedNode);
    if (rank > deepest) deepest = rank;
  }

  // Counted up from zero rather than collected and ordered, so the columns are
  // left to right without anything being sorted into place.
  const rows: RouteRow[] = [];
  for (let rank = 0; rank <= deepest; rank += 1) {
    const bucket = buckets.get(rank);
    if (bucket !== undefined) rows.push({ rank, nodes: bucket });
  }

  const links: RouteLink[] = [];
  for (const edge of edges) {
    const from = placed.get(edge.before);
    const to = placed.get(edge.after);
    if (from === undefined || to === undefined) continue;
    links.push({ before: edge.before, after: edge.after, path: linkPath(from, to) });
  }

  // A map with nothing on it is a margin and nothing in it, not a zero-sized
  // canvas that collapses whatever is drawn around it.
  let width = 2 * MARGIN;
  let height = 2 * MARGIN;
  for (const row of rows) {
    for (const one of row.nodes) {
      width = Math.max(width, one.x + one.width + MARGIN);
      height = Math.max(height, one.y + one.height + MARGIN);
    }
  }

  return {
    rows,
    links,
    width,
    height,
    unsettled: ranking.unsettled,
    beyondTheMap: ranking.beyondTheMap,
  };
}

/**
 * A hand-written cubic bezier from the right edge of one node to the left edge
 * of the next, leaving and arriving horizontally.
 *
 * Hand-written because a router is a dozen lines and a layout library is a
 * dependency that owns rendering — and because the control offset being half a
 * rank gap is the only thing that makes a link read as *crosses one column*.
 */
export function linkPath(from: RouteNode, to: RouteNode): string {
  const reach = RANK_GAP / 2;
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

/* ---------------------------------------------------------------- copy --- */

/**
 * Said when tickets wait on each other. There is no longest path through a
 * cycle, so the columns around it are a guess — and a guess that says so is
 * worth more than a confident number nobody can check.
 */
export const UNSETTLED_NOTE =
  "these tickets wait on each other, so no order among them is the true one";

/**
 * Said when a dependency points at something that is not a child of this map.
 * The edge is real and the row is not, so it is reported rather than drawn to
 * nowhere or dropped in silence.
 */
export const BEYOND_THE_MAP =
  "some of what these tickets wait on is not a child of this map, so it has no row here";

/** What a node opens up, as a number and never as a spray of edges. */
export function unlocksLabel(count: number): string {
  return `unlocks ${count}`;
}

/**
 * The on-screen word for each of the four states.
 *
 * The model's own words, deliberately unchanged, in the shape `PHASE_NAMES`
 * already established: the screen and the type say the same thing, so an
 * operator reading *blocked* and a developer reading `NodeState::Blocked` are
 * reading one vocabulary. The palette is neutrals and one indigo, so the word
 * is doing most of the work and cannot be a synonym.
 */
export const STATE_NAMES: Record<NodeState, string> = {
  resolved: "resolved",
  blocked: "blocked",
  claimed: "claimed",
  takeable: "takeable",
};
