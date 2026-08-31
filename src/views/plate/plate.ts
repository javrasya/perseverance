/**
 * The Plate's geometry: which rank a ticket sits in, where its station lands,
 * where its name is allowed to go, and what the track between two stations
 * looks like.
 *
 * A pure module. Nothing here imports React, touches the DOM, reads a clock, a
 * store or a stylesheet, and nothing decides a colour: this file answers in
 * numbers and words, and the slice that draws it turns those into marks.
 * `plateOf` called twice on the same model answers byte for byte the same, so
 * the drawing is a function of the derived model and of the authored pins, and
 * of nothing a caller could vary.
 *
 * **The Plate is a Beck diagram over the map's own dependency graph.** Stations
 * are tickets, track is what waits on what, and every run of it is horizontal,
 * vertical or exactly 45° — see `router.ts` for why there are no curves. It is
 * competent between twelve and twenty stations ([`COMPETENCE_BAND`]); under
 * that a diagram is a list with extra ceremony, and far over it the plate turns
 * into a hairball. A *flat* map — one where nothing waits on anything — has no
 * topology for this view to draw at all, and the plate says so rather than
 * drawing twenty stations in one column and calling it a network.
 *
 * **Intra-rank order is `map.nodes` order, full stop.** There is no crossing
 * minimisation here, no barycentre sweep, no median heuristic and no
 * comparator: the operator dragged those children into that order in GitHub's
 * own UI and the model's own doc comment says this app never re-sorts them.
 * Reordering a rank would buy a tidier picture with the operator's own
 * arrangement, so **crossings are accepted output** and a layout that looks
 * better by moving a station within its rank is wrong.
 *
 * **`waitsOn` may name issues that are not on this map.** Those are counted and
 * then dropped: a blocker with no row here gets no rank, no station and no
 * track, because a station drawn for a number the map cannot judge is the plate
 * inventing a ticket. `route.ts` tallies the same fact under the same name.
 *
 * **Nothing here re-derives anything Rust decided.** A node's state and the
 * map's frontier arrive already settled and are carried, never recomputed. The
 * only thing this file derives is geometry, which is the one thing the seam
 * does not carry.
 *
 * Two mechanisms make encoding rule 11 — *a view's graph field may not double
 * as its label surface; annotation gets reserved space the topology cannot grow
 * into* — structural rather than a promise:
 *
 * 1. **The two-cell minimum station gap.** Generated stations are placed a
 *    whole pitch apart, and every station's cell plus a one-cell halo is
 *    blocked to the router, so no track ever runs against a station it is not
 *    serving and no two stations touch.
 * 2. **The eight-anchor label solver.** Every station's annotation gets a
 *    reserved box at one of eight anchors, chosen against the boxes already
 *    placed, the stations, and the corridors track needs to leave and arrive
 *    on. Those boxes go into the router's field as blocked cells, so *track
 *    routed around annotation* is not a rule anybody keeps — it is unreachable.
 */

import type { Map, Node } from "../../snapshot/model.generated";
import {
  type Bounds,
  type Cell,
  type Route,
  cellGap,
  cellKey,
  cellsAlong,
  fieldOf,
  routeTrack,
} from "./router";

/** The Plate's own words, in one place, so a test and the screen agree. */
export const PLATE_LABEL = "The Plate";
export const DESIGNATED_TAG = "designated";
export const CLAIMED_TAG = "claimed";
/* The two kind words are the model's vocabulary rather than this view's: said
   once in `src/views/vocabulary.ts`, and re-exported here so a caller reading
   the Plate's words finds all of them in one list. */
export { SPEC_TAG, UNCLASSIFIED_TAG } from "../vocabulary";
export const BOUND_ELSEWHERE_TAG = "not on this machine";
export const LEGEND_HEADING = "How to read this";
/** The fog's own stamp. It names what is missing before it counts it. */
export const FOG_HEADING = "NOT YET SPECIFIED";
export const NOBODY_SURVEYED = "—";
export const FOG_ALL_CHARTED = "nothing left unspecified";
/**
 * The gesture, said out loud in the margin — both hands of it.
 *
 * Rule 10 the other way round: a station can be moved, and an affordance that
 * only exists under a pointer is an affordance half the operators never find.
 * So the sentence is drawn beside the legend, before anything is hovered, and
 * the cursor is not carrying the news on its own. The keyboard's half is named
 * in the same sentence for exactly the same reason: an arrow key discloses even
 * less than a cursor does, because nothing about a focused station suggests it
 * would move if you pressed one.
 */
export const PIN_NOTE =
  "Drag a station to put it where you want it, or move the one you are on with the " +
  "arrow keys. Backspace puts a station back where the plate drew it. This map remembers.";

