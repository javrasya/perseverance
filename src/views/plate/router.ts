/**
 * The Plate's octolinear router: the arithmetic that turns two cells into
 * track, and the only file in the view that knows what a bend costs.
 *
 * **Hand-rolled, and that is a decision rather than an omission.** No graph or
 * layout library is added to `package.json` for this — a layout package brings
 * its own idea of where a node goes, and *where a node goes* is the one thing
 * this view is not allowed to decide (see `plate.ts`: intra-rank order is map
 * order, full stop). A library that ranks, sweeps or sorts would have to be
 * fought at every call; the part actually worth borrowing — a shortest path
 * over a small grid — is thirty lines.
 *
 * **Eight headings and no curve.** Every segment leaves a cell due east, due
 * south, or at exactly 45°, because a transit diagram is a claim that the
 * drawing is schematic: the moment track curves, the eye reads the bend as
 * distance and the diagram starts saying something about a graph that has no
 * distances in it. So the router walks a cell grid in eight directions, and a
 * *step* is the whole of the vocabulary. Nothing here emits a path string: the
 * answer is points, the kind of each segment between them and the turn at each
 * corner, and the slice that draws it decides what a corner looks like.
 *
 * **Turns cost, so the shortest path is not the answer.** Plain Dijkstra over
 * eight neighbours produces a staircase — every step legal, the whole thing
 * unreadable. The cost here is length *plus* a penalty per 45° of turn, which
 * is what makes a long straight run with two bends beat a diagonal ladder with
 * eleven. That is also why the search state is a cell *and a heading* rather
 * than a cell: what a step costs depends on how you arrived.
 *
 * **Blocked cells are the whole of how rule 11 is enforced.** The reserved
 * label boxes go into the field as cells the search cannot enter, so *track
 * routed around annotation* is not a convention somebody has to keep — it is
 * unreachable. Diagonals additionally refuse to cut a corner between two
 * blocked cells, so a 45° step can never slip past the corner of a reserved box
 * that a cell test would call untouched.
 *
 * Deterministic throughout: neighbours are generated in a fixed heading order,
 * the queue breaks ties by insertion sequence, and nothing here reads a clock,
 * a random number or an object's key order.
 */

export type Cell = { readonly column: number; readonly row: number };

/** The eight legal headings, in the order the search generates them. */
export type Heading =
  | "east"
  | "southEast"
  | "south"
  | "southWest"
  | "west"
  | "northWest"
  | "north"
  | "northEast";

const STEPS: readonly { heading: Heading; column: number; row: number }[] = [
  { heading: "east", column: 1, row: 0 },
  { heading: "southEast", column: 1, row: 1 },
  { heading: "south", column: 0, row: 1 },
  { heading: "southWest", column: -1, row: 1 },
  { heading: "west", column: -1, row: 0 },
  { heading: "northWest", column: -1, row: -1 },
  { heading: "north", column: 0, row: -1 },
  { heading: "northEast", column: 1, row: -1 },
];

export const HEADINGS: readonly Heading[] = STEPS.map((step) => step.heading);

function stepOf(heading: Heading): { column: number; row: number } {
  const step = STEPS.find((one) => one.heading === heading);
  if (step === undefined) throw new Error(`not a heading: ${heading}`);
  return step;
}

/* The search encodes a heading as its index, so it has to be able to read one
   back out. The modulo keeps the index in range and the fallback is the type
   system's toll rather than a case. */
function headingAt(index: number): Heading {
  return HEADINGS[((index % HEADINGS.length) + HEADINGS.length) % HEADINGS.length] ?? "east";
}

/**
 * A straight run's kind. Three, because an octolinear drawing has three slopes
 * — and a fourth kind arriving here would mean a curve arrived.
 */
export type SegmentKind = "horizontal" | "vertical" | "diagonal";

export type Segment = {
  readonly from: Cell;
  readonly to: Cell;
  readonly kind: SegmentKind;
  readonly heading: Heading;
};

