import { describe, expect, it } from "vitest";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Model } from "../src/snapshot/model.generated";
import {
  BENCH_WIDTH_FLOOR,
  CUT_PLATE_WIDTH,
  PLATE_WIDTH,
  benchOf,
  type Bench,
} from "../src/views/bench/bench";

/**
 * The Bench's arithmetic, and nothing that has to be rendered to be asked.
 *
 * Every case here goes through `benchOf` and reads what it answered — a plate's
 * rank, its width, the order of a band, an edge that is or is not there. None
 * of them reaches inside for a ranking table or a routing intermediate: those
 * are the parts most likely to be rewritten, and a test that pinned their shape
 * would be a test that has to be rewritten with them while saying nothing about
 * what is on screen.
 *
 * The widths are stated as multiples of the plate rather than as round numbers,
 * so a case about wrapping goes on being about wrapping if the plate is ever
 * re-measured.
 */

const WIDE = 1400;

function drawn(model: Model, width = WIDE): Extract<Bench, { drawn: true }> {
  const bench = benchOf(model, width);
  if (!bench.drawn) throw new Error(`stood down at ${width}, needing ${bench.needs}`);
  return bench;
}

function rankOf(bench: Extract<Bench, { drawn: true }>, number: number): number {
  const plate = bench.plates.find((one) => one.node.number === number);
  if (plate === undefined) throw new Error(`no plate for #${number}`);
  return plate.rank;
}

const awkward = FIXTURES["awkward-map"].model;
const wide = FIXTURES["wide-map"].model;

describe("ranking", () => {
  /**
   * The tangled map is the one that matters. `awkward-map` closes a cycle on
   * purpose — #71 waits on #72, which waits on #75, which waits on #71 — and an
   * operator who tangles a map still gets a drawing. What is asserted is that
   * every child is placed exactly once and that the answer is a finite set of
   * ranks; which edge of the cycle was cut is the walk's business, and pinning
   * it here would be pinning an implementation.
   */
  it("draws a map whose dependencies close a cycle", () => {
    const bench = drawn(awkward);
    const map = awkward.map;
    if (map === null) throw new Error("the awkward map has a map");

    expect(bench.plates).toHaveLength(map.nodes.length);
    expect(new Set(bench.plates.map((plate) => plate.node.number)).size).toBe(
      map.nodes.length,
    );
    for (const plate of bench.plates) {
      expect(Number.isFinite(plate.rank)).toBe(true);
      expect(plate.rank).toBeGreaterThanOrEqual(0);
    }
  });

  it("puts a node behind everything it waits on, by the longest path", () => {
    const bench = drawn(wide);

    // #221 waits on two sources, #225 waits on #221 and #222, #227 on #225 and
    // #226, #228 on #227: four hops from a source, and the rank counts them.
    expect(rankOf(bench, 204)).toBe(0);
    expect(rankOf(bench, 221)).toBe(1);
    expect(rankOf(bench, 225)).toBe(2);
    expect(rankOf(bench, 227)).toBe(3);
    expect(rankOf(bench, 228)).toBe(4);
  });

  it("gives the map a wide first rank and narrow ones behind it", () => {
    const bench = drawn(wide);
    const perRank = bench.bands.map((band) => band.plates.length);
    expect(perRank).toEqual([20, 4, 2, 1, 1]);
  });
});

describe("the wrapped band", () => {
  it("wraps a rank too wide for the window into rows of its own band", () => {
    const narrow = BENCH_WIDTH_FLOOR;
    const bench = drawn(wide, narrow);
    const first = bench.bands[0];
    if (first === undefined) throw new Error("rank 0 is drawn");

    expect(bench.columns).toBe(3);
    expect(first.rows).toBeGreaterThan(1);
    expect(new Set(first.plates.map((plate) => plate.y)).size).toBe(first.rows);
    // Nothing hangs off the right-hand edge, doubled plates included.
    for (const plate of first.plates) {
      expect(plate.x + plate.width).toBeLessThanOrEqual(narrow);
    }
  });

  it("keeps the operator's own order across the wrap", () => {
    const map = wide.map;
    if (map === null) throw new Error("the wide map has a map");
    const dragged = map.nodes.map((node) => node.number);

    for (const width of [BENCH_WIDTH_FLOOR, 900, WIDE]) {
      const bench = drawn(wide, width);
      expect(bench.plates.map((plate) => plate.node.number)).toEqual(dragged);

      const band = bench.bands[0];
      if (band === undefined) throw new Error("rank 0 is drawn");
      const onBand = band.plates.map((plate) => plate.node.number);
      // Read left to right and then down, a band is the drag order filtered.
      expect(onBand).toEqual(dragged.filter((number) => onBand.includes(number)));
      const reading = [...band.plates].sort(
        (one, other) => one.y - other.y || one.x - other.x,
      );
      expect(reading.map((plate) => plate.node.number)).toEqual(onBand);
    }
  });

  it("answers the same layout twice for the same input", () => {
    expect(JSON.stringify(benchOf(wide, WIDE))).toBe(JSON.stringify(benchOf(wide, WIDE)));
    expect(JSON.stringify(benchOf(awkward, 900))).toBe(
      JSON.stringify(benchOf(awkward, 900)),
    );
  });
});

