// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map as MapModel, Model, Node } from "../src/snapshot/model.generated";
import { NO_MAP_OPEN } from "../src/snapshot/readout";
/*
 * `Plate.jsx` and not `Plate`, and the extension is load-bearing: macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Plate`
 * resolves to `plate.ts` — the geometry module, which exports a `Plate` *type*
 * — and the component is never found.
 */
import {
  FOG_HEADING,
  NOBODY_SURVEYED,
  PIN_NOTE,
  Plate,
  UNCLASSIFIED_TAG,
} from "../src/views/plate/Plate.jsx";
import { plateOf } from "../src/views/plate/plate";
import { clearPins, pinStation } from "../src/views/plate/pins";
import { collect } from "./support/sources";

/**
 * The Plate, mounted.
 *
 * `tests/plate.test.ts` pins the geometry; this pins the picture drawn over it.
 * Every case fans out over `FIXTURE_NAMES` and asks its question of whichever
 * fixtures can answer it — a check that names three fixtures is a check that
 * stops covering the fourth the day somebody adds one, and only
 * `src/snapshot/fixtures.ts` is allowed to hold the complete list.
 *
 * The full fixture-space × theme × motion sweep is the conformance suite's,
 * under Playwright. What is here is the shape of the drawing: one designated
 * station, unclassified drawn and never offered, the spec as the destination,
 * the cut reason as text on a double plate, sidings with the legend that names
 * them, a fan drawn where the geometry found one, a fog that names itself, and
 * resolved still in the document with a tab stop on it.
 */

/* Same reason as `tests/route-view.test.tsx`: a suite that always warns is a
   suite whose warnings nobody reads. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

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
    root.render(<Plate model={model} selected={selected} onSelect={onSelect} />);
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

/* A child and a map, for the one case the fixture space cannot answer. Declared
   here rather than imported: a builder shared between two suites is a builder
   whose defaults one of them silently depends on. */
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

function mapOf(nodes: readonly Node[], over: Partial<MapModel> = {}): MapModel {
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

/** Every fixture that puts a map on screen, with the model it was drawn from. */
function mapped(): { name: string; model: Model }[] {
  return FIXTURE_NAMES.map((name) => ({ name, model: FIXTURES[name].model })).filter(
    (fixture) => fixture.model.map !== null,
  );
}

function stations(view: HTMLElement): Element[] {
  return [...view.querySelectorAll("[data-node]")];
}

describe("the map is drawn as a transit diagram", () => {
  it("draws a station for every child of every map, and nothing for no map", async () => {
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      expect([name, stations(view).length]).toEqual([
        name,
        model.map?.nodes.length ?? 0,
      ]);
      teardown();
    }

    const empty = FIXTURES["no-map-open"].model;
    const view = await paint(empty);
    expect(view.textContent).toContain(NO_MAP_OPEN);
    expect(stations(view)).toEqual([]);
  });

  it("carries the model's own words for state and kind onto the station", async () => {
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect([name, node.number, station?.getAttribute("data-state")]).toEqual([
          name,
          node.number,
          node.state,
        ]);
        expect(station?.getAttribute("data-kind")).toBe(node.kind.kind);
      }
      teardown();
    }
  });
});

