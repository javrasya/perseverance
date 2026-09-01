import { defineConfig, devices } from "@playwright/test";

/**
 * The conformance harness runs in a real browser, over `dev:web`, with nothing
 * behind it.
 *
 * Rendered rules cannot be settled in jsdom: a theme is a
 * `prefers-color-scheme` reassignment and motion is a `prefers-reduced-motion`
 * guard, and jsdom computes neither. So the suite drives an actual engine
 * against the frontend-only Vite boot — no `cargo`, no Tauri shell, no PTY and
 * no GitHub — which is the whole reason the fixtures are checked in.
 *
 * **WebKit is required and Chromium is opt-in.** macOS ships a WebView pinned
 * to the OS version and exposes no WebDriver, so nothing else in this repo will
 * ever exercise the tighter CSS floor (`browserslist`, `safari >= 16.4`) in a
 * browser. A Chromium-only run would be systematically blind to the platform
 * most likely to break first, so CI runs `webkit` and depends on it, and
 * `chromium` is there for a developer who wants the second reading.
 */
/**
 * One viewport for every project, and it overrides the device's own.
 *
 * The suite renders each registered view over the whole fixture space, so the
 * window has to be wide enough for the *widest* floor in `VIEW_FLOORS` —
 * otherwise `App` draws its stand-down where a view should be, or the view
 * draws its own, and a rule that then found no rows would be going red for a
 * reason that has nothing to do with the rule. The Bench asks for 680px of
 * canvas, and the canvas is a good deal narrower than the window: the dial opens
 * at `split`, so the map side is half the body; the rail takes 13rem off it; the
 * drop region's own frame and the view column's gutter come off next, because
 * `flex: 1` shares out what is left of the line rather than what is left of the
 * rail; and only then do the launcher and the view halve it. A little under a
 * quarter of the body reaches the canvas, which is the whole of why 680px of
 * canvas is `VIEW_FLOORS.bench = 1842` of map side (`BENCH_MAP_FLOOR` in
 * `src/panes/dial.ts` does that arithmetic) and why this viewport is well over
 * four times 680 rather than near it: at `split` the body has to be at least
 * twice 1842, and 3840 clears that with a margin.
 *
 * The Plate decides the number. Its floor is a floor on the *drawing*, and the
 * map side has to hold the launcher, the rail, the shell's own padding and this
 * view's reserved margin before the drawing gets a pixel — `VIEW_FLOORS.plate`
 * composes all of that and lands at 2360px of map side. The Bench asks for
 * 680px of canvas, which is `VIEW_FLOORS.bench = 1842` of map side by the same
 * kind of arithmetic (`BENCH_MAP_FLOOR` in `src/panes/dial.ts`), and so is the
 * second-widest rather than the widest. 3840 clears the Plate's with a margin
 * at the detent the driver opens a view at.
 *
 * The devices' own 1280 would put every fixture on a stood-down view, so this
 * is not a preference. The driver refuses to run against a mounted-but-undrawn
 * view (`tests/conformance/support/drive.ts`), which is what turns a layout
 * change that eats this margin into a named failure rather than into a suite
 * quietly asserting nothing.
 */
const WIDE_ENOUGH_FOR_EVERY_VIEW = { width: 3840, height: 1440 };

export default defineConfig({
  /* Its own directory, and `vite.config.ts` excludes it from vitest: vitest's
     default include swallows `**​/*.spec.ts`, and these specs import a runner
     vitest has no fixtures for. The fence is two-sided on purpose. */
  testDir: "./tests/conformance",

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  /* CI gets two reporters, because the annotations are the record. A check
     that cannot apply to a state skips with its precondition annotated, and
     `line` prints none of that — so under `line` alone a rule that skipped
     everywhere and a rule that held everywhere are the same output. `html`
     writes those annotations into `playwright-report/`, which `ci.yml` uploads
     even on a red run, since a red run is when the record matters most. */
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: "http://localhost:1421",
    trace: "on-first-retry",
  },

  /*
   * The window, stated rather than inherited, and stated on each project
   * because a device descriptor carries its own viewport and would win.
   *
   * The widest view decides it. The Plate's floor is a floor on the *drawing*,
   * and the map side has to hold the launcher, the rail, the shell's own
   * padding and this view's reserved margin before the drawing gets a pixel —
   * `VIEW_FLOORS.plate` composes all of that and lands at 2360px of map side,
   * which no 1280px laptop default and no 1920px display can reach at any
   * detent. ADR 0026 records why that is accepted rather than fixed. A suite
   * run in a window under it would meet the stand-down at every state and fail
   * loudly (`drive.ts` says so out loud rather than skipping), which is the
   * shell behaving correctly and the harness asking the wrong question. This is
   * the desktop the view is competent on.
   */
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: WIDE_ENOUGH_FOR_EVERY_VIEW },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: WIDE_ENOUGH_FOR_EVERY_VIEW },
    },
  ],

  webServer: {
    /* Not `dev:web`: its `--open` launches a browser on the runner, which is
       not something CI should be doing. And not port 1420 either — that one is
       `strictPort`, so a developer with the app already running would make the
       suite fail to boot rather than run beside it. */
    command: "npm run dev:web:serve",
    url: "http://localhost:1421",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
