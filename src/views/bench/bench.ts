/**
 * The Bench's arithmetic: which rank each node sits on, where its plate lands
 * once the rank is wider than the window, and how the lines between them run.
 *
 * A pure module, in the same sense `route.ts` is one. Nothing here imports
 * React, touches the DOM, measures an element, reads a clock or a store, and
 * **nothing is remembered between two calls** — `benchOf(model, width)` is
 * recomputed from its two arguments every time, so there is no module-level
 * cache of positions and nothing written to `localStorage`. That is contract
 * rule 8 held by construction rather than by discipline: a stored coordinate is
 * a coordinate that outlives the map it was computed for, and the first thing
 * an operator would see is a plate sitting where a ticket used to be.
 *
 * **No layout library, and the omission is the decision.** The edges are
 * already in the model — `waitsOn` is every blocker the answer named — so the
 * ranking is a longest path over an adjacency that arrives spelled out, which
 * is the dozen lines below and not a dependency. What a graph library would
 * bring with it is the thing this view must not do: it would re-order the rows
 * inside a rank to reduce crossings. See [`benchOf`].
 *
 * **The shape it is drawn in.** Ranks run down the canvas and plates run across
 * them, so a rank is a horizontal band and rank 0 — the sources, everything the
 * map can start on — is the widest band there is. On the fixture this view was
 * built against, eleven of twenty sources feed the four ranks behind them; on a
 * real map rank 0 is usually the offender, which is why wrapping a band into
 * rows is in this file rather than left to the browser: a band that wrapped by
 * CSS would keep its order but lose the lane arithmetic the edges into it are
 * drawn from.
 *
 * **Crossings, and why they are allowed.** Bench draws a 90° crossing with a
 * break in the horizontal line and does not curve anything. A curve at this
 * scale reads as a relationship rather than a wire, and two curves that meet
 * are ambiguous in a way two straight lines never are; a break is the oldest
 * schematic convention there is and it costs six pixels. The corollary is that
 * crossings are not minimised, because minimising them means re-ordering rows
 * the operator dragged into place.
 */

import type { Map as MapModel, Model, Node } from "../../snapshot/model.generated";

/*
 * `Map` from the model shadows the built-in one for the whole of this file, the
 * same way it does in `route.ts`. The model's vocabulary is the one worth
 * keeping; the collection is what gets renamed.
 */
const Lookup = globalThis.Map;

/* ------------------------------------------------------------- metrics --- */

/**
 * One plate, and the width every measurement here is stated in.
 *
 * A plate holds a number, a state mark and a title that wraps to two lines at
 * this width in the sizes `Route.module.css` already uses. It is a constant
 * rather than something measured because the canvas has to be laid out before
 * anything is on screen to measure — and a schematic whose plates are each as
 * wide as their own title is a schematic with no columns in it.
 */
export const PLATE_WIDTH = 200;
export const PLATE_HEIGHT = 64;

/** Horizontal space between two plates in the same row. */
export const PLATE_GAP = 24;

/**
 * The double plate, for a ticket the map document cut.
 *
 * A cut carries a reason in the operator's own sentence, and those sentences
 * are long — `wide-map`'s runs to forty words. Rule 6 says the answer at this
 * scale is layout and not styling, so the reason is given twice the width to be
 * laid out in rather than a smaller font, an ellipsis or a hover. Twice plus
 * the gutter it swallows, so a doubled plate still lands on the column pitch
 * and a band with a cut in it keeps its columns.
 */
export const CUT_PLATE_WIDTH = PLATE_WIDTH * 2 + PLATE_GAP;

/** Vertical space between two wrapped rows of the same rank. */
export const ROW_GAP = 16;

/**
 * The vertical space between two bands, and the whole of what the edges have to
 * run in.
 *
 * It is [`LANE_PITCH`] times the number of lanes plus a plate's worth of
 * approach, so a band whose incoming edges all want a lane of their own has
 * somewhere to put them — see [`LANES_PER_GAP`].
 */
export const RANK_GAP = 72;

