import {
  labelOf,
  matches,
  platformName,
  readChord,
  type Chord,
  type KeyboardLike,
} from "../panes/peek";
import { readUi } from "../stores/ui";

/**
 * The one key router: a single chord→action table, at the window, in the
 * capture phase, and the only place in this app a key is bound at all.
 *
 * **Why the window, and why capture.** xterm.js binds its own listeners to a
 * helper `<textarea>` inside the pane, and it takes every key that reaches it.
 * A listener anywhere below the window would therefore never fire while a run
 * is warm, and a *bubble*-phase listener at the window only fires when xterm
 * decided not to call `preventDefault` — which is to say, on the keys the app
 * least needs. Capture at the window is the only placement that can reserve a
 * chord at all.
 *
 * That placement is also why the table has to be narrow. Capture sees every
 * keystroke in the window, and while a run is on the pane the overwhelming
 * majority of them are the operator typing at an agent. **The router claims
 * only what is in the table**; everything else is left completely alone — not
 * inspected, not defaulted, not re-dispatched — and reaches the terminal the
 * way it would if this file did not exist.
 *
 * **Why `Esc` is not in the table.** Its destination is state-dependent, so any
 * static entry for it would be a lie in some state. Whenever the terminal holds
 * the keys, `Esc` is unclaimed and is encoded and sent to the PTY like any
 * ordinary key — it is the interrupt of every agent CLI, and an app that
 * swallows it takes away the only way to stop a run. When a dismissible surface
 * is in front of the terminal, that surface holds the keys, the CLI is not
 * being typed at, and `Esc` takes the surface away. Those are the only two
 * destinations, neither of them changes view, room or dial position, and
 * [`escDestination`] prints whichever is live *by reading this same table* —
 * which is why a row that dismisses something declares `dismisses` rather than
 * the readout keeping a list of its own. A surface added by a later ticket is
 * then picked up by a readout nobody edited. Crossing between the map and the
 * terminal is a chord of its own, and never `Esc`.
 */

/** Everything this table can ask the app to do. */
export type ActionId =
  | "home"
  | "cross"
  | "open"
  | "peek"
  | "dial-wider"
  | "dial-narrower"
  | "dial-next-detent"
  | "dial-previous-detent"
  | "dial-terminal"
  | "dial-map";

/**
 * What routing a key needs to know, and the whole of it.
 *
 * A plain value rather than a set of module reads, so [`route`] is pure and the
 * table's predicates are assertable against hand-written states. The live one
 * is assembled by [`currentState`].
 */
export interface KeyState {
  /** Which platform answered, for the per-platform chord forms and labels. */
  os: string;
  /** The peek's bound chord: the operator's rebind, or the platform's (#52). */
  summon: Chord;
  /**
   * The key is going into a field — an `<input>`, `<textarea>`, `<select>` or
   * a `contenteditable` — which includes xterm's own helper textarea.
   *
   * Bare keys belong to whatever is being typed into. Only a chord carrying a
   * modifier the field has no use for may be taken out from under it.
   */
  typing: boolean;
  /** The route node the key went to, if it went to one. */
  focusedNode: number | null;
  /** The key went to the dial, whose arrows are its own ARIA semantics. */
  dialFocused: boolean;
  /** Which run's bytes are on the pane, or none. */
  monitored: number | null;
  /** Which node is selected, so a second press on it puts it back. */
  selection: number | null;
}

/**
 * One row of the table.
 *
 * The `verb` is not decoration: the command palette and the keys page are
 * *generated* from these rows, so a row that cannot say what it does in a
 * sentence is a row those two surfaces would have to hard-code. It is written
 * here, once, beside the chord it belongs to.
 */
export interface Entry {
  id: ActionId;
  /**
   * How it is pressed. A function of the state because the answer is
   * per-platform — and a list because one action may have more than one way in
   * (`Enter` and `Space` both open the row under the keyboard).
   */
  chords: (state: KeyState) => readonly Chord[];
  /** What it does, as a human sentence. Printed verbatim. */
  verb: string;
  /** When the row applies. A row whose predicate is false is not claimed. */
  when: (state: KeyState) => boolean;
  /** The action lasts while the key is held, and ends on its keyup. */
  held?: boolean;
  /**
   * What this row takes off the screen, named for the readout.
   *
   * Present only on a row that dismisses a surface standing in front of the
   * terminal. [`escDestination`] reads it, which is what keeps the readout and
   * the routing one source rather than two.
   */
  dismisses?: string;
}

