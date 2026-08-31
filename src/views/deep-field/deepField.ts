/**
 * Deep Field's geometry: what rank each ticket stands at, where its plate and
 * its mark are drawn, what the fan-out is drawn between, and — when the width
 * is not there — what the view says instead of drawing.
 *
 * A pure module. Nothing here imports React, touches the DOM, reads a clock, a
 * store or a random number, and nothing is remembered between two calls:
 * `deepFieldOf` handed the same map and the same width answers with the same
 * coordinates, every time. **No stored node positions** is therefore a property
 * of this file rather than a rule somebody keeps — there is nowhere for a
 * position to be stored and no input a caller could vary that is not the model
 * and the width. The one view permitted stored positions is The Plate, and this
 * is not it.
 *
 * ## The plate/field split, which is the load-bearing reading
 *
 * The picture is two zones side by side, and they are two coordinate spaces
 * rather than two halves of one.
 *
 * On the left is the **plate lane**: one plate per node, stacked in map order,
 * bearing every word the view has to say about that node — its title, the word
 * for its state, its tags, and the reason it was cut when it was cut. On the
 * right is the **field**: strict rank columns of bare marks with the fan-out
 * drawn between them, and no text at all.
 *
 * The split is what rule 11 asks for, and the reason it lands *here* rather
 * than as a margin around the drawing is rank 0. Charting a map produces a
 * burst of independent tickets, so eleven sources against ranks of four, two,
 * one and one is the ordinary shape rather than the awkward one — and eleven
 * labels set beside eleven marks in a single tall column is precisely the graph
 * field doubling as the label surface. Words in the field would then be laid
 * over the fan-out leaving that column, which is the densest part of the
 * picture at exactly the n this view claims to be competent at. So the words
 * are given a lane of their own that the topology's coordinates are bounded
 * away from, and the boundary between the two carries [`GUTTER_CLEARANCE`] of
 * blank on the field side so a mark never crowds the zone edge.
 *
 * **A reader may disagree with this**, and the disagreement is a real one: the
 * obvious alternative is that a plate is drawn *at* its node, in the column, and
 * the gutter is reserved for the map's own annotation instead. That reading
 * keeps a node's words next to its position and costs a lookup between the two
 * lanes; this one keeps the field legible at a structurally wide rank 0 and
 * costs the operator a glance sideways. It is chosen because the wide rank 0 is
 * the normal shape and the tidy diamond is the exception, and a layout that is
 * only readable on the exception is the wrong way round. Correspondence between
 * the two lanes is by node number, which both a plate and a mark carry.
 *
 * ## What is decided here and what is not
 *
 * Ranks, columns, coordinates and edge geometry — all of it view identity, none
 * of it shared. The numbers below are this view's own and belong in no registry:
 * the contract binds meaning, never geometry.
 *
 * Nothing here re-derives what is *true*. A node's state, its classification and
 * the designated frontier are read off the model as words and copied onto the
 * plate; `waitsOn` is walked once, in `../graph`, by the same function The Route
 * counts `blocked by N` with. Rank is not truth, it is position, which is why
 * this file is allowed to compute it at all.
 */

import type { Counts, Fog, Frontier, Map, Node, NodeState } from "../../snapshot/model.generated";
import { NOTHING_IN_THE_WAY, blockersOf, type BlockerTally } from "../graph";

const Lookup = globalThis.Map;

/* ------------------------------------------------------------ geometry --- */

/**
 * The plate lane's width, and with it the boundary the field starts after.
 *
 * A plate is the card a node gets. Rule 6's own gloss has a standard plate
 * drawn double-width to fit a cut reason, so this is the standard one and a
 * renderer is free to spend two of them on a row that has more to say.
 */
export const PLATE_WIDTH = 260;
export const PLATE_HEIGHT = 30;
export const PLATE_GAP = 6;