/**
 * The gutter lane pitch, in pixels, and edges run on multiples of it.
 *
 * Discrete lanes rather than free routing: two lines a pixel apart read as one
 * fat line, and two lines six apart read as two. It also makes a crossing a
 * comparison of integers rather than of floats, which is what keeps the hop
 * gaps below deterministic.
 */
export const LANE_PITCH = 6;

/** How wide the break in a horizontal line is where another line crosses it. */
export const HOP_GAP = 6;

/** The margin around the whole canvas. */
export const CANVAS_PADDING = 16;

/** How many discrete lanes a rank gap holds. */
export const LANES_PER_GAP = Math.floor(RANK_GAP / LANE_PITCH) - 1;

/**
 * The narrowest map side the Bench will draw on, in pixels.
 *
 * Three plates across, plus their gutters and the canvas margin:
 * `3 * 200 + 2 * 24 + 2 * 16`. The number is chosen from what the drawing has
 * to say rather than from what will fit — two plates side by side is not a
 * schematic, it is a list with wires on it, and the Route is a better list than
 * a two-column Bench will ever be. Below three columns every band on a normal
 * map wraps into a tall stack, the ranks stop being legible as ranks, and what
 * an operator gets is a squashed diagram that says less than the pane it
 * replaced.
 *
 * It is deliberately below The Plate's hard ~700: The Plate's floor is set by a
 * single detailed card that stops being readable, and there is nothing it can
 * shed. Bench's is set by how many columns are left, so it degrades in steps
 * rather than falling off a cliff — and Bench's recorded weakness is the other
 * end of the scale anyway (under eight nodes it reads pompous, which is a
 * question about the map and not about the window, so it is not this
 * constant's to answer).
 */
export const BENCH_WIDTH_FLOOR = 3 * PLATE_WIDTH + 2 * PLATE_GAP + 2 * CANVAS_PADDING;

/* --------------------------------------------------------------- ranks --- */

/**
 * How far along each node is: the longest path in edges from any source.
 *
 * Longest path rather than shortest, because a rank is *everything that had to
 * happen first*, and a node reachable in one hop and in four sits behind the
 * four.
 *
 * **Cycle-safe, and that is not a nicety.** An operator can tangle a map in
 * GitHub's own UI — `awkward-map` closes one on purpose, #71 waiting on #72
 * waiting on #75 waiting on #71 — and a ranker that recursed into it would
 * either hang or blow the stack, which is a blank window over a map that is
 * merely wrong. The walk below marks a node while it is being resolved and
 * treats an edge back into that mark as contributing nothing: the cycle is cut
 * at whichever edge the walk reached last, deterministically, because the walk
 * starts in `map.nodes` order and visits `waitsOn` in the order the answer
 * listed. The map still draws, and the edge that was cut is still drawn as an
 * edge — it just runs back up the canvas instead of down it.
 *
 * Numbers in `waitsOn` with no row on this map are skipped entirely. They are
 * facts about the ticket, not edges: this map cannot say what rank an issue it
 * does not hold is on, and inventing one for it would put a plate on the canvas
 * for something the operator cannot see the state of. See [`NodeFacts`].
 */
function ranksOf(nodes: readonly Node[]): ReadonlyMap<number, number> {
  const byNumber = new Lookup<number, Node>();
  for (const node of nodes) byNumber.set(node.number, node);

  const ranks = new Lookup<number, number>();
  const resolving = new Set<number>();

  const rankOf = (node: Node): number => {
    const known = ranks.get(node.number);
    if (known !== undefined) return known;
    if (resolving.has(node.number)) return -1;

    resolving.add(node.number);
    let rank = 0;
    for (const before of node.waitsOn) {
      const blocker = byNumber.get(before);
      if (blocker === undefined) continue;
      const behind = rankOf(blocker);
      if (behind < 0) continue;
      rank = Math.max(rank, behind + 1);
    }
    resolving.delete(node.number);
    ranks.set(node.number, rank);
    return rank;
  };

  for (const node of nodes) rankOf(node);
  return ranks;
}

/* --------------------------------------------------------------- facts --- */

