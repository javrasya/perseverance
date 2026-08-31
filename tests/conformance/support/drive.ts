import type { Locator, Page } from "@playwright/test";
import {
  FIXTURE_PARAMETER,
  fixtureNamed,
  isFixtureName,
} from "../../../src/snapshot/fixtures";
import type { Snapshot } from "../../../src/snapshot/model.generated";
import { DEFAULT_VIEW, type ViewName } from "../../../src/views/views";
import type { FixtureState } from "../../support/contract";
import { surfaceOf, type ViewSurface } from "./views";

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
export const ROUTE_VIEW = surfaceOf("route").root;

/**
 * One rendering, and everything a rule check is allowed to know about it.
 *
 * The `snapshot` is the fixture's own, read from `src/snapshot/fixtures.ts`
 * rather than scraped back off the page: a precondition — *this fixture renders
 * no resolved node*, *this map's fog was surveyed* — has to come from the model
 * the rendering was built from, or it is the rendering being asked to vouch for
 * itself. Which is also why a hand-kept list of fixture names is not a
 * precondition: it stops being true the first time a fixture changes.
 *
 * `root` is `null` when this view is not on screen for this fixture at all, and
 * that is a state rather than a failure — `App` mounts no view with no map
 * open. A rule whose subject is the view says so and skips; a rule whose
 * subject is the whole rendering carries on.
 */
export interface Rendering {
  readonly page: Page;
  readonly view: ViewName;
  readonly surface: ViewSurface;
  readonly state: FixtureState;
  readonly snapshot: Snapshot;
  readonly root: Locator | null;
}

/**
 * Loads one point of the fixture space into `page`, for one view.
 *
 * Settled means the view root is visible where there is one, and the fonts are
 * resolved either way: a metric a rule reads — a size, a spacing, a line count
 * — is measured against a fallback face until `document.fonts` is done, and
 * that is a flake nobody can reproduce.
 */
export async function load(
  page: Page,
  view: ViewName,
  state: FixtureState,
): Promise<Rendering> {
  const surface = surfaceOf(view);
  if (!isFixtureName(state.fixture)) throw new Error(`no such fixture: ${state.fixture}`);
  const snapshot = fixtureNamed(state.fixture);

  await page.emulateMedia({
    colorScheme: state.theme,
    reducedMotion: state.motion === "reduced" ? "reduce" : "no-preference",
  });

  await page.goto(`/?${FIXTURE_PARAMETER}=${encodeURIComponent(state.fixture)}`);

  /* The chrome is what is on screen in every state, including the one where no
     view is: waiting on it is what makes *the app booted* separable from *this
     view mounted*, which is the difference the null root reports. */
  await page.locator("header").first().waitFor({ state: "visible" });

  let root: Locator | null = null;
  if (surface.mounts(snapshot)) {
    root = page.locator(surface.root);
    await root.waitFor({ state: "visible" });
  }

  await page.evaluate(() => document.fonts.ready);

  return { page, view, surface, state, snapshot, root };
}

/** The Route, on screen, for a state that has a map open. */
export async function render(page: Page, state: FixtureState): Promise<Locator> {
  const rendering = await load(page, DEFAULT_VIEW, state);
  if (rendering.root === null) {
    throw new Error(`${state.fixture} does not put ${DEFAULT_VIEW} on screen`);
  }
  return rendering.root;
}

/** How a state reads in a test name, so a failure says which point it was. */
export function describeState(state: FixtureState): string {
  return `${state.fixture} · ${state.theme} · ${state.motion} motion`;
}
