/**
 * The WebView's view of the seam.
 *
 * The types are **generated** from `perseverance-model`'s Rust — see
 * `model.generated.ts`, which nobody edits — rather than mirrored by hand. Every
 * other seam in this app is a hand-written mirror pinned from both sides by a
 * pair of tests; this one cannot drift, because a field added in Rust and not
 * propagated here is a failing `cargo test` and then a failing `tsc`.
 *
 * What crosses is **already derived**. The four node states, the three child
 * categories, the counts, the phase ladder and the designated frontier are all
 * decided in Rust, and the two fields those states are decided from — the count
 * of open blockers, and who holds a ticket — do not cross at all. So a second
 * frontier resolver here is not forbidden by a convention: there is nothing on
 * this side to write one from. `tests/snapshot.test.ts` keeps it that way by
 * refusing either field the run of this directory.
 *
 * `dev:web` is the other half of the same seam: the snapshot type is
 * constructible from a JSON file as easily as from GitHub, so the whole
 * frontend boots from a checked-in fixture with no Rust process, no GitHub and
 * no PTY behind it.
 */

import { fixtureNamed, requestedFixture } from "./fixtures";
import type { Snapshot } from "./model.generated";

export type {
  ChildKind,
  Clause,
  ClauseKind,
  Counts,
  Degraded,
  Entry,
  Ledger,
  Map,
  Model,
  Node,
  NodeState,
  Occasion,
  Phase,
  Provenance,
  ReadOutcome,
  Since,
  Snapshot,
  Source,
  TicketType,
} from "./model.generated";

/**
 * Two, since the ledger joined the wire. It rides on the snapshot **beside**
 * the model rather than inside it, which is what puts it outside the type every
 * view is handed — so *no view renders the ledger* is structural here rather
 * than a rule anybody has to keep.
 */
export const SCHEMA_VERSION = 2;

/**
 * True when the app is running inside the Tauri shell. Its negation is the
 * `dev:web` condition: a browser with no Rust behind it, which is where the
 * encoding suite will run.
 */
export function hasRustBehindIt(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The snapshot for this tick.
 *
 * With Rust behind it, one command and nothing else — that is the primary seam,
 * and it is structural rather than conventional because no other command hands
 * the frontend map state.
 *
 * Without Rust behind it, a checked-in fixture, named by the query parameter
 * `fixtures.ts` spells once as `FIXTURE_PARAMETER` — see there for why it is
 * `?map=` and not `?fixture=`.
 *
 * What every fixture has in common is that **none of them is stamped
 * `github`**: they are `fixture`, or `cache` for the one standing in for a poll
 * that failed, or `none` for the state before anything was read. A browser that
 * quietly presented a fixture as a live read would be the one thing the
 * provenance rules exist to prevent.
 */
export async function loadSnapshot(search?: string): Promise<Snapshot> {
  if (!hasRustBehindIt()) {
    return fixtureNamed(requestedFixture(search));
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Snapshot>("snapshot");
}

/** The Rust side's string, not one this file invented. See `SNAPSHOT_EVENT`. */
const SNAPSHOT_EVENT = "snapshot";

/**
 * Every tick the poller finished, for as long as this window is open.
 *
 * The one-shot command above answers with the same value this carries — the
 * poller's latest derivation, stored once and handed out twice — so the
 * subscription and the command cannot disagree about what is on screen. What
 * the subscription adds is the ticks after the first: without it, a window
 * opened at launch would show the model as it was at mount for the rest of the
 * process, and the ledger beside it would never gain a row.
 *
 * **A failed poll arrives too**, exactly as it does on the `maps` event: the
 * last model it had, with an aged stamp, and a ledger that did not grow. Never
 * silence, never an emptied graph, and never a row — a poll that did not land
 * established nothing to write down, and the stale stamp is what carries the
 * health. So an arrival on this channel is not by itself evidence that anything
 * moved.
 *
 * Returns the way to stop listening, for the same reason `watchMaps` does: a
 * subscription that outlives its component is a leak. A browser subscribes to
 * nothing, because nothing behind it is polling — `dev:web` is a single
 * checked-in answer and there is no second one coming.
 */
export async function watchSnapshot(
  onSnapshot: (snapshot: Snapshot) => void,
): Promise<() => void> {
  if (!hasRustBehindIt()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<Snapshot>(SNAPSHOT_EVENT, ({ payload }) => onSnapshot(payload));
}

/** The state the app opens in, before anything has answered. */
export function noMapOpen(): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    model: { map: null },
    provenance: { source: "none", outcome: { kind: "notAttempted" }, fetchedAt: null },
    // *First open*, never `0 changes`: nothing has been compared against
    // anything, and a map nobody has read is not a map that has not moved.
    ledger: { since: "firstOpen", entries: [] },
  };
}

export { DEFAULT_FIXTURE, FIXTURE_NAMES, fixtureNamed, requestedFixture } from "./fixtures";
export type { FixtureName } from "./fixtures";
