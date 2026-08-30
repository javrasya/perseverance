// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
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
import { DESIGNATED_TAG } from "../src/views/route/route";
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

/**
 * The heading a row sits under, which is now the load-bearing claim for three
 * of the states this file pins: a stray issue, a spec and a finished ticket are
 * told apart from available work by the group they are in before anything else.
 *
 * Read off `aria-labelledby`, which is the association a screen reader follows,
 * rather than off a sibling walk — the two agree only because the markup keeps
 * them agreeing, and this is the one that would notice.
 */
function headingOver(host: HTMLElement, number: number): string {
  const list = nodeFor(host, number).closest("[aria-labelledby]");
  const id = list?.getAttribute("aria-labelledby") ?? null;
  const heading = id === null ? null : host.querySelector(`#${id}`);
  if (heading === null) throw new Error(`#${number} sits under no heading`);
  return heading.firstElementChild?.textContent ?? "";
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

  it("draws the takeable spec children as the destination and never as the frontier", async () => {
    /*
     * Every open child on this map is takeable by every state predicate there
     * is, and two of them are the spec. A pane that grouped on the state alone
     * would head both with *Frontier*, count them as available work and draw
     * them wearing the ring that means *this is yours to take* — which is
     * exactly how *Start Working* ends up launched at the destination.
     */
    const map = awkward();
    const host = await paint(FIXTURES["awkward-map"].model);
    const specs = map.nodes.filter((node) => node.kind.kind === "spec");

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      const drawn = nodeFor(host, spec.number);
      // GitHub's word, carried unchanged: the pane regroups the row, it does
      // not rewrite what the model said about it.
      expect(drawn.getAttribute("data-state")).toBe("takeable");
      expect(drawn.getAttribute("data-kind")).toBe("spec");
      expect(drawn.hasAttribute("data-frontier")).toBe(false);
      expect(drawn.getAttribute("data-mark")).toBe("destination");
      expect(headingOver(host, spec.number)).toBe("Destination");
      expect(drawn.closest("[data-destination]")).not.toBeNull();
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
      "Unclassified",
    ]);
    for (const section of sections) {
      expect(section.count).toBe(section.rows.length);
    }

    /*
     * Nothing on this map was cut, and a group is a claim that there is
     * something in it, so that section is absent rather than drawn with the
     * zero `—` exists to be told apart from. The map that did cut something is
     * asserted below.
     */
    expect(host.textContent).not.toContain("Out of scope");
  });

  it("heads the cut rows fifth, after Resolved and before the fog", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);
    const sections = sectionsIn(host);

    expect(sections.map((section) => section.heading)).toEqual([
      "Next",
      "Frontier",
      "Resolved",
      "Out of scope",
    ]);
    for (const section of sections) {
      expect(section.count).toBe(section.rows.length);
    }

    /*
     * Which is the whole of how the resolved count excludes a cut: #106 is
     * counted under this heading and under no other, so *Resolved* heads the
     * decisions made by holding fewer rows rather than by subtracting anything
     * from a number it also prints.
     */
    expect(sections.at(-2)).toEqual({ heading: "Resolved", count: 1, rows: [107] });
    expect(sections.at(-1)).toEqual({ heading: "Out of scope", count: 1, rows: [106] });

    // Still the last thing on the pane: the fog is a region beside the sections
    // and never the last of them.
    expect(all(host, "h2").at(-1)?.textContent).toContain("Fog");
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
      [75, 76],
      [72],
      [71],
      [70],
    ]);
    // The destination is last of all, after the sections and before the fog.
    expect(numbersIn(host)).toEqual([77, 75, 76, 72, 71, 70, 73, 74]);
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

  it("draws seven marks, each a different shape", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const drawn = all(host, "[data-node]").map((row) => ({
      mark: row.getAttribute("data-mark"),
      shape: shapeOn(row),
    }));

    expect(new Set(drawn.map((row) => row.mark))).toEqual(
      new Set([
        "takeable",
        "designated",
        "claimed",
        "blocked",
        "resolved",
        "unclassified",
        "destination",
      ]),
    );
    // Seven marks and seven shapes: a mark told apart by colour alone is a mark
    // lost to a monochrome screen and to the operator who cannot see the hue.
    expect(new Set(drawn.map((row) => row.shape)).size).toBe(7);
    // And every one of them is drawn at all. The CSS-module lookup answers
    // `string | undefined`, so a mistyped class is not a compile error — it is
    // a glyph with no shape, and this is the only thing that would notice.
    expect(drawn.every((row) => row.shape.length > 0)).toBe(true);
  });
});

