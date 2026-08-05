#!/usr/bin/env node
/**
 * The agent crate depends on nothing at all — not one crate, first-party or
 * third-party, normal, build or dev.
 *
 * `crates/agent/src/lib.rs` has said "deliberately depends on nothing" since
 * the walking skeleton, and until this file that was a sentence. It is the
 * sentence `docs/adr/0002` rests on: the environment harvest went into its own
 * crate rather than into `perseverance-github` or `perseverance-pty`
 * specifically so that #45's planner-side work would never be forced to name
 * it, and the whole of that argument is the `agent -> env` arrow staying
 * absent. An arrow a decision rests on that only review can see is an arrow
 * that arrives the first week someone needs a `PathBuf` helper.
 *
 * Nothing is forbidden by name here, unlike `check-model-purity.mjs`. A list of
 * names would be a claim about which dependencies are bad, and the claim is
 * stronger than that: planning is pure, so an adapter is testable with a
 * golden-argv assertion and needs no crate to be. One package in the tree —
 * itself — is the whole rule.
 *
 * `--edges normal,build,dev` for the same reason the purity check uses it: a
 * dev-dependency compiles into the tests, and a test that needs the world is
 * evidence that the thing under test needs the world.
 */

import { execFileSync } from "node:child_process";

const CRATE = "perseverance-agent";

/**
 * The verdict, as a pure function of what `cargo tree` printed, so the
 * paragraph below can put known-bad input through the same code the tree goes
 * through.
 */
function companionsIn(tree) {
  return [
    ...new Set(
      tree
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((name) => name && name !== CRATE),
    ),
  ].sort();
}

/**
 * A check nobody has ever seen fail is indistinguishable from a check that
 * cannot fail, which is why the two stack-level checks test themselves. This
 * one can honestly do half of that: the verdict is exercised against tree
 * output that was never produced by cargo, so a `companionsIn` that returned
 * `[]` for everything fails here rather than passing quietly forever.
 *
 * The half it cannot do is the invocation. If the `--edges` argument below lost
 * `dev`, or `--package` named a crate that does not exist, this file would
 * still be green and this comment is the only thing that says so.
 */
const KNOWN_BAD = [
  { name: "one first-party edge", tree: `${CRATE} v0.1.0\nperseverance-env v0.1.0\n` },
  { name: "one third-party edge", tree: `${CRATE} v0.1.0\nthiserror v2.0.0\n` },
  { name: "a transitive edge only", tree: `${CRATE} v0.1.0\nserde v1.0.0\nserde_derive v1.0.0\n` },
];

for (const { name, tree } of KNOWN_BAD) {
  if (companionsIn(tree).length === 0) {
    console.error(
      `check-agent-solitude cannot detect ${name}: its own known-bad input passed.`,
    );
    process.exit(1);
  }
}
if (companionsIn(`${CRATE} v0.1.0 (/somewhere/crates/agent)\n`).length !== 0) {
  console.error("check-agent-solitude fails a crate that depends on nothing; it is not usable.");
  process.exit(1);
}

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

const companions = companionsIn(tree);

if (companions.length > 0) {
  console.error(
    `${CRATE} must depend on nothing — no crate, no dev-dependency, no build script.\n` +
      `Found in its dependency tree:\n${companions.map((name) => `  ${name}`).join("\n")}\n\n` +
      `Planning is pure: an adapter is a golden-argv assertion and needs no crate to be one.\n` +
      `Acquiring an environment is perseverance-env's, and its accessors hand back std types\n` +
      `precisely so that this crate never has to name it. See docs/adr/0002.`,
  );
  process.exit(1);
}

console.log(`${CRATE}: no dependencies at all, across normal, build and dev edges.`);
