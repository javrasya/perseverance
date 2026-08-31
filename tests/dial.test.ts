// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  COLUMN_FLOORS,
  DEFAULT_DETENT,
  DETENTS,
  NAME_FLOOR,
  VIEW_FLOORS,
  clamp,
  columnsAt,
  detentAt,
  fractionOf,
  fittingViews,
  honours,
  namesFit,
  nextDetent,
  sides,
  snap,
  standDown,
  surfaces,
} from "../src/panes/dial";
import { collapsed, gesture, habitable } from "../src/panes/geometry";
import { readPosition, writePosition } from "../src/panes/position";
import { replaceSnapshot } from "../src/stores/snapshots";
import { OPENING, moveDial, readUi, startGesture } from "../src/stores/ui";
import { FIXTURES } from "../src/snapshot/fixtures";
import { VIEWS, type ViewName } from "../src/views/views";

/**
 * The dial, as arithmetic.
 *
 * Everything here is numbers in and numbers out, which is the point of the
 * module: what fits, what is shed and what has to stand down are decided once,
 * away from any DOM, so the shell has nothing left to get wrong except drawing
 * them. `tests/dial-shell.test.tsx` is the picture; this is the answer.
 *
 * The multi-view cases run on **synthetic floors**. There is one real view
 * today, and inventing a second component to test the switcher's arithmetic
 * would be building #62 early — so the second view here is a name and a number,
 * which is all the arithmetic ever knew about a view anyway.
 */

const PLATE = "plate" as ViewName;
const WINDOW = 1024;

describe("four detents, and free positions between them", () => {
  it("names four, terminal-most first, spanning the whole window", () => {
    expect(DETENTS).toEqual(["terminal", "glance", "split", "map"]);
    expect(fractionOf("terminal")).toBe(0);
    expect(fractionOf("map")).toBe(1);
    expect(DETENTS.map(fractionOf)).toEqual([...DETENTS.map(fractionOf)].sort((a, b) => a - b));
  });

  it("snaps a near miss onto the detent it was aiming at", () => {
    expect(snap(fractionOf("split") + 0.02)).toBe(fractionOf("split"));
    expect(detentAt(fractionOf("split") + 0.02)).toBe("split");
  });

  it("leaves a position that is nowhere near a detent exactly where it is", () => {
    // The whole of *free positions between them*: a dial that rounded every
    // release onto a detent would have four positions and no others.
    expect(snap(0.7)).toBe(0.7);
    expect(detentAt(0.7)).toBeNull();
  });

  it("clamps to the window and reads nonsense as the default", () => {
    expect(clamp(-3)).toBe(0);
    expect(clamp(4)).toBe(1);
    expect(clamp(Number.NaN)).toBe(fractionOf(DEFAULT_DETENT));
  });

  it("travels detent by detent for a keyboard, from a free position too", () => {
    expect(nextDetent(0.4, 1)).toBe("split");
    expect(nextDetent(0.4, -1)).toBe("glance");
    expect(nextDetent(fractionOf("map"), 1)).toBe("map");
    expect(nextDetent(fractionOf("terminal"), -1)).toBe("terminal");
  });

  it("gives the two sides the whole window and no more", () => {
    for (const detent of DETENTS) {
      const { map, terminal } = sides(fractionOf(detent), WINDOW);
      expect(map + terminal).toBe(WINDOW);
    }
    expect(sides(fractionOf("split"), WINDOW).map).toBe(512);
    expect(sides(fractionOf("map"), WINDOW).terminal).toBe(0);
    expect(sides(fractionOf("terminal"), WINDOW).map).toBe(0);
  });

  it("gives the dial's own column to neither side", () => {
    const REACH = 12;
    for (const detent of DETENTS) {
      const bare = sides(fractionOf(detent), WINDOW);
      const { map, terminal } = sides(fractionOf(detent), WINDOW, REACH);
      // The map side is the flex-basis and the reach does not touch it.
      expect(map).toBe(bare.map);
      expect(terminal).toBeGreaterThanOrEqual(0);
    }
    // Map + seam + terminal is the body, exactly — except at the end detent,
    // where one side is worth the whole body and there is nothing left to take
    // the seam out of.
    expect(sides(fractionOf("split"), WINDOW, REACH)).toEqual({ map: 512, terminal: 500 });
    expect(sides(fractionOf("terminal"), WINDOW, REACH)).toEqual({ map: 0, terminal: 1012 });
    expect(sides(fractionOf("map"), WINDOW, REACH).terminal).toBe(0);
  });
});

