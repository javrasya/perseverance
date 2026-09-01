// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { BENCH_MAP_FLOOR, DETENTS, fractionOf, type Detent } from "../src/panes/dial";
import { monitor, moveDial, readUi } from "../src/stores/ui";

/*
 * The seam is real — the writes below are the ones the app makes — and only the
 * *timing* of the read is taken over, for the one claim that is about timing.
 * A mock that answered instead of the module would be a test of the mock.
 */
let held: ((position: number) => void) | null = null;
vi.mock("../src/panes/position", async (original) => {
  const real = await original<typeof import("../src/panes/position")>();
  return {
    ...real,
    readPosition: (folder: number | null, map: number | null) =>
      held === null
        ? real.readPosition(folder, map)
        : new Promise<number>((settle) => {
            held = settle;
          }),
  };
});

/**
 * The shell, at every position of the dial.
 *
 * `tests/dial.test.ts` pins the arithmetic; this pins what survives. The claims
 * are the ones an operator would notice going wrong: the switcher, the three
 * integers, the frontier and both cache stamps are on screen at *every* detent
 * including the two that give one side the whole window; a view that cannot be
 * drawn says so in full rather than going blank; and a cap for a view that does
 * not fit here is still there, still pressable, and moves the dial when pressed.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/*
 * jsdom has no `matchMedia`, and xterm.js asks the window for one the moment a
 * terminal is opened — which is what binding a run to the pane does. The stub is
 * the smallest honest answer a window can give: it matches nothing. Only the
 * *presence* of the run on the map side is under test here; what the emulator
 * draws is `tests/terminals.test.tsx`'s.
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

/** Put the dial somewhere, the way an operator's hand would. */
async function put(where: Detent | number): Promise<void> {
  await act(async () => {
    moveDial(typeof where === "number" ? where : fractionOf(where));
  });
}

function teardown() {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(() => {
  teardown();
  monitor(null);
  moveDial(fractionOf("split"));
});

const theFooter = () => document.querySelector("footer")?.textContent ?? "";
const theSwitcher = () => document.querySelector('[aria-label="Views"]');
const theCap = () => theSwitcher()?.querySelector("button") ?? null;
const theStandDown = () => document.querySelector('[aria-label="View stood down"]');

/** The dial itself, which is the separator the shell hangs between the two. */
const theDial = () => document.querySelector('[role="separator"]') as HTMLElement;

/**
 * A folder picked and a map opened, the way an operator does it — because the
 * position is remembered per folder-and-map and there is nothing to write down
 * until there is one of each.
 */
async function openAMap(): Promise<void> {
  const folder = document.querySelector(
    '[aria-label="Folders"] li button',
  ) as HTMLButtonElement | null;
  if (folder === null) throw new Error("the launcher lists no folder to pick");
  await act(async () => {
    folder.click();
  });

  const map = document.querySelector('[aria-label="Maps"] li button') as HTMLButtonElement | null;
  if (map === null) throw new Error("the folder lists no map to open");
  await act(async () => {
    map.click();
  });
}

/** jsdom measures nothing, and a dial with no body under it moves nowhere. */
function widenTheBody(width: number): void {
  const body = theDial().parentElement;
  if (body === null) throw new Error("the dial hangs outside the body");
  body.getBoundingClientRect = () =>
    ({ width, height: 800, left: 0, top: 0, right: width, bottom: 800, x: 0, y: 0 }) as DOMRect;
}

async function pointer(kind: string, clientX: number): Promise<void> {
  await act(async () => {
    theDial().dispatchEvent(new MouseEvent(kind, { bubbles: true, clientX }));
  });
}

async function press(key: string): Promise<void> {
  await act(async () => {
    theDial().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/**
 * What a gesture costs the store, in writes.
 *
 * Counted at `localStorage` because that is where the seam puts a position with
 * no Rust behind the window; with Rust behind it the same one write is a
 * `map_view` row. What is under test is *how many*, and that is the same number
 * on both sides of the seam.
 */
describe("one write per completed gesture, and none per frame", () => {
  let written: string[] = [];
  let setItem: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    written = [];
    const real = Storage.prototype.setItem;
    setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith("perseverance.dial.")) written.push(`${key}=${value}`);
      real.call(this, key, value);
    });
  });

  afterEach(() => {
    setItem?.mockRestore();
    held = null;
    window.localStorage.clear();
  });

  it("writes nothing on the frames of a drag and exactly once on release", async () => {
    await boot();
    await openAMap();
    widenTheBody(1000);

    await pointer("pointerdown", 500);
    for (const x of [520, 560, 610, 640]) await pointer("pointermove", x);

    // Four frames the operator's hand made, and not one of them is a decision.
    expect(readUi().position).toBeCloseTo(0.64, 5);
    expect(written).toEqual([]);

    await pointer("pointerup", 640);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("=0.64");
  });

  it("writes once for a keyboard move, and once more for the next one", async () => {
    await boot();
    await openAMap();
    widenTheBody(1000);

    await press("End");
    expect(readUi().position).toBe(fractionOf("map"));
    expect(written).toHaveLength(1);

    await press("Home");
    expect(readUi().position).toBe(fractionOf("terminal"));
    expect(written).toHaveLength(2);
  });

  /**
   * The read is asynchronous now, so *the answer landed after the hand had
   * already moved* is a real ordering and not a hypothetical one. It is the
   * same rule the snapshot's subscribe-then-ask keeps: the newer of the two is
   * the operator's, and the reply may not undo it.
   */
  it("does not let a late read put the dial back where the map used to be", async () => {
    await boot();
    held = () => {};
    await openAMap();
    const answer = held as unknown as (position: number) => void;

    await press("End");
    expect(readUi().position).toBe(fractionOf("map"));

    await act(async () => {
      answer(fractionOf("glance"));
    });

    expect(readUi().position).toBe(fractionOf("map"));
  });
});

