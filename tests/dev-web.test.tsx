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
  // Booting twice in one test is how two fixtures get compared, and a mount
  // left behind would go on answering `document.querySelector` for the rest of
  // the file — so the previous one goes before the next one arrives.
  teardown();

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

function teardown() {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(teardown);

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

  it("says the model is stale rather than showing a failed poll as a fresh one", async () => {
    /*
     * The two fixtures carry the same model and differ only in provenance —
     * which is the whole point of a failed poll re-emitting rather than going
     * silent, and also the way this could go quietly wrong. A screen that drew
     * them identically would be presenting an unreachable GitHub as a live
     * read, which is the one thing the provenance rules exist to prevent.
     */
    const failed = await boot("/?map=unreachable");
    expect(failed).toContain("from the last read");
    expect(failed).toContain("nothing newer has arrived");

    const fresh = await boot("/?map=awkward-map");
    expect(fresh).toContain("from a checked-in fixture");
    expect(fresh).not.toContain("nothing newer has arrived");
  });

  it("stamps each thing that was read from its own provenance, and names which", async () => {
    /*
     * Two stamps, and the ways this goes wrong are both silent. Feed one of
     * them the other's provenance and a stale map list reads as fresh — the
     * exact failure the stamp exists to prevent, and invisible, because the
     * wrong stamp is still a plausible-looking stamp. Drop the labels and the
     * reader cannot tell which of two identical sentences is about what.
     *
     * So this asserts the pairing rather than the presence: on this fixture
     * the model was read and the map list was not, and no single provenance
     * can produce both of those sentences.
     */
    await boot("/?map=unreachable");
    const stamps = [...document.querySelectorAll("[data-source]")].map((el) => ({
      source: el.getAttribute("data-source"),
      text: el.textContent ?? "",
    }));

    expect(stamps).toHaveLength(2);
    const [model, mapList] = stamps;
    if (model === undefined || mapList === undefined) throw new Error("two stamps expected");

    // The model came from a copy, because the poll that would have replaced it
    // failed. The age moves with the real clock, so only the words are pinned.
    expect(model.source).toBe("cache");
    expect(model.text.startsWith("model from the last read")).toBe(true);
    expect(model.text).toContain("nothing newer has arrived");

    // Nothing has opened a folder, so the map list has never been read — and
    // says so, rather than borrowing the age of something that has been.
    expect(mapList.source).toBe("none");
    expect(mapList.text).toBe("maps nothing read yet");
  });

  it("carries the reason the read did not land, in the words it arrived in", async () => {
    await boot("/?map=unreachable");
    const stamp = document.querySelector('[data-outcome="failed"]');

    expect(stamp?.getAttribute("title")).toBe("could not reach GitHub");
  });
});
