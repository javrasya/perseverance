import type { Locator, Page } from "@playwright/test";
import {
  FIXTURE_PARAMETER,
  fixtureNamed,
  isFixtureName,
} from "../../../src/snapshot/fixtures";
import type { Snapshot } from "../../../src/snapshot/model.generated";
import {
  DEFAULT_RUN_FIXTURE,
  RUNS_PARAMETER,
  type RunFixtureName,
} from "../../../src/terminal/fixtures";
import { DEFAULT_VIEW, LABELS, type ViewName } from "../../../src/views/views";
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
export interface Prospect {
  readonly view: ViewName;
  readonly surface: ViewSurface;
  readonly state: FixtureState;
  readonly snapshot: Snapshot;
}

export interface Rendering extends Prospect {
  readonly page: Page;
  readonly root: Locator | null;
}

/**
 * One point of the space before any browser has seen it.
 *
 * Everything a *precondition* is allowed to read is here and nothing else is:
 * which view, what that view declares about itself, which preferences are
 * emulated, and the fixture's own `Snapshot`. That is the whole point of the
 * split. A precondition that could read the rendering would be the rendering
 * deciding whether it is worth checking, and it would only be answerable with
 * a browser — where the coverage gate that counts preconditions
 * (`tests/conformance-coverage.test.ts`) has none and must not need one.
 *
 * `load` builds one of these and then adds the page to it, so the two agree by
 * construction rather than by two functions resolving a fixture the same way.
 */
export function prospect(view: ViewName, state: FixtureState): Prospect {
  if (!isFixtureName(state.fixture)) throw new Error(`no such fixture: ${state.fixture}`);
  return { view, surface: surfaceOf(view), state, snapshot: fixtureNamed(state.fixture) };
}

/**
 * Loads one point of the fixture space into `page`, for one view.
 *
 * Settled means the view root is visible where there is one, and the fonts are
 * resolved either way: a metric a rule reads — a size, a spacing, a line count
 * — is measured against a fallback face until `document.fonts` is done, and
 * that is a flake nobody can reproduce.
 *
 * `runs` is the second fixture this window boots from, and it is a parameter
 * rather than part of `FixtureState` because the two axes are not the same
 * axis: `FixtureState` is fixtures × themes × motion, the space every
 * render-bound *rule* is fanned out over, and a set of runs is not a snapshot —
 * nothing in `Snapshot` says what is running. It defaults to
 * `DEFAULT_RUN_FIXTURE`, which is empty, so a caller that says nothing gets the
 * window it always got: `src/terminal/fixtures.ts` argues that a `dev:web` tab
 * opened without asking for runs is a tab with nothing bound, and a driver that
 * seeded runs behind every spec's back would be the harness deciding that for
 * it. A spec whose subject *is* the run chrome asks — `rack-width.spec.ts` does,
 * because a rack with no rows in it can be measured and proves nothing.
 */
export async function load(
  page: Page,
  view: ViewName,
  state: FixtureState,
  runs: RunFixtureName = DEFAULT_RUN_FIXTURE,
): Promise<Rendering> {
  const at = prospect(view, state);
  const { surface, snapshot } = at;

  await page.emulateMedia({
    colorScheme: state.theme,
    reducedMotion: state.motion === "reduced" ? "reduce" : "no-preference",
  });

  /* Both fixtures in one URL, spelled from the parameters their own modules
     export rather than from two literals here — a query string is the whole of
     how `dev:web` is told what to stand in for, and a second spelling of either
     name is a spelling that drifts. */
  const asked = new URLSearchParams({
    [FIXTURE_PARAMETER]: state.fixture,
    [RUNS_PARAMETER]: runs,
  });
  await page.goto(`/?${asked.toString()}`);

  /* The chrome is what is on screen in every state, including the one where no
     view is: waiting on it is what makes *the app booted* separable from *this
     view mounted*, which is the difference the null root reports. */
  await page.locator("header").first().waitFor({ state: "visible" });

  /*
   * Which view is open is an operator act, so the driver performs the operator
   * act: it presses the view's own cap on the switcher.
   *
   * The remembered view (`perseverance.view`) could be seeded through an init
   * script before navigation, and that would be cheaper — but it would open the
   * view *without moving the dial*, and at `DEFAULT_DETENT` half the window the
   * suite runs in is worth less than the Plate's floor. The Plate would then be
   * stood down at every point of the space: a fan-out waiting for a root that
   * the shell has correctly decided not to draw. Pressing the cap is the one
   * lever with both consequences — `App.tsx`'s `onChooseView` widens the dial to
   * a position where the wanted view fits *and* opens it — so the width the view
   * declares it needs is satisfied by the same mechanism an operator would use,
   * rather than by the suite arranging a window the product never arranges for
   * itself.
   *
   * The cap is addressed by role and accessible name, never by a class or a
   * `data-` hook: it is chrome the contract already describes (`role="group"`,
   * `aria-label="Views"`, one button per view carrying `LABELS[name]`), and a
   * name match survives the reason text a cap grows when its view does not fit.
   */
  await page
    .getByRole("group", { name: "Views" })
    .getByRole("button", { name: LABELS[view] })
    .click();

  let root: Locator | null = null;
  if (surface.mounts(snapshot)) {
    root = page.locator(surface.root);
    /*
     * The shell has a real state where a view it was asked for cannot be drawn:
     * below the view's own floor it stands the view down and says what it needs
     * and what it has. Waiting only for the root would meet that state as a
     * thirty-second timeout with no reason on it, so the race is run against
     * the stand-down as well and it is reported as what it is. It is a failure
     * rather than a skip: the cap press above is supposed to have widened the
     * dial to a position where the wanted view fits, so a stand-down here means
     * the window the suite runs in cannot hold this view at any detent — which
     * the run has to say out loud, not quietly stop asserting over.
     */
    const stoodDown = page.locator('section[aria-label="View stood down"]');
    await Promise.race([
      root.waitFor({ state: "visible" }),
      stoodDown.waitFor({ state: "visible" }),
    ]);
    if ((await stoodDown.count()) > 0) {
      throw new Error(
        `${view} stood down at ${state.fixture}: the viewport cannot hold it at any detent`,
      );
    }
    await root.waitFor({ state: "visible" });

    /*
     * Mounted is not drawn. A view is free to answer a canvas narrower than it
     * can work in by printing what it needs instead of the map — The Bench
     * does, inside its own root — and that rendering has a visible root, no
     * rows, and nothing about it that a rule would fail on for the right
     * reason. A suite that ran over it would be green about nothing, so the
     * shortfall is raised here, once, where the width was chosen.
     *
     * The condition is the model's and not any view's: a map with nodes in it
     * is a map every view draws rows for.
     */
    const drawable = snapshot.model.map?.nodes.length ?? 0;
    if (drawable > 0 && (await root.locator(surface.rows).count()) === 0) {
      throw new Error(
        `${view} mounted for ${state.fixture} and drew none of its ${drawable} nodes — ` +
          `the viewport is almost certainly below the view's floor (see playwright.config.ts)`,
      );
    }
  }

  await page.evaluate(() => document.fonts.ready);

  return { ...at, page, root };
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
