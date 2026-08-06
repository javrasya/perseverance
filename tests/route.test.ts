import { describe, expect, it } from "vitest";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import {
  MARGIN,
  NODE_HEIGHT,
  NODE_WIDTH,
  RANK_GAP,
  ROW_GAP,
  TITLE_BUDGET,
  edgesOf,
  elide,
  rankNodes,
  routeOf,
  unlocksFrom,
  type RouteEdge,
} from "../src/views/route/route";
import { collect } from "./support/sources";

/**
 * Nothing here touches the DOM, so there is no jsdom pragma: this is the
 * arithmetic the Route is a picture of, and it is testable without one.
 */

function node(number: number, over: Partial<Node> = {}): Node {
  return {
    number,
    title: `Ticket ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    kind: { kind: "ticket", type: "task" },
    state: "takeable",
    waitsOn: [],
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
    frontier: null,
    ...over,
  };
}

function edge(before: number, after: number): RouteEdge {
  return { before, after };
}

/**
 * The same map, waiting on exactly these edges.
 *
 * The layout takes one argument — the model — so an edge set under test has to
 * be hung on the nodes that wait, which is where a real one arrives from Rust.
 * This is the transposition `edgesOf` undoes, and asking for one edge set and
 * getting the same one back out is a claim the suite makes below.
 */
function waitingOn(map: Map, edges: readonly RouteEdge[]): Map {
  return {
    ...map,
    nodes: map.nodes.map((one) => ({
      ...one,
      waitsOn: edges.filter((each) => each.after === one.number).map((each) => each.before),
    })),
  };
}

function awkward(): Map {
  const map = FIXTURES["awkward-map"].model.map;
  if (map === null) throw new Error("the awkward fixture has no map");
  return map;
}

function numbersIn(nodes: readonly { node: Node }[]): number[] {
  return nodes.map((one) => one.node.number);
}

describe("rank is longest path over an explicit edge set", () => {
  /**
   * The shape a charting session actually produces: a burst of independent
   * tickets against a few that chain. If the ranker took the shortest way in
   * instead of the longest, a ticket four deep would sit in the second column
   * and read as startable next, which is the one thing the Route exists to
   * answer correctly.
   */
  const sources = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const chained = [101, 102, 103, 104, 201, 202, 301, 401];
  const normal = mapOf([...sources, ...chained].map((number) => node(number)));
  const normalEdges: RouteEdge[] = [
    edge(1, 101),
    edge(2, 101),
    edge(3, 102),
    edge(4, 103),
    edge(5, 104),
    // The short way into the deepest node. Longest path must ignore it.
    edge(6, 301),
    edge(101, 201),
    edge(102, 201),
    edge(103, 202),
    edge(104, 202),
    edge(201, 301),
    edge(202, 301),
    edge(301, 401),
  ];

  it("puts eleven sources against ranks of four, two, one and one", () => {
    const route = routeOf(waitingOn(normal, normalEdges));

    expect(route.rows.map((row) => row.nodes.length)).toEqual([11, 4, 2, 1, 1]);
    expect(route.rows.map((row) => row.rank)).toEqual([0, 1, 2, 3, 4]);
    expect(numbersIn(route.rows[0]?.nodes ?? [])).toEqual(sources);
  });

  it("takes the longest way in and not the shortest", () => {
    const ranking = rankNodes(normal.nodes, normalEdges);

    // #301 is reachable from a source in one step and from #201 in three.
    expect(ranking.ranks.get(301)).toBe(3);
    expect(ranking.ranks.get(401)).toBe(4);
    expect(ranking.unsettled).toEqual([]);
    expect(ranking.beyondTheMap).toBe(0);
  });

  it("counts what each node opens up over distinct successors", () => {
    const unlocks = unlocksFrom(normal.nodes, [...normalEdges, edge(1, 101)]);

    // The duplicated edge is one thing being unlocked, not two.
    expect(unlocks.get(1)).toBe(1);
    expect(unlocks.get(101)).toBe(1);
    expect(unlocks.get(11)).toBe(0);
  });
});

describe("intra-rank order is map order and nothing else", () => {
  /**
   * The order is the operator's, dragged in GitHub's own UI. A comparator here
   * — even a crossing-minimising one — reorders rows they deliberately
   * arranged, and the awkward fixture's non-monotonic order is what catches it.
   */
  const MAP_ORDER = [70, 71, 73, 74, 72, 77, 75, 76];

  it("keeps the fixture's order inside every rank the fixture's edges produce", () => {
    const map = awkward();
    const route = routeOf(map);

    expect(map.nodes.map((one) => one.number)).toEqual(MAP_ORDER);
    // Three columns, from the map's own edges. Each row is a subsequence of
    // map order, which no comparator and no crossing-minimiser would leave.
    expect(route.rows.map((row) => numbersIn(row.nodes))).toEqual([
      [70, 73, 74, 77, 75, 76],
      [72],
      [71],
    ]);
  });

  it("keeps it inside a rank whatever the edges are", () => {
    const map = awkward();
    // #74 sits before #72 in map order and after it in number order, so a row
    // of the two says which of the two orders won.
    const route = routeOf(waitingOn(map, [edge(70, 74), edge(70, 72)]));

    expect(numbersIn(route.rows[0]?.nodes ?? [])).toEqual([70, 71, 73, 77, 75, 76]);
    expect(numbersIn(route.rows[1]?.nodes ?? [])).toEqual([74, 72]);
  });

  it("never sorts and never reaches for a store", () => {
    const source = collect([".ts"]).find(
      (file) => file.path === "src/views/route/route.ts",
    );

    expect(source).toBeDefined();
    expect(source?.text).not.toContain(".sort(");
    expect(source?.text).not.toContain("localStorage");
  });
});

describe("a graph that cannot be ranked says so rather than being ranked wrong", () => {
  /**
   * Two ways the arithmetic can be quietly wrong: a cycle has no longest path,
   * and an edge naming something with no row moves a rank with nothing on
   * screen to account for the move. Both are reported; neither hangs.
   */
  it("terminates on a cycle and names both ends of the edge that closed it", () => {
    const ranking = rankNodes(
      [node(1), node(2), node(3)],
      [edge(1, 2), edge(2, 3), edge(3, 1)],
    );

    // Every node still has a number, so the view has something to draw.
    expect([...ranking.ranks.keys()]).toHaveLength(3);
    // #2 waits on #1, which is still on the stack when the descent reaches it.
    expect(ranking.unsettled).toEqual([1, 2]);
  });

  it("drops an edge whose end is not a child of this map and counts it", () => {
    const ranking = rankNodes([node(1), node(2)], [edge(1, 2), edge(2, 99), edge(99, 1)]);

    expect(ranking.beyondTheMap).toBe(2);
    expect(ranking.ranks.get(1)).toBe(0);
    expect(ranking.ranks.get(2)).toBe(1);
  });
});

describe("the edge set is the model's own, transposed and not inferred", () => {
  /**
   * Rust decides what waits on what and hands the numbers over on the node
   * that waits. The failure this catches is a view that ranks from something
   * else — a heuristic, an ordering, a guess — which is a column the map
   * cannot justify.
   */
  it("reads one edge per number the model hung on the node that waits", () => {
    const map = awkward();

    expect(edgesOf(map)).toEqual([
      // In map order, and inside a node in the order the answer listed them.
      edge(72, 71),
      edge(75, 72),
      edge(76, 72),
      edge(71, 75),
    ]);
  });

  it("gives back exactly the edges it was given", () => {
    const edges = [edge(70, 74), edge(70, 72), edge(74, 77)];

    expect(edgesOf(waitingOn(awkward(), edges))).toEqual(edges);
  });

  it("counts what each node opens up, and a source that opens nothing is a zero", () => {
    const route = routeOf(waitingOn(awkward(), [edge(70, 74), edge(70, 72)]));
    const drawn = route.rows.flatMap((row) => row.nodes);
    const unlocks = (number: number) =>
      drawn.find((one) => one.node.number === number)?.unlocks;

    expect(unlocks(70)).toBe(2);
    // A number rather than an absence: nothing waits on #71, and that is a
    // fact the model answered rather than a question nobody asked.
    expect(unlocks(71)).toBe(0);
  });

  it("counts the fixture's own fan-out from the fixture's own edges", () => {
    const drawn = routeOf(awkward()).rows.flatMap((row) => row.nodes);
    const opened = new globalThis.Map(
      drawn.map((one) => [one.node.number, one.unlocks] as const),
    );

    // #75 and #76 each hold up #72, and #72 holds up #71. Every one of these
    // is a number that reaches the screen as `unlocks N`.
    expect(opened.get(75)).toBe(1);
    expect(opened.get(76)).toBe(1);
    expect(opened.get(72)).toBe(1);
    expect(opened.get(70)).toBe(0);
  });
});

describe("the frontier is Rust's answer, carried and never re-resolved", () => {
  /**
   * The spec children of the awkward fixture are takeable by every state
   * predicate there is, and are still not the frontier. A view that marked the
   * first takeable node would mark three nodes here and answer *what next*
   * three times.
   */
  it("marks exactly the node whose number the model named", () => {
    const map = awkward();
    const route = routeOf(map);
    const marked = route.rows.flatMap((row) => row.nodes).filter((one) => one.frontier);

    expect(map.frontier).toBe(75);
    expect(marked.map((one) => one.node.number)).toEqual([75]);
  });

  it("leaves the takeable spec children unmarked", () => {
    const map = awkward();
    const route = routeOf(map);
    const specs = route.rows
      .flatMap((row) => row.nodes)
      .filter((one) => one.node.kind.kind === "spec");

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.node.state).toBe("takeable");
      expect(spec.frontier).toBe(false);
    }
  });

  it("marks nothing when the model named nobody", () => {
    const route = routeOf(mapOf([node(1), node(2)]));

    expect(route.rows.flatMap((row) => row.nodes).some((one) => one.frontier)).toBe(false);
  });
});

describe("the layout is computed on every call and stored nowhere", () => {
  /**
   * Determinism is what buys the right not to store positions. If two calls on
   * the same model could differ, a position would have to be remembered
   * somewhere for the graph to hold still — and a remembered position is one
   * that can disagree with the graph.
   */
  it("answers with the same numbers twice", () => {
    const rearranged = waitingOn(awkward(), [edge(70, 74), edge(70, 72)]);

    expect(routeOf(rearranged)).toEqual(routeOf(rearranged));
    expect(routeOf(awkward())).toEqual(routeOf(awkward()));
  });

  it("places every node from the constants and nothing else", () => {
    const map = awkward();
    const route = routeOf(waitingOn(map, [edge(70, 74), edge(70, 72)]));
    const second = route.rows[1]?.nodes;

    expect(second?.[0]?.x).toBe(MARGIN + (NODE_WIDTH + RANK_GAP));
    expect(second?.[0]?.y).toBe(MARGIN);
    expect(second?.[1]?.y).toBe(MARGIN + (NODE_HEIGHT + ROW_GAP));
    // The canvas is the furthest extent plus the margin it started with.
    expect(route.width).toBe(MARGIN + 2 * NODE_WIDTH + RANK_GAP + MARGIN);
  });

  it("is a margin and nothing in it for a map with nothing on it", () => {
    const route = routeOf(mapOf([]));

    expect(route.rows).toEqual([]);
    expect(route.width).toBe(2 * MARGIN);
    expect(route.height).toBe(2 * MARGIN);
  });

  it("computes a link for every on-map edge and leaves the drawing to the view", () => {
    // #74 waits on one thing that has a row and one that does not. The second
    // is a real dependency of a real ticket and still has nothing to join.
    const route = routeOf(waitingOn(awkward(), [edge(70, 74), edge(999, 74)]));

    expect(route.links.map((link) => link.after)).toEqual([74]);
    expect(route.links[0]?.path).toMatch(/^M [\d.]+ [\d.]+ C /);
    expect(route.beyondTheMap).toBe(1);
  });

  it("cuts a title to the budget, because SVG text does not wrap", () => {
    const short = "Held up, and holding this up";
    const long = "Someone dragged a bug report onto the map";

    expect(elide(short)).toBe(short);
    expect(elide(long)).toHaveLength(TITLE_BUDGET);
    expect(elide(long).endsWith("…")).toBe(true);
  });
});
