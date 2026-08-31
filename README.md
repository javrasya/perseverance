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
| `perseverance-pty` | PTY and child-process ownership, the per-run ring, when a run opened and when it last printed, the byte channel's contiguity, the deadline a quit gives every run, and refusing a launch whose program is not a native image | Deciding what to run, knowing what a run is working on, or handing over a non-contiguous byte range |
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
so `dev:web` can show a revoked token without one existing. And so does the run
pane: `src/terminal/fixtures.ts` carries a rack of readouts named by `?runs=`,
because a wedged AFK run wants five minutes of a research run saying nothing and
a run waiting on its CLI's trust prompt wants a machine state, not a click.
Those are hand-written rather than generated — a run readout is not part of
`Snapshot` and nothing emits one — so the `RunReadout` type and the two tests
that pin the wire shape are the whole of their defence.

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

The node panel is where a number becomes a name. It is chrome rather than a view
— the Route draws the map, this describes the one row you picked — and it prints
nine fields about it: the question, the type, the
state with the map's own designation beside it, the blockers and what waits on
this one *named* rather than counted, the claim, the dates, the resolution and
the link out. **It never renders empty.** No map open, a map with no children,
nothing picked, a selection whose row went away under a re-poll, and a node are
five states with five different sentences, because a panel that can go blank
looks the same whether the click missed or the app broke.

It is also a **boarding pass**: one element with three addresses — a strip along
the spine under the body, the run bar, and the rack — moved between them by the
same imperative-reparent primitive the terminals use, so a re-dock is a move and
never a remount. The panel is never unmounted, which is what makes the scroll
offset you left it at and the text you had selected in it still be there on the
far side of the move; the selection it prints is the store's and it writes
nothing. Which dock is a press and never an arrival, so no poll can relocate it
— with one exception that is measurement rather than automation: the `map`
detent leaves the terminal side worth no pixels, so a dock on that side lends the
pass back to the spine until the width returns, and both docks say so in a
sentence. **A dock without the pass is never a blank box**; it names where the
panel went and offers to take it back.
[ADR 0025](docs/adr/0025-the-node-panel-is-one-element-with-three-addresses.md)
records the decision the panel and the pass are two halves of — why a reading
position is what makes a re-dock a move rather than a remount, why the scroller
travels with the pass instead of belonging to a dock, why the markdown is
rendered here rather than fetched rendered or painted in Rust, and the tests that
falsify each.

What is deliberately not in it is the more interesting half. There is **no issue
body**: the graph query never asks for one, so the title is the whole question
and nothing on screen implies otherwise. There is **no claimant**: how many
people are on a ticket crosses the seam and their names do not, so the panel
says a claim is held and says, in the open, that it is not told by whom. There
are **no timestamps**: the model reads none, and the field says so with its
reason rather than showing a blank or a zero — a fact the harness was never told
is form-level distinct from a count that is genuinely nought, everywhere on this
panel. The URL is **text you select and copy** and not an anchor, because this
WebView has no opener and a live link would navigate the app away from itself.
And the markdown that arrives from a map document — a cut's reason — is rendered
**here**, by a subset renderer that emits React elements and never an HTML
string: no GitHub render endpoint spending a rationed request per
paint, nothing pre-painted in Rust, and raw HTML in an issue body landing on
screen as its own characters because no parser in the path could have made an
element of it. `tests/no-raw-html.test.ts` holds that absence to the whole of
`src/`.

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

Three adapters ship — Claude Code, Codex and Pi — and they are **one shape**:
each plans `[program, prompt]`, each states the same `TERM` because the terminal
type is a fact about the PTY this harness presents and not about a vendor, and
each takes the default `watch`. Codex's `-C/--cd`, Pi's `@file` splice and every
trust, approval and offline flag are declined for all three, because picking
those per vendor is what would shape the product like three vendors' CLIs. What
does differ is declared and only declared: the names to look for, the interpreter
probes, and the scrub set. The scrub sets are asymmetric — Pi takes away three
pointers at a *parent* session, Codex takes away nothing, because nothing in the
evidence can suppress a Codex session record — and the variables each agent keeps
its own history under are named in the code as deliberately left alone.
[ADR 0012](docs/adr/0012-three-adapters-are-one-shape.md) records the shape, the
declined flags, the asymmetry and the unknowns it inherits.

