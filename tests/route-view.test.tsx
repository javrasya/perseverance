// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Map, Model } from "../src/snapshot/model.generated";
import { NO_MAP_OPEN } from "../src/snapshot/readout";
/*
 * `Route.jsx` and not `Route`, and the extension is load-bearing. macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Route`
 * resolves to `route.ts` — the arithmetic module, which exports a `Route`
 * *type* — and the component is never found. The `.jsx` specifier maps to
 * `Route.tsx` under bundler resolution and matches only that file. Anything
 * importing this component has to spell it the same way.
 */
import { Route, upstreamLinks } from "../src/views/route/Route.jsx";
import {
  BEYOND_THE_MAP,
  UNSETTLED_NOTE,
  routeOf,
  type RouteEdge,
} from "../src/views/route/route";
import { collect } from "./support/sources";

/**
 * The Route, mounted.
 *
 * `tests/route.test.ts` pins the arithmetic; this pins the picture. The claim
 * under test is that the second is a pure function of the first — so what is
 * asserted here is that every coordinate on screen came back from `routeOf`,
 * that the four states and the one frontier are the model's answers carried
 * verbatim, and that the fan-out the Route declines to draw is a thing a test
 * can catch it drawing. A deviation nobody can fail is a deviation nobody
 * declared.
 */

/* Same reason as `tests/dev-web.test.tsx`: a suite that always warns is a suite
   whose warnings nobody reads. */
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

  await act(async () => {
    root.render(<Route model={model} selected={selected} onSelect={onSelect} />);
  });

  return host;
}

function teardown() {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(teardown);

function awkward(): Map {
  const map = FIXTURES["awkward-map"].model.map;
  if (map === null) throw new Error("the awkward fixture has no map");
  return map;
}

function edge(before: number, after: number): RouteEdge {
  return { before, after };
}

/**
 * The awkward map, waiting on exactly these edges.
 *
 * The component takes a model and derives its picture from that alone, so an
 * edge set under test is painted rather than passed — which is the point: the
 * three sentences the Route says about edges it cannot rank are reachable from
 * the component's own API and can therefore be failed from it.
 */
function mapWaitingOn(edges: readonly RouteEdge[]): Map {
  const map = awkward();
  return {
    ...map,
    nodes: map.nodes.map((node) => ({
      ...node,
      waitsOn: edges.filter((one) => one.after === node.number).map((one) => one.before),
    })),
  };
}

function waitingOn(edges: readonly RouteEdge[]): Model {
  return { map: mapWaitingOn(edges) };
}

function nodeFor(host: HTMLElement, number: number): Element {
  const found = host.querySelector(`[data-node="${number}"]`);
  if (found === null) throw new Error(`no node drawn for #${number}`);
  return found;
}

function all(host: HTMLElement, selector: string): Element[] {
  return [...host.querySelectorAll(selector)];
}

async function fire(target: Element, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

describe("the four states and the one frontier are the model's answers, drawn", () => {
  it("draws all four states, each spelled as well as styled", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const states = all(host, "[data-node]").map((el) => el.getAttribute("data-state"));

    expect(new Set(states)).toEqual(
      new Set(["resolved", "blocked", "claimed", "takeable"]),
    );
    // The palette is neutrals and one indigo, so the word is not decoration.
    expect(host.textContent).toContain("blocked");
    expect(host.textContent).toContain("claimed");
  });

  it("marks exactly one frontier, and it is the number the model named", async () => {
    const map = awkward();
    const host = await paint(FIXTURES["awkward-map"].model);
    const marked = all(host, "[data-frontier]");

    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute("data-node")).toBe(String(map.frontier));
  });

  it("leaves the takeable spec children takeable and unmarked", async () => {
    /*
     * Three nodes here are takeable and one of them is the frontier. A view
     * that marked the first takeable node would answer *what next* three times,
     * which is the failure the singular frontier exists to prevent.
     */
    const map = awkward();
    const host = await paint(FIXTURES["awkward-map"].model);
    const specs = map.nodes.filter((node) => node.kind.kind === "spec");

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      const drawn = nodeFor(host, spec.number);
      expect(drawn.getAttribute("data-state")).toBe("takeable");
      expect(drawn.getAttribute("data-kind")).toBe("spec");
      expect(drawn.hasAttribute("data-frontier")).toBe(false);
    }
  });

  it("is the chrome's own words when there is no map, and nothing else", async () => {
    const host = await paint(FIXTURES["no-map-open"].model);

    expect(host.textContent).toBe(NO_MAP_OPEN);
    expect(host.querySelector("svg")).toBeNull();
  });
});

describe("what a node opens up is a number on the node", () => {
  /**
   * ADR 0005's decision, in the document rather than in prose: `unlocks N` is
   * the whole of what the Route says about downstream. Asserted on the mounted
   * component and from the model alone, so deleting the text element fails
   * here.
   */
  it("puts the count on the node the model's own edges opened up", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    // #72 holds up #71, and nothing else on this map holds up more than one.
    expect(nodeFor(host, 72).textContent).toContain("unlocks 1");
    expect(nodeFor(host, 75).textContent).toContain("unlocks 1");
  });

  it("counts a fan rather than drawing one", async () => {
    const host = await paint(waitingOn([edge(70, 74), edge(70, 72)]));

    expect(nodeFor(host, 70).textContent).toContain("unlocks 2");
    // Two things opened up, and no line leaving the node that opened them.
    expect(all(host, "[data-link]")).toEqual([]);
  });

  it("spends no ink on a node that opens nothing up", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    expect(nodeFor(host, 70).textContent).not.toContain("unlocks");
    expect(host.textContent).not.toContain("unlocks 0");
  });
});

