// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { CacheStamp } from "../src/chrome/CacheStamp";
import { DROP_REGION_HINT } from "../src/chrome/DropRegion";
import { OVERRIDE_REFUSED_COUNSEL } from "../src/environment/folder";
import { COMPOSE_LABEL, START_LABEL } from "../src/chrome/sockets";
import { CONDITIONS } from "../src/chrome/stamp";
import { MapList } from "../src/maps/MapList";
import {
  LABELS_TRUNCATED_NOTE,
  STOPPED_COPY,
  TRUNCATED_NOTE,
  loadFixture,
  type MapsView,
} from "../src/maps/maps";
import { FIXTURES, FIXTURE_NAMES, type FixtureName } from "../src/snapshot/fixtures";
import type { Snapshot } from "../src/snapshot/model.generated";
import { NOTHING_FOR_THIS_MACHINE, NO_MAP_OPEN } from "../src/snapshot/readout";
import { NO_STAKES, WAITING, refusalLine } from "../src/rack/rack";
import {
  PENDING_FIXTURES,
  pendingFixtureNamed,
  refusalsOf,
  waitingOf,
} from "../src/rack/pending";
import { hasRustBehindIt } from "../src/snapshot/snapshot";
import { monitor } from "../src/stores/ui";
import {
  AWAITING_OPERATOR_READING,
  QUIET_READING,
  SIGNAL_READINGS,
  UNWATCHED_READING,
} from "../src/terminal/Pane";
import { RUN_FIXTURES, RUN_FIXTURE_NAMES } from "../src/terminal/fixtures";

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

/*
 * The emulator itself, stood in for — and it is jsdom that decides this, not a
 * choice about the app. xterm.js reaches for `matchMedia` and a canvas the
 * moment a terminal is opened, and jsdom has neither.
 *
 * Nothing is lost, because every claim in this file is about the frame around
 * the terminal rather than the terminal: with no Rust behind the window there
 * is no PTY, no channel and so no byte to write, and what a real `dev:web` tab
 * shows inside the pane is exactly this — an emulator that was opened and never
 * written to.
 */