/**
 * A bend, with the turn measured in eighths of a full turn — 1 is 45°, 2 is a
 * right angle. The renderer needs the magnitude to pick a join; nothing here
 * picks one for it.
 */
export type Corner = {
  readonly at: Cell;
  readonly from: Heading;
  readonly to: Heading;
  readonly eighths: number;
};

export type Route = {
  readonly points: readonly Cell[];
  readonly segments: readonly Segment[];
  readonly corners: readonly Corner[];
};

/* ------------------------------------------------------------- the field --- */

/**
 * Where the grid starts and how far it runs. The origin may be negative: an
 * authored pin is under no obligation to sit inside the generated plate.
 */
export type Bounds = {
  readonly origin: Cell;
  readonly columns: number;
  readonly rows: number;
};

export function cellKey(cell: Cell): string {
  return `${cell.column},${cell.row}`;
}

export function sameCell(one: Cell, other: Cell): boolean {
  return one.column === other.column && one.row === other.row;
}

/** Chebyshev, because the gap that matters on a grid drawn with diagonals is
 *  the one a diagonal can close. */
export function cellGap(one: Cell, other: Cell): number {
  return Math.max(Math.abs(one.column - other.column), Math.abs(one.row - other.row));
}

/**
 * The grid the search walks, with the blocked cells already burnt in.
 *
 * Compiled once per plate and reused for every edge: a string lookup per
 * neighbour per pop is the difference between a router that is free and one
 * that shows up in a profile.
 */
export type Field = {
  readonly bounds: Bounds;
  readonly blocked: Uint8Array;
};

export function fieldOf(bounds: Bounds, blocked: ReadonlySet<string>): Field {
  const grid = new Uint8Array(bounds.columns * bounds.rows);
  for (let row = 0; row < bounds.rows; row += 1) {
    for (let column = 0; column < bounds.columns; column += 1) {
      const cell = {
        column: bounds.origin.column + column,
        row: bounds.origin.row + row,
      };
      if (blocked.has(cellKey(cell))) grid[row * bounds.columns + column] = 1;
    }
  }
  return { bounds, blocked: grid };
}

function indexOf(field: Field, column: number, row: number): number {
  const x = column - field.bounds.origin.column;
  const y = row - field.bounds.origin.row;
  if (x < 0 || y < 0 || x >= field.bounds.columns || y >= field.bounds.rows) return -1;
  return y * field.bounds.columns + x;
}

function open(field: Field, column: number, row: number): boolean {
  const at = indexOf(field, column, row);
  return at >= 0 && field.blocked[at] === 0;
}

/* ------------------------------------------------------------ the search --- */

const ORTHOGONAL_STEP = 10;
/** 14/10 is √2 to two figures: a diagonal really is longer, and pretending it
 *  is not makes the router prefer a staircase to a straight run. */
const DIAGONAL_STEP = 14;
/** Per 45°, and above the diagonal step on purpose — one more bend has to lose
 *  to one more cell of straight track, or the answer is a ladder. */
const TURN_EIGHTH = 9;

export function eighthsBetween(from: Heading, to: Heading): number {
  const a = HEADINGS.indexOf(from);
  const b = HEADINGS.indexOf(to);
  const round = Math.abs(a - b);
  return Math.min(round, HEADINGS.length - round);
}

/**
 * A binary heap over (cost, sequence). The sequence is the tie-break, so two
 * states of equal cost always come off in the order they went in — which is
 * where half of this view's determinism lives.
 */
type Waiting = { readonly cost: number; readonly seq: number; readonly state: number };

class Queue {
  private items: Waiting[] = [];
  private next = 0;

  get size(): number {
    return this.items.length;
  }

  push(cost: number, state: number): void {
    this.items.push({ cost, seq: this.next, state });
    this.next += 1;
    this.up(this.items.length - 1);
  }