/**
 * What a plate can say about its own edges, counted once here.
 *
 * `fanOut` is the half The Route does not draw. A grouped list can only say
 * what a row waits *on*; the Bench has the space to say what waits on it, which
 * is the question *is this the one to unblock* — and that is the reason the
 * view exists beside the Route rather than instead of it. It is in `map.nodes`
 * order, like everything else here.
 *
 * `stillInTheWay` and `beyondTheMap` are counted apart for the reason
 * `route.ts` counts them apart: a blocker this map shows and a blocker it has
 * never heard of are different claims, and summing them would print a number
 * the canvas cannot account for. Both are derived from `waitsOn` and from the
 * states already on the model — no state is re-derived here, and there is no
 * second frontier resolver: the frontier is whatever `map.frontier` says.
 */
export type NodeFacts = {
  readonly fanOut: readonly number[];
  readonly stillInTheWay: number;
  readonly beyondTheMap: number;
};

function factsOf(nodes: readonly Node[]): ReadonlyMap<number, NodeFacts> {
  const resolved = new Lookup<number, boolean>();
  for (const node of nodes) resolved.set(node.number, node.state === "resolved");

  const fanOut = new Lookup<number, number[]>();
  for (const node of nodes) fanOut.set(node.number, []);
  for (const node of nodes) {
    for (const before of node.waitsOn) {
      fanOut.get(before)?.push(node.number);
    }
  }

  const facts = new Lookup<number, NodeFacts>();
  for (const node of nodes) {
    let stillInTheWay = 0;
    let beyondTheMap = 0;
    for (const before of node.waitsOn) {
      const settled = resolved.get(before);
      if (settled === undefined) beyondTheMap += 1;
      else if (!settled) stillInTheWay += 1;
    }
    facts.set(node.number, {
      fanOut: fanOut.get(node.number) ?? [],
      stillInTheWay,
      beyondTheMap,
    });
  }
  return facts;
}

/* --------------------------------------------------------------- plates --- */

export type Plate = {
  readonly node: Node;
  readonly rank: number;
  /** Which wrapped row of its band this plate landed in, counting from 0. */
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The cut's own sentence, which is why this plate is the wide one. */
  readonly reason: string | null;
  readonly facts: NodeFacts;
};

/** One rank, and the rows its plates wrapped into. */
export type Band = {
  readonly rank: number;
  readonly rows: number;
  readonly top: number;
  readonly height: number;
  /** The plates on this band, in `map.nodes` order across the wrap. */
  readonly plates: readonly Plate[];
};

export type Point = { readonly x: number; readonly y: number };

/**
 * One drawn dependency: the blocker at `from`, the node that waits at `to`.
 *
 * `points` is an orthogonal polyline — down out of the blocker, along a lane,
 * down into the waiting plate — and never anything else. `hops` are the x
 * positions on the horizontal run where another edge's vertical crosses it, and
 * the break belongs to the horizontal line by convention so that a reader
 * following a line down the canvas never loses it.
 */
export type Edge = {
  readonly from: number;
  readonly to: number;
  readonly lane: number;
  readonly points: readonly Point[];
  readonly hops: readonly number[];
};

/**
 * The Bench, drawn, or the Bench standing down.
 *
 * The stand-down is a value rather than an empty canvas: a view that cannot
 * honour its floor has to say what it needed and what it was given, because the
 * operator is the one who widens the window. It carries no advice about which
 * view to open instead — that is the dial's answer, and it already has one.
 */
export type Bench =
  | {
      readonly drawn: true;
      readonly width: number;
      readonly height: number;
      /** How many plate columns this width affords. */
      readonly columns: number;
      readonly bands: readonly Band[];
      /** Every plate, in `map.nodes` order. */
      readonly plates: readonly Plate[];
      readonly edges: readonly Edge[];
      /**
       * Numbers waited on that no plate here holds, in the order they were
       * named. Drawn as facts on their plates and never as edges.
       */
      readonly beyondTheMap: readonly number[];
    }
  | {
      readonly drawn: false;
      readonly needs: number;
      readonly has: number;
    };

const STOOD_DOWN = (width: number): Bench => ({
  drawn: false,
  needs: BENCH_WIDTH_FLOOR,
  has: width,
});