/**
 * The arrangement's own undo, and the only control this view has.
 *
 * A button and not a further keystroke: putting every station back is the one
 * gesture here with nothing behind it to undo, and a chord that did it would be
 * a chord discovered by accident. It sits in the margin, reachable by tab like
 * every station, and it says what it does rather than what it undoes.
 */
export const PUT_BACK = "Put every station back";

export type { Cell, Corner, Heading, Route, Segment, SegmentKind } from "./router";

/* `Map` above is the derived model's map and shadows the built-in one for the
   whole of this file — the same trade `route.ts` makes, and for the same
   reason: the model's vocabulary is worth more here than the collection's. */
const Lookup = globalThis.Map;

/* ----------------------------------------------------------- the measures --- */

/** Cells between two ranks. Wide enough for a station's label box on each side
 *  of the gap and a clear relief column down the middle of it — which is what
 *  guarantees the router always has a way past a crowded rank. */
export const COLUMN_PITCH = 8;

/** Cells between two stations of the same rank. Two label boxes tall plus the
 *  station rows themselves. */
export const ROW_PITCH = 5;

/**
 * The gap the router enforces, in cells, between any two stations.
 *
 * Two rather than one: at one cell a diagonal can pass between two stations and
 * read as track touching both. Every station's cell and its halo out to this
 * distance is blocked to the search, so this is a property of the drawing
 * rather than a hope about the pitches above.
 */
export const MIN_STATION_GAP = 2;

/** A reserved label box, in cells. Three by two is a ticket number and a short
 *  title at the sizes this view is legible at; the drawing slice may set the
 *  type, but it may not spill outside the box. */
export const LABEL_COLUMNS = 3;
export const LABEL_ROWS = 2;

/**
 * A cut station's reserved box, in cells: twice across.
 *
 * A cut carries a reason — the words the branch stopped in — and those words
 * ride on the plate as visible text rather than in a tooltip nobody can read
 * without a pointer. Twice across is the room they need, and it is reserved
 * here rather than doubled at paint time: the box the solver reserves is the
 * box the router treats as blocked, the box `boundsOf` sizes the drawing
 * around, and the box the plate is drawn at. A width the renderer invented on
 * its own would be pixels laid over track the router thought was free.
 */
export const CUT_LABEL_COLUMNS = LABEL_COLUMNS * 2;

/** Cells of the station's own row kept clear on each side, so track always has
 *  somewhere to leave from and arrive on. Label boxes may not take these. */
export const CORRIDOR = 3;

/** Rows between the bottom of the plate and the first siding. */
export const SIDING_GAP = 4;

const TOP_MARGIN = 3;
const LEFT_MARGIN = 4;

/** Free cells kept around everything, and the router's guarantee of a detour:
 *  a lane with nothing in it runs right round the drawing. */
const PADDING = 4;

/**
 * Extra cells around a plate whose pins no longer match the graph.
 *
 * The survival kit for a hand-made layout is exactly two things — room to be
 * wrong in, and a stamp saying it might be. This is the first; [`Provisional`]
 * is the second.
 */
export const CONSTRUCTION_MARGIN = 2;

/** One cell, in pixels of drawn plate. The only bridge in this file between
 *  cells and the width a window has to give the view. */
export const CELL_PIXELS = 14;

/**
 * The width below which the Plate stands down whatever it is drawing.
 *
 * A hard floor, and deliberately not derived from the graph: a two-station map
 * would compute a width a phone could honour, and a plate drawn in three inches
 * is a diagram nobody can read a label on. Under this the view does not shrink,
 * it stands down and says why.
 */
export const PLATE_FLOOR = 700;

/**
 * Where this view is competent, as data rather than as a sentence in a comment.
 *
 * Under twelve stations the topology is thin enough that the Route says the
 * same thing in less; far over twenty the diagram stops being readable and by
 * about sixty it is a hairball. Exported so the slice that draws the plate can
 * say *this map is outside what this view is for* in the view itself, rather
 * than leaving an operator to discover it.
 */
export const COMPETENCE_BAND = { from: 12, to: 20 } as const;

/** Where the diagram stops being a diagram. */
export const HAIRBALL_ABOVE = 60;

/* --------------------------------------------------------------- the plate --- */

export type Box = {
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
};

export function boxHolds(box: Box, cell: Cell): boolean {
  return (
    cell.column >= box.column &&
    cell.column < box.column + box.columns &&
    cell.row >= box.row &&
    cell.row < box.row + box.rows
  );
}

/** The eight anchors, in the order the solver tries them. Above and below
 *  first: a name over a station reads as that station's, a name beside one at
 *  its own row competes with the track leaving it. */
