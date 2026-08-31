import type { Locator, Page } from "@playwright/test";
import { FIXTURE_PARAMETER } from "../../../src/snapshot/fixtures";
import type { FixtureState } from "../../support/contract";

/**
 * One point of the fixture space, on screen, in a real engine.
 *
 * The space is fixtures × themes × motion, and every axis of it is somebody
 * else's declaration: the fixtures are `FIXTURE_NAMES`, the crossing is
 * `fixtureSpace`, and the query parameter that selects a fixture is
 * `FIXTURE_PARAMETER`. Nothing here re-lists any of them, because a second list
 * is a list that drifts — a fixture added later would silently stop being
 * rendered by the suite that exists to render all of them.
 *
 * The two preference axes are emulated per page rather than baked into a
 * browser context. The app reads them through `prefers-color-scheme` and
 * `prefers-reduced-motion` — see `src/styles/tokens/semantic.css` and
 * `src/styles/global.css` — and it only reads them when no override is stored,
 * which is the state a fresh page is in. Emulating the media query is therefore
 * the honest lever: it drives the same code path an operator's OS does, where
 * writing `perseverance.theme` into storage would drive the override instead
 * and prove nothing about the default.
 *
 * The spec owns the page. A driver that opened its own context could not be
 * used from a test that needs two states side by side, and #43's fan-out is
 * exactly that shape.
 */
export const ROUTE_VIEW = 'section[aria-label="The Route"]';

/**
 * Loads `state` into `page` and returns the Route view once it has painted.
 *
 * Settled means the view root is visible and the fonts are resolved: a metric
 * a rule reads — a size, a spacing, a line count — is measured against a
 * fallback face until `document.fonts` is done, and that is a flake nobody can
 * reproduce.
 */
export async function render(page: Page, state: FixtureState): Promise<Locator> {
  await page.emulateMedia({
    colorScheme: state.theme,
    reducedMotion: state.motion === "reduced" ? "reduce" : "no-preference",
  });

  await page.goto(`/?${FIXTURE_PARAMETER}=${encodeURIComponent(state.fixture)}`);

  const route = page.locator(ROUTE_VIEW);
  await route.waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);

  return route;
}

/** How a state reads in a test name, so a failure says which point it was. */
export function describeState(state: FixtureState): string {
  return `${state.fixture} · ${state.theme} · ${state.motion} motion`;
}