`perseverance-pty` owns every terminal. It spawns through `portable-pty` into a
job object, drains each PTY into a per-run ring on its own thread, and answers
the cursor-position query ConPTY will not start without — in the plumbing, so a
run nobody is watching gets it too. **Lag-drop cannot mean dropping bytes**: a VT
stream is not sampleable, so the ring reduces only by dropping whole scrollback
from the front, the channel stops and replays whole rather than sending a gap,
and truncation is printed in the chrome and never into the stream.
[ADR 0013](docs/adr/0013-lag-drop-cannot-mean-dropping-bytes.md) records the
decision, what it costs, and the property test that falsifies it.

**What a run was told is chrome beside its terminal.** The prompt a press was
answered with is kept per run for as long as the window is open and printed
above the emulator as a collapsed block that unfolds in place, its summary line
carrying the character count Rust gave and a **stock/custom** badge — whose
prose this run was started on is the first thing a bug report needs, and ~1.5K
of it unfolded would be the whole first screen. A run this window did not start
has no block at all.

There is one xterm.js instance per run and it is moved between the pane and a
hidden stow by relocating its DOM node — the same imperative-reparent primitive
the node panel's boarding pass is moved between its three docks by, so the app
has one such mechanism rather than two. There
is also one pane geometry for every live run, changed **only** on a settled
gesture: `src/panes/geometry.ts` names all five occasions a size can arrive on
and lets exactly one of them through, and `crates/pty`'s `Panes` has a single
method that yields a resize, so bind, peek, drag and arrival have nothing to
call. That is what makes *never resize on bind* an invariant rather than an
assertion — a resize that landed mid-grilling would rewrap what the operator was
typing. The cost is accepted and named: a background research PTY is reflowed by
a dial it has nothing to do with.

**A quit is one confirmation and one deadline.** One dialog however many runs
are live, naming per run what that run loses — a work run's claim is a GitHub
assignment nothing here holds, so it survives; a research run keeps nothing. The
question is asked on the **close request**, while there is still a window to
keep: `ExitRequested` arrives only after the last window has been destroyed, so
a confirmation hung off it would make *Keep working* mean a headless process
holding every terminal. macOS gets a menu of this app's own for the same reason
— its default Quit is AppKit's `terminate:`, which reaches no handler here.
Then every run is hung up on at once, given one two-second grace between them
rather than one each, and killed. *Hanging up* releases only the write end of
the PTY; the read end is `ClosePseudoConsole` on Windows, an unconditional
terminate rather than something a child gets to answer. Nothing about a run is
written down, so there is no reattach machinery and nothing to keep in sync.
[ADR 0014](docs/adr/0014-a-quit-is-one-confirmation-and-one-deadline.md) records
the platform mapping, why the confirmation is native rather than in the WebView,
and what it does not decide.

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

Eleven rules that would otherwise be conventions. Each is enforced on both CI
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

**Nothing looks anywhere a `PATH` did not name** —
`npm run check:no-install-probing` reads the six files that resolve a program
name, strips their comments and their `#[cfg(test)] mod tests` blocks, and fails
on a hardcoded install directory (`/opt/homebrew`, `.local/bin`, `Program Files`,
the npm global roots) or on shelling out to something that answers with one
(`where.exe`, `Get-Command`, `command -v`, `whereis`). Resolution has two tiers —
the folder's harvested environment, then an explicit override — and a third that
guessed would not be *incomplete*, it would **diverge**, silently, from what the
operator's own shell resolves. It puts known-bad and known-good input through its
own verdict function, so it catches both a check that has stopped detecting
anything and one that would reject the prose arguing its own case.

