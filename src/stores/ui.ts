import { useSyncExternalStore } from "react";
import { DEFAULT_DETENT, clamp, fractionOf } from "../panes/dial";
import { readDefaultView, writeDefaultView, type ViewName } from "../views/views";
import { readable } from "./readable";

/**
 * What this window is looking at, and what the operator's hand is doing.
 *
 * **The second of the two stores, and the one with the longer lifetime.** It
 * changes when the operator does something and at no other time — nothing behind
 * it polls, nothing arrives on it unprompted, and **no change to it round-trips
 * through Rust**. Selecting a node, moving a divider or switching which run is
 * on the pane are answered in this process, in the same frame, and Rust hears
 * about the ones it needs to act on afterwards.
 *
 * That is the whole reason it is not a corner of the snapshot store. A poll
 * lands on its own cadence and replaces the snapshot wholesale; if the two lived
 * together, every landing would be a chance to reset a drag that was still in
 * progress. Here there is no such chance, because a poll cannot write this.
 *
 * The fields are the ones this slice actually has. The dial arrived as
 * `position` — one number, because a detent is a named position rather than a
 * mode — and **the peek, the warm surface and the rack binding are still not
 * declared here**: they are #52's next slice, #55's and #56's, and a field with
 * one legal value invented now would be making those tickets' decisions early.
 * What the shape settles is only that when they arrive, they arrive *here*
 * rather than beside a snapshot.
 */
export interface Ui {
  /** Which view is on screen. App-global and remembered across launches. */
  view: ViewName;
  /** Which node the operator has selected, or none. */
  selection: number | null;
  /** Which run's bytes cross to this window, or none. */
  monitored: number | null;
  /**
   * Where the dial is: the share of the window the map side has, `0` … `1`.
   *
   * A number rather than a detent, because free positions between detents are
   * legal — `src/panes/dial.ts` is what says which numbers are named places.
   * It lives here for the same reason `dragging` does: a poll landing mid-drag
   * may not move it, and this is the store a poll cannot write.
   */
  position: number;
  /** The pane, in characters. One geometry for every live run. */
  geometry: Geometry;
  /**
   * Whether a resize gesture is in progress.
   *
   * The whole of *never during a drag*: while this is true nothing is sent to
   * Rust, and it is the falling edge that sends exactly one geometry.
   */
  dragging: boolean;
}

/** A pane size, in characters. The same pair Rust holds, and the only pair. */
export interface Geometry {
  rows: number;
  cols: number;
}

/** What a run opens at, matching `Geometry::opening` on the Rust side. */
export const OPENING: Geometry = { rows: 40, cols: 120 };

const [store, replace] = readable<Ui>({
  view: readDefaultView(),
  selection: null,
  monitored: null,
  /*
   * The default detent, not a remembered one. What a *map* is worth is
   * remembered per map by `src/panes/position.ts`, and the shell restores it
   * when a map is opened — a store initialiser has no map to ask about.
   */
  position: fractionOf(DEFAULT_DETENT),
  geometry: OPENING,
  dragging: false,
});

/**
 * One change, applied wholesale.
 *
 * A function of the current value rather than a patch object, so a caller that
 * reads a field and writes it back cannot be looking at a value that has since
 * been replaced. Returning the same object notifies nobody.
 */
function change(next: (current: Ui) => Ui): void {
  const current = store.read();
  const updated = next(current);
  replace(updated);
}

export function useUi(): Ui {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

export function readUi(): Ui {
  return store.read();
}

export function watchUi(listener: () => void): () => void {
  return store.subscribe(listener);
}

/** The view, remembered across launches by the same two functions as before. */
export function chooseView(view: ViewName): void {
  writeDefaultView(view);
  change((current) => (current.view === view ? current : { ...current, view }));
}

/**
 * Move the dial.
 *
 * Remembering it is the caller's next line and not this function's business:
 * the position is remembered *per map*, and this store has no idea which map is
 * open. Same division as `monitor` — the declaration is here, the consequence is
 * the caller's.
 */
export function moveDial(position: number): void {
  const wanted = clamp(position);
  change((current) => (current.position === wanted ? current : { ...current, position: wanted }));
}

export function select(selection: number | null): void {
  change((current) => (current.selection === selection ? current : { ...current, selection }));
}

/**
 * Which run is on the pane.
 *
 * This is the *declaration*; telling Rust is the caller's next line and not this
 * function's business. Binding a run changes nothing else — not the geometry,
 * not the run's terminal, not how much of its stream that terminal holds — which
 * is what makes *never resize on bind* true on this side of the seam too.
 */
export function monitor(run: number | null): void {
  change((current) => (current.monitored === run ? current : { ...current, monitored: run }));
}

export function startGesture(): void {
  change((current) => (current.dragging ? current : { ...current, dragging: true }));
}

/**
 * The gesture ended on `geometry`.
 *
 * Returns whether this is a new size, which is the caller's cue to tell Rust —
 * **once**. A gesture that ended where it began returns `false` and reflows
 * nothing, because a resize to the size everything is already at is a reflow of
 * every live terminal for no reason, including one mid-grilling.
 */
export function settle(geometry: Geometry): boolean {
  const current = store.read();
  const same =
    current.geometry.rows === geometry.rows && current.geometry.cols === geometry.cols;
  replace({ ...current, geometry: same ? current.geometry : geometry, dragging: false });
  return !same;
}