function chord(key: string, modifiers: Partial<Chord> = {}): Chord {
  return { key, meta: false, ctrl: false, alt: false, shift: false, ...modifiers };
}

function isMac(os: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(os);
}

/** A chord carrying nothing a field would not itself want. */
function bare(pressed: Chord): boolean {
  return !pressed.meta && !pressed.ctrl && !pressed.alt;
}

/**
 * The crossing chord: `⌘E` on macOS, `Alt+E` everywhere else.
 *
 * It is the chord that used to be `Esc`, and handing `Esc` back to the CLI is
 * the whole point of this ticket. The per-platform split is #52's, for #52's
 * reason: on macOS `⌘` never reaches the shell, and elsewhere `Alt` is the one
 * modifier no shell reads as a control character — which rules out the whole
 * `Ctrl`+letter row, `Ctrl+G` (`BEL`) loudest of all.
 */
function crossing(os: string): Chord {
  return isMac(os) ? chord("e", { meta: true }) : chord("e", { alt: true });
}

/**
 * The table.
 *
 * Order is resolution order, and no two rows share a chord in a state where
 * both apply.
 */
export const ENTRIES: readonly Entry[] = [
  {
    id: "home",
    // `Ctrl+0`, and deliberately not `Ctrl+R`: that is reverse-i-search in
    // every shell and REPL an agent is likely to be sitting in.
    chords: () => [chord("0", { ctrl: true })],
    verb: "go home: the default view, at the default split",
    when: () => true,
  },
  {
    id: "cross",
    chords: (state) => [crossing(state.os)],
    verb: "cross between the map and the terminal",
    when: () => true,
  },
  {
    id: "peek",
    chords: (state) => [state.summon],
    verb: "peek at the map for as long as you hold it",
    when: () => true,
    held: true,
  },
  {
    id: "open",
    chords: () => [chord("Enter"), chord(" ")],
    // Space would scroll the pane out from under the row being picked, which is
    // why this is claimed rather than left to the browser.
    verb: "open the node under the keyboard, or put it back",
    when: (state) => state.focusedNode !== null,
  },
  /*
   * The dial's own keyboard, which is that widget's ARIA semantics rather than
   * a set of app-wide chords — hence the predicate. They are in this table and
   * not on the element because *nothing else in the app binds a key* is a
   * structural claim (`tests/no-loose-keys.test.ts`), and an exception for a
   * focused widget is exactly the kind of second binding that would make the
   * palette's account of what a key does incomplete.
   */
  {
    id: "dial-wider",
    chords: () => [chord("ArrowRight")],
    verb: "give the map a little more of the window",
    when: (state) => state.dialFocused,
  },
  {
    id: "dial-narrower",
    chords: () => [chord("ArrowLeft")],
    verb: "give the terminal a little more of the window",
    when: (state) => state.dialFocused,
  },
  {
    id: "dial-next-detent",
    chords: () => [chord("PageUp")],
    verb: "go to the next detent toward the map",
    when: (state) => state.dialFocused,
  },
  {
    id: "dial-previous-detent",
    chords: () => [chord("PageDown")],
    verb: "go to the next detent toward the terminal",
    when: (state) => state.dialFocused,
  },
  {
    id: "dial-terminal",
    chords: () => [chord("Home")],
    verb: "give the whole window to the terminal",
    when: (state) => state.dialFocused,
  },
  {
    id: "dial-map",
    chords: () => [chord("End")],
    verb: "give the whole window to the map",
    when: (state) => state.dialFocused,
  },
];

/**
 * Which row claims this keystroke, or none.
 *
 * Pure, and the only answer to *is this chord claimed* there is: the window
 * listener below and xterm's custom key handler both come through here, so the
 * key the terminal is refused is by construction the key the app acted on.
 */
export function route(event: KeyboardLike, state: KeyState): Entry | null {
  for (const entry of ENTRIES) {
    if (!entry.when(state)) continue;
    for (const pressed of entry.chords(state)) {
      // A bare key in a field is the field's. Nothing in this table may take an
      // unmodified keystroke out from under something being typed into — xterm's
      // helper textarea included, which is how ordinary typing stays ordinary.
      if (state.typing && bare(pressed)) continue;
      if (matches(pressed, event)) return entry;
    }
  }
  return null;
}

/** How a row is written on screen. What the palette and the keys page print. */
export function labelFor(entry: Entry, state: KeyState): string {
  return entry
    .chords(state)
    .map((pressed) => labelOf(pressed, state.os))
    .join(" or ");
}

