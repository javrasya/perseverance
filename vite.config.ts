import react from "@vitejs/plugin-react";
import browserslistToEsbuild from "browserslist-to-esbuild";
/* `vitest/config` rather than `vite`, so the `test` block below type-checks;
   the Vite half of the config is unchanged by it. */
import { defineConfig } from "vitest/config";

/**
 * macOS is the CSS floor, not Windows.
 *
 * Windows ships an evergreen WebView; macOS ships one pinned to the OS
 * version. macOS 13 / Safari 16.4 is declared once — in package.json's
 * `browserslist` — and read from there by the build target and by stylelint,
 * so a violation is a build error here rather than someone else's rendering
 * surprise later.
 */
const target = browserslistToEsbuild();

export default defineConfig({
  plugins: [react()],

  // Tauri owns the terminal it runs in; do not wipe its output.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/target/**", "**/crates/**"],
    },
  },

  /*
   * The conformance suite is Playwright's, not vitest's.
   *
   * vitest's default include swallows every `*.spec.ts` in the tree, so the
   * browser specs under `tests/conformance/` would be collected by `npm test`
   * and fail on fixtures vitest does not provide. `npm test` and `npm run
   * verify` have to stay runnable with no browser installed — they are what a
   * branch's greenness is judged by — so the fence is explicit here and
   * mirrored by `testDir` in `playwright.config.ts`.
   */
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/conformance/**"],
  },

  build: {
    target,
    cssTarget: target,
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