describe("the floor", () => {
  it("stands down below the floor rather than drawing a squashed schematic", () => {
    const bench = benchOf(wide, BENCH_WIDTH_FLOOR - 1);
    expect(bench.drawn).toBe(false);
    if (bench.drawn) return;
    expect(bench.needs).toBe(BENCH_WIDTH_FLOOR);
    expect(bench.has).toBe(BENCH_WIDTH_FLOOR - 1);
  });

  it("draws at the floor itself", () => {
    const bench = benchOf(wide, BENCH_WIDTH_FLOOR);
    expect(bench.drawn).toBe(true);
  });
});

describe("plates", () => {
  it("doubles the plate of a cut ticket and carries its reason as text", () => {
    const bench = drawn(wide);
    const cut = bench.plates.find((plate) => plate.reason !== null);
    if (cut === undefined) throw new Error("the wide map cuts one ticket");

    expect(cut.node.number).toBe(212);
    expect(cut.width).toBe(CUT_PLATE_WIDTH);
    expect(cut.width).toBeGreaterThan(PLATE_WIDTH);
    expect(cut.reason).toContain("tray icon");
    // Long enough that a standard plate could not have held it, which is the
    // whole reason the second width exists.
    expect((cut.reason ?? "").length).toBeGreaterThan(120);

    for (const plate of bench.plates) {
      if (plate.reason === null) expect(plate.width).toBe(PLATE_WIDTH);
    }
  });

  it("says what waits on a node as well as what it waits on", () => {
    const bench = drawn(wide);
    const source = bench.plates.find((plate) => plate.node.number === 201);
    const waiting = bench.plates.find((plate) => plate.node.number === 224);
    if (source === undefined || waiting === undefined) throw new Error("both are drawn");

    expect(source.facts.fanOut).toEqual([221]);
    expect(waiting.facts.fanOut).toEqual([226]);
    // #224 waits on four children of this map, one of them already resolved,
    // and on #499, which this map has never heard of.
    expect(waiting.facts.stillInTheWay).toBe(3);
    expect(waiting.facts.beyondTheMap).toBe(1);
  });
});

describe("edges", () => {
  it("draws no edge for a blocker that is not on this map", () => {
    const bench = drawn(wide);
    expect(bench.beyondTheMap).toEqual([499]);

    const numbers = new Set(bench.plates.map((plate) => plate.node.number));
    for (const edge of bench.edges) {
      expect(numbers.has(edge.from)).toBe(true);
      expect(numbers.has(edge.to)).toBe(true);
    }
    expect(bench.edges.some((edge) => edge.from === 499 || edge.to === 499)).toBe(false);
  });

  it("routes every edge orthogonally into the plate that waits", () => {
    const bench = drawn(wide);
    expect(bench.edges.length).toBeGreaterThan(0);

    for (const edge of bench.edges) {
      for (let index = 1; index < edge.points.length; index += 1) {
        const before = edge.points[index - 1];
        const here = edge.points[index];
        if (before === undefined || here === undefined) throw new Error("a polyline");
        // Every leg is horizontal or vertical: no diagonal, and no curve.
        expect(before.x === here.x || before.y === here.y).toBe(true);
      }
      const last = edge.points[edge.points.length - 1];
      const target = bench.plates.find((plate) => plate.node.number === edge.to);
      if (last === undefined || target === undefined) throw new Error("a target");
      expect(last.y).toBe(target.y);
    }
  });

  it("breaks the horizontal line where another line crosses it", () => {
    const bench = drawn(wide, BENCH_WIDTH_FLOOR);
    const crossed = bench.edges.filter((edge) => edge.hops.length > 0);
    expect(crossed.length).toBeGreaterThan(0);

    for (const edge of crossed) {
      const lane = edge.points[1];
      const turn = edge.points[2];
      if (lane === undefined || turn === undefined) throw new Error("a polyline");
      const left = Math.min(lane.x, turn.x);
      const right = Math.max(lane.x, turn.x);
      for (const hop of edge.hops) {
        expect(hop).toBeGreaterThan(left);
        expect(hop).toBeLessThan(right);
      }
      expect([...edge.hops].sort((one, other) => one - other)).toEqual(edge.hops);
    }
  });
});

describe("the emptiest maps", () => {
  it("draws a map with nothing on it rather than throwing", () => {
    const bench = drawn(FIXTURES["empty-map"].model);
    expect(bench.plates).toEqual([]);
    expect(bench.bands).toEqual([]);
    expect(bench.edges).toEqual([]);
  });

  it("draws no map at all rather than throwing", () => {
    const bench = drawn({ map: null });
    expect(bench.plates).toEqual([]);
    expect(bench.height).toBeGreaterThan(0);
  });
});
