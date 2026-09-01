/**
 * Moving a live DOM node from one parent to another without unmounting it.
 *
 * **One mechanism, used twice.** A run's terminal is moved between the pane and
 * the stow by this, and the node panel's boarding pass is moved between its
 * three docks by this — the identical move for the identical reason, so the app
 * has one imperative-reparent primitive rather than two that drift.
 *
 * What the panel keeps across a move is not a screen but a reading position: a
 * scroll offset and a text selection. A remount throws away both, and a text
 * selection is the one nothing on this side could ever put back. The scroll
 * offset a move does not keep either: `appendChild` detaches the node before it
 * re-inserts it, and an engine drops the layout box the offset lives on the
 * moment the node leaves the tree. So this function moves the node and reports
 * that it moved; reading the offset back afterwards, in the same task, is the
 * caller's half — see the dock effect in `src/App.tsx`.
 *
 * Why it has to be a move rather than a remount: an xterm.js instance *is* the
 * terminal. Its scrollback, its cursor, its parser's half-finished escape
 * sequence, its alternate-screen state and its selection all live in that
 * object. Unmounting and re-creating it would throw every one of those away, and
 * the harness would have no way to put them back — it holds bytes, not screens,
 * and a replay only reaches as far as the ring does. So the node survives the
 * move, and the terminal never learns it happened.
 *
 * `appendChild` is already a move rather than a copy — the DOM removes a node
 * from its old parent implicitly — which is what makes this three lines. What
 * the function adds is the two cases around it: the same parent twice is not a
 * move, and no parent means the stow.
 */

/** Where a terminal lives when it is not on a pane. */
let stowed: HTMLElement | null = null;

/**
 * The stow: in the document, out of the way, and never removed.
 *
 * *Detached* here means detached from the pane, **not detached from the
 * document**, and the difference is xterm.js's: a terminal has to be able to
 * measure a character to know how many fit, and an element outside the document
 * has no measurements at all. A truly detached instance would report zero and
 * reflow to something absurd the moment it was shown. So the stow is a real,
 * zero-sized, hidden corner of the page.
 *
 * `visibility: hidden` rather than `display: none`, for the same reason: a
 * `display: none` subtree has no box to measure either.
 */
export function stow(): HTMLElement {
  if (stowed !== null) return stowed;

  const held = document.createElement("div");
  held.dataset.stow = "terminals";
  held.style.position = "absolute";
  held.style.width = "0";
  held.style.height = "0";
  held.style.overflow = "hidden";
  held.style.visibility = "hidden";
  held.setAttribute("aria-hidden", "true");
  document.body.appendChild(held);

  stowed = held;
  return held;
}

/**
 * Move `node` into `into`, or into the stow when there is nowhere to put it.
 *
 * Returns whether the node actually moved, which is what lets a caller tell *it
 * is already there* from *it has just arrived* without comparing parents itself.
 */
export function reparent(node: HTMLElement, into: HTMLElement | null): boolean {
  const parent = into ?? stow();
  if (node.parentElement === parent) return false;

  parent.appendChild(node);
  return true;
}

/** For tests, which need each one to start with an empty document. */
export function forgetStow(): void {
  stowed?.remove();
  stowed = null;
}
