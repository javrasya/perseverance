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
 * Two words, borrowed rather than respelled — the same borrowing `Bench.tsx`
 * states, and it moved here with the chip that prints them: *unclassified* and
 * *spec* are what a child **is**, decided in Rust and already spelled once for
 * the Route.
 */
import { SPEC_TAG, UNCLASSIFIED_TAG } from "../route/route";

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

/**
 * The shortest a plate is ever drawn, and no longer the height of every plate.
 *
 * The width is a constant because columns are the point; the height is not,
 * because a plate's box has to *contain* what the plate says. A cut's reason
 * runs to forty words and four micro chips do not fit on one 182px line, so a
 * single reserved height was a box the content walked out of — which is a plate
 * painted over the wrapped row beneath it, and, for a cut plate, a declaration
 * about blank canvas that was not true. [`heightOf`] answers the box per plate
 * from the plate's own content; this constant is the floor it never goes below,
 * so a sparse plate still reads as the same kind of object as a full one.
 */
export const PLATE_HEIGHT = 64;

/** Horizontal space between two plates in the same row. */
export const PLATE_GAP = 24;

/**
 * The column pitch, and the grid every plate lands on.
 *
 * Plates are placed left to right from the margin at this pitch and a doubled
 * plate swallows exactly one gutter, so the vertical strips *between* the
 * columns are never covered by a standard plate. That is what makes them
 * routable: see [`channelsAt`].
 */
export const COLUMN_PITCH = PLATE_WIDTH + PLATE_GAP;

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

/**
 * Vertical space between two wrapped rows of the same rank.
 *
 * Wider than it needs to be to separate two rows, because it is not only
 * separation: an edge that leaves a plate on a wrapped row descends into the
 * gap *below that row* and runs along it, so an inter-row gap carries lanes the
 * same way a rank gap does — see [`edgesOf`]. It stays well under [`RANK_GAP`]
 * so that a wrapped band still reads as one rank rather than as several.
 */
export const ROW_GAP = 24;

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

/**
 * The rank rail's own column, in pixels, outside the canvas.
 *
 * Rule 11: annotation gets reserved space the topology cannot grow into. The
 * rail is a fixed column beside the drawing, so a rank label never lands on a
 * plate and a plate never has to make room for one.
 *
 * It is a number here rather than only a length in the stylesheet because three
 * things have to agree on it: `Bench.tsx` draws the rail this wide and hands
 * `benchOf` the frame **less this rail**, and `VIEW_FLOORS.bench` in
 * `src/panes/dial.ts` adds it back when it works out how much *map side* a
 * canvas of [`BENCH_WIDTH_FLOOR`] takes. It lives here, in the arithmetic,
 * so the shell can reach it without reaching through a component.
 */
export const RANK_RAIL = 56;

/** How many discrete lanes a gap of this height holds, never fewer than one. */
export function lanesIn(height: number): number {
  return Math.max(1, Math.floor(height / LANE_PITCH) - 1);
}

/** How many discrete lanes a rank gap holds. */
export const LANES_PER_GAP = lanesIn(RANK_GAP);

/**
 * The narrowest **canvas** the Bench will draw on, in pixels.
 *
 * A canvas and not a map side: this is the box `benchOf` is handed, which is
 * the view column's content less [`RANK_RAIL`], and the view column is only one
 * of the boxes inside the map side. `VIEW_FLOORS.bench` in `src/panes/dial.ts`
 * is the map-side number derived from this one, and the two are deliberately
 * different numbers about different boxes.
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

/* ----------------------------------------------------------------- box --- */

/**
 * The words a plate carries, spelled here because they are what sizes its box.
 *
 * They used to live in `Bench.tsx`, next to the elements that print them, and
 * that was the right place while every plate was the same 64px tall. It stopped
 * being: the height of a plate is the height of its own content, and the
 * content is four micro chips whose widths are the widths of *these strings*.
 * A second spelling in the arithmetic would be a box measured against words the
 * screen does not say, so there is one spelling and `Bench.tsx` imports it.
 */

/** How many wait on this plate — the fact The Route has no room for. */
export const fanOutLabel = (count: number): string => `unblocks ${count}`;

/** Blockers this map holds a plate for, and has not seen closed. */
export const waitingOnLabel = (count: number): string => `waiting on ${count}`;

/**
 * Blockers with no plate here at all.
 *
 * Never added to the one above. This map cannot say whether an issue it does
 * not hold is done, so the two are different claims and a sum would print a
 * number the canvas has nothing to account for.
 */
export const beyondTheMapLabel = (count: number): string => `${count} off this map`;

