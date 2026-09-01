import { hasRustBehindIt } from "../snapshot/snapshot";
import type { Geometry } from "../stores/ui";
import { requestedRunFixture, runFixtureNamed } from "./fixtures";

/**
 * What one run's terminal is handed, and how it is handed over.
 *
 * The seam here is **bytes, not text**. A VT stream is bytes: an escape sequence
 * is a byte sequence, a UTF-8 character can straddle a read, and anything that
 * decoded on the way across would be deciding what an incomplete sequence means
 * on behalf of a terminal emulator that is about to be handed it anyway. So the
 * channel carries an `ArrayBuffer` and xterm.js is what reads it.
 *
 * A hand-written mirror of `crates/app/src/lib.rs`, pinned from that side by
 * `the_shapes_the_webview_reads_are_the_ones_rust_writes`.
 */

/**
 * The ten-byte header on every delivery, then the bytes.
 *
 * - byte 0 — `0` continues, `1` reset and replay
 * - byte 1 — whether this run has lost scrollback
 * - bytes 2..10 — the absolute offset this delivery ends at, big endian
 */
const HEADER = 10;

export interface Delivery {
  /**
   * **Whether the terminal is reset before these bytes are written.**
   *
   * `continues` is the ordinary frame: bytes that carry on from exactly where
   * the last ones stopped. `replay` is the only other thing that ever arrives,
   * and it is the whole ring — the harness could not continue contiguously, so
   * it reset rather than hand over a gap. There is deliberately no third kind:
   * a shortened range would cut an escape sequence in half and the terminal
   * would render garbage for the rest of the session.
   */
  kind: "continues" | "replay";
  /** This run has lost scrollback. Printed in the chrome, never written in. */
  truncated: boolean;
  /** The absolute offset these bytes end at, which is what gets confirmed. */
  through: number;
  bytes: Uint8Array;
}

/**
 * One framed delivery, read.
 *
 * `through` is read as two 32-bit halves and recombined, because a stream long
 * enough to overflow a `number` is longer than any run this app will ever hold
 * and `BigInt` would put a second numeric type on the hot path for it.
 */
export function readDelivery(frame: ArrayBuffer): Delivery | null {
  if (frame.byteLength < HEADER) return null;

  const view = new DataView(frame);
  const high = view.getUint32(2, false);
  const low = view.getUint32(6, false);

  return {
    kind: view.getUint8(0) === 1 ? "replay" : "continues",
    truncated: view.getUint8(1) === 1,
    through: high * 0x1_0000_0000 + low,
    bytes: new Uint8Array(frame, HEADER),
  };
}

/**
 * How a run ended, or that it has not — as Rust derives it.
 *
 * **Two facts and never one state machine over the process.** A ticket closing
 * is the poller's fact and a child exiting is the terminal's; neither causes the
 * other and they arrive in either order.
 *
 * - `live` — the child is running and the ticket is not closed.
 * - `spent` — the ticket closed. The one good ending, and it says nothing about
 *   the child, which may still be printing. The run keeps its slot until
 *   somebody presses to end it.
 * - `exitedUnresolved` — the child stopped with the ticket still open and still
 *   assigned. The claim is still on GitHub and this pane is the only record of
 *   why it stopped.
 * - `exited` — the child stopped and nothing is claimed of it. An exit over an
 *   open *unassigned* ticket is this and not `exitedUnresolved`, because a
 *   readout must not assert a claim that is not there.
 */
export type RunEnding = "live" | "spent" | "exitedUnresolved" | "exited";

/**
 * Why a run reads as wedged. Two, and they want different sentences — and, being
 * sentences about different quantities, different numbers.
 *
 * - `awaitingOperator` — the readiness rule the adapter declared ran out before
 *   the session opened. Every declared timeout is an order of magnitude above
 *   the ~223 ms an alternate screen has been measured to take, so what expired
 *   is not a slow machine: something is waiting for the operator, most likely a
 *   trust prompt. It carries `unopenedForMs`, **how long since the spawn this
 *   session has not opened** — never the byte silence, which is nothing at all
 *   on a CLI that repaints a spinner while it waits, and which would print
 *   `waiting for you · 0s` beside a run that has been stuck for ten seconds.
 * - `silent` — an unattended run has printed nothing for five minutes and
 *   nothing has ever classified it. Nobody is watching and nothing is coming.
 *   It carries `silentForMs`, the byte silence, which is the whole of what this
 *   reading is derived from.
 */
export type Wedge =
  | { why: "awaitingOperator"; unopenedForMs: number }
  | { why: "silent"; silentForMs: number };

/**
 * What a run's silence means, or that it means nothing — as Rust derives it.
 *
 * **A joint predicate over two independent facts, never a shared threshold.**
 * How long a run has printed nothing is one fact and who is waiting on it is
 * another: the same ninety seconds is a person reading the screen on a work run
 * and an agent that has stopped on a research one. `docs/adr/0025` is the
 * argument, and nothing on this side may re-derive it — the elapsed is here to
 * be printed, not to be compared against a number this file invented.
 *
 * - `nothing` — no reading. The child has exited, and what that means is the
 *   `ending` beside this.
 * - `spent` — the ticket closed. Outranks everything: a spent run is never quiet
 *   and never wedged, however long it has said nothing.
 * - `quiet` — silent with somebody at the keyboard and the ticket still open.
 *   For any elapsed, and forever.
 * - `wedged` — silent in a way that wants somebody, and `why` says which way.
 *   The elapsed beside it is the one that way's sentence claims, so it is named
 *   for that quantity and not for a shared one: see `Wedge`.
 */
