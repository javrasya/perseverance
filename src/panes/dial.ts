import { RACK_RESERVE } from "../rack/rack";
import { BENCH_WIDTH_FLOOR, RANK_RAIL } from "../views/bench/bench";
import { widthNeededFor } from "../views/deep-field/deepField";
import type { ViewName } from "../views/views";

/**
 * The dial: where the seam between the map and the run sits, as arithmetic.
 *
 * Pure on purpose — no React, no DOM, no measurement of its own. Everything
 * here is a function of a **position** (a fraction of the window given to the
 * map side, `0` … `1`) and a **width in pixels**, so every claim the shell makes
 * about what fits, what is shed and what has to stand down is checkable without
 * mounting anything. `src/panes/Dial.tsx` is the hand on it and holds no
 * arithmetic; this file holds no pixels of its own.
 *
 * Two rules are encoded here rather than left to the components:
 *
 * - **Nothing ever switches silently.** [`standDown`] answers *what is wrong and
 *   what could be done about it*; it never answers *what I did about it*. Both
 *   exits it returns are things an operator presses.
 * - **A detent is a place, not a mode.** Positions between detents are legal and
 *   are not rounded away; snapping happens only inside [`SNAP_TOLERANCE`] of a
 *   detent, which is what makes a free position reachable at all.
 */

/** The four named places on the dial, terminal-most first. */
export type Detent = "terminal" | "glance" | "split" | "map";

export const DETENTS: readonly Detent[] = ["terminal", "glance", "split", "map"];

/**
 * How much of the window the map side gets at each detent.
 *
 * `terminal` and `map` are the ends rather than near-ends: a detent that left a
 * sliver of the other side would be a detent nobody can tell from a drag that
 * went slightly wrong.
 */
export const FRACTIONS: Record<Detent, number> = {
  terminal: 0,
  glance: 0.3,
  split: 0.5,
  map: 1,
};

/**
 * Where the dial sits before anyone has moved it, and where a map with nothing
 * remembered about it opens.
 */
export const DEFAULT_DETENT: Detent = "split";

/** How near a detent a free position has to be before it is that detent. */
export const SNAP_TOLERANCE = 0.04;

/** One arrow key's worth of dial. */
export const STEP = 0.02;

/**
 * Whether a move is the hand still on the dial, or the gesture ending.
 *
 * The same two words `src/panes/geometry.ts` uses of a pane size, and the same
 * rule over them: a drag is dozens of these a second, and only the completed
 * gesture is worth telling anything outside this window about. Narrower than
 * that module's `Occasion` on purpose — a dial has two ways to move, and there
 * is no bind and no arrival that puts a hand on one.
 */
export type Move = "drag" | "settled";

/**
 * Whether a move is one to remember.
 *
 * A table over every move rather than a check at each call site, so *which
 * moves are written down* is one line to read and one line to change — the
 * shape [`resizes`] already has for the pane.
 *
 * [`resizes`]: ../panes/geometry.ts
 */
export function remembers(move: Move): boolean {
  return move === "settled";
}

export function fractionOf(detent: Detent): number {
  return FRACTIONS[detent];
}

export function clamp(position: number): number {
  if (!Number.isFinite(position)) return fractionOf(DEFAULT_DETENT);
  if (position < 0) return 0;
  if (position > 1) return 1;
  return position;
}

/** Which detent this position *is*, or `null` for a free position. */
export function detentAt(
  position: number,
  tolerance: number = SNAP_TOLERANCE,
): Detent | null {
  let nearest: Detent | null = null;
  let distance = tolerance;
  for (const detent of DETENTS) {
    const away = Math.abs(clamp(position) - fractionOf(detent));
    if (away <= distance) {
      nearest = detent;
      distance = away;
    }
  }
  return nearest;
}

/** The position, with a near-miss pulled onto the detent it was aiming at. */
export function snap(position: number, tolerance: number = SNAP_TOLERANCE): number {
  const detent = detentAt(position, tolerance);
  return detent === null ? clamp(position) : fractionOf(detent);
}

/**
 * The detent one notch along, for a keyboard that has no pointer to aim with.
 *
 * A free position moves to the next detent past it rather than to the one it is
 * between, so repeated presses always travel.
 */
