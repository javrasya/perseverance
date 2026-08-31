// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
/*
 * `Detail.jsx` and not `Detail`, and the extension is load-bearing: macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Detail`
 * finds `detail.ts` — the arithmetic module — and the component is never
 * imported. The same spelling `App.tsx` uses.
 */
import { Detail } from "../src/detail/Detail.jsx";
import {
  CLAIM_ANONYMOUS,
  HEADINGS,
  MAP_CLOSED,
  NO_BODY,
  NO_DATES,
  NOT_TOLD,
  beyondTheMapNote,
} from "../src/detail/detail";
import { FIXTURE_NAMES, fixtureNamed, type FixtureName } from "../src/snapshot/fixtures";
import type { Model } from "../src/snapshot/model.generated";

/**
 * The panel, mounted.
 *
 * `tests/detail.test.ts` pins the joins; this pins the picture, and its first
 * claim is the one the ticket is named for: **there is no state this window can
 * be in where the panel is blank.** Every fixture the app ships, with nothing
 * selected, with every node on the map selected in turn, and with a selection
 * that names no row, has to leave words on screen.
 */

/* Same reason as `tests/route-view.test.tsx`: a suite that always warns is a
   suite whose warnings nobody reads. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(model: Model, selection: number | null = null): Promise<HTMLElement> {
  if (mounted === null) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = { root: createRoot(host), host };
  }
  const { root, host } = mounted;

  await act(async () => {
    root.render(<Detail model={model} selection={selection} />);
  });

  return host;
}

async function paintFixture(name: FixtureName, selection: number | null = null) {
  return paint(fixtureNamed(name).model, selection);
}

afterEach(async () => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  await act(async () => root.unmount());
  host.remove();
});

/**
 * The words on screen, read the way a person reads them: one space at every
 * element boundary, so two paragraphs stacked in a field do not come back as
 * one run-together word.
 */
