import { clamp, fractionOf, sides } from "./dial";

/**
 * The spring-loaded glance: what holds it, what lets it go, and what it is worth.
 *
 * A peek **borrows the dial rather than drawing a map of its own**. Hold the
 * chord and the map side is promoted over the terminal at full map width — the
 * same DOM, the same view instance, the same model — and release springs it
 * back. Nothing here writes the remembered position, and nothing here resizes a
 * PTY: a glance may not rearrange the room it is a glance at.
 *
 * The reason it is the real view and not a purpose-built glance plate: at map
 * width **no view stands down**, so a peek is the *biggest* map the window can
 * give, and a resolved ticket recedes in salience rather than in visibility. A
 * plate would win the first 700 ms and lose every second after — it would be a
 * second rendering of the map, drifting from the first the moment either
 * changed.
 *
 * Everything in this file is arithmetic and policy over an event sequence, so
 * the release paths — the ones a real window only reproduces by losing focus at
 * the wrong moment — are assertable without a window at all.
 */

/** What is holding the spring down. */
export type PeekSource = "chord" | "stud";

/**
 * Why the spring came back up.
 *
 * `keyup` and `pointerup` are the operator letting go. **Every other member is
 * the named defect**: a hold whose release event never arrives. A window that
 * loses focus mid-hold is never sent the `keyup`, and a peek left open over a
 * terminal that is still taking keystrokes is a screen the operator is typing
 * underneath. So each of these is a release in its own right.
 */
export type Release =
  | "keyup"
  | "pointerup"
  | "blur"
  | "hidden"
  | "repeat-gap"
  | "pointercancel"
  | "pointerleave";

/** What the shell draws, and the whole of what a peek is. */
export interface Peek {
  /** What is holding the spring, or nothing. */
  held: PeekSource | null;
  /**
   * The chord reached this app and did not reach the shell underneath.
   *
   * Drawn, because a key that vanishes without a mark is a key the operator
   * will assume their agent received.
   */
  swallowed: boolean;
  /** Why this hold gave nothing, in words, or `null` when it gave a peek. */
  refused: string | null;
  /** When the last chord keydown arrived, which is what the repeat gap watches. */
  beat: number;
  /** Why the spring last came up. Kept for the readout and for the tests. */
  released: Release | null;
}

export const RESTING: Peek = {
  held: null,
  swallowed: false,
  refused: null,
  beat: 0,
  released: null,
};

/**
 * What can happen to a spring.
 *
 * `position` rides on the two press events because inertness is a property of
 * where the dial already is, and this module — not a component — is what says
 * so. `at` is a clock reading rather than a `Date`, so a test can hold the
 * clock still.
 */
export type PeekEvent =
  | { kind: "chord"; at: number; position: number }
  | { kind: "chord-up" }
  | { kind: "stud"; position: number }
  | { kind: "stud-up" }
  | { kind: "pointercancel" }
  | { kind: "pointerleave" }
  | { kind: "blur" }
  | { kind: "hidden" }
  | { kind: "beat"; at: number };

/**
 * How long a silence between auto-repeat keydowns means the key is no longer
 * down.
 *
 * A held key repeats: the OS sends an initial keydown, waits its *delay*, then
 * sends more at its *rate*. The slowest settings in real use are macOS's
 * two-second "Delay Until Repeat" and a rate of about two a second; Windows's
 * slowest delay is one second. 2500 ms is past the slowest of those and still
 * far short of a glance anyone means to hold, so a spring that has stopped
 * hearing from the key for this long has lost the keyup rather than the key.
 *
 * The accepted cost: a machine with key repeat switched off entirely sends one
 * keydown and no more, so a peek held longer than this springs back on its own.
 * That is the safe direction to be wrong in — a peek that returns is a glance,
 * and a peek that sticks is a screen with keystrokes going somewhere invisible.
 */
export const REPEAT_GAP = 2500;

/** What a hold at map width is told, out loud, rather than being ignored. */
export const NOTHING_TO_GIVE =
  "the dial is already at map width — a peek has nothing to give";

/** Whether a peek from this position would show anything the dial does not. */
export function available(position: number): boolean {
  return clamp(position) < fractionOf("map");
}

