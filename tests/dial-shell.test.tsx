// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { DETENTS, fractionOf, type Detent } from "../src/panes/dial";
import { monitor, moveDial, readUi } from "../src/stores/ui";

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

  it("leaves the terminal mounted even where it is worth no pixels", async () => {
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