describe("a ranking the map cannot justify says so above the picture", () => {
  it("says the tickets wait on each other when the fixture's own edges close a cycle", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    // #71 waits on #72, which waits on #75, which waits on #71. There is no
    // longest path through that, so the columns around it are a guess.
    expect(host.textContent).toContain(UNSETTLED_NOTE);
  });

  it("says a ticket waits on something that has no row here", async () => {
    const host = await paint(waitingOn([edge(999, 74)]));

    expect(host.textContent).toContain(BEYOND_THE_MAP);
    // The edge is real and the row is not, so nothing is drawn to nowhere.
    expect(all(host, "[data-node]")).toHaveLength(awkward().nodes.length);
  });

  it("says neither of them about a graph that ranks cleanly", async () => {
    const host = await paint(waitingOn([edge(70, 74), edge(74, 77)]));

    expect(host.textContent).not.toContain(UNSETTLED_NOTE);
    expect(host.textContent).not.toContain(BEYOND_THE_MAP);
  });
});

describe("intra-rank order reaches the document in map order", () => {
  it("draws the nodes of every rank in the order the operator arranged them", async () => {
    const map = awkward();
    const host = await paint(FIXTURES["awkward-map"].model);
    const inMapOrder = map.nodes.map((node) => node.number);
    const ranks = all(host, "[data-rank]").map((rank) =>
      [...rank.querySelectorAll("[data-node]")].map((el) =>
        Number(el.getAttribute("data-node")),
      ),
    );

    // Non-monotonic on purpose: a numeric sort anywhere fails this line, and a
    // crossing-minimiser fails it by moving a row the operator arranged.
    expect(ranks).toEqual([[70, 73, 74, 77, 75, 76], [72], [71]]);
    for (const drawn of ranks) {
      expect(drawn).toEqual(inMapOrder.filter((number) => drawn.includes(number)));
    }
  });
});

describe("the fan-out the Route declines to draw", () => {
  /**
   * The declaration in `Route.tsx`'s doc comment and in ADR 0005, made
   * falsifiable. Prose cannot fail; this can.
   */
  it("draws no link at all with nothing selected", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    expect(all(host, "[data-link]")).toEqual([]);
  });

  it("draws no link downstream of the node that is selected", async () => {
    const edges = [edge(70, 74), edge(70, 72), edge(74, 77)];
    const host = await paint(waitingOn(edges), 74);

    // #74 waits on one thing and opens up another. Only the wait is drawn —
    // and the link says which pair it joins, so this cannot pass by counting.
    expect(all(host, "[data-link]").map((el) => el.getAttribute("data-link"))).toEqual([
      "70-74",
    ]);
  });

  it("computes every link and hands the view only the upstream ones", () => {
    /* The same claim under the DOM: the layout knows all three edges, and the
       filter is what declines to draw two of them. */
    const edges: RouteEdge[] = [edge(70, 74), edge(70, 72), edge(74, 77)];
    const route = routeOf(mapWaitingOn(edges));

    expect(route.links).toHaveLength(3);
    expect(upstreamLinks(route.links, 74).map((link) => link.before)).toEqual([70]);
    expect(upstreamLinks(route.links, null)).toEqual([]);
  });
});

describe("selection", () => {
  it("marks the node that was picked and no other", async () => {
    const host = await paint(FIXTURES["awkward-map"].model, 75);
    const selected = all(host, "[data-selected]");

    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-node")).toBe("75");
  });

  it("answers a click with the number that was clicked", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, null, (number) =>
      picked.push(number),
    );

    await fire(nodeFor(host, 72), new MouseEvent("click", { bubbles: true }));

    expect(picked).toEqual([72]);
  });

  it("puts a node back when it is the one already picked", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, 72, (number) =>
      picked.push(number),
    );

    await fire(nodeFor(host, 72), new MouseEvent("click", { bubbles: true }));

    expect(picked).toEqual([null]);
  });

  it("is reachable from the keyboard, because a graph is not a place to be trapped", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, null, (number) =>
      picked.push(number),
    );
    const node = nodeFor(host, 76);

    expect(node.getAttribute("tabindex")).toBe("0");
    await fire(node, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await fire(node, new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(picked).toEqual([76, 76]);
  });
});

describe("every coordinate came back from routeOf, and none of them is stored", () => {
  it("places each node exactly where the arithmetic said", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const route = routeOf(awkward());
    const expected = route.rows
      .flatMap((row) => row.nodes)
      .map((entry) => `translate(${entry.x} ${entry.y})`);

    expect(all(host, "[data-node]").map((el) => el.getAttribute("transform"))).toEqual(
      expected,
    );
  });

  it("paints the same model twice into the same picture", async () => {
    const transforms = async () =>
      all(await paint(FIXTURES["awkward-map"].model), "[data-node]").map((el) =>
        el.getAttribute("transform"),
      );

    const first = await transforms();
    const second = await transforms();

    expect(second).toEqual(first);
    expect(first).not.toEqual([]);
  });

  it("keeps no position and no colour of its own", () => {
    const sources = collect([".tsx", ".css"]);
    const view = sources.find((file) => file.path === "src/views/route/Route.tsx");
    const stylesheet = sources.find(
      (file) => file.path === "src/views/route/Route.module.css",
    );

    expect(view).toBeDefined();
    expect(stylesheet).toBeDefined();

    for (const file of [view, stylesheet]) {
      // A remembered position is a position that can disagree with the graph.
      expect(file?.text).not.toContain("localStorage");
    }

    /*
     * The tier check scans stylesheets only, so a colour inlined on an SVG
     * attribute would survive every retheme and every check but this one.
     */
    expect(view?.text).not.toContain(`fill="#`);
    expect(view?.text).not.toContain(`stroke="#`);
    expect(view?.text).not.toContain("rgb(");
  });
});