describe("a cut shows why, and shows it without being asked", () => {
  const cutMap = (): Map => {
    const map = FIXTURES["out-of-scope"].model.map;
    if (map === null) throw new Error("the out-of-scope fixture has no map");
    return map;
  };

  /**
   * The words the map document cut this ticket in, read off the model rather
   * than restated here — which is the claim: what is on screen is the operator's
   * own bullet, not a sentence this side wrote about it.
   */
  function reasonFor(number: number): string {
    const node = cutMap().nodes.find((one) => one.number === number);
    if (node?.cut.cut !== "fromScope") throw new Error(`#${number} was not cut`);
    return node.cut.reason;
  }

  it("puts the reason on the row, whole, as text in the document", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);
    const reason = reasonFor(106);

    expect(reason).not.toBe("");
    expect(nodeFor(host, 106).textContent).toContain(reason);
    // #107 is closed and was not cut, so it has nothing of the kind to say.
    expect(nodeFor(host, 107).textContent).not.toContain(reason);
  });

  /**
   * A branch that stops has to show why it stopped, and *show* is the word. A
   * reason reachable only by hovering is a reason absent from a screenshot, from
   * a page search and from a reader — so the pane carries none of the three
   * mechanisms at all, and the source is asserted alongside the DOM because the
   * DOM only proves nobody used one on this fixture.
   */
  it("hides it behind nothing: no title, no described-by, nowhere to hover", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);
    const view = collect([".tsx"]).find(
      (file) => file.path === "src/views/route/Route.tsx",
    );

    expect(host.querySelector("[title]")).toBeNull();
    expect(view).toBeDefined();
    expect(view?.text).not.toContain("title=");
    expect(view?.text).not.toContain("aria-describedby");
  });

  it("draws the plate double on the row that carries a reason, and only there", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);
    const numbered = (selector: string) =>
      all(host, selector).map((row) => row.getAttribute("data-node"));

    expect(numbered("[data-plate]")).toEqual(["106"]);
    expect(numbered('[data-plate="double"]')).toEqual(["106"]);
    expect(numbered("[data-cut]")).toEqual(["106"]);
    // Four rows on this map and three of them are one plate wide: the doubling
    // is what the reason costs, not what a cut is.
    expect(all(host, "[data-node]")).toHaveLength(4);
  });

  it("measures the second plate against the first rather than beside it", () => {
    const stylesheet = collect([".css"]).find(
      (file) => file.path === "src/views/route/Route.module.css",
    );

    /*
     * One number, twice. A literal second width could drift from the first, and
     * *double-width* would then be a coincidence rather than a rule — the plate
     * has to be a measured unit for the word to mean anything.
     */
    expect(stylesheet?.text).toContain("--c-node-plate: ");
    expect(stylesheet?.text).toContain("max-width: var(--c-node-plate);");
    expect(stylesheet?.text).toContain("max-width: calc(var(--c-node-plate) * 2);");
  });

  it("keeps the state and the mark the ticket already had", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);
    const cut = nodeFor(host, 106);
    const plain = nodeFor(host, 107);

    // A decoration on resolved and not a fifth state: GitHub closed it, and the
    // pane's own encoding of that is unchanged.
    expect(cut.getAttribute("data-state")).toBe("resolved");
    expect(cut.getAttribute("data-mark")).toBe("resolved");
    // Which is why the shape is the resolved disc with something added to it,
    // rather than a sixth glyph standing in its place.
    expect(shapeOn(cut).split(" ")).toContain(shapeOn(plain));
    expect(shapeOn(cut)).not.toBe(shapeOn(plain));
  });
});