  pop(): Waiting | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top === undefined || last === undefined) return undefined;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  private before(one: Waiting, other: Waiting): boolean {
    return one.cost === other.cost ? one.seq < other.seq : one.cost < other.cost;
  }

  private swap(a: number, b: number): void {
    const one = this.items[a];
    const other = this.items[b];
    if (one === undefined || other === undefined) return;
    this.items[a] = other;
    this.items[b] = one;
  }

  private up(at: number): void {
    let child = at;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const one = this.items[child];
      const other = this.items[parent];
      if (one === undefined || other === undefined || !this.before(one, other)) break;
      this.swap(child, parent);
      child = parent;
    }
  }

  private down(at: number): void {
    let parent = at;
    for (;;) {
      let best = parent;
      for (const child of [parent * 2 + 1, parent * 2 + 2]) {
        const one = this.items[child];
        const chosen = this.items[best];
        if (one !== undefined && chosen !== undefined && this.before(one, chosen)) best = child;
      }
      if (best === parent) break;
      this.swap(parent, best);
      parent = best;
    }
  }
}

/**
 * Track from one cell to another, or `null` when the field has no way through.
 *
 * `enter` and `leave` are the headings the track is required to start and end
 * on. The Plate asks for `east` at both ends, and that is what makes a fan a
 * fan: every branch out of a station leaves along the same stub, so the shared
 * stem is a fact about the geometry rather than something drawn on afterwards.
 *
 * `null` is reachable only when an authored pin has walled a station in — a
 * generated plate always leaves a clear relief column between ranks and clear
 * rows under the whole drawing, so a detour always exists. A caller that gets
 * one has an edge it cannot draw, and saying so is better than drawing track
 * through a label.
 */
export function routeTrack(
  field: Field,
  from: Cell,
  to: Cell,
  enter: Heading = "east",
  leave: Heading = "east",
): Route | null {
  const out = stepOf(enter);
  const back = stepOf(leave);
  const start = { column: from.column + out.column, row: from.row + out.row };
  const goal = { column: to.column - back.column, row: to.row - back.row };
  if (!open(field, start.column, start.row) || !open(field, goal.column, goal.row)) return null;

  const states = field.bounds.columns * field.bounds.rows * HEADINGS.length;
  const best = new Int32Array(states).fill(-1);
  const cameFrom = new Int32Array(states).fill(-1);

  const startState =
    indexOf(field, start.column, start.row) * HEADINGS.length + HEADINGS.indexOf(enter);
  const goalState =
    indexOf(field, goal.column, goal.row) * HEADINGS.length + HEADINGS.indexOf(leave);

  const queue = new Queue();
  best[startState] = 0;
  queue.push(0, startState);

  while (queue.size > 0) {
    const top = queue.pop();
    if (top === undefined) break;
    const { cost, state } = top;
    if ((best[state] ?? -1) !== cost) continue;
    if (state === goalState) break;

    const cell = Math.floor(state / HEADINGS.length);
    const heading = headingAt(state);
    const column = field.bounds.origin.column + (cell % field.bounds.columns);
    const row = field.bounds.origin.row + Math.floor(cell / field.bounds.columns);

    for (let next = 0; next < STEPS.length; next += 1) {
      const step = STEPS[next];
      if (step === undefined) continue;
      const turn = eighthsBetween(heading, step.heading);
      // A reversal, or worse, is never the readable answer, and cutting it here
      // is what keeps the state space small enough to be free.
      if (turn > 2) continue;

      const ahead = { column: column + step.column, row: row + step.row };
      if (!open(field, ahead.column, ahead.row)) continue;
      const diagonal = step.column !== 0 && step.row !== 0;
      if (diagonal && (!open(field, ahead.column, row) || !open(field, column, ahead.row))) continue;

      const stepped = cost + (diagonal ? DIAGONAL_STEP : ORTHOGONAL_STEP) + turn * TURN_EIGHTH;
      const aheadState = indexOf(field, ahead.column, ahead.row) * HEADINGS.length + next;
      const known = best[aheadState] ?? -1;
      if (known !== -1 && known <= stepped) continue;
      best[aheadState] = stepped;
      cameFrom[aheadState] = state;
      queue.push(stepped, aheadState);
    }
  }

  if ((best[goalState] ?? -1) === -1) return null;

  const walked: Cell[] = [];
  for (let state = goalState; state !== -1; state = cameFrom[state] ?? -1) {
    const cell = Math.floor(state / HEADINGS.length);
    walked.push({
      column: field.bounds.origin.column + (cell % field.bounds.columns),
      row: field.bounds.origin.row + Math.floor(cell / field.bounds.columns),
    });
    if (state === startState) break;
  }
  walked.reverse();

  const points = cornersOnly([from, ...walked, to]);
  return { points, segments: segmentsOf(points), corners: cornersOf(points) };
}