const EMPTY = (width: number, columns: number): Bench => ({
  drawn: true,
  width,
  height: CANVAS_PADDING * 2,
  columns,
  bands: [],
  plates: [],
  edges: [],
  beyondTheMap: [],
});

/** How many standard plates fit across a map side this wide. */
export function columnsAt(width: number): number {
  const usable = width - CANVAS_PADDING * 2;
  return Math.max(1, Math.floor((usable + PLATE_GAP) / (PLATE_WIDTH + PLATE_GAP)));
}

function widthOfPlate(node: Node): number {
  return node.cut.cut === "fromScope" ? CUT_PLATE_WIDTH : PLATE_WIDTH;
}

/**
 * The whole layout, from the model and the width and nothing else.
 *
 * **Order inside a rank is `map.nodes` order, and there is no comparator in
 * this file.** The operator dragged those rows into that order in GitHub's own
 * UI; a crossing-minimising pass would reshuffle them into whatever reads
 * tidiest to the algorithm, and an operator who cannot find the ticket they put
 * third has lost more than the crossings were worth. Wrapping preserves it too:
 * a band's rows are read left to right and then down, so the sequence across
 * the wrap is the array's own.
 *
 * `map: null` and a map with no nodes both draw — an empty canvas of the right
 * size rather than a throw. There is nothing to say about a map with nothing on
 * it that a blank band does not already say, and a view that throws on the
 * emptiest state is a view that cannot be opened first.
 */
export function benchOf(model: Model, width: number): Bench {
  if (width < BENCH_WIDTH_FLOOR) return STOOD_DOWN(width);

  const columns = columnsAt(width);
  const map: MapModel | null = model.map;
  if (map === null || map.nodes.length === 0) return EMPTY(width, columns);

  const nodes = map.nodes;
  const ranks = ranksOf(nodes);
  const facts = factsOf(nodes);
  const usable = width - CANVAS_PADDING * 2;

  const lastRank = Math.max(...nodes.map((node) => ranks.get(node.number) ?? 0));

  const plates: Plate[] = [];
  const platesByNumber = new Lookup<number, Plate>();
  const bands: Band[] = [];

  /*
   * The first band starts a whole rank gap down rather than at the margin. A
   * cycle the ranker cut leaves an edge pointing back into rank 0 — `awkward-map`
   * has one, #72's blocker #75 is a source and #75 waits on #71 two ranks
   * behind it — and that edge needs a lane above rank 0 to run in. Reserving it
   * unconditionally costs one gap of blank canvas and means no edge is ever
   * routed off the top of the drawing.
   */
  let top = CANVAS_PADDING + RANK_GAP;

  for (let rank = 0; rank <= lastRank; rank += 1) {
    const onRank = nodes.filter((node) => ranks.get(node.number) === rank);
    const laid: Plate[] = [];

    let row = 0;
    let x = CANVAS_PADDING;
    for (const node of onRank) {
      const plateWidth = widthOfPlate(node);
      // A plate wider than the row it is on still gets placed, alone: refusing
      // to draw it would lose a ticket, and a doubled plate at three columns is
      // exactly the case that would be lost.
      if (x > CANVAS_PADDING && x - CANVAS_PADDING + plateWidth > usable) {
        row += 1;
        x = CANVAS_PADDING;
      }
      const plate: Plate = {
        node,
        rank,
        row,
        x,
        y: top + row * (PLATE_HEIGHT + ROW_GAP),
        width: plateWidth,
        height: PLATE_HEIGHT,
        reason: node.cut.cut === "fromScope" ? node.cut.reason : null,
        facts: facts.get(node.number) ?? {
          fanOut: [],
          stillInTheWay: 0,
          beyondTheMap: 0,
        },
      };
      laid.push(plate);
      platesByNumber.set(node.number, plate);
      x += plateWidth + PLATE_GAP;
    }

    const rows = onRank.length === 0 ? 0 : row + 1;
    const height = rows === 0 ? 0 : rows * PLATE_HEIGHT + (rows - 1) * ROW_GAP;
    bands.push({ rank, rows, top, height, plates: laid });
    plates.push(...laid);
    top += height + RANK_GAP;
  }

  const inMapOrder = new Lookup<number, number>();
  nodes.forEach((node, index) => inMapOrder.set(node.number, index));
  plates.sort(
    (one, other) =>
      (inMapOrder.get(one.node.number) ?? 0) - (inMapOrder.get(other.node.number) ?? 0),
  );

  const beyondTheMap: number[] = [];
  const seenBeyond = new Set<number>();
  for (const node of nodes) {
    for (const before of node.waitsOn) {
      if (platesByNumber.has(before) || seenBeyond.has(before)) continue;
      seenBeyond.add(before);
      beyondTheMap.push(before);
    }
  }

  return {
    drawn: true,
    width,
    height: top - RANK_GAP + CANVAS_PADDING,
    columns,
    bands,
    plates,
    edges: edgesOf(nodes, bands, platesByNumber),
    beyondTheMap,
  };
}

