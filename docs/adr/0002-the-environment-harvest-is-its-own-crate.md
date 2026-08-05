# 2. The environment harvest is its own crate

Status: accepted (2026-08-05)
Context: [#31 Environment harvest and token acquisition](https://github.com/javrasya/perseverance/issues/31),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28), on the
measurements in [#21](https://github.com/javrasya/perseverance/issues/21),
[#24](https://github.com/javrasya/perseverance/issues/24) and
[#26](https://github.com/javrasya/perseverance/issues/26).

## Context

A GUI bundle on macOS is started by launchd with about a dozen variables and
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. `gh` is not on it, and neither is `node`,
which is what two of the three adapters' shims resolve through. So the first
thing this app must do to read GitHub at all is ask the operator's login shell
what the environment should have been, and resolve inside the answer. That is
the harvest. #24 fixes its scope here: one app-global harvest at launch, at the
root, serving `gh auth token` and the first poll. The per-folder harvest, the
cwd-keyed cache and the override are #45.

This is the first child process in the Rust tree, and this workspace has been
careful about child processes. ADR 0001 put repo binding on reading
`.git/config` as text precisely so that `perseverance-store` would stay free of
them, and recorded the rule it was obeying: *"`perseverance-agent` plans and
`perseverance-pty` owns child processes."* That sentence now has to say which
kind of child process it meant, because there are two and they are not alike:

- A **session** — long-lived, PTY-backed, interactive, drained into a per-run
  ring, throttled on the channel to the WebView, resumable, and owned by this
  app until it ends. That is `perseverance-pty`'s whole subject.
- A **measurement** — sub-second, pipe-backed, non-interactive, sentinel-framed,
  read until the frame closes and then abandoned. No terminal, no user, no
  resumption, no output anyone reads. Its entire correctness is a byte grammar.

Almost everything #26 measured is a property of the second and meaningless for
the first. A background grandchild holding the write handle for four seconds
past a clean exit is a *harvest* failure mode, because a harvest stops reading
at a mark; a session reads until the session ends and would never notice. A
harvest has no notion of quiet-versus-wedged (#50), because a harvest that has
gone quiet is simply over.

Three facts in the tree decide the placement:

1. `perseverance-github` must run `gh auth token` **inside** the harvested
   environment (AC5), so it has to be able to name the environment type.
2. `crates/agent/src/lib.rs` says two things at once: *"Deliberately depends on
   nothing. A dependency here would be a claim that planning needs the world"*,
   and that #45 will do per-folder resolution and the environment readout.
   Whatever #45 turns out to be, the crate the tree currently says will do it is
   the one crate that may not gain an edge. So the harvest's product must be
   nameable by a planner without the planner depending on anything — which means
   the product's accessors return `std` types, and the crate that produces it
   must not be one the planner is forced to name.
3. `perseverance-pty` already depends on `perseverance-agent`. So a harvest
   sited in `pty` puts `github → pty → agent`: the poller would compile the
   adapter trait in order to ask for a token, and #45's agent-side work would
   have to name a type living downstream of itself. The first is ugly. The
   second is a cycle.

## Decision

A seventh crate, `perseverance-env` at `crates/env`. Its `[dependencies]` is one
line, `thiserror`; its `[dev-dependencies]` is one line, `tempfile`, for the
same reason the store has one.

It **owns** which shell is spawned and which flags it is given, the payload
text, the per-run nonce, the frame grammar and its parser, the record shape
check, the two bounds, the process handling, the classification of stderr,
resolving a program name against a harvested `PATH`, and one bounded `run_in`
that runs a single program inside a harvested environment.

It **never** opens a socket, knows Tauri exists, allocates a terminal, or writes
a file. `perseverance-model` does not depend on it in either direction, and
`scripts/check-model-purity.mjs` now says so.

Its product is `Environment`: names as text, values as bytes, behind accessors
that return `&str` and `&[u8]`. It derives no `Serialize` and *cannot* — there
is no serde in this crate's tree. That is the enforcement of *the harvested
environment never touches disk*, and it is a compile error rather than a
convention.

`perseverance-github` gains `perseverance-env` and one module, `token`, because
that crate's own doc already claims this: *"the token comes from `gh auth
token` at runtime and is never stored."* The mechanism is env's; the policy —
which command, what a refusal is called, and that a refusal never repeats what
`gh` printed to stdout — is github's. **After this change `perseverance-github`
still constructs no child process of its own**: it names `run_in` and nothing
else. That is the single strongest consequence of the placement, and it is why
the socket crate's charter survives intact.

`perseverance-app` gains one piece of state, one command, one event and the wire
types, and that is wiring in ADR 0001's sense: `EnvironmentReadout` is to
`HarvestAttempt` what `RepoBinding` is to `RepoBindingError`.

Three module docs are corrected so that no two documents in the tree disagree
about who may spawn:

- `crates/pty/src/lib.rs` gains a clause saying it owns the child processes the
  operator *watches* — the ones with a terminal, a ring and an ending — and that
  a harvest is not one; and a second clause saying that #51's *no orphans* is a
  promise about those children, not about whatever an operator's own start-up
  files background.
- `crates/store/src/repo.rs`'s aside "those belong to `perseverance-pty`"
  becomes "a child process belongs to `perseverance-pty` or to
  `perseverance-env`", neither of which is a crate whose subject is a file on
  this disk.
- `crates/agent/src/lib.rs`'s #45 line is split. Per-folder *harvesting* and the
  cwd-keyed cache are env's; the adapter's declared probes, the readout's
  interpretation and the override's resolution rule stay agent's, and none of
  them needs an edge, because `Environment`'s accessors hand back `std` types.
  Without this edit two crates would claim one ticket's items and this document
  would be contradicted by a module doc on the day it lands. It is a deliberate
  re-attribution and it is the part of this decision most worth pushing back on.

## Alternatives

**`perseverance-github`, where the walking skeleton's *Filled in by* line put
it.** That line named #31, and it was right about the token: which command to
ask, what a refusal is called, and the rule that a refusal carries `gh`'s stderr
and never its stdout are all policy about GitHub access and all stayed there.
It was wrong about the mechanism. Rejected on #45: routing every agent spawn's
environment through the crate whose defining property is that it is the only one
permitted to open a socket makes the socket boundary meaningless within one
ticket. The seam would also be inverted from the day it ships, because
`Environment`, `Bounds` and the frame types would be exported from the network
crate and every downstream consumer would have to name it to get one — including
`perseverance-pty` at #47, which has no business compiling an HTTP client to
apply a `PATH`. The cost of splitting it is the one edge this document has to
justify at all: `github → env`, a dependency on a mechanism, in exchange for the
crate constructing no child process. The line is edited to read *"#31 token
acquisition, in the environment `perseverance-env` harvested"*, not honoured as
written.

**`perseverance-pty`, on ADR 0001's own ruling.** The closest call, and the
reason this document exists. Rejected twice over. Its stated *Never* is
**deciding what to run**, and the substance of a harvest is exactly that
decision — `$SHELL -lic` rather than `-lc`, `-NoLogo` with `-NoProfile`
deliberately absent — so siting it there would make that crate's one prohibition
false on its first line of real code. And `pty → agent` already exists, so
`github → pty` would drag the planner into the network crate's tree to acquire
a token, while #45's agent-side work would have to name a type downstream of
itself. Every clause of pty's charter — ConPTY, `openpty`, a ring per run,
throttling on the channel — is about a terminal the operator can see. A harvest
gets an interactive rc from a *flag*, not from a TTY; a PTY would in fact make
it worse, because a prompt that writes nothing to a pipe paints escape sequences
into a terminal, and into the frame. The cost of not siting it there is that two
crates now spawn, and #47 will import `apply` and `resolve` from here rather
than owning them.

**A module of `perseverance-app`.** One fewer crate, and the app already depends
on everything. Rejected for the reason ADR 0001 rejected SQLite there: the
shell's charter is why the shell is reviewable, and last-mark-wins,
first-occurrence-wins, stop-at-the-mark-not-at-exit and
kill-the-child-not-the-tree are all policy with an argument behind each. It
would also mean the parser could only ever be exercised with Tauri in the tree,
which is the opposite of what this slice is for.

**`perseverance-agent`, so planning and environment travel together.** Rejected:
planning is pure by charter — no async, no `&mut self`, no I/O — and a harvest is
nothing but I/O. The relationship runs the other way, which is why
`Environment`'s accessors return `std` types and why agent still depends on
nothing.

**Taking a dependency for any of the moving parts.** `wait-timeout` for the
bounds, `uuid`/`fastrand`/`getrandom` for the nonce, `base64` for
`-EncodedCommand`, `duct`/`command-group`/`shared_child` for a tree kill, `which`
for resolution. Rejected wholesale. Two reader threads and an `mpsc::recv_timeout`
give both bounds; `std::process::id()` plus the nanosecond clock plus an
`AtomicU64` give the nonce, and `crates/store/src/folders.rs` already reads the
clock via `std` alone; base64 over an alphabet we control is twenty lines with
four known-answer vectors, and this repo already hand-wrote an INI reader rather
than take a config dependency. `which` in particular would not even do the job —
see the next point.

**Letting `std::process::Command` resolve the program name.** Rejected because
it is wrong, not because it is a dependency. `Command::new("gh")` resolves the
bare name against **this** process's `PATH` — the launchd stub — however
`env_clear()` and `envs()` set the child's. That is #21's original problem
re-entered through the back door, so resolution against the harvested `PATH` is
`perseverance-env`'s, in `Environment::resolve`, and the child is spawned by
absolute path. Resolution is policy, and policy this crate declined to own would
be re-implemented in `github` now and in `agent` at #45.

**Killing the process tree on a bound.** #26 killed with `taskkill /T /F`.
Rejected on merit: the grandchild belongs to the operator's own start-up files —
a background updater, or a daemon the rc started on purpose — and reaching
outside our own child to undo something the operator asked for is not ours to
do. It is also unnecessary, because this harness stops reading at the closing
mark and drops its pipe ends; the grandchild that held the handle for four
seconds past exit held it against a read-to-EOF we do not perform. On unix a
process-group kill wants `libc` and `unsafe`, which `unsafe_code = "forbid"`
would have to be relaxed for.

**A per-record nonce on both platforms.** #26's stated minimum is a per-run
nonce prefixing each record **or** a NUL-delimited payload rather than
line-oriented text — an *or*. This takes the NUL grammar on both platforms and
*additionally* tags each record on Windows, where we write the loop and it is
free. It is not portable to macOS: `env -0` cannot prefix, and a
`while read -d ''` loop is bash/zsh syntax that a fish `$SHELL` would refuse.
Rejected as a universal rule; adopted where it costs nothing, with its limit in
the consequences below.

**A fourth pipe on fd 3, so the frame and the rc's chatter cannot interleave at
all.** The strongest framing available on macOS. Rejected: `std::process::Command`
hands out three stdio slots and a fourth needs `pre_exec`, which is `unsafe`, and
there is no fd 3 for PowerShell regardless. One framing that works on both
platforms beats a better one that works on one and costs the crate its `forbid`.

## Consequences

- The README's crate table has seven rows. It said six and meant it; it now says
  seven and means that. The new row's *Never* cell says **owning a terminal**,
  because that is the distinction this document turns on and it belongs on the
  table rather than only in here.
- `scripts/check-model-purity.mjs` gains `perseverance-env` and also
  `wait-timeout`, `duct`, `command-group`, `shared_child`, `subprocess` and
  `which`. Until now the only spawning entry was `portable-pty`, so any of those
  would have entered the model's tree in silence — the arrow this decision keeps
  absent is the script's business rather than review's, exactly as ADR 0001 did
  for `rusqlite`.
- **A fifth check exists, and it is the one this decision actually rests on.**
  `npm run check:agent-solitude` asserts that
  `cargo tree --package perseverance-agent --edges normal,build,dev` names
  exactly one crate — itself. The placement argument above is entirely an
  argument about the `agent → env` arrow staying absent through #45, and until
  this check existed that arrow was held by review alone. It is a few lines of
  JavaScript, and it makes the #45 argument true rather than intended.
- **`perseverance-github` still constructs no child process.** Its diff is one
  dependency line, one dev-dependency for the fake-`gh` tests, and one module
  that calls `run_in`. The socket crate stays the socket crate.
- **`perseverance-env` has one dependency and one dev-dependency**, and a second
  of either is visible in a diff. That is the whole of the enforcement — the same
  bargain ADR 0001 struck for the store. In particular, the day `serde` appears
  in that file is the day *never touches disk* stops being structural.
- **The harvest cannot be a precondition for window paint.** macOS's 187 ms hides
  behind it; Windows's 1.5–1.9 s does not, and a design that is correct only on
  the fast platform is not correct. `setup()` starts one named thread and
  returns. The cost is a state the WebView must render before it knows anything —
  one more branch in the readout and one more fixture entry.
- **A harvest that fails is a recorded condition, never a rejected command.** The
  `environment` command's return type contains no `Result`, so *a failed harvest
  leaves the app openable* is a compile-time fact and the test only pins the tag.
  The fallback is plain inheritance and the window is already open.
- **The bound is sized on the slowest run that legitimately completed, never on
  the median.** The binding numbers are not the cost table: they are #26's
  chatty-stderr harvest that finished at 4234 ms having drained 1.64 MB,
  `Get-Credential` at 1873 ms, and a read that did not finish until 4013 ms after
  a 1063 ms exit. Nothing waits on either bound, so slack costs nothing and
  tightness costs an operator their environment.
- **The frame-never-closed sentence names both possibilities and blames neither.**
  #26 proved that a drain in the wrong order deadlocks *indistinguishably* from a
  profile that is genuinely still working, so a harness that says "your shell is
  still running something" is asserting the likelier of two things when one of
  them is its own bug. `RepoBindingError::NotAGitRepo`'s doc comment already
  records that rule; this is its second instance, and unlike the first it has a
  mechanical check behind it on both sides of the wire.
- **stderr is shown verbatim and classified, and is never a verdict.** On Windows
  it is CLIXML with a 616-byte non-empty baseline that arrives with no profile at
  all, hard-wrapped mid-word before serialisation (`cannot _x000D__x000A_be
  loaded`), and native-executable output interleaves raw with it. Rendering it
  verbatim shows something that looks broken; that is correct, and the panel says
  so in fixed copy above it. Discarding its text would delete the only artifact
  an `AllSigned` refusal ever leaves, in the same document that admits the
  refusal is undetectable.
- **The stream survives the discard, which is why a harvest hands back a
  `HarvestAttempt` and not a `Result`.** The shell, the stderr and the elapsed
  are true of the *attempt*, so they sit beside its outcome rather than inside
  its success. A condition alone would report *empty* — the reading of a shell
  that wrote nothing — for a stream that was thrown away, and it would do so in
  the two cases the evidence is on stderr and nowhere else: #21's `-ic` rc whose
  `fnm` line died behind a still-plausible `PATH`, and #26's `AllSigned` refusal.
  A panel that goes blind exactly when the harvest failed is backwards. The three
  conditions decided before a process exists — no shell named, no PowerShell
  installed, the shell did not start — carry an empty stream because nothing ever
  ran to write one.
- **`gh auth token`'s stdout is the secret.** No refusal this workspace produces
  may carry it. `TokenRefusal::Declined` carries the first line of `gh`'s
  *stderr*, and there is a test with a fake `gh` that prints a token to stdout and
  exits non-zero to prove the token appears in no field and no `{:?}`.
- **The nonce is not a secret and does not pretend to be.** It travels in the
  argv on unix and inside the encoded command on Windows, so a profile that reads
  its own command line can forge it — and could set `PATH` before our payload
  runs regardless, since the profile and the answer share a process. It defeats
  coincidence and a start-up file written in advance, which is what was measured.
  The Windows per-record tag narrows that further but **does not** rescue a record
  an interleaved writer lands inside: that record is corrupt under any grammar and
  is dropped. Said here so nobody later mistakes the word for a boundary.
- **A dropped record is indistinguishable from a variable the operator does not
  have.** `tally.recordsDropped` crosses the wire because it is the only trace
  contamination leaves, and the panel has a sentence for a non-zero count.
- **Three honest limits are recorded rather than defended against**: resolvable ≠
  spawnable (#21 — `zsh -lc` resolves `codex`, which then dies at exec 127 in its
  own `env node` shebang); spawnable ≠ correct (#24 — a pin to an uninstalled
  version starts the wrong interpreter with nothing on either stream, and the
  diagnostics are anti-correlated with the danger); complete-looking ≠ complete
  (#26 — a profile that calls `exit` yields exit 0, both marks, ninety variables
  and a stderr at the exact no-profile baseline; under `AllSigned` the profile
  does not run at all and the harvest silently degrades to plain inheritance).
  None is closed here. They are in the panel's own words rather than in a document
  nobody opens, and the verbatim `PATH` exists partly so that an operator *could*
  notice a degradation nothing will tell them about.
- **This crate is where #47 gets its environment too, and only half of it.** A
  session spawned inside a harvested environment is `pty → env` for `apply` and
  `resolve`, and stays pty's for everything with a terminal in it. The
  environment-application half is shared; the terminal half never comes here.
  Saying so now is what keeps the harvest/session distinction stable rather than
  convenient.
- **The crate's own negatives are guarded by a one-line dependency list and this
  document, and by nothing else.** `check:agent-solitude` and
  `check:model-purity` hold the two arrows *into* other crates; nothing
  mechanical stops `perseverance-env` itself growing a PTY, a socket or a file,
  and the harvest-versus-session distinction the whole placement rests on is a
  judgement rather than a check. That is the same enforcement ADR 0001 accepted
  for the store, named here so the next person to widen this crate knows they are
  arguing with a decision rather than filling a gap.
