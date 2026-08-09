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
import { Route } from "../src/views/route/Route.jsx";
import { collect } from "./support/sources";

/**
 * The Route, mounted.
 *
 * `tests/route.test.ts` pins the arithmetic; this pins the picture. The claim
 * under test is that the second is a pure function of the first — so what is
 * asserted here is that every section, count and mark on screen came back from
 * `routeOf`, that the four states and the one designation are the model's
 * answers carried verbatim, and that the pane draws no edge at all in any state
 * it can be put into. A thesis nobody can fail is a thesis nobody declared.
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

/**
 * A dependency, for building fixtures with. Declared here and not imported:
 * adjacency reaches the pane hanging off the node that waits and is never
 * transposed into pairs, so nothing in the view has this shape. ADR 0006.
 */
type Waiting = { readonly before: number; readonly after: number };

function edge(before: number, after: number): Waiting {
  return { before, after };
}

/**
 * The awkward map, waiting on exactly these edges.
 *
 * The component takes a model and derives its list from that alone, so an edge
 * set under test is painted rather than passed — which is the point: what the
 * Route says about the edges it will not draw is reachable from the component's
 * own API and can therefore be failed from it.
 */
function mapWaitingOn(edges: readonly Waiting[]): Map {
  const map = awkward();
  return {
    ...map,
    nodes: map.nodes.map((node) => ({
      ...node,
      waitsOn: edges.filter((one) => one.after === node.number).map((one) => one.before),
    })),
  };
}