describe("the spine survives every position of the dial", () => {
  it("keeps the switcher, the three integers, the frontier and both stamps at every detent", async () => {
    await boot();

    for (const detent of DETENTS) {
      await put(detent);

      expect(theSwitcher(), `no switcher at ${detent}`).not.toBeNull();
      expect(theCap()?.textContent, `no cap at ${detent}`).toContain("The Route");

      const footer = theFooter();
      // The three integers and the frontier, spelled by `describeModel` — the
      // same line at every position, because it is drawn outside the body the
      // dial divides.
      expect(footer, `no tickets count at ${detent}`).toMatch(/\d+\/\d+ tickets open/);
      expect(footer, `no specs count at ${detent}`).toMatch(/\d+ spec/);
      expect(footer, `no node count at ${detent}`).toMatch(/\d+ nodes/);
      // And the two cache ages, which may never be a casualty of what else is
      // on screen.
      expect(footer, `no model stamp at ${detent}`).toContain("model");
      expect(footer, `no maps stamp at ${detent}`).toContain("maps");
    }
  });

  it("leaves the terminal mounted even where the pane is worth no pixels", async () => {
    await boot();
    const terminal = document.querySelector('[aria-label="Terminal"]');

    for (const detent of DETENTS) {
      await put(detent);
      // The *same node*, not an equal one: a dial move that remounted the pane
      // would be a screen the harness has no way to put back.
      expect(document.querySelector('[aria-label="Terminal"]')).toBe(terminal);
    }
  });

  it("keeps a free position between two detents rather than snapping the layout onto one", async () => {
    await boot();
    await put(0.71);
    expect(readUi().position).toBe(0.71);
    expect(theSwitcher()).not.toBeNull();
  });
});

