import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import {
  CELL_PIXELS,
  COMPETENCE_BAND,
  CUT_LABEL_COLUMNS,
  LABEL_COLUMNS,
  MIN_STATION_GAP,
  PIN_REACH,
  PLATE_CHROME,
  PLATE_FLOOR,
  boxHolds,
  plateOf,
  type Plate,
} from "../src/views/plate/plate";
import {
  VIEW_FLOORS,
  VIEW_GUTTER,
  floorOf,
  fractionOf,
  mapSideFor,
  sides,
  standDown,
  viewColumnAt,
} from "../src/panes/dial";
import { VIEWS } from "../src/views/views";
import { type Cell, cellGap, cellsAlong, isOctolinear } from "../src/views/plate/router";
import { FURTHEST_CELL } from "../src/views/plate/pins";

/**
 * The Plate's geometry, asserted without a DOM — there is no jsdom pragma here
 * because there is nothing on this side of the view that needs one. Everything
 * below is numbers.
 *
 * The fixture cases walk `FIXTURE_NAMES` rather than naming the snapshots.
 * `contract-declarations.test.ts` asserts that `src/snapshot/fixtures.ts` is the
 * only file in the repo that names them all, so a test that listed them would
 * turn that gate red — and a loop covers the ones added after this file anyway.
 */

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

/** Every map a fixture holds, minus the ones with no map open at all. */
function fixtureMaps(): readonly (readonly [string, Map])[] {
  const maps: (readonly [string, Map])[] = [];
  for (const name of FIXTURE_NAMES) {
    const map = FIXTURES[name].model.map;
    if (map !== null) maps.push([name, map] as const);
  }
  return maps;
}

/** A chain and a fan: 1 unlocks 2 and 3, 3 unlocks 4. Enough topology that the
 *  router has ranks, a fan and a diagonal to draw. */
function branching(): Map {
  return mapOf([
    node(1),
    node(2, { waitsOn: [1] }),
    node(3, { waitsOn: [1] }),
    node(4, { waitsOn: [3] }),
  ]);
}

function cellsOf(plate: Plate): readonly Cell[] {
  return plate.track.flatMap((one) => cellsAlong(one.points));
}

describe("the same map draws the same plate", () => {
  it("answers byte for byte the same twice, for every fixture", () => {
    for (const [name, map] of fixtureMaps()) {
      expect(plateOf(map), name).toEqual(plateOf(map));
    }
  });

  it("answers the same with pins as with pins, twice", () => {
    const pins = new globalThis.Map<number, Cell>([[1, { column: 4, row: 3 }]]);
    expect(plateOf(branching(), pins)).toEqual(plateOf(branching(), pins));
  });
});

describe("intra-rank order is map order", () => {
  it("never re-sorts a rank", () => {
    for (const [name, map] of fixtureMaps()) {
      const plate = plateOf(map);
      const order = map.nodes.map((one) => one.number);
      for (const rank of plate.ranks) {
        const asDrawn = [...rank];
        const asDragged = order.filter((number) => rank.includes(number));
        expect(asDrawn, `${name}: a rank was re-ordered`).toEqual(asDragged);
      }
      expect(plate.sidings, `${name}: sidings were re-ordered`).toEqual(
        order.filter((number) => plate.sidings.includes(number)),
      );
    }
  });

  it("leaves a rank in map order even when that order crosses", () => {
    /* 3 waits on 1 and 2 waits on 4: drawn in map order the two tracks cross,
       and swapping either rank would untangle them. Crossings are accepted
       output — the operator's order is not ours to improve. */
    const map = mapOf([node(1), node(4), node(3, { waitsOn: [1] }), node(2, { waitsOn: [4] })]);
    const plate = plateOf(map);
    expect(plate.ranks[0]).toEqual([1, 4]);
    expect(plate.ranks[1]).toEqual([3, 2]);
  });
});

