import { describe, expect, it } from "vitest";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import {
  NEXT_HEADING,
  NOW_HEADING,
  beyondTheMapNote,
  blockedByLabel,
  blockersOf,
  routeOf,
  type Route,
  type RouteRow,
} from "../src/views/route/route";
import { collect } from "./support/sources";

/**
 * Nothing here touches the DOM, so there is no jsdom pragma: this is the
 * arithmetic the Route is a list of, and it is testable without one.
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

/**
 * A dependency, for building fixtures with: `before` must be resolved first and
 * `after` is the one waiting.
 *
 * Declared here rather than imported, because nothing in the view has this
 * shape. Adjacency reaches the pane hanging off the node that waits and is
 * never transposed into pairs — a production type existing only for a test to
 * import is the ranker's adjacency half, parked. ADR 0006.
 */
type Waiting = { readonly before: number; readonly after: number };

function edge(before: number, after: number): Waiting {
  return { before, after };
}

/**
 * The same map, waiting on exactly these edges.
 *
 * The layout takes one argument — the model — so an edge set under test has to
 * be hung on the nodes that wait, which is where a real one arrives from Rust.
 */
function waitingOn(map: Map, edges: readonly Waiting[]): Map {
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

/** Every row the pane would draw, top to bottom, which is the reading order. */
function rowsIn(route: Route): RouteRow[] {
  return route.sections.flatMap((section) => [...section.rows]);
}

function sectionIn(route: Route, name: string): RouteRow[] {
  return [...(route.sections.find((section) => section.name === name)?.rows ?? [])];
}

function markOn(route: Route, number: number): string | undefined {
  return rowsIn(route).find((row) => row.node.number === number)?.mark;
}

describe("the sections are the model's own words and nothing else", () => {
  /**
   * The awkward fixture holds one of everything: a claimed ticket, a designated
   * frontier, three other takeable children, one blocked and one already
   * closed. A grouping invented here rather than read off `state` would put at
   * least one of them somewhere the map cannot account for.
   */
  it("groups the fixture by state, in document order", () => {
    const route = routeOf(awkward());

    expect(route.sections.map((section) => section.name)).toEqual([
      "now",
      "frontier",
      "blocked",
      "resolved",
    ]);
    expect(route.sections.map((section) => section.heading)).toEqual([
      NOW_HEADING,
      "Frontier",
      "Blocked",
      "Resolved",
    ]);
    expect(numbersIn(sectionIn(route, "now"))).toEqual([77]);
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([70, 73, 74, 75, 76]);
    expect(numbersIn(sectionIn(route, "blocked"))).toEqual([72]);
    expect(numbersIn(sectionIn(route, "resolved"))).toEqual([71]);
  });

  it("heads every section with the rows it actually has", () => {
    const route = routeOf(awkward());

    for (const section of route.sections) {
      expect(section.count).toBe(section.rows.length);
    }
    expect(route.sections.map((section) => section.count)).toEqual([1, 5, 1, 1]);
  });

  /**
   * A group is a claim that there is something in it. An empty one drawn under
   * its heading says *nothing is blocked here* in the same ink as *these three
   * are* — the rule `MapList` already keeps for the same reason.
   */
  it("leaves out a section with nothing in it", () => {
    const route = routeOf(mapOf([node(1), node(2)]));

    expect(route.sections.map((section) => section.name)).toEqual(["frontier"]);
  });

  it("gives back no sections at all for a map with nothing on it", () => {
    expect(routeOf(mapOf([])).sections).toEqual([]);
  });
});

describe("intra-section order is map order and nothing else", () => {
  /**
   * The order is the operator's, dragged in GitHub's own UI. A comparator here
   * reorders rows they deliberately arranged, and a fixture whose numbers
   * descend is what catches one: a sort of any kind would leave the section
   * ascending, and nothing else would.
   */
  const MAP_ORDER = [70, 71, 73, 74, 72, 77, 75, 76];

  it("keeps the fixture's order across every section it fills", () => {
    const map = awkward();

    expect(map.nodes.map((one) => one.number)).toEqual(MAP_ORDER);
    expect(numbersIn(rowsIn(routeOf(map)))).toEqual([77, 70, 73, 74, 75, 76, 72, 71]);
  });

  it("keeps descending numbers descending inside a section", () => {
    const route = routeOf(
      mapOf([
        node(9),
        node(8, { state: "blocked" }),
        node(7),
        node(6, { state: "blocked" }),
        node(5),
      ]),
    );

    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([9, 7, 5]);
    expect(numbersIn(sectionIn(route, "blocked"))).toEqual([8, 6]);
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

describe("the top section is one section with two headings", () => {
  /**
   * *What do I work on next* has one answer at a time. With a session against a
   * ticket the answer is that ticket and the heading says so; with none it is
   * the one number the model designated. Both are read off the model — a
   * heading chosen from anything else would be the view answering the question
   * itself.
   */
  it("reads Next and holds only the designated node when nothing is claimed", () => {
    const route = routeOf(mapOf([node(1), node(2), node(3)], { frontier: 2 }));

    expect(route.sections[0]?.heading).toBe(NEXT_HEADING);
    expect(numbersIn(sectionIn(route, "now"))).toEqual([2]);
    // Taken out of Frontier rather than drawn in both, and the rest keep their
    // order around the hole.
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([1, 3]);
  });

  it("reads Now and holds every claimed node when something is", () => {
    const route = routeOf(
      mapOf([node(1, { state: "claimed" }), node(2), node(3, { state: "claimed" })], {
        frontier: 2,
      }),
    );

    expect(route.sections[0]?.heading).toBe(NOW_HEADING);
    expect(numbersIn(sectionIn(route, "now"))).toEqual([1, 3]);
    // The designation is still the model's answer and still on its own row.
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([2]);
  });

  it("is absent when nothing is claimed and nothing is designated", () => {
    const route = routeOf(mapOf([node(1), node(2)]));

    expect(route.sections.some((section) => section.name === "now")).toBe(false);
  });
});

describe("a mark has one precedence: claimed, then designated, then state", () => {
  /**
   * One test per rung, because the rungs are the whole rule. A designated node
   * that somebody has already started is being worked, and marking it as the
   * next thing to pick up would send two operators at one ticket.
   */
  it("marks a claimed node claimed even when the model designated it", () => {
    const route = routeOf(mapOf([node(1, { state: "claimed" })], { frontier: 1 }));

    expect(markOn(route, 1)).toBe("claimed");
    // The designation is carried rather than overwritten.
    expect(rowsIn(route)[0]?.designated).toBe(true);
  });

  it("marks the designated node designated ahead of its own state", () => {
    const route = routeOf(mapOf([node(1)], { frontier: 1 }));

    expect(markOn(route, 1)).toBe("designated");
  });

  it("falls back to the state, and the state is the model's word for it", () => {
    const route = routeOf(
      mapOf([node(1), node(2, { state: "blocked" }), node(3, { state: "resolved" })]),
    );

    expect(markOn(route, 1)).toBe("takeable");
    expect(markOn(route, 2)).toBe("blocked");
    expect(markOn(route, 3)).toBe("resolved");
  });
});

describe("blockers are counted against the states this map is showing", () => {
  /**
   * The derived model carries no per-node blocker count, so these numbers are
   * the only source for what a blocked row says about what holds it up. The
   * failure they prevent is a count that no row on screen can account for.
   */
  it("counts what #72 waits on that this map still shows in the way", () => {
    expect(blockersOf(awkward().nodes).get(72)).toEqual({
      unresolved: 2,
      beyondTheMap: 0,
    });
    expect(blockedByLabel(2)).toBe("blocked by 2");
  });

  it("does not count a blocker this map shows as resolved", () => {
    // #75 waits on #71, which this map has already closed. Out of the way is a
    // fact, and `blocked by 1` on a takeable row would contradict it.
    expect(blockersOf(awkward().nodes).get(75)).toEqual({
      unresolved: 0,
      beyondTheMap: 0,
    });
  });

  it("empties the tally of a node this map shows as resolved", () => {
    /*
     * #71 is closed and still names #72, which is blocked. GitHub does not
     * clear what a closed issue was blocked by, so the number is real and the
     * reading is not — and `blocked by 1` on a row under the heading *Resolved*
     * is a contradiction between a row and the heading over it.
     */
    const finished = awkward().nodes.find((one) => one.number === 71);

    expect(finished?.state).toBe("resolved");
    expect(finished?.waitsOn).toEqual([72]);
    expect(blockersOf(awkward().nodes).get(71)).toEqual({
      unresolved: 0,
      beyondTheMap: 0,
    });
  });

  it("empties it whether what it named has a row here or not", () => {
    // Both halves, because a finished ticket that named an issue elsewhere
    // would otherwise still carry the *no row on this map* note.
    const map = waitingOn(
      mapOf([node(1, { state: "resolved" }), node(2, { state: "blocked" })]),
      [edge(2, 1), edge(99, 1)],
    );

    expect(blockersOf(map.nodes).get(1)).toEqual({ unresolved: 0, beyondTheMap: 0 });
  });

  it("counts a blocker with no row here apart, as one it cannot judge", () => {
    const map = waitingOn(mapOf([node(1), node(2, { state: "blocked" })]), [
      edge(1, 2),
      edge(99, 2),
    ]);

    expect(blockersOf(map.nodes).get(2)).toEqual({ unresolved: 1, beyondTheMap: 1 });
  });

  it("says what it cannot judge in words rather than in the count", () => {
    expect(beyondTheMapNote(1)).toContain("not a child of this map");
    expect(beyondTheMapNote(2)).toContain("not a child of this map");
  });

  it("hands every row its own tally", () => {
    const route = routeOf(awkward());
    const blocked = sectionIn(route, "blocked")[0];

    expect(blocked?.node.number).toBe(72);
    expect(blocked?.blockers.unresolved).toBe(2);
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
    const marked = rowsIn(routeOf(map)).filter((row) => row.designated);

    expect(map.frontier).toBe(75);
    expect(numbersIn(marked)).toEqual([75]);
  });

  it("leaves the takeable spec children unmarked", () => {
    const specs = rowsIn(routeOf(awkward())).filter((row) => row.node.kind.kind === "spec");

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.node.state).toBe("takeable");
      expect(spec.designated).toBe(false);
    }
  });

  it("marks nothing when the model named nobody", () => {
    const route = routeOf(mapOf([node(1), node(2)]));

    expect(rowsIn(route).some((row) => row.designated)).toBe(false);
  });
});

describe("attendance is the wayfinder's rule, applied where the model is silent", () => {
  /**
   * Research runs AFK and everything else is human-in-the-loop. A spec and an
   * unclassified child get nothing at all rather than a default, because both
   * defaults are wrong in a way an operator cannot see.
   */
  it("reads AFK off research and HITL off every other ticket", () => {
    const route = routeOf(awkward());
    const attendance = (number: number) =>
      rowsIn(route).find((row) => row.node.number === number)?.attendance;

    expect(attendance(72)).toBe("AFK");
    expect(attendance(77)).toBe("HITL");
    expect(attendance(75)).toBe("HITL");
  });

  it("says nothing at all for a spec or an unclassified child", () => {
    const route = routeOf(awkward());
    const attendance = (number: number) =>
      rowsIn(route).find((row) => row.node.number === number)?.attendance;

    expect(attendance(73)).toBeNull();
    expect(attendance(70)).toBeNull();
  });
});

describe("the sections are computed on every call and stored nowhere", () => {
  /**
   * Determinism is what buys the right to store nothing. If two calls on the
   * same model could differ, the pane would have to remember something for the
   * list to hold still — and a remembered grouping is one that can disagree
   * with the map.
   */
  it("answers with the same numbers twice", () => {
    const rearranged = waitingOn(awkward(), [edge(70, 74), edge(70, 72)]);

    expect(routeOf(rearranged)).toEqual(routeOf(rearranged));
    expect(routeOf(awkward())).toEqual(routeOf(awkward()));
  });
});
