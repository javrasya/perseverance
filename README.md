# perseverance

A desktop harness for the wayfinder loop — chart a map, work the frontier one
ticket at a time, compose a spec — without leaving the thing you are working on.

This is the walking skeleton: the empty room, correctly shaped. The spec is
[#28](https://github.com/javrasya/perseverance/issues/28).

## Shape

A Cargo workspace of six crates plus a React 19 + TypeScript frontend.

| Crate | Owns | Never |
|---|---|---|
| `perseverance-model` | Deriving the model from a GitHub graph | Tauri, the network, a browser |
| `perseverance-github` | Every network call, and the poller | Writing to GitHub |
| `perseverance-agent` | The agent trait and its adapters; planning | Spawning anything |
| `perseverance-pty` | PTY and child-process ownership | Deciding what to run |
| `perseverance-store` | The launcher registry: one SQLite file, its schema, and binding a folder to its repo | The network, Tauri, a child process |
| `perseverance-app` | The Tauri window and command surface | Any decision at all |

`perseverance-model` is the primary seam. It is derivation only, so the same
`Snapshot` that Rust produces can be a checked-in JSON fixture that drives the
frontend with no Rust, no GitHub and no PTY behind it. The launcher works the
same way: `src/launcher/folders.fixture.json` carries a present folder, a
missing one and all three repo-binding refusals, because those are states a
browser cannot conjure.

`perseverance-store` is the sixth crate rather than a corner of the shell
because it carries real policy — refusing a schema version this build does not
speak, keeping a missing folder on the list, and three distinct ways a folder
can fail to be a repository. The shell's charter is wiring only.
[ADR 0001](docs/adr/0001-the-launcher-registry-is-its-own-crate.md) records why,
and what it costs.

App-level artifacts are named **perseverance**. `wayfinder` stays reserved for
the skill's vocabulary and never appears in a shipped name.

## Running it

```bash
npm install
npm run tauri dev      # the app
npm run dev            # the frontend alone, in a browser
```

Packaging, signing and auto-update are out of scope, so `bundle.active` is
false and `npm run tauri build` is not a supported path yet.

## The checks

Four rules that would otherwise be conventions. Each is enforced on both CI
runners.

```bash
npm run verify         # all of the below, plus typecheck and build
```

**The model crate stays pure** — `npm run check:model-purity` walks
`cargo tree` for `perseverance-model` across normal, build *and* dev edges and
fails on Tauri, any HTTP client, any async runtime that opens sockets, any
browser engine or driver, and `portable-pty`. Dev edges are included because
the claim covers the tests too.

**SMIL is prohibited** — `tests/no-smil.test.ts`. `prefers-reduced-motion` does
not touch SMIL, so a liveness pulse authored that way survives the media query
silently and breaks the still-state rule in the one state that matters. CSS
animation and transitions only. The prohibition is stack-level precisely
because it is invisible in review.

**Views consume semantic tokens only** — `tests/token-tiers.test.ts`. Three
tiers: `--p-*` primitives defined in one file, `--s-*` semantics that name a
job rather than a value, `--c-*` component tokens local to a module. Only the
semantic file may read a primitive, and no stylesheet may carry a raw colour
literal. That is what makes *survives a retheme* checkable: a retheme is a
reassignment in `semantic.css`, and nothing re-renders.

**macOS is the CSS floor, not Windows** — `npm run check:css-floor`. Windows
ships an evergreen WebView; macOS ships one pinned to the OS version. macOS 13
/ Safari 16.4 is declared once in `package.json`'s `browserslist` and read from
there by both stylelint and the Vite build target, so a violation is a build
error rather than someone else's rendering surprise.

Both stack-level checks test themselves against known-bad input as well as
against the tree. A check nobody has ever seen fail is indistinguishable from a
check that cannot fail.

## Honest limits

- **The CSS floor gate is only as complete as `doiuse`'s feature data.** It
  catches what caniuse names — CSS nesting at Safari 16.5 is caught, verified
  — but a property caniuse has no entry for passes silently. It is a floor,
  not a proof.
- **The theme override currently persists to `localStorage`.** That is
  app-global and survives restart, which is what "persisted globally" requires,
  but the `app` key/value table — which now exists — is where it belongs. The
  swap is one file (`src/theme/theme.ts`).
- **The launcher registry has no capabilities file, and needs none.** The folder
  picker is answered in Rust and hands back a path, so the WebView calls only
  app-defined commands, which Tauri v2 does not gate. The day the frontend calls
  a plugin command directly, `crates/app/capabilities/` has to appear and carry
  `core:default` with it.
- **No macOS run has happened yet on this branch.** The matrix declares it;
  only CI can green it.
