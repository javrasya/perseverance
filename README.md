# perseverance

A desktop harness for the wayfinder loop — chart a map, work the frontier one
ticket at a time, compose a spec — without leaving the thing you are working on.

This is the walking skeleton: the empty room, correctly shaped. The spec is
[#28](https://github.com/javrasya/perseverance/issues/28).

## Shape

A Cargo workspace of five crates plus a React 19 + TypeScript frontend.

| Crate | Owns | Never |
|---|---|---|
| `perseverance-model` | Deriving the model from a GitHub graph | Tauri, the network, a browser |
| `perseverance-github` | Every network call, and the poller | Writing to GitHub |
| `perseverance-agent` | The agent trait and its adapters; planning | Spawning anything |
| `perseverance-pty` | PTY and child-process ownership | Deciding what to run |
| `perseverance-app` | The Tauri window and command surface | Any decision at all |

`perseverance-model` is the primary seam. It is derivation only, so the same
`Snapshot` that Rust produces can be a checked-in JSON fixture that drives the
frontend with no Rust, no GitHub and no PTY behind it.

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
  but the `app` key/value table is where it belongs once the store lands. The
  swap is one file (`src/theme/theme.ts`).
- **No macOS run has happened yet on this branch.** The matrix declares it;
  only CI can green it.
