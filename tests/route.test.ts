import { describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import type { Map, Node } from "../src/snapshot/model.generated";
import { beyondTheMapNote, blockedByLabel } from "../src/views/graph";
import {
  NEXT_HEADING,
  NOW_HEADING,
  blockersOf,
  pingOf,
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

/** The frontier in the one reading that names a number. */
function designating(number: number): Map["frontier"] {
  return { frontier: "designated", number };
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

/**
 * Every row the pane would draw, top to bottom, which is the reading order.
 *
 * The destination is on the end because that is where it is drawn: after every
 * section and before the fog. It is not a section — it heads no count — but it
 * holds rows, and a reader of *every row* that missed them would be reading a
 * shorter map than the one on screen.
 */
function rowsIn(route: Route): RouteRow[] {
  return [...route.sections.flatMap((section) => [...section.rows]), ...route.destination];
}

function sectionIn(route: Route, name: string): RouteRow[] {
  return [...(route.sections.find((section) => section.name === name)?.rows ?? [])];
}

function markOn(route: Route, number: number): string | undefined {
  return rowsIn(route).find((row) => row.node.number === number)?.mark;
}

/**
 * The one state no fixture holds: a spec the map document itself cut.
 *
 * Reachable from real data — `Node::of` hangs `Cut::FromScope` on any child
 * GitHub already calls resolved that the map's own `## Out of scope` names, and
 * it asks nothing about the kind — and it is the single row where the two rules
 * this file adds pull in opposite directions. Built by hand because a recorded
 * answer for it would cost a fixture nothing else needs.
 */
function cutSpec(): Map {
  return mapOf([
    node(1, {
      kind: { kind: "spec" },
      state: "resolved",
      cut: { cut: "fromScope", reason: "#1 - this map is not going there" },
    }),
    node(2),
  ]);
}

describe("the sections are the model's own words and nothing else", () => {
  /**
   * The awkward fixture holds one of everything: a claimed ticket, a designated
   * frontier, one other takeable child, one blocked, one already closed, one
   * nobody classified and two spec children. A grouping invented here rather
   * than read off `kind` and `state` would put at least one of them somewhere
   * the map cannot account for.
   */
  it("groups the fixture by kind and then by state, in document order", () => {
    const route = routeOf(awkward());

    expect(route.sections.map((section) => section.name)).toEqual([
      "now",
      "frontier",
      "blocked",
      "resolved",
      "unclassified",
    ]);
    expect(route.sections.map((section) => section.heading)).toEqual([
      NOW_HEADING,
      "Frontier",
      "Blocked",
      "Resolved",
      "Unclassified",
    ]);
    expect(numbersIn(sectionIn(route, "now"))).toEqual([77]);
    // Two, and not four: the stray issue and the two spec children are takeable
    // by every state predicate there is, and none of the three is work.
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([75, 76]);
    expect(numbersIn(sectionIn(route, "blocked"))).toEqual([72]);
    expect(numbersIn(sectionIn(route, "resolved"))).toEqual([71]);
    expect(numbersIn(sectionIn(route, "unclassified"))).toEqual([70]);
    expect(numbersIn(route.destination)).toEqual([73, 74]);
  });

  it("heads every section with the rows it actually has", () => {
    const route = routeOf(awkward());

    for (const section of route.sections) {
      expect(section.count).toBe(section.rows.length);
    }
    expect(route.sections.map((section) => section.count)).toEqual([1, 2, 1, 1, 1]);
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
    // 75 before 76 inside Frontier and 73 before 74 inside the destination are
    // the operator's own arrangement, which no sort would produce.
    expect(numbersIn(rowsIn(routeOf(map)))).toEqual([77, 75, 76, 72, 71, 70, 73, 74]);
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
    const route = routeOf(mapOf([node(1), node(2), node(3)], { frontier: designating(2) }));

    expect(route.sections[0]?.heading).toBe(NEXT_HEADING);
    expect(numbersIn(sectionIn(route, "now"))).toEqual([2]);
    // Taken out of Frontier rather than drawn in both, and the rest keep their
    // order around the hole.
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([1, 3]);
  });

  it("reads Now and holds every claimed node when something is", () => {
    const route = routeOf(
      mapOf([node(1, { state: "claimed" }), node(2), node(3, { state: "claimed" })], {
        frontier: designating(2),
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
    const route = routeOf(mapOf([node(1, { state: "claimed" })], { frontier: designating(1) }));

    expect(markOn(route, 1)).toBe("claimed");
    // The designation is carried rather than overwritten.
    expect(rowsIn(route)[0]?.designated).toBe(true);
  });

  it("marks the designated node designated ahead of its own state", () => {
    const route = routeOf(mapOf([node(1)], { frontier: designating(1) }));

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

    expect(map.frontier).toEqual({ frontier: "designated", number: 75 });
    expect(numbersIn(marked)).toEqual([75]);
  });

  it("leaves the takeable spec children unmarked, and draws them as the destination", () => {
    const route = routeOf(awkward());
    const specs = route.destination;

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.node.kind.kind).toBe("spec");
      // GitHub's word, carried unchanged: the pane regroups the row, it does
      // not rewrite what the model said about it.
      expect(spec.node.state).toBe("takeable");
      expect(spec.designated).toBe(false);
      expect(spec.mark).toBe("destination");
    }
    // And no section holds one, so nothing counts one.
    expect(
      route.sections.flatMap((section) =>
        section.rows.filter((row) => row.node.kind.kind === "spec"),
      ),
    ).toEqual([]);
  });

  it("marks nothing when the model named nobody", () => {
    const route = routeOf(mapOf([node(1), node(2)]));

    expect(rowsIn(route).some((row) => row.designated)).toBe(false);
  });
});

describe("the tickets this machine cannot start are listed and not offered", () => {
  /**
   * The Windows reading of `platform-bound`: three takeable tickets, every one
   * of them labelled for a machine this is not. The pane's whole job here is to
   * keep them exactly where their state puts them, keep them in the count, and
   * say in a word why none of them is designated — the alternative is a
   * *Frontier* section of three rows with nothing marked, which reads as a bug.
   */
  function bound(): Map {
    const map = FIXTURES["platform-bound-windows"].model.map;
    if (map === null) throw new Error("the platform-bound fixture has no map");
    return map;
  }

  it("leaves every one of them under Frontier and in its count", () => {
    const route = routeOf(bound());
    const frontier = sectionIn(route, "frontier");

    expect(numbersIn(frontier)).toEqual([80, 81, 82]);
    expect(route.sections.find((section) => section.name === "frontier")?.count).toBe(3);
    /*
     * All three, and the section holds nothing else: *a ticket this machine
     * cannot start* and *not a ticket at all* are two different reasons not to
     * be offered, and they are drawn in two different places. The spec, which
     * was never frontier-eligible for a reason that has nothing to do with
     * machines, is at the destination.
     */
    expect(frontier.filter((row) => row.boundElsewhere)).toHaveLength(3);
    expect(numbersIn(route.destination)).toEqual([84]);
  });

  it("designates none of them and draws no Now section at all", () => {
    const route = routeOf(bound());

    expect(rowsIn(route).some((row) => row.designated)).toBe(false);
    // Not an empty group under a heading: *nothing for this machine* is said in
    // the readout, and a heading over nothing would say it as a shrug.
    expect(route.sections.some((section) => section.name === "now")).toBe(false);
  });

  it("carries the verdict onto the row rather than working it out here", () => {
    const rows = rowsIn(routeOf(bound()));
    const boundElsewhere = (number: number) =>
      rows.find((row) => row.node.number === number)?.boundElsewhere;

    // A copy of `node.boundElsewhere`, node by node, including the two the
    // machine has nothing to say about.
    for (const row of rows) {
      expect([row.node.number, row.boundElsewhere]).toEqual([
        row.node.number,
        row.node.boundElsewhere,
      ]);
    }
    expect(boundElsewhere(80)).toBe(true);
    // #83 is for this machine and merely blocked, and #84 is the spec.
    expect(boundElsewhere(83)).toBe(false);
    expect(boundElsewhere(84)).toBe(false);
  });

  it("reads the other machine's answer off the same map with nothing else moved", () => {
    const mac = FIXTURES["platform-bound-macos"].model.map;
    if (mac === null) throw new Error("the platform-bound fixture has no map");

    const here = routeOf(bound());
    const there = routeOf(mac);

    // Every row is drawn on both, and every row is counted on both. What moves
    // is which section the designated one is read under — the pane's own
    // *Now/Next* rule — and nothing else, which is what *still render and still
    // count* looks like from the pane an operator reads.
    const drawn = (route: Route) => numbersIn(rowsIn(route)).sort((a, b) => a - b);
    const counted = (route: Route) =>
      route.sections.reduce((total, section) => total + section.count, 0);

    expect(drawn(there)).toEqual(drawn(here));
    expect(counted(there)).toBe(counted(here));
    expect(numbersIn(rowsIn(there).filter((row) => row.designated))).toEqual([81]);
    // And the state of every row is the same on both machines, because a
    // machine is a fact about the reader.
    const stateOf = (route: Route) =>
      Object.fromEntries(rowsIn(route).map((row) => [row.node.number, row.node.state]));
    expect(stateOf(there)).toEqual(stateOf(here));
  });
});

describe("a ticket the map cut is resolved, and is not counted as progress", () => {
  /**
   * The out-of-scope fixture closes two tickets and the map document cut one of
   * them: #106 was dropped with a reason written under `## Out of scope`, #107
   * was actually done. GitHub calls both of them closed, so a *Resolved*
   * heading that counted the pair would report progress for work nobody did —
   * which is the whole of what this section exists to stop.
   */
  function cutSomething(): Map {
    const map = FIXTURES["out-of-scope"].model.map;
    if (map === null) throw new Error("the out-of-scope fixture has no map");
    return map;
  }

  it("heads Resolved with the decisions made and the cut one with its own", () => {
    const route = routeOf(cutSomething());

    expect(route.sections.map((section) => section.name)).toEqual([
      "now",
      "frontier",
      "resolved",
      "outOfScope",
    ]);
    expect(route.sections.map((section) => section.heading)).toEqual([
      NEXT_HEADING,
      "Frontier",
      "Resolved",
      "Out of scope",
    ]);
    expect(numbersIn(sectionIn(route, "resolved"))).toEqual([107]);
    expect(numbersIn(sectionIn(route, "outOfScope"))).toEqual([106]);
  });

  /**
   * The arithmetic, said as the file says it everywhere else: a count is the
   * rows it heads. *Resolved* reads 1 because one row is under it, and the cut
   * row is not among them — there is no subtraction anywhere for a reader to
   * check against the screen.
   */
  it("counts one under each heading, and each count is the rows it heads", () => {
    const route = routeOf(cutSomething());
    const countIn = (name: string) =>
      route.sections.find((section) => section.name === name)?.count;

    for (const section of route.sections) {
      expect(section.count).toBe(section.rows.length);
    }
    expect(countIn("resolved")).toBe(1);
    expect(countIn("outOfScope")).toBe(1);
  });

  it("keeps the cut row resolved, because this is a decoration and not a mark", () => {
    const cut = sectionIn(routeOf(cutSomething()), "outOfScope")[0];

    expect(cut?.node.state).toBe("resolved");
    expect(cut?.mark).toBe("resolved");
  });

  it("carries the operator's own bullet onto the row, verbatim", () => {
    const route = routeOf(cutSomething());
    const cutOn = (number: number) =>
      rowsIn(route).find((row) => row.node.number === number)?.cut;

    expect(cutOn(106)).toBe(
      "#106 - the launcher never touched the PTY, so there was nothing to strip out and nothing left to keep",
    );
    // The other closed ticket was finished rather than dropped, and an open one
    // is not in that section at all.
    expect(cutOn(107)).toBeNull();
    expect(cutOn(105)).toBeNull();
  });

  it("leaves the open tickets exactly where the frontier put them", () => {
    const route = routeOf(cutSomething());

    // A cut is a fact about a closed ticket, so nothing open moves for it: #105
    // is still the one answer to *what next* and #108 is still behind it.
    expect(numbersIn(sectionIn(route, "now"))).toEqual([105]);
    expect(numbersIn(sectionIn(route, "frontier"))).toEqual([108]);
    expect(rowsIn(route).filter((row) => row.cut !== null)).toHaveLength(1);
  });

  /**
   * A group is a claim that there is something in it, and this one claims the
   * map dropped work. On a map that dropped none, the heading would be that
   * claim made about nothing.
   */
  it("draws no out-of-scope section at all on a map that cut nothing", () => {
    const route = routeOf(mapOf([node(1), node(2, { state: "resolved" })]));

    expect(route.sections.map((section) => section.name)).toEqual([
      "frontier",
      "resolved",
    ]);
    expect(numbersIn(sectionIn(route, "resolved"))).toEqual([2]);
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

describe("a child that is not a ticket is not on the work scale", () => {
  /**
   * The classification is three-way in Rust — a `wayfinder:<type>` in the four
   * is a ticket, `wayfinder:spec` is the destination, anything else at all is
   * unclassified — and the third row is what stops a stray issue dragged onto
   * the map from satisfying every state predicate there is. This is the same
   * rule read on this side: neither of the two non-tickets is grouped as work,
   * whatever GitHub says about its state.
   */
  it("puts every spec child at the destination and in no section at all", () => {
    for (const name of FIXTURE_NAMES) {
      const map = FIXTURES[name].model.map;
      if (map === null) continue;

      const route = routeOf(map);
      const specs = map.nodes
        .filter((one) => one.kind.kind === "spec" && one.cut.cut !== "fromScope")
        .map((one) => one.number);

      expect([name, numbersIn(route.destination)]).toEqual([name, specs]);
      // A section's count is the rows it heads, so a spec inside one is a spec
      // counted as work. There is no subtraction anywhere — the row is
      // somewhere else.
      expect([
        name,
        route.sections.flatMap((section) =>
          numbersIn(section.rows.filter((row) => row.node.kind.kind === "spec")),
        ),
      ]).toEqual([name, []]);
    }
  });

  it("keeps an unclassified child out of every state's section, whatever its state", () => {
    /*
     * One stray issue per state GitHub can put one in. All four are the same
     * fault — a child nobody classified — and the state it happens to carry is
     * exactly the thing that must not decide where it goes.
     */
    const route = routeOf(
      mapOf([
        node(1, { kind: { kind: "unclassified" }, state: "takeable" }),
        node(2, { kind: { kind: "unclassified" }, state: "claimed" }),
        node(3, { kind: { kind: "unclassified" }, state: "blocked" }),
        node(4, { kind: { kind: "unclassified" }, state: "resolved" }),
      ]),
    );

    expect(route.sections.map((section) => section.name)).toEqual(["unclassified"]);
    expect(numbersIn(sectionIn(route, "unclassified"))).toEqual([1, 2, 3, 4]);
    expect(route.sections.find((one) => one.name === "unclassified")?.count).toBe(4);
    expect(route.destination).toEqual([]);
  });

  it("heads the stray issues last, after the rows the map cut", () => {
    const route = routeOf(
      mapOf([
        node(1),
        node(2, { kind: { kind: "unclassified" } }),
        node(3, {
          state: "resolved",
          cut: { cut: "fromScope", reason: "#3 - dropped" },
        }),
      ]),
    );

    // The list is the progression of work, and a child nobody classified is not
    // on it — so it goes after the last group that is.
    expect(route.sections.map((section) => section.name)).toEqual([
      "frontier",
      "outOfScope",
      "unclassified",
    ]);
  });

  it("refuses a spec the designated mark and the Now section, even when the frontier names it", () => {
    /*
     * `map.frontier` cannot name a spec — `is_startable_work` requires a ticket
     * — so this map is impossible from Rust. It is built anyway, because *fails
     * safe* means the pane refuses the offer on its own rather than trusting
     * the one upstream: two things would have to fail together to draw the
     * *start this* ring on the destination.
     */
    const route = routeOf(
      mapOf([node(1, { kind: { kind: "spec" } }), node(2)], { frontier: designating(1) }),
    );

    expect(route.sections.some((section) => section.name === "now")).toBe(false);
    expect(numbersIn(route.destination)).toEqual([1]);
    expect(route.destination[0]?.mark).toBe("destination");
    // The model's word is carried rather than hidden: the pane refuses the
    // shape, it does not pretend the frontier said something else.
    expect(route.destination[0]?.designated).toBe(true);
  });

  it("leaves a cut spec under Out of scope, because the operator's own word outranks a label", () => {
    const route = routeOf(cutSpec());

    expect(numbersIn(sectionIn(route, "outOfScope"))).toEqual([1]);
    expect(route.destination).toEqual([]);
    /*
     * And it wears the mark its bucket is about. `.markCut` is a decoration
     * composed onto a mark that is *true* of the row — #36's rule — so the
     * thing under the strike has to be the resolved disc every other cut row
     * carries. Left as `destination` the pane would draw a waypoint under a
     * heading reading *Out of scope*, and the strike, positioned inside a glyph
     * rotated 45°, would come out diagonal.
     */
    expect(markOn(route, 1)).toBe("resolved");
  });

  it("never lets the bucket and the mark disagree about a row", () => {
    /*
     * Every fixture there is, and then the one state none of them holds. A
     * bucket and a mark are two answers to one question, and the cut spec is
     * where they would come apart: the cut decides the bucket and the kind
     * would have decided the mark, so a rule that asked them in different
     * orders would file the row under *Out of scope* while drawing it as the
     * destination. No recorded answer reaches that row, so the guard has to.
     */
    const maps: readonly (readonly [string, Map | null])[] = [
      ...FIXTURE_NAMES.map((name) => [name, FIXTURES[name].model.map] as const),
      ["a spec the map cut", cutSpec()] as const,
    ];

    for (const [name, map] of maps) {
      if (map === null) continue;

      const route = routeOf(map);
      const stray = sectionIn(route, "unclassified");
      const elsewhere = rowsIn(route).filter(
        (row) => !stray.includes(row) && !route.destination.includes(row),
      );

      expect([name, route.destination.map((row) => row.mark)]).toEqual([
        name,
        route.destination.map(() => "destination"),
      ]);
      expect([name, stray.map((row) => row.mark)]).toEqual([
        name,
        stray.map(() => "unclassified"),
      ]);
      // And nowhere else wears either, which is the half that catches a row
      // drawn as the destination while counted as work.
      expect([
        name,
        elsewhere.filter(
          (row) => row.mark === "destination" || row.mark === "unclassified",
        ),
      ]).toEqual([name, []]);
    }
  });

  it("counts every node exactly once, on every fixture there is", () => {
    /*
     * The single strongest guard on this file, and the one that fails if a
     * resolved row is ever hidden, a spec is counted twice, or any row is
     * dropped on the way to a group: every number the map holds is drawn
     * exactly once, and the counts the headings print plus the uncounted
     * destination account for all of them.
     */
    for (const name of FIXTURE_NAMES) {
      const map = FIXTURES[name].model.map;
      if (map === null) continue;

      const route = routeOf(map);
      const drawn = numbersIn(rowsIn(route));
      const counted = route.sections.reduce((total, one) => total + one.count, 0);

      expect([name, [...drawn].sort((a, b) => a - b)]).toEqual([
        name,
        map.nodes.map((one) => one.number).sort((a, b) => a - b),
      ]);
      expect([name, drawn.length]).toEqual([name, new Set(drawn).size]);
      expect([name, counted + route.destination.length]).toEqual([
        name,
        map.nodes.length,
      ]);
    }
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

describe("the fog is a region beside the sections and never one of them", () => {
  it("carries the model's own reading through without asking again", () => {
    const charted = {
      fog: "surveyed",
      region: { count: 2, text: "- one\n- two" },
    } as const;

    expect(routeOf(mapOf([], { fog: charted })).fog).toEqual(charted);
    expect(routeOf(mapOf([])).fog).toEqual({ fog: "unsurveyed" });
  });

  it("keeps a survey that found nothing apart from a map nobody surveyed", () => {
    /*
     * The distinction this whole ticket exists for, at the layer it is decided
     * — and it is a shape here rather than a number, so no reader can flatten
     * the two into one by reaching for a count.
     */
    const surveyed = routeOf(
      mapOf([], { fog: { fog: "surveyed", region: { count: 0, text: "" } } }),
    ).fog;
    const unsurveyed = routeOf(mapOf([])).fog;

    expect(surveyed).not.toEqual(unsurveyed);
    expect(unsurveyed.fog).toBe("unsurveyed");
  });

  it("is never a section, so nothing counts it with the rows", () => {
    /*
     * A `RouteSection` count is always the rows it heads. The fog has no rows,
     * so a fog that arrived as a section would be a count nothing could check.
     */
    const route = routeOf(
      mapOf([node(70)], { fog: { fog: "surveyed", region: { count: 9, text: "- x" } } }),
    );

    expect(route.sections.map((section) => section.name)).not.toContain("fog");
    for (const section of route.sections) expect(section.count).toBe(section.rows.length);
  });

  it("survives a map the arithmetic gives no section at all", () => {
    /*
     * Every section is dropped when it is empty; this is the one region where
     * the emptiness is the claim, so it is still in the answer for a map with
     * nothing on it.
     */
    const route = routeOf(mapOf([]));

    expect(route.sections).toEqual([]);
    expect(route.fog).toEqual({ fog: "unsurveyed" });
  });
});

describe("the halo is the screen's, and not one per claimed row", () => {
  /*
   * #56 rations motion by the screen: at most one animated element however many
   * runs are live, and a view that drew a ping per claim would blow that on a
   * map staking two. So the pane asks *which row moves* once, and the answer is
   * a number rather than a predicate over rows.
   */
  it("names one row however many rows are claimed", () => {
    const route = routeOf(
      mapOf([
        node(1, { state: "claimed" }),
        node(2, { state: "claimed" }),
        node(3, { state: "claimed" }),
      ]),
    );
    const claimed = route.sections
      .flatMap((section) => section.rows)
      .filter((row) => row.mark === "claimed");

    // The mark is still on all three — what is rationed is the movement.
    expect(claimed).toHaveLength(3);
    expect(pingOf(route)).toBe(1);
  });

  it("names nothing when nothing on the map is in progress", () => {
    const route = routeOf(mapOf([node(1), node(2, { state: "resolved" })]));

    expect(pingOf(route)).toBeNull();
  });

  it("never lands on a row the pane does not mark claimed", () => {
    /* `markOf` answers `destination` above the state, so a spec child holding a
       session is not marked `claimed` and draws no halo — reading `node.state`
       instead of the mark is how the shell came to suppress the rack's lamp
       against a ping that was never on the screen. */
    const route = routeOf(
      mapOf([node(1), node(9, { kind: { kind: "spec" }, state: "claimed" })]),
    );

    expect(pingOf(route)).toBeNull();
  });
});
