import { describe, expect, it } from "vitest";
import {
  findMotionViolations,
  findReducedMotionViolations,
  findStrayMotion,
  format,
  readMotion,
  transitionedProperties,
  type LicensedMotion,
} from "./support/checks";
import { lampPings } from "../src/rack/rack";
import type { Map, Node } from "../src/snapshot/model.generated";
import { pingOf, routeOf } from "../src/views/route/route";
import { collectMarkupAndStyles, collectStylesheets } from "./support/sources";

/** The one file allowed to say what reduced motion means here. */
const GUARD_PATH = "src/styles/global.css";

const ROUTE_PATH = "src/views/route/Route.module.css";
const RACK_PATH = "src/rack/Rack.module.css";

/**
 * The whole of the motion this app is allowed to spend, and the claim each
 * spend carries.
 *
 * Rule 9 rations motion to running-vs-stale, and on this side of the seam
 * there is no running-vs-stale bit to spend it on: `NodeState` is
 * `resolved | blocked | claimed | takeable` and nothing in the snapshot says
 * whether work is in flight. `claimed` is as close as this half of the app
 * comes to liveness, and it is a real instance of it rather than a stand-in:
 * of the four states it is the only one that is *in progress* — somebody has
 * the ticket in their hands right now — while the other three are settled
 * facts about the graph. The ration is spent telling that one apart from the
 * three that are not moving, and it is spent nowhere else.
 *
 * Rule 9's tier is asserted, so that settlement had to be made rather than
 * deferred: there is no deviation route and no declaration slot, and an
 * animation is therefore either licensed here with its claim written down or
 * it comes out of the stylesheet.
 *
 * The list is meant to stay hard to grow. A new animation, or one of these
 * moving to a selector carrying no such claim, is a red test whose fix is an
 * argument in this comment — never a line added to this array by reflex.
 *
 * The second entry is the rack's, and it is the *other* half of rule 9's
 * ration: the Route's `claimed` is as close to liveness as the snapshot gets,
 * while a run readout carries the real thing — a child process that is either
 * printing or has stopped. It is licensed on four conditions, and the first
 * three are held to by `tests/rack.test.tsx`. It is spent **once for the whole
 * rack** rather than once per row, because four live runs pinging at once is
 * ambient motion however defensible each ping is on its own. It is authored over
 * a still ring that survives `prefers-reduced-motion`, the way `.markClaimed`
 * is. And it moves in one direction only: a landing takes motion away — the lamp
 * stops when the last live run lands — so nothing in that surface ever starts
 * moving because something ended.
 *
 * The fourth is why this list is two entries and still means *one animated
 * element*, and it is held to below. **The two licences are never spent at the
 * same time**: #56 rations motion by the screen and not by a subtree, and the
 * Route's halo and the rack's lamp are both drawn at `split`, at `glance` and at
 * `map` with a map open. So the rack yields — `lampPings` is the arbitration,
 * `src/App.tsx` is the only box that can see both surfaces and is what answers
 * it, and each animated element carries `data-animated` so the count is a query
 * over the document rather than a reading of two stylesheets.
 *
 * And each licence is one element rather than one per thing it is about. The
 * rack spends its lamp once for the whole rack; the Route draws its halo on the
 * row `pingOf` names and on no other, so a map staking three claims animates one
 * mark and keeps the disc, the ring and the `Now` heading on the other two. That
 * is what makes *at most one* a fact about the delivered window rather than a
 * fact about the fixtures that happen to stake exactly one claim.
 *
 * The arbitration itself moves on presses only: `elsewhere` is *the map side is
 * drawn*, read off which view is open and how the dial is set, never off whether
 * the graph holds a claim. A claim landing on GitHub may therefore neither start
 * this lamp nor stop it — the thing #56 forbids in as many words — and the price
 * is a licence held unspent while the Route is up with nothing claimed on it.
 * Zero animated elements is inside the ration; a lamp that starts because a
 * ticket resolved is not. What the rack gives up is the movement and never the
 * fact, which the lit ring and `N of M still running` keep.
 */
const LICENSED_MOTION: readonly LicensedMotion[] = [
  {
    path: ROUTE_PATH,
    selector: ".markPing::after",
    keyframes: "ping",
    carries:
      "claimed — the one node state that is in progress rather than settled, and the only liveness this side of the seam can carry — drawn once for the pane by `pingOf` and never once per claimed row, over a still ring on `.markClaimed::after` that every claim keeps",
  },
  {
    path: RACK_PATH,
    selector: ".lampPing::after",
    keyframes: "rackPing",
    carries:
      "anything in the rack is still running *and* the screen's one animation is not already spent on the Route — one lamp for the whole rack rather than one per row, and its ceasing is how the last landing is announced",
  },
];

