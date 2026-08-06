// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { FIXTURES, FIXTURE_NAMES } from "../src/snapshot/fixtures";
import { NO_MAP_OPEN } from "../src/snapshot/readout";
import { hasRustBehindIt } from "../src/snapshot/snapshot";

/**
 * `dev:web` boots the whole frontend from a checked-in snapshot with no Rust
 * process behind it.
 *
 * Asserted by actually mounting the app, because *boots* is the claim. Every
 * other check in this repository could pass while the page threw on mount —
 * the fixtures parse, the types compile, the derivation is right — and an
 * operator would still open a browser onto nothing.
 */

/*
 * React only flushes effects inside `act` when it is told it is in a test
 * environment. Without this the assertions still pass — because the snapshot
 * arrives in a microtask either way — but every render logs a warning, and a
 * suite that always warns is a suite whose warnings nobody reads.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(search: string): Promise<string> {
  // Booting twice in one test is how two fixtures get compared, and a mount
  // left behind would go on answering `document.querySelector` for the rest of
  // the file — so the previous one goes before the next one arrives.
  teardown();

  // The one thing a browser cannot be talked out of: `jsdom` has a `window`,
  // and what makes this the `dev:web` path is that nothing put Tauri on it.
  window.history.replaceState({}, "", search);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<App />);
  });
  // The snapshot arrives from a promise, so one more turn of the loop.
  await act(async () => {
    await Promise.resolve();
  });

  return host.textContent ?? "";
}

/** The view itself, rather than the whole window it is mounted in. */
function theRoute(): Element {
  const section = document.querySelector('[aria-label="The Route"]');
  if (section === null) throw new Error("the app did not open on the Route");
  return section;
}

/** The chip in the chrome: the header's whole claim about the model. */
function theChip(): Element {
  const chip = document.querySelector("header [data-state]");
  if (chip === null) throw new Error("the chrome has no map chip");
  return chip;
}

/** The same model, spelled by `describeModel`, at the other end of the window. */
function theReadout(): string {
  return document.querySelector("footer")?.textContent ?? "";
}

/** One row, by the number it carries. */
function theRow(number: number): Element {
  const row = theRoute().querySelector(`[data-node="${number}"]`);
  if (row === null) throw new Error(`no row for #${number}`);
  return row;
}

/**
 * The heading a row sits under, which is the whole of what the pane says about
 * where that ticket stands. The list is labelled by its heading's id, so this
 * reads the association the screen reader reads rather than a sibling walk.
 */
function theHeadingOver(number: number): string {
  const list = theRow(number).closest("[aria-labelledby]");
  const id = list?.getAttribute("aria-labelledby");
  const heading = id === null || id === undefined ? null : document.getElementById(id);
  if (heading === null) throw new Error(`#${number} sits under no heading`);
  return heading.firstElementChild?.textContent ?? "";
}

/*
 * Every way a browser can be made to draw a line between two things, plus the
 * attribute the ranked view that preceded this one hung on the ones it drew.
 */
const ANY_DRAWN_EDGE = "svg, path, line, polyline, polygon, canvas, [data-link]";

