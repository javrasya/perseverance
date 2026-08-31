// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowSeconds, relativeAge, terseAge } from "../src/chrome/age";
import { Rack } from "../src/rack/Rack.jsx";
import {
  FIELDS,
  NO_STAKES,
  RACK_BASIS,
  RACK_FLOOR,
  RACK_RESERVE,
  SHOWN,
  TIERS,
  TIER_FLOORS,
  WAITING,
  droppedAt,
  droppedSentence,
  phraseAt,
  queuedPhraseAt,
  queuedRowsFor,
  REFUSALS_HELD,
  heldRefusals,
  refusalLine,
  waitingSentence,
  withoutRefusal,
  regionFor,
  rowsFor,
  shows,
  tierFor,
  type Tier,
} from "../src/rack/rack";
import {
  PENDING_FIXTURES,
  pendingFixtureNamed,
  refusalsOf,
  waitingOf,
  type PendingRun,
} from "../src/rack/pending";
import { fractionOf, sides, type Detent } from "../src/panes/dial";
import { runFixtureNamed } from "../src/terminal/fixtures";
import { keysGo } from "../src/keys/temperature";
import { currentState } from "../src/keys/router";
import { keyedRun, monitor, readUi, setKeyed } from "../src/stores/ui";
import { type RunReadout } from "../src/terminal/runs";
import { readMotion } from "./support/checks";
import { collectStylesheets } from "./support/sources";

/**
 * The rack, at three widths, with the two claims that are easiest to lose.
 *
 * The tier is a function of width and never of N: nothing about how many runs
 * there are, how long a row's words came out or whether any of them is live may
 * change which tier draws or how wide the region is. And the rack spends one
 * animation, on the rack rather than on a row, so that a landing is announced by
 * that ping ceasing rather than by anything starting.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const RACK_CSS = "src/rack/Rack.module.css";
const PANE_CSS = "src/terminal/Pane.module.css";

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

/** jsdom lays nothing out, so the one measurement the rack takes is stubbed. */
function regionIs(width: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * The rack, drawn. `elsewhere` is the shell's answer to *is the window's one
 * animation already being spent* — false unless a test is asking about the
 * ration itself, because every other test here is about width and words.
 */
async function draw(
  readouts: readonly RunReadout[],
  elsewhere = false,
  pending: readonly PendingRun[] = [],
  refusals: readonly PendingRun[] = [],
  onDismissRefusal: (id: number) => void = () => {},
): Promise<Element> {
  teardown();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(
      <Rack
        readouts={readouts}
        pending={pending}
        refusals={refusals}
        onDismissRefusal={onDismissRefusal}
        spentElsewhere={elsewhere}
      />,
    );
  });

  const rack = host.querySelector('[aria-label="The rack"]');
  if (rack === null) throw new Error("the rack did not render");
  return rack;
}

function teardown(): void {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
}

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

function stylesheet(path: string): string {
  const found = collectStylesheets().find((file) => file.path === path);
  if (found === undefined) throw new Error(`${path} is not there`);
  return found.text;
}

/** The fixture the `dev:web` path serves, which is every state worth drawing. */
async function fixtureRuns(): Promise<RunReadout[]> {
  return runFixtureNamed("rack");
}