/**
 * What the spring does next.
 *
 * Returning the argument unchanged is how a release that is not a release —
 * a blur with nothing held, a beat that arrived in time — notifies nobody.
 */
export function advance(state: Peek, event: PeekEvent, gap: number = REPEAT_GAP): Peek {
  switch (event.kind) {
    case "chord": {
      const gives = available(event.position);
      return {
        held: gives ? "chord" : null,
        // Swallowed either way: the app claimed the chord even when it had
        // nothing to show for it, and that is exactly the case the operator
        // most needs the mark for.
        swallowed: true,
        refused: gives ? null : NOTHING_TO_GIVE,
        beat: event.at,
        released: null,
      };
    }
    case "stud": {
      const gives = available(event.position);
      return {
        held: gives ? "stud" : null,
        swallowed: false,
        refused: gives ? null : NOTHING_TO_GIVE,
        beat: state.beat,
        released: null,
      };
    }
    case "chord-up":
      return release(state, "keyup");
    case "stud-up":
      return state.held === "stud" ? release(state, "pointerup") : state;
    case "pointercancel":
      return state.held === "stud" ? release(state, "pointercancel") : state;
    case "pointerleave":
      return state.held === "stud" ? release(state, "pointerleave") : state;
    // A blur takes everything down, including a stud whose pointerup is about
    // to be delivered to a window that is no longer in front.
    case "blur":
      return release(state, "blur");
    case "hidden":
      return release(state, "hidden");
    case "beat":
      if (state.held !== "chord") return state;
      return event.at - state.beat >= gap ? release(state, "repeat-gap") : state;
  }
}

function release(state: Peek, why: Release): Peek {
  if (state.held === null && !state.swallowed && state.refused === null) return state;
  return { ...RESTING, released: why };
}

/**
 * How wide the promoted map side is: the map side at the `map` detent, which is
 * the body less the dial's own column.
 *
 * The full map width and not a width of its own, because *no view stands down*
 * is the whole argument for peeking at the real view; a glance a few pixels
 * narrower than the detent could stand a view down that the detent would draw.
 */
export function peekWidth(bodyWidth: number, reach: number): number {
  return sides(fractionOf("map"), bodyWidth, reach).map;
}

/**
 * How many terminal rows the peek stops short of.
 *
 * The cursor sits at the bottom of xterm's box, and an operator who cannot see
 * the row they are typing into is typing blind. Two rows rather than one: the
 * bottom row is often a soft-wrapped continuation of the line being typed, and
 * clearing only the cursor's own row would hide the start of the operator's own
 * sentence.
 */
export const CLEARED_ROWS = 2;

/**
 * A terminal row, in pixels, at the app's mono size.
 *
 * The pane does not publish its cell height — xterm measures it inside a box
 * this module has no access to — and measuring it here would mean a second
 * observer on a box the pane already owns. Overshooting clears more of the
 * cursor's row than needed; undershooting hides it, so the constant errs high.
 */
export const ROW_HEIGHT = 20;

/**
 * The prompt block, in rows.
 *
 * When one is drawn it is the sentence the run was started with, and the pane
 * has that much less room for the terminal. The reserve grows by its height so
 * the same number of terminal rows stays uncovered.
 */
export const PROMPT_ROWS = 2;

/** How far above the bottom of the body the peek stops, in pixels. */
export function clearance(promptShown: boolean): number {
  return (CLEARED_ROWS + (promptShown ? PROMPT_ROWS : 0)) * ROW_HEIGHT;
}

/**
 * A chord, as the one key router of #53 will eventually want it.
 *
 * Modifiers are declared in full rather than as "whatever was down", so a chord
 * cannot be matched by a keystroke that carried an extra modifier the operator
 * meant for something else.
 */
export interface Chord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * The summon chord, per platform, and the one place the asymmetry is written.
 *
 * `⌘G` is the macOS answer and has no Windows equivalent: `Ctrl+G` is `BEL` in
 * every shell, and a key that rings the terminal bell may not be claimed by a
 * glance. `Alt+G` is the answer everywhere else — a modifier no shell reads as
 * a control character.
 *
 * A pure function of a platform string, so the table is testable without a
 * `navigator` and without an OS plugin: what platform this is, is one call to
 * [`platformName`] and nothing else in the app asks.
 */
