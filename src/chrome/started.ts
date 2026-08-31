/**
 * The WebView's view of Start Working and of Resume.
 *
 * These types mirror the app crate's `Started` and `prompt::Rendered` exactly,
 * for the same reason `maps.ts` mirrors `MapsView` and `snapshot.ts` mirrors
 * `Snapshot`: one seam rather than two. **They are hand-written, not
 * generated** — the generator covers the model crate, and this shape belongs to
 * the command — so a rename on the Rust side is a silent breakage here, and
 * `what_start_working_answers_crosses_in_the_shape_the_frontend_declares` in
 * `crates/app/src/lib.rs` is the assertion that catches it there.
 *
 * **One command, and it awaits the check itself.** The revalidation, the
 * comparison against the frontier, the render, the spawn and the three writes
 * that follow it are all inside `start_working` — see `docs/adr/0020`. There is
 * nothing for this side to sequence: it presses once and reads one answer.
 *
 * **Two commands, one crossing.** `resume_working` is `start_working` with one
 * guard swapped — a node reading `Claimed` where the other wants the designated
 * frontier — and it answers in the same shape off the same template. So this
 * file has two exported verbs over one private press, and neither of them puts a
 * word about the verb on the wire: see `docs/adr/0023`.
 */

import type { Frontier } from "../snapshot/model.generated";
import { hasRustBehindIt } from "../snapshot/snapshot";

/** Whether the prompt came from our prose or the operator's. */
export type Origin = "stock" | "custom";

/** A rendered prompt, with the two facts printed beside it. */
export interface Rendered {
  text: string;
  /** Characters and not bytes: the prose is full of em dashes. */
  characters: number;
  origin: Origin;
}

/**
 * What a press comes back with.
 *
 * `frontier` on a refusal is `null` when **no fresh read landed** — a different
 * fact from *what next has changed*, and one that names no new target. What the
 * socket does with the difference is `sockets.ts`'s.
 */
export type Started =
  | { kind: "spawned"; run: number; prompt: Rendered }
  | { kind: "refused"; detail: string; frontier: Frontier | null };

/**
 * What a press answers in a browser with no Rust behind it.
 *
 * A refusal and never a fake spawn: there is no PTY behind this window, so a
 * run number invented here would be a terminal that can never have bytes.
 */
export const NO_HARNESS = "there is no harness behind this window, so nothing was started";

/**
 * A press, on either verb.
 *
 * **The payload is three values and the command name is the only difference.**
 * No verb flag, no template name, no origin marker: the prompt a resumed session
 * is handed has to be byte-identical to the one a started session is handed, and
 * the cheapest way to keep that true is to have nothing to strip. The command
 * name never reaches the render — it picks a guard and stops there.
 */
async function press(
  command: "start_working" | "resume_working",
  folder: string,
  ticket: number,
  adapter: string,
): Promise<Started> {
  if (!hasRustBehindIt()) {
    return { kind: "refused", detail: NO_HARNESS, frontier: null };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Started>(command, { folder, ticket, adapter });
}

/**
 * Press Start Working, once.
 *
 * The adapter is an argument because the crossing owns the picker: which agent
 * to start is a fact about *this press*, resolved against this folder, and
 * never a global setting read here or written anywhere.
 */
export async function startWorking(
  folder: string,
  ticket: number,
  adapter: string,
): Promise<Started> {
  return await press("start_working", folder, ticket, adapter);
}

/**
 * Press Resume, once, on a claim the operator already holds.
 *
 * The same three values as a start, for the same reason and with the same
 * picker behind the adapter. What makes it a resume is which guard Rust runs,
 * and nothing that crosses from here.
 */
export async function resumeWorking(
  folder: string,
  ticket: number,
  adapter: string,
): Promise<Started> {
  return await press("resume_working", folder, ticket, adapter);
}

/**
 * What a Compose press comes back with.
 *
 * A second, smaller type beside [`Started`] and not a field on it, mirroring
 * the app crate's `Composed` — including the field it does not have. A compose
 * press has no frontier: it is aimed at the map, so there is no number for a
 * refusal to re-arm on and no null here for this side to read as one. The Rust
 * assertion that pins the shape, field count included, is
 * `what_compose_spec_answers_crosses_in_the_shape_the_frontend_declares`.
 *
 * **And no claim.** The claim is the harness's record of the ticket it handed
 * out, and a compose run takes no ticket — so nothing is written down for this
 * press to be told about, and nothing here asks.
 */
export type Composed =
  | { kind: "spawned"; run: number; prompt: Rendered }
  | { kind: "refused"; detail: string };

/**
 * Press Compose Spec, once.
 *
 * The map is not an argument: which map is open is the ledger's answer and the
 * command re-reads it, so a number sent from here could only ever disagree with
 * it. The folder and the adapter are, for `startWorking`'s reason — both are
 * facts about *this press*.
 */
export async function composeSpec(folder: string, adapter: string): Promise<Composed> {
  if (!hasRustBehindIt()) {
    return { kind: "refused", detail: NO_HARNESS };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Composed>("compose_spec", { folder, adapter });
}

/**
 * What an Ask press comes back with.
 *
 * `Composed`'s shape and hand-mirrored the same way, including the field it
 * does not have: an Ask press is aimed at the node the operator selected, so
 * there is no frontier for a refusal to re-arm on and no null here for this
 * side to read as one. The Rust assertion that pins the shape, field count
 * included, is `what_ask_answers_crosses_in_the_shape_the_frontend_declares`.
 *
 * **And nothing about a claim.** An Ask run takes none — it may not comment,
 * close, edit, label, assign or claim — so there is nothing written down for
 * this press to be told about.
 */
export type Asked =
  | { kind: "spawned"; run: number; prompt: Rendered }
  | { kind: "refused"; detail: string };

/**
 * Press Ask, once, on one node of the open map.
 *
 * The node is an argument where the map is not: which map is open is the
 * ledger's answer, but which node the question is about is the selection, and
 * that is a fact about *this press*. So is the adapter, for `startWorking`'s
 * reason.
 *
 * The question itself is not an argument and never becomes one: the operator
 * types it into the live session, which is the whole of what makes this run
 * human-in-the-loop.
 */
export async function ask(folder: string, node: number, adapter: string): Promise<Asked> {
  if (!hasRustBehindIt()) {
    return { kind: "refused", detail: NO_HARNESS };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Asked>("ask", { folder, node, adapter });
}