describe("the tier is a function of width, and of nothing else", () => {
  it("reads one number, at every boundary", () => {
    const table: readonly [number, Tier][] = [
      [0, "studs"],
      [RACK_FLOOR, "studs"],
      [TIER_FLOORS.boards - 1, "studs"],
      [TIER_FLOORS.boards, "boards"],
      [TIER_FLOORS.bays - 1, "boards"],
      [TIER_FLOORS.bays, "bays"],
      [4000, "bays"],
    ];

    for (const [width, tier] of table) {
      expect(tierFor(width), `${width}px`).toBe(tier);
    }
  });

  it("answers the narrow rack for a box nobody has laid out, rather than nothing", () => {
    // A first paint, an unmeasured box and every jsdom test all read zero, and
    // the answer to all three has to be a rack rather than a disappearance.
    expect(tierFor(0)).toBe("studs");
    expect(tierFor(-40)).toBe("studs");
    expect(tierFor(Number.NaN)).toBe("studs");
    expect(TIERS).toContain(tierFor(Number.POSITIVE_INFINITY));
  });

  it("floors the region inside its own narrowest tier, so the floor is drawable", () => {
    expect(RACK_FLOOR).toBeGreaterThan(0);
    expect(RACK_FLOOR).toBeLessThan(TIER_FLOORS.boards);
  });

  it("draws one named tier at each detent, and glance is not the narrow one", () => {
    // The ruling in ADR 0025, in numbers. #56 asks for `studs` at `glance`, and
    // no function of width can give it: `glance` hands the *map* 0.3, so the
    // terminal side there is 70% — wider than at `split` — and a wider region
    // may never draw a narrower tier.
    const WINDOW = 1280;
    const REACH = 12;
    const table: readonly [Detent, Tier][] = [
      ["terminal", "bays"],
      ["glance", "bays"],
      ["split", "bays"],
      ["map", "studs"],
    ];

    for (const [detent, tier] of table) {
      const { terminal } = sides(fractionOf(detent), WINDOW, REACH);
      expect(tierFor(regionFor(terminal)), detent).toBe(tier);
    }

    // The two ends of the table said as widths rather than as names: three
    // detents leave the region more than its basis, and the fourth leaves it the
    // reserve exactly, which is the floor plus the terminal box's own padding.
    expect(regionFor(sides(fractionOf("split"), WINDOW, REACH).terminal)).toBe(RACK_BASIS);
    expect(sides(fractionOf("map"), WINDOW, REACH).terminal).toBe(RACK_RESERVE);
    expect(regionFor(RACK_RESERVE)).toBe(RACK_FLOOR);

    // Monotone, which is the invariant the ruling turns on: every wider terminal
    // side draws a tier at least as wide.
    let seen = 0;
    for (const detent of ["map", "split", "glance", "terminal"] as const) {
      const region = regionFor(sides(fractionOf(detent), WINDOW, REACH).terminal);
      expect(region, detent).toBeGreaterThanOrEqual(seen);
      seen = region;
    }

    // And `boards` is the drag tier and the small-window tier, not a detent's:
    // no press reaches it on a default window, and `split` reaches it on a
    // narrow one.
    expect(
      table.map(([detent]) => tierFor(regionFor(sides(fractionOf(detent), WINDOW, REACH).terminal))),
    ).not.toContain("boards");
    expect(tierFor(regionFor(sides(fractionOf("split"), 700, REACH).terminal))).toBe("boards");
  });

  it("draws the same tier for one run and for forty", async () => {
    regionIs(300);
    const runs = await fixtureRuns();

    const one = await draw(runs.slice(0, 1));
    expect(one.getAttribute("data-tier")).toBe("boards");

    const many = await draw(
      Array.from({ length: 40 }, (_, index) => ({ ...runs[index % runs.length]!, run: 500 + index })),
    );
    expect(many.getAttribute("data-tier")).toBe("boards");
    expect(many.querySelectorAll("li")).toHaveLength(40);
  });

  it("takes the region's width from a floor and a basis, never from its content", () => {
    const css = stylesheet(RACK_CSS);

    // The literal floor and the exported one are the same number: the tier is
    // chosen from a measurement in pixels and the stylesheet is what produces
    // that measurement, so the two spellings have to agree.
    expect(css).toContain(`--c-rack-floor: ${RACK_FLOOR}px`);
    expect(css).toContain("min-width: var(--c-rack-floor)");
    expect(css).toContain("flex: 0 1 var(--c-rack-basis)");
    // The basis is a preference rather than a measurement, so the stylesheet may
    // keep it in `rem` — at the root size nothing in this app overrides.
    expect(css).toContain(`--c-rack-basis: ${RACK_BASIS / 16}rem`);
    // And the pane's declaration, which is half of this claim: the region's
    // siblings share out the line's shrinkage in proportion to their bases, so a
    // pane left at the initial `0 1 auto` would put xterm's fitted width — or the
    // width of an empty pane's sentence — into the rack's width, and the tier
    // would have become a function of what the pane contains.
    expect(stylesheet(PANE_CSS)).toContain("flex: 1 1 0;");
    // `min-width: auto` is flexbox's content measurement, and it is exactly the
    // way a long run kind would come to widen the region.
    expect(css).not.toContain("min-width: auto");
    expect(css).not.toContain("width: max-content");
    expect(css).not.toContain("width: fit-content");
  });

  it("puts no width of its own on the region, so a row cannot move it", async () => {
    regionIs(500);
    const runs = await fixtureRuns();

    const rack = await draw(runs);
    expect(rack.getAttribute("style")).toBeNull();
    expect(rack.getAttribute("data-tier")).toBe("bays");

    // The same rack with a run gone and a run arrived, which is what the world
    // does to it: the tier and the region's own attributes are untouched.
    const churned = await draw([...runs.slice(1), { ...runs[0]!, run: 99 }]);
    expect(churned.getAttribute("style")).toBeNull();
    expect(churned.getAttribute("data-tier")).toBe("bays");
  });
});

