// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Map as MapModel, Model, Node } from "../src/snapshot/model.generated";
/* `Plate.jsx` and not `Plate`, for the reason `tests/plate-view.test.tsx`
   gives: an extensionless `./Plate` resolves to the geometry module. */
import { Plate } from "../src/views/plate/Plate.jsx";
import { CELL_PIXELS, plateOf } from "../src/views/plate/plate";
import { openPinsAt, readPins, readPinsOnScreen, writePins } from "../src/views/plate/pins";

/**
 * The one exception to *no stored node positions*, from both ends.
 *
 * `tests/plate.test.ts` pins the geometry a pin is honoured by; this pins the
 * seam it is remembered through and the gesture that writes it. Everything here
 * runs on the `localStorage` half of the seam, which is the half the window with
 * no Rust behind it uses — `crates/app/src/lib.rs` holds the other half against
 * the same rules, in its own tests.
 *
 * What is asserted, in order: an arrangement is per map and under the Plate's
 * own key, junk in the store is *nothing pinned* rather than a refusal, a drag
 * writes exactly once on the settled gesture and nothing per frame, and a pin
 * the graph has moved under stamps the plate provisional in the legend — which
 * until this slice was a path nothing could reach.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const FOLDER = 7;
const MAP = 28;

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

function mapOf(nodes: readonly Node[]): MapModel {
  return {
    number: MAP,
    title: "Spec: perseverance",
    closed: false,
    phase: "wayfinding",
    counts: { tickets: nodes.length, open: nodes.length, specs: 0 },
    nodes: [...nodes],
    frontier: { frontier: "nothingToStart" },
    fog: { fog: "unsurveyed" },
  };
}

const THREE: readonly Node[] = [node(1), node(2, { waitsOn: [1] }), node(3, { waitsOn: [1] })];
const MODEL: Model = { map: mapOf(THREE) };

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(model: Model): Promise<HTMLElement> {
  if (mounted === null) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = { root: createRoot(host), host };
  }
  const { root, host } = mounted;
  await act(async () => {
    root.render(<Plate model={model} selected={null} onSelect={() => {}} />);
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

/** A pointer gesture, in the two events a settled drag is: down here, up there.
 *  jsdom has no `PointerEvent`, and what this view reads off one is the two
 *  client coordinates a `MouseEvent` carries. */
function drag(station: Element, by: { columns: number; rows: number }) {
  const at = (type: string, x: number, y: number) =>
    station.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }),
    );
  act(() => {
    at("pointerdown", 100, 100);
    at("pointerup", 100 + by.columns * CELL_PIXELS, 100 + by.rows * CELL_PIXELS);
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  await act(async () => {
    openPinsAt(null, null);
  });
});

afterEach(teardown);

describe("an arrangement is remembered per map, under the Plate's own key", () => {
  it("writes where the dial is not, and reads back exactly what was put", async () => {
    await writePins(FOLDER, MAP, new Map([[2, { column: 20, row: 8 }]]));

    const keys = Object.keys(window.localStorage);
    expect(keys).toEqual([`perseverance.plate.${FOLDER}#${MAP}`]);
    expect(keys.some((key) => key.startsWith("perseverance.dial."))).toBe(false);

    expect([...(await readPins(FOLDER, MAP))]).toEqual([[2, { column: 20, row: 8 }]]);
    /* Per map and per folder: neither the next map nor the same map in another
       folder inherits an arrangement. */
    expect((await readPins(FOLDER, MAP + 1)).size).toBe(0);
    expect((await readPins(FOLDER + 1, MAP)).size).toBe(0);
    /* And nothing open is not a place an arrangement can belong to. */
    expect((await readPins(null, MAP)).size).toBe(0);
    expect((await readPins(FOLDER, null)).size).toBe(0);
  });

  it("reads anything that is not an arrangement as nothing pinned", async () => {
    for (const written of [
      "not json",
      "0.3",
      "{}",
      "[]",
      '[{"node":0,"column":2,"row":2}]',
      '[{"node":2,"column":-1,"row":2}]',
      '[{"node":2,"column":2,"row":99999}]',
      '[{"node":2,"column":2.5,"row":2}]',
      '["north of the fold"]',
    ]) {
      window.localStorage.setItem(`perseverance.plate.${FOLDER}#${MAP}`, written);
      expect((await readPins(FOLDER, MAP)).size, written).toBe(0);
    }

    /* One bad pin costs that pin and not the arrangement: what is left is an
       authored plate the graph has moved under, which is provisional and drawn. */
    window.localStorage.setItem(
      `perseverance.plate.${FOLDER}#${MAP}`,
      '[{"node":2,"column":2,"row":2},{"node":3,"column":-4,"row":2}]',
    );
    expect([...(await readPins(FOLDER, MAP))]).toEqual([[2, { column: 2, row: 2 }]]);
  });
});

describe("a station is dragged, and the map remembers where it was put", () => {
  it("snaps to a cell, writes once, and draws the station there next time", async () => {
    await act(async () => {
      openPinsAt(FOLDER, MAP);
    });

    const view = await paint(MODEL);
    const was = plateOf(MODEL.map).stations.find((station) => station.number === 2);
    if (was === undefined) throw new Error("the fixture has no station 2");

    const station = view.querySelector('[data-node="2"]');
    if (station === null) throw new Error("station 2 is not drawn");
    expect(station.getAttribute("data-pinned")).toBeNull();

    drag(station, { columns: 3, rows: -2 });
    const wanted = { column: was.at.column + 3, row: was.at.row - 2 };

    /* One pin, in the store on screen and in the one place it is remembered. */
    expect([...readPinsOnScreen()]).toEqual([[2, wanted]]);
    expect([...(await readPins(FOLDER, MAP))]).toEqual([[2, wanted]]);

    /* And the drawing honours it exactly: the geometry places the station in
       the cell the hand chose, and the view redraws over that geometry. */
    const again = await paint(MODEL);
    const moved = again.querySelector('[data-node="2"]');
    expect(moved?.getAttribute("data-pinned")).toBe("");
    const pinned = plateOf(MODEL.map, new Map([[2, wanted]])).stations.find(
      (candidate) => candidate.number === 2,
    );
    expect(pinned?.at).toEqual(wanted);
    /* The label box is the eight-anchor solver's, on a pinned station as on a
       generated one — rule 11's reservation is not something a pin opts out of. */
    expect(pinned?.label.box).toBeDefined();
  });

  it("does not write for a press that never moved", async () => {
    await act(async () => {
      openPinsAt(FOLDER, MAP);
    });
    const view = await paint(MODEL);
    const station = view.querySelector('[data-node="2"]');
    if (station === null) throw new Error("station 2 is not drawn");

    drag(station, { columns: 0, rows: 0 });

    expect(readPinsOnScreen().size).toBe(0);
    expect(window.localStorage.getItem(`perseverance.plate.${FOLDER}#${MAP}`)).toBeNull();
  });
});

describe("a plate the graph has moved under says so", () => {
  it("stamps provisional and gives the legend the entry that explains it", async () => {
    /* A pin for a child this map does not have: an authored layout, stale. */
    window.localStorage.setItem(
      `perseverance.plate.${FOLDER}#${MAP}`,
      '[{"node":1,"column":8,"row":6},{"node":99,"column":30,"row":6}]',
    );
    await act(async () => {
      openPinsAt(FOLDER, MAP);
    });

    const view = await paint(MODEL);
    const entry = view.querySelector('[data-legend-key="provisional"]');
    expect(entry).not.toBeNull();
    expect(entry?.textContent).toContain("no longer match the graph");
  });
});
