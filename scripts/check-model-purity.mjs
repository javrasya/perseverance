#!/usr/bin/env node
/**
 * The model crate builds and its tests pass with no Tauri, no network and no
 * browser in its dependency tree.
 *
 * That sentence is the primary seam. Left as prose it decays the first time
 * someone reaches for a convenient HTTP client "just for a helper"; as a walk
 * over `cargo tree` it is a build failure.
 *
 * `--edges normal,build,dev` on purpose: the claim covers the tests too, so a
 * dev-dependency pulling a browser driver in must fail exactly as a real
 * dependency would.
 */

import { execFileSync } from "node:child_process";

const CRATE = "perseverance-model";

/** Prefix match, so a family (tauri-build, tauri-macros, …) is one entry. */
const FORBIDDEN = [
  // Tauri and its webview stack
  { prefix: "tauri", why: "Tauri" },
  { prefix: "wry", why: "Tauri's webview" },
  { prefix: "tao", why: "Tauri's windowing" },
  { prefix: "muda", why: "Tauri's menus" },
  { prefix: "webkit2gtk", why: "a browser engine" },
  { prefix: "webview2-com", why: "a browser engine" },
  { prefix: "objc2-web-kit", why: "a browser engine" },
  // Browser automation
  { prefix: "headless_chrome", why: "a browser" },
  { prefix: "fantoccini", why: "a browser" },
  { prefix: "thirtyfour", why: "a browser" },
  // Network
  { prefix: "reqwest", why: "the network" },
  { prefix: "hyper", why: "the network" },
  { prefix: "h2", why: "the network" },
  { prefix: "ureq", why: "the network" },
  { prefix: "attohttpc", why: "the network" },
  { prefix: "isahc", why: "the network" },
  { prefix: "curl", why: "the network" },
  { prefix: "surf", why: "the network" },
  { prefix: "octocrab", why: "the network" },
  { prefix: "tokio", why: "an async runtime that opens sockets" },
  { prefix: "async-std", why: "an async runtime that opens sockets" },
  { prefix: "smol", why: "an async runtime that opens sockets" },
  { prefix: "mio", why: "the network" },
  { prefix: "socket2", why: "the network" },
  { prefix: "native-tls", why: "the network" },
  { prefix: "rustls", why: "the network" },
  { prefix: "openssl", why: "the network" },
  // Process and terminal ownership belongs to perseverance-pty
  { prefix: "portable-pty", why: "PTY ownership, which belongs to perseverance-pty" },
];

let tree;
try {
  tree = execFileSync(
    "cargo",
    [
      "tree",
      "--package",
      CRATE,
      "--edges",
      "normal,build,dev",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (error) {
  console.error(`cargo tree failed for ${CRATE}:\n${error.stderr ?? error.message}`);
  process.exit(1);
}

const packages = [
  ...new Set(
    tree
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && name !== CRATE),
  ),
].sort();

const breaches = [];
for (const name of packages) {
  const hit = FORBIDDEN.find(
    (entry) => name === entry.prefix || name.startsWith(`${entry.prefix}-`),
  );
  if (hit) breaches.push(`  ${name} — ${hit.why}`);
}

if (breaches.length > 0) {
  console.error(
    `${CRATE} must build and test with no Tauri, no network and no browser.\n` +
      `Found in its dependency tree:\n${breaches.join("\n")}\n\n` +
      `The seam is the point: the model crate is what a JSON fixture drives.`,
  );
  process.exit(1);
}

console.log(
  `${CRATE}: ${packages.length} transitive dependencies, none of them Tauri, network or browser.`,
);
