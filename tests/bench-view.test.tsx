// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureNamed } from "../src/snapshot/fixtures";
import type { Model, Node } from "../src/snapshot/model.generated";
/*
 * `Bench.jsx` and not `Bench`, and the extension is load-bearing: macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Bench`
 * resolves to `bench.ts` — the arithmetic module, which exports a `Bench`
 * *type* — and the component is never found.
 */
import {
  Bench,
  beyondTheMapLabel,
  fanOutLabel,
  waitingOnLabel,
} from "../src/views/bench/Bench.jsx";
import { BENCH_WIDTH_FLOOR, CUT_PLATE_WIDTH } from "../src/views/bench/bench";
import { install } from "../src/keys/router";
import { collectStylesheets } from "./support/sources";

/**
 * The Bench, mounted.
 *
 * `tests/bench.test.ts` pins the arithmetic and none of it is restated here.
 * What this file asks is the other half: that every plate the layout answered
 * with reaches the DOM as a real element, that the model's own words arrive on
 * it unchanged, that the two blocker tallies stay two, that finished work stays
 * findable, and that the drawing is a pure function of the model — nothing
 * stored, nothing remembered, the same geometry twice.
 */

/* Same reason as `tests/route-view.test.tsx`: a suite that always warns is a
   suite whose warnings nobody reads. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

/**
 * Paint, or repaint the mount that is already there. Repainting is how *the
 * same model twice* is asked, so the second render has to land on the first
 * root rather than on a fresh one.
 */
async function paint(
  model: Model,
  selected: number | null = null,
  onSelect: (number: number | null) => void = () => {},
): Promise<HTMLElement> {
  if (mounted === null) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = { root: createRoot(host), host };
  }
  const { root, host } = mounted;

  routeKeys(selected, onSelect);

  await act(async () => {
    root.render(<Bench model={model} selected={selected} onSelect={onSelect} />);
  });

  return host;
}

/*
 * The plate's keys, where they live.
 *
 * `Enter` and `Space` are a row of the one chord to action table in
 * `src/keys/router.ts` — the view binds nothing, exactly as The Route and Deep
 * Field bind nothing — so a test that synthesises them has to stand up the same
 * router the app installs. What is spelled below is the app's own dispatch for
 * `open` and nothing more: the toggle, and the `preventDefault` that keeps
 * `Space` from scrolling the canvas, are the router's.
 */
let routing: (() => void) | null = null;

function routeKeys(selected: number | null, onSelect: (number: number | null) => void): void {
  routing?.();
  routing = install({
    press: (id, state) => {
      if (id !== "open" || state.focusedNode === null) return;
      onSelect(state.focusedNode === selected ? null : state.focusedNode);
    },
    release: () => {},
  });
}

function teardown() {
  routing?.();
  routing = null;
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(teardown);

/**
 * The map this view was built against: 28 children over five ranks, twenty of
 * them sources, one cut with a forty-word reason, one child nobody classified,
 * one spec, one blocker with no plate here, and a designated frontier.
 */
function wide(): Model {
  return fixtureNamed("wide-map").model;
}

function wideMap() {
  const map = wide().map;
  if (map === null) throw new Error("the wide fixture has no map");
  return map;
}

function plateFor(host: HTMLElement, number: number): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-node="${number}"]`);
  if (found === null) throw new Error(`no plate drawn for #${number}`);
  return found;
}

function all(host: HTMLElement, selector: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(selector)];
}

/** A coordinate the component wrote, read back off the element itself. */
function px(element: HTMLElement, side: "left" | "top" | "width"): number {
  return Number.parseFloat(element.style[side]);
}

function nodeNamed(number: number): Node {
  const found = wideMap().nodes.find((node) => node.number === number);
  if (found === undefined) throw new Error(`the wide fixture has no #${number}`);
  return found;
}

