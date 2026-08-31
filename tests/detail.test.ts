import { describe, expect, it } from "vitest";
import {
  MAP_EMPTY,
  NOTHING_SELECTED,
  blockedOf,
  blockersOf,
  cardOf,
  panelOf,
  typeOf,
  selectionGone,
} from "../src/detail/detail";
import { fixtureNamed, type FixtureName } from "../src/snapshot/fixtures";
import type { Map, Model, Node } from "../src/snapshot/model.generated";

/**
 * The panel's arithmetic.
 *
 * `tests/detail-panel.test.tsx` pins the picture; this pins the joins under it.
 * The claim being tested is that the panel derives nothing — every value it
 * prints is a field of the model carried over, or a lookup of one number
 * against the rows of the same map — and that a number with no row is named as
 * such rather than dropped or counted into a total.
 */

function mapOf(name: FixtureName): Map {
  const map = fixtureNamed(name).model.map;
  if (map === null) throw new Error(`${name} has no map`);
  return map;
}

function modelOf(name: FixtureName): Model {
  return fixtureNamed(name).model;
}

function nodeOn(map: Map, number: number): Node {
  const node = map.nodes.find((row) => row.number === number);
  if (node === undefined) throw new Error(`#${number} is not on this map`);
  return node;
}

describe("the panel resolves a selection to something to say", () => {
  it("says no map open when there is none, and never calls it empty", () => {
    expect(panelOf(modelOf("no-map-open"), null)).toEqual({ kind: "noMap" });
    // A selection left over from the last map does not make one exist.
    expect(panelOf(modelOf("no-map-open"), 75)).toEqual({ kind: "noMap" });
  });

  it("tells a map with no children from a map with nothing picked", () => {
    const empty = panelOf(modelOf("empty-map"), null);
    const unpicked = panelOf(modelOf("awkward-map"), null);

    expect([empty.kind, unpicked.kind]).toEqual(["mapEmpty", "unselected"]);
    // Two states, two sentences: the words are what the operator reads, so a
    // shared phrasing would collapse the distinction the branch exists for.
    expect(MAP_EMPTY).not.toBe(NOTHING_SELECTED);
  });

  it("names a selection that outlived its row rather than blanking", () => {
    const panel = panelOf(modelOf("awkward-map"), 4242);

    expect(panel).toEqual({
      kind: "gone",
      number: 4242,
      map: { number: 60, closed: false },
    });
    expect(selectionGone(4242)).toContain("4242");
  });

  it("carries the map's closed bit onto every branch that has a map", () => {
    const closed = panelOf(modelOf("map-closed"), null);

    expect(closed.kind === "unselected" ? closed.map.closed : null).toBe(true);
  });
});

describe("what the card carries is what the node carries", () => {
  const map = mapOf("awkward-map");

  it("reads the state off the node and never off its edges", () => {
    // #71 is closed with an open blocker: the precedence in `derive.rs` says
    // resolved, and a panel that re-read the edges would say blocked.
    const resolved = cardOf(map, nodeOn(map, 71));

    expect(resolved.state).toBe("resolved");
    expect(resolved.blockers.named.map((edge) => edge.number)).toEqual([72]);
    expect(resolved.blockers.named[0]?.state).toBe("blocked");
  });

  it("takes the designation off the map's one resolver", () => {
    expect(cardOf(map, nodeOn(map, 75)).designated).toBe(true);
    expect(cardOf(map, nodeOn(map, 76)).designated).toBe(false);
  });

  it("names each kind, and the unclassified one loudest", () => {
    expect(typeOf(nodeOn(map, 77).kind)).toBe("ticket, grilling");
    expect(typeOf(nodeOn(map, 72).kind)).toBe("ticket, research");
    expect(typeOf(nodeOn(map, 73).kind)).toBe("spec");
    expect(typeOf(nodeOn(map, 70).kind)).toBe("unclassified");
  });

  it("holds a claim without holding a claimant", () => {
    const claimed = cardOf(map, nodeOn(map, 77));

    expect(claimed.claimed).toBe(true);
    expect(cardOf(map, nodeOn(map, 76)).claimed).toBe(false);
    // The card has no field for *who*, and that is the assertion: assignees
    // cross as a count, so a name here would have to be invented.
    expect(Object.keys(claimed)).not.toContain("claimant");
  });

  it("carries a cut's reason as text rather than as a flag", () => {
    const cut = mapOf("out-of-scope");
    const dropped = cardOf(cut, nodeOn(cut, 106));

    expect(dropped.state).toBe("resolved");
    expect(dropped.resolution.kind).toBe("fromScope");
    expect(
      dropped.resolution.kind === "fromScope" ? dropped.resolution.reason : "",
    ).toContain("the launcher never touched the PTY");
    expect(cardOf(cut, nodeOn(cut, 107)).resolution).toEqual({ kind: "inScope" });
  });
});

describe("the edges are joined, in both directions", () => {
  const map = mapOf("awkward-map");

  it("names what a node waits on, in the map's own order", () => {
    expect(blockersOf(map, nodeOn(map, 72)).named.map((edge) => edge.number)).toEqual([
      75, 76,
    ]);
  });

  it("names what waits on a node", () => {
    expect(blockedOf(map, nodeOn(map, 75)).named.map((edge) => edge.number)).toEqual([72]);
    expect(blockedOf(map, nodeOn(map, 77)).named).toEqual([]);
  });

  it("counts a blocker with no row here rather than dropping it", () => {
    const beyond: Map = {
      ...map,
      nodes: map.nodes.map((node) =>
        node.number === 76 ? { ...node, waitsOn: [999, 71, 1000] } : node,
      ),
    };
    const edges = blockersOf(beyond, nodeOn(beyond, 76));

    expect(edges.named.map((edge) => edge.number)).toEqual([71]);
    expect(edges.beyondTheMap).toBe(2);
  });

  it("cannot see a node elsewhere waiting on this one, and says so with a zero it means", () => {
    // The reverse direction is structurally complete over the rows it has, so
    // its `beyondTheMap` is always zero — the panel prints a sentence for that
    // rather than the number.
    expect(blockedOf(map, nodeOn(map, 71)).beyondTheMap).toBe(0);
  });
});