vi.mock("../src/terminal/xterm", () => ({
  xterm: () => ({
    element: document.createElement("div"),
    write: () => {},
    reset: () => {},
    resize: () => {},
    measure: () => null,
    onData: () => () => {},
    dispose: () => {},
  }),
}));

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(search: string): Promise<string> {
  // Booting twice in one test is how two fixtures get compared, and a mount
  // left behind would go on answering `document.querySelector` for the rest of
  // the file — so the previous one goes before the next one arrives.
  teardown();

  // The one thing a browser cannot be talked out of: `jsdom` has a `window`,
  // and what makes this the `dev:web` path is that nothing put Tauri on it.
  window.history.replaceState({}, "", search);
  /*
   * Which run is on the pane lives in a module-level store that outlives a
   * mount, so a fresh tab is spelled out rather than assumed: without this the
   * fixture set one test opened would still be bound in the next one, and the
   * empty pane would be a state no boot could get back to.
   */
  monitor(null);

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

/**
 * The number a map's frontier names, for the fixtures where it names one. The
 * union is read rather than the number assumed, because two of its three
 * readings are absences with words of their own.
 */
function designatedIn(map: NonNullable<Snapshot["model"]["map"]>): number {
  if (map.frontier.frontier !== "designated") {
    throw new Error("this fixture designates nobody");
  }
  return map.frontier.number;
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
    expect(text).toContain(`frontier #${designatedIn(map)}`);
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
     * can be started, then what is held up, then what is done, then the child
     * nobody classified — and last of all the destination, which is where the
     * map is going. `map.nodes` order is kept inside each of them: 75 before 76
     * inside Frontier and 73 before 74 inside the destination are the operator's
     * own arrangement, which no sort would produce and nothing here is allowed
     * to improve on.
     */
    expect(numbers).toEqual([77, 75, 76, 72, 71, 70, 73, 74]);
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

  it("boots the awkward map with the stray issue under its own heading and the spec at the far end", async () => {
    /*
     * #37 end to end from a booted app. #70 is a bug report somebody dragged
     * onto the map — no `wayfinder:` type at all — and #73 and #74 are the
     * spec. Before this, all three arrived `takeable` and were headed
     * *Frontier*, counted as available work and drawn wearing the ring that
     * means *this is yours to take*, which is how *Start Working* ends up
     * launched at the destination.
     */
    await boot("/?map=awkward-map");
    const route = theRoute();
    const destination = route.querySelector("[data-destination]");

    expect(theHeadingOver(70)).toBe("Unclassified");
    expect(theRow(70).textContent).toContain("unclassified");
    expect(theHeadingOver(73)).toBe("Destination");
    expect(theHeadingOver(74)).toBe("Destination");
    expect(destination).not.toBeNull();
    // No numeral over the destination: a section's count is the rows it heads,
    // so the only honest way to stop counting a spec is to head it with
    // something that prints no count at all.
    expect(destination?.querySelector("[data-count]")).toBeNull();
    // And neither of the three is ever the one answer to *what next*.
    expect(route.querySelectorAll("[data-frontier]")).toHaveLength(1);
    expect(
      route.querySelector("[data-frontier]")?.getAttribute("data-node"),
    ).toBe("75");
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

  it("lists the work this machine cannot start and offers none of it", async () => {
    /*
     * The whole of #61, end to end from a booted app. The map has three
     * takeable tickets on it and every one of them belongs on a machine this is
     * not — so all three are on screen, all three say so, nothing is
     * designated, and the readout says *nothing for this machine* rather than
     * the sentence a finished map gets.
     */
    const text = await boot("/?map=platform-bound-windows");

    const held = [...theRoute().querySelectorAll("[data-elsewhere]")];
    expect(held.map((el) => el.getAttribute("data-node"))).toEqual(["80", "81", "82"]);
    for (const row of held) {
      expect(row.getAttribute("data-state")).toBe("takeable");
      expect(row.textContent).toContain("not on this machine");
    }

    // Nothing is offered, and the row that *is* for this machine is merely
    // blocked — which is what makes the reading below about the machine.
    expect(theRoute().querySelectorAll("[data-frontier]")).toHaveLength(0);
    expect(theRow(83).getAttribute("data-elsewhere")).toBeNull();
    expect(theRow(83).getAttribute("data-state")).toBe("blocked");

    expect(theReadout()).toContain(NOTHING_FOR_THIS_MACHINE);
    expect(text).not.toContain("nothing to start");
  });

  it("offers the same map's work on the machine it belongs to", async () => {
    // The other reading of one recorded answer, so the fixture pair is what
    // proves the difference rather than a sentence about it.
    await boot("/?map=platform-bound-macos");

    const frontier = [...theRoute().querySelectorAll("[data-frontier]")];
    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.getAttribute("data-node")).toBe("81");
    // And #80 is still listed, still under Frontier, and still tagged.
    expect(theRow(80).getAttribute("data-elsewhere")).toBe("");
    expect(theHeadingOver(80)).toBe("Frontier");
    // And #83 wears the tag while being unstartable for another reason
    // entirely: the verdict is about the ticket's binding, so it rides a
    // blocked row without moving its section, its state or its count.
    expect(theRow(83).getAttribute("data-elsewhere")).toBe("");
    expect(theRow(83).getAttribute("data-state")).toBe("blocked");
    expect(theHeadingOver(83)).toBe("Blocked");
    expect(theReadout()).not.toContain(NOTHING_FOR_THIS_MACHINE);
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
     * The snapshot is subscribed to as well as read once at mount, so what is
     * open can now change under a window that stays where it is — which is
     * exactly when a shell that put the view where the launcher had been would
     * bite. It would take open, locate, forget, *open a new folder* and every
     * other map in the repository off the screen for the rest of the process,
     * and there is nothing on the Route that reaches any of them. Both
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

  it("puts the drop region's own words on screen when the whole window boots", async () => {
    const text = await boot("/?map=no-map-open");

    /*
     * `drop-region.test.tsx` proves the component says this; only a mounted
     * `App` can say that the assembled window still holds the component that
     * says it. Drop the wrapper in `App` and every component-level test stays
     * green while first launch shows a body with nothing telling an operator
     * what it is for. Asserted against the exported constant so the wording
     * exists once.
     */
    expect(text).toContain(DROP_REGION_HINT);
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
     * `—` exists to be told apart from, so neither is drawn.
     *
     * #37 looked at what an empty map should *say* and left it saying this. The
     * fog already names itself here and the readout already counts nothing, so
     * a sentence added to the pane would be a third account of one absence —
     * and the two that exist are the two the model actually distinguishes.
     */
    expect(route.querySelectorAll('h2[id^="route-section-"]')).toHaveLength(0);
    expect(route.querySelectorAll("[data-node]")).toHaveLength(0);
    expect(route.querySelectorAll(ANY_DRAWN_EDGE)).toHaveLength(0);
    // The fog is the one region drawn on a map with nothing on it, because
    // here the absence is the fact rather than the reason to say nothing.
    expect(route.querySelector('[data-fog="unsurveyed"]')).not.toBeNull();
  });

  it("boots each fog state and keeps the two nothings apart on screen", async () => {
    await boot("/?map=fog-unsurveyed");
    const nobody = theRoute().querySelector("[data-fog]");
    expect(nobody?.getAttribute("data-fog")).toBe("unsurveyed");
    expect(nobody?.textContent).toContain("—");
    expect(nobody?.querySelector("[data-count]")).toBeNull();

    await boot("/?map=fog-empty");
    const nothing = theRoute().querySelector("[data-fog]");
    expect(nothing?.getAttribute("data-fog")).toBe("surveyed");
    expect(nothing?.querySelector("[data-count]")?.textContent).toBe("0");

    await boot("/?map=fog-charted");
    const charted = theRoute().querySelector("[data-fog]");
    expect(charted?.querySelector("[data-count]")?.textContent).toBe("3");
    // The nested line is on screen and is not one of the three.
    expect(charted?.querySelector("pre")?.textContent).toContain(
      "  - and whether the split is remembered",
    );
    // And the section stopped where the next heading did.
    expect(charted?.textContent).not.toContain("The Route is a grouped list");
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
    expect(text).toContain(`frontier #${designatedIn(map)}`);
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
    const outcome = FIXTURES.unreachable.provenance.outcome;
    if (outcome.kind !== "failed") throw new Error("the unreachable fixture landed");

    expect(stamp?.getAttribute("title")).toBe(outcome.detail);
  });
});

describe("opening a map is a declaration this window makes, and the row is where it is made", () => {
  /**
   * The launcher's top row, opened — which is what puts a map list on screen at
   * all. `dev:web` has no registry and no poller behind either step: the folder
   * comes from the preview rows, the map list from the cached fixture, and
   * `watching` is inert. What is being asserted is the wiring, which is the
   * half that has to be right before a poller could ever be told anything.
   */
  async function openTheTopFolder(): Promise<Element> {
    const folder = document.querySelector('[aria-label="Folders"] li button');
    if (!(folder instanceof HTMLButtonElement)) {
      throw new Error("the launcher has no folder to open");
    }

    await act(async () => {
      folder.click();
    });
    // Remembering the folder, then the cached read, then the binding — three
    // promises deep, and the list is not on screen until the first resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const section = document.querySelector('[aria-label="Maps"]');
    if (section === null) throw new Error("opening a folder drew no map list");
    return section;
  }

  function theRowFor(number: number): Element {
    const row = [...(document.querySelector('[aria-label="Maps"]')?.querySelectorAll("li") ?? [])]
      .find((candidate) => candidate.textContent?.includes(`#${number}`));
    if (row === undefined) throw new Error(`no map row for #${number}`);
    return row;
  }

  it("makes every row a button, because the read behind it now exists", async () => {
    await boot("/?map=awkward-map");
    const list = await openTheTopFolder();

    const rows = [...list.querySelectorAll("li")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const button = row.querySelector("button");
      // `type="button"` and not a bare one: a row inside a form that submitted
      // on click would be a navigation nobody asked for.
      expect([row.textContent, button?.getAttribute("type")]).toEqual([
        row.textContent,
        "button",
      ]);
    }
  });

  it("marks the row you opened and leaves both surfaces exactly where they were", async () => {
    await boot("/?map=awkward-map");
    const list = await openTheTopFolder();
    const opened = loadFixture(1, "?map=awkward-map").maps[0]?.number;
    if (opened === undefined) throw new Error("the map fixture lists nothing");

    // Nothing is open until a row is clicked: a folder is opened with no map
    // open, and a map nobody picked is not a map this window is watching.
    expect(list.querySelectorAll('li[data-open="true"]')).toHaveLength(0);

    const row = theRowFor(opened).querySelector("button");
    if (!(row instanceof HTMLButtonElement)) throw new Error("a row is not a button");
    await act(async () => {
      row.click();
    });

    const marked = [...document.querySelectorAll('[aria-label="Maps"] li[data-open="true"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain(`#${opened}`);
    expect(marked[0]?.querySelector("button")?.getAttribute("aria-current")).toBe("true");

    // Both surfaces, and neither of them a mode: the list is the only way to
    // reach a different map, and the launcher the only way to a different
    // folder, so opening one may not take either away.
    expect(document.querySelector('[aria-label="Folders"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Maps"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Open a new folder");
  });
});

describe("a folder opens whatever its resolution came to", () => {
  /**
   * The launcher's top row, opened, plus enough turns of the loop for the three
   * promises that follow: the registry row, the folder's resolution and the
   * repository binding. `dev:web` has none of the three behind it — the folder
   * comes from the preview rows and the resolution from a checked-in fixture —
   * which is the point: what is asserted is the wiring.
   */
  async function openTheTopFolder(): Promise<void> {
    const folder = document.querySelector('[aria-label="Folders"] li button');
    if (!(folder instanceof HTMLButtonElement)) {
      throw new Error("the launcher has no folder to open");
    }
    await act(async () => {
      folder.click();
    });
    await act(async () => {
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
  }

  it("selects the folder and reads its maps even when nothing answers to the CLI", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();

    /*
     * Criterion 9, at the surface. The folder is selected, the map list is on
     * screen, and the missing program is a note beside all of that — never a
     * refusal that replaced the list, and never a dialog to dismiss first.
     */
    expect(document.querySelector('[aria-label="Maps"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Folders"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Not on this folder's PATH");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.querySelectorAll("dialog")).toHaveLength(0);
  });

  it("puts the folder's own verbatim PATH in the error, scrollable and reachable", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();

    const box = document.querySelector('[aria-label="PATH, exactly as it arrived"]');
    if (box === null) throw new Error("the error carries no PATH");

    // Focusable, because a region a keyboard cannot reach is a region a
    // keyboard user cannot read — and this box is the evidence that makes
    // "not found" something an operator can disagree with.
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.textContent).toContain("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  /** Types into the inline override field the way a keystroke would. */
  async function typeTheOverride(text: string): Promise<void> {
    const field = document.querySelector("#folder-override");
    if (!(field instanceof HTMLInputElement)) throw new Error("the error carries no field");

    // React owns the value, so the event goes through the native setter the
    // way a real keystroke would.
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** *Use this*, wherever in the error it sits. */
  async function submitTheOverride(): Promise<void> {
    const submit = [...document.querySelectorAll("form button")].find(
      (button) => button.textContent === "Use this",
    );
    if (!(submit instanceof HTMLButtonElement)) throw new Error("the error has no submit");

    await act(async () => {
      submit.click();
    });
    await act(async () => {
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
  }

  it("announces the sentence and never the PATH or the field it wraps", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();

    const announced = [...document.querySelectorAll('[role="status"]')];
    expect(announced.length).toBeGreaterThan(0);
    expect(
      announced.some((region) => region.textContent?.includes("Not on this folder's PATH")),
    ).toBe(true);

    /*
     * A polite region containing a text field re-announces everything inside it
     * on every keystroke — and what is inside this one is a hundred PATH
     * entries and the split of whatever has been typed so far. An operator
     * typing the fix would hear the evidence read back to them, character by
     * character, until they stopped. The evidence stays in the same box; it
     * stays out of the announcement.
     */
    for (const region of announced) {
      expect(region.querySelector("input")).toBeNull();
      expect(region.querySelector("[data-parsed]")).toBeNull();
      expect(region.querySelector('[aria-label="PATH, exactly as it arrived"]')).toBeNull();
      expect(region.textContent).not.toContain("/usr/bin:/bin:/usr/sbin:/sbin");
    }

    // And it stays out of it while somebody is typing, which is the case that
    // brought it up: the region may not grow a field partway through a word.
    await typeTheOverride("nod");
    for (const region of document.querySelectorAll('[role="status"]')) {
      expect(region.querySelector("input")).toBeNull();
      expect(region.querySelector("[data-parsed]")).toBeNull();
    }
  });

  it("shows what was typed as a vector before anything uses it", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();

    await typeTheOverride('node "C:\\Program Files\\claude\\cli.js"');

    // Two words, and the quoted path stayed one of them. Shown back before the
    // operator commits to it, which is the whole defence against a split that
    // surprised somebody.
    const parsed = document.querySelector("[data-parsed]");
    expect(parsed?.getAttribute("data-parsed")).toBe("2");
    expect(parsed?.textContent).toContain("C:\\Program Files\\claude\\cli.js");
  });

  it("replaces the error in place when an override answers, with no navigation", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();
    const before = document.querySelector('[aria-label="Folders"] li')?.textContent;

    // Typed first, because an empty field is the refusal and proves nothing
    // about an override answering.
    await typeTheOverride("node /opt/claude/cli.js");
    await submitTheOverride();

    // The note is gone because something resolved, the row is exactly where it
    // was, and nothing navigated anywhere to get here.
    expect(document.body.textContent).not.toContain("Not on this folder's PATH");
    expect(document.querySelector('[aria-label="Folders"] li')?.textContent).toBe(before);
    expect(document.querySelector('[aria-label="Maps"]')).not.toBeNull();
  });

  it("leaves the error exactly where it was when the vector names no program", async () => {
    await boot("/?map=awkward-map&folder=notFound");
    await openTheTopFolder();

    // A pair of quotes around nothing is one empty word, which is a vector
    // whose first word is no program at all.
    await typeTheOverride('""');
    await submitTheOverride();

    // Nothing was changed, so the error is still the answer to the folder —
    // and it says so at the field it was typed into rather than only in a
    // panel that opens closed.
    expect(document.body.textContent).toContain("Not on this folder's PATH");
    expect(document.querySelector("[data-override]")?.getAttribute("data-override")).toBe(
      "refused",
    );
    expect(document.body.textContent).toContain(OVERRIDE_REFUSED_COUNSEL);
    expect(document.querySelector("#folder-override")).not.toBeNull();
  });

  it("carries the per-folder panel beside the folder, on every fixture there is", async () => {
    for (const state of ["resolved", "notFound", "harvestDiscarded", "policyDegraded", "overridden", "overriddenGlobally"]) {
      await boot(`/?map=awkward-map&folder=${state}`);
      await openTheTopFolder();

      const panel = document.querySelector("#folder-environment-panel");
      expect([state, panel !== null]).toEqual([state, true]);
      // A second panel rather than fields on the app-global one, because they
      // answer different questions: that one says what this process is running
      // in, this one says what a folder resolves under, and #45 exists because
      // the two can differ.
      expect([state, document.querySelectorAll("#environment-panel").length]).toEqual([
        state,
        1,
      ]);
    }
  });

  it("names the declined start-up file from what the interpreter wrote", async () => {
    await boot("/?map=awkward-map&folder=policyDegraded");
    await openTheTopFolder();

    const panel = document.querySelector("#folder-environment-panel");
    expect(panel?.textContent).toContain("Start-up file declined");
    // And the transcript it was read out of is shown exactly as it arrived,
    // hard wrap and all, rather than tidied into something that is no longer
    // evidence.
    expect(panel?.textContent).toContain("cannot _x000D__x000A_be loaded");
  });
});

describe("the ledger announces by changing a numeral, and this side only marks what it read", () => {
  /** The record's fixed slot in the chrome. */
  function theLedger(): Element {
    const ledger = document.querySelector("header [data-ledger]");
    if (ledger === null) throw new Error("the chrome has no ledger");
    return ledger;
  }

  /** The numeral, or the word standing in place of one. */
  function theNumeral(): string {
    return theLedger().querySelector("[data-first]")?.textContent ?? "";
  }

  /** Open the record. Reading it is what marks it read. */
  async function reveal(): Promise<Element> {
    const face = theLedger().querySelector("button");
    if (!(face instanceof HTMLButtonElement)) throw new Error("the ledger has no control");
    await act(async () => {
      face.click();
    });
    return theLedger();
  }

  const announceableIn = (name: FixtureName) =>
    FIXTURES[name].ledger.entries
      .flatMap((entry) => entry.clauses)
      .filter((clause) => clause.announce).length;

  it("counts the clauses Rust stamped announceable and re-decides none of them", async () => {
    await boot("/?map=while-you-were-away");

    const clauses = FIXTURES["while-you-were-away"].ledger.entries.flatMap(
      (entry) => entry.clauses,
    );
    const announceable = announceableIn("while-you-were-away");

    // Taken from the fixture rather than written down here: `announce` is
    // decided once, in Rust, over the finished entry, and a number typed into
    // this file would be a second account of that decision.
    expect(announceable).toBeGreaterThan(0);
    expect(announceable).toBeLessThan(clauses.length);
    expect(theNumeral()).toBe(String(announceable));
  });

  it("reads first open rather than a zero for a map nothing has been compared for", async () => {
    await boot("/?map=awkward-map");

    // A map nobody has looked at twice has not failed to move. The two are
    // different facts, so they are different words rather than one number.
    expect(theNumeral()).toBe("first open");
    expect(theNumeral()).not.toBe("0");
    expect(theLedger().getAttribute("data-ledger")).toBe("firstOpen");
  });

  it("keeps the numeral on the chrome on every fixture there is", async () => {
    // A numeral able to vanish is a numeral nobody can trust: an operator
    // glancing at an empty slot cannot tell *nothing has moved* apart from
    // *this window stopped saying*. Unconditional, over every fixture, since
    // the next one added is where a condition would come back unnoticed.
    for (const name of FIXTURE_NAMES) {
      await boot(`/?map=${name}`);
      expect([name, document.querySelectorAll("header [data-ledger]").length]).toEqual([
        name,
        1,
      ]);
      expect([name, theNumeral().length > 0]).toEqual([name, true]);
    }
  });

  it("draws one row for the gap and names it, with its clauses in Rust's own order", async () => {
    await boot("/?map=while-you-were-away");
    const record = await reveal();

    const rows = [...record.querySelectorAll("li[data-seq]")];
    expect(rows).toHaveLength(FIXTURES["while-you-were-away"].ledger.entries.length);
    expect(rows[0]?.getAttribute("data-occasion")).toBe("whileYouWereAway");
    expect(rows[0]?.textContent).toContain("while you were away");

    // The clauses arrive sorted by the fixed precedence and are rendered in
    // arrival order, so what is on screen is the order Rust settled.
    const kinds = [...record.querySelectorAll("[data-kind]")].map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(
      FIXTURES["while-you-were-away"].ledger.entries[0]?.clauses.map(
        (clause) => clause.kind,
      ),
    );
    // The catch-all is in the record and out of the numeral, which is what *the
    // record is complete; the announcement is selective* looks like on screen.
    expect(kinds).toContain("unnamed");
  });

  it("marks the record read when it is read, and the numeral is the only thing that moves", async () => {
    await boot("/?map=while-you-were-away");
    expect(theNumeral()).toBe(String(announceableIn("while-you-were-away")));

    await reveal();

    // Everything up to the newest `seq` has now been read. The count is
    // arithmetic over what Rust stamped and a marker this side holds; nothing
    // here re-decided what was worth announcing.
    expect(theNumeral()).toBe("0");
  });

  it("selects the node a reference names and moves nothing else on the window", async () => {
    await boot("/?map=while-you-were-away");
    const record = await reveal();

    const before = {
      folders: document.querySelector('[aria-label="Folders"]')?.textContent,
      route: [...theRoute().querySelectorAll("[data-node]")].map((el) =>
        el.getAttribute("data-node"),
      ),
      readout: theReadout(),
    };

    const reference = record.querySelector("li[data-kind] button[data-node]");
    if (!(reference instanceof HTMLButtonElement)) {
      throw new Error("the record carries no reference");
    }
    const number = Number(reference.getAttribute("data-node"));

    await act(async () => {
      reference.click();
    });

    // The node is picked, and picking it is the whole of what happened.
    expect(theRow(number).getAttribute("aria-current")).toBe("true");
    expect(theRoute().querySelectorAll('[data-node][aria-current="true"]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="Folders"]')?.textContent).toBe(
      before.folders,
    );
    expect(
      [...theRoute().querySelectorAll("[data-node]")].map((el) =>
        el.getAttribute("data-node"),
      ),
    ).toEqual(before.route);
    expect(theReadout()).toBe(before.readout);

    // And it sets rather than toggles: a record of things already true has no
    // state to put back, so a second look leaves the node picked.
    await act(async () => {
      reference.click();
    });
    expect(theRow(number).getAttribute("aria-current")).toBe("true");
  });

  it("leaves Enter on a reference to the button, so the keyboard sets like the mouse", async () => {
    await boot("/?map=while-you-were-away");
    const record = await reveal();

    const reference = record.querySelector("li[data-kind] button[data-node]");
    if (!(reference instanceof HTMLButtonElement)) {
      throw new Error("the record carries no reference");
    }
    const number = Number(reference.getAttribute("data-node"));
    reference.focus();

    /*
     * The router sits at the window in the capture phase, so a chord it claims
     * here would be `preventDefault`ed out from under the button's own
     * activation — and the row's `open` row *toggles*, which is not what this
     * button does. It resolves a route row by `data-node-row`, which only the
     * route's rows carry, so `Enter` on a reference is the button's.
     */
    const picked = () =>
      [...theRoute().querySelectorAll('[data-node][aria-current="true"]')].map((el) =>
        el.getAttribute("data-node"),
      );
    const before = picked();

    const press = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      reference.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(false);
    expect(picked()).toEqual(before);

    // And the activation the key stands for still sets rather than toggles,
    // twice over — the mouse and the keyboard agreeing on the one control.
    await act(async () => {
      reference.click();
    });
    await act(async () => {
      reference.click();
    });
    expect(theRow(number).getAttribute("aria-current")).toBe("true");
  });

  it("changes a numeral and never takes focus or puts a live region on the chrome", async () => {
    // The whole of the announcement is a number changing on chrome that was
    // already there. Nothing interrupts a screen reader and nothing steals the
    // caret — on every fixture, since the record is unconditional.
    for (const name of FIXTURE_NAMES) {
      await boot(`/?map=${name}`);

      for (const shouting of [
        "[aria-live]",
        '[role="alert"]',
        '[role="status"]',
        '[role="dialog"]',
        '[role="alertdialog"]',
        "dialog",
      ]) {
        expect([name, shouting, document.querySelectorAll(shouting).length]).toEqual([
          name,
          shouting,
          0,
        ]);
      }
      expect([name, document.activeElement]).toEqual([name, document.body]);
    }
  });

  it("holds the numeral still while only the clock moves", async () => {
    /*
     * The stamp beside it ages on a ticker, and the ledger does not: a record
     * grows when a poll lands with something to write down, and `dev:web` has
     * no poller at all. So time passing must move the stamp and leave the
     * numeral exactly where it is — a numeral drifting on a timer would be this
     * side counting something of its own.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T08:00:05Z"));

    try {
      await boot("/?map=while-you-were-away");
      const announceable = String(announceableIn("while-you-were-away"));
      expect(theNumeral()).toBe(announceable);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });

      expect(theReadout()).toContain("4 minutes ago");
      expect(theNumeral()).toBe(announceable);

      // The one thing that does move it is somebody reading the record.
      await reveal();
      expect(theNumeral()).toBe("0");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Every fixture the model crate generates for a read that did not land. */
const DEGRADED: FixtureName[] = ["unreachable", "auth-failed", "map-gone", "rate-limited"];

describe("a harness read failure is a condition on the graph and never an interruption", () => {
  it("raises no modal and no toast, on any condition there is", async () => {
    /*
     * The rule as something that can fail. A modal is a thing that interrupts
     * you to be dismissed, and a poll that did not land is a fact about how old
     * the screen is — so the condition paints and nothing demands an answer.
     * Over every condition rather than the one that is easiest to reach,
     * because the next one somebody adds is where a dialog would come back
     * unnoticed. `aria-live="assertive"` is here for the same reason as the
     * roles: it interrupts a screen reader mid-sentence, which is the same
     * interruption in the other modality.
     */
    for (const name of DEGRADED) {
      await boot(`/?map=${name}`);

      for (const interrupting of [
        '[role="alert"]',
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-live="assertive"]',
        "dialog",
      ]) {
        expect([name, interrupting, document.querySelectorAll(interrupting).length]).toEqual(
          [name, interrupting, 0],
        );
      }
    }
  });

  it("stamps the condition on the graph and keeps the age ageing", async () => {
    for (const name of DEGRADED) {
      await boot(`/?map=${name}`);
      const stamp = document.querySelector("[data-degraded]");
      const outcome = FIXTURES[name].provenance.outcome;
      if (outcome.kind !== "failed") throw new Error(`${name} is not a failed read`);

      // The attribute the dashed-and-hatched vocabulary keys on.
      expect([name, stamp?.getAttribute("data-degraded")]).toEqual([
        name,
        outcome.reason.reason,
      ]);
      // The age is still beside it. A stamp that swapped the age for a reason
      // would stop reporting staleness at the moment it began to matter, which
      // is the moment the reason arrived.
      expect([name, /ago|just now/.test(stamp?.textContent ?? "")]).toEqual([name, true]);
      // The reason is text and not only a hover — #28 story 24 — and the whole
      // detail sentence is still in the `title` beside it.
      expect([name, stamp?.textContent]).toEqual([
        name,
        expect.stringContaining(CONDITIONS[outcome.reason.reason]),
      ]);
      expect([name, stamp?.getAttribute("title")]).toEqual([name, outcome.detail]);
    }
  });

  it("goes on ageing while the poller is stopped and nothing is arriving", async () => {
    /*
     * AC6, in the one state that can defeat it. `AuthFailed` and `MapGone`
     * answer `Floor::Never`, `next_wake` answers `Wake::WhenPoked`, and the
     * loop blocks on its channel — so no further `maps` event is ever emitted
     * and nothing external will re-render this window again. Before #40's
     * review there was no ticker anywhere in `src/`: `now` was read once per
     * paint, the last paint was the one that reported the stop, and the stamp
     * froze on *just now* for the rest of the session while the words beside
     * it went on asserting that freshness.
     *
     * Fake timers rather than a real wait, and the system clock is set just
     * after the fixture's own stamp so the age starts at the bottom of the
     * scale and has somewhere to go.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T08:00:05Z"));

    try {
      await boot("/?map=auth-failed");
      const said = () => document.querySelector("[data-degraded]")?.textContent ?? "";

      expect(said()).toContain("just now");

      // Nothing is poked, nothing is emitted, nothing is clicked. Only time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });

      expect(said()).toContain("4 minutes ago");
      // And the condition is still beside it: the stamp aged, it did not reset.
      expect(said()).toContain(CONDITIONS.authFailed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints the refusing crate's own sentence rather than the condition's short name", async () => {
    /*
     * #28 story 7. `unreachable` is the condition for five refusals that never
     * reach a socket as well as for a dead network, so its short name may not
     * be a diagnosis and the sentence has to be on screen — as text, not in a
     * `title`. A folder with no `.git`, or with no GitHub remote, reading as
     * *could not reach GitHub* on permanent chrome is what this pins shut.
     *
     * The sentences are the store's and the reader's own `Display` output,
     * copied here because no browser can reach these states — the same reason
     * the map list borrows its condition from the generated fixtures.
     */
    const REFUSALS = [
      "this folder holds no usable .git: either there is none here, or the .git here points at a git directory that is not there",
      "this folder is a git repository, but none of its remotes names a repository on GitHub",
      "the launcher registry could not be opened",
      "the read did not complete: connection closed before a response arrived",
    ];

    for (const detail of REFUSALS) {
      teardown();

      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      mounted = { root, host };

      act(() => {
        root.render(
          <CacheStamp
            what="maps"
            provenance={{
              source: "cache",
              outcome: { kind: "failed", reason: { reason: "unreachable" }, detail },
              fetchedAt: "2026-08-05T08:00:00Z",
            }}
            now={1_785_916_800}
          />,
        );
      });

      const said = host.textContent ?? "";
      expect([detail, said]).toEqual([detail, expect.stringContaining(detail)]);
    }
  });

  it("prints the one command that fixes a token, and invents one for nothing else", async () => {
    await boot("/?map=auth-failed");

    // The whole reason the taxonomy exists: an operator watching a stamp age
    // assumes a flaky network, and the fix was one line all along. It is in the
    // document rather than behind a hover, and nothing had to be opened.
    expect(document.body.textContent).toContain("run gh auth login");

    await boot("/?map=unreachable");
    expect(document.body.textContent).not.toContain("gh auth login");
  });
});

describe("the map list is disabled in place when the poller has stopped reading", () => {
  /*
   * Mounted directly, because nothing has opened a folder in `dev:web` and the
   * list is not on screen until something does. `loadFixture` is given the same
   * `?map=` name the window would carry, so what is rendered is the condition
   * Rust generated rather than one written down here.
   */
  function renderMaps(
    fixture: FixtureName,
    onOpen: (number: number) => void = () => {},
    /*
     * A truncation is a condition of the read rather than of the map, so no
     * `?map=` name can put one on screen — the flags are the app crate's, and
     * `dev:web` has no app crate behind it. Overridden here rather than given a
     * hand-written second fixture, because the shape is already pinned from
     * Rust and a second account of it is the drift `maps.fixture.json` is
     * careful not to be.
     */
    over: Partial<MapsView> = {},
  ): Element {
    teardown();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted = { root, host };

    act(() => {
      root.render(
        <MapList
          view={{ ...loadFixture(1, `?map=${fixture}`), ...over }}
          selected={null}
          onOpen={onOpen}
        />,
      );
    });

    const section = host.querySelector('[aria-label="Maps"]');
    if (section === null) throw new Error("the map list did not render");
    return section;
  }

  it("keeps every row on screen and takes the affordance off each of them", () => {
    const listed = renderMaps("awkward-map");
    const rows = listed.querySelectorAll("li");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute("aria-disabled")).toBeNull();
    }

    const stopped = renderMaps("auth-failed");
    const disabled = stopped.querySelectorAll("li");

    // The same rows and the same count. Never hidden and never emptied: a list
    // that emptied itself would assert the maps are gone on the strength of not
    // having been able to look, and a missing row and a broken network must not
    // look identical.
    expect(disabled.length).toBe(rows.length);
    for (const row of disabled) {
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("data-disabled")).toBe("true");
    }
    expect(stopped.getAttribute("data-degraded")).toBe("authFailed");
  });

  it("tells a label list that ran long apart from a page that cannot exist", () => {
    /*
     * The one truncation that fails unsafe gets its own sentence, and the
     * sentence that says *GitHub's own limits say this cannot happen* is not
     * said about it — nothing caps how many labels an issue may carry. An
     * operator whose issue is merely well-labelled would otherwise be told an
     * impossibility had occurred, and told nothing about the consequence: a
     * ticket bound to another machine can be offered on this one while a label
     * that said so sits past the end of the page.
     */
    const ranLong = renderMaps("awkward-map", () => {}, { labelsTruncated: true });

    expect(ranLong.textContent).toContain(LABELS_TRUNCATED_NOTE);
    expect(ranLong.textContent).not.toContain(TRUNCATED_NOTE);
    expect(ranLong.querySelectorAll("[data-labels-truncated]")).toHaveLength(1);

    // And the two are independent conditions rather than two readings of one,
    // so an answer with both cut off draws both.
    const both = renderMaps("awkward-map", () => {}, {
      truncated: true,
      labelsTruncated: true,
    });

    expect(both.textContent).toContain(TRUNCATED_NOTE);
    expect(both.textContent).toContain(LABELS_TRUNCATED_NOTE);
  });

  it("prints the reason and the fixing command above the rows, as text", () => {
    const stopped = renderMaps("auth-failed");

    expect(stopped.textContent).toContain(CONDITIONS.authFailed);
    expect(stopped.textContent).toContain(STOPPED_COPY.authFailed);
    expect(stopped.textContent).toContain("run gh auth login");
    // Not an alert. The condition is a fact about what is on screen rather than
    // something to be dismissed.
    expect(stopped.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("says a map is gone in the words that send you to the folder rather than the network", () => {
    const gone = renderMaps("map-gone");

    expect(gone.getAttribute("data-degraded")).toBe("mapGone");
    expect(gone.textContent).toContain(STOPPED_COPY.mapGone);
    // No command, because there is none: a repository that is not there needs a
    // decision, and a remedy invented for it would be this app telling somebody
    // to do something nobody established would work.
    expect(gone.textContent).not.toContain("gh auth login");
  });

  it("leaves a row it cannot open as a button that does nothing, never as a row that went", () => {
    /*
     * The affordance goes, the row does not. A poller that has stopped reading
     * cannot fetch a graph either, so a row that still opened would declare a
     * map nothing is ever going to answer for — and a list that dropped the row
     * instead would assert the map is gone on the strength of not having been
     * able to look.
     */
    const opened: number[] = [];
    const stopped = renderMaps("auth-failed", (number) => opened.push(number));
    const button = stopped.querySelector("li button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("a row is not a button");

    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(opened).toEqual([]);

    // And the healthy list opens the map the row names, by its number.
    const listed = renderMaps("awkward-map", (number) => opened.push(number));
    const live = listed.querySelector("li button");
    if (!(live instanceof HTMLButtonElement)) throw new Error("a row is not a button");

    expect(live.disabled).toBe(false);
    act(() => live.click());
    expect(opened).toEqual([loadFixture(1, "?map=awkward-map").maps[0]?.number]);
  });

  it("leaves the rows alone for a condition that only delays the next read", () => {
    // A rate limit is a wait with an end on it. Rows disabled for one would come
    // back by themselves while somebody sat reading a reason to give up.
    for (const name of ["rate-limited", "unreachable"] as const) {
      const limited = renderMaps(name);

      expect([name, limited.getAttribute("data-degraded")]).toEqual([name, null]);
      for (const row of limited.querySelectorAll("li")) {
        expect([name, row.getAttribute("aria-disabled")]).toEqual([name, null]);
      }
    }
  });
});

describe("the stamp says the harness is yielding, and only while it is", () => {
  /*
   * Mounted directly rather than through `boot`, because the state this is
   * about cannot be reached from a browser: a poller is what decides the flag,
   * `dev:web` has none, and the map list there has never been read at all. What
   * is asserted is the rendered clause, which is the thing an operator sees.
   */
  function render(yielding: boolean): string {
    teardown();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted = { root, host };

    act(() => {
      root.render(
        <CacheStamp
          what="maps"
          provenance={{
            source: "github",
            outcome: { kind: "ok" },
            fetchedAt: "2026-08-05T08:00:00Z",
          }}
          now={1_785_916_800}
          yielding={yielding}
        />,
      );
    });

    return host.textContent ?? "";
  }

  it("gains the clause with the flag and loses it without", () => {
    expect(render(true)).toBe(
      "maps read from GitHub just now — paced against your rate limit",
    );
    expect(render(false)).toBe("maps read from GitHub just now");
  });

  it("never names a number or a time, because it describes the state and not the adjustment", () => {
    // #28 story 109. A clause carrying the interval would narrate every
    // adjustment of it, and the interval moves on every poll.
    const said = render(true);

    expect(said).not.toMatch(/\d+\s*(second|minute|hour)s?\b(?! ago)/);
    expect(said).not.toMatch(/\b\d{3,}\b/);
  });
});

describe("the compose offer is on screen from a fixture, and only on the rung that has it", () => {
  /*
   * #66's offer, end to end from a booted app with no Rust behind it.
   *
   * The rung it stands on is the one a browser has no way to walk to — every
   * ticket on a real map closed, and stopped there before a spec is attached —
   * so `spec-ready` exists for exactly this: without it the only state where
   * the button appears would be the only state nobody could look at, and the
   * word on the primary socket would be pinned in a unit test and drawn
   * nowhere. Its two neighbours are the same map one and two steps later, and
   * they are here because *gone afterwards* is half the claim.
   */
  const theStart = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[data-socket="start"]');
    if (found === null) throw new Error("no start socket in the document");
    return found;
  };

  it("reads Compose Spec on the spec-ready map, aimed at the map itself", async () => {
    await boot("/?map=spec-ready");
    const map = FIXTURES["spec-ready"].model.map;

    // The phase is the gate, and it is the fixture's own — nothing here
    // re-derives it from the counts.
    expect(map?.phase).toBe("specReady");
    expect(theStart().textContent).toContain(COMPOSE_LABEL);
    // Aimed at the map and not at a ticket: there is no takeable one left, and
    // the number on the button is the map's.
    expect(theStart().textContent).toContain(`#${map?.number}`);
  });

  it("reads Start Working again on the two rungs after it", async () => {
    for (const name of ["spec-composed", "map-closed"] as const) {
      await boot(`/?map=${name}`);
      expect([name, theStart().textContent?.includes(START_LABEL)]).toEqual([name, true]);
      expect([name, theStart().textContent?.includes(COMPOSE_LABEL)]).toEqual([name, false]);
    }
  });
});

describe("a wedged run is a state `dev:web` can be put into, and a browser cannot", () => {
  /*
   * The reason this parameter exists. A wedged AFK run wants five minutes of a
   * research run saying nothing and an `awaitingOperator` one wants a CLI
   * sitting on its own trust prompt — neither is a click, in this window or in
   * a real one, so without a fixture set the still-states this ticket is about
   * would be renderable only in a screenshot somebody took once.
   */

  /** The pane's chrome, which is where every fact about a stream is written. */
  function thePane(): string {
    return document.querySelector('[aria-label="Terminal"]')?.textContent ?? "";
  }

  it("boots the pane onto a run rather than onto nothing, with no Rust anywhere", async () => {
    await boot("/?map=awkward-map&runs=awaiting-operator");

    expect(hasRustBehindIt()).toBe(false);
    expect(thePane()).not.toContain("Nothing is running here yet.");
    expect(thePane()).toContain(AWAITING_OPERATOR_READING);
    expect(thePane()).toContain("in the terminal below");
  });

  it("renders every silence the type has a tag for", async () => {
    for (const [name, expected] of [
      ["quiet", `${QUIET_READING} · 62m`],
      ["awaiting-operator", AWAITING_OPERATOR_READING],
      ["unwatched", UNWATCHED_READING],
      // The two with nothing to add: the ending sentence beside them carries it.
      ["spent", "the ticket closed"],
      ["ended", "this run has ended (130)"],
    ] as const) {
      await boot(`/?map=awkward-map&runs=${name}`);
      expect([name, thePane().includes(expected)]).toEqual([name, true]);
    }
  });

  it("says nothing beside a run that is printing, which is the ordinary case", async () => {
    /*
     * The one fixture here that is not a state a browser struggles to reach,
     * and the one the other five are read against. A run streaming output has
     * no silence to report — Rust's floor answers `nothing`, which is a reading
     * and not an absence of data — so the chrome carries its signal and no
     * sentence at all. `quiet · 0s` re-rendered three times a second beside a
     * terminal that is visibly working is copy this app cannot produce.
     */
    await boot("/?map=awkward-map&runs=streaming");

    expect(thePane()).not.toContain("Nothing is running here yet.");
    expect(thePane()).not.toContain(QUIET_READING);
    expect(thePane()).toContain(SIGNAL_READINGS.busy);
  });

  it("renders a signal for every run a watch has classified, and none for the rest", async () => {
    await boot("/?map=awkward-map&runs=the-rack");

    // The rack's own runs carry `ready`, `busy`, `idle` and `null` between
    // them, so all four are a state this window can be opened onto — and the
    // one on the pane is the wedged one, which has never been classified.
    const signals = RUN_FIXTURES["the-rack"].map((readout) => readout.signal);
    expect(new Set(signals)).toEqual(new Set(["ready", "busy", "idle", null]));
    expect(thePane()).not.toContain(SIGNAL_READINGS.ready);
  });

  it("raises no modal and no toast with a wedged run on screen", async () => {
    /*
     * The trust prompt named in that sentence is the agent CLI's own, already
     * in the terminal. The house rule holds with the loudest reading this app
     * has on screen: a condition is a fact, and a modal is a thing that
     * interrupts you to be dismissed.
     */
    for (const name of RUN_FIXTURE_NAMES) {
      await boot(`/?map=awkward-map&runs=${name}`);

      for (const interrupting of [
        "[aria-live]",
        '[role="alert"]',
        '[role="status"]',
        '[role="dialog"]',
        '[role="alertdialog"]',
        "dialog",
      ]) {
        expect([name, interrupting, document.querySelectorAll(interrupting).length]).toEqual([
          name,
          interrupting,
          0,
        ]);
      }
    }
  });

  it("opens on nothing when nothing was asked for, which is what `?map=` alone means", async () => {
    await boot("/?map=awkward-map");

    expect(thePane()).toContain("Nothing is running here yet.");
  });
});

/**
 * The rack, in the window `dev:web` actually boots.
 *
 * The fixture behind it carries the states a browser cannot be clicked into: a
 * run that has just printed, one that has said nothing for minutes, one whose
 * terminal is a megabyte behind, one that has landed, and one the harness was
 * never told the stakes of. `tests/rack.test.tsx` is where the tiers and the row
 * model are pinned; this is the claim that the whole window draws them.
 */
describe("the rack lists every run beside the pane, from the fixture behind dev:web", () => {
  const theRack = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[aria-label="The rack"]');
    if (found === null) throw new Error("the window booted without a rack");
    return found;
  };

  it("draws one row per run, landed ones included", async () => {
    await boot("/?map=awkward-map&runs=rack");
    const rack = theRack();

    expect(rack.querySelectorAll("li")).toHaveLength(RUN_FIXTURES.rack.length);
    // A landing takes no row away: only `endRun` — a press — does that.
    expect(rack.querySelectorAll('[data-run][data-live="false"]')).toHaveLength(1);
    expect(rack.textContent).toContain(
      `${RUN_FIXTURES.rack.length - 1} of ${RUN_FIXTURES.rack.length} still running`,
    );
  });

  it("carries the kind, the waiting output and the silence on the row", async () => {
    await boot("/?map=awkward-map&runs=rack");
    const rack = theRack();

    expect(rack.textContent).toContain("research");
    expect(rack.textContent).toContain(NO_STAKES);
    // jsdom measures every box at zero, so this is the `studs` row — and the
    // narrow tiers say the silence and the waiting output in the characters a
    // 152px region has, rather than in the wide row's sentence.
    expect(rack.textContent).toContain("quiet 6m");
    expect(rack.textContent).toContain("2.1 KB");
    expect(rack.textContent).not.toContain("last printed");
    expect(rack.textContent).not.toContain("bytes unseen");
    expect(rack.textContent).toContain("landed");
  });

  it("moves one thing at most on the screen, however many of them are running", async () => {
    await boot("/?map=awkward-map&runs=rack");
    /*
     * Counted over the window and not over the rack's subtree, because the
     * criterion is one animated element *on screen*. Both licensed animations
     * carry `data-animated` — the Route's claimed ping and the rack's lamp — and
     * here the map side is drawing the Route over a fixture that stakes exactly
     * one claim, so the window's ration is already spent when the rack is asked.
     * The rack yields it: this is the state that animated two things at once
     * before the ration was arbitrated in `lampPings`.
     */
    expect(document.querySelectorAll('[data-animated="true"]')).toHaveLength(1);
    expect(theRack().querySelectorAll('[data-animated="true"]')).toHaveLength(0);
    /* And what it gives up is the movement, never the fact: the lamp is still
       lit and the count still says how many are going. */
    expect(theRack().querySelector("[data-lamp]")).not.toBeNull();
    expect(theRack().textContent).toContain("still running");
  });

  it("draws the narrow tier in a window nothing has laid out, rather than nothing", async () => {
    await boot("/?map=awkward-map&runs=rack");
    // jsdom measures every box at zero, which is the same reading as a first
    // paint. The rack answers `studs` — there is no tier that means gone.
    expect(theRack().getAttribute("data-tier")).toBe("studs");
    expect(theRack().querySelectorAll("li").length).toBeGreaterThan(0);
  });

  /**
   * The queue, from a fixture — the state a browser is furthest from reaching.
   *
   * A pending entry only exists once the research ceiling is met, which is four
   * agent CLIs and four worktrees away from anything `dev:web` can do, and the
   * refusal further still: it wants a deferred spawn that failed after the
   * press that ordered it had been answered.
   */
  it("draws a row for every waiting press, beside the runs and counted apart from them", async () => {
    await boot("/?map=awkward-map&runs=rack&pending=waiting");
    const rack = theRack();

    expect(rack.querySelectorAll("[data-pending]")).toHaveLength(
      PENDING_FIXTURES.waiting.length,
    );
    // The head's count is a count of runs, and a queue entry is not one: the
    // sentence is the same one the same runs draw with nothing waiting.
    expect(rack.textContent).toContain(
      `${RUN_FIXTURES.rack.length - 1} of ${RUN_FIXTURES.rack.length} still running`,
    );
    expect(rack.textContent).toContain("2 presses are waiting to start.");
    expect(rack.textContent).toContain(WAITING);

    /* And nothing of them anywhere else in the window. The rack is the only
       surface a queue entry is drawn on — it writes no model in Rust, so there
       is nothing on the graph for it to appear on here. */
    expect(document.querySelectorAll("[data-pending]")).toHaveLength(
      rack.querySelectorAll("[data-pending]").length,
    );
  });

  it("stands a deferred refusal on screen, and never as a waiting row", async () => {
    await boot("/?map=awkward-map&runs=rack&pending=refused");
    const rack = theRack();
    const announced = pendingFixtureNamed("refused");

    // The sentence crosses on one emission and is held on this side, because
    // nothing will ever send it again and no socket is left to print it on.
    expect(rack.textContent).toContain(refusalLine(refusalsOf(announced)[0]!));
    // A refused entry has left the queue: the rows are the waiting ones only.
    expect(rack.querySelectorAll("[data-pending]")).toHaveLength(
      waitingOf(announced).length,
    );
    expect(rack.textContent).toContain("1 press is waiting to start.");
  });

  it("draws no queue when none was asked for, which is what `?runs=` alone means", async () => {
    await boot("/?map=awkward-map&runs=rack");
    const rack = theRack();

    expect(rack.querySelectorAll("[data-pending]")).toHaveLength(0);
    expect(rack.textContent).not.toContain("waiting to start");
    // The runs are untouched by a channel that answered with nothing.
    expect(rack.querySelectorAll("[data-run]")).toHaveLength(RUN_FIXTURES.rack.length);
  });

  it("fills no rack at all when nothing was asked for, which is what `?map=` alone means", async () => {
    // The rack is chrome at a fixed address, so it is *there* either way — with
    // no runs behind it, it says so rather than disappearing.
    await boot("/?map=awkward-map");
    expect(theRack().querySelectorAll("li")).toHaveLength(0);
  });
});