describe("the four detents are drawn on the dial, and none of them is a fill", () => {
  const seam = () => document.querySelector('[role="separator"]');

  it("draws a tick for every detent and marks the one the dial is at", async () => {
    await boot();

    for (const detent of DETENTS) {
      await put(detent);
      const ticks = seam()?.querySelectorAll("[data-here]") ?? [];
      expect(ticks, `no ticks at ${detent}`).toHaveLength(DETENTS.length);
      const here = [...ticks].filter((tick) => tick.getAttribute("data-here") === "true");
      expect(here, `nothing marked at ${detent}`).toHaveLength(1);
      // Named where the body can afford it, which jsdom's 1024 can.
      expect(here[0]?.textContent).toBe(detent);
    }
  });

  it("marks no tick at a free position, and adds no stops to the tab order", async () => {
    await boot();
    await put(0.71);

    const ticks = seam()?.querySelectorAll("[data-here]") ?? [];
    expect([...ticks].some((tick) => tick.getAttribute("data-here") === "true")).toBe(false);
    // The detent is announced on the separator itself; the drawing is for the
    // eye, and a tick that were focusable would be a control nobody asked for.
    expect(seam()?.querySelectorAll("[tabindex], button, a")).toHaveLength(0);
    expect(seam()?.getAttribute("aria-label")).toBe(
      "Dial: how much of the window the map has — 71% to the map",
    );
  });

  /*
   * Rule 5 refuses a value widget anywhere in the rendering, and the family is
   * refused rather than the word *bar*: a dial announcing 71 of 100 is a
   * proportion in the accessibility tree whether or not the proportion is the
   * map's. The conformance suite settles this over the whole fixture space; this
   * holds it at the seam that would grow the attribute back, where the failure
   * names the control instead of naming the page.
   */
  it("is a seam and not a value widget, at a detent and between two", async () => {
    await boot();

    for (const at of [...DETENTS, 0.71] as (Detent | number)[]) {
      await put(at);
      const seamed = seam();
      expect(seamed?.getAttribute("aria-valuenow"), `a value at ${at}`).toBeNull();
      expect(seamed?.getAttribute("aria-valuemin"), `a minimum at ${at}`).toBeNull();
      expect(seamed?.getAttribute("aria-valuemax"), `a maximum at ${at}`).toBeNull();
      expect(seamed?.getAttribute("aria-valuetext"), `a value text at ${at}`).toBeNull();
      expect(
        document.querySelectorAll("progress, meter, [role=progressbar], [aria-valuenow]"),
        `a value widget at ${at}`,
      ).toHaveLength(0);
      // What replaced them still says where the dial stands.
      expect(seamed?.getAttribute("aria-label")).toContain(
        typeof at === "number" ? "71% to the map" : at,
      );
    }
  });
});

describe("a view below its floor stands down, in words", () => {
  it("names the view, the reason, what it needs and what it has", async () => {
    await boot();
    await put("glance");

    const standing = theStandDown();
    expect(standing).not.toBeNull();
    const said = standing?.textContent ?? "";
    expect(said).toContain("The Route");
    expect(said).toContain("needs 420px of map");
    // What it actually has, rather than *too narrow*: 30% of jsdom's 1024.
    expect(said).toContain("this position gives 307px");
    expect(said).toContain("worse than a row that is not there");
  });

  it("keeps the three integers and the frontier readable while it is up", async () => {
    await boot();
    await put("glance");

    expect(theStandDown()?.textContent ?? "").toMatch(/\d+\/\d+ tickets open/);
    expect(theFooter()).toMatch(/\d+ nodes/);
  });

  /*
   * The band under the view column's own floor, where every column of the map
   * side has been shed — launcher, view and rail all at once. The stand-down
   * lives outside the column for exactly this: the alternative here is a map
   * side with nothing in it and no reason given, which is the one thing #28's
   * story 29 says never happens. Free positions land in this band on any normal
   * window, so it is not a corner.
   */
  it("still stands down under the width the view column itself needs", async () => {
    await boot();

    for (const map of [1, 120, 259]) {
      // jsdom's body is 1024 wide, so the position is the width, exactly.
      await put(map / 1024);

      const standing = theStandDown();
      expect(standing, `nothing said at ${map}px`).not.toBeNull();
      const said = standing?.textContent ?? "";
      expect(said, `no view named at ${map}px`).toContain("The Route");
      expect(said, `no requirement at ${map}px`).toContain("needs 420px of map");
      expect(said, `no actual at ${map}px`).toContain(`this position gives ${map}px`);
      // The three integers and the frontier are not a casualty of the width
      // either — the stand-down carries them wherever it is drawn.
      expect(said, `no model line at ${map}px`).toMatch(/\d+\/\d+ tickets open/);
      // Two exits, still the operator's to press and never taken by the app.
      expect(standing?.querySelectorAll("button"), `no exits at ${map}px`).toHaveLength(2);
      expect(readUi().position).toBeCloseTo(map / 1024, 5);
      expect(readUi().view).toBe("route");
      // And the columns really are gone: this is the stand-down speaking for a
      // map side that has nothing else left in it.
      expect(document.querySelector('[aria-label="Folders"]'), `launcher at ${map}px`).toBeNull();
    }
  });

  it("offers exactly two exits and takes neither by itself", async () => {
    await boot();
    await put("glance");

    const exits = theStandDown()?.querySelectorAll("button") ?? [];
    expect(exits).toHaveLength(2);
    expect(exits[0]?.textContent).toContain("Widen to split");
    expect(exits[1]?.textContent).toContain("Give the whole window to the terminal");

    // Still standing down until something is pressed: the app did not widen,
    // narrow or swap the view on its own while the surface was up.
    expect(readUi().position).toBe(fractionOf("glance"));
    expect(readUi().view).toBe("route");

    await act(async () => {
      exits[0]?.click();
    });
    expect(readUi().position).toBe(fractionOf("split"));
    expect(theStandDown()).toBeNull();
  });
});