function press(element: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("every child is a plate, and the plate carries the model's own words", () => {
  it("draws one element per node, with the three claims kept apart", async () => {
    const model = wide();
    const host = await paint(model);
    const map = wideMap();

    expect(all(host, "[data-node]")).toHaveLength(map.nodes.length);

    for (const node of map.nodes) {
      const plate = plateFor(host, node.number);
      // The model's word, spelled and never re-derived.
      expect(plate.dataset.state).toBe(node.state);
      expect(plate.dataset.kind).toBe(node.kind.kind);
      // The view's own encoding, which is a different claim and may differ.
      expect(plate.dataset.mark).toBeDefined();
      expect(plate.tabIndex).toBe(0);
    }
  });

  it("marks exactly one plate designated, and carries the frontier's own number", async () => {
    const host = await paint(wide());
    const map = wideMap();
    if (map.frontier.frontier !== "designated") {
      throw new Error("the wide fixture no longer designates a frontier");
    }

    const designated = all(host, '[data-mark="designated"]');
    expect(designated).toHaveLength(1);
    expect(designated[0]?.dataset.node).toBe(String(map.frontier.number));

    // Verbatim, and on the one plate the map named.
    const flagged = all(host, "[data-frontier]");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.dataset.frontier).toBe(String(map.frontier.number));
  });

  it("keeps map.nodes order across a band that wrapped", async () => {
    const host = await paint(wide());

    /*
     * Rank 0 is the sources, and on this fixture a source is a node that waits
     * on nothing — derived from the model rather than from the layout, so this
     * asks the drawing and not the arithmetic that produced it.
     */
    const sources = wideMap()
      .nodes.filter((node) => node.waitsOn.length === 0)
      .map((node) => node.number);
    expect(sources.length).toBeGreaterThan(4);

    const laid = sources
      .map((number) => plateFor(host, number))
      .sort((one, other) => px(one, "top") - px(other, "top") || px(one, "left") - px(other, "left"));

    // Left to right and then down is the reading order, and the order it reads
    // in is the one the operator dragged into GitHub.
    expect(laid.map((plate) => Number(plate.dataset.node))).toEqual(sources);

    // And it really did wrap, or the assertion above is about one row.
    expect(new Set(laid.map((plate) => px(plate, "top"))).size).toBeGreaterThan(1);
  });
});

describe("a cut is a decoration on resolved, and its reason is on the plate", () => {
  it("gives the cut plate two plates of width and the reason as text", async () => {
    const host = await paint(wide());
    const cut = wideMap().nodes.find((node) => node.cut.cut === "fromScope");
    if (cut === undefined || cut.cut.cut !== "fromScope") {
      throw new Error("the wide fixture no longer cuts anything");
    }

    const plate = plateFor(host, cut.number);
    expect(px(plate, "width")).toBe(CUT_PLATE_WIDTH);
    expect(plate.dataset.cut).toBe("");

    // Still resolved, and still resolved in both claims: a cut is not a fifth
    // state beside the four.
    expect(plate.dataset.state).toBe("resolved");
    expect(plate.dataset.mark).toBe("resolved");

    const reason = plate.querySelector<HTMLElement>("[data-reason]");
    expect(reason?.textContent).toBe(cut.cut.reason);
  });

  it("hides nothing behind a pointer, anywhere on the canvas", async () => {
    const host = await paint(wide());

    // Rule 6 and rule 10 together: no ellipsised reason, no tooltip, nothing a
    // screenshot or a page search would miss.
    expect(host.querySelector("[title]")).toBeNull();
  });

  it("spends every hover on ink and on nothing that discloses", () => {
    /*
     * Rule 10's asserted floor walks the live CSSOM for `:hover` selectors
     * touching a disclosure property, and it reads the whole page — one
     * registered stylesheet carrying such a declaration turns the floor red for
     * every view at once. That floor needs a browser and cannot run on this
     * checkout, so this case is what stands between a hover that lifts, fades or
     * unfolds and a page-wide red nobody here can see go red.
     *
     * The list is restated by hand because the floor keeps its copy inside a
     * `page.evaluate` closure, which vitest cannot import. Its source is
     * `tests/conformance/support/rules.ts`; an edit there is an edit here.
     */
    const DISCLOSURE = [
      "display",
      "visibility",
      "opacity",
      "content",
      "height",
      "max-height",
      "width",
      "max-width",
      "clip-path",
      "transform",
    ];

    const sheet = collectStylesheets().find(
      (file) => file.path === "src/views/bench/Bench.module.css",
    );
    if (sheet === undefined) throw new Error("the bench stylesheet is no longer collected");

    // Comments talk about `:hover` and about `transform` at length; only what
    // the browser parses counts.
    const css = sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");

    const hovered: { selector: string; block: string }[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1] ?? "";
      if (selector.includes(":hover")) {
        hovered.push({ selector: selector.trim(), block: rule[2] ?? "" });
      }
    }

    // If the sheet stops hovering at all, this case has stopped guarding
    // anything and should say so rather than pass quietly.
    expect(hovered.length).toBeGreaterThan(0);

    for (const { selector, block } of hovered) {
      for (const property of DISCLOSURE) {
        const declared = new RegExp(`(^|[;{\\s])${property}\\s*:`).test(block);
        expect(`${selector} declares ${property}: ${declared}`).toBe(
          `${selector} declares ${property}: false`,
        );
      }
    }
  });
});