export type Anchor =
  | "north"
  | "south"
  | "northEast"
  | "southEast"
  | "northWest"
  | "southWest"
  | "east"
  | "west";

export const ANCHORS: readonly Anchor[] = [
  "north",
  "south",
  "northEast",
  "southEast",
  "northWest",
  "southWest",
  "east",
  "west",
];

export type Label = {
  readonly anchor: Anchor;
  readonly box: Box;
  /** True when no anchor was clear and the least-bad one was taken. The box is
   *  still reserved and still routed around; it is the neighbour it overlaps,
   *  not the track. */
  readonly crowded: boolean;
};

export type Station = {
  readonly node: Node;
  readonly number: number;
  /** Longest path over in-map blockers. Sidings carry the rank they would have
   *  had, which is always zero. */
  readonly rank: number;
  /** Index within the rank, in `map.nodes` order. */
  readonly place: number;
  readonly at: Cell;
  readonly siding: boolean;
  readonly pinned: boolean;
  readonly label: Label;
};

export type Track = {
  /** The station that has to finish first. */
  readonly from: number;
  /** The station waiting on it. */
  readonly to: number;
} & Route;

/**
 * Where one station unlocks several, drawn as one stem and its branches.
 *
 * The Route deliberately refuses to draw fan-out — a list has nowhere to put
 * it. The Plate is one of the views that does, and the shape is not decorative:
 * *finishing this frees four things* is the single most actionable fact on a
 * dependency graph, and a diagram that draws four unrelated lines out of one
 * station has said it four times instead of once.
 *
 * The stem is computed rather than drawn: every track leaves its station
 * heading east, so the branches genuinely share cells, and the spine is the run
 * of cells all of them agree on.
 */
export type Fan = {
  readonly from: number;
  readonly spine: readonly Cell[];
  readonly branches: readonly { readonly to: number; readonly leaves: Cell }[];
};

/**
 * The keys the legend can spell, which is every convention *and* every thing
 * the drawing knows about itself that the picture cannot show.
 *
 * The last four are not conventions of the drawing at all — they are the
 * drawing's own account of where it falls short: three verdicts for a map
 * outside the band this view is competent at, and one for an edge the router
 * could not draw. They ride the legend rather than a channel of their own
 * because there is one margin, one place a reader looks for *what am I looking
 * at*, and a second one would be a second thing to remember to read.
 */
export type LegendKey =
  | "siding"
  | "fan"
  | "provisional"
  | "beyondTheMap"
  | "unrouted"
  | "thin"
  | "crowded"
  | "hairball";

/**
 * The conventions this drawing uses, as data.
 *
 * Explicit on purpose. A siding is the one piece of vocabulary on the plate an
 * operator cannot read off the picture — track that goes nowhere looks like a
 * mistake until something says it is a claim — so the legend is part of the
 * geometry's answer rather than a decoration the drawing slice might forget.
 * An entry appears only when the plate actually contains the thing it explains:
 * a key for something not on screen is a legend explaining somebody else's
 * diagram.
 */
export type LegendEntry = {
  readonly key: LegendKey;
  readonly count: number;
  readonly meaning: string;
};

export const LEGEND_MEANINGS: Record<LegendKey, string> = {
  siding: "On a siding: nothing here waits on it and it waits on nothing here.",
  fan: "A fan: finishing the station at the stem frees every branch off it.",
  provisional: "Provisional: the placed stations no longer match the graph.",
  beyondTheMap: "Waits on an issue with no station here, so no track is drawn.",
  /* An edge that is on the map and not in the picture. Said out loud for the
     same reason the fog is: a link nobody can see is a dependency the drawing
     has quietly denied, and a diagram missing one is worse than a diagram
     admitting it is. */
  unrouted:
    "Walled in by a station somebody placed: this many links are on the map and " +
    "not drawn. Put that station back and the track comes with it.",
  thin:
    `Thinner than this view is for: under ${COMPETENCE_BAND.from} stations there is ` +
    "barely a shape here, and the Route says the same thing in less.",
  crowded:
    `More stations than this view is competent at: over ${COMPETENCE_BAND.to} the ` +
    "diagram is still drawn, and it is harder to read than it looks.",
  hairball:
    `Far past what this view can draw: over ${HAIRBALL_ABOVE} stations this is a ` +
    "hairball rather than a diagram, and no reading of it is a safe one.",
};

/**
 * The stamp a hand-authored layout wears once the graph has moved under it.
 *
 * Pins are authored positions and are never moved — so the day a pinned ticket
 * leaves the map, or a new one arrives with nowhere authored to go, the drawing
 * is partly generated and partly somebody's hand, and the honest thing is to
 * say so. `null` means the layout and the graph agree, which includes the plain
 * case of no pins at all: a plate nobody has arranged by hand is not a plate
 * whose arrangement has gone stale.
 */
