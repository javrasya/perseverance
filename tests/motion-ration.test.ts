import { describe, expect, it } from "vitest";
import {
  findMotionViolations,
  findReducedMotionViolations,
  format,
  readMotion,
  transitionedProperties,
  type LicensedMotion,
} from "./support/checks";
import { collectStylesheets } from "./support/sources";

/** The one file allowed to say what reduced motion means here. */
const GUARD_PATH = "src/styles/global.css";

const ROUTE_PATH = "src/views/route/Route.module.css";

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
 * The list is one entry and is meant to stay hard to grow. A second animation,
 * or this one moving to a selector carrying no such claim, is a red test whose
 * fix is an argument in this comment — never a line added to this array by
 * reflex.
 */
const LICENSED_MOTION: readonly LicensedMotion[] = [
  {
    path: ROUTE_PATH,
    selector: ".markClaimed::after",
    keyframes: "ping",
    carries:
      "claimed — the one node state that is in progress rather than settled, and the only liveness this side of the seam can carry",
  },
];

const ROUTE_MOTION = `
.markClaimed::after {
  content: "";
  border: 1.5px solid var(--c-node-glyph);
  opacity: 0.5;
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
      ".markClaimed::after",
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
    expect(here(`.markClaimed::after { animation: throb 2s linear infinite; }`)).toHaveLength(1);
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