function waitingOn(edges: readonly Waiting[]): Model {
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

/* ------------------------------------------------------------- readers --- */

interface DrawnSection {
  heading: string;
  count: number;
  rows: number[];
}

/**
 * Each heading, the count it carries, and the rows the heading names.
 *
 * Scoped to the row sections. The fog draws an `h2` too — it is a peer of these
 * groups — but it heads no rows and carries no count that could be
 * `rows.length`, so a reader that swept both would be asking one question of
 * two different things.
 */
function sectionsIn(host: HTMLElement): DrawnSection[] {
  return all(host, 'h2[id^="route-section-"]').map((heading) => {
    const rows = host.querySelector(`[aria-labelledby="${heading.id}"]`);
    if (rows === null) throw new Error(`nothing is labelled by ${heading.id}`);
    const [name, , count] = [...heading.children];
    return {
      heading: name?.textContent ?? "",
      count: Number(count?.textContent),
      rows: [...rows.querySelectorAll("[data-node]")].map((row) =>
        Number(row.getAttribute("data-node")),
      ),
    };
  });
}

/** The class the glyph wears, which is the shape rather than the colour. */
function shapeOn(row: Element): string {
  const glyph = row.firstElementChild?.firstElementChild;
  if (!glyph) throw new Error(`no glyph on ${row.getAttribute("data-node")}`);
  return glyph.className;
}

function numbersIn(host: HTMLElement): number[] {
  return all(host, "[data-node]").map((row) => Number(row.getAttribute("data-node")));
}

/** The map with nobody working, so the top section rests at *Next*. */
function nothingClaimed(): Model {
  const map = awkward();
  return {
    map: {
      ...map,
      nodes: map.nodes.map((node) =>
        node.state === "claimed" ? { ...node, state: "takeable" as const } : node,
      ),
    },
  };
}

/* Every way a browser can be made to draw a line between two things, plus the
   attribute the old ranked view hung on the ones it drew. */
const ANY_DRAWN_EDGE = "svg, path, line, polyline, polygon, canvas, [data-link]";

describe("the four states and the one designation are the model's answers, drawn", () => {
  it("draws all four states, each spelled as well as styled", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const states = all(host, "[data-node]").map((el) => el.getAttribute("data-state"));

    expect(new Set(states)).toEqual(
      new Set(["resolved", "blocked", "claimed", "takeable"]),
    );
    // The palette is two accents and neutrals, so the word is not decoration.
    expect(host.textContent).toContain("blocked");
    expect(host.textContent).toContain("claimed");
  });

  it("marks exactly one frontier, and it is the number the model named", async () => {
    const map = awkward();
    const host = await paint(FIXTURES["awkward-map"].model);
    const marked = all(host, "[data-frontier]");

    expect(marked).toHaveLength(1);
    if (map.frontier.frontier !== "designated") {
      throw new Error("the awkward fixture designates nobody");
    }
    expect(marked[0]?.getAttribute("data-node")).toBe(String(map.frontier.number));
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

  it("says what the model said and what the pane made of it, separately", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const designated = nodeFor(host, 75);

    // The state is GitHub's word, carried; the mark folds the designation in.
    expect(designated.getAttribute("data-state")).toBe("takeable");
    expect(designated.getAttribute("data-mark")).toBe("designated");
  });

  it("is the chrome's own words when there is no map, and nothing else", async () => {
    const host = await paint(FIXTURES["no-map-open"].model);

    expect(host.textContent).toBe(NO_MAP_OPEN);
    expect(host.querySelector("svg")).toBeNull();
  });
});

describe("a grouped list in one column", () => {
  it("heads every section with the rows it holds and nothing else", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const sections = sectionsIn(host);

    expect(sections.map((section) => section.heading)).toEqual([
      "Now",
      "Frontier",
      "Blocked",
      "Resolved",
    ]);
    for (const section of sections) {
      expect(section.count).toBe(section.rows.length);
    }

    /*
     * Four sections, and the one that would follow is a named hole rather than
     * a stub. Out of scope is #36, and a stubbed heading here would have to
     * carry a count — which is the zero `—` exists to be told apart from. The
     * fog is no longer a hole; it is a region, and it is asserted below.
     */
    expect(host.textContent).not.toContain("Out of scope");
  });

  it("puts the sections in one column, each in the operator's own order", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    /*
     * Grouping is the only thing that moves a row. Inside a section the order
     * is `map.nodes` order, unmodified — a numeric sort anywhere fails this
     * line, and so does anything that re-arranges what the operator dragged.
     */
    expect(sectionsIn(host).map((section) => section.rows)).toEqual([
      [77],
      [70, 73, 74, 75, 76],
      [72],
      [71],
    ]);
    expect(numbersIn(host)).toEqual([77, 70, 73, 74, 75, 76, 72, 71]);
  });

  it("rests at Next, and reads Now only while something is claimed", async () => {
    const resting = sectionsIn(await paint(nothingClaimed()));
    const working = sectionsIn(await paint(FIXTURES["awkward-map"].model));

    // Nobody working: the top section is the one node the map designates.
    expect(resting[0]).toEqual({ heading: "Next", count: 1, rows: [75] });
    expect(working[0]).toEqual({ heading: "Now", count: 1, rows: [77] });
  });

  it("draws no section for a map with nothing on it", async () => {
    const host = await paint(FIXTURES["empty-map"].model);

    // A heading is a claim that there is something under it, and a count
    // standing in for an absence is the zero `—` exists to be told apart from.
    expect(all(host, 'h2[id^="route-section-"]')).toEqual([]);
    expect(all(host, "[data-node]")).toEqual([]);
    // The fog is the exception to *a heading is a claim that there is something
    // under it*, because on this map the absence is the thing there is to say.
    expect(host.querySelector("[data-fog]")).not.toBeNull();
  });

  it("draws five marks, each a different shape", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const drawn = all(host, "[data-node]").map((row) => ({
      mark: row.getAttribute("data-mark"),
      shape: shapeOn(row),
    }));

    expect(new Set(drawn.map((row) => row.mark))).toEqual(
      new Set(["takeable", "designated", "claimed", "blocked", "resolved"]),
    );
    // Five marks and five shapes: a mark told apart by colour alone is a mark
    // lost to a monochrome screen and to the operator who cannot see the hue.
    expect(new Set(drawn.map((row) => row.shape)).size).toBe(5);
    expect(drawn.every((row) => row.shape.length > 0)).toBe(true);
  });
});

