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
import { DEFAULT_VIEW, VIEW_STORAGE_KEY, type ViewName } from "../../../src/views/views";
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

  /*
   * Which view is open is the remembered one, so the way to open a view here is
   * the way an operator's last session opens it: the key `views.ts` reads at
   * boot, written before any of the app's own script runs, so the very first
   * paint is already the asked-for view. Pressing the switcher instead would
   * make every rule check depend on the switcher being reachable at this width,
   * which is a different claim from the rule's. The key is imported and never
   * respelled: a second spelling would go on passing after the app renamed it,
   * asserting against whatever the app opened on instead.
   *
   * A `?view=` parameter beside `?map=` was the alternative, and it was refused
   * for the reason a second list always is: choosing a view would then be two
   * mechanisms, and the day they disagree the suite is the thing that lies.
   */
  await page.addInitScript(
    ([key, name]: readonly [string, ViewName]) => {
      try {
        window.localStorage.setItem(key, name);
      } catch {
        // Storage denied: the app opens on its default, and the root wait below
        // is what reports that rather than a check quietly reading another view.
      }
    },
    [VIEW_STORAGE_KEY, view] as const,
  );

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

  await openTheDial(page);

  let root: Locator | null = null;
  if (surface.mounts(snapshot)) {
    root = page.locator(surface.root);
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

/**
 * The dial, put where the view is drawn, before anything is read off it.
 *
 * Setup, exactly like seeding the remembered view above, and for the same
 * reason: how much window the map side is worth is the operator's, the shell
 * remembers it per map, and a suite that never touched it would be asserting
 * about whichever share the default detent happens to leave. That share is not
 * generous — the map side is split with the terminal and then split again with
 * the launcher and the rail — and a view wide enough to want the room says so
 * by standing itself down, at which point every rule below reads a notice
 * instead of a picture and reports green for the half of itself the notice
 * happens to satisfy. That is what the first WebKit run against Deep Field
 * found, and it is a hole in the reading rather than a finding about the view.
 *
 * `map` and not *the narrowest detent that fits*: which detent fits is a number
 * the shell computes from floors, and a driver that asked the shell where to
 * stand would be the rendering choosing the conditions it is judged under. The
 * far detent is the one position that is the same claim for every view — *this
 * window, all of it, to the map* — so a view that will not draw there is a view
 * that will not draw at all, which is a finding and not a hole.
 *
 * Driven through the keyboard rather than through the store: the dial's
 * remembered position is keyed on a folder and a map, and `dev:web` has opened
 * neither, so there is no cell to seed. `End` is the binding the one key router
 * declares for *give the whole window to the map* (`src/keys/router.ts`), and
 * `data-dial` is the hook that router resolves the widget by — the same two
 * hooks an operator's own hand goes through.
 */
async function openTheDial(page: Page): Promise<void> {
  const dial = page.locator("[data-dial]");
  await dial.waitFor({ state: "visible" });
  await dial.focus();
  await page.keyboard.press("End");
  /* The attribute the dial writes its own detent into, so the wait is on the
     move having landed rather than on a duration. */
  await page.locator('[data-dial][data-detent="map"]').waitFor({ state: "visible" });
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