describe("the track is octolinear", () => {
  it("draws no segment that is not horizontal, vertical or exactly 45°", () => {
    for (const [name, map] of fixtureMaps()) {
      for (const one of plateOf(map).track) {
        expect(isOctolinear(one.points), `${name}: ${one.from} to ${one.to}`).toBe(true);
        for (const segment of one.segments) {
          const dx = Math.abs(segment.to.column - segment.from.column);
          const dy = Math.abs(segment.to.row - segment.from.row);
          const octolinear =
            (segment.kind === "horizontal" && dy === 0) ||
            (segment.kind === "vertical" && dx === 0) ||
            (segment.kind === "diagonal" && dx === dy && dx > 0);
          expect(octolinear, `${name}: ${segment.kind} ${dx}x${dy}`).toBe(true);
        }
      }
    }
  });

  it("draws every track on a graph with ranks, sources and a fan", () => {
    const plate = plateOf(branching());
    expect(plate.unrouted).toEqual([]);
    expect(plate.track.map((one) => [one.from, one.to])).toEqual([
      [1, 2],
      [1, 3],
      [3, 4],
    ]);
    for (const one of plate.track) expect(one.segments.length).toBeGreaterThan(0);
  });
});

describe("annotation gets space the topology cannot grow into", () => {
  it("routes no track through a reserved label box", () => {
    for (const [name, map] of fixtureMaps()) {
      const plate = plateOf(map);
      const walked = cellsOf(plate);
      for (const station of plate.stations) {
        for (const cell of walked) {
          expect(
            boxHolds(station.label.box, cell),
            `${name}: track at ${cell.column},${cell.row} crosses ${station.number}'s label`,
          ).toBe(false);
        }
      }
    }
  });

  it("routes no track through a label box on a plate with a fan in it", () => {
    const plate = plateOf(branching());
    const walked = cellsOf(plate);
    expect(walked.length).toBeGreaterThan(0);
    for (const station of plate.stations) {
      for (const cell of walked) expect(boxHolds(station.label.box, cell)).toBe(false);
    }
  });

  it("gives every station a box of its own, at one of the eight anchors", () => {
    for (const [name, map] of fixtureMaps()) {
      const plate = plateOf(map);
      for (const station of plate.stations) {
        expect(station.label.box.columns * station.label.box.rows, name).toBeGreaterThan(0);
        expect(boxHolds(station.label.box, station.at), name).toBe(false);
      }
    }
  });
});

describe("the two-cell minimum station gap", () => {
  it("holds between every pair of generated stations", () => {
    for (const [name, map] of fixtureMaps()) {
      const stations = plateOf(map).stations;
      for (const one of stations) {
        for (const other of stations) {
          if (one.number === other.number) continue;
          expect(cellGap(one.at, other.at), `${name}: ${one.number} and ${other.number}`)
            .toBeGreaterThanOrEqual(MIN_STATION_GAP);
        }
      }
    }
  });

  it("moves a generated station out of a pinned one's way rather than the reverse", () => {
    const pin = { column: 4, row: 3 };
    const plate = plateOf(branching(), new globalThis.Map([[2, pin]]));
    const pinned = plate.stations.find((one) => one.number === 2);
    const generated = plate.stations.find((one) => one.number === 1);
    expect(pinned?.at).toEqual(pin);
    expect(cellGap(generated?.at ?? pin, pin)).toBeGreaterThanOrEqual(MIN_STATION_GAP);
  });
});

describe("unserved sources go on sidings", () => {
  it("takes the ones nothing waits on that wait on nothing here", () => {
    const map = mapOf([node(1), node(2, { waitsOn: [1] }), node(9)]);
    const plate = plateOf(map);

    expect(plate.sidings).toEqual([9]);
    expect(plate.ranks.flat()).toEqual([1, 2]);
    expect(plate.stations.find((one) => one.number === 9)?.siding).toBe(true);
    expect(plate.stations.find((one) => one.number === 1)?.siding).toBe(false);
    expect(plate.legend.map((entry) => entry.key)).toContain("siding");
    expect(plate.legend.find((entry) => entry.key === "siding")?.count).toBe(1);
    expect(plate.legend.find((entry) => entry.key === "siding")?.meaning).not.toBe("");
  });

  it("explains nothing it is not drawing", () => {
    expect(plateOf(branching()).legend.map((entry) => entry.key)).not.toContain("siding");
  });

  it("agrees with itself on every fixture", () => {
    for (const [name, map] of fixtureMaps()) {
      const plate = plateOf(map);
      const sidings = plate.stations.filter((one) => one.siding).map((one) => one.number);
      expect(sidings, name).toEqual([...plate.sidings]);
      for (const number of plate.sidings) {
        expect(plate.ranks.flat(), name).not.toContain(number);
        expect(plate.track.some((one) => one.from === number || one.to === number), name).toBe(
          false,
        );
      }
    }
  });
});