/**
 * Where `Esc` goes right now, in words, computed from the table above.
 *
 * Never a hard-coded string per state: the dismissible surfaces are rows, and a
 * row added by a later ticket changes this answer without this function being
 * touched. The no-run case says so plainly rather than naming a destination
 * that is not there.
 */
export function escDestination(state: KeyState, table: readonly Entry[] = ENTRIES): string {
  const dismissing = table.find(
    (entry) =>
      entry.dismisses !== undefined &&
      entry.when(state) &&
      entry.chords(state).some((pressed) => pressed.key === "Escape"),
  );
  if (dismissing !== undefined) return `dismisses ${dismissing.dismisses}`;
  if (state.monitored !== null) return "reaches the agent CLI";
  return "reaches nothing yet — nothing is bound to this window";
}

/*
 * The bound summon chord, read once and remembered.
 *
 * `readChord` touches `localStorage`, and this is on the path of every
 * keystroke in the window — including every character typed at an agent. The
 * rebind is the only thing that can change the answer, and it says so.
 */
let summon: Chord | null = null;

function summonChord(): Chord {
  return (summon ??= readChord());
}

/** The peek was rebound; forget the remembered chord. Called by `usePeek`. */
export function rebound(): void {
  summon = null;
}

const FIELDS = ["input", "textarea", "select"];

function typingInto(element: Element | null): boolean {
  if (element === null) return false;
  if (FIELDS.includes(element.tagName.toLowerCase())) return true;
  return element.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

function nodeUnder(element: Element | null): number | null {
  const row = element?.closest("[data-node]") ?? null;
  if (row === null) return null;
  const number = Number(row.getAttribute("data-node"));
  return Number.isInteger(number) ? number : null;
}

/**
 * The live state, assembled from the event's own target rather than from
 * `document.activeElement`.
 *
 * They are the same element in every real press — a key goes where the focus
 * is — but the target is the fact the event itself carries, and reading it is
 * what lets the row and the dial be resolved without this module having to ask
 * the document what has focus.
 */
export function currentState(target: EventTarget | null = null): KeyState {
  const element =
    target instanceof Element ? target : (document.activeElement as Element | null);
  const ui = readUi();
  return {
    os: platformName(),
    summon: summonChord(),
    typing: typingInto(element),
    focusedNode: nodeUnder(element),
    dialFocused: element !== null && element.closest("[data-dial]") !== null,
    monitored: ui.monitored,
    selection: ui.selection,
  };
}

/** Whether the terminal must be refused this keystroke. xterm's seam asks. */
export function claims(event: KeyboardEvent): boolean {
  return route(event, currentState(event.target)) !== null;
}

/** What the app does when a row is claimed. Supplied once, at the one install. */
export interface Handlers {
  press(id: ActionId, state: KeyState): void;
  /** A held row's key came back up. */
  release(id: ActionId): void;
}

/** The keys any chord may be built from, so a held row ends when one lifts. */
const MODIFIER_KEYS = ["Meta", "Alt", "Control", "Shift"];

/**
 * Install the router. Once, for the app's lifetime, and nowhere else.
 *
 * Returns the disposer. A claimed chord is stopped dead — `preventDefault` so
 * the browser does nothing with it, `stopPropagation` so it never reaches
 * xterm's textarea at all — and an unclaimed one is not touched.
 */
export function install(handlers: Handlers): () => void {
  let held: Entry | null = null;

  const onKeyDown = (event: KeyboardEvent) => {
    const state = currentState(event.target);
    const entry = route(event, state);
    if (entry === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (entry.held === true) held = entry;
    handlers.press(entry.id, state);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (held === null) return;
    /*
     * Any part of the chord coming up ends the hold. Releasing the modifier
     * first is the common case, and its keyup carries `Meta` rather than the
     * chord's own key — a listener that waited for the letter would wait
     * forever.
     */
    const parts = held.chords(currentState(event.target));
    const part =
      parts.some((pressed) => pressed.key.toLowerCase() === event.key.toLowerCase()) ||
      MODIFIER_KEYS.includes(event.key);
    if (!part) return;
    const { id } = held;
    held = null;
    handlers.release(id);
  };

  // A window that lost focus is never sent the keyup. A hold's *own* release
  // paths are the holder's business — `src/panes/peek.ts` owns the peek's — and
  // all this has to do is stop waiting for a key that is not coming back up.
  const onBlur = () => {
    held = null;
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
}