**SMIL is prohibited** — `tests/no-smil.test.ts`. `prefers-reduced-motion` does
not touch SMIL, so a liveness pulse authored that way survives the media query
silently and breaks the still-state rule in the one state that matters. CSS
animation and transitions only. The prohibition is stack-level precisely
because it is invisible in review.

**Motion is rationed, and reduced motion takes travel rather than colour** —
`tests/motion-ration.test.ts`. Because SMIL is banned, every animation in this
app is CSS text, so the ration is a set that can be *collected*: every
`animation` declaration and every keyframes block under `src/`, held against a
list that names, per selector and per keyframes name, the liveness claim the
motion is spent on. Rule 9 rations motion to running-vs-stale and this side of
the seam has no running bit, so the list settles what the one animation is
allowed to mean: `claimed` is the only node state that is in progress rather
than a settled fact about the graph, and that is the liveness this half of the
app can carry. The list is one entry — the claimed mark's halo — and
growing it costs an argument in the test rather than a line in an allow-list: a
second animation anywhere, or that one moving to a selector carrying no claim,
is red. *Anywhere* is checked rather than assumed: a companion guard in the same
file walks the wider net `tests/no-smil.test.ts` uses — every `.ts`, `.tsx`,
`.svg` and `.html` under `src/` plus the root `index.html` — and goes red on an
`@keyframes`, an `animation` declaration, an `animation` assigned onto a style
attribute from script, or a call into the Web Animations API (an `animate` on an
element, an `Animation` constructed by hand, a handle taken from
`getAnimations`) written anywhere but a rationed stylesheet, so an inline style,
a `<style>` block in an `.svg`, a keyframes block in `index.html` or motion
started from JavaScript with no CSS text anywhere cannot spend motion the ration
never sees. The fix for
that red is to move the motion into a stylesheet and argue for its licence
there. The same walk reads the `prefers-reduced-motion` guard, which is global
and is the only one allowed to exist: what it kills is looping animation and
travel — transform, translate, rotate, scale, any geometric length — and what
it keeps is opacity, colour and stroke, because the trigger is movement and a
crossfade is not movement. A blanket `transition: none` is the wrong default and
fails the same check. Rule 12 then reads the *rendering* against the same walk
([the conformance suite](#the-conformance-suite)): whatever the stylesheets
animate owes a still form, so an animation added with none turns rule 12 red in
the browser suite instead of going uncovered.

**Views consume semantic tokens only** — `tests/token-tiers.test.ts`. Three
tiers: `--p-*` primitives defined in one file, `--s-*` semantics that name a
job rather than a value, `--c-*` component tokens local to a module. Only the
semantic file may read a primitive, and no stylesheet may carry a raw colour
literal. That is what makes *survives a retheme* checkable: a retheme is a
reassignment in `semantic.css`, and nothing re-renders.

**One file names a change, and it names only what was true** —
`tests/ledger.test.ts`. Every word the change ledger renders lives in
`src/chrome/ledger.ts` and in no other file under `src/`, and the scan is built
out of the constants themselves rather than out of a list beside them. The
second half is the one worth the CI time: no causal connective appears in the
three files the record is written across, *or* in the vocabulary's values, or in
any string the describe functions build from them. Two resolutions arriving in
one diff make *which one unblocked this* a guess dressed as a record, and the
model carries no edge from one change to another that anybody could settle it
from. [ADR 0010](docs/adr/0010-the-change-ledger-is-a-notification-surface-not-an-archive.md).

**No view can see the change ledger** — `tests/views.test.ts`. `ViewProps` is
declared once, names `model`, `selected` and `onSelect`, and mentions neither
the snapshot the record rides on nor the record itself; no file under
`src/views/` but that declaration has a word for it. *No view renders the
record* is then a property of a type rather than a rule every view added later
has to keep — the same mechanism that keeps `blockedBy` and `assignees` out of
the WebView.

**Thirteen contract rules, each with one tier** — `src/contract/rules.ts` and
`tests/contract-registry.test.ts`. The encoding contract is one sentence per
rule and one tier per rule, and the tier is the load-bearing half: *structural*
means a violation is unexpressible — there is no prop, no column to write it
into; *asserted* means a test decides and a red test is the failure, with no
appeal; *judged* means part of the obligation is about what a person reads, so a
person decides and a deviation must be declared. A tier is a fact about today's
design rather than a rank among the rules — widen `ViewProps` and rule 7 stops
being structural with its sentence unchanged — so the registry names the file
each structural mechanism lives in and the test reads it back out of the tree.
[ADR 0020](docs/adr/0020-the-contract-is-thirteen-rules-in-three-tiers.md).

**Every judged rule is declared per view, in prose** —
`tests/contract-declarations.test.ts` and `docs/contract/declarations/`. A rule
a person keeps leaves no artifact but writing, and a rule nobody wrote about is
indistinguishable from a rule nobody has a problem with, so each registered view
files a falsifiable paragraph under each of the five judged rules saying what it
actually does — free to say it does not comply. **Presence is asserted and
content is not**: a missing or stubbed section is red, and no test grades the
answer, because grading it would be the assertion the tier already said cannot
exist. Checkboxes are banned in a declaration and the parser goes red on one — a
box gets ticked, and by the third view a ticked box is a rubber stamp. Three
gates key the check to what changed: adding a value the model can take (each of
`NodeState` and `Phase` is crossed with the checked-in fixtures, so a state or a
rung no fixture reaches is red until the fixture reaching it lands — and the
fixture is cheap because the fixture space is derived from `FIXTURE_NAMES`, with
no second enumeration of fixture names allowed to exist), adding a view (driven off `VIEWS`, so a new view is red until it has
declarations), and adding a rule (driven off the registry, so a rule landing in
*judged* retro-fits a section onto every view). A declared deviation is a
paragraph opening `Deviation:` — the only structure the format has, stated in
the declarations themselves, with a near miss (bold, a bullet, an em dash, or
the sentence buried mid-paragraph) red rather than silent — and it is collected
verbatim into a worklist to be worked off, never a carve-out. The
declarations are read when a view is designed or redesigned, not at every
commit.

**The contract matrix is an instrument and gates nothing** — `docs/contract/matrix.md`,
regenerated by `npm run contract:matrix`. One row per rule with its tier, its
subject, where it is enforced and each view's declaration status, plus the
worklist and the open obligations that have no deviation route. Rows are rules
and never rule × rendered state: the unit of conformance is the rule, and a grid
of cells is an artifact that goes stale in a way nothing fails. The only thing
`tests/contract-matrix.test.ts` asserts about it is that it is current — a test
that read a cell for conformance would make the file the contract, and then a
rule would be kept by whoever last regenerated it.

**macOS is the CSS floor, not Windows** — `npm run check:css-floor`. Windows
ships an evergreen WebView; macOS ships one pinned to the OS version. macOS 13
/ Safari 16.4 is declared once in `package.json`'s `browserslist` and read from
there by both stylelint and the Vite build target, so a violation is a build
error rather than someone else's rendering surprise.

**The rendered rules are settled in a real browser, and the required one is
WebKit** — `npm run test:conformance`, `playwright.config.ts`,
`tests/conformance/`. A theme is a `prefers-color-scheme` reassignment and
motion is a `prefers-reduced-motion` guard; jsdom computes neither, so a rule
about what is on screen cannot be settled by `npm test`. The suite drives an
engine against the `dev:web` boot — no Rust, no PTY, no GitHub, only the
checked-in fixtures — and `tests/conformance/support/drive.ts` turns one point
of the fixture space (fixtures × two themes × reduced motion, crossed once in
`tests/support/contract.ts`) into a loaded page. **WebKit is required and
Chromium is opt-in**: Windows ships an evergreen WebView, macOS ships one
pinned to the OS version and exposes no WebDriver, so this is the only
automated thing that will ever exercise the tighter floor in a browser, and a
Chromium-only run would be systematically blind to the platform most likely to
break first. CI installs and runs WebKit and depends on it; Chromium
(`npm run test:conformance:chromium`) is the second reading a developer can
ask for, and is never what a build depends on. The suite needs a downloaded
browser, so it is kept out of `npm test` and `npm run verify` — those stay
runnable on a bare checkout.

**The suite writes its own assertions** — `tests/conformance/rules.spec.ts`.
Nothing in it enumerates anything: the rules are `renderBoundRules()`, the views
are `VIEWS`, the fixtures are `FIXTURE_NAMES` and the crossing is `fixtureSpace`,
so adding a fixture — or a view — produces assertions across every render-bound
rule with no test code written anywhere. One page load per view × state, and
every applicable rule reads that one rendering; a rule that loaded its own page
would turn seventy tests into six hundred navigations and a suite nobody runs.
`tests/conformance/support/rules.ts` holds one entry per render-bound rule and a
gate goes red if one is missing: an entry may legitimately assert nothing, but
only for a wholly judged rule — one whose tier says a machine settles nothing
and which declares no asserted floor — and it has to say so in prose, because a
rule the suite quietly stopped covering is worse than no suite. A check that cannot apply to a
point of the space (no map is open; this fixture has no cut ticket) skips on a
precondition read off the fixture's own snapshot and annotates the report with
it. `tests/conformance/support/views.ts` is where a view declares how the
contract reads in it — its root, whether a given fixture puts it on screen, its
rows, its designated encoding — so the checks name no view's selectors.

**The skips are counted, not just annotated** —
`tests/conformance-coverage.test.ts`. An entry existing is not an entry firing.
A check that skips at *every* point of the space is green exactly the way one
that holds everywhere is green, with the difference living only in a report
nobody opens on a passing run — so deleting the two fixtures that carry a cut
ticket would leave rule 6 asserting nothing anywhere and the suite still all
green. Each entry's precondition is therefore separable from its assertion
(`RuleEntry.applies`) and answerable without a browser: it reads the fixture's
own `Snapshot`, the point's theme and motion, and what the view declares about
mounting. This gate walks `VIEWS` × `fixtureSpace(FIXTURE_NAMES)` with those
preconditions and goes red on any entry with a check and nowhere left to apply
— today rule 6 applies at 8 of 76 points and rule 12 at 12, which is a margin
worth knowing has not gone to zero. It is a vitest test rather than a
browser one precisely so it runs inside `npm run verify` on a bare checkout, and
like the other pure checks it is proved against known-bad input — a precondition
met nowhere, and one met everywhere — before it is run over the table.

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
- **A run only learns its ending while its own folder is the selected one.** The
  poller reads the folder that is open, so a run staked in a folder you have
  moved away from stops hearing about its ticket — and moving away is how you
  reach a second one. If that ticket closes while you are elsewhere and the agent
  then exits, the pane says the run stopped with its ticket still open and still
  claimed, about work that finished. Selecting the folder again puts it right on
  the next tick, and nothing was done on the strength of the wrong sentence:
  either ending holds its slot until you end the run yourself. Polling every
  folder a run is staked in is the remedy, and it is deliberately not in v1.
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
- **`nothing_inside_the_terminal_can_raise_a_condition_on_the_graph` names every
  file in `crates/pty/src` by hand.** A file added there escapes the scan until
  someone adds it to the list. The array's length is part of its type, so the
  mistake is at least noticed from one direction.
- **`nothing_about_a_run_is_written_down_when_the_app_quits` names every file in
  `crates/store/src` by hand, with the same escape hatch.** It is the scan that
  discharges *no reattach machinery* by absence, so a file added to that crate
  and not to the list is a place a run could be persisted without the assertion
  noticing. Same mitigation and same limit as the scan above.
- **`Session::spawn` refuses a launch whose process tree it cannot own, and on
  Windows that means a completely empty environment cannot start a child at
  all** — `CreateProcessW` rejects a zero-length environment block with *the
  parameter is incorrect*. Nothing in the product path passes one (a harvest
  always carries at least a `PATH`), so this surfaces as a puzzling sentence
  rather than as a designed refusal.
- **A run's ending is a waited-for exit code and never an end of file.** Measured
  on Windows: ConPTY's output pipe stays open for as long as the harness holds
  the pseudoconsole, so a `cmd.exe` that exited zero at 250 ms produced no EOF at
  five seconds and would have produced none ever. The cost is a second thread per
  run. The end of file a quit sends travels the other way — into the child's
  *input*, where it is a request rather than a report — so it is not an ending
  either: what ends a run is still an exit code, or the deadline running out.
- **The two-second quit grace is a guess, and nothing in this repository has
  measured it.** `GRACE` in `crates/pty/src/runs.rs` is how long every live run
  gets between being hung up on and being killed, and its basis is a bracket
  rather than a measurement. The lower end is eight times the 5 × 50 ms
  `portable-pty` spends between its own `SIGHUP` and its `SIGKILL` — the grace
  inside the kill this quit ends with — so an agent that merely needs to flush is
  not cut off. The upper end is a fifth of the ten seconds all three adapters
  *declare* for readiness; `Ready` is declared and not implemented on any of
  them, so nothing spends those ten seconds today and that end of the bracket is
  a shape borrowed from a number nobody has run. `docs/research/pty-spawn-agent-clis.md`
  §8 measured what reaps a tree and never how long a tree asks for — no
  time-from-end-of-input-to-exit exists for `claude`, `codex` or `pi` on either
  platform, and that measurement is the whole of what would settle it. The
  revisit trigger is the first report of an agent killed mid-write: that is the
  failure this number would be wrong about, and it is a visible one.
- **On Windows the hang-up is an interrupt, not an end of file, so the grace is
  a unix mechanism in practice.** Measured on this repository's own harness: a
  run of `ping -n 31`, which never reads its input, is over inside a tenth of a
  second of the pseudoconsole's input pipe closing, with exit code
  `STATUS_CONTROL_C_EXIT` — the console host breaks the session rather than
  delivering an EOF anything could ignore. So on Windows the two seconds are
  almost never spent, and `one_quit_is_one_deadline_and_not_one_per_run` asserts
  its lower bound on unix only, with `hanging_up_ends_a_windows_run_by_itself`
  pinning the Windows half instead. The read end is still held until the deadline
  passes, because dropping the master is `ClosePseudoConsole` — an unconditional
  terminate of every attached process, eighteen of them measured in
  `docs/research/pty-spawn-agent-clis.md` §8.1 — and an interrupt a child may
  answer is not the same offer as one it may not.
- **On macOS the end of file is `\n` and the terminal's `VEOF`, which is a
  request and not a guarantee.** That is a real end of file to a child in
  canonical mode and a `Ctrl-D` to a full-screen agent in raw mode, and most TUIs
  quit on it — but nothing obliges one to, which is the reason there is a
  deadline behind it at all. The `\n` is `portable-pty`'s and it is not free: to
  an agent in raw mode it arrives as a literal `0x0A`, which most prompt widgets
  read as *submit*, so a half-typed prompt can be sent as the last thing that
  happens before the run is ended. There is no way to write the `VEOF` without
  it from here, and the quit it belongs to has already been confirmed against a
  sentence saying the run is about to end.
- **A macOS grandchild that both ignores `SIGHUP` and has left the controlling
  terminal's foreground process group would survive a quit.** The kill on unix is
  the *owned* child's — `SIGHUP`, five 50 ms looks, then `SIGKILL` — plus the
  kernel's hangup of the terminal's foreground group once the leader is gone. A
  direct child that ignores `SIGHUP` is therefore killed anyway, and
  `a_run_that_ignores_the_hangup_does_not_survive_the_quit` pins that; a
  *grandchild* that has put itself outside both the process group and the signal
  is outside the reach of anything this app may do without `libc` and `unsafe`.
  Nothing measured says the agent CLIs produce one, and the Windows job object
  has no such gap — this is the shape of the platform asymmetry, not a bug on one
  side of it.
- **A stranded claim being reachable through Resume on the next launch is not
  demonstrable on this branch.** A claim is a GitHub assignment and nothing this
  process holds; claiming is #48's and Resume is #49's, and both are open. What
  #51 owns is the half that makes the criterion possible: nothing about a run is
  written down — `nothing_about_a_run_is_written_down_when_the_app_quits` pins
  the shipped schema at `folders`, `app` and `graph_cache` and pins every file in
  `crates/store` as naming no session and no run — so there is nothing to
  reattach to, and the assignment is all that survives. That it is then *reached*
  is somebody else's ticket, and it is not ticked here.
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
  the exact no-profile baseline. Every structural check passes. The verbatim
  `PATH` in the diagnostics panel exists partly so an operator *could* notice;
  nothing makes them.
- **The `AllSigned` degradation is named from what the interpreter wrote, and
  only in a language this reads.** `degradation_in` matches two token groups —
  the two wordings the interpreter is known to write, and no third one reaching
  for the help topic it points at, because `about_Execution_Policies` flattens
  with its underscores intact and a group that cannot fire is not coverage —
  against a flattened copy of the stderr that is captured on every path —
  PowerShell escapes its hard wrap as `_x000D__x000A_` mid-word — and never on
  `StderrKind::Clixml` or on the stream being non-empty, since the Windows
  baseline is a non-empty CLIXML stream with no profile at all. So an interpreter
  that declines *silently*, or in a locale whose refusal is worded differently,
  still degrades to plain inheritance with nothing on screen to say so. The
  transcript both sides match is pinned twice — a Rust `const` in
  `crates/env/src/harvest.rs` and the `windowsClean` fixture — so the two copies
  cannot drift apart, and `-ExecutionPolicy` is still absent from the argv,
  because overriding the operator's own policy is refused rather than
  unimplemented.
- **Resolvable is not spawnable, and spawnable is not correct.** A `PATH` that
  resolves `codex` says nothing about whether its `#!/usr/bin/env node` shebang
  resolves at exec time — #21 measured that exact 127 — and a version pin to
  something uninstalled starts the wrong interpreter successfully with nothing
  on either stream. The per-folder harvest makes the second *inspectable* rather
  than detected: the readout shows the absolute file each name resolved to in
  that folder's own environment, which is the only visible form a pin has. It
  does not check it, and nothing here ever will.
- **A folder's answer stands until the operator asks again.** Invalidation is
  *Ask again* and nothing else: no TTL and no filesystem watcher, because the
  dangerous case is *pin unchanged, installed set changed*, which no watcher over
  the folder can see and a clock would only re-take at random. The cost is that a
  tool installed while a folder is open is invisible until somebody says so. The
  cache is keyed on the canonicalised absolute spawn directory, so two spellings
  of one folder are one answer — which deletes the worktree question rather than
  answering it, and means a relocated folder simply gets a new one.
- **A declared probe can read *not on this PATH* on a perfectly good install.**
  `ClaudeCode` declares `Probes::NONE`, on the argument that its supported
  installs are native images and a shim is refused by
  `perseverance_pty::accept` rather than sniffed; #46's two adapters declare
  `node --version`, and Pi's differ by platform — Windows is also asked for
  `bash --version`, because pi's own `bash` tool fails at *runtime* without one.
  A Homebrew or standalone-release Codex is a native image with no `node` behind
  it at all, so its probe answers *nothing of that name* on a machine where
  nothing is wrong. Nothing parses or compares a probe, and the panel has no
  sentence yet saying that an answer of nothing may be fine.
- **There is still no spawn.** `perseverance_pty::accept` has no caller, and
  `Launch::under` — the one composition rule an override has — is asserted by
  golden tests and run by nothing. So *Retry re-harvests, then respawns* is
  half-wired: `retry_folder_environment` re-harvests and re-resolves, and #47 is
  what will call it before starting anything.
- **The guard against install-location probing is an allowlist of six files.**
  A resolution path added in a file not on `SURFACE` in
  `scripts/check-no-install-probing.mjs` escapes the scan entirely — the same
  honest limit `PTY_SOURCES` already carries, and unlike the agent-source scan
  there is no self-check that would notice a seventh resolving file appearing.
- **The bound values are inferences.** 8 s / 2 s on unix and 20 s / 5 s on
  Windows sit above every legitimate run anyone has timed, but nobody has run a
  p10k-plus-conda rc or a corporate profile with a dozen module imports against
  them. Too tight and an operator loses their environment and gets a sentence
  saying so: recoverable, visible, and still wrong.
- **`gh auth token` is spawned for real in exactly one line no runner can
  exercise honestly.** A GitHub runner has `gh` installed and has never signed
  in, so every branch of the interpretation is tested against a fabricated
  capture and a fake `gh` on a temporary `PATH`. A typo in `["auth", "token"]`
  would still ship green. The two `#[ignore]`d tests that would catch it —
  `cargo test --workspace -- --ignored` — ask this machine for its own
  operator's login shell and its own `gh`, which is why no runner takes them.
- **The environment readout is two mirrors kept true by hand.** `crates/app`
  and `src/environment/environment.ts` each assert ten keys, and a rename that
  updated both tests would be exactly as silent as no test at all. Same cost ADR
  0001 accepted for the repo bindings, same defence. The per-folder readout is a
  second such pair — twelve keys, `crates/app` and `src/environment/folder.ts` —
  and the map list a third, between `crates/app`'s `MapsView` and
  `src/maps/maps.ts`.
- **The harvest kills the shell it spawned and reaches no further, once per
  folder now rather than once per launch.** An rc that backgrounds a daemon on
  purpose leaks one per folder opened, exactly as it would if the operator had
  opened that many terminals. The cwd-keyed cache is what bounds it: a folder is
  harvested once and asked again only when somebody presses *Ask again*.
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
- **One of the three pokes has no producer, and deliberately so.** An adapter's
  `Idle` is not waiting on a ticket: **all three** shipped adapters take the
  default `watch`, which classifies nothing — the whole out-of-band tier is cut
  from v1, a live signal would mean only *poll sooner*, and polling never
  stopped. Three adapters producing no signal is a stronger claim than one did:
  no call site can have grown a branch on whether an adapter watches, because
  none of them does and every call site works anyway. So the type is here and
  deliberately unproduced. The other two are produced now that #48 *Start
  Working* spawns: `start_working` holds a `RunHandle` through
  `Terminals::counting`, so the run-live rung is reached in a running build and
  a run's process exit arrives on the channel the poller is told about.
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
  spawns `claude`, `codex` or `pi`.** The Claude Code adapter's two argv
  elements, its scrubbed `CLAUDE_CODE_CHILD_SESSION`, its `TERM`, and the
  ~223 ms alternate-screen measurement behind its ten-second readiness timeout
  all come from `docs/research/pty-spawn-agent-clis.md` — one machine, one day.
  The codex and pi goldens are weaker again: they rest on `--help` output from
  one Windows machine and one Mac on two days in 2026-08, neither adapter's
  time-to-alt-screen has ever been measured, and both reuse Claude's ten seconds
  because there is nothing else to use. A release that moved a prompt behind a
  flag would leave every test here passing. That is the deliberate trade for
  tests that need no async runtime, no PTY and no installed CLI.
- **Both npm-installed adapters are refused by the shim gate, and nothing spawns
  to prove it.** `codex` and `pi` install as `#!/usr/bin/env node` script text on
  macOS and as `.cmd` shims on Windows — the two shapes `perseverance_pty::accept`
  refuses. That is the intended loud failure and #45's argv override is the
  answer, but `accept` still has no caller, so the whole path is untested end to
  end until #47.
- **Linux has never built the TLS stack.** `ureq` verifies certificates against
  the operator's own trust store via `rustls-platform-verifier`, which supports
  Linux — but both CI runners are Windows and macOS by design, so nothing here
  has ever compiled it there.
- **The read cache is written on every successful read, not only on a differing
  one.** The spec's rule is *write on read-from-GitHub only, and only when the
  derived model differs*; the second half needs the derived model to compare,
  which is #33. Until then the cost is a redundant write per poll and no
  incorrectness.
