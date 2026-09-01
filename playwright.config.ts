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

  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
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