/** What this child is, in the model's own three words. */
export function kindTag(node: Node): string {
  switch (node.kind.kind) {
    case "ticket":
      return node.kind.type;
    case "spec":
      return SPEC_TAG;
    case "unclassified":
      return UNCLASSIFIED_TAG;
  }
}

/** Every chip a plate prints, in the order the plate prints them. */
export function chipsOf(node: Node, facts: NodeFacts): readonly string[] {
  const chips = [fanOutLabel(facts.fanOut.length)];
  if (facts.stillInTheWay > 0) chips.push(waitingOnLabel(facts.stillInTheWay));
  if (facts.beyondTheMap > 0) chips.push(beyondTheMapLabel(facts.beyondTheMap));
  chips.push(kindTag(node));
  return chips;
}

/*
 * The stylesheet's own numbers, restated as arithmetic.
 *
 * Every constant below is one declaration in `Bench.module.css` resolved
 * through `src/styles/tokens/`: the hairline border, `--s-space-tight` padding,
 * the `--s-space-hair` gaps, `--s-text-small` at 1.25 for the title and
 * `--s-text-micro` at 1.3 for the reason. They are duplicated rather than
 * measured because the canvas has to be laid out before anything is on screen
 * to measure, and feeding a measurement back into the layout would make the
 * Bench a function of the DOM instead of a function of the model.
 *
 * A duplicate is only as good as what checks it, so the check is not arithmetic:
 * `tests/conformance/bench-box.spec.ts` renders the real page in a real browser
 * and asserts that no plate's rendered height exceeds the box reserved here. If
 * a token moves, that goes red rather than a plate quietly growing out of its
 * box again.
 *
 * The advances are per-character widths, rounded **up** from the faces the
 * stacks resolve to (a monospace face is 0.6em; `--s-tracking-label` adds
 * 0.08em to a chip). Rounding up costs a few pixels of blank plate and buys the
 * only error direction that is not a plate overlapping its neighbour.
 */
const PLATE_BORDER = 1;
const PLATE_PADDING = 8;
/** `gap: var(--s-space-hair) var(--s-space-tight)` — between flex lines, and along one. */
const CONTENT_GAP = 4;
const CONTENT_SPACE = 8;
/** `.stud`, `flex: 0 0 14px`. */
const STUD = 14;
/** `--s-text-small` at `line-height: 1.25`, and the line `.id` sets in the same size. */
const TEXT_LINE = 17;
/** `-webkit-line-clamp: 2`, so a third line of title is never drawn. */
const TITLE_CLAMP = 2;
/** `--s-text-small` in the body face. */
const TITLE_ADVANCE = 7.5;
/** `--s-text-small` in `--s-font-mono`. */
const SMALL_MONO_ADVANCE = 8.1;
/** `--s-text-micro` in `--s-font-mono`. */
const MICRO_MONO_ADVANCE = 6.9;
/** The same, plus `--s-tracking-label`. */
const CHIP_ADVANCE = 7.7;
/** `.fact`'s padding and its hairline, both sides. */
const CHIP_PADDING = 10;
/** One chip's line box, its border included. */
const CHIP_LINE = 17;
/** `.reason` at `line-height: 1.3`. */
const REASON_LINE = 15;

/**
 * How many lines a string takes in a box this wide.
 *
 * Word wrapping, because that is what the browser does, plus the one thing
 * `overflow-wrap: break-word` adds: a word wider than the box is broken across
 * as many lines as it needs rather than hanging out of it.
 */
function linesOf(text: string, width: number, advance: number): number {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return 0;

  let lines = 1;
  let used = 0;
  for (const word of words) {
    const wide = word.length * advance;
    if (wide > width) {
      if (used > 0) lines += 1;
      const broken = Math.ceil(wide / width);
      lines += broken - 1;
      used = wide - (broken - 1) * width;
      continue;
    }
    const space = used === 0 ? 0 : advance;
    if (used > 0 && used + space + wide > width) {
      lines += 1;
      used = wide;
    } else {
      used += space + wide;
    }
  }
  return lines;
}

/** How many lines the chips wrap onto, packed the way a wrapping flex row packs them. */
function chipLines(chips: readonly string[], width: number): number {
  let lines = 1;
  let used = 0;
  for (const chip of chips) {
    const wide = chip.length * CHIP_ADVANCE + CHIP_PADDING;
    const space = used === 0 ? 0 : CONTENT_GAP;
    if (used > 0 && used + space + wide > width) {
      lines += 1;
      used = wide;
    } else {
      used += space + wide;
    }
  }
  return lines;
}