export type Provisional = {
  readonly pinsWithoutStation: readonly number[];
  readonly stationsWithoutPin: readonly number[];
  /** Cells of slack added round the drawing, so a stale layout has room to be
   *  wrong in rather than running off its own edge. */
  readonly margin: number;
};

export type Competence = {
  readonly band: typeof COMPETENCE_BAND;
  readonly stations: number;
  readonly verdict: "thin" | "competent" | "crowded" | "hairball";
  /** Nothing waits on anything here, so there is no topology to draw. */
  readonly flat: boolean;
};

export type Plate = {
  readonly stations: readonly Station[];
  /** Node numbers per rank, in `map.nodes` order within each. Sidings are not
   *  in here: they are off the plate. */
  readonly ranks: readonly (readonly number[])[];
  readonly sidings: readonly number[];
  readonly track: readonly Track[];
  readonly fans: readonly Fan[];
  readonly legend: readonly LegendEntry[];
  readonly extent: Bounds;
  /** Pixels of map side this drawing needs, floored at [`PLATE_FLOOR`]. */
  readonly requiredWidth: number;
  readonly provisional: Provisional | null;
  readonly competence: Competence;
  /** Named blockers with no station here, counted and then dropped. */
  readonly beyondTheMap: number;
  /** Edges an authored pin walled in. Empty on any generated plate. */
  readonly unrouted: readonly { readonly from: number; readonly to: number }[];
};

const NO_PINS: ReadonlyMap<number, Cell> = new Lookup<number, Cell>();

/* ---------------------------------------------------------------- the ranks --- */

/**
 * Longest path over in-map blockers, memoised, in map order.
 *
 * Longest and not shortest: a station's rank is *how deep in the work it is*,
 * and the deepest chain reaching it is the only reading under which every
 * track runs left to right. Shortest paths would let an edge point backwards,
 * and backwards track on a transit diagram reads as a second line.
 *
 * **Rank 0 is structurally wide and that is the normal shape.** A charting
 * session produces a burst of independent tickets, so eleven sources against
 * later ranks of four, two, one and one is what a healthy map looks like — the
 * plate's answer to that is sidings, not a wider band.
 *
 * A cycle cannot arrive from GitHub's own blocking relation, but a cycle here
 * would be an infinite recursion rather than a wrong picture, so the walk keeps
 * a visiting set and treats a back edge as no edge.
 */
function ranksOf(nodes: readonly Node[]): ReadonlyMap<number, number> {
  const byNumber = new Lookup<number, Node>();
  for (const node of nodes) byNumber.set(node.number, node);

  const ranks = new Lookup<number, number>();
  const visiting = new Set<number>();

  const rankOf = (node: Node): number => {
    const known = ranks.get(node.number);
    if (known !== undefined) return known;
    visiting.add(node.number);

    let rank = 0;
    for (const before of node.waitsOn) {
      const blocker = byNumber.get(before);
      if (blocker === undefined || visiting.has(before)) continue;
      rank = Math.max(rank, rankOf(blocker) + 1);
    }

    visiting.delete(node.number);
    ranks.set(node.number, rank);
    return rank;
  };

  for (const node of nodes) rankOf(node);
  return ranks;
}

/**
 * An unserved source: nothing on this map waits on it, and it waits on nothing
 * on this map.
 *
 * Both halves, and the conjunction is the whole definition. A source that
 * unlocks something belongs on the plate — it is the start of a line. A ticket
 * that waits on something is on a line by definition. What is left is a station
 * with no track at either end, and drawing it in rank 0 makes the widest rank
 * on the map wider with nodes that carry no topology at all. Those go on
 * sidings: still drawn, still counted, still labelled, just not pretending to
 * be part of a network they have no edge into.
 *
 * A blocker beyond the map does not count as waiting on something: this map
 * cannot draw that edge, so as far as this drawing goes the station has none.
 */
function unservedSources(nodes: readonly Node[]): ReadonlySet<number> {
  const here = new Set<number>(nodes.map((node) => node.number));
  const served = new Set<number>();
  const waiting = new Set<number>();
  for (const node of nodes) {
    for (const before of node.waitsOn) {
      if (!here.has(before)) continue;
      served.add(before);
      waiting.add(node.number);
    }
  }
  return new Set(
    nodes
      .filter((node) => !served.has(node.number) && !waiting.has(node.number))
      .map((node) => node.number),
  );
}

/* --------------------------------------------------------------- the labels --- */