describe("a stray issue fails safe", () => {
  /**
   * #70 on the awkward map is *someone dragged a bug report onto the map*: a
   * child with no `wayfinder:` type at all, which arrives from Rust as
   * `unclassified` and `takeable`. Fail-safe means the pane refuses to
   * reinterpret it as work — and refuses it in three channels at once, because
   * a treatment carried by one is a treatment a retheme, a monochrome screen or
   * an operator who does not know the glyphs can lose.
   */
  it("draws it under a heading of its own, with the model's word on the row", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const stray = nodeFor(host, 70);

    expect(stray.getAttribute("data-kind")).toBe("unclassified");
    expect(stray.getAttribute("data-mark")).toBe("unclassified");
    expect(headingOver(host, 70)).toBe("Unclassified");
    // The word, in the document, where a page search and a screenshot find it.
    expect(stray.textContent).toContain("unclassified");
  });

  it("counts the stray issues, because a backlog of them is the thing worth saying", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const stray = sectionsIn(host).find(
      (section) => section.heading === "Unclassified",
    );

    // A real claim about a real fault: one child on this map the frontier can
    // never reach. And it is `rows.length` like every other count.
    expect(stray).toEqual({ heading: "Unclassified", count: 1, rows: [70] });
  });

  it("never offers a row that is not a ticket, on every fixture there is", async () => {
    /*
     * The negative half of the whole ticket, and unconditional: no spec and no
     * unclassified child is ever the frontier, and none of them is ever under a
     * heading that means *available work*. Over every fixture because a fixture
     * added later is exactly where the third reading of *may this be started*
     * would come from.
     */
    for (const name of FIXTURE_NAMES) {
      const map = FIXTURES[name].model.map;
      if (map === null) continue;

      const host = await paint(FIXTURES[name].model);
      const offered = all(host, "[data-node]").filter(
        (row) => row.getAttribute("data-kind") !== "ticket",
      );

      for (const row of offered) {
        const number = Number(row.getAttribute("data-node"));
        expect([name, number, row.hasAttribute("data-frontier")]).toEqual([
          name,
          number,
          false,
        ]);
        expect([name, number, headingOver(host, number)]).not.toEqual([
          name,
          number,
          "Now",
        ]);
        expect([name, number, headingOver(host, number)]).not.toEqual([
          name,
          number,
          "Next",
        ]);
        expect([name, number, headingOver(host, number)]).not.toEqual([
          name,
          number,
          "Frontier",
        ]);
      }
    }
  });

  it("tells it apart by shape, and not by a hue", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const stylesheet = collect([".css"]).find(
      (file) => file.path === "src/views/route/Route.module.css",
    );
    const css = stylesheet?.text ?? "";
    const glyph = block(css, ".markUnclassified");
    const row = block(css, '.node[data-mark="unclassified"]');

    // Not a circle and not a solid line: two departures from every one of the
    // five work glyphs, so it survives a monochrome screen.
    expect(glyph).toContain("dashed");
    expect(glyph).not.toContain("border-radius");
    expect(shapeOn(nodeFor(host, 70))).not.toBe(shapeOn(nodeFor(host, 76)));

    /*
     * And what colour it does carry is a semantic job rather than a value, so
     * the retheme reaches it. `token-tiers.test.ts` holds every stylesheet to
     * that; this holds the one block the fail-safe depends on.
     */
    for (const read of row.match(/var\(--[a-z-]+/g) ?? []) {
      expect(read).toContain("var(--s-");
    }
  });
});