describe("each tier prints what it dropped", () => {
  it("drops nothing at the full width, and says nothing about it", () => {
    expect(droppedAt("bays")).toEqual([]);
    expect(droppedSentence("bays")).toBeNull();
    expect(SHOWN.bays).toEqual(FIELDS);
  });

  it("names exactly the fields it is not drawing", () => {
    expect(droppedAt("boards")).toEqual(["age"]);
    expect(droppedSentence("boards")).toBe("Too narrow to show how long ago each run opened.");

    expect(droppedAt("studs")).toEqual(["ticket", "age"]);
    expect(droppedSentence("studs")).toBe(
      "Too narrow to show the ticket each run is staked on and how long ago each run opened.",
    );
  });

  it("keeps liveness, waiting output and silence at every width", () => {
    for (const tier of TIERS) {
      expect(shows(tier, "liveness"), tier).toBe(true);
      expect(shows(tier, "unseen"), tier).toBe(true);
      expect(shows(tier, "silence"), tier).toBe(true);
    }
  });

  it("puts the sentence on the screen as text rather than behind a hover", async () => {
    regionIs(200);
    const rack = await draw(await fixtureRuns());

    expect(rack.textContent).toContain(droppedSentence("studs"));
    // Rule 10: nothing load-bearing behind a `title`.
    expect(rack.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("renders exactly the fields the tier claims, and no dropped one in the tree", async () => {
    const runs = await fixtureRuns();

    regionIs(300);
    const boards = await draw(runs);
    expect(boards.textContent).toContain("#214");
    expect(boards.textContent).not.toContain("opened ");

    regionIs(180);
    const studs = await draw(runs);
    expect(studs.textContent).not.toContain("#214");
    expect(studs.textContent).not.toContain("opened ");
  });

  it("says the same facts in fewer characters where there is no room for them", async () => {
    const rows = rowsFor(await fixtureRuns(), nowSeconds());
    const noisy = rows.find((row) => row.run === 1)!;

    // The wide row spells both out; the narrow ones say the same two facts in
    // what a 152px region has room for. Not different facts, and not rounded
    // any further — a field that came out as an ellipsis would be `SHOWN`
    // claiming something the screen does not show.
    expect(phraseAt("bays", noisy, "unseen")).toBe("2,112 bytes unseen");
    expect(phraseAt("bays", noisy, "silence")).toBe("last printed just now");
    for (const tier of ["boards", "studs"] as const) {
      expect(phraseAt(tier, noisy, "unseen"), tier).toBe("2.1 KB");
      expect(phraseAt(tier, noisy, "silence"), tier).toBe("quiet <1m");
    }

    const behind = rows.find((row) => row.run === 3)!;
    expect(phraseAt("studs", behind, "unseen")).toBe("1.2 MB");
    expect(phraseAt("studs", rows.find((row) => row.run === 2)!, "unseen")).toBe("0 B");
    expect(phraseAt("studs", rows.find((row) => row.run === 4)!, "silence")).toBe("quiet 1h");

    // Never longer than the seven characters the narrowest row was measured for.
    for (const row of rows) {
      expect(row.unseenBrief.length, row.unseenBrief).toBeLessThanOrEqual(8);
      expect(row.silenceBrief.length, row.silenceBrief).toBeLessThanOrEqual(10);
    }
  });

  it("keeps the terse ladder on the same rungs as the wide one", () => {
    // Two spellings of a duration, and a rack draws one tier at a time so no
    // screen carries both. What would make them two *answers* rather than two
    // spellings is a boundary that moved — `6m` against `an hour ago`.
    const now = nowSeconds();
    const ago = (seconds: number) =>
      [relativeAge(now - seconds, now), terseAge(now - seconds, now)] as const;

    expect(ago(30)).toEqual(["just now", "<1m"]);
    expect(ago(6 * 60)).toEqual(["6 minutes ago", "6m"]);
    expect(ago(2 * 60 * 60)).toEqual(["2 hours ago", "2h"]);
    expect(ago(3 * 24 * 60 * 60)).toEqual(["3 days ago", "3d"]);
    expect(ago(21 * 24 * 60 * 60)).toEqual(["3 weeks ago", "3w"]);
    expect(ago(300 * 24 * 60 * 60)).toEqual(["10 months ago", "10mo"]);
    expect(ago(800 * 24 * 60 * 60)).toEqual(["2 years ago", "2y"]);
  });

  it("draws nothing for a field the tier dropped, or for a ticket a run has none of", async () => {
    const rows = rowsFor(await fixtureRuns(), nowSeconds());
    const unstaked = rows.find((row) => row.run === 5)!;

    for (const field of FIELDS) {
      for (const tier of TIERS) {
        if (!shows(tier, field)) expect(phraseAt(tier, unstaked, field), field).toBeNull();
      }
    }
    expect(phraseAt("boards", unstaked, "ticket")).toBeNull();
    expect(phraseAt("boards", rows.find((row) => row.run === 1)!, "ticket")).toBe("#214");
  });
});

describe("a row says what a run is, how old, how far behind and how quiet", () => {
  it("reads every state the fixture carries", async () => {
    const runs = await fixtureRuns();
    const rows = rowsFor(runs, nowSeconds());
    const of = (run: number) => rows.find((row) => row.run === run)!;

    const noisy = of(1);
    expect(noisy.kind).toBe("work");
    expect(noisy.ticket).toBe("#214");
    expect(noisy.age).toBe("3 hours ago");
    expect(noisy.silence).toBe("just now");
    // Unseen output is derived — `end - through` — and is never a field.
    expect(noisy.unseenBytes).toBe(2112);
    expect(noisy.unseen).toBe(`${(2112).toLocaleString()} bytes unseen`);
    expect(noisy.liveness).toBe("live");

    const quiet = of(2);
    expect(quiet.kind).toBe("research");
    expect(quiet.silence).toBe("6 minutes ago");
    expect(quiet.unseen).toBe("nothing unseen");

    const behind = of(3);
    expect(behind.kind).toBe("charting");
    expect(behind.ticket).toBeNull();
    expect(behind.unseenBytes).toBe(1_204_880);

    const landed = of(4);
    expect(landed.live).toBe(false);
    expect(landed.liveness).toBe("landed");
    expect(landed.silence).toBe("1 hour ago");

    const unstaked = of(5);
    expect(unstaked.kind).toBe(NO_STAKES);
    expect(unstaked.ticket).toBeNull();
    expect(unstaked.unseenBytes).toBe(640);

    expect(of(6).kind).toBe("composing");
  });

  it("keeps the runs in the order they were opened, whatever they are doing", async () => {
    const runs = await fixtureRuns();
    expect(rowsFor(runs, nowSeconds()).map((row) => row.run)).toEqual(runs.map((run) => run.run));
  });

  it("holds a landed run in the rack rather than taking its row away", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns());

    const rows = [...rack.querySelectorAll("[data-run]")];
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.getAttribute("data-live") === "false")).toHaveLength(1);
  });
});

