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
 * measuring the body was to stop the shell printing arithmetic. It defaults to
 * `0` for the callers that only ever read `.map` — [`surfaces`], [`standDown`]
 * — where the dial's column is on the other side of the number entirely.
 *
 * Map + reach + terminal is the body, exactly.
 */
export function sides(
  position: number,
  width: number,
  reach = 0,
): { map: number; terminal: number } {
  const usable = Math.max(0, Math.floor(width));
  const between = Math.min(usable, Math.max(0, Math.round(reach)));
  // The map side is the flex-basis, literally: a percentage of the body box.
  // The terminal side is what is left once the dial's own column is taken out,
  // and never less than nothing.
  const map = Math.round(usable * clamp(position));
  return { map, terminal: Math.max(0, usable - between - map) };
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
};

export function floorOf(view: ViewName, floors: Record<string, number> = VIEW_FLOORS): number {
  return floors[view] ?? 0;
}

export function honours(floor: number, mapWidth: number): boolean {
  return mapWidth >= floor;
}

/**
 * The narrowest detent that gives a floor the pixels it asked for, or `null`
 * when this window is too small for it at any position.
 */
export function surfaces(floor: number, width: number): Detent | null {
  for (const detent of DETENTS) {
    if (honours(floor, sides(fractionOf(detent), width).map)) return detent;
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
 */
export function standDown(
  view: ViewName,
  position: number,
  width: number,
  views: readonly ViewName[],
  floors: Record<string, number> = VIEW_FLOORS,
): StandDown | null {
  const has = sides(position, width).map;
  const needs = floorOf(view, floors);
  if (honours(needs, has)) return null;

  const wider = surfaces(needs, width);
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
