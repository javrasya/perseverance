import { hasRustBehindIt } from "../snapshot/snapshot";
import type { Geometry } from "../stores/ui";

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

export async function loadRunReadouts(): Promise<RunReadout[]> {
  if (!hasRustBehindIt()) return [];
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
