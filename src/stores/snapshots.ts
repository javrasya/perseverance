import { useSyncExternalStore } from "react";
import { noMapOpen, type Snapshot } from "../snapshot/snapshot";
import { readable } from "./readable";

/**
 * The snapshot store: what Rust last derived, replaced wholesale.
 *
 * **The first of the two stores, and the one with the shorter lifetime.** It is
 * overwritten every time a poll lands — several times a minute, unprompted, on a
 * cadence nobody on this side controls. Nothing a component does writes to it,
 * because [`useSnapshot`] returns a `Snapshot` and there is no setter beside it;
 * the only writer is [`replaceSnapshot`], which the app's own wiring holds and
 * no view or chrome file imports.
 *
 * Keeping it apart from [`ui`] is not tidiness. A poll landing mid-drag would
 * otherwise be a re-render that reset whatever the operator's hand was in the
 * middle of, and *the dial went back to where it was when I let go* is
 * indistinguishable from a broken dial. Two stores, two lifetimes, and the poll
 * has nothing to reset.
 *
 * [`ui`]: ../stores/ui
 */
const [store, replace] = readable<Snapshot>(noMapOpen());

/** For the wiring only. Nothing under `src/views/` or `src/chrome/` may import it. */
export const replaceSnapshot = replace;

/** What the last poll derived. A value, not a handle: there is nothing to set. */
export function useSnapshot(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

/** The same value, for code that is not a component. */
export function readSnapshot(): Snapshot {
  return store.read();
}

export function watchSnapshotStore(listener: () => void): () => void {
  return store.subscribe(listener);
}