/**
 * The box one anchor reserves, at the width that station's plate needs.
 *
 * `columns` is a parameter rather than the constant because a cut station's
 * plate is twice across. Every consumer downstream — the anchor arithmetic
 * here, `boxCells` and through it the router's blocked set, and `boundsOf` and
 * through it the extent — is written off the box rather than off the constant,
 * so a wide box is wide in all of them and in the pixels too.
 */
function boxFor(anchor: Anchor, at: Cell, columns: number = LABEL_COLUMNS): Box {
  const west = at.column - columns;
  const east = at.column + 1;
  const centre = at.column - Math.floor(columns / 2);
  const above = at.row - LABEL_ROWS;
  const below = at.row + 1;

  switch (anchor) {
    case "north":
      return { column: centre, row: above, columns, rows: LABEL_ROWS };
    case "south":
      return { column: centre, row: below, columns, rows: LABEL_ROWS };
    case "northEast":
      return { column: east, row: above, columns, rows: LABEL_ROWS };
    case "southEast":
      return { column: east, row: below, columns, rows: LABEL_ROWS };
    case "northWest":
      return { column: west, row: above, columns, rows: LABEL_ROWS };
    case "southWest":
      return { column: west, row: below, columns, rows: LABEL_ROWS };
    case "east":
      return { column: east, row: at.row, columns, rows: LABEL_ROWS };
    case "west":
      return { column: west, row: at.row, columns, rows: LABEL_ROWS };
  }
}

function boxCells(box: Box): Cell[] {
  const cells: Cell[] = [];
  for (let row = box.row; row < box.row + box.rows; row += 1) {
    for (let column = box.column; column < box.column + box.columns; column += 1) {
      cells.push({ column, row });
    }
  }
  return cells;
}

/**
 * The corridor cells a station needs kept clear: its own row, out to
 * [`CORRIDOR`] cells on the side track leaves from and the side it arrives on.
 *
 * This is the half of rule 11 that runs the other way. The label solver already
 * refuses to put a box where track has to be; without the corridors it would
 * only refuse where track *already is*, and the first station whose name landed
 * east of it would be a station nothing could leave.
 */
function corridorsOf(at: Cell, leaves: boolean, arrives: boolean): Cell[] {
  const cells: Cell[] = [];
  if (leaves) {
    for (let step = 1; step <= CORRIDOR; step += 1) cells.push({ column: at.column + step, row: at.row });
  }
  if (arrives) {
    for (let step = 1; step <= CORRIDOR; step += 1) cells.push({ column: at.column - step, row: at.row });
  }
  return cells;
}

/**
 * The eight-anchor solver: every station's annotation gets a reserved box, and
 * the box is chosen against everything already reserved.
 *
 * Greedy in map order rather than optimal, and that is the point — an optimiser
 * would move the *first* station's label to suit the eleventh, so the same map
 * with one ticket added would redraw every name on the plate. Map order means a
 * new ticket disturbs the labels after it and no others.
 *
 * When no anchor is clear the least-conflicted one is taken and marked
 * `crowded`. Corridors outrank neighbours in that count: two names touching is
 * ugly, a name sitting where track must leave is an edge that cannot be drawn.
 */
function labelsFor(
  stations: readonly {
    number: number;
    at: Cell;
    leaves: boolean;
    arrives: boolean;
    /** Cut from scope, so a reason has to fit beside the name and the box is
     *  reserved twice across. */
    cut: boolean;
  }[],
): ReadonlyMap<number, Label> {
  const stationCells = new Set(stations.map((station) => cellKey(station.at)));
  const corridors = new Set<string>();
  for (const station of stations) {
    for (const cell of corridorsOf(station.at, station.leaves, station.arrives)) {
      corridors.add(cellKey(cell));
    }
  }

  const taken = new Set<string>();
  const labels = new Lookup<number, Label>();

  for (const station of stations) {
    let best: { anchor: Anchor; box: Box; corridorHits: number; hits: number } | null = null;
    const columns = station.cut ? CUT_LABEL_COLUMNS : LABEL_COLUMNS;

    for (const anchor of ANCHORS) {
      const box = boxFor(anchor, station.at, columns);
      let corridorHits = 0;
      let hits = 0;
      for (const cell of boxCells(box)) {
        const key = cellKey(cell);
        if (corridors.has(key)) corridorHits += 1;
        if (taken.has(key) || stationCells.has(key)) hits += 1;
      }
      if (corridorHits === 0 && hits === 0) {
        best = { anchor, box, corridorHits, hits };
        break;
      }
      const better =
        best === null ||
        corridorHits < best.corridorHits ||
        (corridorHits === best.corridorHits && hits < best.hits);
      if (better) best = { anchor, box, corridorHits, hits };
    }

    /* `ANCHORS` is non-empty, so the loop above always leaves a candidate; the
       throw is here because TypeScript cannot know that and a silent `north`
       fallback would hide a solver that stopped trying anchors. */
    if (best === null) throw new Error("the label solver was given no anchors");
    for (const cell of boxCells(best.box)) taken.add(cellKey(cell));
    labels.set(station.number, {
      anchor: best.anchor,
      box: best.box,
      crowded: best.corridorHits > 0 || best.hits > 0,
    });
  }

  return labels;
}

