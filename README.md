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
| `perseverance-pty` | PTY and child-process ownership, and refusing a launch whose program is not a native image | Deciding what to run |
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
a state a fresh browser has no way to reach. The four conditions a read can fail
in — unreachable, auth-failed, map-gone, rate-limited — are four more such
states, and they are generated from the model crate rather than written by hand,
so `dev:web` can show a revoked token without one existing.

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

The Route is the first view, and it is a grouped list in one column with no
graph library, no layout library and no drawn edge anywhere behind it. A fan of
edges reads as capacity, and on a map whose takeable tickets are all
human-in-the-loop that capacity is one — so structure is section membership and
position in the column, and edges get words instead: `blocked by N` on the row
that waits, and a note when a blocker names an issue with no row on this map.
The cost is that the Route cannot say *which* tickets a node opens up, which
belongs to the views that draw the fan, or *which* one blocks a row, which
belongs to the detail panel.
[ADR 0006](docs/adr/0006-the-route-is-a-grouped-list-not-a-graph.md) records the
decision, the readings on both sides of it, and the test that falsifies it.

`perseverance-agent` is a trait with four members and one value. An adapter
names itself, says what to look for, plans a launch, and optionally classifies
bytes — it does not spawn, wait, inject a prompt or decide it is done, because
there is no member on which it could. Planning is pure by signature rather than
by promise: `LaunchContext` derives `Copy`, so no writable handle can ever be a
field of it, and it hands the program and the working directory over as names
rather than as paths, because a path carries `exists`, `metadata` and `read_dir`
as inherent methods that need no import and that no scan of the source would
see. The whole of what an adapter produces is an argument vector, an environment
delta and a readiness rule. That is why per-run configuration *is* argv and
environment: there is nowhere else for it to be said. Which platform a
plan is for is a parameter and never a `cfg!`, so both goldens are asserted from
whichever runner is running. And a launch is checked before anything is spawned
— `perseverance_pty::accept` reads the program's first bytes and refuses
anything that is not a native image, because npm's `claude.cmd` interposes
`cmd.exe` and killing that orphans the agent.
[ADR 0010](docs/adr/0010-the-adapter-contract-is-four-members-and-a-value.md)
records the contract, the invariants that are enforced rather than documented,
and the alternatives it turned down.

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
- **The remembered default view persists to `localStorage` too**, the same
  compromise and the same remedy: app-global, survives restart, and belongs in
  the `app` table the day a command exposes it. The swap is one file
  (`src/views/views.ts`).
- **A dependency on an issue in another repository is not an edge.** The derived
  `Node` carries `waitsOn` — the numbers of every blocker GitHub named, finished
  ones included, which is what a blocked row's `blocked by N` is computed from —
  and `crates/model` drops the ones belonging to another repository, because an
  issue number means nothing outside the repository that issued it and
  `other/repo#75` would otherwise be counted against this map's `#75`. The
  filter compares `nameWithOwner` at both ends and a silence never drops an
  edge, so an answer recorded before either field was asked for keeps its
  blockers. The cost is that a genuine cross-repository dependency is invisible
  rather than reported: it is not in `waitsOn` at all, so it is counted into no
  row's `blocked by N` and the Route cannot say it is beyond the map either —
  which is exactly what it does say for a blocker it can see and cannot judge.
- **Whether GitHub's blocked-by connection lists resolved blockers is taken on
  the evidence of one recorded answer.** `docs/research/github-graph-api-coverage.md`
  names it as unverified — the fixture it was written against had no closed
  issues. `waitsOn` rests on it, and the omission would now be invisible rather
  than loud: nothing ranks, and `blocked by N` skips resolved blockers anyway,
  so the only visible casualty would be a *no row on this map* note about a
  blocker that is both closed and elsewhere. `crates/model` still documents the
  field as carrying every blocker the answer named, so the next reader will
  believe it. It is one query against a real map to settle.
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
- **No rate-limit header has ever been seen from a real GitHub.** Both of the
  documented forms are read in `send` — `Retry-After`, and otherwise
  `x-ratelimit-remaining: 0` beside `x-ratelimit-reset` — resolved to one moment
  in `when_it_resets`, and honoured exactly by `backoff_floor`. From a
  fabricated `Answer` in every test there is: this machine has not tripped a
  secondary rate limit, so the parse (whole numbers, and only whole numbers — an
  HTTP-date `Retry-After` is deliberately refused as *nothing said when*) is
  asserted against text this repository wrote down. A 403 that named a reset in
  neither form still falls back to `AuthFailed`, which stops: the safe direction
  of what is left, and still the wrong answer if GitHub ever adds a third
  form.
- **`NoRepository` reading as `MapGone` is a judgement, not a measurement.**
  `data.repository` is null when the repository is not there *or* when the token
  cannot see it, and the second of those is an auth condition wearing a
  not-found costume. It is classified as gone because the remedy in both cases
  is a decision — pick another folder, or fix what the token can see — rather
  than a wait, and because the alternative reading stops the poller with a
  command that would not help. A token whose scopes were narrowed mid-session
  therefore reads as *GitHub says this is not there*.
- **The budget clause reports which term won, not how much yielding there is.**
  It is on while the budget beats the rung it is being compared against, and the
  rung depends on whether the window has the operator — so over an hour a
  `remaining` between 1024 and 1119 carries the clause in front of you and not
  behind you, at the same budget. That is the acceptance criterion working as
  written; it is also why the clause says *paced against* and never names a
  duration.
- **The `maps` command always answers *not yielding*.** It reads the store and
  has no poller behind it, so first paint never carries the clause; it arrives
  with the first poll. The flag means something only on the `maps` event.