describe("the detent ticks are named only where the body can afford it", () => {
  it("names them in a wide body and draws them bare in a narrow one", () => {
    expect(namesFit(NAME_FLOOR)).toBe(true);
    expect(namesFit(NAME_FLOOR - 1)).toBe(false);
  });
});

describe("columns are shed by measured width and by nothing else", () => {
  it("draws every column when the map side is wide", () => {
    expect(columnsAt(1024)).toEqual(["launcher", "view", "rail"]);
  });

  it("sheds the rail, then the launcher, then the view as it narrows", () => {
    expect(columnsAt(COLUMN_FLOORS.rail - 1)).toEqual(["launcher", "view"]);
    expect(columnsAt(COLUMN_FLOORS.launcher - 1)).toEqual(["view"]);
    expect(columnsAt(COLUMN_FLOORS.view - 1)).toEqual([]);
  });

  it("sheds nothing at the floor itself", () => {
    expect(columnsAt(COLUMN_FLOORS.rail)).toContain("rail");
  });

  /*
   * The launcher's floor is the one #48 argues against, and it stands: the
   * shedding is by width alone and one dial move undoes it. Both halves are the
   * decision — a test that only pinned the shedding would be pinning half of an
   * argument.
   */
  it("sheds the launcher below its floor and has it back at the next detent up", () => {
    const glance = sides(fractionOf("glance"), WINDOW).map;
    const split = sides(fractionOf("split"), WINDOW).map;
    expect(glance).toBeLessThan(COLUMN_FLOORS.launcher);
    expect(columnsAt(glance)).not.toContain("launcher");

    expect(split).toBeGreaterThanOrEqual(COLUMN_FLOORS.launcher);
    expect(columnsAt(split)).toContain("launcher");
  });
});

describe("a view below its floor stands down, and nothing switches by itself", () => {
  it("says nothing at all when the view fits", () => {
    expect(standDown("route", fractionOf("split"), WINDOW, VIEWS)).toBeNull();
  });

  it("names the view, what it needs and what it has", () => {
    const standing = standDown("route", fractionOf("glance"), WINDOW, VIEWS);
    expect(standing).not.toBeNull();
    expect(standing?.view).toBe("route");
    expect(standing?.needs).toBe(VIEW_FLOORS.route);
    expect(standing?.has).toBe(sides(fractionOf("glance"), WINDOW).map);
    expect(standing?.has).toBeLessThan(VIEW_FLOORS.route);
  });

  it("offers exactly two exits, and both are things an operator presses", () => {
    const standing = standDown("route", fractionOf("glance"), WINDOW, VIEWS);
    expect(standing?.exits).toHaveLength(2);
    // The narrowest detent that honours the floor, not the widest: an exit that
    // took the whole window would be answering a question nobody asked.
    expect(standing?.exits[0]).toEqual({ kind: "widen", detent: "split", honoured: true });
    // One view registered, so nothing else fits here and the second exit is the
    // other side of the dial rather than a view that does not exist.
    expect(standing?.exits[1]).toEqual({ kind: "terminal" });
  });

  it("offers a view that does fit here when there is one", () => {
    const floors = { route: 900, plate: 100 };
    const standing = standDown("route", fractionOf("split"), WINDOW, ["route", PLATE], floors);
    expect(standing?.exits[1]).toEqual({ kind: "open", view: PLATE });
    // And it is an offer. Nothing in the answer says which view is open — that
    // is the caller's state, and the stand-down never changes it.
    expect(standing?.view).toBe("route");
  });

  it("still offers a way out when the window itself is too small", () => {
    const floors = { route: 4000 };
    const standing = standDown("route", fractionOf("split"), WINDOW, ["route"], floors);
    expect(standing?.exits[0]).toEqual({ kind: "widen", detent: "map", honoured: false });
    expect(standing?.exits[1]).toEqual({ kind: "terminal" });
  });

  it("surfaces a view at the narrowest detent that honours it", () => {
    expect(surfaces(VIEW_FLOORS.route, WINDOW)).toBe("split");
    expect(surfaces(300, WINDOW)).toBe("glance");
    expect(surfaces(4000, WINDOW)).toBeNull();
  });

  it("answers which views fit, from floors alone", () => {
    const floors = { route: 900, plate: 100 };
    expect(fittingViews(512, ["route", PLATE], floors)).toEqual([PLATE]);
    expect(fittingViews(1000, ["route", PLATE], floors)).toEqual(["route", PLATE]);
    expect(honours(VIEW_FLOORS.route, VIEW_FLOORS.route)).toBe(true);
  });
});