/* ------------------------------------------------------------- the placing --- */

/**
 * Where a station goes when nobody has said.
 *
 * Rank across, place down: the map's direction of travel is left to right, so
 * the thing you can start now is on the left and the thing it unlocks is to the
 * right of it. `place` is the index within the rank in map order and nothing
 * else — no sort, no sweep. Sidings sit under the whole drawing, in map order
 * down their own column.
 */
function naturalCell(rank: number, place: number): Cell {
  return {
    column: LEFT_MARGIN + rank * COLUMN_PITCH,
    row: TOP_MARGIN + place * ROW_PITCH,
  };
}

/** The first free cell at or below the natural one. Pinned cells are never
 *  moved, so a generated station is what gives way. */
function clearOf(natural: Cell, taken: readonly Cell[]): Cell {
  let cell = natural;
  for (let tries = 0; tries < 256; tries += 1) {
    if (taken.every((other) => cellGap(cell, other) >= MIN_STATION_GAP)) return cell;
    cell = { column: cell.column, row: cell.row + ROW_PITCH };
  }
  return cell;
}

/* ---------------------------------------------------------------- the plate --- */

const EMPTY_PLATE: Plate = {
  stations: [],
  ranks: [],
  sidings: [],
  track: [],
  fans: [],
  legend: [],
  extent: { origin: { column: 0, row: 0 }, columns: 0, rows: 0 },
  requiredWidth: PLATE_FLOOR,
  provisional: null,
  competence: { band: COMPETENCE_BAND, stations: 0, verdict: "thin", flat: true },
  beyondTheMap: 0,
  unrouted: [],
};

function competenceOf(stations: number, flat: boolean): Competence {
  const verdict: Competence["verdict"] =
    stations > HAIRBALL_ABOVE
      ? "hairball"
      : stations > COMPETENCE_BAND.to
        ? "crowded"
        : stations < COMPETENCE_BAND.from
          ? "thin"
          : "competent";
  return { band: COMPETENCE_BAND, stations, verdict, flat };
}

/**
 * The whole geometry of one plate.
 *
 * `null` for the map is *no map open* and answers with a well-formed empty
 * plate rather than throwing — an absence is a state this app draws, not an
 * error it reports. An empty map answers the same way for the same reason.
 *
 * `pins` are authored station positions and are honoured exactly: a pinned
 * station is placed where the pin says and every generated station is placed
 * around it. Persistence is somebody else's slice; here they are a parameter
 * that defaults to none.
 */