export function chordFor(os: string): Chord {
  const mac = isMac(os);
  return {
    key: "g",
    meta: mac,
    ctrl: false,
    alt: !mac,
    shift: false,
  };
}

/**
 * The chords an operator may bind the peek to, this platform's answer first.
 *
 * A short offered list rather than *press the keys you want*, because capturing
 * a keystroke means a second key listener, and #53 is the ticket that gets to
 * own key listening. Every member carries a modifier the shell underneath does
 * not read as a control character — **no lone `Ctrl` letter is offered**, since
 * `Ctrl+G` is `BEL` and its neighbours are as spoken for.
 */
export function chordChoices(os: string): readonly Chord[] {
  const base = chordFor(os);
  const alternates: Chord[] = isMac(os)
    ? [
        { key: "g", meta: false, ctrl: false, alt: true, shift: false },
        { key: "g", meta: true, ctrl: false, alt: false, shift: true },
      ]
    : [
        { key: "g", meta: false, ctrl: true, alt: true, shift: false },
        { key: "g", meta: false, ctrl: false, alt: true, shift: true },
      ];
  return [base, ...alternates];
}

function isMac(os: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(os);
}

/** What a chord is called on screen. Symbols on macOS, words elsewhere. */
export function labelOf(chord: Chord, os: string): string {
  const mac = isMac(os);
  const parts: string[] = [];
  if (chord.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  if (chord.shift) parts.push(mac ? "⇧" : "Shift");
  if (chord.meta) parts.push(mac ? "⌘" : "Win");
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join(mac ? "" : "+");
}

/** The part of a keyboard event this module reads, so a test can hand it one. */
export interface KeyboardLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Whether this keystroke is that chord, modifiers and all. */
export function matches(chord: Chord, event: KeyboardLike): boolean {
  return (
    event.key.toLowerCase() === chord.key.toLowerCase() &&
    event.metaKey === chord.meta &&
    event.ctrlKey === chord.ctrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift
  );
}

/**
 * Which platform this is, behind one function.
 *
 * `navigator` and nothing else: a Tauri OS plugin and a Rust command are both
 * round trips for a string the WebView already has, and both would make *which
 * chord summons the peek* a question this side cannot answer while a command is
 * in flight.
 */
export function platformName(): string {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  if (nav === undefined) return "";
  return nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
}

const STORAGE_KEY = "perseverance.peek.chord";

/*
 * The format is this file's business and nobody else's — the same two-function
 * seam `src/views/views.ts` keeps around the default view. When the `app` table
 * in `crates/store` gets a command, `readChord`/`writeChord` change and no
 * caller does.
 */
function parse(text: string | null): Chord | null {
  if (text === null) return null;
  const parts = text.split("+").filter((part) => part.length > 0);
  const key = parts.pop();
  if (key === undefined) return null;
  const has = (name: string) => parts.includes(name);
  const chord: Chord = {
    key,
    meta: has("meta"),
    ctrl: has("ctrl"),
    alt: has("alt"),
    shift: has("shift"),
  };
  // A bare letter is a key the terminal underneath is entitled to. A chord with
  // no modifier at all would swallow it forever, so it is not a chord.
  if (!chord.meta && !chord.ctrl && !chord.alt) return null;
  return chord;
}

function format(chord: Chord): string {
  const parts: string[] = [];
  if (chord.meta) parts.push("meta");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key.toLowerCase());
  return parts.join("+");
}

/** The bound chord: the operator's, if they set one, else this platform's. */
export function readChord(os: string = platformName()): Chord {
  try {
    const stored = parse(window.localStorage.getItem(STORAGE_KEY));
    if (stored !== null) return stored;
  } catch {
    // Storage denied still gets a working peek; it just opens on the platform
    // default every launch.
  }
  return chordFor(os);
}

/** Bind a different chord, for good. `null` goes back to the platform's. */
export function writeChord(chord: Chord | null): void {
  try {
    if (chord === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, format(chord));
  } catch {
    // Same as above: the rebind lasts the session rather than forever.
  }
}