function widthOfPlate(node: Node): number {
  return node.cut.cut === "fromScope" ? CUT_PLATE_WIDTH : PLATE_WIDTH;
}

/**
 * The box one plate is reserved, from what that plate has to say in it.
 *
 * Three stacked lines of content: the stud, the number and the clamped title;
 * the chips; and, on a cut plate, the reason in the operator's own sentence.
 * Rule 6 forbids every cheaper answer to a long reason — no ellipsis, no
 * smaller face, no hover, no `title` — so the answer is the box, and the box is
 * computed here rather than overflowed on screen. A cut plate is therefore
 * taller as well as wider, and nothing on this canvas overhangs what the
 * arithmetic reserved for it.
 */
export function heightOf(node: Node, facts: NodeFacts): number {
  const content = widthOfPlate(node) - 2 * PLATE_BORDER - 2 * PLATE_PADDING;

  const number = `#${node.number}`.length * SMALL_MONO_ADVANCE;
  const forTitle = Math.max(
    content * 0.4,
    content - STUD - CONTENT_SPACE - number - CONTENT_SPACE,
  );
  const title = Math.min(TITLE_CLAMP, linesOf(node.title, forTitle, TITLE_ADVANCE));

  const chips = chipLines(chipsOf(node, facts), content);
  const reason =
    node.cut.cut === "fromScope"
      ? CONTENT_GAP + linesOf(node.cut.reason, content, MICRO_MONO_ADVANCE) * REASON_LINE
      : 0;

  return Math.max(
    PLATE_HEIGHT,
    2 * PLATE_BORDER +
      2 * PLATE_PADDING +
      Math.max(STUD, title * TEXT_LINE) +
      CONTENT_GAP +
      (chips * CHIP_LINE + (chips - 1) * CONTENT_GAP) +
      reason,
  );
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
 * Where another edge's vertical crosses one of this edge's horizontal runs.
 *
 * `leg` is which run: the segment from `points[leg]` to `points[leg + 1]`. An
 * edge has two horizontal runs when it had to change columns to get down the
 * canvas without crossing a plate, so a bare list of x positions would no
 * longer say which line the break belongs to.
 */
export type Hop = {
  readonly leg: number;
  readonly x: number;
};

/**
 * One drawn dependency: the blocker at `from`, the node that waits at `to`.
 *
 * `points` is an orthogonal polyline and never anything else. In the ordinary
 * case it is the three legs it always was — out of the blocker's face, along a
 * lane, down into the waiting plate. When the two plates are more than one row
 * apart it is five, because the straight run between them would pass through
 * the rows in between: it steps sideways into a routing channel first, runs
 * down that, and steps back out in the lane above the plate that waits. See
 * [`edgesOf`].
 *
 * `hops` are the crossings, and the break belongs to the horizontal line by
 * convention so that a reader following a line down the canvas never loses it.
 */
export type Edge = {
  readonly from: number;
  readonly to: number;
  readonly lane: number;
  readonly points: readonly Point[];
  readonly hops: readonly Hop[];
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
  return Math.max(1, Math.floor((usable + PLATE_GAP) / COLUMN_PITCH));
}

/**
 * One laid row of the canvas, wrapped or not, in the order it is read down the
 * page. Rows are what the router thinks in: a band is a run of them, and the
 * space above each one is where its incoming edges are allowed to run.
 */
type Row = {
  readonly top: number;
  readonly height: number;
  readonly plates: readonly Plate[];
};

/** The blank strip above one row, and the lanes it affords. */
type Gap = {
  readonly top: number;
  readonly lanes: number;
};

function gapsBetween(rows: readonly Row[]): readonly Gap[] {
  return rows.map((row, index) => {
    const above = rows[index - 1];
    const top = above === undefined ? CANVAS_PADDING : above.top + above.height;
    return { top, lanes: lanesIn(row.top - top) };
  });
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
  /* Every row on the canvas, and which one each plate is on. The router works
     in rows rather than in bands: a wrapped band is several rows deep, and an
     edge that treats it as one box runs its verticals through the rows in
     between. */
  const rows: Row[] = [];
  const rowOfPlate = new Lookup<number, number>();

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

    /*
     * Wrapped first, measured second, placed third. A row's height is the
     * tallest box on it and a plate's box is its own content's, so no `y` can
     * be settled until the whole row is known — which is also why the
     * arithmetic wraps the band itself rather than leaving it to CSS.
     */
    const wrapped: { node: Node; row: number; x: number; height: number }[] = [];
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
      const nodeFacts = facts.get(node.number) ?? {
        fanOut: [],
        stillInTheWay: 0,
        beyondTheMap: 0,
      };
      wrapped.push({ node, row, x, height: heightOf(node, nodeFacts) });
      x += plateWidth + PLATE_GAP;
    }

    const rowCount = onRank.length === 0 ? 0 : row + 1;
    const rowHeights = Array.from({ length: rowCount }, (_, index) =>
      Math.max(
        PLATE_HEIGHT,
        ...wrapped.filter((one) => one.row === index).map((one) => one.height),
      ),
    );

    const laid: Plate[] = [];
    let rowTop = top;
    for (let index = 0; index < rowCount; index += 1) {
      const height = rowHeights[index] ?? PLATE_HEIGHT;
      const onRow: Plate[] = [];
      for (const placed of wrapped) {
        if (placed.row !== index) continue;
        const plate: Plate = {
          node: placed.node,
          rank,
          row: index,
          x: placed.x,
          y: rowTop,
          width: widthOfPlate(placed.node),
          height: placed.height,
          reason: placed.node.cut.cut === "fromScope" ? placed.node.cut.reason : null,
          facts: facts.get(placed.node.number) ?? {
            fanOut: [],
            stillInTheWay: 0,
            beyondTheMap: 0,
          },
        };
        onRow.push(plate);
        platesByNumber.set(placed.node.number, plate);
        rowOfPlate.set(placed.node.number, rows.length);
      }
      laid.push(...onRow);
      rows.push({ top: rowTop, height, plates: onRow });
      rowTop += height + ROW_GAP;
    }

    const height =
      rowCount === 0
        ? 0
        : rowHeights.reduce((sum, one) => sum + one, 0) + (rowCount - 1) * ROW_GAP;
    bands.push({ rank, rows: rowCount, top, height, plates: laid });
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
    edges: edgesOf(nodes, rows, rowOfPlate, platesByNumber, columns),
    beyondTheMap,
  };
}

