import { describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import {
  BAND_HIGH,
  BAND_LOW,
  NOBODY_SURVEYED,
  VIEW_NAME,
  deepFieldOf,
  widthNeededFor,
  type DeepField,
  type FanOut,
} from "../src/views/deep-field/deepField";
import { FOG_ALL_CHARTED } from "../src/views/vocabulary";
import { collect } from "./support/sources";

/**
 * Nothing here touches the DOM, so there is no jsdom pragma: this is the
 * geometry the view is drawn from, and it is testable without one.
 *
 * Every case asks the layout a question a reader of the picture could ask —
 * which column is this ticket in, does any mark reach into the gutter, what
 * does the view say when it cannot be drawn. Nothing asks about a helper: the
 * ranker, the router and the plate stacker are free to be rewritten, and the
 * answers below are what may not move.
 */

/** Wide enough for anything built here, so width is never the subject. */
const AMPLE = 4000;

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

/** The laid-out reading, or a failure naming what came back instead. */
function drawn(field: DeepField) {
  if (field.kind !== "field") throw new Error(`expected a field, got ${field.kind}`);
  return field;
}

function standing(field: DeepField) {
  if (field.kind !== "standDown") throw new Error(`expected a stand-down, got ${field.kind}`);
  return field.standDown;
}

function numbersAt(field: DeepField, rank: number): number[] {
  const column = drawn(field).columns.find((one) => one.rank === rank);
  return (column?.marks ?? []).map((mark) => mark.number);
}

function rankOf(field: DeepField, number: number): number | undefined {
  return drawn(field).plates.find((plate) => plate.node.number === number)?.rank;
}

/**
 * The shape charting actually produces: a burst of independent tickets, then
 * ranks of four, two, one and one behind them. Nineteen nodes, inside the band.
 */
function wideRankZero(): Map {
  const sources = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((number) => node(number));
  const second = [12, 13, 14, 15].map((number, index) =>
    node(number, { state: "blocked", waitsOn: [index + 1] }),
  );
  const third = [16, 17].map((number, index) =>
    node(number, { state: "blocked", waitsOn: [12 + index] }),
  );
  const fourth = node(18, { state: "blocked", waitsOn: [16, 17] });
  const fifth = node(19, { state: "blocked", waitsOn: [18] });
  return mapOf([...sources, ...second, ...third, fourth, fifth]);
}

/**
 * A cycle the ranker has to break: every node waits on the one before it and
 * the first waits on the last. The refused edge is the one that spans more than
 * one rank backwards — the only shape in this repo that puts a curve's control
 * point inside the reserved gutter, which is why it is swept below rather than
 * left to a fixture that does not contain it.
 */
function multiRankCycle(): Map {
  return mapOf([
    node(1, { state: "blocked", waitsOn: [4] }),
    node(2, { state: "blocked", waitsOn: [1] }),
    node(3, { state: "blocked", waitsOn: [2] }),
    node(4, { state: "blocked", waitsOn: [3] }),
  ]);
}

/**
 * The leftmost x the ink of one edge actually reaches.
 *
 * The renderer draws `M start C bend0 bend1 end`, so this is that cubic
 * sampled: a control point is not a point on the curve, and the difference
 * between the two is the whole of what rule 11's declaration claims here.
 */
function drawnExtentOf(edge: FanOut): number {
  const from = edge.start.x;
  const first = edge.bend[0].x;
  const second = edge.bend[1].x;
  const to = edge.end.x;
  let least = Math.min(from, to);
  for (let step = 0; step <= 256; step += 1) {
    const t = step / 256;
    const u = 1 - t;
    const x = u * u * u * from + 3 * u * u * t * first + 3 * u * t * t * second + t * t * t * to;
    least = Math.min(least, x);
  }
  return least;
}

describe("ranks are the longest path and the columns are map order", () => {
  it("stands eleven sources against ranks of four, two, one and one", () => {
    const field = deepFieldOf(wideRankZero(), AMPLE);

    expect(drawn(field).columns.map((column) => column.marks.length)).toEqual([11, 4, 2, 1, 1]);
    expect(numbersAt(field, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(numbersAt(field, 4)).toEqual([19]);
  });

  it("ranks a diamond by its longer side", () => {
    const field = deepFieldOf(
      mapOf([
        node(1),
        node(2, { state: "blocked", waitsOn: [1] }),
        node(3, { state: "blocked", waitsOn: [2] }),
        node(4, { state: "blocked", waitsOn: [1] }),
        node(5, { state: "blocked", waitsOn: [3, 4] }),
      ]),
      AMPLE,
    );

    expect(rankOf(field, 4)).toBe(1);
    expect(rankOf(field, 3)).toBe(2);
    // Longest path, not shortest: 5 waits on 4 at rank 1 and on 3 at rank 2.
    expect(rankOf(field, 5)).toBe(3);
  });

  it("keeps map order inside a column and never sorts by number", () => {
    const field = deepFieldOf(mapOf([node(90), node(12), node(41)]), AMPLE);

    expect(numbersAt(field, 0)).toEqual([90, 12, 41]);
    expect(drawn(field).plates.map((plate) => plate.node.number)).toEqual([90, 12, 41]);
  });

  it("leaves a blocker beyond the map unranked, unedged and still said", () => {
    const field = deepFieldOf(
      mapOf([node(1), node(2, { state: "blocked", waitsOn: [1, 4242] })]),
      AMPLE,
    );

    // Rank comes from the one blocker with a row here; the other cannot be
    // judged, so it moves nothing.
    expect(rankOf(field, 2)).toBe(1);
    expect(drawn(field).fanOut.map((edge) => [edge.from, edge.to])).toEqual([[1, 2]]);

    const plate = drawn(field).plates.find((one) => one.node.number === 2);
    expect(plate?.blockers).toEqual({ unresolved: 1, beyondTheMap: 1 });
  });

  it("refuses the edge that closes a cycle and still ranks every node", () => {
    const field = deepFieldOf(
      mapOf([
        node(1, { state: "blocked", waitsOn: [3] }),
        node(2, { state: "blocked", waitsOn: [1] }),
        node(3, { state: "blocked", waitsOn: [2] }),
      ]),
      AMPLE,
    );

    // The walk starts at the first node in map order, so the edge it comes back
    // on is 2's — refused, and both its ends named. Every node keeps a finite
    // rank, and which node loses its edge is map order's answer rather than an
    // accident of the recursion.
    expect(drawn(field).plates.map((plate) => plate.rank)).toEqual([2, 0, 1]);
    expect(drawn(field).circular).toEqual([1, 2]);
    expect(
      drawn(field)
        .plates.filter((plate) => plate.circular)
        .map((plate) => plate.node.number),
    ).toEqual([1, 2]);

    // The edge is still drawn, and it is the one that travels no rank forward.
    const back = drawn(field).fanOut.find((edge) => edge.circular);
    expect([back?.from, back?.to]).toEqual([1, 2]);
    expect(back?.spans).toBe(-2);
  });

  it("survives a node that waits on itself", () => {
    const field = deepFieldOf(mapOf([node(1, { state: "blocked", waitsOn: [1] })]), AMPLE);

    expect(rankOf(field, 1)).toBe(0);
    expect(drawn(field).circular).toEqual([1]);
  });
});

describe("the plate/field split is a reserved region, not a habit", () => {
  /** Every laid-out map there is to ask, fixtures and hand-built alike. */
  function everyField(): DeepField[] {
    const built = [
      wideRankZero(),
      mapOf([]),
      mapOf([node(1), node(2, { waitsOn: [1] })]),
      multiRankCycle(),
    ];
    const fixtures = FIXTURE_NAMES.map((name) => FIXTURES[name].model.map).filter(
      (map): map is Map => map !== null,
    );
    return [...built, ...fixtures].map((map) => deepFieldOf(map, AMPLE));
  }

  it("keeps every mark clear of the boundary by the clearance, at every n", () => {
    for (const field of everyField()) {
      const { split, columns } = drawn(field);
      const floor = split.boundary + split.clearance;

      expect(split.field.x).toBeGreaterThanOrEqual(floor);
      for (const column of columns) {
        for (const mark of column.marks) {
          expect(mark.at.x - mark.radius).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it("keeps every edge's drawn ink clear of the boundary by the clearance", () => {
    for (const field of everyField()) {
      const { split, fanOut } = drawn(field);
      const floor = split.boundary + split.clearance;

      for (const edge of fanOut) {
        expect(drawnExtentOf(edge)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("permits a control point into the gutter, where the viewport clips it", () => {
    /*
     * Not a loophole found after the fact: the refused edge of a multi-rank
     * cycle reaches backwards further than the gap it spans, and its second
     * control point lands inside the reserved 34px. The declaration says so in
     * writing, the viewBox starts at `split.field.x` so nothing of it is
     * painted there, and the test above is what keeps the *ink* honest. If the
     * router is ever changed to clamp the reach, this is the case that says the
     * declaration has to be rewritten with it.
     */
    const field = drawn(deepFieldOf(multiRankCycle(), AMPLE));
    const floor = field.split.boundary + field.split.clearance;
    const inside = field.fanOut.filter((edge) =>
      edge.bend.some((point) => point.x < floor),
    );

    expect(inside.length).toBeGreaterThan(0);
    for (const edge of inside) expect(drawnExtentOf(edge)).toBeGreaterThanOrEqual(floor);
  });

  it("keeps every plate on its own side of the boundary", () => {
    for (const field of everyField()) {
      const { split, plates } = drawn(field);
      for (const plate of plates) {
        expect(plate.span.x + plate.span.width).toBeLessThanOrEqual(split.boundary);
      }
    }
  });

  it("gives every node exactly one plate and one mark", () => {
    for (const field of everyField()) {
      const { plates, columns } = drawn(field);
      const marked = columns.flatMap((column) => column.marks.map((mark) => mark.number));

      expect(marked.length).toBe(plates.length);
      expect(new Set(marked).size).toBe(plates.length);
    }
  });

  it("draws no empty column and skips no rank", () => {
    for (const field of everyField()) {
      const ranks = drawn(field).columns.map((column) => column.rank);
      expect(ranks).toEqual(ranks.map((_, index) => index));
      for (const column of drawn(field).columns) expect(column.marks.length).toBeGreaterThan(0);
    }
  });

  it("lays an empty map out as an empty picture rather than an absence", () => {
    const field = deepFieldOf(FIXTURES["empty-map"].model.map ?? mapOf([]), AMPLE);

    expect(drawn(field).columns).toEqual([]);
    expect(drawn(field).plates).toEqual([]);
    expect(drawn(field).fanOut).toEqual([]);
    // The gutter is reserved whether or not anything stands beside it.
    expect(drawn(field).split.boundary).toBeGreaterThan(0);
  });

  it("answers a map that is not open with the absence and no geometry", () => {
    expect(deepFieldOf(null, AMPLE)).toEqual({ kind: "noMapOpen" });
    expect(FIXTURES["no-map-open"].model.map).toBeNull();
    expect(deepFieldOf(FIXTURES["no-map-open"].model.map, AMPLE).kind).toBe("noMapOpen");
  });
});

describe("fan-out leaves the blocker and lands on what it releases", () => {
  it("draws one edge per named in-map blocker, however often it is named", () => {
    const field = deepFieldOf(
      mapOf([node(1), node(2, { state: "blocked", waitsOn: [1, 1] })]),
      AMPLE,
    );

    expect(drawn(field).fanOut).toHaveLength(1);
  });

  it("fans one finished ticket out to everything it unblocks", () => {
    const field = deepFieldOf(
      mapOf([
        node(1, { state: "resolved" }),
        node(2, { state: "blocked", waitsOn: [1] }),
        node(3, { state: "blocked", waitsOn: [1] }),
        node(4, { state: "blocked", waitsOn: [1] }),
      ]),
      AMPLE,
    );

    const out = drawn(field).fanOut.filter((edge) => edge.from === 1);
    expect(out.map((edge) => edge.to)).toEqual([2, 3, 4]);
    expect(out.every((edge) => edge.cleared)).toBe(true);
  });

  it("starts and ends on the marks it names, clear of both discs", () => {
    const field = deepFieldOf(mapOf([node(1), node(2, { waitsOn: [1] })]), AMPLE);
    const [edge] = drawn(field).fanOut;
    if (edge === undefined) throw new Error("no edge was drawn");

    const marks = drawn(field).columns.flatMap((column) => column.marks);
    const from = marks.find((mark) => mark.number === 1);
    const to = marks.find((mark) => mark.number === 2);

    expect(edge.start).toEqual({ x: (from?.at.x ?? 0) + (from?.radius ?? 0), y: from?.at.y });
    expect(edge.end).toEqual({ x: (to?.at.x ?? 0) - (to?.radius ?? 0), y: to?.at.y });
    expect(edge.bend[0].x).toBeGreaterThan(edge.start.x);
    expect(edge.bend[1].x).toBeLessThan(edge.end.x);
    expect(edge.spans).toBe(1);
  });
});

describe("the width floor and the stand-down", () => {
  it("stands down a pixel under what the map needs, and draws at the floor", () => {
    const map = wideRankZero();
    const needs = widthNeededFor(5);

    expect(deepFieldOf(map, needs).kind).toBe("field");
    expect(deepFieldOf(map, needs - 1).kind).toBe("standDown");
  });

  it("asks for more width the deeper the map goes", () => {
    expect(widthNeededFor(4)).toBeGreaterThan(widthNeededFor(1));
  });

  it("names the view, the reason, what it needs and what it has", () => {
    const map = mapOf([node(1), node(2, { state: "blocked", waitsOn: [1] })], {
      counts: { tickets: 2, open: 1, specs: 3 },
      frontier: { frontier: "designated", number: 1 },
    });
    const down = standing(deepFieldOf(map, 100));

    expect(down.view).toBe(VIEW_NAME);
    expect(down.reason).toContain("2 rank columns");
    expect(down.needs).toBe(widthNeededFor(2));
    expect(down.has).toBe(100);
  });

  it("keeps the three integers and the frontier alive when the graph is not", () => {
    const map = mapOf([node(1)], {
      counts: { tickets: 9, open: 4, specs: 1 },
      frontier: { frontier: "designated", number: 1 },
    });
    const down = standing(deepFieldOf(map, 10));

    expect(down.counts).toEqual({ tickets: 9, open: 4, specs: 1 });
    expect(down.frontier).toEqual({ frontier: "designated", number: 1 });
  });

  it("offers no exits, because the dial and the switcher are the shell's", () => {
    const down = standing(deepFieldOf(mapOf([node(1)]), 10));
    expect(Object.keys(down).sort()).toEqual([
      "counts",
      "fog",
      "frontier",
      "has",
      "needs",
      "reason",
      "view",
    ]);
  });

  it("carries the fog into the stand-down, unchanged from the drawn picture", () => {
    /*
     * The fog is words: it costs no width, so the state that cannot afford the
     * picture can still afford the region. Nobody surveyed is a finding, and a
     * region that disappeared with the graph would report it as *nothing to
     * report* — which is rule 4's floor, in the half of the fixture space where
     * this view draws nothing.
     */
    const map = FIXTURES["fog-unsurveyed"].model.map;
    if (map === null) throw new Error("fog-unsurveyed is a map");

    expect(standing(deepFieldOf(map, 10)).fog).toEqual({
      surveyed: false,
      heading: "Fog",
      absence: NOBODY_SURVEYED,
    });
    expect(standing(deepFieldOf(map, 10)).fog).toEqual(drawn(deepFieldOf(map, AMPLE)).fog);
  });

  it("treats an unmeasured width as no width rather than as enough", () => {
    expect(deepFieldOf(mapOf([node(1)]), Number.NaN).kind).toBe("standDown");
  });
});

describe("the competence band is data and never a refusal", () => {
  function bandAt(count: number) {
    const nodes = Array.from({ length: count }, (_, index) => node(index + 1));
    return drawn(deepFieldOf(mapOf(nodes), AMPLE)).competence;
  }

  it("names both edges of the band it is competent at", () => {
    expect([BAND_LOW, BAND_HIGH]).toEqual([12, 25]);
  });

  it("stands within the band at both edges and under it below", () => {
    expect(bandAt(BAND_LOW).standing).toBe("within");
    expect(bandAt(BAND_HIGH).standing).toBe("within");
    expect(bandAt(BAND_LOW - 1).standing).toBe("under");
  });

  it("draws a map above the band and says it is above it", () => {
    const above = deepFieldOf(
      mapOf(Array.from({ length: 40 }, (_, index) => node(index + 1))),
      AMPLE,
    );

    expect(drawn(above).competence).toMatchObject({ nodes: 40, standing: "over" });
    expect(numbersAt(above, 0)).toHaveLength(40);
  });
});

describe("what a plate says that a mark cannot", () => {
  it("carries the designation the model named and never picks one", () => {
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward map is a map");
    const designated = map.frontier.frontier === "designated" ? map.frontier.number : null;
    const field = deepFieldOf(map, AMPLE);

    const named = drawn(field).plates.filter((plate) => plate.designated);
    expect(named.map((plate) => plate.node.number)).toEqual(designated === null ? [] : [designated]);
  });

  it("carries the cut's reason as text on a plate that is still resolved", () => {
    const map = FIXTURES["out-of-scope"].model.map;
    if (map === null) throw new Error("the out-of-scope fixture is a map");
    const cut = drawn(deepFieldOf(map, AMPLE)).plates.filter((plate) => plate.cut !== null);

    expect(cut.length).toBeGreaterThan(0);
    for (const plate of cut) {
      expect(plate.cut).not.toBe("");
      expect(plate.state).toBe("resolved");
      expect(plate.stateName).toBe("resolved");
    }
  });

  it("says which children are not tickets in the model's own words", () => {
    const field = deepFieldOf(
      mapOf([
        node(1, { kind: { kind: "spec" } }),
        node(2, { kind: { kind: "unclassified" } }),
        node(3),
      ]),
      AMPLE,
    );

    expect(drawn(field).plates.map((plate) => plate.tag)).toEqual(["spec", "unclassified", null]);
  });

  it("carries the binding verdict rather than deciding it", () => {
    const map = FIXTURES["platform-bound-windows"].model.map;
    if (map === null) throw new Error("the platform-bound fixture is a map");
    const plates = drawn(deepFieldOf(map, AMPLE)).plates;

    expect(plates.filter((plate) => plate.boundElsewhere).length).toBeGreaterThan(0);
    for (const plate of plates) expect(plate.boundElsewhere).toBe(plate.node.boundElsewhere);
  });
});

describe("the fog names itself and its two absences differ in form", () => {
  function fogOf(name: "fog-unsurveyed" | "fog-empty" | "fog-charted") {
    const map = FIXTURES[name].model.map;
    if (map === null) throw new Error(`${name} is a map`);
    return drawn(deepFieldOf(map, AMPLE)).fog;
  }

  it("tells nobody surveyed from surveyed and found nothing", () => {
    const nobody = fogOf("fog-unsurveyed");
    const nothing = fogOf("fog-empty");

    expect(nobody).toEqual({ surveyed: false, heading: "Fog", absence: NOBODY_SURVEYED });
    expect(nothing).toMatchObject({ surveyed: true, count: 0, charted: FOG_ALL_CHARTED });
    // Different shapes, so no renderer can collapse them into one nullable
    // number and print `0` for both.
    expect(Object.keys(nobody)).not.toEqual(Object.keys(nothing));
  });

  it("carries the surveyed region's own text, unedited", () => {
    const charted = fogOf("fog-charted");
    if (!charted.surveyed) throw new Error("the charted fixture was surveyed");

    const map = FIXTURES["fog-charted"].model.map;
    const region = map?.fog.fog === "surveyed" ? map.fog.region : null;
    expect(charted.count).toBe(region?.count);
    expect(charted.text).toBe(region?.text);
    expect(charted.charted).toBeNull();
  });
});

describe("the same map in, the same picture out, and nothing kept", () => {
  it("answers two calls with equal pictures, on every fixture", () => {
    for (const name of FIXTURE_NAMES) {
      const map = FIXTURES[name].model.map;
      expect(deepFieldOf(map, AMPLE)).toEqual(deepFieldOf(map, AMPLE));
    }
  });

  it("draws the same picture whichever order the maps arrived in", () => {
    const wide = wideRankZero();
    const first = deepFieldOf(wide, AMPLE);
    deepFieldOf(mapOf([node(1), node(2, { waitsOn: [1] })]), AMPLE);

    expect(deepFieldOf(wide, AMPLE)).toEqual(first);
  });

  it("reaches for no store, no clock and no randomness", () => {
    const source = collect([".ts"]).find(
      (file) => file.path === "src/views/deep-field/deepField.ts",
    );

    expect(source).toBeDefined();
    expect(source?.text).not.toContain("localStorage");
    expect(source?.text).not.toContain("sessionStorage");
    expect(source?.text).not.toContain("Math.random");
    expect(source?.text).not.toContain("Date.");
    expect(source?.text).not.toContain("window.");
    expect(source?.text).not.toContain(".sort(");
    expect(source?.text).not.toContain("from \"react\"");
  });

  it("keeps three integers and nothing a renderer could make a bar of", () => {
    const map = FIXTURES["awkward-map"].model.map;
    const field = deepFieldOf(map, AMPLE);
    const down = standing(deepFieldOf(map, 10));

    expect(Object.keys(down.counts).sort()).toEqual(["open", "specs", "tickets"]);
    expect(map?.counts).toEqual(down.counts);
    // And the drawn value carries no second copy of them to disagree with.
    expect(drawn(field)).not.toHaveProperty("counts");
    expect(drawn(field)).not.toHaveProperty("frontier");
  });
});
