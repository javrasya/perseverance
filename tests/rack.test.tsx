// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowSeconds } from "../src/chrome/age";
import { Rack } from "../src/rack/Rack.jsx";
import {
  FIELDS,
  NO_STAKES,
  RACK_FLOOR,
  SHOWN,
  TIERS,
  TIER_FLOORS,
  droppedAt,
  droppedSentence,
  rowsFor,
  shows,
  tierFor,
  type Tier,
} from "../src/rack/rack";
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

async function draw(readouts: readonly RunReadout[]): Promise<Element> {
  teardown();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<Rack readouts={readouts} />);
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
    expect(studs.textContent).toContain("last printed");
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

    expect(surface.animations.map((animation) => animation.selector)).toEqual([".lampLive::after"]);
    expect(surface.keyframes.map((block) => block.name)).toEqual(["rackPing"]);
    // The ring underneath is what survives `prefers-reduced-motion`, the way
    // `.markClaimed` survives it on the Route.
    expect(stylesheet(RACK_CSS)).toContain(".lamp {");
    expect(stylesheet(RACK_CSS)).toContain("border-radius: 50%");
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
