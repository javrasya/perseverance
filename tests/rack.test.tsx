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
  droppedAt,
  droppedSentence,
  phraseAt,
  regionFor,
  rowsFor,
  shows,
  tierFor,
  type Tier,
} from "../src/rack/rack";
import { fractionOf, sides, type Detent } from "../src/panes/dial";
import { runFixtureNamed } from "../src/terminal/fixtures";
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
async function draw(readouts: readonly RunReadout[], elsewhere = false): Promise<Element> {
  teardown();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<Rack readouts={readouts} spentElsewhere={elsewhere} />);
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

    const rows = [...rack.querySelectorAll("li")];
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.getAttribute("data-live") === "false")).toHaveLength(1);
  });
});

describe("liveness is still-readable, and only one thing moves", () => {
  it("tells a live run from a landed one in words and in a class, with nothing moving", async () => {
    regionIs(500);
    const rack = await draw(await fixtureRuns());
    const rows = [...rack.querySelectorAll("li")];

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
