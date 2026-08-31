// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { fractionOf } from "../src/panes/dial";
import { NOTHING_TO_GIVE, platformName, readChord } from "../src/panes/peek";
import { moveDial, readUi } from "../src/stores/ui";

/**
 * The peek, in the real shell.
 *
 * `tests/peek.test.ts` pins the spring; this pins what the window does with it.
 * The claims are the ones an operator would notice going wrong: the terminal's
 * box does not move, the view on screen is the *same node* rather than a second
 * rendering of the map, the spine is still drawn over the top, a hold at map
 * width prints why it gave nothing, and no peek — held or released — writes the
 * position the dial is remembered at.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/*
 * jsdom has no `matchMedia`, and xterm.js asks the window for one the moment a
 * terminal is opened. The stub is the smallest honest answer a window can give:
 * it matches nothing.
 */
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(): Promise<void> {
  teardown();
  window.history.replaceState({}, "", "/?map=awkward-map");

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<App />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function teardown() {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(async () => {
  await release();
  teardown();
  moveDial(fractionOf("split"));
  window.localStorage.clear();
});

const chord = () => readChord(platformName());

async function hold(): Promise<void> {
  const bound = chord();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: bound.key,
        metaKey: bound.meta,
        ctrlKey: bound.ctrl,
        altKey: bound.alt,
        shiftKey: bound.shift,
        cancelable: true,
      }),
    );
  });
}

async function release(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: chord().key }));
  });
}

async function put(position: number): Promise<void> {
  await act(async () => moveDial(position));
}

const theOverlay = () => document.querySelector("[data-peeking]");
const theTerminal = () => document.querySelector('[aria-label="Terminal"]');
const theStud = () => document.querySelector('[aria-label^="Peek at the map"]');

describe("a peek occludes and never displaces", () => {
  it("promotes the same nodes and leaves the terminal exactly where it was", async () => {
    await boot();
    const terminal = theTerminal();
    const overlay = theOverlay();
    const view = document.querySelector('[aria-label="Views"]');
    const geometry = readUi().geometry;

    expect(overlay?.getAttribute("data-peeking")).toBe("false");

    await hold();

    expect(theOverlay()?.getAttribute("data-peeking")).toBe("true");
    // The same node, promoted — not a second rendering of the map. Two
    // renderings are two things that can disagree.
    expect(theOverlay()).toBe(overlay);
    expect(theTerminal()).toBe(terminal);
    expect(document.querySelector('[aria-label="Views"]')).toBe(view);
    // Nothing reached `settle`: the terminal's box never changed, so the pane's
    // observer had nothing to report and no PTY was resized.
    expect(readUi().geometry).toBe(geometry);

    await release();

    expect(theOverlay()?.getAttribute("data-peeking")).toBe("false");
    expect(theTerminal()).toBe(terminal);
  });

  it("stops short of the prompt line rather than covering the window", async () => {
    await boot();
    await hold();

    const style = (theOverlay() as HTMLElement).style;
    expect(style.bottom).not.toBe("");
    expect(Number.parseInt(style.bottom, 10)).toBeGreaterThan(0);
  });

  it("keeps the spine — the switcher, the three integers and both stamps", async () => {
    await boot();
    await hold();

    expect(document.querySelector('[aria-label="Views"]')).not.toBeNull();
    const footer = document.querySelector("footer")?.textContent ?? "";
    expect(footer).toMatch(/\d+\/\d+ tickets open/);
    expect(footer).toMatch(/\d+ nodes/);
    expect(footer).toContain("model");
    expect(footer).toContain("maps");
  });
});

describe("a peek borrows the dial and never moves it", () => {
  it("leaves the position where it was and writes nothing down", async () => {
    await boot();
    await put(fractionOf("glance"));
    window.localStorage.clear();

    await hold();

    expect(readUi().position).toBe(fractionOf("glance"));
    // A glance may not rearrange the room: nothing about the peek reaches the
    // per-map memory.
    expect(window.localStorage.length).toBe(0);

    await release();

    expect(readUi().position).toBe(fractionOf("glance"));
    expect(window.localStorage.length).toBe(0);
  });

  it("makes the dial read as map width while the spring is held", async () => {
    await boot();
    await put(fractionOf("glance"));
    const dial = document.querySelector('[role="separator"]');
    expect(dial?.getAttribute("data-detent")).toBe("glance");

    await hold();
    expect(dial?.getAttribute("data-detent")).toBe("map");
    expect(dial?.getAttribute("aria-valuetext")).toBe("map");

    await release();
    expect(dial?.getAttribute("data-detent")).toBe("glance");
  });
});

describe("inert at map width, and it says so", () => {
  it("prints why rather than doing nothing quietly", async () => {
    await boot();
    await put(fractionOf("map"));

    await hold();

    expect(theOverlay()?.getAttribute("data-peeking")).toBe("false");
    expect(document.body.textContent).toContain(NOTHING_TO_GIVE);
  });
});

describe("the named defect: a hold whose release never arrives", () => {
  it("springs back when the window loses focus mid-hold", async () => {
    await boot();
    await hold();
    expect(theOverlay()?.getAttribute("data-peeking")).toBe("true");

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(theOverlay()?.getAttribute("data-peeking")).toBe("false");
  });
});

describe("the stud on the terminal's edge", () => {
  it("names the live chord and peeks exactly as the chord does", async () => {
    await boot();
    const stud = theStud() as HTMLElement | null;
    expect(stud).not.toBeNull();
    expect(stud?.getAttribute("aria-label")).toContain("hold");

    await act(async () => {
      stud?.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(theOverlay()?.getAttribute("data-peeking")).toBe("true");

    await act(async () => {
      stud?.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(theOverlay()?.getAttribute("data-peeking")).toBe("false");
  });

  it("marks the swallow, so a claimed chord is not a key that vanished", async () => {
    await boot();
    await hold();
    expect(document.body.textContent).toContain("the run did not see it");
  });
});