describe("the spec is the destination and not a ticket to take", () => {
  it("draws it after every section and before the fog", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const region = host.querySelector("[data-destination]");
    const headings = all(host, "h2").map((heading) => heading.textContent ?? "");

    expect(region).not.toBeNull();
    expect(headings.at(-2)).toContain("Destination");
    // Still the last thing on the pane: the fog is beyond the destination, the
    // way the unmapped ground is beyond the place you are going.
    expect(headings.at(-1)).toContain("Fog");
  });

  it("puts no count over it, which is the whole of never counted", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const region = host.querySelector("[data-destination]");
    const sections = sectionsIn(host);

    /*
     * A section's count is the rows it heads, so *never counted* cannot be a
     * subtraction — the only way to stop counting a row and stay honest is to
     * head it with something that prints no number. Two children in that
     * heading where a section has three, and no `[data-count]` anywhere in the
     * region.
     */
    expect(region?.querySelector("h2")?.children).toHaveLength(2);
    expect(region?.querySelector("[data-count]")).toBeNull();
    // Six counted across five headings, against eight rows drawn: the two the
    // pane is not counting are the two at the destination.
    expect(sections.reduce((total, one) => total + one.count, 0)).toBe(6);
    expect(all(host, "[data-node]")).toHaveLength(8);
  });

  it("draws no destination at all on a map with no spec child", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);

    // A group is a claim that there is something in it. A map still being
    // charted has no destination yet, and there is no second absence to tell
    // apart here the way there is in the fog.
    expect(host.querySelector("[data-destination]")).toBeNull();
    expect(sectionsIn(host).map((section) => section.heading)).toEqual([
      "Next",
      "Frontier",
      "Resolved",
      "Out of scope",
    ]);
  });

  it("heads no Frontier at all when the only thing left open is the spec", async () => {
    /*
     * `spec-composed`: both tickets resolved, the spec still open, and the
     * model's own answer to *what next* is `nothingToStart`. The pane says the
     * same thing by drawing no Frontier section — where before this ticket it
     * would have headed one over a row nobody can take.
     */
    const host = await paint(FIXTURES["spec-composed"].model);

    expect(sectionsIn(host).map((section) => section.heading)).toEqual(["Resolved"]);
    expect(headingOver(host, 93)).toBe("Destination");
    expect(all(host, "[data-frontier]")).toEqual([]);
  });

  it("tells the waypoint apart from the ring in shape as well as in fill", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const css =
      collect([".css"]).find(
        (file) => file.path === "src/views/route/Route.module.css",
      )?.text ?? "";
    const glyph = block(css, ".markDestination");

    expect(glyph).toContain("rotate(");
    expect(glyph).toContain("background:");
    expect(shapeOn(nodeFor(host, 73))).not.toBe(shapeOn(nodeFor(host, 75)));
    expect(shapeOn(nodeFor(host, 73))).not.toBe(shapeOn(nodeFor(host, 77)));
  });

  it("draws no offer on it even when the frontier names its number", async () => {
    /*
     * The map below is impossible from Rust — `is_startable_work` requires a
     * ticket, so `map.frontier` cannot name #73 — and it is painted anyway,
     * because *fails safe* means the pane refuses the offer on its own rather
     * than trusting the one upstream. Two things would have to fail together
     * for an agent to be launched at the destination.
     *
     * The arithmetic half of this is pinned in `tests/route.test.ts`; what is
     * asserted here is the half a later reader actually touches. `data-frontier`
     * is the hook every test in `dev-web.test.tsx` uses to mean *the one thing
     * to take*, and the marker tag is the word an operator reads — a row saying
     * *destination* in its glyph and *designated* in its text would be the pane
     * contradicting itself in the same glance.
     */
    const map = awkward();
    const host = await paint({
      map: { ...map, frontier: { frontier: "designated", number: 73 } },
    });
    const drawn = nodeFor(host, 73);

    expect(drawn.getAttribute("data-mark")).toBe("destination");
    expect(headingOver(host, 73)).toBe("Destination");
    expect(drawn.hasAttribute("data-frontier")).toBe(false);
    expect(drawn.textContent).not.toContain(DESIGNATED_TAG);
    // And nothing else picked the offer up in its place either.
    expect(all(host, "[data-frontier]")).toEqual([]);
  });

  it("draws a spec the map cut as a struck resolved disc and not as the destination", async () => {
    /*
     * The one state no recorded answer holds, and the one place the bucket and
     * the mark could come apart: `Node::of` hangs the cut on any child GitHub
     * calls resolved that the map document names, asking nothing about the
     * kind. The cut outranks the label — a map that dropped its own destination
     * is not going there — and the mark has to follow the bucket, because
     * `.markCut` is a decoration composed onto a mark that is *true* of the
     * row. Left as the destination, the strike would be positioned inside a
     * glyph rotated 45° and drawn diagonally across it.
     */
    const map = awkward();
    const host = await paint({
      map: {
        ...map,
        nodes: map.nodes.map((one) =>
          one.number === 73
            ? {
                ...one,
                state: "resolved" as const,
                cut: {
                  cut: "fromScope" as const,
                  reason: "#73 - this map is not going there after all",
                },
              }
            : one,
        ),
      },
    });
    const drawn = nodeFor(host, 73);

    expect(headingOver(host, 73)).toBe("Out of scope");
    expect(drawn.getAttribute("data-mark")).toBe("resolved");
    expect(drawn.closest("[data-destination]")).toBeNull();
    // The same composition every other cut row wears: the resolved disc, with
    // something added to it rather than a shape standing in its place.
    expect(shapeOn(drawn).split(" ")).toContain(shapeOn(nodeFor(host, 71)));
    expect(shapeOn(drawn)).not.toBe(shapeOn(nodeFor(host, 74)));
    // And #74, which nobody cut, is still where the map is going.
    expect(headingOver(host, 74)).toBe("Destination");
  });

  it("keeps it selectable, because selecting a row is not starting one", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, null, (number) =>
      picked.push(number),
    );

    // The row an operator most needs to be able to open is the one that is
    // wrong, so nothing here removes the click or the tab stop. What the row
    // loses is the offer, and the offer is not a control on this pane.
    await fire(nodeFor(host, 73), new MouseEvent("click", { bubbles: true }));

    expect(picked).toEqual([73]);
    expect(nodeFor(host, 73).getAttribute("tabindex")).toBe("0");
  });
});