describe("fan-out is drawn", () => {
  it("gives one station unlocking several a stem and its branches", () => {
    const plate = plateOf(branching());
    expect(plate.fans.map((fan) => fan.from)).toEqual([1]);

    const fan = plate.fans[0];
    expect(fan?.branches.map((branch) => branch.to)).toEqual([2, 3]);
    // Every branch leaves the station along the same stub, so the shared run is
    // at least the station cell and the cell east of it.
    expect(fan?.spine.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(plate.legend.map((entry) => entry.key)).toContain("fan");
  });

  it("calls one track out of a station no fan", () => {
    expect(plateOf(mapOf([node(1), node(2, { waitsOn: [1] })])).fans).toEqual([]);
  });
});

describe("pins", () => {
  it("never moves a pinned station", () => {
    const pins = new globalThis.Map<number, Cell>([
      [1, { column: 2, row: 2 }],
      [2, { column: 14, row: 9 }],
      [3, { column: 14, row: 20 }],
      [4, { column: 26, row: 20 }],
    ]);
    const plate = plateOf(branching(), pins);
    for (const station of plate.stations) {
      expect(station.pinned).toBe(true);
      expect(station.at).toEqual(pins.get(station.number));
    }
    expect(plate.provisional).toBeNull();
  });

  it("stamps the plate provisional when a pin names a ticket that has gone", () => {
    const pins = new globalThis.Map<number, Cell>([
      [1, { column: 4, row: 3 }],
      [2, { column: 12, row: 3 }],
      [3, { column: 12, row: 9 }],
      [4, { column: 20, row: 9 }],
      [99, { column: 30, row: 30 }],
    ]);
    const plate = plateOf(branching(), pins);
    expect(plate.provisional?.pinsWithoutStation).toEqual([99]);
    expect(plate.provisional?.pinsOffThePlate).toEqual([]);
    expect(plate.provisional?.margin ?? 0).toBeGreaterThan(0);
    expect(plate.legend.map((entry) => entry.key)).toContain("provisional");
  });

  it("leaves a half-arranged plate alone: one dragged station is not a stale layout", () => {
    /* The ordinary state after the first drag — one pin, three stations still
       generated. Nothing has come apart, so nothing is stamped and nothing in
       the legend claims the graph has moved. */
    const plate = plateOf(branching(), new globalThis.Map([[1, { column: 4, row: 3 }]]));
    expect(plate.provisional).toBeNull();
    expect(plate.legend.map((entry) => entry.key)).not.toContain("provisional");
  });

  it("calls a plate nobody arranged by hand provisional in neither direction", () => {
    expect(plateOf(branching()).provisional).toBeNull();
    for (const [name, map] of fixtureMaps()) {
      expect(plateOf(map).provisional, name).toBeNull();
    }
  });
});

describe("blockers beyond the map", () => {
  it("draws no station and no track for a number with no row here", () => {
    const plate = plateOf(mapOf([node(1), node(2, { waitsOn: [1, 404] })]));

    expect(plate.beyondTheMap).toBe(1);
    expect(plate.stations.map((one) => one.number)).toEqual([1, 2]);
    expect(plate.track.map((one) => [one.from, one.to])).toEqual([[1, 2]]);
    expect(plate.ranks).toEqual([[1], [2]]);
    expect(plate.legend.map((entry) => entry.key)).toContain("beyondTheMap");
  });

  it("does not let one keep a source off its siding", () => {
    // 7 waits only on something beyond the map, so this drawing has no track at
    // either end of it: it is an unserved source here whatever it names.
    const plate = plateOf(mapOf([node(1), node(2, { waitsOn: [1] }), node(7, { waitsOn: [404] })]));
    expect(plate.sidings).toEqual([7]);
    expect(plate.beyondTheMap).toBe(1);
  });
});

describe("an absence draws an empty plate rather than throwing", () => {
  it("answers a well-formed plate for no map open", () => {
    const plate = plateOf(null);
    expect(plate.stations).toEqual([]);
    expect(plate.ranks).toEqual([]);
    expect(plate.track).toEqual([]);
    expect(plate.legend).toEqual([]);
    expect(plate.requiredWidth).toBe(PLATE_FLOOR);
    expect(plate.competence.stations).toBe(0);
  });

  it("answers the same for a map with nothing on it", () => {
    expect(plateOf(FIXTURES["empty-map"].model.map)).toEqual(plateOf(null));
    expect(plateOf(mapOf([]))).toEqual(plateOf(null));
  });

  it("draws every fixture without throwing", () => {
    for (const [name, map] of fixtureMaps()) {
      expect(() => plateOf(map), name).not.toThrow();
    }
  });
});

describe("a pin outside the drawing is not a pin on it", () => {
  /*
   * `pins.ts` accepts any cell out to `FURTHEST_CELL` as sane *storage*, and the
   * field the router searches spans every cell on the plate — so a pin parked
   * near that bound was a field of millions of cells, allocated and cleared once
   * per edge, from a value both validators call legal. The plate's own reach is
   * the answer: a station dragged that far is not somewhere on this drawing, so
   * the pin is not read and the station keeps the cell the plate generated.
   */
  it("places the stations it would have placed, over a field that stayed small", () => {
    const map = branching();
    const far = new globalThis.Map<number, Cell>([
      [1, { column: FURTHEST_CELL, row: FURTHEST_CELL }],
    ]);
    const plate = plateOf(map, far);
    const generated = plateOf(map);
    expect(plate.stations.map((one) => one.at)).toEqual(generated.stations.map((one) => one.at));
    expect(plate.stations.some((one) => one.pinned)).toBe(false);
    /* Said out loud rather than silently: an authored position this drawing
       will not read is an arrangement that has come apart, which is what
       `provisional` is for. */
    expect(plate.provisional?.pinsOffThePlate).toEqual([1]);
    /* The number that matters is the field's, because the router allocates over
       it: unbounded, this is `FURTHEST_CELL` squared. */
    expect(plate.extent.columns * plate.extent.rows).toBeLessThan(10_000);
  });

  it("keeps the pins on the drawing and drops only the ones off it", () => {
    const map = branching();
    const pins = new globalThis.Map<number, Cell>([
      [1, { column: 4, row: 3 }],
      [2, { column: FURTHEST_CELL, row: 2 }],
    ]);
    const plate = plateOf(map, pins);
    const stationOf = (number: number) => plate.stations.find((one) => one.number === number);

    expect(stationOf(1)?.at).toEqual({ column: 4, row: 3 });
    expect(stationOf(2)?.pinned).toBe(false);
    expect(stationOf(2)?.at.column).toBeLessThan(FURTHEST_CELL);
    /* And it is said out loud rather than quietly: an arrangement that no longer
       matches the graph is what `provisional` is for. */
    expect(plate.provisional?.pinsOffThePlate).toContain(2);
    expect(plate.extent.columns * plate.extent.rows).toBeLessThan(10_000);
  });

  it("still honours a station dragged well clear of the generated drawing", () => {
    const map = branching();
    const out = { column: 4 + PIN_REACH, row: 3 };
    const plate = plateOf(map, new globalThis.Map<number, Cell>([[1, out]]));
    const one = plate.stations.find((station) => station.number === 1);
    expect(one?.pinned).toBe(true);
    expect(one?.at).toEqual(out);
  });
});

describe("the floor, as numbers", () => {
  it("never asks for less than the hard floor", () => {
    for (const [name, map] of fixtureMaps()) {
      expect(plateOf(map).requiredWidth, name).toBeGreaterThanOrEqual(PLATE_FLOOR);
    }
  });

  /*
   * The floor is the registry's, not this module's second opinion. #63's
   * acceptance criterion is a hard ~700px floor with an explicit stand-down, and
   * this is where the geometry's number and the shell's answer are held to each
   * other: the view is registered, `VIEW_FLOORS.plate` is what the map side has
   * to be for the *field* to get `PLATE_FLOOR`, and `standDown` names the view,
   * what it needs, what it has and two exits.
   */
  it("is registered at its own floor, and stands down under it", () => {
    expect(VIEW_FLOORS.plate).toBe(mapSideFor(PLATE_FLOOR + PLATE_CHROME));
    expect(floorOf("plate")).toBe(VIEW_FLOORS.plate);

    /* A window whose map side is under the floor at every detent. */
    const narrow = 690;
    expect(sides(fractionOf("map"), narrow).map).toBeLessThan(floorOf("plate"));
    const standing = standDown("plate", fractionOf("split"), narrow, VIEWS);
    expect(standing?.view).toBe("plate");
    expect(standing?.needs).toBe(floorOf("plate"));
    expect(standing?.exits).toHaveLength(2);

    /* And a window wide enough is drawn rather than explained. */
    expect(standDown("plate", fractionOf("map"), floorOf("plate") + 10, VIEWS)).toBeNull();
  });

  /*
   * The floor is what the *field* gets, which is the whole of what a floor on a
   * drawing can mean.
   *
   * #63 first compared `PLATE_FLOOR` against the map side, and the map side is a
   * flex row: the launcher and the rail are drawn beside the view column, the
   * shell pads the column it hands over (`VIEW_GUTTER`), and this view spends
   * `PLATE_CHROME` more of what is left on its reserved margin. At 700px of map
   * side the drawing was left under two hundred pixels — the three inches the
   * floor exists to refuse — and with the shell's own padding left out of the
   * composition it was still 32px short of the promise. So every term is spent
   * here: at exactly the registered floor the field is worth `PLATE_FLOOR`, and
   * a pixel under it, it is not.
   */
  it("hands the field the pixels the floor promises", () => {
    const field = (mapSide: number) => viewColumnAt(mapSide) - VIEW_GUTTER - PLATE_CHROME;

    expect(field(floorOf("plate"))).toBeGreaterThanOrEqual(PLATE_FLOOR);
    expect(field(floorOf("plate") - 1)).toBeLessThan(PLATE_FLOOR);
  });

  /*
   * And the chrome is read out of the stylesheets rather than asserted from the
   * same comments that set it: `PLATE_CHROME` is three declarations in
   * `Plate.module.css` and two tokens, `VIEW_GUTTER` is one declaration in
   * `App.module.css`, and a sheet that widens either with these numbers left
   * behind is exactly the drift this whole test exists for. Both sheets, because
   * reading only the view's own is how the shell's padding went uncharged in the
   * first place.
   */
  it("keeps the chrome it charges for and the chrome it draws in step", () => {
    const sheet = readFileSync(
      new URL("../src/views/plate/Plate.module.css", import.meta.url),
      "utf8",
    );
    expect(sheet).toContain("flex: 0 0 18rem");
    /* The field is beside the margin, and the gap and the padding are the view's
       own — one gap, and padding on both sides of the row. */
    expect(sheet).toContain("gap: var(--s-space-loose)");
    expect(sheet).toContain("padding: var(--s-space-base)");

    const tokens = readFileSync(
      new URL("../src/styles/tokens/primitive.css", import.meta.url),
      "utf8",
    );
    expect(tokens).toContain("--p-space-4: 16px");
    expect(tokens).toContain("--p-space-5: 24px");

    const semantic = readFileSync(
      new URL("../src/styles/tokens/semantic.css", import.meta.url),
      "utf8",
    );
    expect(semantic).toContain("--s-space-base: var(--p-space-4)");
    expect(semantic).toContain("--s-space-loose: var(--p-space-5)");

    expect(PLATE_CHROME).toBe(18 * 16 + 24 + 16 * 2);

    /* And the gutter the shell draws around the view, out of the shell's own
       sheet: `.view` is where the Plate is rendered, and its padding is on both
       sides of the box the view is handed. */
    const shell = readFileSync(new URL("../src/App.module.css", import.meta.url), "utf8");
    const viewRule = shell.slice(shell.indexOf("\n.view {"));
    expect(viewRule.slice(0, viewRule.indexOf("}"))).toContain("padding: var(--s-space-base)");
    expect(VIEW_GUTTER).toBe(16 * 2);
  });

  /*
   * Above the floor and under this drawing's own width there is deliberately no
   * second stand-down: the view is drawn at natural size and the column scrolls,
   * because a plate scaled under 1:1 is a plate whose reserved label boxes no
   * longer hold their words. What the geometry still owes is the number — the
   * width the drawing needs — and it is a measurement rather than a floor.
   */
  it("asks for the width the drawing needs and never for a re-layout", () => {
    const wide = plateOf(mapOf(Array.from({ length: 24 }, (_, at) => node(at + 1))));
    expect(wide.requiredWidth).toBe(
      Math.max(PLATE_FLOOR, wide.extent.columns * CELL_PIXELS),
    );
    expect(standDown("plate", fractionOf("map"), floorOf("plate") + 10, VIEWS)).toBeNull();
  });

  it("carries the competence band rather than a comment about it", () => {
    expect(COMPETENCE_BAND).toEqual({ from: 12, to: 20 });

    const thin = plateOf(branching());
    expect(thin.competence.band).toEqual(COMPETENCE_BAND);
    expect(thin.competence.verdict).toBe("thin");

    const chain = mapOf(
      Array.from({ length: 14 }, (_, at) => node(at + 1, at === 0 ? {} : { waitsOn: [at] })),
    );
    expect(plateOf(chain).competence.verdict).toBe("competent");
    expect(plateOf(chain).competence.flat).toBe(false);
  });

  it("says so when nothing on the map waits on anything", () => {
    const flat = plateOf(mapOf([node(1), node(2), node(3)]));
    expect(flat.competence.flat).toBe(true);
    expect(flat.track).toEqual([]);
  });
});

/**
 * The band, drawn rather than only computed.
 *
 * `COMPETENCE_BAND` is a claim this view makes about itself on screen, and
 * until a map in the fixture set reached twelve stations it was a claim nothing
 * rendered ever tested: every fixture drew *thin*, so *competent* — the one
 * verdict the legend says nothing about, because there is nothing to warn a
 * reader of — was a word no drawing had been asked for. What
 * is asserted here is that the set now holds such a map and that it has the
 * structures the band is a claim about — ranks with corners in them, a fan and
 * a siding — because a fifteen-station map with no topology would satisfy the
 * count and answer none of the question.
 */
describe("the band the plate claims is a map somebody can open", () => {
  it("holds a fixture inside twelve to twenty, with the structures to go with it", () => {
    const competent = fixtureMaps()
      .map(([name, map]) => [name, plateOf(map)] as const)
      .filter(([, plate]) => plate.competence.verdict === "competent");
    expect(competent.length).toBeGreaterThan(0);

    for (const [name, plate] of competent) {
      expect([name, plate.competence.stations >= COMPETENCE_BAND.from]).toEqual([name, true]);
      expect([name, plate.competence.stations <= COMPETENCE_BAND.to]).toEqual([name, true]);
      expect([name, plate.stations.length]).toEqual([name, plate.competence.stations]);
      /* A map this size that draws no track is a list with dots on it, and the
         band would be a claim about nothing. */
      expect([name, plate.competence.flat]).toEqual([name, false]);
    }

    const [name, band] = competent[0] ?? ["none", plateOf(null)];
    /* Ranks: the rows the routed stations sit on, sidings excepted — those are
       below the plate by construction and are not a rank. */
    const ranks = new Set(
      band.stations.filter((station) => !station.siding).map((station) => station.at.row),
    );
    expect([name, ranks.size >= 4]).toEqual([name, true]);
    expect([name, band.sidings.length > 0]).toEqual([name, true]);
    expect([name, band.fans.length > 0]).toEqual([name, true]);
    /* Corners, and not one straight run: a route with more than two points has
       bent at least once on the way. */
    expect([name, band.track.some((one) => one.points.length > 2)]).toEqual([name, true]);
  });
});

/**
 * The cut station's double plate, reserved rather than painted.
 *
 * A cut carries the words the branch stopped in, and this view puts them on the
 * drawing as text — which needs twice the room a name needs. The room is the
 * thing asserted here: a width the renderer doubled on its own would be pixels
 * over cells the router still believed were free, and the extent would still be
 * sized for half of it, so the second half of the plate would sit across live
 * track or off the edge of the drawing depending on which anchor won.
 */
describe("a cut station's plate is reserved twice across, not widened at paint time", () => {
  const REASON = "Out of scope: the vendor owns this half of the pipeline.";

  it("reserves the double box, keeps track out of all of it, and sizes the drawing round it", () => {
    const map = mapOf([
      node(1),
      node(2, { waitsOn: [1], cut: { cut: "fromScope", reason: REASON } }),
      node(3, { waitsOn: [1] }),
      node(4, { waitsOn: [3] }),
    ]);
    const plate = plateOf(map);
    const cut = plate.stations.find((station) => station.node.cut.cut === "fromScope");
    expect(cut).toBeDefined();
    if (cut === undefined) return;

    expect(cut.label.box.columns).toBe(CUT_LABEL_COLUMNS);
    expect(CUT_LABEL_COLUMNS).toBe(LABEL_COLUMNS * 2);
    for (const station of plate.stations) {
      if (station.number === cut.number) continue;
      expect([station.number, station.label.box.columns]).toEqual([station.number, LABEL_COLUMNS]);
    }

    /* The whole of the double box is in the router's field as blocked, which is
       only checkable from out here as the thing it buys: no length of track
       anywhere on the plate crosses any cell of it. */
    for (const cell of cellsOf(plate)) {
      expect([cell, boxHolds(cut.label.box, cell)]).toEqual([cell, false]);
    }

    // And the extent is sized for the box the plate is drawn at, so no part of
    // the reason can fall outside the viewBox and be clipped away.
    const { origin, columns, rows } = plate.extent;
    expect(cut.label.box.column).toBeGreaterThanOrEqual(origin.column);
    expect(cut.label.box.column + cut.label.box.columns).toBeLessThanOrEqual(
      origin.column + columns,
    );
    expect(cut.label.box.row).toBeGreaterThanOrEqual(origin.row);
    expect(cut.label.box.row + cut.label.box.rows).toBeLessThanOrEqual(origin.row + rows);
  });

  /* Every anchor, not only the one a fixture happens to pick. The doubling used
     to live in the renderer, where a `west` anchor drew the second half back
     across the station's own glyph and the corridor its track leaves by; with
     the width in the reservation the box is the box whichever way it faces. */
  it("holds for whichever anchor the solver gives it", () => {
    const anchors = new Set<string>();
    for (let extra = 0; extra < 8; extra += 1) {
      const map = mapOf([
        node(1),
        node(2, { waitsOn: [1], cut: { cut: "fromScope", reason: REASON } }),
        ...Array.from({ length: extra }, (_, at) => node(at + 3, { waitsOn: [1] })),
      ]);
      const plate = plateOf(map);
      const cut = plate.stations.find((station) => station.node.cut.cut === "fromScope");
      if (cut === undefined) continue;
      anchors.add(cut.label.anchor);
      expect([cut.label.anchor, cut.label.box.columns]).toEqual([
        cut.label.anchor,
        CUT_LABEL_COLUMNS,
      ]);
      for (const cell of cellsOf(plate)) {
        expect([cut.label.anchor, boxHolds(cut.label.box, cell)]).toEqual([
          cut.label.anchor,
          false,
        ]);
      }
    }
    expect(anchors.size).toBeGreaterThan(0);
  });
});

/**
 * A station walled in by somebody's hand, and the drawing saying so.
 *
 * The router answers `null` rather than running track through a reserved label
 * box, and the only way to reach that answer is an authored pin — the free lane
 * round the outside is a detour from everywhere else. What is asserted is that
 * the answer does not stop there: an edge that is on the map and not in the
 * picture is counted in `unrouted` *and* named in the legend, because a diagram
 * quietly missing a dependency reads as a map that does not have one.
 */
describe("an edge the router could not draw is said out loud", () => {
  /** A ring of pinned stations round node 2, at a radius its arrival corridor
   *  cannot reach through, and node 1 outside it waiting to reach it. */
  function walledIn(): { map: Map; pins: globalThis.Map<number, Cell> } {
    const at = { column: 60, row: 60 };
    const ring: Cell[] = [];
    for (const along of [-3, 0, 3]) {
      ring.push({ column: at.column - 4, row: at.row + along });
      ring.push({ column: at.column + 4, row: at.row + along });
      ring.push({ column: at.column + along, row: at.row - 4 });
      ring.push({ column: at.column + along, row: at.row + 4 });
    }
    const pins = new globalThis.Map<number, Cell>([[2, at]]);
    ring.forEach((cell, index) => pins.set(index + 3, cell));
    return {
      map: mapOf([
        node(1),
        node(2, { waitsOn: [1] }),
        ...ring.map((_, index) => node(index + 3)),
      ]),
      pins,
    };
  }

  it("counts the edge and gives the legend a line about it", () => {
    const { map, pins } = walledIn();
    const walled = plateOf(map, pins);
    expect(walled.unrouted).toEqual([{ from: 1, to: 2 }]);
    expect(walled.track.some((one) => one.from === 1 && one.to === 2)).toBe(false);

    const said = walled.legend.find((entry) => entry.key === "unrouted");
    expect(said?.count).toBe(1);
    expect(said?.meaning.length ?? 0).toBeGreaterThan(0);

    // And the same map with nobody's hand on it draws the edge and says nothing.
    const generated = plateOf(map);
    expect(generated.unrouted).toEqual([]);
    expect(generated.legend.some((entry) => entry.key === "unrouted")).toBe(false);
  });
});

/**
 * The verdict, in the margin rather than only in the return value.
 *
 * `COMPETENCE_BAND` is this view's own claim about where it is worth reading,
 * and a view that computes *you are outside what I am for* and keeps it to
 * itself has left the operator to find that out by squinting. So every verdict
 * but `competent` is a legend line, and `competent` is none: there is nothing
 * to warn a reader about a drawing doing what it was built for.
 */
describe("the plate says when the map is outside what it is for", () => {
  it("gives every verdict but competent a legend line, counted in stations", () => {
    const cases: readonly (readonly [number, string])[] = [
      [3, "thin"],
      [COMPETENCE_BAND.to + 4, "crowded"],
    ];
    for (const [count, verdict] of cases) {
      const map = mapOf(
        Array.from({ length: count }, (_, at) => node(at + 1, at === 0 ? {} : { waitsOn: [at] })),
      );
      const plate = plateOf(map);
      expect([count, plate.competence.verdict]).toEqual([count, verdict]);
      const said = plate.legend.find((entry) => entry.key === verdict);
      expect([count, said?.count]).toEqual([count, count]);
      /* First in the margin: it is the one line that changes how everything
         under it should be read. */
      expect([count, plate.legend[0]?.key]).toEqual([count, verdict]);
    }

    const competent = plateOf(
      mapOf(Array.from({ length: 14 }, (_, at) => node(at + 1, at === 0 ? {} : { waitsOn: [at] }))),
    );
    expect(competent.competence.verdict).toBe("competent");
    const verdicts = new Set(["thin", "crowded", "hairball"]);
    expect(competent.legend.filter((entry) => verdicts.has(entry.key))).toEqual([]);
  });
});