describe("liveness is still-readable, and only one thing moves", () => {
  it("tells a live run from a landed one in words and in a class, with nothing moving", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    const rows = [...rack.querySelectorAll("[data-run]")];

    const live = rows.find((row) => row.getAttribute("data-live") === "true")!;
    const landed = rows.find((row) => row.getAttribute("data-live") === "false")!;

    expect(live.textContent).toContain("live");
    expect(landed.textContent).toContain("landed");
    expect(live.className).not.toBe(landed.className);
    // Rule 12: whatever the media query kills, no row was relying on it.
    expect(live.hasAttribute("data-animated")).toBe(false);
    expect(landed.hasAttribute("data-animated")).toBe(false);
  });

  it("spends one animation in the stylesheet, on one selector, over a still ring", () => {
    const surface = readMotion(stylesheet(RACK_CSS));

    expect(surface.animations.map((animation) => animation.selector)).toEqual([".lampPing::after"]);
    expect(surface.keyframes.map((block) => block.name)).toEqual(["rackPing"]);
    // The ring underneath is what survives `prefers-reduced-motion`, the way
    // `.markClaimed` survives it on the Route — and it is a class of its own, so
    // a lamp whose ping is suppressed still says the run is going.
    expect(stylesheet(RACK_CSS)).toContain(".lamp {");
    expect(stylesheet(RACK_CSS)).toContain("border-radius: 50%");
    expect(stylesheet(RACK_CSS)).toContain(".lampLive {");
  });

  it("yields the ration when the screen is already spending it, and keeps the fact", async () => {
    regionIs(500);
    const runs = await fixtureRuns();
    expect(runs.filter((run) => !run.over).length).toBeGreaterThan(1);

    const yielding = await draw(runs, true);

    // Nothing moves here while the Route's claimed ping is on screen — the
    // criterion is one animated element on the *screen*, not one per subtree.
    expect(yielding.querySelectorAll('[data-animated="true"]')).toHaveLength(0);
    // What a suppressed ping costs is the motion and never the fact: the lamp is
    // still lit, and the count still says how many are going.
    const yielded = yielding.querySelector("[data-lamp]");
    expect(yielded).not.toBeNull();
    expect(yielding.textContent).toContain("still running");

    // And it is the same lamp, differently classed, rather than a second one.
    const spending = await draw(runs, false);
    expect(spending.querySelectorAll("[data-lamp]")).toHaveLength(1);
    expect(spending.querySelectorAll('[data-animated="true"]')).toHaveLength(1);
    expect(yielded!.className).not.toBe(spending.querySelector("[data-lamp]")!.className);
  });

  it("carries at most one animated element, however many runs are live", async () => {
    regionIs(500);
    const runs = await fixtureRuns();
    expect(runs.filter((run) => !run.over).length).toBeGreaterThan(1);

    const rack = await draw(runs);
    expect(rack.querySelectorAll('[data-animated="true"]')).toHaveLength(1);

    const crowded = await draw(
      Array.from({ length: 12 }, (_, index) => ({ ...runs[0]!, run: 800 + index })),
    );
    expect(crowded.querySelectorAll('[data-animated="true"]')).toHaveLength(1);
  });

  it("announces the landing by the ping ceasing, and never by an onset", async () => {
    regionIs(500);
    const runs = await fixtureRuns();

    const landing = runs.map((run) => ({ ...run, over: true }));
    const rack = await draw(landing);

    expect(rack.querySelectorAll('[data-animated="true"]')).toHaveLength(0);
    // What is left is the still form: every row still there, every one landed.
    expect(rack.querySelectorAll("li")).toHaveLength(runs.length);
    expect(rack.textContent).toContain("0 of 6 still running");
  });
});

