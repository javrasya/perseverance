//! PTY and child-process ownership.
//!
//! Boundary: the one place ConPTY and `openpty` are spoken, so there is a
//! single implementation to get right rather than one per adapter. It always
//! drains a PTY into a per-run ring and never blocks the child; throttling
//! happens on the channel to the WebView, never on the wire.
//!
//! It consumes what [`perseverance_agent`] planned and never plans anything
//! itself.
//!
//! The child processes here are the ones the operator *watches*: a terminal, a
//! ring, an ending to resolve, a session this app owns until it is over. A
//! harvest is not one of those — it is sub-second, pipe-backed, framed and
//! abandoned at the closing mark, with nobody reading its output — so it lives
//! in [`perseverance_env`] and not here. Siting it here would also make this
//! crate's one *Never* false, because choosing `-lic` over `-lc` is deciding
//! what to run. `docs/adr/0002` records that argument in full.
//!
//! #51's *no orphans* is a promise about those sessions. It is not a promise
//! about whatever an operator's own start-up files background: a harvest kills
//! the shell it spawned and reaches no further, because a daemon an rc started
//! on purpose is the operator's and not ours to end.
//!
//! **The harness surfaces only its own failures.** A command that exited 1, a
//! compiler that could not find a header, an agent that printed a stack — none
//! of those is a condition on the graph, and nothing in this crate may raise
//! one. An error printing three inches from your eyes is the terminal's to
//! print, and a harness that narrated it would be saying, less well, what the
//! operator is already reading. What the graph is for is the failures the
//! operator *cannot* see: a poll that did not land, a token that has gone, a
//! map that is no longer there. #40 built that vocabulary, and it is
//! deliberately unreachable from here — `crates/app` has a test that reads
//! every file in `crates/pty/src` from a hand-written list and asserts this
//! crate names none of it, which is the strongest form available while the
//! crate owns no terminal.
//!
//! **A launch whose `argv[0]` is a shim is refused here and nowhere else.**
//! #44 put the check at this boundary rather than inside each adapter, because
//! spawning through a `.cmd` interposes `cmd.exe`: killing the child kills the
//! interpreter, orphans the agent, and returns the shim's exit code instead of
//! the agent's. [`accept`] is the whole of the rule — a spawnable program is a
//! file whose first bytes are a native-executable magic for this target — and
//! it is a *type*, not a boolean: [`Accepted`] has private fields and one
//! constructor, so #47's spawn takes an `Accepted` and the check cannot be
//! routed around. It reads a file and never runs one, so it is exercisable
//! from hand-written bytes with no agent CLI installed.
//!
//! **Lag-drop cannot mean dropping bytes.** A VT stream is not sampleable: a
//! range discarded mid-flight cuts an escape sequence in half and the terminal
//! renders garbage permanently. So no path in this crate ever hands over a
//! non-contiguous byte range. [`Ring`] reduces only by dropping *whole
//! scrollback from the front*, which is the one reduction that leaves what
//! remains a contiguous suffix; [`Tap`] has three answers and none of them is a
//! shortened range — when the WebView falls behind, what stops is the sending,
//! and the way back is a reset and the ring replayed whole. Truncation is
//! reported to the chrome as a count and never written into the stream.
//!
//! **A run nobody is watching is drained on identical terms.** It has to be: an
//! unread PTY fills its pipe and blocks the child, and on Windows an unanswered
//! cursor-position query means the child never starts at all — so [`Queries`]
//! lives in the plumbing rather than in whatever renderer happens to be
//! attached. Which run bytes cross for is [`Runs`]'s and never a session's,
//! because a session has no channel to send on.
//!
//! **A quit is three phases, and each of them is a handle rather than a word.**
//! [`Runs::shut_down`] hangs up, waits once, and then kills. *Hanging up*
//! releases every session's write end and nothing else, and what that means is
//! not the same on the two platforms: on unix it is a dup of the master fd whose
//! `Drop` writes the terminal's `VEOF` into the pty, which a child may read or
//! ignore; on Windows it closes the pseudoconsole's input pipe, and the console
//! host answers that by breaking the session — measured, a run that never reads
//! its input is gone inside a tenth of a second with `STATUS_CONTROL_C_EXIT`. So
//! the asking is a request on one platform and an interrupt on the other, and
//! the grace behind it is in practice a unix mechanism. The read end is kept
//! either way, because dropping the master on Windows is `ClosePseudoConsole`,
//! an unconditional terminate rather than something a child gets to answer.
//! *The wait* is one [`GRACE`] across the whole quit and not one per run, ended
//! early the moment every run is over. *The kill* is every session dropping: on
//! Windows `TerminateProcess`, then `ClosePseudoConsole` taking the tree, then
//! the job object closing behind it; on unix `SIGHUP`, five 50 ms looks at the
//! child, then `SIGKILL` — the escalation that only the **owned** child carries,
//! which is why [`Session`] keeps it rather than a cloned signaller — after
//! which the kernel hangs up the controlling terminal's foreground group.
//! [`Session`]'s `Drop` remains the backstop for the paths where nothing gets to
//! run at all. **No adapter participates in any of it** — what ends a run here
//! is a handle lifetime and a clock, so the contract stays at four members and
//! this crate learns no product vocabulary.
//!
//! Filled in by:
//! - #47 PTY ownership and the embedded terminal (the environment a session
//!   starts in comes from [`perseverance_env`]; everything with a terminal in
//!   it stays here)
//! - #51 quitting: one confirmation, clean shutdown, no orphans (the deadline
//!   and the kill are here; the confirmation is `crates/app`'s, because what a
//!   run is working on is product vocabulary this crate may not hold)
//! - #49 two endings: spent, exited-but-unresolved, and Resume
//! - #50 silence taxonomy: quiet versus wedged, readiness, and the parked caret
//!
//! [`perseverance_env`]: https://github.com/javrasya/perseverance

mod geometry;
mod guard;
mod queries;
mod ring;
mod runs;
mod session;
mod shim;
mod tap;

pub use geometry::{Geometry, Panes};
pub use guard::{Guard, GuardRefusal};
pub use queries::{Queries, ANSWER};
pub use ring::{Ring, SCROLLBACK};
pub use runs::{Run, RunId, Runs, Telemetry, GRACE};
pub use session::{Ending, Session, SessionFailure};
pub use shim::{accept, Accepted, SpawnRefusal};
pub use tap::{Delivery, Tap, SLACK};