/* --------------------------------------------------------------- edges --- */

/**
 * Every drawn dependency, routed in the lanes above the plate it points at.
 *
 * One rule for every edge, including the ones a cut cycle leaves running
 * backwards: the horizontal run sits in the gap **above the waiting plate's
 * band**, the line leaves the blocker from whichever face the lane is on, and
 * it enters the waiting plate from the top. A backwards edge is then a line
 * that goes up, along and down again — visibly odd, which is correct, because
 * the map it came from is.
 *
 * Lanes are handed out in edge order and wrapped at [`LANES_PER_GAP`], so a
 * band with more incoming edges than lanes reuses one rather than routing
 * outside the gap. Two edges sharing a lane is a readable overlap; an edge
 * drawn through a plate is not.
 */
function edgesOf(
  nodes: readonly Node[],
  bands: readonly Band[],
  platesByNumber: ReadonlyMap<number, Plate>,
): readonly Edge[] {
  const laneCount = new Lookup<number, number>();
  const routed: {
    edge: Omit<Edge, "hops">;
    verticals: readonly { x: number; from: number; to: number }[];
  }[] = [];

  for (const node of nodes) {
    const to = platesByNumber.get(node.number);
    if (to === undefined) continue;
    for (const before of node.waitsOn) {
      const from = platesByNumber.get(before);
      if (from === undefined) continue;

      const band = bands[to.rank];
      if (band === undefined) continue;

      const used = laneCount.get(to.rank) ?? 0;
      laneCount.set(to.rank, used + 1);
      const lane = used % LANES_PER_GAP;
      const laneY = band.top - RANK_GAP + LANE_PITCH * (lane + 1);

      const fromX = from.x + from.width / 2;
      const toX = to.x + to.width / 2;
      // The blocker is left from the face the lane is on: below it when the
      // lane is below, above it when the cut cycle put the lane overhead.
      const leavesBelow = laneY >= from.y + from.height;
      const fromY = leavesBelow ? from.y + from.height : from.y;

      routed.push({
        edge: {
          from: before,
          to: node.number,
          lane,
          points: [
            { x: fromX, y: fromY },
            { x: fromX, y: laneY },
            { x: toX, y: laneY },
            { x: toX, y: to.y },
          ],
        },
        verticals: [
          { x: fromX, from: Math.min(fromY, laneY), to: Math.max(fromY, laneY) },
          { x: toX, from: laneY, to: to.y },
        ],
      });
    }
  }

  return routed.map(({ edge }, index) => {
    const laneY = edge.points[1]?.y ?? 0;
    const left = Math.min(edge.points[1]?.x ?? 0, edge.points[2]?.x ?? 0);
    const right = Math.max(edge.points[1]?.x ?? 0, edge.points[2]?.x ?? 0);

    const hops = new Set<number>();
    routed.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      for (const vertical of other.verticals) {
        // Strictly inside, at both ends: a vertical that stops on this lane is
        // an edge sharing a corner with it, not a crossing, and breaking the
        // line there would draw a gap where two lines meet.
        if (vertical.x <= left || vertical.x >= right) continue;
        if (vertical.from >= laneY || vertical.to <= laneY) continue;
        hops.add(vertical.x);
      }
    });

    return { ...edge, hops: [...hops].sort((one, other) => one - other) };
  });
}