- **A cold process spends two points before it can know it should not.** Nothing
  has been reported yet, so `budget_floor` is handed `None` — no constraint — and
  a poller that has never ticked is due now, so the first poll fires immediately
  even if the budget is already under the reserve. It is unavoidable in this
  shape: reading is the only way to learn the budget, and the number the pacing
  needs arrives on the answer to the read it would have had to skip. Every poll
  after the first is paced.
- **The reserve is defended by this machine's clock against GitHub's `resetAt`.**
  The bias is deliberately late — the horizon is anchored at `fetched_at` while
  the wait is measured from a tick stamped after the read returned — so skew
  polls later than necessary rather than earlier. A badly wrong clock makes the
  pacing nonsense in either direction, and nothing detects that.
- **`QUERY_COST = 2` is a measurement of today's document, not a law.** A field
  added to `map-read.graphql` that repriced the query would make the pacing
  under-wait by whatever it added, and the reserve property would go on passing
  against a number that had stopped being true. The fixture pins it only for as
  long as somebody refreshes the fixture, and the `#[ignore]`d live test is the
  only thing that meets a real schema.
- **Two of the three pokes have no producer, and now for two different
  reasons.** A run's process exit waits on #47, which is the crate that will own
  a child process. An adapter's `Idle` is not waiting on anything: #44 landed the
  contract and the one adapter, and Claude Code takes the default `watch`, which
  classifies nothing — the whole out-of-band tier is cut from v1, a live signal
  would mean only *poll sooner*, and polling never stopped. So the type is here
  and deliberately unproduced. Either way both arrive as things the poller is
  *told about* on a channel, the only thing holding a `RunHandle` today is a
  test, and the run-live rung is unreachable in a running build.
- **A fourth poke the ticket did not ask for.** `EnvironmentSettled` fires when
  the harvest lands, because without it a Windows launch spends 1.5–1.9 s
  harvesting, ticks with no token, and waits a whole rung before the first list
  anybody sees.
- **The poller emits a map list, not a derived model.** `snapshot` is still the
  constant `Snapshot::no_map_open()`: wiring `Model::of` and `Snapshot::aged`
  into the tick is a slice of its own and folding it in here would have doubled
  this diff, and the frontend still reads the snapshot once at mount. So the
  Route pane is drawn from something nothing refreshes.
- **The rung is on screen nowhere, and two of the three floors are.** A poller
  stuck on the five-minute rung looks exactly like one that is working. The
  budget clause paints while the budget is the winning term, and a read that did
  not land paints its condition on the stamp — but a poller merely *backing off*
  after one failure, with the last read still on screen and still recent, is
  indistinguishable from one on the rung. What is visible is the condition, not
  the wait it earned.
- **The PTY rule is asserted by a byte scan over a hand-written list of
  files.** *Nothing printed inside a terminal raises a condition on the graph*
  is held by a test in `crates/app` that reads `crates/pty/src/lib.rs` and
  `crates/pty/src/shim.rs` as bytes and asserts neither names `Degraded`,
  `ReadOutcome`, `MapsView`, `Provenance` or `emit`. Two files, both named in
  the test — so a *third* file added to `crates/pty/src` escapes the scan
  entirely until somebody adds it there. The agent-side scan next to it now
  checks its own list against that crate's `mod` declarations and caught a
  missing file the first time it ran; the PTY scan has no such guard. And the
  crate still owns no terminal: what it holds today is a shim check that reads a
  file and never runs one. #47 is where the rule has to be re-asserted against a
  crate that actually spawns, and where a stronger form than a byte scan becomes
  possible.
- **The agent-side scan reads text, not a parse tree.** *An adapter plans from
  what it was handed* is held by an allowlist — every `std` path
  `crates/agent` names must be `ffi`, `fmt`, `time` or `error` — which is
  syntax-proof in the way a list of forbidden names was not, since a brace group
  or an alias cannot reach a module without naming it after `std::` somewhere.
  What it is not is a compiler: it strips comments with a hand-rolled reader
  that does not know raw string literals, and it lets `println!` through, which
  is I/O in a function documented as doing none. Both are visible side effects
  rather than routes to the operator's config, and both would be caught by a
  lint rather than by a scan.
- **The shim gate has no consumer.** `perseverance_pty::accept` mints an
  `Accepted`, `Accepted` has private fields, and #47's spawn will take one — so
  the check is a constructor rather than a call site anyone could forget. Until
  #47 lands, nothing calls it outside its own tests, and the routing-around it
  exists to prevent has never been attempted.
- **The golden argv is checked against a recording, and nothing in CI ever
  spawns `claude`.** The Claude Code adapter's two argv elements, its scrubbed
  `CLAUDE_CODE_CHILD_SESSION`, its `TERM`, and the ~223 ms alternate-screen
  measurement behind its ten-second readiness timeout all come from
  `docs/research/pty-spawn-agent-clis.md` — one machine, one day. A release that
  moved the prompt behind a flag would leave every test here passing. That is
  the deliberate trade for tests that need no async runtime, no PTY and no
  installed CLI.
- **Linux has never built the TLS stack.** `ureq` verifies certificates against
  the operator's own trust store via `rustls-platform-verifier`, which supports
  Linux — but both CI runners are Windows and macOS by design, so nothing here
  has ever compiled it there.
- **The read cache is written on every successful read, not only on a differing
  one.** The spec's rule is *write on read-from-GitHub only, and only when the
  derived model differs*; the second half needs the derived model to compare,
  which is #33. Until then the cost is a redundant write per poll and no
  incorrectness.