/**
 * The blank kept on the field side of the zone boundary, in pixels.
 *
 * Rule 11's corollary — a zone boundary needs clearance from the graph's own
 * marks — as a number, and a view-local one. It came out of the design round
 * that produced this view and it is a starting value rather than a settled one;
 * what is settled is that the topology's coordinates may never enter it at any
 * n, which `tests/deep-field.test.ts` asks of every fixture and every hand-built
 * shape. Promoting it into the shared contract registry would be exactly the
 * mistake the meta-rule names: the rule binds the clearance, not the 34.
 */
export const GUTTER_CLEARANCE = 34;

export const MARK_RADIUS = 7;
/** Distance between two rank columns, centre to centre. */
export const COLUMN_PITCH = 84;
/** Distance between two marks inside one column, centre to centre. */
export const ROW_PITCH = 34;
/** Blank inside the field's own box, so a mark never sits on its edge. */
export const FIELD_PAD = 18;

/**
 * The least horizontal reach an edge is drawn with.
 *
 * Only ever the answer for an edge that does not travel rightwards, which is
 * the back edge the ranker refused to rank by. Drawn rather than dropped: the
 * cycle is a fact about the map, and a view that silently omits the edge that
 * caused it leaves the operator looking at a picture with no explanation in it.
 */
export const MIN_BEND = 26;

/** The n this view is competent at, named at both ends. */
export const BAND_LOW = 12;
export const BAND_HIGH = 25;

export type Point = { readonly x: number; readonly y: number };

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The two zones and the line between them.
 *
 * `boundary` is one x, drawn once by the renderer rather than invented twice,
 * and `clearance` is the blank to its right that no mark may enter. The field's
 * own box already starts after that blank, so the invariant is checkable
 * against these three numbers alone.
 */
export type Split = {
  readonly plates: Box;
  readonly field: Box;
  readonly boundary: number;
  readonly clearance: number;
};

/* -------------------------------------------------------------- ranking --- */

type Ranking = {
  readonly rankOf: ReadonlyMap<number, number>;
  readonly circular: readonly number[];
};

/**
 * Longest-path rank over the blocking edges this map can see.
 *
 * Rank 0 is a ticket that waits on nothing with a row here; every other rank is
 * one past the deepest of its in-map blockers. A blocker beyond the map
 * contributes no rank — this map cannot say where it stands, so it cannot say
 * how far past it anything is — and the fact survives on the plate as a tally
 * rather than being quietly rounded into rank 0.
 *
 * **The cycle guard is not defensive coding.** GitHub will happily present A
 * waits on B waits on A, and longest path over a cycle does not terminate. The
 * defined outcome: the edge that closes the cycle is refused, both its ends are
 * named in `circular`, and every node still gets a finite rank. Which edge that
 * is, is decided by map order and by nothing else, so it is the same edge on
 * every call.
 *
 * The walk recurses to the length of the longest chain, which on a map of
 * sub-issues is bounded by the number of children.
 */
function ranksOf(nodes: readonly Node[]): Ranking {
  const here = new Lookup<number, Node>();
  for (const node of nodes) here.set(node.number, node);

  const rank = new Lookup<number, number>();
  const walking = new Set<number>();
  const circular = new Set<number>();

  const rankFor = (node: Node): number => {
    const settled = rank.get(node.number);
    if (settled !== undefined) return settled;

    walking.add(node.number);
    let deepest = -1;
    for (const before of node.waitsOn) {
      const blocker = here.get(before);
      if (blocker === undefined) continue;
      if (walking.has(before)) {
        circular.add(node.number);
        circular.add(before);
        continue;
      }
      deepest = Math.max(deepest, rankFor(blocker));
    }
    walking.delete(node.number);

    const settledAt = deepest + 1;
    rank.set(node.number, settledAt);
    return settledAt;
  };

  for (const node of nodes) rankFor(node);
  return { rankOf: rank, circular: [...circular] };
}

/* --------------------------------------------------------------- plates --- */

/** The two kinds of child that are not tickets, or null for a ticket. */
export type KindTag = typeof SPEC_TAG | typeof UNCLASSIFIED_TAG | null;

