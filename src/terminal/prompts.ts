/**
 * What each run was actually started with, kept per run for as long as the
 * window is open.
 *
 * A spawn answers with the rendered prompt exactly once — it is the only time
 * this side is ever told the text, because nothing on the Rust side stores it
 * for a second reader. Dropping it on the floor would mean a run under custom
 * prose is indistinguishable from a run under ours for the rest of the process,
 * which is precisely the diagnosis `Origin` exists to make possible.
 *
 * A plain module-level map, deliberately: it is per-window state with no
 * subscribers, nothing polls it, and nothing renders it in this slice — the
 * terminal prints it in #48's next one.
 */

import type { Rendered } from "../chrome/started";

const rendered = new Map<number, Rendered>();

/** The prompt this run was started with, from the one answer that carried it. */
export function recordPrompt(run: number, prompt: Rendered): void {
  rendered.set(run, prompt);
}

/** What run was started with, or `null` for a run this window did not start. */
export function promptFor(run: number): Rendered | null {
  return rendered.get(run) ?? null;
}

/** For tests, which are the only caller with a reason to have no memory. */
export function forgetPrompts(): void {
  rendered.clear();
}
