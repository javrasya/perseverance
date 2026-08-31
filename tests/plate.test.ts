import { describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import {
  COMPETENCE_BAND,
  MIN_STATION_GAP,
  PLATE_FLOOR,
  boxHolds,
  plateOf,
  plateStandDown,
  type Plate,
} from "../src/views/plate/plate";
import { type Cell, cellGap, cellsAlong, isOctolinear } from "../src/views/plate/router";

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
    expect(plate.provisional?.stationsWithoutPin).toEqual([]);
    expect(plate.provisional?.margin ?? 0).toBeGreaterThan(0);
    expect(plate.legend.map((entry) => entry.key)).toContain("provisional");
  });

  it("stamps it provisional when a ticket arrived with nowhere authored to go", () => {
    const plate = plateOf(branching(), new globalThis.Map([[1, { column: 4, row: 3 }]]));
    expect(plate.provisional?.stationsWithoutPin).toEqual([2, 3, 4]);
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

describe("the floor, as numbers", () => {
  it("never asks for less than the hard floor", () => {
    for (const [name, map] of fixtureMaps()) {
      expect(plateOf(map).requiredWidth, name).toBeGreaterThanOrEqual(PLATE_FLOOR);
    }
  });

  it("stands down under the floor and says which reading it is", () => {
    const plate = plateOf(branching());
    expect(plateStandDown(plate, plate.requiredWidth)).toBeNull();
    expect(plateStandDown(plate, PLATE_FLOOR - 1)).toEqual({
      view: "plate",
      why: "narrowerThanFloor",
      needs: plate.requiredWidth,
      has: PLATE_FLOOR - 1,
    });
  });

  it("tells the two readings of too narrow apart", () => {
    const wide = plateOf(mapOf(Array.from({ length: 24 }, (_, at) => node(at + 1))));
    const plate: Plate = { ...wide, requiredWidth: PLATE_FLOOR + 200 };
    expect(plateStandDown(plate, PLATE_FLOOR + 10)?.why).toBe("narrowerThanPlate");
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