export type Plate = {
  readonly node: Node;
  readonly rank: number;
  /** `map.frontier` named this number. Never re-resolved on this side. */
  readonly designated: boolean;
  /** A copy of `node.boundElsewhere`, and emphatically not a derivation. */
  readonly boundElsewhere: boolean;
  /** The words the map cut this ticket in, or null when it was not cut. */
  readonly cut: string | null;
  readonly tag: KindTag;
  readonly state: NodeState;
  readonly stateName: string;
  readonly blockers: BlockerTally;
  /** This node is an end of an edge the ranker refused. */
  readonly circular: boolean;
  readonly box: Box;
};

/* ----------------------------------------------------------------- field --- */

export type Mark = {
  readonly number: number;
  readonly rank: number;
  /** Position in the column, which is map order and never a sort. */
  readonly row: number;
  readonly at: Point;
  readonly radius: number;
  readonly state: NodeState;
  readonly designated: boolean;
};

export type RankColumn = {
  readonly rank: number;
  readonly x: number;
  readonly marks: readonly Mark[];
};

/**
 * One drawn edge from a ticket to a ticket it unblocks.
 *
 * The direction is deliberate and is the whole of why this view draws what The
 * Route declines to: an edge here leaves the thing that is finished, or nearly,
 * and lands on what it releases. Read left to right it is ground covered, which
 * is the question the view answers.
 *
 * The routing is a cubic with two horizontal handles, hand-written because edge
 * geometry is view identity and is deliberately unstandardised across views.
 */
export type FanOut = {
  /** The blocker: the ticket the edge leaves. */
  readonly from: number;
  /** What it unblocks: the ticket the edge lands on. */
  readonly to: number;
  readonly start: Point;
  readonly end: Point;
  readonly bend: readonly [Point, Point];
  /** Ranks crossed. Zero or less exactly when the edge is a refused one. */
  readonly spans: number;
  /** The blocker is resolved on this map, so this edge is behind the operator. */
  readonly cleared: boolean;
  readonly circular: boolean;
};

/* ------------------------------------------------------------ annotation --- */

/**
 * The fog, with its two absences kept apart.
 *
 * Rule 4 in the one place a view is most tempted to collapse it: *nobody
 * surveyed* is not zero, and a nullable number would make them one value with a
 * renderer left to guess. So the surveyed reading carries a numeral and the
 * unsurveyed one carries [`NOBODY_SURVEYED`], and they are different shapes.
 * Both carry the heading, because the region names itself rather than standing
 * as a figure in the margin.
 */
export type FieldFog =
  | { readonly surveyed: false; readonly heading: string; readonly absence: string }
  | {
      readonly surveyed: true;
      readonly heading: string;
      readonly count: number;
      /** The section verbatim, as the model carries it. Never edited here. */
      readonly text: string;
      /** Said when the survey happened and turned up nothing, else null. */
      readonly charted: string | null;
    };

/**
 * Where this map's n sits against the band the view is competent at.
 *
 * Data and not a decision: a map outside the band is still drawn, because
 * nothing about a 40-node map stops the geometry working — it stops being the
 * *best* answer, and choosing a better one is the shell's dial, which is
 * another ticket's work. The view says where it stands and draws.
 */
export type Competence = {
  readonly low: number;
  readonly high: number;
  readonly nodes: number;
  readonly standing: "under" | "within" | "over";
};

/**
 * What the view says when it cannot be drawn at this width.
 *
 * Which view, why, what it needs and what it has — and then the three integers
 * and the frontier, which stay alive when the graph does not. That is the whole
 * point of the value: a map is still being worked while the picture of it does
 * not fit, and a view that goes blank takes the operator's answer with it.
 *
 * No exits. The dial that widens the pane and the switcher that opens a view
 * that does fit are the shell's, in `src/panes/dial.ts`, and offering a second
 * set of them from inside the view would be two controls for one move. This
 * decides and reports; somebody else offers.
 *
 * Distinct from that shell-level stand-down in what it measures. The dial asks
 * whether the view column exists at all, per view, from one constant. This asks
 * whether *this map* fits, and its answer moves with the map: a four-rank map
 * needs three column pitches more than a one-rank map, and no constant can say
 * that.
 */
