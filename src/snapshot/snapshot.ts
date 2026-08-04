/**
 * The WebView's view of the seam.
 *
 * These types mirror `perseverance-model`'s `Snapshot` exactly. The same
 * artifact is that crate's output and this app's input, which is what makes it
 * one seam rather than two — and why a checked-in JSON file can drive the
 * frontend with no Rust, no GitHub and no PTY behind it.
 */

export const SCHEMA_VERSION = 1;

export type Source = "github" | "cache" | "fixture" | "none";

export type ReadOutcome =
  | { kind: "ok" }
  | { kind: "failed"; detail: string }
  | { kind: "notAttempted" };

export interface Provenance {
  source: Source;
  outcome: ReadOutcome;
  fetchedAt: string | null;
}

export interface MapRef {
  number: number;
  title: string;
}

export interface Snapshot {
  schemaVersion: number;
  map: MapRef | null;
  provenance: Provenance;
}

export function noMapOpen(): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    map: null,
    provenance: { source: "none", outcome: { kind: "notAttempted" }, fetchedAt: null },
  };
}

/**
 * True when the app is running inside the Tauri shell. Its negation is the
 * `dev:web` condition: a browser with no Rust behind it, which is where the
 * encoding suite will run.
 */
export function hasRustBehindIt(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadSnapshot(): Promise<Snapshot> {
  if (!hasRustBehindIt()) {
    return noMapOpen();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Snapshot>("snapshot");
}
