import {
  labelOf,
  matches,
  platformName,
  readChord,
  type Chord,
  type KeyboardLike,
} from "../panes/peek";
import type { Surface } from "../stores/ui";
import { keyedRun, readUi } from "../stores/ui";

/**
 * The one key router: a single chord→action table, at the window, in the
 * capture phase, and the only place in this app a key is bound at all.
 *
 * **Why the window, and why capture.** xterm.js binds its own listeners to a
 * helper `<textarea>` inside the pane, and it takes every key that reaches it.
 * A listener anywhere below the window would therefore never fire while a run
 * has the keys, and a *bubble*-phase listener at the window only fires when xterm
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
 * **Why `Esc` has no binding of its own.** Its destination is state-dependent,
 * so any single entry for it would be a lie in some state. The only rows it
 * appears on are *dismiss* rows, each of which applies exactly while its own
 * surface is in front. Whenever the terminal holds
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
  | "dial-map"
  | "palette"
  | "palette-away"
  | "keys"
  | "keys-away";

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
  /**
   * Which run has the keys, or none — the whole of the temperature, read
   * through `keyedRun` and never assembled here.
   *
   * Separate from `monitored` because they answer different questions: that one
   * is *what am I watching*, this one is *where does what I type go*. They are
   * joined most of the time and the store is what joins them — a warm run is by
   * construction the monitored one — so a reader of this field never has to
   * check the pair for agreement.
   */
  warm: number | null;
  /** Which node is selected, so a second press on it puts it back. */
  selection: number | null;
  /**
   * What stands in front of the terminal, straight off the store.
   *
   * The one reading of it there is. A dismiss row's `when` is this field and
   * nothing else, which is what makes [`escDestination`] a lookup over the same
   * table the press goes through rather than a second opinion about what is on
   * screen.
   */
  inFront: Surface | null;
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
 * The palette's chord: `⌘K` on macOS, `Alt+K` everywhere else.
 *
 * The same per-platform shape as the crossing and the peek, for the same
 * reason: `⌘` never reaches the shell, and elsewhere `Alt` is the one modifier
 * no shell reads as a control character. That rules out the whole `Ctrl`+letter
 * row on its own — `Ctrl+K` is kill-line, `Ctrl+R` is reverse-i-search and
 * `Ctrl+G` is `BEL` — so a lone `Ctrl`+letter is never a candidate here.
 *
 * `K` and not one of the letters already spent: `E` crosses, `G` summons the
 * peek and the peek's rebind alternates are ⌥G, ⇧⌘G, Ctrl+Alt+G and Alt+Shift+G
 * (`src/panes/peek.ts`), all of them on `G`. Nothing else in the table carries a
 * modifier at all — `Ctrl+0` is home, and `Enter`, `Space` and the six dial keys
 * are bare — so this chord cannot collide with a row in any state where both
 * apply.
 */
function commanding(os: string): Chord {
  return isMac(os) ? chord("k", { meta: true }) : chord("k", { alt: true });
}

/**
 * The keys page's chord: `⌘/` on macOS, `Alt+/` everywhere else.
 *
 * The per-platform shape is not a choice, it is the same constraint the
 * crossing, the peek and the palette are all built on: `⌘` never reaches the
 * shell, and off macOS `Alt` is the one modifier no shell reads as a control
 * character. The whole `Ctrl`+letter row is out for the reason written above
 * `commanding` — `Ctrl+K` kill-line, `Ctrl+R` reverse-i-search, `Ctrl+G` `BEL`.
 *
 * `/` and not another letter, for two reasons. The letters are spent: `E`
 * crosses, `K` is the palette, and `G` is the peek together with every one of
 * its rebind alternates (`src/panes/peek.ts`). And `/` is what a keyboard
 * reaches for when it wants to be told about the keyboard — it is the help key
 * of nearly every application an operator already has open, via its shifted
 * form `?`. `?` itself cannot be the binding: unmodified it is a character, and
 * a character is the agent's, typed into the run underneath. So the modifier
 * this app already uses carries it, and the chord asks for no `Shift` — `⌘?`
 * would be a third key in the hand for a page that is only being read.
 *
 * Nothing else in the table is punctuation at all: `Ctrl+0` is home, the six
 * dial keys and `Enter`/`Space` are bare, and every modified row is on a
 * letter. So this collides with no row in any state where both apply, and
 * `tests/keys.test.ts` says so row by row rather than taking it on trust.
 */