export type StandDown = {
  readonly view: string;
  readonly reason: string;
  /** Pixels of width the picture of this map would take. */
  readonly needs: number;
  /** Pixels it was offered. */
  readonly has: number;
  readonly counts: Counts;
  readonly frontier: Frontier;
  /**
   * The fog region, carried into the stand-down for the same reason the counts
   * are: it is words rather than picture, it costs no width, and a region that
   * vanished with the graph would report *nobody has been here* as *nothing to
   * report*. Rule 4's floor is asserted over the whole fixture space, and this
   * is the half of that space where nothing is drawn.
   */
  readonly fog: FieldFog;
};

/* ------------------------------------------------------------- the view --- */

export type DeepField =
  | { readonly kind: "noMapOpen" }
  | { readonly kind: "standDown"; readonly standDown: StandDown }
  | {
      readonly kind: "field";
      readonly extent: Box;
      readonly split: Split;
      /** Map order, one per node, and the same length as `map.nodes`. */
      readonly plates: readonly Plate[];
      /** Left to right, rank 0 first, with no rank skipped and none empty. */
      readonly columns: readonly RankColumn[];
      readonly fanOut: readonly FanOut[];
      /** Every node named by an edge the ranker refused, in map order. */
      readonly circular: readonly number[];
      readonly counts: Counts;
      readonly frontier: Frontier;
      readonly fog: FieldFog;
      readonly competence: Competence;
      /** The width floor this picture cleared. */
      readonly needs: number;
    };

/**
 * The width a map this deep takes, plate lane and clearance included.
 *
 * Exported because it is the floor, and a floor nobody can ask for is a number
 * that drifts from what the layout actually does.
 */
export function widthNeededFor(columns: number): number {
  return PLATE_WIDTH + GUTTER_CLEARANCE + fieldWidthFor(columns);
}

function fieldWidthFor(columns: number): number {
  if (columns === 0) return 0;
  return 2 * FIELD_PAD + 2 * MARK_RADIUS + (columns - 1) * COLUMN_PITCH;
}

function tagOf(node: Node): KindTag {
  if (node.kind.kind === "spec") return SPEC_TAG;
  if (node.kind.kind === "unclassified") return UNCLASSIFIED_TAG;
  return null;
}

function fogOf(fog: Fog): FieldFog {
  if (fog.fog === "unsurveyed") {
    return { surveyed: false, heading: FOG_HEADING, absence: NOBODY_SURVEYED };
  }
  return {
    surveyed: true,
    heading: FOG_HEADING,
    count: fog.region.count,
    text: fog.region.text,
    charted: fog.region.count === 0 ? FOG_ALL_CHARTED : null,
  };
}

function standingOf(nodes: number): Competence["standing"] {
  if (nodes < BAND_LOW) return "under";
  if (nodes > BAND_HIGH) return "over";
  return "within";
}

/**
 * The whole picture, or the reason there is none.
 *
 * `null` for the map is *no map open*, which is an absence and not an empty
 * map: the two get different answers here so that they can get different
 * screens, exactly as the model keeps them apart.
 *
 * `width` is the pixels of pane the view has been given. It is floored to a
 * whole pixel and never trusted to be a number — a NaN from a measurement that
 * has not happened yet would otherwise pass every comparison and draw a picture
 * into a pane of unknown size.
 */
