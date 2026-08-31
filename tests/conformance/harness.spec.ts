import { expect, test } from "@playwright/test";
import { DEFAULT_FIXTURE, FIXTURES } from "../../src/snapshot/fixtures";
import { fixtureSpace, type FixtureState } from "../support/contract";
import { ROUTE_VIEW, describeState, render } from "./support/drive";

/**
 * Proof that the harness works, and nothing more.
 *
 * It settles no encoding rule — that fan-out is #43's next slice. What it has
 * to establish is that the loop exists at all: a fixture state becomes a loaded
 * page, the page is the frontend-only boot rather than the shell, the fixture
 * asked for is the fixture on screen, and the two preference axes actually
 * reach the rendering. A rule assertion written on top of a harness where any
 * of those silently did nothing would be a green that means nothing — every
 * point of the space rendering the same default page and agreeing with itself.
 *
 * Deliberately two fixture states rather than the whole space. The space is
 * what the rules fan out over; this is the wiring underneath it.
 */

/* Picked out of the crossing rather than written as an object literal, so
   these are the same values the fan-out will iterate and not a look-alike. */
function state(
  fixture: string,
  theme: FixtureState["theme"],
  motion: FixtureState["motion"],
): FixtureState {
  const found = fixtureSpace([fixture]).find(
    (point) => point.theme === theme && point.motion === motion,
  );
  if (found === undefined) throw new Error(`no such state: ${fixture}`);
  return found;
}

const LIT = state(DEFAULT_FIXTURE, "light", "full");
const OTHER = state("two-maps-one-open", "light", "full");

/** The identity the chrome puts on screen for a fixture: its open map. */
function mapOf(fixture: string) {
  const map = FIXTURES[fixture as keyof typeof FIXTURES].model.map;
  if (map === null) throw new Error(`${fixture} has no map open`);
  return map;
}

test.describe("the conformance harness", () => {
  test(`boots with no Rust behind it — ${describeState(LIT)}`, async ({ page }) => {
    await render(page, LIT);

    /* `hasRustBehindIt()` in src/snapshot/snapshot.ts, read the only way a
       browser can read it: the shell's injected global is what the predicate
       is, and its absence is the whole `dev:web` condition. */
    expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  });

  test("renders the fixture it was asked for", async ({ page }) => {
    /* The chrome's map chip, not the graph: a node's title can quote the map's
       and the chip is the one place the open map is named once. */
    const chip = page.locator('header [data-state="open"]');

    await render(page, LIT);
    await expect(chip).toContainText(mapOf(LIT.fixture).title);

    await render(page, OTHER);
    await expect(chip).toContainText(mapOf(OTHER.fixture).title);
    /* The negative half: without it, a driver that ignored the parameter and
       always served the default would pass the line above. */
    await expect(chip).not.toContainText(mapOf(LIT.fixture).title);
  });

  test("makes the theme axis reach the rendering", async ({ page }) => {
    const surface = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await render(page, { ...LIT, theme: "light" });
    const light = await surface();

    await render(page, { ...LIT, theme: "dark" });
    expect(await surface()).not.toBe(light);
  });

  test("makes the motion axis reach the rendering", async ({ page }) => {
    /* The reduced-motion guard in global.css narrows `transition-property` on
       every element, so the route root itself carries the difference — no view
       has to have grown an animation for this to be readable. */
    const transitions = (): Promise<string> =>
      page.evaluate(
        (selector) =>
          getComputedStyle(document.querySelector(selector)!).transitionProperty,
        ROUTE_VIEW,
      );

    await render(page, { ...LIT, motion: "full" });
    const full = await transitions();

    await render(page, { ...LIT, motion: "reduced" });
    expect(await transitions()).not.toBe(full);
  });
});
