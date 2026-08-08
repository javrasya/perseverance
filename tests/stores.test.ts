// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readable } from "../src/stores/readable";
import { readSnapshot, replaceSnapshot, watchSnapshotStore } from "../src/stores/snapshots";
import {
  monitor,
  readUi,
  select,
  settle,
  startGesture,
  watchUi,
  type Ui,
} from "../src/stores/ui";
import { gesture, resizes, type Occasion } from "../src/panes/geometry";
import { FIXTURES } from "../src/snapshot/fixtures";
import { collect } from "./support/sources";

/**
 * Two stores, two lifetimes.
 *
 * The claim worth a test is the one in the ticket: *a poll landing mid-drag does
 * not disturb UI state*. Everything else here is what makes that claim
 * structural rather than a habit — that a component holds no setter for the
 * snapshot, and that nothing but the app's own wiring can replace one.
 */

describe("the store primitive", () => {
  it("notifies subscribers when the value is replaced", () => {
    const [store, replace] = readable(1);
    const heard = vi.fn();
    const off = store.subscribe(heard);

    replace(2);

    expect(store.read()).toBe(2);
    expect(heard).toHaveBeenCalledTimes(1);

    off();
    replace(3);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("notifies nobody when the value did not change", () => {
    const held = { rows: 24 };
    const [store, replace] = readable(held);
    const heard = vi.fn();
    store.subscribe(heard);

    replace(held);

    // A poll that landed with nothing new is not a re-render of the window.
    expect(heard).not.toHaveBeenCalled();
  });

  it("survives a listener that unsubscribes while being notified", () => {
    const [store, replace] = readable(0);
    const second = vi.fn();
    const off = store.subscribe(() => off());
    store.subscribe(second);

    replace(1);

    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("a poll landing mid-drag", () => {
  it("replaces the snapshot and disturbs nothing the operator was doing", () => {
    // A hand on the divider, a node selected, a run on the pane.
    select(7);
    monitor(3);
    startGesture();
    const before: Ui = readUi();
    expect(before.dragging).toBe(true);

    const heard = vi.fn();
    const off = watchUi(heard);
    replaceSnapshot(FIXTURES["two-maps-one-open"]);

    // The snapshot moved.
    expect(readSnapshot()).toBe(FIXTURES["two-maps-one-open"]);
    // Nothing else did — not the selection, not the run on the pane, and above
    // all not the gesture in progress. The dial going back to where it was when
    // you let go is indistinguishable from a broken dial.
    expect(readUi()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
    off();

    // And the two are genuinely separate subscriptions.
    const onSnapshot = vi.fn();
    const stop = watchSnapshotStore(onSnapshot);
    select(9);
    expect(onSnapshot).not.toHaveBeenCalled();
    stop();
  });
});

describe("what a component may write", () => {
  it("gives no file outside the app's own wiring a way to replace the snapshot", () => {
    // `useSnapshot` returns a `Snapshot` and there is no setter beside it, so a
    // view has nothing to call. This is the other half: nothing under the
    // rendering directories imports the one function that can write.
    const writers = collect([".ts", ".tsx"])
      .filter(({ path }) =>
        /^src\/(views|chrome|terminal|launcher|maps|environment|panes)\//.test(path),
      )
      .filter(({ text }) => text.includes("replaceSnapshot"))
      .map(({ path }) => path);

    expect(writers).toEqual([]);
  });
});

describe("which occasions may resize a pty", () => {
  it("is exactly one of the five, and the table says which", () => {
    const occasions: Occasion[] = ["drag", "settled", "bind", "peek", "arrival"];

    expect(occasions.filter(resizes)).toEqual(["settled"]);
  });

  it("sends exactly one resize for a completed gesture", () => {
    settle({ rows: 24, cols: 80 });
    const resized = vi.fn();
    const gestured = gesture(resized, 5);

    // A drag is dozens of these a second, and not one of them may reach a PTY.
    gestured.measured("drag", { rows: 30, cols: 100 });
    gestured.measured("drag", { rows: 31, cols: 101 });
    gestured.measured("drag", { rows: 32, cols: 102 });
    expect(resized).not.toHaveBeenCalled();
    expect(readUi().dragging).toBe(true);

    gestured.measured("settled", { rows: 40, cols: 120 });

    expect(resized).toHaveBeenCalledTimes(1);
    expect(resized).toHaveBeenCalledWith({ rows: 40, cols: 120 });
    expect(readUi().dragging).toBe(false);
  });

  it("sends none on bind, on peek or on arrival, however different the size is", () => {
    settle({ rows: 24, cols: 80 });
    const resized = vi.fn();
    const gestured = gesture(resized, 5);

    for (const occasion of ["bind", "peek", "arrival"] as const) {
      gestured.measured(occasion, { rows: 99, cols: 999 });
    }

    expect(resized).not.toHaveBeenCalled();
    // And nothing is left waiting, so none of them can become a resize by the
    // passage of time either.
    expect(readUi().dragging).toBe(false);
    expect(readUi().geometry).toEqual({ rows: 24, cols: 80 });
  });

  it("sends none when the gesture ended where it began", () => {
    settle({ rows: 40, cols: 120 });
    const resized = vi.fn();
    const gestured = gesture(resized, 5);

    gestured.measured("settled", { rows: 40, cols: 120 });

    // A real thing to do with a mouse, and a reflow of every live terminal —
    // including one mid-grilling — for no reason at all.
    expect(resized).not.toHaveBeenCalled();
  });

  it("sends nothing for a drag that was cancelled before it settled", () => {
    settle({ rows: 24, cols: 80 });
    const resized = vi.fn();
    const gestured = gesture(resized, 5);

    gestured.measured("drag", { rows: 60, cols: 200 });
    gestured.cancel();

    expect(resized).not.toHaveBeenCalled();
    expect(readUi().dragging).toBe(false);
  });
});