export function plateOf(map: Map | null, pins: ReadonlyMap<number, Cell> = NO_PINS): Plate {
  if (map === null || map.nodes.length === 0) return EMPTY_PLATE;

  const nodes = map.nodes;
  const here = new Set(nodes.map((node) => node.number));
  const ranks = ranksOf(nodes);
  const sidelined = unservedSources(nodes);

  let beyondTheMap = 0;
  const leaves = new Set<number>();
  const arrives = new Set<number>();
  for (const node of nodes) {
    for (const before of node.waitsOn) {
      if (!here.has(before)) {
        beyondTheMap += 1;
        continue;
      }
      leaves.add(before);
      arrives.add(node.number);
    }
  }

  /* Ranks and places first, in map order, so a station's `place` is decided
     before anything has been placed in a cell. */
  const rows: number[][] = [];
  const places = new Lookup<number, number>();
  const sidings: number[] = [];
  for (const node of nodes) {
    if (sidelined.has(node.number)) {
      places.set(node.number, sidings.length);
      sidings.push(node.number);
      continue;
    }
    const rank = ranks.get(node.number) ?? 0;
    while (rows.length <= rank) rows.push([]);
    const bucket = rows[rank] ?? [];
    places.set(node.number, bucket.length);
    bucket.push(node.number);
  }

  const deepest = rows.reduce((widest, rank) => Math.max(widest, rank.length), 0);
  const sidingRow = TOP_MARGIN + Math.max(deepest - 1, 0) * ROW_PITCH + SIDING_GAP;

  const pinsWithoutStation = [...pins.keys()].filter((number) => !here.has(number)).sort((a, b) => a - b);
  const stationsWithoutPin =
    pins.size === 0 ? [] : nodes.filter((node) => !pins.has(node.number)).map((node) => node.number);
  const provisional: Provisional | null =
    pins.size > 0 && (pinsWithoutStation.length > 0 || stationsWithoutPin.length > 0)
      ? { pinsWithoutStation, stationsWithoutPin, margin: CONSTRUCTION_MARGIN }
      : null;

  /* Pinned first, all of them, before a single generated station takes a cell:
     a generated station gives way to a pin and never the other way round, and
     that is only true if the pins are all down before the giving way starts. */
  const at = new Lookup<number, Cell>();
  const occupied: Cell[] = [];
  for (const node of nodes) {
    const pin = pins.get(node.number);
    if (pin === undefined) continue;
    at.set(node.number, pin);
    occupied.push(pin);
  }
  for (const node of nodes) {
    if (at.has(node.number)) continue;
    const place = places.get(node.number) ?? 0;
    const natural = sidelined.has(node.number)
      ? { column: LEFT_MARGIN, row: sidingRow + place * ROW_PITCH }
      : naturalCell(ranks.get(node.number) ?? 0, place);
    const cell = clearOf(natural, occupied);
    at.set(node.number, cell);
    occupied.push(cell);
  }

  const labels = labelsFor(
    nodes.map((node) => ({
      number: node.number,
      at: at.get(node.number) ?? { column: 0, row: 0 },
      leaves: leaves.has(node.number),
      arrives: arrives.has(node.number),
      cut: node.cut.cut === "fromScope",
    })),
  );

  const stations: Station[] = nodes.map((node) => ({
    node,
    number: node.number,
    rank: ranks.get(node.number) ?? 0,
    place: places.get(node.number) ?? 0,
    at: at.get(node.number) ?? { column: 0, row: 0 },
    siding: sidelined.has(node.number),
    pinned: pins.has(node.number),
    label: labels.get(node.number) ?? {
      anchor: "north",
      box: boxFor(
        "north",
        at.get(node.number) ?? { column: 0, row: 0 },
        node.cut.cut === "fromScope" ? CUT_LABEL_COLUMNS : LABEL_COLUMNS,
      ),
      crowded: true,
    },
  }));

  const extent = boundsOf(stations, provisional !== null);

  /* One field for the whole plate: stations and their halos, every reserved
     label box, and then the corridors cut back out of it. The corridors are
     removed last because a station's own halo covers the cell its track has to
     leave from, and a station nothing can leave is not a station. */
  const blocked = new Set<string>();
  for (const station of stations) {
    for (let row = -MIN_STATION_GAP + 1; row <= MIN_STATION_GAP - 1; row += 1) {
      for (let column = -MIN_STATION_GAP + 1; column <= MIN_STATION_GAP - 1; column += 1) {
        blocked.add(cellKey({ column: station.at.column + column, row: station.at.row + row }));
      }
    }
    for (const cell of boxCells(station.label.box)) blocked.add(cellKey(cell));
  }
  for (const station of stations) {
    for (const cell of corridorsOf(
      station.at,
      leaves.has(station.number),
      arrives.has(station.number),
    )) {
      blocked.delete(cellKey(cell));
    }
  }
  const field = fieldOf(extent, blocked);

  const track: Track[] = [];
  const unrouted: { from: number; to: number }[] = [];
  for (const node of nodes) {
    for (const before of node.waitsOn) {
      if (!here.has(before)) continue;
      const from = at.get(before);
      const to = at.get(node.number);
      if (from === undefined || to === undefined) continue;
      const route = routeTrack(field, from, to);
      if (route === null) {
        unrouted.push({ from: before, to: node.number });
        continue;
      }
      track.push({ from: before, to: node.number, ...route });
    }
  }

  const fans = fansOf(track);
  const flat = track.length === 0;
  const competence = competenceOf(stations.length, flat);
  const legend = legendOf({
    sidings: sidings.length,
    fans: fans.length,
    provisional: provisional !== null,
    beyondTheMap,
    unrouted: unrouted.length,
    competence,
  });

  return {
    stations,
    ranks: rows,
    sidings,
    track,
    fans,
    legend,
    extent,
    requiredWidth: Math.max(PLATE_FLOOR, extent.columns * CELL_PIXELS),
    provisional,
    competence,
    beyondTheMap,
    unrouted,
  };
}

/**
 * The grid everything has to fit in, with a free lane of [`PADDING`] cells all
 * the way round.
 *
 * The lane is not decoration: it is the router's guarantee that a detour
 * exists. Nothing blocks it, so a station walled in by its neighbours' labels
 * can always be reached by going round the outside — which is what lets the
 * router answer `null` only for an authored pin that has walled a station in.
 */