describe("the rack is the patchbay's selector, and the keys do not follow", () => {
  // Inside `act`: this runs while the rack is still mounted, and it is a store
  // change the rack renders for.
  afterEach(() => {
    act(() => monitor(null));
  });

  /** Every row, as the thing that is pressed: the row *is* the button. */
  const pressable = (rack: Element) => [...rack.querySelectorAll("[data-run]")] as HTMLElement[];

  /* The press tells the harness before it moves the store, so the store's change
     lands a microtask after the click and has to be settled inside `act`. */
  async function press(row: HTMLElement): Promise<void> {
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
  }

  it("puts the run it names on the monitor", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    const row = pressable(rack)[2]!;

    await press(row);

    expect(readUi().monitored).toBe(Number(row.dataset.run));
  });

  it("leaves the keys where they were rather than taking them to the run it patched", async () => {
    /*
     * The acceptance criterion in one press: *select which run the terminal
     * shows without moving your keyboard to it*. The run was warm, another row
     * was pressed, and the readout has to be able to say so — a rack that
     * focused the terminal would leave the key line pointing at a conversation
     * nobody chose to type into.
     */
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    const [first, second] = pressable(rack);

    await act(async () => {
      monitor(Number(first!.dataset.run));
      setKeyed(true);
    });
    expect(keyedRun(readUi())).toBe(Number(first!.dataset.run));

    await press(second!);

    expect(readUi().monitored).toBe(Number(second!.dataset.run));
    expect(keyedRun(readUi())).toBeNull();
    expect(keysGo(currentState())).toBe("the map");
  });

  it("patches the monitor onto a run that has already exited", async () => {
    /* A landed run keeps its row, and reading the crash on the monitor is what
       the row is for. `monitor` cools, so this cannot land the caret in a dead
       child. */
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    const landed = pressable(rack).find((row) => row.dataset.live === "false")!;

    await press(landed);

    expect(readUi().monitored).toBe(Number(landed.dataset.run));
    expect(keyedRun(readUi())).toBeNull();
  });

  it("marks the row that is on the monitor, in form and not in colour alone", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    /* A live row on purpose: the fixture holds one landed run, and a mark
       compared against a row of the other liveness would be comparing two
       classes that already differ. */
    const chosen = pressable(rack).find((row) => row.dataset.live === "true")!;

    await press(chosen);

    const marked = pressable(rack).filter((row) => row.dataset.monitored === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.dataset.run).toBe(chosen.dataset.run);
    expect(marked[0]!.getAttribute("aria-current")).toBe("true");

    const other = pressable(rack).find(
      (row) => row.dataset.monitored !== "true" && row.dataset.live === marked[0]!.dataset.live,
    )!;
    expect(marked[0]!.className).not.toBe(other.className);

    /* The mark is a ring and not a tint, it is not hidden behind a hover, and
       it does not move: the screen's one animation is the lamp. */
    const css = stylesheet(RACK_CSS);
    const rule = css.slice(css.indexOf(".rowPatched"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("outline");
    expect(css).not.toContain(".rowPatched:hover");
    expect(rack.querySelectorAll("[data-animated]")).toHaveLength(
      rack.querySelectorAll("[data-lamp][data-animated]").length,
    );
  });

  it("reads the mark off the store rather than off Rust's own account", async () => {
    /* `RunReadout.monitored` lags the press by a poll tick and the `dev:web`
       fixtures never set it, so a mark taken from there would be a mark the
       operator's own press could not move. */
    regionIs(500);
    const runs = (await fixtureRuns()).map((run) => ({ ...run, monitored: true }));
    const rack = await draw(runs);

    await act(async () => {
      monitor(runs[1]!.run);
    });

    const marked = pressable(rack).filter((row) => row.dataset.monitored === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.dataset.run).toBe(String(runs[1]!.run));
  });

  it("changes neither the tier nor the region's width when a row is pressed", async () => {
    // The rack changes width on a press against the dial and on nothing else.
    regionIs(TIER_FLOORS.boards);
    const rack = await draw(await fixtureRuns());
    const before = rack.getAttribute("data-tier");

    await press(pressable(rack)[1]!);

    expect(rack.getAttribute("data-tier")).toBe(before);
    expect([...rack.querySelectorAll("[data-field]")].length).toBeGreaterThan(0);
  });
});