/**
 * The two licences above, and which of them may be spent at once.
 *
 * The ration is *at most one animated element on screen*, so a list of two
 * licences is only sound if something decides between them. That decision is
 * [`lampPings`], and this is where it is enforced rather than described: the
 * table below is the whole of the arbitration, over the two facts it reads.
 */
const RATION = [
  { live: 0, elsewhere: false, pings: false },
  { live: 0, elsewhere: true, pings: false },
  { live: 1, elsewhere: false, pings: true },
  { live: 1, elsewhere: true, pings: false },
  { live: 6, elsewhere: false, pings: true },
  { live: 6, elsewhere: true, pings: false },
] as const;

const ROUTE_MOTION = `
.markClaimed::after {
  content: "";
  border: 1.5px solid var(--c-node-glyph);
  opacity: 0.5;
}

.markPing::after {
  animation: ping 2.1s var(--s-motion-ease) infinite;
}

@keyframes ping {
  0% { opacity: 0.7; transform: scale(0.7); }
  70%, 100% { opacity: 0; transform: scale(1.25); }
}
`;

const GUARD = `
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition-property: opacity, color, background-color, border-color, fill,
      stroke !important;
  }
}
`;

describe("motion is rationed, and the ration is enumerable over the stylesheets", () => {
  it("reads the selector an animation is written on, and the keyframes it drives", () => {
    const surface = readMotion(ROUTE_MOTION);

    expect(surface.animations.map((animation) => animation.selector)).toEqual([
      ".markPing::after",
    ]);
    expect(surface.animations[0]!.names).toEqual(["ping"]);
    expect(surface.keyframes.map((block) => block.name)).toEqual(["ping"]);
  });

  it("counts no transition: a crossfade is not motion spent", () => {
    const surface = readMotion(`
      .row {
        transition-property: color, background-color, border-color, opacity;
        transition-duration: var(--s-motion-fast);
      }
    `);

    expect(surface.animations).toEqual([]);
    expect(surface.keyframes).toEqual([]);
  });

  it("the check catches each way motion leaves the ration", () => {
    const elsewhere = (text: string) =>
      findMotionViolations({ path: "src/maps/MapList.module.css", text }, LICENSED_MOTION);

    expect(elsewhere(`.row:hover { animation: nudge 300ms ease; }`)).toHaveLength(1);
    expect(elsewhere(`@keyframes nudge { to { transform: translateX(2px); } }`)).toHaveLength(1);
    expect(
      elsewhere(`.row { animation-name: nudge; }\n@keyframes nudge { to { opacity: 0; } }`),
    ).toHaveLength(2);

    const here = (text: string) => findMotionViolations({ path: ROUTE_PATH, text }, LICENSED_MOTION);

    expect(here(`.markBlocked { animation: ping 2s linear infinite; }`)).toHaveLength(1);
    // The still ring's own selector is not the licensed one: moving the
    // animation back onto it is a ping per claimed row again.
    expect(here(`.markClaimed::after { animation: ping 2s linear infinite; }`)).toHaveLength(1);
    expect(here(`.markPing::after { animation: throb 2s linear infinite; }`)).toHaveLength(1);
    expect(here(`@keyframes throb { to { opacity: 0; } }`)).toHaveLength(1);
  });

  it("the check passes the licensed animation and the suppression of it", () => {
    expect(findMotionViolations({ path: ROUTE_PATH, text: ROUTE_MOTION }, LICENSED_MOTION)).toEqual(
      [],
    );
    expect(
      findMotionViolations({ path: GUARD_PATH, text: GUARD }, LICENSED_MOTION),
    ).toEqual([]);
  });

  it("every animation under src/ is one this list licenses", () => {
    const offences = collectStylesheets()
      .map((file) => format(file.path, findMotionViolations(file, LICENSED_MOTION)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });

  /*
   * The ration is enumerable over the stylesheets only if the stylesheets are
   * where the motion is. These two say so, over the same net `no-smil.test.ts`
   * walks — every `.ts`, `.tsx`, `.css`, `.svg` and `.html` under `src/` plus
   * the root `index.html` — because an `animation` in a JSX `style={{…}}`, a
   * `<style>` block in an `.svg`, or a `@keyframes` in `index.html` is motion
   * spent where `collectStylesheets` cannot look, and rule 12's still-form
   * obligation is derived from that same walk.
   */
  it("the check catches each way motion leaves the stylesheets", () => {
    const stray = (path: string, text: string) => findStrayMotion({ path, text });

    expect(stray("src/views/route/Route.tsx", `<li style={{ animation: "ping 2s linear" }} />`)).toHaveLength(1);
    expect(stray("src/views/route/Route.tsx", `<li style={{ animationName: "ping" }} />`)).toHaveLength(1);
    expect(
      stray("src/icons/mark.svg", `<style>@keyframes spin { to { rotate: 360deg; } }</style>`),
    ).toHaveLength(1);
    expect(stray("index.html", `<style>@keyframes fade { to { opacity: 0; } }</style>`)).toHaveLength(1);
    expect(stray("src/views/route/route.ts", `element.style.animation = "ping 2s linear";`)).toHaveLength(1);
    expect(
      stray("src/views/route/route.ts", `element.style.setProperty("animation-name", "ping");`),
    ).toHaveLength(1);
    /* The Web Animations API writes no CSS text at all, which is what makes it
       the widest way past the three patterns above. */
    expect(
      stray("src/views/route/route.ts", `element.animate([{ opacity: 1 }, { opacity: 0 }], 800);`),
    ).toHaveLength(1);
    expect(
      stray("src/views/route/route.ts", `const pulse = new Animation(effect, document.timeline);`),
    ).toHaveLength(1);
    expect(
      stray("src/views/route/route.ts", `element.getAnimations()[0]?.play();`),
    ).toHaveLength(1);
  });

  it("the check leaves the rationed stylesheets and ordinary source alone", () => {
    expect(findStrayMotion({ path: ROUTE_PATH, text: ROUTE_MOTION })).toEqual([]);
    expect(findStrayMotion({ path: GUARD_PATH, text: GUARD })).toEqual([]);
    expect(
      findStrayMotion({ path: "src/views/route/Route.tsx", text: `const animated = rows.filter(isMoving);` }),
    ).toEqual([]);
    /* Prose that names the constructs is not one of them: the registry entry
       for rule 9 says exactly this about itself, in a `.ts` file this walk
       reads. A check that went red on its own description would be edited
       until it stopped saying anything. */
    expect(
      findStrayMotion({
        path: "src/contract/rules.ts",
        text: "goes red on an `@keyframes` or an `animation` declaration written anywhere but a rationed stylesheet",
      }),
    ).toEqual([]);
  });

  it("no file outside the rationed stylesheets spends motion at all", () => {
    const offences = collectMarkupAndStyles()
      .map((file) => format(file.path, findStrayMotion(file)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });

  it("every licence is spent, so the list cannot outlive what it licenses", () => {
    const stylesheets = collectStylesheets();

    for (const entry of LICENSED_MOTION) {
      const file = stylesheets.find((candidate) => candidate.path === entry.path);
      expect(file, `${entry.path} is licensed for motion and is not there`).toBeDefined();
      const surface = readMotion(file!.text);
      expect(
        surface.animations.map((animation) => animation.selector),
        `${entry.selector} is licensed for motion and runs none`,
      ).toContain(entry.selector);
      expect(surface.keyframes.map((block) => block.name)).toContain(entry.keyframes);
    }
  });
});

function ticket(number: number, claimed: boolean): Node {
  return {
    number,
    title: `Ticket ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    kind: { kind: "ticket", type: "task" },
    state: claimed ? "claimed" : "takeable",
    waitsOn: [],
    boundElsewhere: false,
    cut: { cut: "inScope" },
  };
}

function mapStaking(claims: number): Map {
  const nodes = Array.from({ length: Math.max(claims, 1) }, (_, at) =>
    ticket(at + 1, at < claims),
  );
  return {
    number: 28,
    title: "Spec: perseverance",
    closed: false,
    phase: "wayfinding",
    counts: { tickets: nodes.length, open: nodes.length, specs: 0 },
    nodes,
    frontier: { frontier: "nothingToStart" },
    fog: { fog: "unsurveyed" },
  };
}

/**
 * How many marks the Route would hand `data-animated` on a map staking this
 * many claims — the view's real element count, from the view's own arithmetic.
 *
 * `pingOf` names the one row that moves and `Route.tsx` draws the attribute on
 * exactly the row it names, so this is the same walk the DOM does — held to on
 * the DOM itself in `tests/route-view.test.tsx`, which paints a multi-claim map
 * and counts the attribute rather than deriving it.
 */
function routeElements(claims: number): number {
  const route = routeOf(mapStaking(claims));
  const ping = pingOf(route);
  if (ping === null) return 0;
  return route.sections
    .flatMap((section) => section.rows)
    .filter((row) => row.node.number === ping).length;
}

describe("the ration is one element on screen, and the rack is what yields", () => {
  it("spends the rack's licence only where the other one is not being spent", () => {
    for (const point of RATION) {
      expect(
        lampPings(point.live, point.elsewhere),
        `${point.live} live, elsewhere ${point.elsewhere}`,
      ).toBe(point.pings);
    }
  });

  it("never animates two elements at once, whatever the screen is showing", () => {
    /*
     * The screen's count, and the Route's half of it is *counted* rather than
     * assumed: `routeElements` asks the view's own arithmetic how many marks
     * would carry `data-animated` over a map staking that many claims. A 1
     * written in here would assert the criterion under an assumption the view is
     * free to break, which is exactly how a ping per claimed row survived a
     * green test — the fixtures all staked one claim, so nothing counted two.
     */
    for (const claims of [0, 1, 2, 7]) {
      for (const live of [0, 1, 2, 6, 12]) {
        for (const elsewhere of [false, true]) {
          const moving =
            (elsewhere ? routeElements(claims) : 0) + (lampPings(live, elsewhere) ? 1 : 0);
          expect(
            moving,
            `${claims} claimed, ${live} live, elsewhere ${elsewhere}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("draws the map side's licence on one mark however many claims are staked", () => {
    /* And the count is not vacuously small: the rows are there to animate, and
       one of them does. */
    expect(routeElements(0)).toBe(0);
    expect(routeElements(1)).toBe(1);
    expect(routeElements(7)).toBe(1);
  });

  it("lets no landing start the lamp, whatever else is on screen", () => {
    /* Monotone in the live count: one run fewer can only take the ping away.
       This is the *never by an onset* clause, checked as arithmetic rather than
       trusted to a stylesheet — a rack that pinged because the last run landed
       would be announcing an ending by starting to move. */
    for (const elsewhere of [false, true]) {
      for (let live = 1; live <= 12; live += 1) {
        const landing = lampPings(live - 1, elsewhere);
        const before = lampPings(live, elsewhere);
        expect(landing && !before, `${live} live, elsewhere ${elsewhere}`).toBe(false);
      }
    }
  });
});

describe("reduced motion suppresses travel, not colour", () => {
  it("the check catches a guard that lets travel back in", () => {
    const guard = (declarations: string) =>
      findReducedMotionViolations(
        {
          path: GUARD_PATH,
          text: `@media (prefers-reduced-motion: reduce) { * { ${declarations} } }`,
        },
        GUARD_PATH,
      );

    expect(guard(`transition-property: opacity, transform !important;`)).toHaveLength(1);
    expect(guard(`transition-property: opacity, inset-inline-start !important;`)).toHaveLength(1);
    expect(guard(`transition-property: all !important;`)).toHaveLength(1);
    expect(guard(`transform: translateY(-2px);`)).toHaveLength(1);
    expect(guard(`animation: ping 2.1s linear infinite;`)).toHaveLength(1);
  });

  it("the check catches a guard that blankets the crossfades", () => {
    const guard = (declarations: string) =>
      findReducedMotionViolations(
        {
          path: GUARD_PATH,
          text: `@media (prefers-reduced-motion: reduce) { * { ${declarations} } }`,
        },
        GUARD_PATH,
      );

    expect(guard(`transition: none !important;`)).toHaveLength(1);
    expect(guard(`transition-property: none !important;`)).toHaveLength(1);
    expect(guard(`transition-duration: 0s !important;`)).toHaveLength(1);
  });

  it("the check catches a second guard, whether or not it says the right thing", () => {
    expect(findReducedMotionViolations({ path: ROUTE_PATH, text: GUARD }, GUARD_PATH)).toHaveLength(
      1,
    );
  });

  it("the check passes the guard this app actually ships", () => {
    expect(findReducedMotionViolations({ path: GUARD_PATH, text: GUARD }, GUARD_PATH)).toEqual([]);
  });

  it("no stylesheet under src/ opens a reduced-motion block of its own", () => {
    const offences = collectStylesheets()
      .map((file) => format(file.path, findReducedMotionViolations(file, GUARD_PATH)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });

  /*
   * The default itself, read off the one guard: the checks above say nothing
   * bad is declared, and this says the right thing is. Properties and their
   * absence only — no duration, no easing, no figure of any kind, because the
   * contract governs what a view must mean and never what it must look like.
   */
  it("the one guard kills looping animation and keeps the crossfades", () => {
    const guards = collectStylesheets().flatMap((file) =>
      readMotion(file.text).reducedMotion.map((block) => ({ path: file.path, block })),
    );

    expect(guards.map((found) => found.path)).toEqual([GUARD_PATH]);
    const { block } = guards[0]!;

    expect(block.selector).toContain("*");
    expect(block.selector).toContain("::before");
    expect(block.selector).toContain("::after");

    const declarations = new Map(block.declarations.map((d) => [d.property, d]));
    const animation = declarations.get("animation");
    expect(animation?.value, "looping animation survives the guard").toBe("none");
    expect(animation?.important, "a view can outrank the guard on specificity alone").toBe(true);

    const surviving = transitionedProperties(declarations.get("transition-property")?.value ?? "");
    expect(surviving).toEqual(
      expect.arrayContaining(["opacity", "color", "background-color", "border-color", "stroke"]),
    );
  });
});