describe("edges get words, never pixels", () => {
  it("counts what holds a row up on the row that waits", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    // #72 waits on #75 and #76, and this map shows both of them open.
    expect(nodeFor(host, 72).textContent).toContain("blocked by 2");
  });

  it("spends no ink saying nothing is in the way", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    // #75 waits only on #71, which is resolved: out of the way, and a
    // `blocked by 0` on any row is a contradiction of the row above it.
    expect(nodeFor(host, 75).textContent).not.toContain("blocked by");
    expect(host.textContent).not.toContain("blocked by 0");
  });

  it("says nothing about what holds up a row that is already finished", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const resolved = sectionsIn(host).find((section) => section.heading === "Resolved");

    /*
     * #71 is closed and still names #72, which this map shows as blocked.
     * GitHub does not clear what a closed issue was blocked by, so the number
     * survives the close — and `blocked by 1` on a row sitting under the
     * heading *Resolved* is a contradiction between a row and the heading over
     * it, which is the failure class this whole pane is arranged around.
     */
    expect(resolved?.rows).toEqual([71]);
    for (const number of resolved?.rows ?? []) {
      expect(nodeFor(host, number).textContent).not.toContain("blocked by");
    }
  });

  it("says on the row itself when a blocker has no row here", async () => {
    const host = await paint(waitingOn([edge(999, 74)]));

    expect(nodeFor(host, 74).textContent).toContain("not a child of this map");
    // The edge is real and the row is not, so nothing is drawn to nowhere.
    expect(all(host, "[data-node]")).toHaveLength(awkward().nodes.length);
  });

  it("keeps the whole title in the document and lets the browser cut it", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    for (const node of awkward().nodes) {
      expect(nodeFor(host, node.number).textContent).toContain(node.title);
    }
  });

  /**
   * ADR 0006's decision, in the document rather than in prose: The Route is a
   * grouped list and not a graph, so it draws no edge in any state. Prose
   * cannot fail; this can — and it is unconditional, because a rule with an
   * exception is a rule with a place for a graph to come back.
   */
  it("draws no edge with nothing selected", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    expect(all(host, ANY_DRAWN_EDGE)).toEqual([]);
  });

  it("draws no edge for the node that is selected either", async () => {
    const edges = [edge(70, 74), edge(70, 72), edge(74, 77)];
    const host = await paint(waitingOn(edges), 74);

    // #74 waits on one thing and holds up another. Neither is a line.
    expect(all(host, ANY_DRAWN_EDGE)).toEqual([]);
    expect(nodeFor(host, 74).hasAttribute("data-selected")).toBe(true);
  });

  it("draws no edge on an empty map or on no map at all", async () => {
    expect(all(await paint(FIXTURES["empty-map"].model), ANY_DRAWN_EDGE)).toEqual([]);
    expect(all(await paint(FIXTURES["no-map-open"].model), ANY_DRAWN_EDGE)).toEqual([]);
  });
});

