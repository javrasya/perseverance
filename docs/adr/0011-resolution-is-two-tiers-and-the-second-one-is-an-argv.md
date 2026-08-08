# 11. Resolution is two tiers, and the second one is an argv

Status: accepted (2026-08-08)
Context: [#45 per-folder resolution, the environment readout, and the
override](https://github.com/javrasya/perseverance/issues/45), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). It fills the split
ADR 0002 drew between acquiring an environment and planning against one, and it
consumes two things #44 built and left without a caller: `Discovery.probes` and
`perseverance_pty::accept`. The measurements it leans on are #21's, #24's and
#26's.

## Context

The app has to turn the name `claude` into something it can spawn, in a folder,
on a machine whose `PATH` is whatever the operator's login shell says it is. #31
acquired that `PATH` once per launch, at the filesystem root. The root is the
right place for a fact about the machine — `gh auth token` is asked there and
stays there — and the wrong place for a fact about a folder, because a repo that
pins an interpreter version answers the question *which node* only to a process
that started inside it.

Three failure modes shape everything below, and only the first is loud.

**Resolvable is not spawnable.** A `PATH` that resolves `codex` says nothing
about whether its `#!/usr/bin/env node` shebang resolves at exec time; #21
measured that exact 127.

**Spawnable is not correct.** A pin to an uninstalled version falls back to the
default and starts successfully under the wrong interpreter, with nothing on
either stream (#24).

**Complete-looking is not complete.** A profile that throws or exits aborts only
itself while the payload still runs, yielding exit 0, both marks, clean stdout
and a silently partial harvest (#26).

The loud case prints. The dangerous cases say nothing.

## Decision

**Two tiers only: the harvested environment, then an explicit override.** There
is no third tier and in particular no install-location probing — no
`~/.local/bin`, no `/opt/homebrew`, no `%APPDATA%\npm`, no `where.exe`, no
`Get-Command`, no `command -v`.

This is now a rule rather than an argument. Probing's failure mode is not
incompleteness, it is **divergence**: a candidate directory that the operator's
own shell does not have on its `PATH` produces a binary they cannot reproduce
from their own terminal, and it produces it *silently*. A silent wrong binary
beats a loud not-found, so the not-found is made falsifiable instead — see the
readout below. `perseverance_env::Environment::resolve` against the harvested
`PATH` is the only name-to-path mechanism in the tree, and
`locate_in`'s doc comment states the rule where a reader of the resolution code
will meet it. The near-miss is `powershell_location`, which derives
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` — that locates the
*harvest's own interpreter* at a moment when `PATH` is the thing not yet
acquired, and it is out of scope by that distinction rather than by exemption.

The rule is checked rather than claimed. `npm run check:no-install-probing` reads
the six files that resolve a program name — `crates/env/src/{environment, locate,
folder, shell, run}.rs` and `crates/app/src/lib.rs` — strips their comments and
their `#[cfg(test)] mod tests` blocks, and fails on any of the directories and
resolvers named above. Comments are stripped because this crate argues its case
in prose and a scan that rejected the argument would be turned off within a week;
test modules are stripped because the strongest evidence the rule holds is a test
that puts a program somewhere no `PATH` names and asserts it is not found. Like
`check-agent-solitude.mjs` it runs known-bad *and* known-good input through its
own verdict function first.

**A per-folder harvest is the same harvest with the child's working directory
set to the folder.** `harvest_command_in(shell, nonce, directory)` is the one
builder; `harvest_command` is now literally it, called with `harvest_cwd()`. So
the app-global harvest and a folder's differ in exactly one field, and
`harvest_with` — whose own doc reserved this — is not forked.

**Setting the child's working directory suffices; there is no `cd` inside the
harvest, on either platform.** A version manager resolves its pin inside its own
process at rc-evaluation time, so the pin is answered by where the shell
*started*. On Windows only the aliased `cd` fires the hook at all, so scripted
navigation would not even work. And #24 already called it the load-bearing
correction from the other side: a `cd` in the command runs before the framing and
puts its own output where the opening mark belongs. `payload.rs`'s
`!payload.contains("cd ")` assertion stays, and a new one says a folder command's
argv is identical to the root command's.

**The cache is keyed on the absolute, canonicalised spawn working directory** —
not on a folder id, not on a path as it was typed. That deletes the worktree
question rather than answering it: two rows that resolve to one directory share
one harvest because they *are* one harvest. Canonicalisation is not tidiness —
`/var` and `/private/var` are one directory on macOS and an 8.3 short name and
its long spelling are one on Windows, so two keys would be two harvests that
could disagree about which interpreter a folder resolves under, which is the
exact harm. `spawn_directory` canonicalises for the key; `spawnable_form` strips
the `\\?\` prefix `canonicalize` returns on Windows, because that prefix is right
for a key and unproven for `Command::current_dir`.

**Invalidation is the operator's explicit retry and nothing else.** No TTL, no
filesystem watcher. A watcher catches the wrong thing: the dangerous case is *pin
unchanged, installed set changed*, where `.nvmrc` still reads the same and the
version it names has just been installed or removed — nothing under the folder
was written. A clock would re-take the harvest at a moment chosen by neither the
operator nor the machine. So `Harvests` has no duration parameter anywhere on it
and `again_in_folder` forgets that directory and harvests it again, in that
order. Retry re-harvests, then respawns.

The map lock is held only to get-or-insert a cell and released before the
harvest; the harvest happens inside `OnceLock::get_or_init`. A Windows harvest is
bounded at 20 s, and holding the map across one would serialise every folder in
the app behind whichever was asked first. Two concurrent asks for one directory
still produce one harvest.

**Wrong-interpreter is made inspectable rather than detected.** A per-folder
readout carries the verbatim `PATH` and, per adapter, the absolute path each
candidate resolved to plus each declared probe's first line — and it parses no
version and compares nothing. A check that guessed would be this harness
disagreeing silently with the operator's own terminal, which is the same harm as
probing. The `PATH` crosses unsplit and is split only for display, with a note
saying the separator is a guess.

**`Discovery.probes` is per platform by type**: `Probes { windows, unix }` and
`Probes::on(platform)`, rather than a flat list with a `platform` tag on each
entry. A tagged list is per-platform only for as long as every caller remembers
to filter it, and a probe run on the wrong platform is a reading of nothing
presented as a reading of something — `node --version` on a machine without
`node` reads exactly like a folder that has none. `Probe` loses its `platform`
field: which list it is in *is* the platform.

**The execution-policy degradation is named from what the interpreter wrote, and
`-ExecutionPolicy` is still refused.** Under a restrictive policy the harvest
degrades to plain inheritance with exit 0, both sentinels and clean stdout; the
refusal appears only in serialised stderr. `Degradation::ProfileRefused` is read
out of that stream by content — a small table of token groups, matched against a
copy with PowerShell's escaped hard wrap (`cannot _x000D__x000A_be loaded`)
flattened and lowercased. Never by `StderrKind::Clixml` and never by "stderr is
non-empty": the Windows baseline is 616 bytes of CLIXML with no profile at all.
It is a `Degradation` and not a `HarvestCondition`, because the harvest
succeeded. Adding `-ExecutionPolicy` to the argv was refused again: it would be
this harness running something the operator's machine declined, and the negative
assertion in `shell.rs` stays and is load-bearing.

This is a narrowing of ADR 0002's honest limit rather than a reversal of it. The
degradation is now *nameable when the interpreter names it* and still invisible
when it says nothing, and the frontend copy that promised the first half is
rewritten rather than deleted.

**Not-found never blocks launch, and carries its own evidence.** A missing CLI is
a value — `Located::NotFound { names }` — beside a `FolderEnvironment` that
already holds the shell used, the harvest's condition and the verbatim `PATH`.
One home per fact: `HarvestAttempt` keeps `shell` outside `outcome` and keeps
stderr on a discarded harvest, so nothing is re-derived and
`Shell::for_this_machine` is not asked twice. The commands that carry it return
no `Result`, which is how ADR 0002 already held the same property for the
app-global readout: a compile-time fact rather than a test. The `PATH` is shown
verbatim, horizontally scrollable and keyboard-reachable, because what makes
`claude: not found` falsifiable is seeing the binary in the same list your own
terminal has.

**The override is app-global, an argv vector, and has exactly one composition
rule.** An argv vector because a path string cannot express `node .../cli.js`;
app-global because it is the operator's answer to *that is not the binary I
meant* and that is not a per-folder statement — it lives in the existing
`app(key, value)` table beside `default_adapter`, with no schema change, and
deliberately not in `folders.adapter`. The rule is that **`argv[0]` resolves
against the folder's environment**: a bare name follows the folder's pin, a path
pins the machine, and the operator chooses the scope by what they type.
`Launch::under(interposed)` splices `argv[1..]` after the resolved program and
before the adapter's own arguments.

`Scope::{FollowsTheFolder, PinnedGlobally}` is a *restatement* of what
`Environment::resolve` already does — a name with a parent is taken at its word
and only checked; a bare name walks the harvested `PATH` — written down so the
surface can show which of the two the operator picked. It resolves nothing
itself.

**Adapters resolve once per folder, in that folder's environment, inside the same
folder-open step that produces the readout.** There is no launch-time picker to
annotate; the crossing owns the picker (story 36). In `crates/app` that is
`read_folder`, driven by four commands — `folder_environment`,
`retry_folder_environment`, `use_override` and `clear_override` — none of which
returns a `Result`; in `src/App.tsx` it is one call inside the existing
`openFolder` block, started after `setSelectedId` and never awaited before it, so
a missing CLI can only ever *add* a `LauncherNote`. `use_override` re-resolves
and deliberately does **not** re-harvest: an override is a different answer to
*which program*, not a claim that the folder's environment changed.

**The readouts are two hand-kept mirrors, and the counts are the defence.** The
app-global one goes from nine keys to ten (`degradation`); the per-folder one is
twelve and lives in a separate type and a separate TypeScript file, because it
answers a different question and bolting it onto the app-global value would make
one readout mean two things. Both counts are asserted from Rust and from
TypeScript.

## Alternatives

**A TTL on the cache.** It re-runs the operator's login shell at a moment nobody
chose, and it re-runs it *most* when the app is idle and *least* when they have
just installed something. The case it is supposed to catch is the one it cannot:
a pin whose text has not changed.

**A filesystem watcher on the folder.** It watches the artefact that did not
change. `.nvmrc` is identical before and after `nvm install 22`, and the thing
that changed lives in the version manager's own store.

**Keying the cache on the folder row's id.** The id is stable across relocation
by design, which is the wrong stability here: after a relocation the child would
start somewhere else and the answer would be a different machine's. Keying on the
path as typed has the opposite fault — two spellings, two harvests, and no way to
tell which of two disagreeing answers is the folder's.

**Probing install locations as a fallback tier.** Rejected above; the whole
argument is that its failures are silent and diverge from the operator's own
shell.

**Detecting the wrong interpreter.** Every rule available is a version
comparison, and every version comparison is a policy this ticket did not measure.
Showing the absolute resolved path costs nothing and is the fact that actually
distinguishes two folders' answers.

**Adding `-ExecutionPolicy Bypass` to the harvest argv.** It would make the
degradation go away by overriding a decision the operator's machine made. Refused
in #26 and refused again.

**The override as a path string.** It cannot say `node .../cli.js`, which is the
only thing an operator with an npm install has to say.

**The override per folder.** `folders.adapter` is right there, and it is the
wrong scope: the override exists because the machine resolved the wrong binary,
and the operator should not have to say so once per folder. A bare `argv[0]`
already gives per-folder behaviour for anyone who wants it.

## Consequences

`Discovery` changed shape one ticket after #44 accepted it, and `Probe` lost a
field. That is a cost paid deliberately: #44 declared `probes` with no consumer,
and the first consumer is what showed the tag-on-each-entry shape to be
per-platform only by convention. The change is confined — one adapter ships and
it declares `Probes::NONE` — and it is the kind of thing that only gets cheaper
to do now.

The shipped adapter declares no probes, so on a shipped build the probe section
of the per-folder readout is **empty**, and the panel says so and why. What
carries the weight instead is the resolved absolute path. Anyone reading the
probe machinery should know it is exercised by tests and by no adapter in this
binary.

`perseverance_pty::accept` still has no caller. AC8 makes that visible from a new
angle: `accept` refuses a non-absolute `argv[0]`, so an override's bare name must
be resolved by `Environment::resolve` *before* it reaches `Launch`, and a bare
name arriving at `accept` is a refusal rather than a resolution. Nothing enforces
that ordering yet, because nothing spawns until #47.

"Retry re-harvests, then respawns" is half-wired for the same reason. The
re-harvest is real and the respawn has nothing to call; the retry command is the
seam #47 will call.

`Harvests` holds one `Environment` per folder for the life of the process, and an
`Environment` is a map of the operator's variables. Nothing here writes one down
— `perseverance-env` still has no serde in its tree — but the memory cost now
scales with the number of folders opened rather than being one, and there is no
eviction, because eviction is invalidation with a different name.

The no-probing check is an **allowlist of six files**, so a resolution path added
in a seventh escapes it entirely. That is the same honest limit `PTY_SOURCES`
already carries, and unlike the agent-source scan there is no self-check that
would notice a new resolving file appearing. It is recorded in README rather than
defended against, because the alternative — scanning the whole tree — would have
to permit every fixture, ADR and copy string that *names* these directories in
order to say they are not looked in, and a check with that many exemptions is a
check nobody trusts. `spawnable_form` became `pub` for the same surface: probes
run at the folder, and the key's `\\?\` spelling is the wrong thing to hand
`Command::current_dir`.

The degradation table is two token groups and no regular expression — a third
was drafted for the help topic the refusal points at and dropped before it
shipped, because `about_Execution_Policies` flattens with its underscores intact
and the two-word phrase occurs in nothing the interpreter writes. It is
matched against a flattened copy and pinned to the genuine `AllSigned` transcript
already checked in as the `windowsClean` fixture, asserted from both Rust and
TypeScript so the two copies cannot drift. It will not recognise a localised
Windows, and a machine whose interpreter refuses in another language degrades
exactly as before — invisibly. That is the same limit ADR 0002 recorded, now with
a smaller surface rather than none.