function boundsOf(stations: readonly Station[], provisional: boolean): Bounds {
  const columns: number[] = [];
  const rows: number[] = [];
  for (const station of stations) {
    columns.push(station.at.column - CORRIDOR, station.at.column + CORRIDOR);
    rows.push(station.at.row);
    columns.push(station.label.box.column, station.label.box.column + station.label.box.columns - 1);
    rows.push(station.label.box.row, station.label.box.row + station.label.box.rows - 1);
  }
  const pad = PADDING + (provisional ? CONSTRUCTION_MARGIN : 0);
  const left = Math.min(...columns) - pad;
  const top = Math.min(...rows) - pad;
  return {
    origin: { column: left, row: top },
    columns: Math.max(...columns) + pad - left + 1,
    rows: Math.max(...rows) + pad - top + 1,
  };
}

/** The run of cells every branch out of one station agrees on, and where each
 *  branch leaves it. */
function fansOf(track: readonly Track[]): readonly Fan[] {
  const byStation = new Lookup<number, Track[]>();
  const order: number[] = [];
  for (const one of track) {
    const branches = byStation.get(one.from);
    if (branches === undefined) {
      byStation.set(one.from, [one]);
      order.push(one.from);
    } else {
      branches.push(one);
    }
  }

  const fans: Fan[] = [];
  for (const from of order) {
    const branches = byStation.get(from) ?? [];
    if (branches.length < 2) continue;

    const walks = branches.map((one) => cellsAlong(one.points));
    const first = walks[0] ?? [];
    let shared = 0;
    for (;;) {
      const cell = first[shared];
      if (cell === undefined) break;
      const agreed = walks.every((walk) => {
        const other = walk[shared];
        return other !== undefined && other.column === cell.column && other.row === cell.row;
      });
      if (!agreed) break;
      shared += 1;
    }

    const off: { to: number; leaves: Cell }[] = [];
    for (let index = 0; index < branches.length; index += 1) {
      const one = branches[index];
      const walk = walks[index] ?? [];
      const leaves = walk[shared] ?? walk[walk.length - 1];
      if (one === undefined || leaves === undefined) continue;
      off.push({ to: one.to, leaves });
    }

    fans.push({ from, spine: first.slice(0, shared), branches: off });
  }
  return fans;
}

/**
 * The margin's whole text, decided here rather than in the drawing.
 *
 * The verdict comes first and only when it is not `competent`: *this map is
 * outside what this view is for* is the one line that changes how everything
 * under it should be read, and a view that computes that and keeps it to itself
 * has left the operator to discover it. `unrouted` is the same duty pointed at
 * one edge instead of the whole map — the router returns `null` rather than
 * drawing track through a label, and an edge dropped in silence would leave the
 * drawing reading as a map with one fewer dependency in it.
 */
function legendOf(what: {
  readonly sidings: number;
  readonly fans: number;
  readonly provisional: boolean;
  readonly beyondTheMap: number;
  readonly unrouted: number;
  readonly competence: Competence;
}): readonly LegendEntry[] {
  const entries: LegendEntry[] = [];
  const add = (key: LegendKey, count: number) => {
    if (count > 0) entries.push({ key, count, meaning: LEGEND_MEANINGS[key] });
  };
  /* Counted in stations, because the count is what the verdict is about: the
     band is a claim about how many of these a reader can follow at once. */
  if (what.competence.verdict !== "competent") {
    add(what.competence.verdict, what.competence.stations);
  }
  add("siding", what.sidings);
  add("fan", what.fans);
  add("provisional", what.provisional ? 1 : 0);
  add("beyondTheMap", what.beyondTheMap);
  add("unrouted", what.unrouted);
  return entries;
}

/* ----------------------------------------------------------- the stand-down --- */

/**
 * There is no stand-down of this view's own, and that is a decision.
 *
 * Two readings of *too narrow* were available: under [`PLATE_FLOOR`], where no
 * plate of any size is legible; and over the floor but under this drawing's own
 * [`Plate.requiredWidth`], where the picture is simply bigger than the room. The
 * first is the shell's already — `VIEW_FLOORS.plate` is this floor, and
 * `standDown` in `src/panes/dial.ts` answers it in the four terms every view is
 * answered in, with the two exits an operator can actually press. The second has
 * no remedy worth a stand-down: this is the one view that cannot reflow, and
 * scaling the drawing under 1:1 would defeat the label boxes the router reserved
 * in cells, so the answer above the floor is natural size and a scrollport —
 * which is what `Plate.module.css` does. A second stand-down type would have
 * been a second thing entitled to disagree with the registry about when a view
 * is drawn. See `docs/adr/0026-the-plate-pins-under-its-own-key.md`.
 */