export function deepFieldOf(map: Map | null, width: number): DeepField {
  if (map === null) return { kind: "noMapOpen" };

  const nodes = map.nodes;
  const ranked = ranksOf(nodes);
  const blockers = blockersOf(nodes);

  /*
   * Read once, above the loop. `map.frontier` names a number in exactly one of
   * its three readings; which of the other two it is, is the model's word and
   * is not asked here.
   */
  const designated = map.frontier.frontier === "designated" ? map.frontier.number : null;
  const circular = new Set(ranked.circular);

  const stacks = new Lookup<number, Node[]>();
  let depth = 0;
  for (const node of nodes) {
    const rank = ranked.rankOf.get(node.number) ?? 0;
    depth = Math.max(depth, rank + 1);
    const stack = stacks.get(rank);
    if (stack === undefined) stacks.set(rank, [node]);
    else stack.push(node);
  }

  const fieldX = PLATE_WIDTH + GUTTER_CLEARANCE;
  const fieldWidth = fieldWidthFor(depth);

  const columns: RankColumn[] = [];
  const marks = new Lookup<number, Mark>();
  let fieldHeight = 0;
  for (let rank = 0; rank < depth; rank += 1) {
    const stack = stacks.get(rank) ?? [];
    const x = fieldX + FIELD_PAD + MARK_RADIUS + rank * COLUMN_PITCH;
    const column: Mark[] = [];
    stack.forEach((node, row) => {
      const mark: Mark = {
        number: node.number,
        rank,
        row,
        at: { x, y: FIELD_PAD + MARK_RADIUS + row * ROW_PITCH },
        radius: MARK_RADIUS,
        state: node.state,
        designated: node.number === designated,
      };
      column.push(mark);
      marks.set(node.number, mark);
    });
    fieldHeight = Math.max(
      fieldHeight,
      2 * FIELD_PAD + 2 * MARK_RADIUS + Math.max(0, column.length - 1) * ROW_PITCH,
    );
    columns.push({ rank, x, marks: column });
  }

  const plates: Plate[] = nodes.map((node, index) => ({
    node,
    rank: ranked.rankOf.get(node.number) ?? 0,
    designated: node.number === designated,
    boundElsewhere: node.boundElsewhere,
    cut: node.cut.cut === "fromScope" ? node.cut.reason : null,
    tag: tagOf(node),
    state: node.state,
    stateName: STATE_NAMES[node.state],
    blockers: blockers.get(node.number) ?? NOTHING_IN_THE_WAY,
    circular: circular.has(node.number),
    box: {
      x: 0,
      y: index * (PLATE_HEIGHT + PLATE_GAP),
      width: PLATE_WIDTH,
      height: PLATE_HEIGHT,
    },
  }));

  const platesHeight =
    nodes.length === 0 ? 0 : nodes.length * (PLATE_HEIGHT + PLATE_GAP) - PLATE_GAP;

  const needs = widthNeededFor(depth);
  const has = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (has < needs) {
    return {
      kind: "standDown",
      standDown: {
        view: VIEW_NAME,
        reason: tooNarrowFor(depth),
        needs,
        has,
        counts: map.counts,
        frontier: map.frontier,
        fog: fogOf(map.fog),
      },
    };
  }

  return {
    kind: "field",
    extent: {
      x: 0,
      y: 0,
      width: needs,
      height: Math.max(platesHeight, fieldHeight),
    },
    split: {
      plates: { x: 0, y: 0, width: PLATE_WIDTH, height: platesHeight },
      field: { x: fieldX, y: 0, width: fieldWidth, height: fieldHeight },
      boundary: PLATE_WIDTH,
      clearance: GUTTER_CLEARANCE,
    },
    plates,
    columns,
    fanOut: fanOutOf(nodes, marks),
    circular: nodes.map((node) => node.number).filter((number) => circular.has(number)),
    counts: map.counts,
    frontier: map.frontier,
    fog: fogOf(map.fog),
    competence: {
      low: BAND_LOW,
      high: BAND_HIGH,
      nodes: nodes.length,
      standing: standingOf(nodes.length),
    },
    needs,
  };
}

/**
 * Every edge from a ticket to a ticket it unblocks, with the curve to draw it.
 *
 * The reverse of `waitsOn`, walked in map order so the set is the same on every
 * call, and de-duplicated: GitHub can list one blocker twice and two identical
 * curves drawn over each other are a thicker line, which is a claim nobody
 * made. A named blocker with no row here yields no edge at all — there is
 * nothing on screen for it to leave from — and stays legible on the plate that
 * waits, as [`BlockerTally.beyondTheMap`].
 */
