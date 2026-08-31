import { useSyncExternalStore } from "react";
import { DEFAULT_DOCK, type Dock } from "../detail/docks";
import { DEFAULT_DETENT, clamp, fractionOf } from "../panes/dial";
import type { PeekSource } from "../panes/peek";
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
 * mode — and the peek arrived beside it as `peeking`, a *separate* field for the
 * reason the whole gesture exists: a glance borrows the dial and may not move
 * it. `dock` arrived beside them both because the same argument holds a third
 * time: which dock the boarding pass is at is a press and never an arrival, so
 * a poll may not write it either. The warm surface and the rack *binding* are
 * still not declared here — they are #55's and #56's, and a field with one legal
 * value invented now would be making those tickets' decisions early. What the shape settles is only that
 * when they arrive, they arrive *here* rather than beside a snapshot.
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
  /**
   * The spring-loaded glance, while it is held.
   *
   * Beside `position` and never inside it: the peek reads as `map` on screen
   * while the dial's remembered position is untouched, so a glance rearranges
   * nothing and springs back to exactly the room it borrowed.
   */
  peeking: Peeking;
  /**
   * Which dock the operator has sent the node panel to.
   *
   * The dock they *chose*, which is not always the dock the pass is at: a dial
   * position that collapses the terminal side leaves a dock on it worth no
   * pixels, and `effectiveDock` in `src/detail/docks.ts` borrows the pass onto
   * the spine until the width comes back. The choice is kept here through all
   * of that, which is what makes the return a spring rather than a second
   * press — the same borrow-and-give-back `peeking` has beside `position`.
   *
   * Nothing automatic writes it. There is exactly one caller of `chooseDock`
   * and it is a button.
   */
  dock: Dock;
  /** The pane, in characters. One geometry for every live run. */
  geometry: Geometry;
  /**
   * Whether a resize gesture is in progress.
   *
   * The whole of *never during a drag*: while this is true nothing is sent to
   * Rust, and it is the falling edge that sends exactly one geometry.
   */
  dragging: boolean;
  /**
   * What stands in front of the terminal, or nothing.
   *
   * **One field and one value**, not a flag per surface: *what is in front* is
   * a single fact, and two booleans would let the window claim two answers to
   * it — two surfaces holding the keys, and an `Esc` with two destinations. The
   * router's own state carries this field verbatim, so a surface's dismiss row
   * and the `Esc` readout are reading the same one fact.
   */
  inFront: Surface | null;
}

/**
 * The surfaces that can stand in front of the terminal.
 *
 * A union rather than the literal, because the keys page stands beside the
 * palette in exactly the same place: in front of the terminal, holding the
 * keys, dismissed by `Esc`. Both are here and neither is a flag of its own —
 * *what is in front* stays one fact with one value, so `Esc` never has two
 * destinations at once.
 */
export type Surface = "palette" | "keys";

/**
 * What a peek is on screen, and the whole of what this store keeps about one.
 *
 * The spring's own machine — the beat of the auto-repeat, why it last released
 * — lives in `src/panes/peek.ts` and is stepped in a ref, because a store write
 * per repeat keydown would re-render the window thirty times a second for a
 * number nothing draws. These three are the drawn facts and nothing else.
 */
export interface Peeking {
  /** What is holding the spring, or nothing. */
  held: PeekSource | null;
  /** The app claimed the chord, and the run underneath never saw it. */
  swallowed: boolean;
  /** Why a hold gave nothing, in words. Never silence. */
  refused: string | null;
}

export const NOT_PEEKING: Peeking = { held: null, swallowed: false, refused: null };

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
  peeking: NOT_PEEKING,
  dock: DEFAULT_DOCK,
  geometry: OPENING,
  dragging: false,
  inFront: null,
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

/**
 * What the spring is doing, drawn.
 *
 * Deliberately not a call to [`moveDial`]: a peek shows the map side at map
 * width without the dial having moved, and nothing here reaches
 * `src/panes/position.ts`. A glance that wrote the per-map memory would leave
 * the room rearranged after the operator let go.
 */
export function showPeek(peeking: Peeking): void {
  change((current) => {
    const same =
      current.peeking.held === peeking.held &&
      current.peeking.swallowed === peeking.swallowed &&
      current.peeking.refused === peeking.refused;
    return same ? current : { ...current, peeking };
  });
}

/**
 * Send the node panel to a dock.
 *
 * Nothing automatic calls this — no poll, no dial move, no arrival. A dial
 * position that collapses the chosen dock is answered by *reading* this field
 * through `effectiveDock` rather than by rewriting it, because a store that
 * corrected the operator's choice on their behalf would have no choice left to
 * spring back to.
 */
export function chooseDock(dock: Dock): void {
  change((current) => (current.dock === dock ? current : { ...current, dock }));
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
 *
 * **Only a press calls this.** Every caller is an operator doing something: the
 * rail starting or resuming a run, the idea box, and the one press that ends a
 * run and empties the pane. Nothing automatic may reach it, and in particular
 * **a run dying does not move the caret**. Auto-rebinding is theft — the next
 * keystroke would land in a different agent's conversation, typed by somebody
 * who had no idea the pane had changed under them — so when the keyed run's
 * child stops, the caret parks: the pane stays on that run so its last output can
 * be read and its crash diagnosed, printable keys go to that run's register in
 * `src/terminal/spill.ts` instead of a child that is gone, and the run keeps its
 * row in the readouts as `exited`, because a run vanishing from the layout would
 * be the world rearranging the operator's screen. The one exception is the End
 * press, which is a person deciding they are finished reading.
 *
 * One non-press caller exists and it is named here so that the rule above can be
 * read as absolute wherever it matters: the `dev:web` fixture boot, in
 * `src/terminal/fixtures.ts`, which binds the pane to a hand-written readout on
 * the window's first tick. It is gated on `hasRustBehindIt()` and answers `null`
 * the moment there is a harness behind the window, so it cannot move a caret
 * that any keystroke could follow — there is no child on the other end of it to
 * steal a keystroke for. On a real harness the rule holds without exception, and
 * nothing driven by a poll, a readout tick or a death path reaches this.
 */
export function monitor(run: number | null): void {
  change((current) => (current.monitored === run ? current : { ...current, monitored: run }));
}

/**
 * Put a surface in front of the terminal.
 *
 * Raising a second surface replaces the first rather than stacking on it: the
 * field holds one value, and a stack would be a second answer to *what does
 * `Esc` take away* — the exact ambiguity the single field exists to rule out.
 */
export function raise(surface: Surface): void {
  change((current) => (current.inFront === surface ? current : { ...current, inFront: surface }));
}

/**
 * Take whatever is in front away.
 *
 * Whatever, and not a named one: the caller that dismisses is the router's
 * dismiss row, which already knows the row it matched applied. Giving the
 * keyboard back is the shell's business and not this store's — the same
 * division `monitor` and `moveDial` draw.
 */
export function dismiss(): void {
  change((current) => (current.inFront === null ? current : { ...current, inFront: null }));
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