export type RunSilence =
  | { kind: "nothing" }
  | { kind: "spent" }
  | { kind: "quiet"; silentForMs: number }
  | ({ kind: "wedged" } & Wedge);

/**
 * A live signal, as Rust writes it.
 *
 * Three and no fourth: there is deliberately no `completed`, because completion
 * is a GitHub state transition and nothing else. A signal means exactly *poll
 * GitHub sooner* and is never evidence in its own right, so nothing here may
 * read one as an answer about a ticket.
 */
export type RunSignal = "ready" | "busy" | "idle";

/** One run's readout, as Rust writes it. Counts and flags, never bytes. */
export interface RunReadout {
  run: number;
  held: number;
  dropped: number;
  through: number;
  end: number;
  truncated: boolean;
  desynced: boolean;
  over: boolean;
  code: number | null;
  monitored: boolean;
  ending: RunEnding;
  /**
   * The ticket this run was staked on, or `null` for a run the harness was never
   * told about.
   *
   * Half of the value that joins a run to a node, which is how a claim with a
   * live terminal is told from a claim with none — the difference the rail
   * offers Resume on.
   */
  ticket: number | null;
  /**
   * The folder that run was staked in, or `null` for a run the harness was never
   * told about.
   *
   * The other half of the join, and the half without which the join is wrong: an
   * issue number is unique inside one repository and means nothing across two,
   * and this window holds every folder's runs at once. Rust matches on both, and
   * so does `liveRunOn`.
   */
  folder: string | null;
  /** What this run's silence means, or that it means nothing. */
  silence: RunSilence;
  /**
   * The last state a watch classified this run as, or `null` for a run no signal
   * has ever been observed for.
   *
   * `null` is a fact about the run's history and never an answer about its
   * adapter: every run is drained through a watch on identical terms, so there
   * is nothing here to ask whether one produces signals.
   */
  signal: RunSignal | null;
}

/**
 * Where the monitored run's bytes are to be delivered.
 *
 * Registered **once**, at mount, and never per run. Re-registering on every bind
 * would make binding a channel event, and a channel that restarted would have to
 * decide where in the stream to restart from — which is the decision the harness
 * makes and this side must not have an opinion about.
 */
export async function openTerminalChannel(
  onDelivery: (delivery: Delivery) => void,
): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { Channel, invoke } = await import("@tauri-apps/api/core");

  const bytes = new Channel<ArrayBuffer>();
  bytes.onmessage = (frame) => {
    const delivery = readDelivery(frame);
    if (delivery !== null) onDelivery(delivery);
  };

  await invoke("terminal_channel", { bytes });
}

/** A declaration and not a fetch: nothing is answered, the channel carries it. */
export async function monitorRun(run: number | null): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("monitor_run", { run });
}

/**
 * This window confirming it has written a run's bytes up to `through`.
 *
 * **The whole of the backpressure signal.** Without it the harness has no way to
 * tell a window that is keeping up from one that has stopped, so it would go on
 * sending to a terminal that is minutes behind — and the only way that ends is a
 * replay of a ring that has long since dropped what was missing.
 */
export async function runTook(run: number, through: number): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("run_took", { run, through });
}

/** Keystrokes, as xterm.js hands them over. Nothing here reads them. */
export async function typedAtRun(run: number, text: string): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("typed_at_run", { run, text });
}

/**
 * A completed gesture settled on a pane size.
 *
 * The **only** call in this app that resizes a PTY, and it is reached from
 * exactly one place: the falling edge of a gesture in `src/panes/geometry.ts`.
 * Bind, peek, arrival and every frame of a drag have nothing to call.
 */
export async function settledGeometry(geometry: Geometry): Promise<number> {
  if (!hasRustBehindIt()) return 0;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<number>("settled_geometry", {
    rows: geometry.rows,
    cols: geometry.cols,
  });
}

/**
 * One run, ended by this press.
 *
 * The **only** way a run leaves the rack. A spent run holds its slot until this
 * is called: the app noticing that a ticket closed is not a person being
 * finished with what is on screen, and nothing on the Rust side — no poll, no
 * readout tick — is allowed to call what this calls.
 */
export async function endRun(run: number): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("end_run", { run });
}

/**
 * Every run's readout, once.
 *
 * Without Rust behind it, a checked-in set named by the query parameter
 * `fixtures.ts` spells once as `RUNS_PARAMETER` — see there for why a browser
 * needs one at all, and for what these fixtures are not.
 */
export async function loadRunReadouts(): Promise<RunReadout[]> {
  if (!hasRustBehindIt()) return runFixtureNamed(requestedRunFixture());
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<RunReadout[]>("run_readouts");
}

/** The Rust side's string, not one this file invented. */
const READOUTS_EVENT = "run-readouts";

/**
 * Every run's readout, several times a second, for as long as this window is
 * open.
 *
 * Subscribe and then ask, the ordering every other surface here uses: the tick
 * is unprompted and the command covers the gap before there is a listener, and
 * both carry the same value so neither can contradict the other.
 */
export async function watchRunReadouts(
  onReadouts: (readouts: RunReadout[]) => void,
): Promise<() => void> {
  if (!hasRustBehindIt()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<RunReadout[]>(READOUTS_EVENT, ({ payload }) => onReadouts(payload));
}