function words(node: globalThis.Node | null): string {
  if (node === null) return "";
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? "";
  return [...node.childNodes]
    .map(words)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function field(host: HTMLElement, name: string): string {
  return words(host.querySelector(`[data-field="${name}"]`));
}

describe("the panel never renders empty", () => {
  it("has words in it for every fixture, with nothing selected", async () => {
    for (const name of FIXTURE_NAMES) {
      const host = await paintFixture(name);
      expect([name, words(host).length > 20]).toEqual([name, true]);
    }
  });

  it("has words in it for every node of every fixture", async () => {
    for (const name of FIXTURE_NAMES) {
      for (const node of fixtureNamed(name).model.map?.nodes ?? []) {
        const host = await paintFixture(name, node.number);
        expect([name, node.number, words(host).length > 20]).toEqual([
          name,
          node.number,
          true,
        ]);
      }
    }
  });

  it("says something different in each of its five states", async () => {
    const said = new Map<string, string>();
    said.set("noMap", words(await paintFixture("no-map-open")));
    said.set("mapEmpty", words(await paintFixture("empty-map")));
    said.set("unselected", words(await paintFixture("awkward-map")));
    said.set("gone", words(await paintFixture("awkward-map", 9999)));
    said.set("node", words(await paintFixture("awkward-map", 75)));

    expect(new Set(said.values()).size).toBe(said.size);
  });

  it("says the selection is gone rather than blanking when its row goes", async () => {
    const before = await paintFixture("awkward-map", 75);
    expect(before.getAttribute("data-panel")).toBe(null);

    // The poller replaces the graph whole; the same selection now names no row.
    const after = await paintFixture("empty-map", 75);
    expect(after.querySelector('[data-panel="mapEmpty"]')).not.toBeNull();
    expect(words(after).length).toBeGreaterThan(20);
  });
});

describe("every field the ticket lists is on screen", () => {
  it("prints all nine, in one pass", async () => {
    const host = await paintFixture("awkward-map", 72);
    const printed = [...host.querySelectorAll("[data-field]")].map((el) =>
      el.getAttribute("data-field"),
    );

    expect(printed).toEqual([
      "question",
      "type",
      "state",
      "blockers",
      "blocked",
      "claim",
      "dates",
      "resolution",
      "link",
    ]);
    expect(Object.keys(HEADINGS)).toEqual(printed);
  });

  it("says the question is the title and nothing implies a body", async () => {
    const host = await paintFixture("awkward-map", 72);
    const node = fixtureNamed("awkward-map").model.map?.nodes.find((row) => row.number === 72);

    expect(field(host, "question")).toContain(node?.title ?? "");
    expect(field(host, "question")).toContain(NO_BODY);
  });

  it("names each kind, including the one that is nobody's", async () => {
    expect(field(await paintFixture("awkward-map", 77), "type")).toBe("Type ticket, grilling");
    expect(field(await paintFixture("awkward-map", 73), "type")).toBe("Type spec");
    expect(field(await paintFixture("awkward-map", 70), "type")).toBe("Type unclassified");
  });

  it("carries the state, the designation and the machine binding as three facts", async () => {
    const designated = await paintFixture("awkward-map", 75);
    expect(designated.querySelector('[data-field="state"] [data-state]')?.textContent).toBe(
      "takeable",
    );
    expect(field(designated, "state")).toContain("designated");

    const bound = fixtureNamed("platform-bound-macos").model.map?.nodes.find(
      (node) => node.boundElsewhere,
    );
    if (bound !== undefined) {
      expect(field(await paintFixture("platform-bound-macos", bound.number), "state")).toContain(
        "not on this machine",
      );
    }
  });

  it("names the blockers and what waits, rather than counting either", async () => {
    const host = await paintFixture("awkward-map", 72);
    const blockers = [...host.querySelectorAll('[data-field="blockers"] [data-edge]')].map(
      (el) => el.getAttribute("data-edge"),
    );

    expect(blockers).toEqual(["75", "76"]);
    // Names and their states, never a count: the count is the Route row's, and
    // a second one here would be a second thing to keep in step.
    expect(field(host, "blockers")).toContain("The first thing that can be started");
    expect(field(host, "blockers")).not.toMatch(/blocked by \d/);
    expect(
      [...host.querySelectorAll('[data-field="blocked"] [data-edge]')].map((el) =>
        el.getAttribute("data-edge"),
      ),
    ).toEqual(["71"]);
  });

  it("says a blocker with no row here in words", async () => {
    const map = fixtureNamed("awkward-map").model.map;
    if (map === null) throw new Error("awkward-map has a map");
    const model: Model = {
      map: {
        ...map,
        nodes: map.nodes.map((node) =>
          node.number === 76 ? { ...node, waitsOn: [4242] } : node,
        ),
      },
    };
    const host = await paint(model, 76);

    expect(field(host, "blockers")).toContain(beyondTheMapNote(1));
    expect(host.querySelector('[data-field="blockers"] [data-edge]')).toBeNull();
  });

  it("says a claim is held without saying by whom", async () => {
    const held = await paintFixture("awkward-map", 77);
    expect(field(held, "claim")).toBe(`${HEADINGS.claim} held ${CLAIM_ANONYMOUS}`);

    const free = await paintFixture("awkward-map", 76);
    expect(field(free, "claim")).toContain("not held");
  });

  it("prints the dates field as a stated absence and never as a zero", async () => {
    const host = await paintFixture("awkward-map", 76);

    expect(field(host, "dates")).toBe(`${HEADINGS.dates} ${NOT_TOLD} ${NO_DATES}`);
    expect(field(host, "dates")).not.toContain("0");
  });

  it("shows a cut's reason as visible text rather than behind a hover", async () => {
    const host = await paintFixture("out-of-scope", 106);
    const resolution = host.querySelector('[data-field="resolution"]');

    expect(resolution?.querySelector("[data-cut]")?.getAttribute("data-cut")).toBe("fromScope");
    expect(field(host, "resolution")).toContain("the launcher never touched the PTY");
    // Nothing on the panel hides a fact in a tooltip.
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
    expect(field(await paintFixture("out-of-scope", 107), "resolution")).toContain("in scope");
  });

  it("prints the URL as text and never as something that could navigate", async () => {
    const host = await paintFixture("awkward-map", 75);

    expect(field(host, "link")).toContain("https://github.com/");
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("says the map is closed, on the map rather than on the node", async () => {
    const host = await paintFixture("map-closed", 101);

    expect(words(host)).toContain(MAP_CLOSED);
    // The node keeps the state the model gave it: a closed map is not a sixth
    // node state, and this side does not invent one.
    expect(host.querySelector('[data-field="state"] [data-state]')?.getAttribute("data-state"))
      .toBe("takeable");
  });
});

describe("the panel draws no edge and spends no motion", () => {
  it("has no drawn element in any state", async () => {
    for (const name of FIXTURE_NAMES) {
      const map = fixtureNamed(name).model.map;
      const first = map?.nodes[0]?.number ?? null;
      const host = await paintFixture(name, first);

      expect([
        name,
        [...host.querySelectorAll("svg, path, line, polyline, polygon, canvas, [data-link]")],
      ]).toEqual([name, []]);
    }
  });
});
