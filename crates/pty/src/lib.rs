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
//! these bytes and asserts this crate names none of it, which is the strongest
//! form available while this file is a doc comment and nothing else.
//!
//! Filled in by:
//! - #47 PTY ownership and the embedded terminal (the environment a session
//!   starts in comes from [`perseverance_env`]; everything with a terminal in
//!   it stays here)
//! - #49 two endings: spent, exited-but-unresolved, and Resume
//! - #50 silence taxonomy: quiet versus wedged, readiness, and the parked caret
//! - #51 quitting: one confirmation, clean shutdown, no orphans
//!
//! [`perseverance_env`]: https://github.com/javrasya/perseverance