function fanOutOf(nodes: readonly Node[], marks: ReadonlyMap<number, Mark>): FanOut[] {
  const resolved = new Lookup<number, boolean>();
  for (const node of nodes) resolved.set(node.number, node.state === "resolved");

  const edges: FanOut[] = [];
  const drawn = new Set<string>();
  for (const node of nodes) {
    const end = marks.get(node.number);
    if (end === undefined) continue;
    for (const before of node.waitsOn) {
      const start = marks.get(before);
      if (start === undefined) continue;
      const key = `${before}>${node.number}`;
      if (drawn.has(key)) continue;
      drawn.add(key);

      const spans = end.rank - start.rank;
      const reach = Math.max(MIN_BEND, (end.at.x - start.at.x) / 2);
      edges.push({
        from: before,
        to: node.number,
        start: { x: start.at.x + start.radius, y: start.at.y },
        end: { x: end.at.x - end.radius, y: end.at.y },
        bend: [
          { x: start.at.x + start.radius + reach, y: start.at.y },
          { x: end.at.x - end.radius - reach, y: end.at.y },
        ],
        spans,
        cleared: resolved.get(before) === true,
        circular: spans <= 0,
      });
    }
  }
  return edges;
}

/* ---------------------------------------------------------------- copy --- */

/** The view, named, and the only place it is spelled on this side. */
export const VIEW_NAME = "Deep Field";

/**
 * Why the view stood down, in the terms the operator can act on.
 *
 * Names the columns rather than the pixels, because the pixels are already on
 * the value beside it and *four columns will not fit* is the sentence that says
 * what would have to change.
 */
export function tooNarrowFor(columns: number): string {
  return columns === 1
    ? "one rank column and its annotation gutter need more width than this"
    : `${columns} rank columns and their annotation gutter need more width than this`;
}

/** What holds a plate up, as a number and never as a spray of edges. */
export function blockedByLabel(count: number): string {
  return `blocked by ${count}`;
}

/**
 * Said on the plate that waits, when one of the numbers it waits on has no row
 * here. The blocker is real, this map cannot judge it, and no edge is drawn for
 * it — so if the plate does not say it, nothing does.
 */
export function beyondTheMapNote(count: number): string {
  return count === 1
    ? "1 blocker, not a child of this map, has no row here"
    : `${count} blockers, each not a child of this map, have no row here`;
}

/**
 * Said on both ends of the edge the ranker refused.
 *
 * A cycle is GitHub's to present and nobody's to resolve from here, so the view
 * neither picks a winner nor hides the pair: it ranks them by the edges that are
 * not circular and says, on the plate, why the picture is the shape it is.
 */
export const CIRCULAR_TAG = "waits on something that waits on it";

/** The word on the cold tag, and the only place the designation is named. */
export const DESIGNATED_TAG = "designated";

/** Names the ticket's binding — a fact about the reader's machine. */
export const BOUND_ELSEWHERE_TAG = "not on this machine";

export const SPEC_TAG = "spec";
export const UNCLASSIFIED_TAG = "unclassified";

/** The fog names itself here as it does on The Route: a region, not a figure. */
export const FOG_HEADING = "Fog";

/**
 * What stands where the count would be when the map's body never named the fog.
 *
 * `—` and never `0`. The same em dash the other panes each declare for
 * themselves — one dash for one meaning across the window, and no import
 * between two views for a character.
 */
export const NOBODY_SURVEYED = "—";

/** Said under the heading when the survey happened and turned up nothing. */
export const FOG_ALL_CHARTED = "nothing left unspecified";

/**
 * The on-screen word for each of the four states, unchanged from the model's.
 *
 * The palette here is doing less work than on a list — a mark is a disc of a few
 * pixels — so the word beside it on the plate is most of what says where a
 * ticket stands, and a synonym would be a second vocabulary.
 */
export const STATE_NAMES: Record<NodeState, string> = {
  resolved: "resolved",
  blocked: "blocked",
  claimed: "claimed",
  takeable: "takeable",
};