/* --------------------------------------------------------------- edges --- */

/**
 * The vertical strips no plate can be standing in, at this width.
 *
 * Plates are placed from the margin on [`COLUMN_PITCH`], and the doubled plate
 * is exactly two columns plus the gutter it swallows, so the centre line of
 * every gutter between two columns is a strip of canvas a *standard* plate
 * never covers. Those centre lines are the channels an edge drops down when it
 * has rows to get past. A doubled plate does cover the one gutter it swallowed,
 * which is why a channel is chosen per edge against the rows it actually
 * crosses rather than once for the canvas.
 */
function channelsAt(columns: number): readonly number[] {
  const channels: number[] = [];
  for (let column = 0; column + 1 < columns; column += 1) {
    channels.push(CANVAS_PADDING + column * COLUMN_PITCH + PLATE_WIDTH + PLATE_GAP / 2);
  }
  return channels;
}

/**
 * Every drawn dependency, routed so that no line is drawn through a plate.
 *
 * **The lane is the gap above the waiting plate's row**, not above its band. A
 * band that wrapped into eight rows is eight rows deep, and a lane placed once
 * for the whole band is a lane the incoming verticals reach by crossing every
 * row above it — which was this file's stated invariant broken by its own
 * headline feature.
 *
 * The line therefore leaves the blocker into the gap **beside its own row** —
 * below it for an edge that runs down the canvas, above it for the backwards
 * edge a cut cycle leaves — and enters the waiting plate from the top out of
 * the gap above *its* row. When those two gaps are the same one, that is the
 * three-leg polyline this view has always drawn. When they are not, the two
 * lanes are joined down a routing channel ([`channelsAt`]) chosen to miss every
 * plate on every row in between: sideways, down, sideways. Five legs, still
 * orthogonal, still no diagonal and still no curve.
 *
 * Lanes are handed out in edge order and wrapped at the gap's own lane count,
 * so a gap with more edges than lanes reuses one rather than routing outside
 * it. Two edges sharing a lane is a readable overlap; an edge drawn through a
 * plate is not — and now neither is the vertical that reaches it.
 *
 * **The one case that degrades.** If every channel is covered on some row in
 * between — which takes cut plates stacked so their swallowed gutters between
 * them leave nothing free — the least covered channel is taken. That is a line
 * over a plate again, in the one arrangement where the canvas has no clear
 * column left; it is deterministic and it is not silent, because
 * `tests/bench.test.ts` asserts the clean case over the whole fixture.
 */