function teardown() {
  if (mounted === null) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

afterEach(teardown);

describe("dev:web", () => {
  it("has no Rust behind it, which is the whole condition", () => {
    expect(hasRustBehindIt()).toBe(false);
  });

  it("mounts and puts the derived model on screen", async () => {
    const text = await boot("/?map=awkward-map");
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    expect(text).toContain("perseverance");
    expect(text).toContain("wayfinding");
    expect(text).toContain(`frontier #${map.frontier}`);
  });

  it("opens on the Route and lists the map's own nodes, grouped and in map order", async () => {
    await boot("/?map=awkward-map");
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    const route = theRoute();
    const drawn = [...route.querySelectorAll("[data-node]")];
    const numbers = drawn.map((el) => Number(el.getAttribute("data-node")));

    // Every node, once.
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      [...map.nodes.map((node) => node.number)].sort((a, b) => a - b),
    );
    /*
     * And in section order down the one column: what is being worked, then what
     * can be started, then what is held up, then what is done — with `map.nodes`
     * order kept inside each of them. 73 before 74 and 75 before 76 are the
     * operator's own arrangement, which no sort would produce and nothing here
     * is allowed to improve on.
     */
    expect(numbers).toEqual([77, 70, 73, 74, 75, 76, 72, 71]);
    expect(theHeadingOver(77)).toBe("Now");
    expect(theHeadingOver(75)).toBe("Frontier");

    // In full. The browser cuts the title with CSS, so the whole string is
    // still in the document to be found, read aloud and asserted on.
    expect(route.textContent).toContain("Held up, and holding this up");
    expect(route.textContent).toContain("Somebody is already on this one");

    // The four states arrive from Rust and are spelled, not re-derived here.
    const stateOf = new Map(map.nodes.map((node) => [node.number, node.state]));
    expect(drawn.map((el) => el.getAttribute("data-state"))).toEqual(
      numbers.map((number) => stateOf.get(number)),
    );
  });

  it("heads the top section Next when the map has nobody working on it", async () => {
    await boot("/?map=two-maps-one-open");

    // Nothing is claimed here, so the section that would read *Now* reads what
    // it rests at, and under it is the one node the map designates.
    expect(theHeadingOver(32)).toBe("Next");
  });

  it("marks exactly one node as the frontier, so what next has one answer", async () => {
    await boot("/?map=awkward-map");

    const frontier = [...theRoute().querySelectorAll("[data-frontier]")];

    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.getAttribute("data-node")).toBe("75");
  });

  it("is a list rather than a drawing, on every fixture there is", async () => {
    /*
     * ADR 0006's decision, at the end of the shipped path: The Route is a
     * grouped list and draws no edge. Unconditional and over every fixture,
     * because a rule with an exception is a rule with a place for a graph to
     * come back — and a mounted app is where one would come back unnoticed.
     */
    for (const name of FIXTURE_NAMES) {
      await boot(`/?map=${name}`);
      // The pane is open wherever there is a map to open it on, so nothing here
      // passes by there being nothing on screen to look at.
      const open = FIXTURES[name].model.map !== null;
      const route = document.querySelector('[aria-label="The Route"]');
      expect([name, route !== null]).toEqual([name, open]);
      expect([name, [...(route?.querySelectorAll(ANY_DRAWN_EDGE) ?? [])]]).toEqual([
        name,
        [],
      ]);
    }
  });

  it("counts what holds a ticket up, from the fixture's own edges", async () => {
    await boot("/?map=awkward-map");

    // #72 waits on #75 and #76, and this map shows both of them open. The
    // fixture's edges are the model's, so this is the shipped path end to end:
    // the edge reaches the screen as a word rather than as a line.
    expect(theRow(72).textContent).toContain("blocked by 2");
    // A zero is worth no ink, and `blocked by 0` on a blocked row is a
    // contradiction an operator can see.
    expect(theRoute().textContent).not.toContain("blocked by 0");
  });

  it("says a ticket waits on something that has no row on this map", async () => {
    await boot("/?map=two-maps-one-open");

    // #32 waits on #30, which is closed and is not a child of this map. This
    // map cannot say whether it is done, so it is said on #32's own row rather
    // than counted into a number nothing on screen accounts for.
    expect(theRow(32).textContent).toContain("not a child of this map");
  });

  it("keeps the launcher on screen while a map is open, because nothing brings it back", async () => {
    const text = await boot("/?map=awkward-map");

    /*
     * The snapshot is read once at mount and nothing re-reads it, so a shell
     * that put the view where the launcher had been would take open, locate,
     * forget and *open a new folder* off the screen for the rest of the
     * process — and there is nothing on the Route that reaches them. Both
     * surfaces, and neither of them a mode. What each is worth once the dial
     * exists is #52's; that neither can vanish is this.
     */
    expect(document.querySelector('[aria-label="Folders"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="The Route"]')).not.toBeNull();
    expect(text).toContain("Open a new folder");
  });

  it("opens on the launcher when there is no map, rather than on an empty Route", async () => {
    const text = await boot("/?map=no-map-open");

    // A window with no map open is not a map with nothing in it: it is the
    // folder list, which is what the app opens on. The Route keeps its own
    // words for an absent map — `route-view.test.tsx` holds that to the
    // chrome's phrasing rather than a view-local copy — but a window with
    // nothing open is never what those words are for.
    expect(document.querySelector('[aria-label="The Route"]')).toBeNull();
    expect(text).toContain("Folders");
    expect(text).toContain(NO_MAP_OPEN);
  });

  it("names the open map in the chrome rather than asserting there is none", async () => {
    await boot("/?map=awkward-map");
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    // The chip shipped as a constant, so this is the assertion that would have
    // failed the moment #34 listed a map under a header saying none was open.
    const chip = theChip();
    expect(chip.getAttribute("data-state")).toBe("open");
    expect(chip.textContent).toContain(`#${map.number}`);
    expect(chip.textContent).toContain(map.title);
    expect(chip.textContent).not.toContain(NO_MAP_OPEN);
  });

  it("says the chrome's own words for an absence, in the chrome, when there is none", async () => {
    await boot("/?map=no-map-open");

    const chip = theChip();
    expect(chip.getAttribute("data-state")).toBe("empty");
    expect(chip.textContent).toContain(NO_MAP_OPEN);
  });

  it("never lets the header and the readout disagree, on any fixture there is", async () => {
    /*
     * The claim in the form it is actually made: one model, two renderings, at
     * opposite ends of the window. Over every fixture rather than the two that
     * make the point, because a fixture added later is exactly where a third
     * account of *is anything open* would come from — and both readings reach
     * for the same constant, so neither can drift into agreeing by accident.
     */
    for (const name of FIXTURE_NAMES) {
      await boot(`/?map=${name}`);
      const openInTheChrome = theChip().getAttribute("data-state") === "open";
      const openInTheReadout = !theReadout().includes(NO_MAP_OPEN);

      expect([name, openInTheChrome]).toEqual([name, openInTheReadout]);
    }
  });

  it("opens a map with nothing on it without throwing on the way", async () => {
    await boot("/?map=empty-map");
    const route = theRoute();

    /*
     * The pane is there and it is empty: no sections, no rows, and no frame
     * kept alive around the absence. A heading is a claim that there is
     * something under it and a count standing in for nothing is the zero that
     * `—` exists to be told apart from, so neither is drawn. What an empty map
     * should *say* — as opposed to what it may not claim — is #37's.
     */
    expect(route.querySelectorAll("h2")).toHaveLength(0);
    expect(route.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(route.querySelectorAll(ANY_DRAWN_EDGE)).toHaveLength(0);
  });

  it("boots whichever map the url named", async () => {
    const text = await boot("/?map=map-closed");

    expect(text).toContain("done");
    expect(text).not.toContain("wayfinding");
  });

  it("boots on a map with nothing on it without reading as finished", async () => {
    const text = await boot("/?map=empty-map");

    expect(text).toContain("unstarted");
    expect(text).toContain("nothing to start");
  });

  it("still lists the map when the last poll failed", async () => {
    const text = await boot("/?map=unreachable");
    const map = FIXTURES.unreachable.model.map;
    if (map === null) throw new Error("the unreachable fixture has no map");

    // Never silence. The frontier is still named, because what was read last
    // time is still what is true of the last time anybody looked.
    expect(text).toContain(`frontier #${map.frontier}`);
  });

  it("says the model is stale rather than showing a failed poll as a fresh one", async () => {
    /*
     * The two fixtures carry the same model and differ only in provenance —
     * which is the whole point of a failed poll re-emitting rather than going
     * silent, and also the way this could go quietly wrong. A screen that drew
     * them identically would be presenting an unreachable GitHub as a live
     * read, which is the one thing the provenance rules exist to prevent.
     */
    const failed = await boot("/?map=unreachable");
    expect(failed).toContain("from the last read");
    expect(failed).toContain("nothing newer has arrived");

    const fresh = await boot("/?map=awkward-map");
    expect(fresh).toContain("from a checked-in fixture");
    expect(fresh).not.toContain("nothing newer has arrived");
  });

  it("stamps each thing that was read from its own provenance, and names which", async () => {
    /*
     * Two stamps, and the ways this goes wrong are both silent. Feed one of
     * them the other's provenance and a stale map list reads as fresh — the
     * exact failure the stamp exists to prevent, and invisible, because the
     * wrong stamp is still a plausible-looking stamp. Drop the labels and the
     * reader cannot tell which of two identical sentences is about what.
     *
     * So this asserts the pairing rather than the presence: on this fixture
     * the model was read and the map list was not, and no single provenance
     * can produce both of those sentences.
     */
    await boot("/?map=unreachable");
    const stamps = [...document.querySelectorAll("[data-source]")].map((el) => ({
      source: el.getAttribute("data-source"),
      text: el.textContent ?? "",
    }));

    expect(stamps).toHaveLength(2);
    const [model, mapList] = stamps;
    if (model === undefined || mapList === undefined) throw new Error("two stamps expected");

    // The model came from a copy, because the poll that would have replaced it
    // failed. The age moves with the real clock, so only the words are pinned.
    expect(model.source).toBe("cache");
    expect(model.text.startsWith("model from the last read")).toBe(true);
    expect(model.text).toContain("nothing newer has arrived");

    // Nothing has opened a folder, so the map list has never been read — and
    // says so, rather than borrowing the age of something that has been.
    expect(mapList.source).toBe("none");
    expect(mapList.text).toBe("maps nothing read yet");
  });

  it("carries the reason the read did not land, in the words it arrived in", async () => {
    await boot("/?map=unreachable");
    const stamp = document.querySelector('[data-outcome="failed"]');

    expect(stamp?.getAttribute("title")).toBe("could not reach GitHub");
  });
});