describe("the fog is a named region and not a smudge", () => {
  const withFog = (fog: Map["fog"]): Model => ({ map: { ...awkward(), fog } });
  const unsurveyed = withFog({ fog: "unsurveyed" });
  const empty = withFog({ fog: "surveyed", region: { count: 0, text: "" } });
  const charted = withFog({
    fog: "surveyed",
    region: { count: 2, text: "- one\n  - nested\n\n- two" },
  });

  it("names itself on every map, and not only counts itself", async () => {
    for (const model of [unsurveyed, empty, charted]) {
      const region = (await paint(model)).querySelector("[data-fog]");
      expect(region?.querySelector("h2")?.firstElementChild?.textContent).toBe("Fog");
    }
  });

  /**
   * The region's shape, read off the DOM while it is up.
   *
   * Read rather than held: `paint` repaints into the same root, so React keeps
   * the one `<section>` and a reference taken before the second paint would be
   * the second region wearing the first one's name.
   */
  const shapeOfTheFog = async (model: Model) => {
    const region = (await paint(model)).querySelector("[data-fog]");
    return {
      which: region?.getAttribute("data-fog"),
      count: region?.querySelector("[data-count]")?.textContent ?? null,
      dash: region?.querySelector("[data-unsurveyed]")?.textContent ?? null,
      elements: region?.children.length,
    };
  };

  it("tells a map nobody surveyed from a survey that found nothing, by form", async () => {
    const nobody = await shapeOfTheFog(unsurveyed);
    const nothing = await shapeOfTheFog(empty);

    /*
     * Different elements in the count's slot — not one element with different
     * text in it, which is the distinction #35 refuses to settle for — and a
     * different number of elements in the region, because nobody surveyed and
     * so there is nothing under the heading at all.
     */
    expect(nobody).toEqual({ which: "unsurveyed", count: null, dash: "—", elements: 1 });
    expect(nothing).toEqual({ which: "surveyed", count: "0", dash: null, elements: 2 });
  });

  it("renders the section verbatim, indentation and blank line intact", async () => {
    const region = (await paint(charted)).querySelector("[data-fog] pre");

    // Byte for byte. Nothing re-rendered it as a list, nothing collapsed the
    // blank line, nothing ate the two spaces in front of the nested bullet.
    expect(region?.textContent).toBe("- one\n  - nested\n\n- two");
  });

  it("carries the model's count and never one of its own", async () => {
    // Two, though there are three bullet-looking lines on screen: the nesting
    // was judged in Rust and this side does not recount it.
    const host = await paint(charted);

    expect(host.querySelector("[data-count]")?.textContent).toBe("2");
  });

  it("draws no edge of any kind, fog included", async () => {
    for (const model of [unsurveyed, empty, charted]) {
      expect(all(await paint(model), ANY_DRAWN_EDGE)).toEqual([]);
    }
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

  it("is reachable from the keyboard, because a list is not a place to be trapped", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, null, (number) =>
      picked.push(number),
    );
    const node = nodeFor(host, 76);
    const space = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });

    expect(node.getAttribute("tabindex")).toBe("0");
    await fire(node, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await fire(node, space);

    expect(picked).toEqual([76, 76]);
    // Space would otherwise scroll the pane, which moves the row being picked
    // out from under the pointer that picked it.
    expect(space.defaultPrevented).toBe(true);
  });
});

describe("the same model twice, and nothing of its own kept between", () => {
  it("paints the same model twice into the same list", async () => {
    const drawn = async () => {
      const host = await paint(FIXTURES["awkward-map"].model);
      return sectionsIn(host);
    };

    const first = await drawn();
    const second = await drawn();

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
     * The tier check scans stylesheets only, so a colour written into the
     * markup would survive every retheme and every check but this one.
     */
    expect(view?.text).not.toContain(`fill="#`);
    expect(view?.text).not.toContain(`stroke="#`);
    expect(view?.text).not.toContain("rgb(");

    // And a coordinate written into the markup is the ranked view coming back.
    expect(view?.text).not.toContain("<svg");
    expect(view?.text).not.toContain("viewBox");
    expect(view?.text).not.toContain("translate(");

    // The middle tier is the rule: this sheet reads jobs, never values.
    expect(stylesheet?.text).not.toContain("--p-");

    /*
     * And no focus ring of its own. A row is an `<li>` in the document now, so
     * the app's one ring reaches it; a second one painted here is a second
     * thing to keep in step with the first.
     */
    expect(stylesheet?.text).not.toContain("outline:");
  });

  it("leaves a still ring where the ping was when motion is refused", () => {
    /*
     * The global rule kills `animation` outright, so a halo that *is* the
     * animation vanishes and *live* stops being visible at all. The ring is
     * authored in the base rule and the animation is added on top of it, which
     * this fails if the two are ever merged: the keyframes may move the ring
     * and may not be what draws it.
     */
    const stylesheet = collect([".css"]).find(
      (file) => file.path === "src/views/route/Route.module.css",
    );
    const css = stylesheet?.text ?? "";
    const halo = block(css, ".markClaimed::after");
    const frames = block(css, "@keyframes");

    expect(halo).toContain("border:");
    expect(halo).toContain("animation:");
    for (const drawing of ["border", "background", "content", "inset"]) {
      expect(frames).not.toContain(drawing);
    }
  });
});

/** One rule or at-rule, braces balanced, so a nested block comes back whole. */
function block(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`no ${opener} in the stylesheet`);

  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`${opener} is never closed`);
}
