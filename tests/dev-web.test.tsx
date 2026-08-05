// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { FIXTURES } from "../src/snapshot/fixtures";
import { hasRustBehindIt } from "../src/snapshot/snapshot";

/**
 * `dev:web` boots the whole frontend from a checked-in snapshot with no Rust
 * process behind it.
 *
 * Asserted by actually mounting the app, because *boots* is the claim. Every
 * other check in this repository could pass while the page threw on mount —
 * the fixtures parse, the types compile, the derivation is right — and an
 * operator would still open a browser onto nothing.
 */

/*
 * React only flushes effects inside `act` when it is told it is in a test
 * environment. Without this the assertions still pass — because the snapshot
 * arrives in a microtask either way — but every render logs a warning, and a
 * suite that always warns is a suite whose warnings nobody reads.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(search: string): Promise<string> {
  // The one thing a browser cannot be talked out of: `jsdom` has a `window`,
  // and what makes this the `dev:web` path is that nothing put Tauri on it.
  window.history.replaceState({}, "", search);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<App />);
  });
  // The snapshot arrives from a promise, so one more turn of the loop.
  await act(async () => {
    await Promise.resolve();
  });

  return host.textContent ?? "";
}

afterEach(() => {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
});

describe("dev:web", () => {
  it("has no Rust behind it, which is the whole condition", () => {
    expect(hasRustBehindIt()).toBe(false);
  });

  it("mounts and puts the derived model on screen", async () => {
    const text = await boot("/?map=awkward-map");
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    expect(text).toContain("perseverance");
    expect(text).toContain("wayfinding");
    expect(text).toContain(`frontier #${map.frontier}`);
  });

  it("boots whichever map the url named", async () => {
    const text = await boot("/?map=map-closed");

    expect(text).toContain("done");
    expect(text).not.toContain("wayfinding");
  });

  it("boots on a map with nothing on it without reading as finished", async () => {
    const text = await boot("/?map=empty-map");

    expect(text).toContain("unstarted");
    expect(text).toContain("nothing to start");
  });

  it("still draws the graph when the last poll failed", async () => {
    const text = await boot("/?map=unreachable");
    const map = FIXTURES.unreachable.model.map;
    if (map === null) throw new Error("the unreachable fixture has no map");

    // Never silence. The frontier is still named, because what was read last
    // time is still what is true of the last time anybody looked.
    expect(text).toContain(`frontier #${map.frontier}`);
  });
});
