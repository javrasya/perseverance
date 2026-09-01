// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import appStyles from "../src/App.module.css";
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
/** The stud's own box — the one carrying the chord, the rebind and the refusal. */
const theStudBox = () => theStud()?.parentElement ?? null;
/** The terminal's share of the body: the box the `map` detent collapses away. */
const theTerminalBox = () => document.querySelector(`.${appStyles.terminal}`);
const theBody = () => document.querySelector(`.${appStyles.body}`);

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
    expect(dial?.getAttribute("aria-label")).toBe(
      "Dial: how much of the window the map has — map",
    );

    await release();
    expect(dial?.getAttribute("data-detent")).toBe("glance");
  });
});

describe("a peek is the map side at map width, not at the detent it came from", () => {
  /*
   * The defect this pins: every number the map side is drawn from used to come
   * off the *resting* position — the one a peek deliberately never moves — so
   * the promoted box was filled with whatever the dial was entitled to. From
   * `terminal` that is an opaque blank panel over the run; from `glance` it is
   * the stand-down, stretched. Both are a glance at the position rather than at
   * the map, which is the one thing a peek is for.
   */
  it("draws every column and stands nothing down, from terminal and from glance", async () => {
    await boot();

    for (const detent of ["terminal", "glance"] as const) {
      await put(fractionOf(detent));
      await hold();

      const overlay = theOverlay();
      expect(overlay?.getAttribute("data-peeking")).toBe("true");
      // Full map width: the launcher, the real view and the rail, all of them
      // inside the promoted box and none of them shed.
      expect(overlay?.querySelector('[aria-label="Folders"]')).not.toBeNull();
      expect(overlay?.querySelector('[aria-label="The Route"]')).not.toBeNull();
      expect(
        overlay?.querySelector('[aria-label="what to do at the frontier"]'),
      ).not.toBeNull();
      // At map width no view stands down — the whole argument for peeking at
      // the real view rather than at a plate of its own.
      expect(document.querySelector('[aria-label="View stood down"]')).toBeNull();

      await release();

      // And back to what the position is worth the moment the spring is up:
      // neither detent can afford the launcher, and `glance` cannot afford the
      // Route either.
      expect(document.querySelector('[aria-label="Folders"]')).toBeNull();
      expect(document.querySelector('[aria-label="The Route"]')).toBeNull();
    }

    await put(fractionOf("glance"));
    expect(document.querySelector('[aria-label="View stood down"]')).not.toBeNull();
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

  /*
   * The defect this pins: the refusal was in the DOM and off the screen. The
   * stud used to hang off the terminal's box — `flex: 1 1 0`, `overflow:
   * hidden` — which the `map` detent collapses to its own padding, so the
   * chord, the rebind and the refusal were clipped to nothing at exactly the
   * position where the refusal is the only feedback there is. The assertion
   * above passed anyway, because jsdom answers `textContent` without laying
   * anything out.
   *
   * jsdom still lays nothing out, so what is pinned here is the thing that
   * decides the clipping: *which box the stud hangs on*. The body is the one
   * box the dial cannot collapse.
   */
  it("prints it somewhere the map detent cannot clip away", async () => {
    await boot();
    await put(fractionOf("map"));
    await hold();

    const stud = theStudBox();
    expect(stud).not.toBeNull();
    expect(stud?.textContent).toContain(NOTHING_TO_GIVE);
    expect(stud?.parentElement).toBe(theBody());
    expect(theTerminalBox()?.contains(stud as Node)).toBe(false);
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
  it("hangs off the body at every position, never inside the collapsing pane", async () => {
    await boot();
    for (const detent of ["terminal", "split", "glance", "map"] as const) {
      await put(fractionOf(detent));
      const stud = theStudBox();
      expect(stud, `no stud at ${detent}`).not.toBeNull();
      expect(stud?.parentElement, `stud is off the body at ${detent}`).toBe(theBody());
      expect(theTerminalBox()?.contains(stud as Node)).toBe(false);
    }
  });

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
