/**
 * The three addresses the node panel can be at, and which one it is really at.
 *
 * The panel is a **boarding pass**: one element, rendered once, moved between
 * docks by `src/terminal/reparent.ts` rather than unmounted and rebuilt. That
 * makes *where it is* a question worth answering somewhere pure — this file has
 * no DOM, no React and no pixels of its own beyond the one floor below, so every
 * claim the shell makes about which dock holds the pass is checkable without
 * mounting anything. Same division as `src/panes/dial.ts`, and for the same
 * reason.
 *
 * Two rules are encoded here rather than left to the component:
 *
 * - **A dock is a press, never an arrival.** [`effectiveDock`] is the *only*
 *   thing that ever overrides the chosen dock, it does so for one measurable
 *   reason, and the choice it overrides is kept — so widening the dial springs
 *   the pass back to where the operator put it.
 * - **Nothing about it is silent.** Every dock that is not holding the pass has
 *   a sentence to print ([`dockedElsewhere`]), and a dock holding a pass it
 *   borrowed says so ([`borrowedBecause`]). A blank rectangle is exactly what
 *   the panel's five never-empty states exist to forbid, and a dock is not
 *   exempt from that because it is chrome.
 */

/** Where the pass can be. `spine` is the one no dial position can collapse. */
export type Dock = "spine" | "runBar" | "rack";

export const DOCKS: readonly Dock[] = ["spine", "runBar", "rack"];

/** Where the pass is before anyone has moved it. */
export const DEFAULT_DOCK: Dock = "spine";

/** Each dock, as the operator would name it in a sentence. */
export const DOCK_NAMES: Record<Dock, string> = {
  spine: "the spine",
  runBar: "the run bar",
  rack: "the rack",
};

/** The press that takes the pass, on the dock that does not have it. */
export const DOCK_PRESSES: Record<Dock, string> = {
  spine: "Dock on the spine",
  runBar: "Dock in the run bar",
  rack: "Dock on the rack",
};

/**
 * The two docks that ride on the terminal side of the dial, and are therefore
 * worth no pixels at the `map` detent.
 *
 * The spine dock is not one of them: it is drawn below the body the dial
 * divides, so no position of the dial can take its width away.
 */
export function onTerminalSide(dock: Dock): boolean {
  return dock !== "spine";
}

/**
 * How wide the terminal side has to be before a dock on it can hold the panel.
 *
 * The panel's own two columns and nothing else: a `5.5rem` name column beside a
 * value column that stops flexing at `12rem` (`src/detail/Detail.module.css`).
 * Below that the fields wrap into a ribbon nobody can read, and at the `map`
 * detent the number is zero — the terminal side clips its own overflow, so a
 * pass docked there would not be narrow, it would be *invisible with no
 * explanation*, which is the blank rectangle this whole panel exists to forbid.
 */
export const TERMINAL_DOCK_FLOOR = 280;

/**
 * Which dock actually holds the pass, given the one that was chosen.
 *
 * The chosen dock whenever it can be seen, and the spine otherwise. The choice
 * itself is *not* rewritten — it stays in the store, and this is re-evaluated on
 * every width — so a dial move that collapses the terminal side borrows the pass
 * and a dial move that gives it back returns it, exactly the way the peek
 * borrows the dial's position without writing it (`src/panes/peek.ts`).
 */
export function effectiveDock(chosen: Dock, terminalWidth: number): Dock {
  if (!onTerminalSide(chosen)) return chosen;
  return terminalWidth >= TERMINAL_DOCK_FLOOR ? chosen : "spine";
}

/** What a dock without the pass says. Never silence, never a blank box. */
export function dockedElsewhere(occupant: Dock): string {
  return `The node panel is docked at ${DOCK_NAMES[occupant]}.`;
}

/**
 * Why a dock is holding a pass that was not sent to it, or `null` when it was.
 *
 * The sentence names the dock the operator chose and the one move that undoes
 * the borrowing, because a pass that moved on its own with nothing said is a
 * pass the operator will assume they lost.
 */
export function borrowedBecause(chosen: Dock, holding: Dock): string | null {
  if (chosen === holding) return null;
  return `The panel is here because ${DOCK_NAMES[chosen]} has no width at this dial position. Widen the terminal side and it goes back.`;
}