/**
 * The research queue, drawn in the one place it is drawn at all.
 *
 * A pending entry is an accepted press with no run behind it: no run number, no
 * worktree, no claim, no PTY and no bytes. Everything below is a consequence of
 * that absence — it is not counted as live, it does not light the lamp, it is
 * not pressable onto the monitor, and the two fields that are about a stream
 * are not claimed rather than drawn as zero.
 */
describe("the rack draws what has not started, and a queue entry is not a run", () => {
  const waiting = (): PendingRun[] => pendingFixtureNamed("waiting");

  /** The queue's rows, which carry the entry's own id and never a run's. */
  const queueRows = (rack: Element) => [...rack.querySelectorAll("[data-pending]")];

  it("mirrors the six fields Rust writes, and no seventh", () => {
    /*
     * `PendingRun` lives in `crates/app` rather than in the model crate, so
     * nothing generates this type and no build fails when the two drift. The
     * Rust half of the pin is `a_press_at_the_ceiling_is_queued_rather_than_refused`,
     * which asserts the same names and that the object has six keys; this is
     * the other half, over the fixture the `dev:web` path serves as that shape.
     */
    const entry = waiting()[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      ["folder", "id", "kind", "queued", "refused", "ticket"].sort(),
    );
    // Every waiting row carries no refusal — a refused entry is not waiting.
    expect(waiting().every((one) => one.refused === null)).toBe(true);
    expect(waitingOf(pendingFixtureNamed("refused"))).toHaveLength(1);
    expect(refusalsOf(pendingFixtureNamed("refused"))).toHaveLength(1);
    expect(refusalsOf(waiting())).toEqual([]);
  });

  it("draws a row for every waiting press, after the runs and in press order", async () => {
    regionIs(500);
    const runs = await fixtureRuns();
    const rack = await draw(runs, false, waiting());

    const rows = [...rack.querySelectorAll("li")];
    expect(rows).toHaveLength(runs.length + PENDING_FIXTURES.waiting.length);
    // The queue is the tail of the rack, never interleaved with the runs.
    expect(rows.slice(runs.length).every((row) => row.querySelector("[data-pending]"))).toBe(
      true,
    );

    /* Press order and no sort, for `rowsFor`'s reason and one of its own: the
       entry at the top is the one the next landing starts, so the position is
       the meaning. */
    expect(queueRows(rack).map((row) => row.getAttribute("data-pending"))).toEqual([
      String(waiting()[0]!.id),
      String(waiting()[1]!.id),
    ]);
    expect(rack.textContent).toContain("#61");
    expect(rack.textContent).toContain("#62");
  });

  it("keys the queue apart from the runs, because the two ids are two spaces", async () => {
    regionIs(500);
    /* A run numbered the same as a waiting entry, which is not a coincidence to
       be waited for: entry ids start at one and so do run numbers. An unprefixed
       key would have React reuse one row's state for the other, silently. */
    const runs = (await fixtureRuns()).map((run, index) => ({ ...run, run: index + 1 }));
    const rack = await draw(runs, false, waiting());

    expect(rack.querySelectorAll("[data-run]")).toHaveLength(runs.length);
    expect(queueRows(rack)).toHaveLength(2);
    // No queue row is a run row and no run row is a queue row.
    expect(rack.querySelectorAll("[data-run][data-pending]")).toHaveLength(0);
  });

  it("counts nothing waiting among the runs, and lights nothing for it", async () => {
    regionIs(500);
    const runs = await fixtureRuns();

    const without = await draw(runs);
    const said = without.querySelector("[data-lamp]")?.parentElement?.textContent;
    const withQueue = await draw(runs, false, waiting());

    /* `N of M still running` counts runs. A queue entry is neither N nor M: it
       has no run to be running, and folding it in would assert two runs that do
       not exist. */
    expect(withQueue.querySelector("[data-lamp]")?.parentElement?.textContent).toBe(said);
    expect(said).toContain(`of ${runs.length} still running`);

    // And nothing waiting is liveness to spend the window's one animation on.
    const idle = await draw([], false, waiting());
    expect(idle.textContent).toContain("no runs");
    expect(idle.querySelectorAll('[data-animated="true"]')).toHaveLength(0);
    expect(idle.querySelector("[data-lamp]")?.className).not.toContain("Live");
  });

  it("says what is waiting in its own sentence rather than in the head's count", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns(), false, waiting());

    expect(rack.textContent).toContain("2 presses are waiting to start.");
    // Singular and absent, which is the whole of the function beside the plural.
    expect(waitingSentence(1)).toBe("1 press is waiting to start.");
    expect(waitingSentence(0)).toBeNull();
    // The sentence is text in the flow and never a tooltip (rule 10).
    expect(rack.querySelector("[title]")).toBeNull();
  });

  it("is not a patchbay source: nothing to press, and no run to press it onto", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns(), false, waiting());
    const row = queueRows(rack)[0]!;

    /*
     * The defect this forbids is putting the monitor on a run that does not
     * exist. A queue entry has no run number at all, so a pressable row here
     * would have to invent one or leave the monitor where it was while marking
     * this row as what the terminal is showing.
     */
    expect(row.tagName).not.toBe("BUTTON");
    expect(row.closest("button")).toBeNull();
    expect(row.getAttribute("data-run")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(row.getAttribute("aria-current")).toBeNull();
  });

  it("draws no zero for the absences a queue entry has", async () => {
    regionIs(500);
    const rack = await draw([], false, waiting());
    const fields = [...queueRows(rack)[0]!.querySelectorAll("[data-field]")].map((span) =>
      span.getAttribute("data-field"),
    );

    /*
     * Rule 4: absence is never zero. There is no stream behind a waiting entry,
     * so `0 B` and `quiet 0m` would render an absence as a number — and as a
     * number an operator reads as *this run has printed nothing yet* about
     * something that was never spawned. The fields are not claimed instead.
     */
    expect(fields).not.toContain("unseen");
    expect(fields).not.toContain("silence");
    expect(rack.textContent).not.toContain("0 B");
    expect(rack.textContent).not.toContain("quiet 0m");
    expect(rack.textContent).not.toContain("nothing unseen");

    // What it does say is what it is, at every tier, in a word beside the runs'.
    expect(rack.textContent).toContain(WAITING);
    for (const tier of TIERS) {
      const row = queuedRowsFor(waiting(), nowSeconds())[0]!;
      expect(queuedPhraseAt(tier, row, "unseen")).toBeNull();
      expect(queuedPhraseAt(tier, row, "silence")).toBeNull();
      expect(queuedPhraseAt(tier, row, "liveness")).toBe(WAITING);
      // And never a field the tier dropped: `SHOWN` is one table, not two.
      for (const field of droppedAt(tier)) expect(queuedPhraseAt(tier, row, field)).toBeNull();
    }
  });

  it("changes neither the tier nor the region's width when a queue arrives", async () => {
    regionIs(TIER_FLOORS.boards);
    const runs = await fixtureRuns();

    const before = await draw(runs);
    expect(before.getAttribute("data-tier")).toBe("boards");

    // The tier is a function of width and never of N — of runs or of anything
    // else in the rack. A queue is the newest way to have got that wrong.
    const after = await draw(runs, false, waiting());
    expect(after.getAttribute("data-tier")).toBe("boards");
    expect(after.getAttribute("style")).toBeNull();
    /* And the sentence is still derived from `SHOWN`, so a tier cannot come to
       describe a rack that is drawing a queue it never mentions. */
    expect(after.textContent).toContain(droppedSentence(tierFor(TIER_FLOORS.boards)));
  });

  it("prints a deferred refusal as a sentence, and never as a waiting row", async () => {
    regionIs(500);
    const announced = pendingFixtureNamed("refused");
    const rack = await draw([], false, waitingOf(announced), refusalsOf(announced));

    const refusal = refusalsOf(announced)[0]!;
    expect(rack.textContent).toContain(refusalLine(refusal));
    expect(rack.textContent).toContain(String(refusal.refused));
    expect(rack.textContent).toContain(refusal.folder);

    /* A refused entry has left the queue: a row for it would be an entry that
       never drains, and the count beside it would be wrong by one forever. */
    expect(queueRows(rack)).toHaveLength(1);
    expect(queueRows(rack)[0]!.getAttribute("data-pending")).toBe(String(waitingOf(announced)[0]!.id));
    expect(rack.textContent).toContain("1 press is waiting to start.");
  });

  /*
   * The refusal list, as the one thing on this surface that is *held* rather
   * than redrawn from a tick.
   *
   * Two failure modes and they pull opposite ways: dropped silently, and the
   * operator never hears about a spawn that failed after its press was
   * answered; held forever, and a flush of a full queue takes the whole region
   * — `.rows` is the flex child that gives and the rack clips its overflow, so
   * the live rows are squeezed to nothing and the dock is clipped out. So it is
   * bounded, dismissable by hand, and drawn in a box that shrinks and scrolls.
   */
  const refusal = (id: number): PendingRun => ({
    id,
    ticket: 100 + id,
    kind: "research",
    folder: "/work/perseverance",
    queued: nowSeconds() - 60,
    refused: "no token is stored for this host",
  });

  it("holds the newest refusals up to its bound, and never grows past it", () => {
    const many = Array.from({ length: REFUSALS_HELD + 3 }, (_, at) => refusal(at + 1));

    /* One at a time, which is how they actually arrive: a tick announces what
       refused on that tick and the shell adds it to what it is holding. */
    let held: readonly PendingRun[] = [];
    for (const one of many) held = heldRefusals(held, [one]);

    expect(held).toHaveLength(REFUSALS_HELD);
    /* The oldest go, and the newest — the ones nobody has read yet — stay. */
    expect(held.map((one) => one.id)).toEqual(many.slice(-REFUSALS_HELD).map((one) => one.id));

    // And a single flush bigger than the bound is bounded the same way.
    expect(heldRefusals([], many).map((one) => one.id)).toEqual(
      many.slice(-REFUSALS_HELD).map((one) => one.id),
    );
  });

  it("prints the same failure once, and re-renders nothing when a tick says nothing new", () => {
    const held = heldRefusals([], [refusal(1), refusal(2)]);
    expect(heldRefusals(held, [refusal(2)])).toBe(held);
    expect(heldRefusals(held, [refusal(2), refusal(3)]).map((one) => one.id)).toEqual([1, 2, 3]);
  });

  it("offers a dismissal on each held refusal, and it takes away that one alone", async () => {
    regionIs(500);
    const held = [refusal(1), refusal(2)];
    const dismissed: number[] = [];
    const rack = await draw([], false, [], held, (id) => dismissed.push(id));

    const controls = [...rack.querySelectorAll("[data-dismiss]")] as HTMLElement[];
    expect(controls).toHaveLength(held.length);
    /* A word in the flow rather than a glyph behind hover: rule 10 keeps a
       control an operator needs off a pointer-only affordance. */
    expect(controls[0]!.textContent).toBe("dismiss");

    await act(async () => {
      controls[1]!.click();
      await Promise.resolve();
    });
    expect(dismissed).toEqual([held[1]!.id]);

    /* The list is the shell's, so the rack asked and edited nothing — and what
       the shell does with the id takes away that entry and no other. */
    expect([...rack.querySelectorAll("[data-dismiss]")]).toHaveLength(held.length);
    expect(withoutRefusal(held, held[1]!.id).map((one) => one.id)).toEqual([held[0]!.id]);
  });

  it("draws the refusals in a box that shrinks and scrolls rather than one that pushes", () => {
    const css = stylesheet(RACK_CSS);
    const refusals = /\.refusals \{([^}]*)\}/.exec(css)?.[1] ?? "";

    /* `.rows` is `flex: 1; min-height: 0` and `.rack` is `overflow: hidden`, so
       a refusal list without a shrink and a scroll of its own takes its full
       content height out of the rows and the dock. */
    expect(refusals).toContain("flex: 0 1 auto;");
    expect(refusals).toContain("min-height: 0;");
    expect(refusals).toContain("overflow-y: auto;");
    // A folder path still has nowhere to break, and still has to wrap.
    expect(refusals).toContain("overflow-wrap: anywhere;");

    // And the dismissal moves nothing: the window's one animation is the lamp.
    const dismiss = /\.dismiss \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(dismiss).not.toContain("animation");
    expect(dismiss).not.toContain("transition");
    expect(readMotion(css).animations.map((one) => one.selector)).toEqual([".lampPing::after"]);
  });

  it("spends no motion and no colour of its own on the queue", async () => {
    const css = stylesheet(RACK_CSS);

    /*
     * Rule 12 and rule 3 together. The window's ration is one animated element
     * and `lampPings` already arbitrates it, so a queue entry may not animate;
     * and *waiting* has to be readable from *live* with the palette taken away,
     * which is what the dashed rule and the word on the row are for.
     */
    expect(css).toContain("dashed");
    const waitingRule = /\.rowWaiting \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(waitingRule).not.toContain("animation");
    expect(waitingRule).not.toContain("transition");
    /* The stylesheet still animates one selector and it is still the lamp's:
       the queue added no second one. */
    expect(readMotion(css).animations.map((one) => one.selector)).toEqual([".lampPing::after"]);

    // No hue-only distinction, and nothing behind hover (rule 10).
    expect(css).not.toContain(".rowWaiting:hover");
  });
});