export function nextDetent(position: number, direction: 1 | -1): Detent {
  const here = clamp(position);
  const ordered = direction === 1 ? DETENTS : [...DETENTS].reverse();
  for (const detent of ordered) {
    const there = fractionOf(detent);
    if (direction === 1 ? there > here + 1e-9 : there < here - 1e-9) return detent;
  }
  return direction === 1 ? "map" : "terminal";
}

/**
 * What each side is worth, in pixels, at this position of this body box.
 *
 * `width` is the **body** — the box the dial divides, measured — and never the
 * window: the map side is applied as a flex-basis percentage of that box, so
 * `position × width` is not an estimate of the map side, it is the map side.
 *
 * `reach` is the dial's own column, which lives between the two sides and
 * belongs to neither. It is a parameter here rather than a subtraction left to
 * the callers because this is the one function that answers *what each side is
 * worth*: a caller that forgot the correction would print a terminal side a
 * dozen pixels wider than the pixels the terminal has, and the whole point of
 * measuring the body was to stop the shell printing arithmetic. The map side is
 * no safer than the terminal side here: the cap below takes the seam out of the
 * map end, so at the `map` detent a reach-blind `.map` is `reach` pixels wider
 * than the pixels a view is drawn into — which is why [`surfaces`] and
 * [`standDown`] thread the measured reach through rather than reading `.map`
 * and hoping. The `0` default is for tests and for callers with no dial on
 * screen to measure; it leaves every answer here exactly what it was.
 *
 * Map + reach + terminal is the body, exactly — at every position, the `map`
 * detent included. That is what the cap below is for: the seam has to come out
 * of one of the two sides, and at the far end there is no terminal side left to
 * take it out of.
 *
 * The terminal side is never worth nothing. [`RACK_RESERVE`] pixels of it are
 * owed to the rack — the region that says what every run in the window is doing
 * — and they are taken out of the map end at *every* position rather than at
 * the `map` detent alone, so the rack never changes width for anything but a
 * dial move the operator made. A rack clipped to zero at the far detent would
 * be the one position where supervising N runs stops working, which is the
 * whole reason the rack sits on the dial's side of the pane: a narrowing
 * terminal takes the pane's pixels and leaves the rack standing.
 *
 * On a body too narrow to afford both, the reservation gives way rather than
 * inverting the dial: it never takes more than half of what the two sides
 * share, so the `map` detent stays map-most at every width and a map side that
 * had pixels before still has them. A floor that could turn the map detent into
 * a terminal detent would be a floor that broke the control it was floored for.
 *
 * [`RACK_RESERVE`]: ../rack/rack.ts
 */
export function sides(
  position: number,
  width: number,
  reach = 0,
): { map: number; terminal: number } {
  const usable = Math.max(0, Math.floor(width));
  const between = Math.min(usable, Math.max(0, Math.round(reach)));
  const shared = usable - between;
  // What the terminal side owes the rack, halved away on a body that cannot
  // afford it. `Math.floor` of half is what keeps the map side the larger of
  // the two at the far detent even when the reservation is biting hardest.
  const owed = Math.min(RACK_RESERVE, Math.floor(shared / 2));
  // The map side is the flex-basis, literally: a percentage of the body box,
  // capped at the body less the dial's own column and less what the rack is
  // owed. The cap only ever bites at the `map` end, and it is not arithmetic
  // tidiness: a map side worth the whole body *plus* a seam is a flex line wider
  // than the box it sits in, and that box is `overflow: hidden`. What gets
  // pushed past the clip edge is the dial's own column — the one control the
  // shed columns, the stand-down's `Widen to map` and the switcher's caps all
  // rely on being on screen at every position. [`mapCap`] below writes this same
  // line, degrade included, as the `max-width` `src/App.tsx` puts on the map
  // side, which is what makes this a description of the layout rather than a
  // claim about it.
  const map = Math.min(Math.round(usable * clamp(position)), shared - owed);
  return { map, terminal: shared - map };
}