/* ------------------------------------------------------------- the shape --- */

function headingOf(from: Cell, to: Cell): Heading {
  const column = Math.sign(to.column - from.column);
  const row = Math.sign(to.row - from.row);
  const step = STEPS.find((one) => one.column === column && one.row === row);
  if (step === undefined) {
    throw new Error(`not an octolinear step: ${cellKey(from)} to ${cellKey(to)}`);
  }
  return step.heading;
}

/** Collinear runs collapse to their endpoints: the answer is a polyline, not a
 *  list of every cell it walked through. */
function cornersOnly(walked: readonly Cell[]): readonly Cell[] {
  const points: Cell[] = [];
  let before: Cell | null = null;
  let last: Cell | null = null;
  for (const cell of walked) {
    if (last === null) {
      points.push(cell);
      last = cell;
      continue;
    }
    if (sameCell(last, cell)) continue;
    if (before !== null && headingOf(before, last) === headingOf(last, cell)) {
      points[points.length - 1] = cell;
      last = cell;
      continue;
    }
    points.push(cell);
    before = last;
    last = cell;
  }
  return points;
}

export function kindOf(from: Cell, to: Cell): SegmentKind {
  if (from.row === to.row) return "horizontal";
  if (from.column === to.column) return "vertical";
  return "diagonal";
}

export function segmentsOf(points: readonly Cell[]): readonly Segment[] {
  const segments: Segment[] = [];
  let before: Cell | null = null;
  for (const point of points) {
    if (before !== null) {
      segments.push({
        from: before,
        to: point,
        kind: kindOf(before, point),
        heading: headingOf(before, point),
      });
    }
    before = point;
  }
  return segments;
}

export function cornersOf(points: readonly Cell[]): readonly Corner[] {
  const corners: Corner[] = [];
  let before: Cell | null = null;
  let bend: Cell | null = null;
  for (const point of points) {
    if (before !== null && bend !== null) {
      const from = headingOf(before, bend);
      const to = headingOf(bend, point);
      corners.push({ at: bend, from, to, eighths: eighthsBetween(from, to) });
    }
    before = bend;
    bend = point;
  }
  return corners;
}

/**
 * Every cell a polyline passes through, endpoints included.
 *
 * The honest form of *does this track touch that box*: a polyline crosses a
 * reserved label box whether or not one of its corners lands inside it, so the
 * check has to walk the track rather than sample it. It is also what a fan's
 * shared stem is computed from.
 */
export function cellsAlong(points: readonly Cell[]): readonly Cell[] {
  const cells: Cell[] = [];
  let before: Cell | null = null;
  for (const here of points) {
    if (before === null) {
      cells.push(here);
      before = here;
      continue;
    }
    const step = stepOf(headingOf(before, here));
    const runs = Math.max(Math.abs(here.column - before.column), Math.abs(here.row - before.row));
    for (let one = 1; one <= runs; one += 1) {
      cells.push({
        column: before.column + step.column * one,
        row: before.row + step.row * one,
      });
    }
    before = here;
  }
  return cells;
}

/** Axis-aligned or exactly 45°, asked of a polyline rather than assumed. */
export function isOctolinear(points: readonly Cell[]): boolean {
  let before: Cell | null = null;
  for (const point of points) {
    if (before !== null) {
      const dx = Math.abs(point.column - before.column);
      const dy = Math.abs(point.row - before.row);
      if (dx === 0 && dy === 0) return false;
      if (dx !== 0 && dy !== 0 && dx !== dy) return false;
    }
    before = point;
  }
  return true;
}
