import react from "@vitejs/plugin-react";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { defineConfig } from "vite";

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

  build: {
    target,
    cssTarget: target,
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