/**
 * The map side's `max-width`, in the words a stylesheet can say it in.
 *
 * The same sentence as [`sides`], written for the flexbox, so that the width the
 * shell prints and the width the browser lays out cannot be two numbers. A flat
 * `calc(100% - Xpx)` was the second copy of it, and it was wrong in exactly one
 * place: on a body too narrow to afford the reservation, [`sides`] halves the
 * reservation away rather than inverting the dial, and a flat subtraction knows
 * nothing about that. Below `2 x RACK_RESERVE` of shared width the subtraction
 * hands the terminal side *more* pixels than the map side at the `map` detent —
 * the inversion the degrade branch exists to refuse, printed as a layout. So the
 * cap is a `max()` of the two branches, which is what the arithmetic is: the
 * whole reservation while the body can afford it, half of what the two sides
 * share when it cannot.
 *
 * Percentages rather than the measured body width, because this has to be right
 * on the first paint as well. Before the `ResizeObserver` has spoken the shell
 * measures zero, and a cap computed from zero is a map side collapsed for a
 * frame; a percentage resolves against the box the browser is already laying
 * out. Half a pixel is the whole difference that leaves between this and
 * [`sides`], on an odd shared width, and it falls inside the rack's floor.
 */
export function mapCap(reach: number): string {
  const seam = Math.max(0, Math.round(reach));
  return `max(calc(100% - ${seam + RACK_RESERVE}px), calc((100% - ${seam}px) / 2))`;
}

/**
 * Where [`mapCap`] leaves off, measured in from the body's right edge.
 *
 * The promoted peek is drawn at the `map` detent's width, so it has to stop
 * where the map side's own cap stops — and it is positioned from the right,
 * which makes it the complement of the cap rather than a third spelling of it.
 * The two are derived here together for the same reason the cap is derived at
 * all: a peek that reached past the cap would cover the rack at the one position
 * where the rack is the whole of the terminal side.
 */
export function beyondMapCap(reach: number): string {
  const seam = Math.max(0, Math.round(reach));
  return `min(${seam + RACK_RESERVE}px, calc(${seam}px + (100% - ${seam}px) / 2))`;
}

/**
 * The map side's columns, widest-lived first.
 *
 * Shedding is by **measured width and nothing else** — never by which map is
 * open, never by which view is up. A column is shed because the pixels are not
 * there, and every shed column comes back by moving the dial, which is the one
 * control on screen at every position.
 */
export const COLUMNS = ["launcher", "view", "rail"] as const;

export type Column = (typeof COLUMNS)[number];

/**
 * The map-side width, in pixels, at which each column starts being drawn.
 *
 * Narrowing sheds the rail first, then the launcher, and the view last: the
 * rail's four verbs are about the run that is already on the other side of the
 * dial, the launcher is how you get to a different map, and the view is the
 * reason the map side exists at all.
 *
 * That priority is about which column is *drawn*, and it was contradicted for a
 * while by how the drawn ones divide: the launcher grew on equal terms with the
 * view, so the column shed last was also the column handed half of every pixel
 * the dial gave over — enough to keep a wide view standing itself down at every
 * detent of an ordinary window. It no longer does; the argument and the basis
 * are in `src/chrome/DropRegion.module.css`, beside the region that takes them.
 *
 * The launcher's floor is the contested one, and it stands. #48 argues that the
 * folder launcher may never disappear, and that is true of every reason a shell
 * could have for hiding it — a map being open, a run being live, a view being
 * up. None of those is this. This is width and nothing else: below 420px of
 * *measured* map side the launcher's rows cannot be read, and the dial that
 * brings them back is on screen at every position, one move away. A column shed
 * by measurement and restored by one control is not a column that disappeared,
 * so #48's claim is discharged rather than overridden, and the number is left
 * where it is. `tests/dial.test.ts` pins both halves.
 */
export const COLUMN_FLOORS: Record<Column, number> = {
  view: 260,
  launcher: 420,
  rail: 500,
};

export function columnsAt(mapWidth: number): readonly Column[] {
  return COLUMNS.filter((column) => mapWidth >= COLUMN_FLOORS[column]);
}

/**
 * How wide the body has to be before the detents are drawn with their names.
 *
 * The seam is a hairline in a 0.75rem column, so names on it cost the two sides
 * a few pixels each; below this the ticks are drawn bare and the names stay
 * where they already are, on the switcher and on the stand-down.
 */
export const NAME_FLOOR = 900;

/** Whether the detent ticks can afford to be labelled in a body this wide. */
export function namesFit(width: number): boolean {
  return width >= NAME_FLOOR;
}