describe("the switcher is never hidden, and a cap that cannot fit says so", () => {
  it("draws a cap for every view at the detents that cannot hold it", async () => {
    await boot();
    await put("terminal");

    const cap = theCap();
    expect(cap).not.toBeNull();
    // Form-distinct rather than colour-distinct: the state is on the element
    // itself and printed in words on the cap, so it survives a sheet whose
    // every semantic colour has been collapsed to one value.
    expect(cap?.getAttribute("data-fits")).toBe("false");
    expect(cap?.textContent).toContain("needs 420px");
  });

  it("surfaces and opens on one press", async () => {
    await boot();
    await put("terminal");

    await act(async () => {
      theCap()?.click();
    });

    // Both halves: the dial moved to the narrowest position that honours the
    // floor, and that view is the one that is open.
    expect(readUi().position).toBe(fractionOf("split"));
    expect(readUi().view).toBe("route");
    expect(theCap()?.getAttribute("data-fits")).toBe("true");
  });
});

describe("a map rendered during a run shows that run", () => {
  it("carries the monitored run on the map side", async () => {
    await boot();
    await act(async () => {
      monitor(7);
    });

    expect(document.body.textContent).toContain("run #7 is on the pane");

    await act(async () => {
      monitor(null);
    });
    expect(document.body.textContent).not.toContain("is on the pane");
  });
});

/**
 * The Bench, through the shell, either side of the floor the shell compares.
 *
 * `VIEW_FLOORS.bench` is a **map side** derived from the Bench's canvas floor,
 * and the derivation is what keeps these two mounts from both being a drawn
 * Bench: above the floor the view column really does hold plates, and one pixel
 * under it the shell says so itself rather than handing the column to a view
 * that would put its own stand-down inside it. `tests/bench-view.test.tsx`
 * mounts the component; nothing but this reaches it the way an operator does.
 *
 * jsdom lays nothing out, so what is pinned here is the *decision* — floor
 * honoured, column drawn, plates rendered — and not the pixels. The pixels are
 * `tests/dial.test.ts` (the arithmetic) and the conformance run (a browser).
 */
describe("the Bench is reached through the shell, or stood down by it", () => {
  const wasWide = window.innerWidth;

  /** jsdom's body measures zero, so the window is what the shell falls back to. */
  async function windowIs(width: number): Promise<void> {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: wasWide, configurable: true });
  });

  const theBenchCap = () =>
    [...(theSwitcher()?.querySelectorAll("button") ?? [])].find((cap) =>
      cap.textContent?.includes("The Bench"),
    ) ?? null;

  /** Half of `body` is the map side at the opening detent. */
  async function openTheBench(body: number): Promise<void> {
    await boot();
    await windowIs(body);
    await put(0.5);

    const cap = theBenchCap();
    expect(cap, "no cap for the Bench").not.toBeNull();
    expect(cap?.getAttribute("data-fits")).toBe("true");
    await act(async () => {
      cap?.click();
    });
    expect(readUi().view).toBe("bench");
  }

  it("draws plates in the view column just above the floor", async () => {
    await openTheBench(2 * BENCH_MAP_FLOOR + 2);

    expect(theStandDown(), "the shell stood the Bench down above its floor").toBeNull();
    const bench = document.querySelector('[aria-label="The Bench"]');
    expect(bench, "no Bench on the map side").not.toBeNull();
    expect(bench?.querySelectorAll("[data-mark]").length ?? 0).toBeGreaterThan(0);
  });

  it("stands the Bench down one pixel under the floor, and names the number", async () => {
    const body = 2 * BENCH_MAP_FLOOR + 2;
    await openTheBench(body);
    await put((BENCH_MAP_FLOOR - 1) / body);

    const said = theStandDown()?.textContent ?? "";
    expect(said, "no view named").toContain("The Bench");
    expect(said, "the floor is not the map-side number").toContain(
      `needs ${BENCH_MAP_FLOOR}px of map`,
    );
    expect(said).toContain(`this position gives ${BENCH_MAP_FLOOR - 1}px`);
    // The shell said it, so the column is not there saying nothing.
    expect(document.querySelector('[aria-label="The Bench"]')).toBeNull();
    // And nothing switched by itself on the way down.
    expect(readUi().view).toBe("bench");
  });
});
