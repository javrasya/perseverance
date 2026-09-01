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
 */
export function sides(
  position: number,
  width: number,
  reach = 0,
): { map: number; terminal: number } {
  const usable = Math.max(0, Math.floor(width));
  const between = Math.min(usable, Math.max(0, Math.round(reach)));
  // The map side is the flex-basis, literally: a percentage of the body box,
  // capped at the body less the dial's own column. The cap only ever bites at
  // the `map` end, and it is not arithmetic tidiness: a map side worth the whole
  // body *plus* a seam is a flex line wider than the box it sits in, and that
  // box is `overflow: hidden`. What gets pushed past the clip edge is the dial's
  // own column — the one control the shed columns, the stand-down's `Widen to
  // map` and the switcher's caps all rely on being on screen at every position.
  // The terminal side is what is left once the dial's column is taken out, and
  // never less than nothing.
  const map = Math.min(Math.round(usable * clamp(position)), usable - between);
  return { map, terminal: usable - between - map };
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
 * How much map side each view needs to be worth drawing.
 *
 * A `Record` over `ViewName` rather than a list, so a view added to `VIEWS`
 * without a floor is a type error rather than a view that silently claims to
 * fit anywhere. The Route is a single column of grouped rows; the wider views
 * (#62/#63/#64) arrive as one entry each.
 */
export const VIEW_FLOORS: Record<ViewName, number> = {
  route: 420,
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