describe("fan-out is drawn, and the two blocker tallies are never one number", () => {
  it("prints how many wait on every plate", async () => {
    const host = await paint(wide());

    for (const plate of all(host, "[data-node]")) {
      expect(plate.querySelector("[data-fan-out]")).not.toBeNull();
    }

    // #224 is waited on by exactly one node on this map.
    expect(
      plateFor(host, 224).querySelector("[data-fan-out]")?.textContent,
    ).toBe(fanOutLabel(1));
  });

  it("counts a blocker this map holds apart from one it has never heard of", async () => {
    const host = await paint(wide());
    const plate = plateFor(host, 224);

    /*
     * #224 waits on five: one resolved, three still in the way, and #499, which
     * has no plate here at all. Three and one, and never four — a sum would be
     * this canvas asserting a state it has nothing on screen to back.
     */
    const waiting = nodeNamed(224).waitsOn;
    expect(waiting).toHaveLength(5);
    expect(plate.querySelector("[data-waiting-on]")?.textContent).toBe(waitingOnLabel(3));
    expect(plate.querySelector("[data-beyond-the-map]")?.textContent).toBe(
      beyondTheMapLabel(1),
    );
    expect(plate.textContent).not.toContain(waitingOnLabel(4));
  });

  it("draws no wire for a blocker that is not on this map", async () => {
    const host = await paint(wide());

    expect(all(host, "[data-edge]").length).toBeGreaterThan(0);
    expect(host.querySelector('[data-edge^="499-"]')).toBeNull();
    expect(host.querySelector('[data-edge$="-499"]')).toBeNull();

    // The wires restate what the plates already say in words, so they are not
    // read out a second time.
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("what recedes is salience, never visibility", () => {
  it("leaves resolved plates on the canvas, hit-testable and focusable", async () => {
    const host = await paint(wide());
    const resolved = all(host, '[data-mark="resolved"]');

    expect(resolved.length).toBeGreaterThan(0);
    for (const plate of resolved) {
      expect(plate.tabIndex).toBe(0);
      expect(plate.hasAttribute("hidden")).toBe(false);
      expect(plate.getAttribute("aria-hidden")).toBeNull();
      // The coordinate is still a coordinate on the canvas.
      expect(Number.isFinite(px(plate, "top"))).toBe(true);
    }
  });

  it("spends the resolved block on ink and on nothing that reduces visibility", () => {
    const sheet = collectStylesheets().find(
      (file) => file.path === "src/views/bench/Bench.module.css",
    );
    const block = /\.plate\[data-mark="resolved"\]\s*\{([^}]*)\}/.exec(sheet?.text ?? "")?.[1];
    if (block === undefined) throw new Error("the stylesheet no longer marks resolved");

    for (const banned of ["opacity", "display", "visibility", "content-visibility"]) {
      expect(block).not.toContain(banned);
    }
  });
});

describe("a child nobody classified is visible, named, and never offered", () => {
  it("says the word on the plate and withholds the frontier's hook", async () => {
    const host = await paint(wide());
    const stray = wideMap().nodes.find((node) => node.kind.kind === "unclassified");
    if (stray === undefined) throw new Error("the wide fixture classifies everything");

    const plate = plateFor(host, stray.number);
    expect(plate.dataset.mark).toBe("unclassified");
    expect(plate.querySelector("[data-unclassified]")?.textContent).toBe("unclassified");

    // Selectable, because selecting is not starting — and never designated,
    // whatever the frontier says.
    expect(plate.tabIndex).toBe(0);
    expect(plate.hasAttribute("data-frontier")).toBe(false);
  });
});

describe("selection is one answer, and picking it twice puts it back", () => {
  it("selects on a click and deselects on the next one", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(wide(), null, (number) => picked.push(number));

    click(plateFor(host, 204));
    expect(picked).toEqual([204]);

    // The same plate, now drawn as the selected one.
    await paint(wide(), 204, (number) => picked.push(number));
    const chosen = plateFor(host, 204);
    expect(chosen.dataset.selected).toBe("");
    expect(chosen.getAttribute("aria-current")).toBe("true");

    click(chosen);
    expect(picked).toEqual([204, null]);
  });

  it("activates on Enter and on Space, and Space does not scroll the canvas", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(wide(), null, (number) => picked.push(number));

    // The hook the router resolves a pickable row by, worn by the plate for
    // the same reason The Route's rows wear it.
    expect(plateFor(host, 204).getAttribute("data-node-row")).toBe("204");

    expect(press(plateFor(host, 204), "Enter")).toBe(true);
    expect(press(plateFor(host, 204), " ")).toBe(true);
    expect(picked).toEqual([204, 204]);

    // Anything else is somebody else's key.
    expect(press(plateFor(host, 204), "a")).toBe(false);
    expect(picked).toEqual([204, 204]);
  });
});

describe("nothing is remembered between two looks", () => {
  it("writes no coordinate to the store", async () => {
    const wrote = vi.spyOn(Storage.prototype, "setItem");

    await paint(wide());
    await paint(wide(), 204);

    expect(wrote).not.toHaveBeenCalled();
    wrote.mockRestore();
  });

  it("draws the same model twice in the same place", async () => {
    const geometry = async (): Promise<string[]> => {
      const host = await paint(wide());
      return all(host, "[data-node]").map(
        (plate) =>
          `${plate.dataset.node}@${plate.style.left},${plate.style.top},${plate.style.width}`,
      );
    };

    const first = await geometry();
    const second = await geometry();

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("the emptiest states, and the window it cannot draw in", () => {
  it("draws the maps with nothing on them rather than throwing", async () => {
    for (const model of [fixtureNamed("empty-map").model, { map: null } as Model]) {
      const host = await paint(model);
      expect(all(host, "[data-node]")).toHaveLength(0);
    }
  });

  it("draws a map that closes a cycle", async () => {
    const host = await paint(fixtureNamed("awkward-map").model);
    const map = fixtureNamed("awkward-map").model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    expect(all(host, "[data-node]")).toHaveLength(map.nodes.length);
  });

  it("stands down below its floor and says what it needed", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });

    try {
      const host = await paint(wide());

      expect(all(host, "[data-node]")).toHaveLength(0);
      expect(host.textContent).toContain(String(BENCH_WIDTH_FLOOR));
      // The number the operator is being asked to change, not an apology.
      expect(host.textContent).toMatch(/\d+px/);
    } finally {
      if (original === undefined) {
        delete (window as unknown as { innerWidth?: number }).innerWidth;
      } else {
        Object.defineProperty(window, "innerWidth", original);
      }
    }
  });
});
