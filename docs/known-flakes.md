# Known flakes

A named registry of tests that fail intermittently for reasons unrelated to the change under test. It exists so an automated loop can tell a flake from a regression without guessing, and it is the **only** licence to re-run a red build.

## The re-run rule

On a red build, re-run **once** — `gh run rerun <run-id> --failed` — if and only if both hold:

- **Every** failing test is listed below. One unlisted failure makes the whole red real.
- The branch touched **none** of the failing test's crate. A branch that edits `crates/pty/` gets no free roll on a `perseverance-pty` failure, however flaky that test is elsewhere.

Otherwise the red is real immediately. Still red after the one re-run → real. Repair it.

**Announce every re-run** — in the PR comment and in the run's brief. A silent re-run is how a genuine intermittent regression gets waved through at the bottom of a deep stack.

Both entries fail in the CI step named `Rust tests`, so that is the only step this registry ever needs to inspect. Key the check on the `test <name> ... FAILED` lines rather than on the step name — an expired log archive reports `UNKNOWN STEP`.

## `poller::tests::an_idle_signal_waits_for_quiet_before_it_polls`

- **File** — `crates/github/src/poller.rs`
- **Crate** — `perseverance-github`
- **Platform** — `macos-latest` only. Never reproduced on the operator's Windows machine.
- **Why** — a wall-clock race. The assertion is `taken.recv_timeout(WINDOW / 4).is_err()`; on a contended runner the adapter has not gone quiet inside a quarter-window and the test panics with `an adapter still talking has not gone quiet`.
- **Evidence** — pre-existing. It failed on `main` in run [31229742169](https://github.com/javrasya/perseverance/actions/runs/31229742169), before branch `worktree-35-fog` existed. It failed again in attempt 1 of run [31310821962](https://github.com/javrasya/perseverance/actions/runs/31310821962) on `worktree-35-fog` — a branch touching `crates/model`, not `crates/github` — and attempt 2 went green on a bare `gh run rerun --failed` with no code change.

## `runs::tests::one_quit_is_one_deadline_and_not_one_per_run`

- **File** — `crates/pty/src/runs.rs`
- **Crate** — `perseverance-pty`
- **Platform** — `macos-latest` only. Same as above: not reproducible on Windows.
- **Why** — the same family. The panic is in the `wait_until` helper's 60-second deadline rather than in the grace assertion under test: `all three runs started did not happen inside a minute`. Three PTY runs failing to start inside a minute is a story about the runner, not about quit handling.
- **Evidence** — pre-existing. It failed on `macos-latest` in run [31303699839](https://github.com/javrasya/perseverance/actions/runs/31303699839), on PR #81 (`worktree-51-quitting`). That instance earns **no** re-run under the rule above — #81 is the ticket that owns `crates/pty/src/runs.rs`, so the branch touched the failing test's crate. That is the rule working, not a gap in it.

`crates/pty/src/runs.rs` does not exist on `main`. It arrives with PR #80 (`worktree-47-pty-terminal`), so until that merges this entry names a path visible only on the unmerged stack.

## These want a real fix

Both tests assert on wall-clock duration from a test process sharing a runner with a whole `cargo test --workspace`. The fix is to stop measuring time: inject a fake clock, or assert on the **ordering** of events rather than on the size of the gap between them.

**No ticket exists for that work.** This registry is the bill — every entry is a test the project has chosen to tolerate rather than fix, and the list should shrink rather than grow. Do not add an entry to make a red build go away; add one only for a failure shown to be independent of the change under test.