function consulting(os: string): Chord {
  return isMac(os) ? chord("/", { meta: true }) : chord("/", { alt: true });
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
   *
   * `inFront === null` in every one of them, for ADR 0025's invariant: while a
   * surface stands in front it is the only thing the keyboard may act on, so
   * that *the CLI is not being typed at* stays a fact about the table rather
   * than a hope about where the focus happens to be. A dial nudged from behind
   * a page is the harmless end of the same hole `cross` opened at the other.
   */
  {
    id: "dial-wider",
    chords: () => [chord("ArrowRight")],
    verb: "give the map a little more of the window",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "dial-narrower",
    chords: () => [chord("ArrowLeft")],
    verb: "give the terminal a little more of the window",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "dial-next-detent",
    chords: () => [chord("PageUp")],
    verb: "go to the next detent toward the map",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "dial-previous-detent",
    chords: () => [chord("PageDown")],
    verb: "go to the next detent toward the terminal",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "dial-terminal",
    chords: () => [chord("Home")],
    verb: "give the whole window to the terminal",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "dial-map",
    chords: () => [chord("End")],
    verb: "give the whole window to the map",
    when: (state) => state.dialFocused && state.inFront === null,
  },
  {
    id: "palette",
    chords: (state) => [commanding(state.os)],
    verb: "open the command palette: everything this window binds, in one list",
    // Only with nothing in front. The palette is what stands there, so a chord
    // that raised it over itself would be raising a second answer to *what has
    // the keys* — and the surfaces are one field with one value precisely so
    // that cannot happen.
    when: (state) => state.inFront === null,
  },
  {
    id: "palette-away",
    chords: () => [chord("Escape")],
    verb: "put the command palette away",
    when: (state) => state.inFront === "palette",
    /* The first real user of the mechanism `escDestination` was built on: this
       row is what the readout finds and prints, so the sentence beside the
       terminal and the key that acts are one lookup apart. One dismiss row per
       surface, never one row with a state-dependent `dismisses` — the readout
       stays a lookup rather than a computation of its own. */
    dismisses: "the command palette",
  },
  {
    id: "keys",
    chords: (state) => [consulting(state.os)],
    verb: "open the keys page: the whole keyboard, at full window, to read",
    // The palette's predicate, for the palette's reason: `inFront` is one field
    // with one value, so no surface may be raised over another.
    when: (state) => state.inFront === null,
  },
  {
    id: "keys-away",
    chords: () => [chord("Escape")],
    verb: "put the keys page away",
    when: (state) => state.inFront === "keys",
    /* A dismiss row of its own rather than a `dismisses` that reads the state:
       one row per surface is what keeps `escDestination` a lookup over this
       table instead of a second computation of what is on screen — and it is
       this row, not a line in `EscReadout.tsx`, that makes the sentence beside
       the terminal name the keys page. */
    dismisses: "the keys page",
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
      /*
       * A bare key in a field is the field's. Nothing in this table may take an
       * unmodified keystroke out from under something being typed into —
       * xterm's helper textarea included, which is how ordinary typing stays
       * ordinary.
       *
       * `Escape` is the one exemption, and it has to be: a surface in front of
       * the terminal is a surface with a filter field in it, so the guard would
       * make `Esc` un-dismissable from the very control the palette focuses on
       * opening. It is safe because no field types an `Escape` *character* —
       * the key edits nothing and inserts nothing — and it cannot take `Esc`
       * from a warm terminal, because every row written with `Escape` requires
       * a surface in front. With nothing in front no such row applies, `route`
       * answers null, [`claims`] is false, and xterm is handed the key.
       */
      if (state.typing && bare(pressed) && pressed.key !== "Escape") continue;
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
  /*
   * `warm` and not `monitored`, because those two came apart in #57 and the old
   * reading is now a lie in a state the operator can reach in one press:
   * watching a run without typing at it. `Esc` is only the CLI's while the CLI
   * has the keys — a cold run is on screen and is not being typed at, so the
   * key reaches nothing at all, and saying *the agent CLI* there would promise
   * an interrupt that never arrives.
   */
  if (state.warm !== null) return "reaches the agent CLI";
  if (state.monitored !== null) return "reaches nothing — the keys are on the map";
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

/**
 * The route row under the keyboard, resolved by the row's own hook.
 *
 * `data-node-row` and not `data-node`: the latter means *this element is about
 * node N*, and other things wear it — the change ledger draws each reference as
 * a `<button data-node={n}>` whose activation *sets* the selection. This
 * listener is at the window in the capture phase, so claiming `Enter` there
 * would suppress that button's own activation and run the `open` row's
 * *toggle* instead, leaving the keyboard and the mouse disagreeing about one
 * control. Only a view's pickable rows — The Route's rows and Deep Field's
 * plates — carry `data-node-row`, so only they are openable from here.
 */
function nodeUnder(element: Element | null): number | null {
  const row = element?.closest("[data-node-row]") ?? null;
  if (row === null) return null;
  const number = Number(row.getAttribute("data-node-row"));
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
    warm: keyedRun(ui),
    selection: ui.selection,
    inFront: ui.inFront,
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