/**
 * The map side the shell has to hand the Bench before the Bench will draw, in
 * pixels.
 *
 * `BENCH_WIDTH_FLOOR` is a **canvas** and the map side is the whole flex line,
 * so the two are different boxes and equating them would stand nothing down
 * where it matters: the shell would find the floor honoured, draw the view
 * column, and the Bench would put its own stood-down canvas inside it with
 * nothing in the shell saying why. This walks the boxes between the two,
 * outermost in — every length named against the stylesheet that owns it:
 *
 * - the rail column is `flex: 0 0 var(--c-app-rail-width)` — 13rem, and the
 *   root font size is the 16px default — so [`RAIL_COLUMN`] comes off the map
 *   side before anything is shared out (`src/App.module.css`);
 * - the launcher and the view are then both `flex: 1` with a zero basis. **What
 *   they halve is what is left of the map side once every box on the line has
 *   taken its own margins, padding and borders**, and that is the one step of
 *   this walk it is easy to get wrong: `flex-grow` shares out free space into
 *   the items' *content* boxes, and free space is the line less each item's
 *   outer non-content lengths. So the two columns end up with equal **content**
 *   widths and unequal border boxes, and every gutter below is subtracted once,
 *   before the halving, rather than being carried inside a share;
 * - the launcher column is the drop region itself, and it wears its frame on
 *   the flex item: `--s-space-base` of margin, `--s-space-room` of padding and a
 *   `--s-border-hairline` border on each side ([`LAUNCHER_COLUMN_FRAME`],
 *   `src/chrome/DropRegion.module.css`). None of it is the view's to spend, and
 *   a derivation that halved the line without it would promise the Bench a
 *   canvas 33px wider than the one it is handed — enough, at exactly this
 *   floor, for the Bench to stand itself down inside a view column the shell
 *   had just found roomy enough;
 * - the view column pads itself by `--s-space-base` on each side
 *   ([`VIEW_COLUMN_PAD`], `src/App.module.css`), and the Bench's frame is
 *   `width: 100%` of what that leaves;
 * - and the Bench spends [`RANK_RAIL`] of its frame on the rank gutter before
 *   `benchOf` is handed a canvas at all.
 *
 * There is no second regime to fold in: the widest entry in [`COLUMN_FLOORS`]
 * is the rail's 500px and this number is far above it, so at every width that
 * honours this floor all three columns are drawn and the share really is a
 * half. `tests/dial.test.ts` pins the arithmetic against the three stylesheets
 * so a change to any of the lengths is a red test rather than a silent drift,
 * `tests/dial-shell.test.tsx` mounts the shell either side of it, and
 * `tests/conformance/bench-box.spec.ts` is the one that measures it in a real
 * engine: it computes its viewport back from this constant and drives the Bench
 * at exactly `BENCH_WIDTH_FLOOR` of canvas, so a floor that over-promises is a
 * Bench that mounts and draws nothing.
 */
const RAIL_COLUMN = 13 * 16;
const VIEW_COLUMN_PAD = 16;
/**
 * The drop region's own frame, both sides: margin, padding and border.
 *
 * `src/chrome/DropRegion.module.css` puts all three on the flex item rather than
 * inside it, so they come off the shared line and never out of the view's half.
 */
const LAUNCHER_COLUMN_FRAME = 2 * (16 + 48 + 1);
/** The launcher and the view, both `flex: 1`: the view column gets one of two. */
const VIEW_COLUMN_SHARE = 2;

export const BENCH_MAP_FLOOR =
  VIEW_COLUMN_SHARE * (BENCH_WIDTH_FLOOR + RANK_RAIL) +
  2 * VIEW_COLUMN_PAD +
  LAUNCHER_COLUMN_FRAME +
  RAIL_COLUMN;

/**
 * How much map side each view needs to be worth drawing.
 *
 * A `Record` over `ViewName` rather than a list, so a view added to `VIEWS`
 * without a floor is a type error rather than a view that silently claims to
 * fit anywhere. The Route is a single column of grouped rows; the wider views
 * (#63/#64) arrive as one entry each.
 *
 * Every number here is a **map side**, because that is the box [`standDown`]
 * compares against — so a view whose own floor is about a smaller box has to be
 * converted rather than copied. The Route's floor is already a map side: it is
 * one column of rows and it is drawn in the whole of what the view column gets.
 * The Bench's is not, and [`BENCH_MAP_FLOOR`] is that conversion. The import
 * runs view → dial, which is the direction that already exists (`ViewName`
 * above) and so adds no cycle.
 */