describe("resolved recedes in salience and never in visibility", () => {
  it("keeps a finished row focusable", async () => {
    const picked: (number | null)[] = [];
    const host = await paint(FIXTURES["awkward-map"].model, null, (number) =>
      picked.push(number),
    );
    const finished = nodeFor(host, 71) as HTMLElement;

    expect(finished.getAttribute("tabindex")).toBe("0");
    finished.focus();
    expect(document.activeElement).toBe(finished);
    await fire(finished, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(picked).toEqual([71]);
  });

  it("keeps a finished row locatable", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const finished = nodeFor(host, 71);
    const title = awkward().nodes.find((one) => one.number === 71)?.title ?? "";

    expect(title).not.toBe("");
    // The whole title in the document, where a page search and a reader find
    // it: the browser ellipsises, the view does not cut.
    expect(host.textContent).toContain(title);
    expect(finished.hasAttribute("hidden")).toBe(false);
    expect(finished.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps a finished row countable", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);
    const resolved = sectionsIn(host).find((section) => section.heading === "Resolved");

    expect(resolved).toEqual({ heading: "Resolved", count: 1, rows: [71] });
  });

  it("hides no row from the document, on every fixture there is", async () => {
    /*
     * The rule read at its widest: receding is a reduction in salience, so
     * nothing anywhere is allowed to reduce a row's visibility. Every number
     * the map holds has a row, and no row is hidden from a reader.
     */
    for (const name of FIXTURE_NAMES) {
      const map = FIXTURES[name].model.map;
      if (map === null) continue;

      const host = await paint(FIXTURES[name].model);
      const drawn = numbersIn(host);

      expect([name, [...drawn].sort((a, b) => a - b)]).toEqual([
        name,
        map.nodes.map((one) => one.number).sort((a, b) => a - b),
      ]);
      for (const row of all(host, "[data-node]")) {
        expect([name, row.getAttribute("data-node"), row.hasAttribute("hidden")]).toEqual(
          [name, row.getAttribute("data-node"), false],
        );
        expect([
          name,
          row.getAttribute("data-node"),
          row.hasAttribute("aria-hidden"),
        ]).toEqual([name, row.getAttribute("data-node"), false]);
      }
    }
  });

  /**
   * The test the stylesheet's own comment has been asking for since #34.
   *
   * Receding is two ink jobs and nothing else. An `opacity` on the row would
   * reach the title, a `display` or a `visibility` would take the row off the
   * screen, and a `content-visibility` would take it out of a find — each of
   * them turning *the decisions this map has already made* into an absence.
   */
  it("recedes in ink weight and in nothing else", () => {
    const css =
      collect([".css"]).find(
        (file) => file.path === "src/views/route/Route.module.css",
      )?.text ?? "";
    const receding = block(css, '.node[data-mark="resolved"]');

    for (const vanishing of ["opacity", "display", "visibility", "content-visibility"]) {
      expect(receding).not.toContain(vanishing);
    }
    expect(receding).toContain("--c-node-ink:");
    expect(receding).toContain("--c-node-quiet:");
    // And both of them are jobs rather than values, so a retheme reaches them.
    for (const read of receding.match(/var\(--[a-z-]+/g) ?? []) {
      expect(read).toContain("var(--s-");
    }
  });
});

describe("the pane draws one picture, whatever the theme is set to", () => {
  /**
   * *Survives a retheme* has one mechanical meaning in this repo — views
   * consume semantic tokens only, which `token-tiers.test.ts` scans for — and
   * one more that belongs here: the pane must not have a theme branch of its
   * own. Nothing in the DOM may differ between light and dark, because a
   * difference is a second place for the two to disagree.
   */
  const shapeOfThePane = (host: HTMLElement) =>
    all(host, "[data-node]").map((row) => [
      row.getAttribute("data-node"),
      row.getAttribute("data-kind"),
      row.getAttribute("data-mark"),
      row.getAttribute("data-state"),
      shapeOn(row),
    ]);

  it("draws the same DOM under either theme", async () => {
    document.documentElement.dataset.theme = "light";
    const light = shapeOfThePane(await paint(FIXTURES["awkward-map"].model));

    document.documentElement.dataset.theme = "dark";
    const dark = shapeOfThePane(await paint(FIXTURES["awkward-map"].model));

    delete document.documentElement.dataset.theme;

    expect(dark).toEqual(light);
    expect(light).not.toEqual([]);
  });

  it("asks nothing about the theme at all", () => {
    const view = collect([".tsx"]).find(
      (file) => file.path === "src/views/route/Route.tsx",
    );

    // A view that read the theme would be a view with two pictures to keep in
    // step, and the retheme would only be checkable on the one being read.
    expect(view?.text).not.toContain("data-theme");
    expect(view?.text).not.toContain("matchMedia");
    expect(view?.text).not.toContain("prefers-color-scheme");
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

  it("draws no edge now that two of the glyphs are new", async () => {
    /*
     * A square with a dashed border and a rotated lozenge are the obvious
     * places to reach for an inline `<svg>`. Both are CSS geometry on a
     * `<span>`, and this is where reaching for one would be caught.
     */
    for (const name of ["awkward-map", "spec-composed", "platform-bound-windows"] as const) {
      expect([name, all(await paint(FIXTURES[name].model), ANY_DRAWN_EDGE)]).toEqual([
        name,
        [],
      ]);
    }
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

describe("there is a fixture for each state this pane draws, and it is painted", () => {
  /**
   * The fixtures are the model crate's own output — generated from recorded
   * GitHub answers, byte-compared on `cargo test` — so a state is covered by
   * *naming* the fixture that carries it and painting it, rather than by
   * hand-writing a JSON the Rust side would reject. All three states this
   * ticket is about already exist on disk, which is why none was added.
   */
  it("has one map carrying the stray issue, the spec and the finished ticket at once", async () => {
    const host = await paint(FIXTURES["awkward-map"].model);

    expect(nodeFor(host, 70).getAttribute("data-kind")).toBe("unclassified");
    expect(nodeFor(host, 73).getAttribute("data-kind")).toBe("spec");
    expect(nodeFor(host, 74).getAttribute("data-kind")).toBe("spec");
    expect(nodeFor(host, 71).getAttribute("data-mark")).toBe("resolved");
  });

  it("has one where the spec is the last thing standing", async () => {
    // Every ticket resolved, the spec still open, and the model's own answer to
    // *what next* is that there is nothing to start.
    const host = await paint(FIXTURES["spec-composed"].model);

    expect(headingOver(host, 93)).toBe("Destination");
    expect(headingOver(host, 91)).toBe("Resolved");
  });

  it("has one where the spec stands beside tickets none of which are offered", async () => {
    /*
     * Two different reasons not to be offered, drawn in two different places:
     * a ticket bound to another machine keeps its section, its count and a word
     * about the binding, while the spec is not in a section at all.
     */
    const host = await paint(FIXTURES["platform-bound-windows"].model);

    expect(headingOver(host, 80)).toBe("Frontier");
    expect(nodeFor(host, 80).getAttribute("data-elsewhere")).toBe("");
    expect(headingOver(host, 84)).toBe("Destination");
    expect(nodeFor(host, 84).hasAttribute("data-elsewhere")).toBe(false);
    expect(all(host, "[data-frontier]")).toEqual([]);
  });

  it("has one where a finished ticket sits beside one the map cut", async () => {
    const host = await paint(FIXTURES["out-of-scope"].model);

    expect(headingOver(host, 107)).toBe("Resolved");
    expect(headingOver(host, 106)).toBe("Out of scope");
    expect(nodeFor(host, 106).getAttribute("data-mark")).toBe("resolved");
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
