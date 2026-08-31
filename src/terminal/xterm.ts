import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { claims } from "../keys/router";
import type { Geometry } from "../stores/ui";
import type { Factory, Terminal } from "./terminals";

/**
 * The one place xterm.js is named.
 *
 * Everything else in this directory holds a [`Terminal`], which is four methods
 * and a node. That is what lets *one instance per run, moved and never
 * remounted* be asserted without a canvas, a font stack and a layout engine
 * standing in the way of the assertion.
 *
 * The stylesheet is imported here rather than in a component, because it belongs
 * to the emulator and not to any view: a pane that rendered no terminal would
 * still be a pane, and a terminal rendered anywhere needs these rules.
 */
import "@xterm/xterm/css/xterm.css";

/**
 * A terminal that answers cursor queries itself, and is answered anyway.
 *
 * `windowsPty` is not set: the harness owns the pseudoconsole and this side sees
 * a byte stream, so telling xterm.js which backend produced it would be telling
 * it something it has no use for. The cursor-position query ConPTY insists on is
 * answered in `crates/pty` — in the plumbing, where a run that nobody is
 * monitoring gets it too.
 */
const OPTIONS = {
  // The scrollback the *terminal* keeps, which is a different bound from the
  // ring's: the ring exists so a WebView can be caught up, this exists so an
  // operator can scroll. Neither is derived from the other.
  scrollback: 10_000,
  convertEol: false,
  allowProposedApi: false,
  // The harness is what says what the caret is doing (#50). A blink here would
  // be this side inventing liveness the run has not demonstrated.
  cursorBlink: false,
  // One family for every terminal, resolved from the theme's own token so a
  // retheme reaches the pane like it reaches everything else.
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
} as const;

/**
 * The shipped factory.
 *
 * Each terminal gets its own element, opened immediately so it has a box to
 * measure from the moment it exists. Where that element *is* is
 * `Terminals`'s — it starts in the stow and is moved to the pane when bound —
 * and this file has no opinion about it.
 */
export const xterm: Factory = (geometry: Geometry): Terminal => {
  const element = document.createElement("div");
  element.className = "terminalHost";
  element.style.width = "100%";
  element.style.height = "100%";

  const terminal = new Xterm({ ...OPTIONS, rows: geometry.rows, cols: geometry.cols });
  /*
   * The router's half of the seam, and the only place in this app xterm's key
   * handling is touched.
   *
   * Returning `false` is what stops a keystroke being encoded and sent to the
   * PTY, and it is returned for **claimed chords only** — the same
   * `route(event, state)` the window listener asks, so the key the terminal is
   * refused is by construction the key the app took. Everything else returns
   * `true` and goes to the run untouched, `Esc` first among them: it is the
   * interrupt of every agent CLI and this app never claims it.
   *
   * Mostly this handler never sees a claimed chord at all — the capture-phase
   * listener at the window calls `stopPropagation` long before the helper
   * textarea hears anything. It is here so that the refusal is a property of
   * the terminal rather than of the listener being installed: a terminal opened
   * with no router at the window still does not eat a chord the app owns.
   */
  terminal.attachCustomKeyEventHandler((event) => event.type !== "keydown" || !claims(event));
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);

  return {
    element,
    write: (bytes) => terminal.write(bytes),
    reset: () => terminal.reset(),
    resize: ({ rows, cols }) => terminal.resize(cols, rows),
    /*
     * The fit addon proposes; it is never asked to `fit()`.
     *
     * `fit()` would resize the terminal itself, on the spot, from whatever box
     * it happens to be in — which is a resize on arrival, on bind and on every
     * frame of a drag, which is the whole of what this slice forbids. So the
     * proposal is read and the decision is made in `src/panes/geometry.ts`,
     * where the occasion is known.
     */
    measure: () => {
      const proposed = fit.proposeDimensions();
      if (proposed === undefined) return null;
      if (!Number.isFinite(proposed.rows) || !Number.isFinite(proposed.cols)) return null;
      return { rows: proposed.rows, cols: proposed.cols };
    },
    onData: (handler) => {
      const listening = terminal.onData(handler);
      return () => listening.dispose();
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
};