describe("the position is remembered per map", () => {
  const FOLDER = "/Users/x/repo";

  afterEach(() => {
    window.localStorage.clear();
  });

  it("comes back on the same map and not on another one", () => {
    writePosition(FOLDER, 12, fractionOf("map"));
    expect(readPosition(FOLDER, 12)).toBe(fractionOf("map"));
    expect(readPosition(FOLDER, 13)).toBe(fractionOf(DEFAULT_DETENT));
    expect(readPosition("/Users/x/other", 12)).toBe(fractionOf(DEFAULT_DETENT));
  });

  it("reads a stored value that does not parse as absence", () => {
    writePosition(FOLDER, 12, fractionOf("map"));
    const key = Object.keys(window.localStorage).find((name) => name.includes("12"));
    expect(key).toBeDefined();
    window.localStorage.setItem(key as string, "wide-ish");
    expect(readPosition(FOLDER, 12)).toBe(fractionOf(DEFAULT_DETENT));

    // Out of the window is the same kind of nonsense as not a number at all.
    window.localStorage.setItem(key as string, "7");
    expect(readPosition(FOLDER, 12)).toBe(fractionOf(DEFAULT_DETENT));
  });

  it("has no key and no default of its own with no map open", () => {
    writePosition(FOLDER, null, fractionOf("map"));
    writePosition(null, 12, fractionOf("map"));
    expect(Object.keys(window.localStorage)).toHaveLength(0);
    expect(readPosition(FOLDER, null)).toBe(fractionOf(DEFAULT_DETENT));
    expect(readPosition(null, null)).toBe(fractionOf(DEFAULT_DETENT));
  });
});

describe("a collapsing detent may not resize a PTY", () => {
  it("knows a geometry no terminal could live at", () => {
    expect(habitable({ rows: 24, cols: 80 })).toBe(true);
    expect(habitable({ rows: 0, cols: 0 })).toBe(false);
    expect(habitable({ rows: 24, cols: 0 })).toBe(false);
    expect(habitable({ rows: Number.NaN, cols: 80 })).toBe(false);
  });

  it("knows a box that has been collapsed out of the layout", () => {
    expect(collapsed({ width: 0, height: 400 })).toBe(true);
    expect(collapsed({ width: 400, height: 0 })).toBe(true);
    expect(collapsed({ width: 400, height: 400 })).toBe(false);
  });

  it("sends no resize for a degenerate geometry, on any occasion", () => {
    const sent: unknown[] = [];
    const dial = gesture((geometry) => sent.push(geometry));

    dial.measured("settled", { rows: 0, cols: 0 });
    dial.measured("drag", { rows: 0, cols: 0 });
    expect(sent).toEqual([]);

    // And the store is untouched by it, so nothing downstream can pick the
    // degenerate size up later and send it.
    expect(readUi().geometry).toEqual(OPENING);

    dial.measured("settled", { rows: 24, cols: 80 });
    expect(sent).toEqual([{ rows: 24, cols: 80 }]);
    dial.cancel();
  });
});

describe("a poll cannot move the dial", () => {
  it("leaves a position mid-gesture exactly where the hand put it", () => {
    moveDial(0.62);
    startGesture();
    expect(readUi().dragging).toBe(true);

    replaceSnapshot(FIXTURES["awkward-map"]);

    expect(readUi().position).toBe(0.62);
    expect(readUi().dragging).toBe(true);
    moveDial(fractionOf(DEFAULT_DETENT));
  });
});
