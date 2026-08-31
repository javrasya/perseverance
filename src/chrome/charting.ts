/**
 * The WebView's view of Start Charting.
 *
 * The same seam as `started.ts`, over the same answer: `start_charting` returns
 * the app crate's `Started`, so the shape is declared once and imported here
 * rather than spelled a second time. **Hand-written, not generated** — the
 * generator covers the model crate — so a rename in `crates/app/src/lib.rs` is
 * a silent breakage on this side.
 *
 * **A charting run has no ticket.** It carries an idea instead: prose the
 * operator typed, which Rust renders into the opening prompt and answers back.
 * And it names no map, because the whole point of the press is that the folder
 * has none — which is why a refusal from here never carries a frontier.
 */

import type { Started } from "./started";
import { NO_HARNESS } from "./started";
import { hasRustBehindIt } from "../snapshot/snapshot";

/**
 * Press Start Charting, once.
 *
 * The adapter is an argument for the same reason it is one on `startWorking`:
 * which agent to start is a fact about *this press*, resolved against this
 * folder's readout, and never a setting read here or written anywhere.
 *
 * A browser with no Rust behind it refuses and never fakes a spawn: there is no
 * PTY behind that window, so a run number invented here would be a terminal
 * that can never have bytes.
 */
export async function startCharting(
  folder: string,
  idea: string,
  adapter: string,
): Promise<Started> {
  if (!hasRustBehindIt()) {
    return { kind: "refused", detail: NO_HARNESS, frontier: null };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Started>("start_charting", { folder, idea, adapter });
}
