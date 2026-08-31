// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map, Model, Node } from "../src/snapshot/model.generated";
/*
 * `DeepField.jsx` and not `DeepField`, and the extension is load-bearing. macOS
 * and Windows filesystems are case-insensitive, so an extensionless
 * `./DeepField` resolves to `deepField.ts` — the arithmetic module — and the
 * component is never found. The `.jsx` specifier maps to `DeepField.tsx` under
 * bundler resolution and matches only that file.
 */
import { DeepField } from "../src/views/deep-field/DeepField.jsx";
import {
  FOG_HEADING,
  GUTTER_CLEARANCE,
  NOBODY_SURVEYED,
  PLATE_WIDTH,
  VIEW_NAME,
} from "../src/views/deep-field/deepField";
import { REPO_ROOT } from "./support/sources";

/**
 * Deep Field, mounted.
 *
 * `tests/deep-field.test.ts` pins the geometry; this pins the picture drawn
 * from it. The claims under test are the ones the encoding rules make about
 * this view and nothing else: that no word is ever drawn in the field, that no
 * mark ever reaches into the gutter at any n the repo has a fixture for, that
 * the stand-down keeps the operator's three numbers alive and offers no way
 * out, and that the same model at the same width answers with the same DOM.
 *
 * Nothing here asserts a coordinate the layout chose. Where a number is
 * checked, it is checked against another number in the same document — the
 * viewBox the marks are drawn into, the clearance the gutter reserves — because
 * a test that re-runs the layout to confirm the layout confirms nothing.
 */

/* Same reason as `tests/route-view.test.tsx`: a suite that always warns is a
   suite whose warnings nobody reads. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * The width the view measures itself at.
 *
 * `getBoundingClientRect` answers zero for everything in jsdom, so the view
 * falls back to the window — which is exactly the fallback that makes a first
 * paint honest in the browser, and is what lets a test say *this pane is 320px
 * wide* without a layout engine.
 */
const AMPLE = 4000;

function widthIs(pixels: number) {
  Object.defineProperty(window, "innerWidth", { value: pixels, configurable: true });
}

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

  await act(async () => {
    root.render(<DeepField model={model} selected={selected} onSelect={onSelect} />);
  });

  return host;
}