export const VIEW_FLOORS: Record<ViewName, number> = {
  route: 420,
  bench: BENCH_MAP_FLOOR,
  /*
   * Two rank columns' worth: the narrowest picture in which one ticket is drawn
   * releasing another, which is the whole of what this view is for. Asked of
   * the layout rather than written down, so the plate lane, the clearance and
   * the column pitch cannot drift away from the number the dial promises. One
   * column would fit in less and would be a field with no fan-out in it, and a
   * map deeper than two stands the view down from inside — that answer moves
   * with the map and no constant here can say it.
   */
  "deep-field": widthNeededFor(2),
};

/**
 * What a view needs, floored by the column it has to be drawn in.
 *
 * A view's own floor is never the whole answer: the view column is shed at
 * `COLUMN_FLOORS.view` by measurement alone, so below that width *no* view can
 * be drawn however modest its own appetite. Taking the maximum here is what
 * keeps [`standDown`] and [`columnsAt`] from ever disagreeing — a view that is
 * not on screen is a view that is standing down, at every width, including the
 * ones a future view with a floor under 260 would otherwise slip through.
 */
export function floorOf(view: ViewName, floors: Record<string, number> = VIEW_FLOORS): number {
  return Math.max(COLUMN_FLOORS.view, floors[view] ?? 0);
}

export function honours(floor: number, mapWidth: number): boolean {
  return mapWidth >= floor;
}

/**
 * The narrowest detent that gives a floor the pixels it asked for, or `null`
 * when this window is too small for it at any position.
 *
 * `reach` is the dial's own column, and it has to be the measured one: a floor
 * inside the last `reach` pixels of the body is honoured by no detent at all,
 * and answering `map` for it would send the operator to a position where the
 * view still does not fit.
 */
export function surfaces(floor: number, width: number, reach = 0): Detent | null {
  for (const detent of DETENTS) {
    if (honours(floor, sides(fractionOf(detent), width, reach).map)) return detent;
  }
  return null;
}

/** Which views can be drawn at this map-side width, in registry order. */
export function fittingViews(
  mapWidth: number,
  views: readonly ViewName[],
  floors: Record<string, number> = VIEW_FLOORS,
): readonly ViewName[] {
  return views.filter((view) => honours(floorOf(view, floors), mapWidth));
}

/**
 * A way out of a stand-down, and always one the operator takes.
 *
 * `honoured: false` on a `widen` says *this is the widest this window has and it
 * still is not enough* — the exit is offered anyway, because an exit hidden when
 * it is the only one left is a dead end.
 */
export type Exit =
  | { kind: "widen"; detent: Detent; honoured: boolean }
  | { kind: "open"; view: ViewName }
  | { kind: "terminal" };

export interface StandDown {
  /** The view that cannot be drawn, named. */
  view: ViewName;
  /** What it needs, in pixels of map side. */
  needs: number;
  /** What this position actually gives it. */
  has: number;
  /** Exactly two, and neither happens by itself. */
  exits: readonly [Exit, Exit];
}

/**
 * Whether the open view can be drawn here, and if not, what is on offer.
 *
 * Returns `null` when the view fits, which is the only answer that means
 * *carry on*. Nothing in here moves the dial or changes the view: the caller
 * renders the two exits as controls and the operator presses one.
 *
 * `reach` is the dial's own measured column, and it is what keeps `has` a
 * measurement rather than arithmetic: the map side the view is drawn into is
 * the body less that column at the `map` end, so a reach-blind answer would
 * print a `has` too big by `reach` and, in the band the cap bites in, return
 * `null` for a view that is being drawn below its floor with nothing on screen
 * to say so. The same number goes into the widen exit, so `honoured` tells the
 * truth about the detent it names.
 */
export function standDown(
  view: ViewName,
  position: number,
  width: number,
  views: readonly ViewName[],
  floors: Record<string, number> = VIEW_FLOORS,
  reach = 0,
): StandDown | null {
  const has = sides(position, width, reach).map;
  const needs = floorOf(view, floors);
  if (honours(needs, has)) return null;

  const wider = surfaces(needs, width, reach);
  const alternatives = fittingViews(has, views, floors).filter((other) => other !== view);

  const widen: Exit =
    wider === null
      ? { kind: "widen", detent: "map", honoured: false }
      : { kind: "widen", detent: wider, honoured: true };
  const instead = alternatives[0];
  const second: Exit =
    instead === undefined ? { kind: "terminal" } : { kind: "open", view: instead };

  return { view, needs, has, exits: [widen, second] };
}