describe("the designation is read, never resolved", () => {
  it("draws exactly one designated station, and only where the map designates one", async () => {
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      const frontier = model.map?.frontier;
      const designated = [...view.querySelectorAll("[data-frontier]")];

      if (frontier?.frontier === "designated") {
        expect([name, designated.length]).toEqual([name, 1]);
        expect([name, designated[0]?.getAttribute("data-node")]).toEqual([
          name,
          String(frontier.number),
        ]);
      } else {
        // Two readings of an empty frontier, and neither of them is a station
        // wearing the offer's ring.
        expect([name, designated.length]).toEqual([name, 0]);
      }
      teardown();
    }
  });

  it("never offers a spec or a child nobody classified, and draws the spec as the destination", async () => {
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        if (node.kind.kind === "ticket") continue;
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect([name, node.number, station?.hasAttribute("data-frontier")]).toEqual([
          name,
          node.number,
          false,
        ]);
        // A cut child wears the mark its state earned, decorated; every other
        // non-ticket wears the shape its kind earned.
        if (node.cut.cut === "fromScope") continue;
        expect([name, node.number, station?.getAttribute("data-mark")]).toEqual([
          name,
          node.number,
          node.kind.kind === "spec" ? "destination" : "unclassified",
        ]);
      }
      teardown();
    }
  });

  it("draws an unclassified child in words as well as in shape", async () => {
    const seen: string[] = [];
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        if (node.kind.kind !== "unclassified") continue;
        seen.push(name);
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect(station?.textContent).toContain(UNCLASSIFIED_TAG);
      }
      teardown();
    }

    // The word is the channel that survives a retheme, so a fixture space with
    // no unclassified child in it would leave that claim untested.
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("a station nobody can start still says everything about itself", () => {
  it("lists a ticket bound to another machine and offers it nothing", async () => {
    const seen: string[] = [];
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        if (!node.boundElsewhere) continue;
        seen.push(name);
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect(station).not.toBeNull();
        expect(station?.hasAttribute("data-elsewhere")).toBe(true);
        expect(station?.hasAttribute("data-frontier")).toBe(false);
      }
      teardown();
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("puts a cut reason on the drawing, on a double plate, with nothing behind a pointer", async () => {
    const seen: string[] = [];
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        if (node.cut.cut !== "fromScope") continue;
        seen.push(name);
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect(station?.hasAttribute("data-cut")).toBe(true);
        // Rule 6 forces layout at this scale: the plate carrying the reason is
        // drawn two boxes across, because the words take a plate's worth of
        // room.
        expect(station?.getAttribute("data-plate")).toBe("double");
        expect(station?.textContent).toContain(node.cut.reason);
        // The state is untouched: a cut ticket really is closed, and the cut is
        // a decoration on the mark rather than a mark of its own.
        expect(station?.getAttribute("data-state")).toBe("resolved");
      }

      // Nothing anywhere in the drawing is behind a hover, on any fixture: no
      // `title` attribute and no SVG `<title>` to hang one on.
      expect([name, view.querySelectorAll("[title]").length]).toEqual([name, 0]);
      expect([name, view.querySelectorAll("title").length]).toEqual([name, 0]);
      teardown();
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("the conventions the picture cannot explain about itself", () => {
  it("names a siding in the legend wherever it draws one", async () => {
    const seen: string[] = [];
    for (const { name, model } of mapped()) {
      const geometry = plateOf(model.map);
      if (geometry.sidings.length === 0) continue;
      seen.push(name);

      const view = await paint(model);
      expect([name, view.querySelectorAll("[data-siding]").length]).toEqual([
        name,
        geometry.sidings.length,
      ]);
      // Track that goes nowhere reads as a mistake until something says it is a
      // claim, so the legend is not optional where a siding is drawn.
      const entry = view.querySelector('[data-legend-key="siding"]');
      expect(entry).not.toBeNull();
      expect(entry?.textContent).toContain("siding");
      teardown();
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("draws a length of track for every edge the router routed", async () => {
    for (const { name, model } of mapped()) {
      const geometry = plateOf(model.map);
      const view = await paint(model);
      expect([name, view.querySelectorAll("[data-track]").length]).toEqual([
        name,
        geometry.track.length,
      ]);
      teardown();
    }
  });

  /*
   * Built here rather than taken off a fixture, and it is the one case in this
   * file that is: no checked-in snapshot holds a station that unlocks two, so
   * asking the fixture space this question would be a check that skips
   * everywhere and passes about nothing. Reaching the state in a browser means
   * editing sub-issue links on a real GitHub, which is what the fixtures exist
   * to stand in for — until one carries a fan, the map is made here.
   */
  it("draws the fan where one station unlocks several", async () => {
    const map = mapOf([
      node(1),
      node(2, { waitsOn: [1] }),
      node(3, { waitsOn: [1] }),
      node(4, { waitsOn: [1] }),
    ]);
    const geometry = plateOf(map);
    expect(geometry.fans.map((fan) => fan.from)).toEqual([1]);

    const view = await paint({ map });
    const drawn = view.querySelector('[data-fan="1"]');
    expect(drawn).not.toBeNull();
    // One stem said once, rather than three lines saying it three times.
    expect(drawn?.getAttribute("data-branches")).toBe("3");
    expect(view.querySelectorAll("[data-fan]")).toHaveLength(1);
    expect(view.querySelectorAll("[data-track]")).toHaveLength(geometry.track.length);
  });
});

describe("the fog names itself before it counts itself", () => {
  it("tells nobody surveyed from surveyed and found nothing, at form level", async () => {
    const readings = new Set<string>();
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      const region = view.querySelector("[data-fog]");
      const fog = model.map?.fog;
      expect([name, region === null]).toEqual([name, false]);
      // The stamp first: the region says what is missing, not only how much.
      expect(region?.textContent).toContain(FOG_HEADING);

      if (fog?.fog === "unsurveyed") {
        readings.add("unsurveyed");
        expect(region?.getAttribute("data-fog")).toBe("unsurveyed");
        expect(region?.querySelector("[data-unsurveyed]")?.textContent).toBe(
          NOBODY_SURVEYED,
        );
        // Two form-level differences from a count, and neither is a colour: no
        // numeral in the slot, and no ground drawn beneath the stamp.
        expect(region?.querySelector("[data-count]")).toBeNull();
        expect(region?.querySelector("[data-hatch]")).toBeNull();
      } else {
        readings.add(fog?.region.count === 0 ? "empty" : "charted");
        expect(region?.getAttribute("data-fog")).toBe("surveyed");
        expect(region?.querySelector("[data-count]")?.textContent).toBe(
          String(fog?.region.count),
        );
        expect(region?.querySelector("[data-unsurveyed]")).toBeNull();
        expect(region?.querySelector("[data-hatch]")).not.toBeNull();
      }
      teardown();
    }

    // All three readings are on screen somewhere, so the two absences are being
    // told apart rather than one of them never being drawn.
    expect([...readings].sort()).toEqual(["charted", "empty", "unsurveyed"]);
  });
});

describe("resolved recedes and stays where it is", () => {
  it("keeps a finished station in the document, with its words and its tab stop", async () => {
    const seen: string[] = [];
    for (const { name, model } of mapped()) {
      const view = await paint(model);
      for (const node of model.map?.nodes ?? []) {
        if (node.state !== "resolved") continue;
        seen.push(name);
        const station = view.querySelector(`[data-node="${node.number}"]`);
        expect([name, node.number, station === null]).toEqual([name, node.number, false]);
        // Rule 13's floor, in the two halves jsdom can answer: it is here, and
        // it is reachable from the keyboard.
        expect(station?.getAttribute("tabindex")).toBe("0");
        expect(station?.textContent).toContain(node.title);
      }
      teardown();
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("hands a picked station back when it is picked again", async () => {
    const picked: (number | null)[] = [];
    const model = FIXTURES["awkward-map"].model;
    const first = model.map?.nodes[0]?.number ?? 0;

    /* `dispatchEvent` and not `click()`: a station is an SVG `<g>`, and jsdom
       gives `click()` to `HTMLElement` alone. */
    let view = await paint(model, null, (number) => picked.push(number));
    view
      .querySelector(`[data-node="${first}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    view = await paint(model, first, (number) => picked.push(number));
    const station = view.querySelector(`[data-node="${first}"]`);
    expect(station?.getAttribute("aria-current")).toBe("true");
    station?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(picked).toEqual([first, null]);
  });
});

describe("the drawing is painted through the stylesheet", () => {
  it("names no colour in the markup", () => {
    const source = collect([".tsx"]).find(
      (file) => file.path === "src/views/plate/Plate.tsx",
    );
    if (source === undefined) throw new Error("the Plate has no component file");

    /*
     * A colour written into the `.tsx` is a colour the retheme cannot see and
     * the token-tier check cannot scan. Every fill and stroke on this drawing
     * arrives through a class.
     */
    for (const literal of ['fill="#', 'stroke="#', "rgb(", "oklch(", "hsl("]) {
      expect([literal, source.text.includes(literal)]).toEqual([literal, false]);
    }
  });
});

describe("the gesture is in the margin before it is in anybody's hand", () => {
  it("names the drag and the keyboard in words, on every map it draws", async () => {
    /* Rule 10 the other way round. A station moves under a pointer and under an
       arrow key, and neither the cursor nor a focus ring says so — so the words
       are on screen from the first paint, on every map, before anything has
       been hovered or focused. */
    expect(PIN_NOTE).toMatch(/drag/i);
    expect(PIN_NOTE).toMatch(/arrow keys/i);
    expect(PIN_NOTE).toMatch(/backspace/i);

    for (const { name, model } of mapped()) {
      const view = await paint(model);
      expect([name, view.textContent?.includes(PIN_NOTE)]).toEqual([name, true]);
      /* And it is still not a tooltip: the sentence is a paragraph in the
         margin, and nothing in this view discloses on hover. */
      expect([name, view.querySelectorAll("[title]").length]).toEqual([name, 0]);
      teardown();
    }
  });
});

/**
 * What the drawing knows about itself, said on the drawing.
 *
 * Two facts the picture cannot show and the geometry has always held: that the
 * map is outside the band this view is competent at, and that an edge was one
 * the router could not draw. Both used to live in the return value alone — a
 * sixty-station hairball drew itself with no word about being one, and an edge
 * an authored pin walled out simply vanished, leaving a diagram that read as a
 * map with one fewer dependency in it. Both are legend lines now, which is the
 * one place in the margin a reader is already looking.
 */
describe("the plate says what it knows about its own drawing", () => {
  it("spells the verdict where the map is outside the band, and nothing where it is not", async () => {
    const said = new Set<string>();
    for (const { name, model } of mapped()) {
      const geometry = plateOf(model.map);
      const view = await paint(model);
      const verdict = geometry.competence.verdict;
      /* A map with no children draws no plate, and a verdict on a drawing that
         is not there would be a legend for somebody else's diagram. */
      const drawn = geometry.stations.length > 0;
      if (drawn) said.add(verdict);

      if (verdict === "competent" || !drawn) {
        // Nothing to warn anybody about in a drawing doing what it is for.
        for (const outside of ["thin", "crowded", "hairball"]) {
          expect([name, view.querySelector(`[data-legend-key="${outside}"]`)]).toEqual([
            name,
            null,
          ]);
        }
      } else {
        const entry = view.querySelector(`[data-legend-key="${verdict}"]`);
        expect([name, entry === null]).toEqual([name, false]);
        // Counted in stations, because the band is a claim about how many.
        expect([name, entry?.textContent]).toEqual([
          name,
          expect.stringContaining(String(geometry.competence.stations)),
        ]);
      }
      teardown();
    }
    // The fixture space holds both readings, or this checks only one of them.
    expect(said.size).toBeGreaterThan(1);
  });

  /*
   * Built here for the same reason the fan is: no checked-in snapshot carries a
   * hand-arranged plate, and walling a station in takes an authored pin by
   * construction — the free lane round the outside of the drawing is the
   * router's guarantee that every generated plate routes.
   */
  it("names an edge an authored pin walled out of the picture", async () => {
    const at = { column: 60, row: 60 };
    const ring: { column: number; row: number }[] = [];
    for (const along of [-3, 0, 3]) {
      ring.push({ column: at.column - 4, row: at.row + along });
      ring.push({ column: at.column + 4, row: at.row + along });
      ring.push({ column: at.column + along, row: at.row - 4 });
      ring.push({ column: at.column + along, row: at.row + 4 });
    }
    const map = mapOf([
      node(1),
      node(2, { waitsOn: [1] }),
      ...ring.map((_, index) => node(index + 3)),
    ]);

    act(() => {
      pinStation(2, at);
      for (const [index, cell] of ring.entries()) pinStation(index + 3, cell);
    });
    const view = await paint({ map });
    const entry = view.querySelector('[data-legend-key="unrouted"]');
    expect(entry).not.toBeNull();
    expect(entry?.textContent).toContain("1");
    // The edge really is missing from the picture, which is what the line is for.
    expect(view.querySelectorAll("[data-track]")).toHaveLength(0);

    // And with the hand taken off it, the track is drawn and nothing is said.
    act(() => clearPins());
    const generated = await paint({ map });
    expect(generated.querySelector('[data-legend-key="unrouted"]')).toBeNull();
    expect(generated.querySelectorAll("[data-track]")).toHaveLength(1);
  });
});
