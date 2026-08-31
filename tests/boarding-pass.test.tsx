// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { PANEL_HEADING } from "../src/detail/detail";
import { DOCKS, DOCK_NAMES, DOCK_PRESSES, type Dock } from "../src/detail/docks";
import { fractionOf } from "../src/panes/dial";
import { chooseDock, moveDial, readUi, select } from "../src/stores/ui";
import { forgetStow } from "../src/terminal/reparent";

/**
 * The boarding pass, in the real shell.
 *
 * `tests/docks.test.ts` pins the arithmetic of *where*; this pins what the
 * window does with it. The claims are the ones an operator would notice going
 * wrong: there is exactly one panel in the document at every moment, the node
 * that arrives at a dock is the *same object* that left the last one, the
 * scroll offset comes with it, the selection it prints is untouched by the
 * move, and no dock is ever a blank box.
 *
 * What is asserted about survival is node identity and scroll offset. Whether a
 * live *text selection* survives an `appendChild` move is the browser's own
 * behaviour and jsdom has no layout to exercise it with — it is claimed in prose
 * on the pass in `src/App.tsx` and nowhere faked into an assertion here.
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

afterEach(() => {
  teardown();
  chooseDock("spine");
  select(null);
  moveDial(fractionOf("split"));
  forgetStow();
  window.localStorage.clear();
});

/** Every panel in the document. There may only ever be one. */
const panels = () => document.querySelectorAll(`[aria-label="${PANEL_HEADING}"]`);
const thePanel = () => panels()[0] ?? null;
/** The pass: the box the panel is rendered into, and the box that moves. */
const thePass = () => thePanel()?.parentElement ?? null;
const theDock = (dock: Dock) => document.querySelector(`[data-dock="${dock}"]`);
/** Where the pass actually is, read off the document rather than the store. */
const holding = (): Dock | null =>
  DOCKS.find((dock) => theDock(dock)?.contains(thePanel() ?? null) === true) ?? null;

/** The press on a dock that has not got the pass. */
function pressOn(dock: Dock): HTMLButtonElement {
  const buttons = Array.from(theDock(dock)?.querySelectorAll("button") ?? []);
  const press = buttons.find((button) => button.textContent === DOCK_PRESSES[dock]);
  if (press === undefined) throw new Error(`no press on ${dock}`);
  return press as HTMLButtonElement;
}

async function send(dock: Dock): Promise<void> {
  await act(async () => pressOn(dock).click());
}

async function put(position: number): Promise<void> {
  await act(async () => moveDial(position));
}

describe("one panel, three docks, never unmounted", () => {
  it("starts on the spine with exactly one panel in the document", async () => {
    await boot();

    expect(panels()).toHaveLength(1);
    expect(holding()).toBe("spine");
  });

  it("carries the same node — and its scroll offset — through all three docks", async () => {
    await boot();

    const panel = thePanel();
    const pass = thePass();
    expect(pass).not.toBeNull();
    // A scroll the operator made. jsdom has no layout, but it does keep the
    // number, which is enough to tell *the same scroller travelled* from *a new
    // one was built at the far end*.
    pass!.scrollTop = 40;

    for (const dock of ["runBar", "rack", "spine"] as const) {
      await send(dock);

      expect(holding()).toBe(dock);
      // Identity, not text: two renderings of the same fields would pass a
      // `textContent` check and would still be two panels.
      expect(thePanel()).toBe(panel);
      expect(thePass()).toBe(pass);
      expect(pass!.scrollTop).toBe(40);
      expect(panels()).toHaveLength(1);
    }
  });

  it("prints the same selection after a re-dock as before one", async () => {
    await boot();
    // A row that is not on this map: the panel's *selection is gone* branch,
    // which is a state with words in it and one the store alone decides.
    await act(async () => select(999_999));

    const before = thePanel()?.getAttribute("data-panel");
    const selection = readUi().selection;

    await send("rack");

    expect(thePanel()?.getAttribute("data-panel")).toBe(before);
    // The panel writes nothing. A panel with an opinion of its own about what
    // is selected would be a second answer to a question that has one.
    expect(readUi().selection).toBe(selection);
  });
});

describe("a dock without the pass says where it went", () => {
  it("names the occupant on both of the other two, in every state", async () => {
    await boot();

    // Starting on the spine, so the spine is pressed last rather than first:
    // the dock that already has the pass shows the pass and not a press.
    for (const dock of ["runBar", "rack", "spine"] as const) {
      await send(dock);

      for (const empty of DOCKS.filter((other) => other !== dock)) {
        expect(theDock(empty)?.textContent).toContain(DOCK_NAMES[dock]);
      }
    }
  });

  it("offers a keyboard-reachable press on every dock that has not got it", async () => {
    await boot();
    await send("runBar");

    for (const empty of ["spine", "rack"] as const) {
      const press = pressOn(empty);
      expect(press.tagName).toBe("BUTTON");
      expect(press.type).toBe("button");
    }
  });
});

describe("a collapsed dock lends the pass back rather than hiding it", () => {
  it("borrows it onto the spine at the map detent, and says why", async () => {
    await boot();
    await send("rack");
    expect(holding()).toBe("rack");

    // The `map` detent: the terminal side is worth no pixels and clips its own
    // overflow, so a pass left on the rack would be invisible with nothing said.
    await put(fractionOf("map"));

    expect(holding()).toBe("spine");
    expect(panels()).toHaveLength(1);
    expect(theDock("spine")?.textContent).toContain(DOCK_NAMES.rack);
    // The press is what was kept. Nothing automatic rewrote it.
    expect(readUi().dock).toBe("rack");
  });

  it("springs back to the chosen dock when the width returns", async () => {
    await boot();
    await send("rack");
    const panel = thePanel();

    await put(fractionOf("map"));
    await put(fractionOf("split"));

    expect(holding()).toBe("rack");
    expect(thePanel()).toBe(panel);
    expect(panels()).toHaveLength(1);
  });
});