function teardown() {
  widthIs(AMPLE);
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(teardown);
widthIs(AMPLE);

/* --------------------------------------------------------------- maps --- */

function node(number: number, over: Partial<Node> = {}): Node {
  return {
    number,
    title: `Ticket ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    kind: { kind: "ticket", type: "task" },
    state: "takeable",
    waitsOn: [],
    boundElsewhere: false,
    cut: { cut: "inScope" },
    ...over,
  };
}

function mapOf(nodes: readonly Node[], over: Partial<Map> = {}): Map {
  return {
    number: 28,
    title: "Spec: perseverance",
    closed: false,
    phase: "wayfinding",
    counts: { tickets: nodes.length, open: nodes.length, specs: 0 },
    nodes: [...nodes],
    frontier: { frontier: "nothingToStart" },
    fog: { fog: "unsurveyed" },
    ...over,
  };
}

function modelOf(nodes: readonly Node[], over: Partial<Map> = {}): Model {
  return { map: mapOf(nodes, over) };
}

function view(host: HTMLElement): HTMLElement {
  const section = host.querySelector<HTMLElement>("section[aria-label='Deep Field']");
  if (section === null) throw new Error("the view drew no root section");
  return section;
}

function fieldPlot(host: HTMLElement): SVGSVGElement {
  const svg = host.querySelector<SVGSVGElement>("svg[data-field]");
  if (svg === null) throw new Error("the view drew no field");
  return svg;
}

/** Where the field's own coordinate space starts, read out of the document. */
function fieldOrigin(svg: SVGSVGElement): number {
  const box = (svg.getAttribute("viewBox") ?? "").split(/\s+/);
  const origin = Number(box[0]);
  if (!Number.isFinite(origin)) throw new Error("the field has no viewBox origin");
  return origin;
}

/* ------------------------------------------------------------ the split --- */

describe("the words are in the lane and the field has none", () => {
  it("keeps every mark clear of the gutter, on every fixture there is", async () => {
    let drawn = 0;
    let marked = 0;

    for (const name of FIXTURE_NAMES) {
      const model = FIXTURES[name].model;
      if (model.map === null) continue;

      const host = await paint(model);
      const svg = host.querySelector<SVGSVGElement>("svg[data-field]");
      if (svg === null) continue;
      drawn += 1;

      /*
       * The one number this asserts against is in the same document: the field
       * starts where its viewBox says it does, and the boundary plus the
       * clearance is where the layout says that is. A mark's left edge — its
       * centre less its radius, because a disc is not a point — may not be left
       * of it, at any n.
       */
      const origin = fieldOrigin(svg);
      expect(origin).toBe(PLATE_WIDTH + GUTTER_CLEARANCE);

      const gutter = host.querySelector<HTMLElement>("[data-gutter]");
      expect(gutter?.style.width).toBe(`${GUTTER_CLEARANCE}px`);

      const marks = [...svg.querySelectorAll("circle")];
      marked += marks.length;
      for (const mark of marks) {
        const centre = Number(mark.getAttribute("cx"));
        const radius = Number(mark.getAttribute("r"));
        expect(centre - radius).toBeGreaterThanOrEqual(origin);
      }
    }

    /* A sweep that drew nothing would pass saying nothing. A map with a field
       and no marks in it is a real fixture — the empty map — so the floor is on
       the sweep rather than on each pass through it. */
    expect(drawn).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(0);
  });

  it("writes no text of any kind into the field", async () => {
    for (const name of FIXTURE_NAMES) {
      const model = FIXTURES[name].model;
      if (model.map === null) continue;

      const host = await paint(model);
      const svg = host.querySelector<SVGSVGElement>("svg[data-field]");
      if (svg === null) continue;

      /*
       * `textContent` and a walk, because they fail differently: a `<title>` or
       * a `<desc>` would show up in the first, and a bare text node between two
       * shapes would show up in the second. Rule 11 is that neither exists.
       */
      expect(svg.textContent).toBe("");
      const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
      expect(walker.nextNode()).toBeNull();
    }
  });

  it("puts the node number on the plate and never on the mark", async () => {
    const host = await paint(modelOf([node(1), node(2, { waitsOn: [1] })]));

    // One element per node, and it is the plate: a mark answering the same
    // selector would double every row a later reader counted.
    expect(view(host).querySelectorAll("[data-node]")).toHaveLength(2);
    expect(fieldPlot(host).querySelectorAll("[data-node]")).toHaveLength(0);
    expect(fieldPlot(host).querySelectorAll("[data-mark-node]")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------- fan-out --- */

describe("the fan-out is drawn, including the edge the ranker refused", () => {
  it("draws one path per edge and marks the back edge as the circular one", async () => {
    /*
     * 1 unblocks 2; 2 and 3 wait on each other, which is the cycle GitHub will
     * happily present. Three edges: two forwards and the one that closes the
     * cycle, which is refused a rank and drawn anyway — a picture with the
     * cause of its own shape left out is a picture with no explanation in it.
     */
    const host = await paint(
      modelOf([node(1), node(2, { waitsOn: [1, 3] }), node(3, { waitsOn: [2] })]),
    );
    const svg = fieldPlot(host);

    expect(svg.querySelectorAll("path")).toHaveLength(3);
    expect(svg.querySelectorAll("path[data-circular]").length).toBeGreaterThan(0);

    // Every path is a cubic with two handles, which is the routing the layout
    // hands over; nothing here re-derives it, but a path with no curve in it
    // would mean the bend never reached the document.
    for (const path of svg.querySelectorAll("path")) {
      expect(path.getAttribute("d")).toMatch(/^M [\d.-]+ [\d.-]+ C /);
    }
  });

  it("draws no edge for a blocker with no row here, and says so on the plate", async () => {
    const host = await paint(modelOf([node(1, { waitsOn: [99] })]));

    expect(fieldPlot(host).querySelectorAll("path")).toHaveLength(0);
    expect(view(host).textContent).toContain("no row here");
  });
});

/* ----------------------------------------------------------- stand-down --- */

describe("the stand-down keeps the answer alive and offers no way out", () => {
  it("says which view, why, what it needs and what it has", async () => {
    widthIs(320);
    const host = await paint(modelOf([node(1), node(2, { waitsOn: [1] })]));

    const notice = view(host).querySelector<HTMLElement>("[data-stand-down]");
    expect(notice).not.toBeNull();
    expect(host.querySelector("svg[data-field]")).toBeNull();

    expect(notice?.textContent).toContain(VIEW_NAME);
    expect(notice?.querySelector("[data-needs]")?.textContent).toMatch(/needs \d+px/);
    expect(notice?.querySelector("[data-has]")?.textContent).toBe("has 320px");
  });

  it("keeps the three counts and the frontier when the graph is gone", async () => {
    widthIs(320);
    const host = await paint(
      modelOf([node(1), node(2, { waitsOn: [1] })], {
        counts: { tickets: 2, open: 1, specs: 3 },
        frontier: { frontier: "designated", number: 1 },
      }),
    );
    const notice = view(host).querySelector<HTMLElement>("[data-stand-down]");

    expect(notice?.querySelector("[data-count-of='tickets']")?.textContent).toBe("2");
    expect(notice?.querySelector("[data-count-of='open']")?.textContent).toBe("1");
    expect(notice?.querySelector("[data-count-of='specs']")?.textContent).toBe("3");
    expect(notice?.querySelector("[data-frontier-reading]")?.textContent).toBe("#1");
  });

  it("offers no exit, because widening and switching are the shell's", async () => {
    widthIs(320);
    const host = await paint(modelOf([node(1), node(2, { waitsOn: [1] })]));

    /*
     * Nothing clickable, nothing focusable, nothing a pointer could take for an
     * offer. A second set of controls here would be two controls for one move,
     * and the one an operator reached for would be the one that did the least.
     */
    expect(
      view(host).querySelectorAll(
        "button, a, input, select, textarea, [role='button'], [role='link'], [tabindex]",
      ),
    ).toHaveLength(0);
  });

  it("is a fact about this map and moves with it", async () => {
    /* Three ranks need two column pitches more than one rank does, and no
       constant on the shell's side can say that. */
    widthIs(500);
    const deep = await paint(
      modelOf([node(1), node(2, { waitsOn: [1] }), node(3, { waitsOn: [2] })]),
    );
    expect(deep.querySelector("[data-stand-down]")).not.toBeNull();

    const flat = await paint(modelOf([node(1), node(2), node(3)]));
    expect(flat.querySelector("[data-stand-down]")).toBeNull();
    expect(flat.querySelector("svg[data-field]")).not.toBeNull();
  });
});

/* ----------------------------------------------------------------- fog --- */

describe("absence is never zero, and the region names itself", () => {
  it("stands a dash where a numeral would go, and draws no body", async () => {
    const host = await paint(modelOf([node(1)], { fog: { fog: "unsurveyed" } }));
    const fog = view(host).querySelector<HTMLElement>("[data-fog]");

    expect(fog?.getAttribute("data-fog")).toBe("unsurveyed");
    expect(fog?.querySelector("[data-unsurveyed]")?.textContent).toBe(NOBODY_SURVEYED);
    expect(fog?.querySelector("[data-count]")).toBeNull();
    // The heading and nothing under it: the second difference from a surveyed
    // region, so the two are told apart by shape and not by a character.
    expect(fog?.children).toHaveLength(1);
    expect(fog?.textContent).toContain(FOG_HEADING);
  });

  it("draws a numeral and always a body when somebody did survey", async () => {
    const host = await paint(
      modelOf([node(1)], {
        fog: { fog: "surveyed", region: { count: 0, text: "" } },
      }),
    );
    const fog = view(host).querySelector<HTMLElement>("[data-fog]");

    expect(fog?.getAttribute("data-fog")).toBe("surveyed");
    expect(fog?.querySelector("[data-count]")?.textContent).toBe("0");
    expect(fog?.querySelector("[data-unsurveyed]")).toBeNull();
    expect(fog?.children.length).toBeGreaterThan(1);
    expect(fog?.textContent).toContain(FOG_HEADING);
  });

  it("counts three numerals for progress and draws nothing continuous", async () => {
    const host = await paint(
      modelOf([node(1)], { counts: { tickets: 9, open: 4, specs: 1 } }),
    );
    const progress = view(host).querySelector<HTMLElement>("[data-progress]");

    expect(progress?.querySelectorAll("[data-count-of]")).toHaveLength(3);
    // No hairline, no track, no bar: three entries and nothing between them.
    expect(progress?.children).toHaveLength(3);
  });
});

/* --------------------------------------------------------------- plates --- */

describe("what a plate carries", () => {
  it("copies the frontier verbatim onto exactly one plate", async () => {
    const host = await paint(
      modelOf([node(1), node(2), node(3)], {
        frontier: { frontier: "designated", number: 2 },
      }),
    );

    const designated = [...view(host).querySelectorAll("[data-frontier]")];
    expect(designated).toHaveLength(1);
    expect(designated[0]?.getAttribute("data-node")).toBe("2");
    expect(designated[0]?.textContent).toContain("designated");
  });

  it("says unclassified in words, so the fail-safe survives a retheme", async () => {
    const host = await paint(modelOf([node(1, { kind: { kind: "unclassified" } })]));
    const plate = view(host).querySelector<HTMLElement>("[data-node='1']");

    expect(plate?.getAttribute("data-kind")).toBe("unclassified");
    expect(plate?.textContent).toContain("unclassified");
    // Never the offer: the one answer to *may this be started* is the frontier,
    // and it named nothing here.
    expect(plate?.hasAttribute("data-frontier")).toBe(false);
  });

  it("shows a cut's reason as text, with nothing behind a hover", async () => {
    const reason = "superseded by the socket rewrite";
    const host = await paint(
      modelOf([
        node(1, { state: "resolved", cut: { cut: "fromScope", reason } }),
      ]),
    );
    const plate = view(host).querySelector<HTMLElement>("[data-node='1']");

    expect(plate?.hasAttribute("data-cut")).toBe(true);
    expect(plate?.textContent).toContain(reason);
    // A reason a pointer has to find is a reason a screenshot, a search and a
    // reader do not have. `title` is not permitted to carry it.
    expect(view(host).querySelectorAll("[title]")).toHaveLength(0);
    // A cut ticket is a decoration on resolved and stays resolved.
    expect(plate?.getAttribute("data-state")).toBe("resolved");
  });

  it("leaves a resolved plate visible, focusable and unfaded", async () => {
    const host = await paint(modelOf([node(1, { state: "resolved" })]));
    const plate = view(host).querySelector<HTMLElement>("[data-state='resolved']");

    expect(plate).not.toBeNull();
    expect(plate?.tabIndex).toBe(0);
    expect(window.getComputedStyle(plate as HTMLElement).opacity).not.toBe("0");

    /*
     * And in the stylesheet, which is where receding would actually be written.
     * Rule 13 is that resolved recedes in salience and never in visibility, so
     * the resolved block is held to reassigning ink and nothing else — an
     * `opacity`, a `display`, a `visibility` or a `content-visibility` arriving
     * in it fails here before anybody has to notice a plate went missing.
     */
    const sheet = readFileSync(
      join(REPO_ROOT, "src/views/deep-field/DeepField.module.css"),
      "utf8",
    );
    const block = /\.plate\[data-state="resolved"\]\s*\{([^}]*)\}/.exec(sheet)?.[1];
    if (block === undefined) throw new Error("the stylesheet has no resolved block");
    expect(block).not.toMatch(/opacity|display|visibility/);
  });

  it("hands a selection out and takes it back, and holds none of it", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(modelOf([node(1), node(2)]), null, (number) =>
      picked.push(number),
    );

    const plate = view(host).querySelector<HTMLElement>("[data-node='2']");
    await act(async () => plate?.click());
    expect(picked).toEqual([2]);

    // Nothing moved on its own: the choice arrives back through the prop.
    expect(plate?.hasAttribute("data-selected")).toBe(false);

    const chosen = await paint(modelOf([node(1), node(2)]), 2, (number) =>
      picked.push(number),
    );
    const again = view(chosen).querySelector<HTMLElement>("[data-node='2']");
    expect(again?.getAttribute("aria-current")).toBe("true");

    // Picking the plate you already picked puts it back.
    await act(async () => again?.click());
    expect(picked).toEqual([2, null]);
  });

  it("selects from the keyboard, and stops Space scrolling the lane", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(modelOf([node(1)]), null, (number) => picked.push(number));
    const plate = view(host).querySelector<HTMLElement>("[data-node='1']");

    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => {
        plate?.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(picked).toEqual([1, 1]);
  });
});

/* ------------------------------------------------------- no memory at all --- */

describe("the view remembers nothing", () => {
  it("writes no position, and no anything, to storage", async () => {
    const wrote = vi.spyOn(Storage.prototype, "setItem");
    try {
      await paint(modelOf([node(1), node(2, { waitsOn: [1] })]));
      widthIs(320);
      await paint(modelOf([node(1), node(2, { waitsOn: [1] })]));
      expect(wrote).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
    } finally {
      wrote.mockRestore();
    }
  });

  it("answers the same map at the same width with the same document", async () => {
    const nodes = [
      node(1, { state: "resolved" }),
      node(2, { waitsOn: [1], state: "claimed" }),
      node(3, { waitsOn: [1, 2] }),
      node(4, { kind: { kind: "spec" } }),
    ];

    const first = (await paint(modelOf(nodes))).innerHTML;
    const second = (await paint(modelOf(nodes))).innerHTML;
    expect(second).toBe(first);
  });

  it("says the map is not open rather than drawing an empty one", async () => {
    const host = await paint({ map: null });

    expect(view(host).textContent).toContain("no map open");
    expect(host.querySelector("svg[data-field]")).toBeNull();
  });
});
