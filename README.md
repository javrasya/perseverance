# perseverance

A desktop harness for the wayfinder loop — chart a map, work the frontier one
ticket at a time, compose a spec — without leaving the thing you are working on.

This is the walking skeleton: the empty room, correctly shaped. The spec is
[#28](https://github.com/javrasya/perseverance/issues/28).

## Shape

A Cargo workspace of seven crates plus a React 19 + TypeScript frontend.

| Crate | Owns | Never |
|---|---|---|
| `perseverance-model` | Deriving the model from a GitHub graph | Tauri, the network, a browser |
| `perseverance-github` | Every network call, and the poller | Writing to GitHub |
| `perseverance-agent` | The agent trait and its adapters; planning | Spawning anything |
| `perseverance-pty` | PTY and child-process ownership | Deciding what to run |
| `perseverance-store` | The launcher registry: one SQLite file, its schema, and binding a folder to its repo | The network, Tauri, a child process |
| `perseverance-env` | The environment harvest: the operator's login shell asked once, in memory, and running one program inside the answer | Owning a terminal |
| `perseverance-app` | The Tauri window and command surface | Any decision at all |

`perseverance-model` is the primary seam. It is derivation only, so the same
`Snapshot` that Rust produces can be a checked-in JSON fixture that drives the
frontend with no Rust, no GitHub and no PTY behind it. The launcher works the
same way: `src/launcher/folders.fixture.json` carries a present folder, a
missing one and all three repo-binding refusals, because those are states a
browser cannot conjure. So does the diagnostics panel:
`src/environment/environment.fixture.json` carries a launchd stub, a refused
shell and a Windows transcript, none of which a browser can produce either. And
so does the map list: `src/maps/maps.fixture.json` carries an open map, a
completed one, and a read that is already old, because a cache with age on it is
a state a fresh browser has no way to reach.

`perseverance-store` is the sixth crate rather than a corner of the shell
because it carries real policy — refusing a schema version this build does not
speak, keeping a missing folder on the list, and three distinct ways a folder
can fail to be a repository. The shell's charter is wiring only.
[ADR 0001](docs/adr/0001-the-launcher-registry-is-its-own-crate.md) records why,
and what it costs.

`perseverance-env` is the seventh for a narrower reason: a GUI bundle on macOS
starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and cannot find `gh` at all, so
the app's first act is to ask the operator's login shell what the environment
should have been. That is a child process, but it is a *measurement* rather than
a session — framed, sub-second, read to a mark and abandoned — and the crate that
owns terminals owns the other kind.
[ADR 0002](docs/adr/0002-the-environment-harvest-is-its-own-crate.md) records
the distinction, why the harvest is not a corner of `perseverance-github` or
`perseverance-pty`, and what it costs.

`perseverance-github` reads GitHub over a socket it opens itself — one blocking
`POST` of one GraphQL document, signed with the token `gh auth token` handed
over at launch — rather than by spawning `gh api` and reading what it prints.
Spawning would be a smaller diff and no new dependency, and it would leave the
acquired token with nothing to do.
[ADR 0003](docs/adr/0003-github-is-read-over-a-blocking-socket-this-app-owns.md)
records the decision, why the client is `ureq` rather than `octocrab`, and what
it costs.

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

Five rules that would otherwise be conventions. Each is enforced on both CI
runners.

```bash
npm run verify         # all of the below, plus typecheck and build
```

**The model crate stays pure** — `npm run check:model-purity` walks
`cargo tree` for `perseverance-model` across normal, build *and* dev edges and
fails on Tauri, any HTTP client, any async runtime that opens sockets, any
browser engine or driver, `portable-pty`, and anything else that would give the
model a child process. Dev edges are included because the claim covers the tests
too.

**The agent crate depends on nothing** — `npm run check:agent-solitude` walks
the same three edge kinds for `perseverance-agent` and fails if `cargo tree`
names any crate but itself. Nothing is forbidden by name, because the rule is
stronger than a list: planning is pure, so an adapter is a golden-argv assertion
and needs no crate to be one. It is also the arrow ADR 0002 rests on — the
harvest became its own crate so that #45's planner-side work would never be
forced to name it, and until this check existed that was held by review. It puts
known-bad `cargo tree` output through its own verdict function, which catches a
check that has stopped detecting anything but not a check invoked with the wrong
flags.

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
- **No Windows machine ran any of the environment harvest.** The PowerShell
  payload, its UTF-16LE-and-base64 encoding, the profile-relocation test and the
  CLIXML classification were all authored and unit-tested from macOS. Both
  platforms' argv and both platforms' frame grammar are values built from
  parameters rather than `#[cfg]` bodies, so `macos-latest` does assert the
  Windows plan — but asserting a plan is not running it, and the first
  `windows-latest` job is a real gate rather than a formality.
- **The Windows payload is not the one that was measured.** #26 measured a
  line-oriented `Get-ChildItem Env: | ForEach-Object` and said outright that
  this payload is the part that must change; *must change* is not *was measured
  after changing*. Writing hand-encoded UTF-8 straight to `OpenStandardOutput()`
  removes the dependence on `[Console]::OutputEncoding` and on the host's
  formatter, which is the strongest form available and still unmeasured. It
  fails loudly if it is wrong — no mark pair, a recorded condition, an app that
  opens.
- **A harvest that looks complete may not be.** A PowerShell profile that calls
  `exit` half-way yields exit 0, both marks, ninety variables and a stderr at
  the exact no-profile baseline; under `AllSigned` the profile does not run at
  all and the harvest degrades silently to plain inheritance. Every structural
  check passes in both cases. The verbatim `PATH` in the diagnostics panel
  exists partly so an operator *could* notice; nothing makes them.
- **Resolvable is not spawnable, and spawnable is not correct.** A `PATH` that
  resolves `codex` says nothing about whether its `#!/usr/bin/env node` shebang
  resolves at exec time — #21 measured that exact 127 — and a version pin to
  something uninstalled starts the wrong interpreter successfully with nothing
  on either stream. This slice's harvest runs at the root and cannot see the
  second at all; the per-folder remedy is #45.
- **The bound values are inferences.** 8 s / 2 s on unix and 20 s / 5 s on
  Windows sit above every legitimate run anyone has timed, but nobody has run a
  p10k-plus-conda rc or a corporate profile with a dozen module imports against
  them. Too tight and an operator loses their environment and gets a sentence
  saying so: recoverable, visible, and still wrong.
- **The harvest kills the shell it spawned and reaches no further.** A daemon an
  operator's rc started on purpose is theirs, so an rc that backgrounds one
  leaks a process per launch — exactly as it would if they had opened a
  terminal. #45 makes that one per folder open, and that is the ticket where the
  decision has to be re-argued.
- **`gh auth token` is spawned for real in exactly one line no runner can
  exercise honestly.** A GitHub runner has `gh` installed and has never signed
  in, so every branch of the interpretation is tested against a fabricated
  capture and a fake `gh` on a temporary `PATH`. A typo in `["auth", "token"]`
  would still ship green. The two `#[ignore]`d tests that would catch it —
  `cargo test --workspace -- --ignored` — ask this machine for its own
  operator's login shell and its own `gh`, which is why no runner takes them.
- **The environment readout is two mirrors kept true by hand.** `crates/app`
  and `src/environment/environment.ts` each assert nine keys, and a rename that
  updated both tests would be exactly as silent as no test at all. Same cost ADR
  0001 accepted for the repo bindings, same defence. The map list is a third
  such mirror, between `crates/app`'s `MapsView` and `src/maps/maps.ts`.
- **The GraphQL document meets a real schema in exactly one `#[ignore]`d test.**
  Every other test in `perseverance-github` reads a recorded response, so a
  renamed field, a bad argument name or a query that costs more than it should
  would all ship green. `cargo test --workspace -- --ignored` on a machine whose
  operator has signed in is the only thing that catches them, and no runner
  takes it.
- **Nothing polls yet.** A map created outside the app appears the next time the
  folder is opened, because that is the only thing that currently triggers a
  read. The cadence ladder, the off-cadence pokes and the interval composition
  are #38; the budget floor is #39 and the backoff is #40. `rateLimit` is read
  and carried to the WebView, and acted on by nobody.
- **Linux has never built the TLS stack.** `ureq` verifies certificates against
  the operator's own trust store via `rustls-platform-verifier`, which supports
  Linux — but both CI runners are Windows and macOS by design, so nothing here
  has ever compiled it there.
- **The read cache is written on every successful read, not only on a differing
  one.** The spec's rule is *write on read-from-GitHub only, and only when the
  derived model differs*; the second half needs the derived model to compare,
  which is #33. Until then the cost is a redundant write per poll and no
  incorrectness.