function edgesOf(
  nodes: readonly Node[],
  rows: readonly Row[],
  rowOfPlate: ReadonlyMap<number, number>,
  platesByNumber: ReadonlyMap<number, Plate>,
  columns: number,
): readonly Edge[] {
  const gaps = gapsBetween(rows);
  const channels = channelsAt(columns);
  const laneCount = new Lookup<number, number>();

  const laneIn = (gap: number): { lane: number; y: number } => {
    const here = gaps[gap];
    if (here === undefined) return { lane: 0, y: 0 };
    const used = laneCount.get(gap) ?? 0;
    laneCount.set(gap, used + 1);
    const lane = used % here.lanes;
    return { lane, y: here.top + LANE_PITCH * (lane + 1) };
  };

  /** The channel that crosses the fewest plates on the rows in between. */
  const channelFor = (first: number, last: number, near: number): number => {
    const crossed = rows.slice(first, last).flatMap((row) => row.plates);
    let best = near;
    let bestCover = Number.POSITIVE_INFINITY;
    for (const channel of channels) {
      const cover = crossed.filter(
        (plate) => plate.x < channel && channel < plate.x + plate.width,
      ).length;
      if (cover < bestCover || (cover === bestCover && Math.abs(channel - near) < Math.abs(best - near))) {
        best = channel;
        bestCover = cover;
      }
    }
    return best;
  };

  const routed: {
    edge: Omit<Edge, "hops">;
    verticals: readonly { x: number; from: number; to: number }[];
  }[] = [];

  for (const node of nodes) {
    const to = platesByNumber.get(node.number);
    const toRow = rowOfPlate.get(node.number);
    if (to === undefined || toRow === undefined) continue;
    for (const before of node.waitsOn) {
      const from = platesByNumber.get(before);
      const fromRow = rowOfPlate.get(before);
      if (from === undefined || fromRow === undefined) continue;

      const fromX = from.x + from.width / 2;
      const toX = to.x + to.width / 2;

      /* The gap above the waiting plate's row is where the line arrives; the
         gap beside the blocker's own row is where it sets off. */
      const arrival = toRow;
      const departure = toRow > fromRow ? fromRow + 1 : fromRow;

      if (arrival === departure) {
        const { lane, y } = laneIn(arrival);
        // The blocker is left from the face the lane is on: below it when the
        // lane is below, above it when the cut cycle put the lane overhead.
        const fromY = y >= from.y + from.height ? from.y + from.height : from.y;
        routed.push({
          edge: {
            from: before,
            to: node.number,
            lane,
            points: [
              { x: fromX, y: fromY },
              { x: fromX, y },
              { x: toX, y },
              { x: toX, y: to.y },
            ],
          },
          verticals: [
            { x: fromX, from: Math.min(fromY, y), to: Math.max(fromY, y) },
            { x: toX, from: y, to: to.y },
          ],
        });
        continue;
      }

      const down = arrival > departure;
      const leaving = laneIn(departure);
      const { lane, y: arriveY } = laneIn(arrival);
      const fromY = down ? from.y + from.height : from.y;
      const channel = channelFor(
        Math.min(departure, arrival),
        Math.max(departure, arrival),
        (fromX + toX) / 2,
      );

      routed.push({
        edge: {
          from: before,
          to: node.number,
          lane,
          points: [
            { x: fromX, y: fromY },
            { x: fromX, y: leaving.y },
            { x: channel, y: leaving.y },
            { x: channel, y: arriveY },
            { x: toX, y: arriveY },
            { x: toX, y: to.y },
          ],
        },
        verticals: [
          { x: fromX, from: Math.min(fromY, leaving.y), to: Math.max(fromY, leaving.y) },
          {
            x: channel,
            from: Math.min(leaving.y, arriveY),
            to: Math.max(leaving.y, arriveY),
          },
          { x: toX, from: arriveY, to: to.y },
        ],
      });
    }
  }

  return routed.map(({ edge }, index) => {
    const hops: Hop[] = [];
    for (let leg = 0; leg + 1 < edge.points.length; leg += 1) {
      const start = edge.points[leg];
      const end = edge.points[leg + 1];
      if (start === undefined || end === undefined || start.y !== end.y) continue;
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);

      const at = new Set<number>();
      routed.forEach((other, otherIndex) => {
        if (otherIndex === index) return;
        for (const vertical of other.verticals) {
          // Strictly inside, at both ends: a vertical that stops on this lane
          // is an edge sharing a corner with it, not a crossing, and breaking
          // the line there would draw a gap where two lines meet.
          if (vertical.x <= left || vertical.x >= right) continue;
          if (vertical.from >= start.y || vertical.to <= start.y) continue;
          at.add(vertical.x);
        }
      });
      for (const x of [...at].sort((one, other) => one - other)) hops.push({ leg, x });
    }

    return { ...edge, hops };
  });
}
