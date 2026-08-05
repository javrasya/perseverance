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
//! Filled in by:
//! - #47 PTY ownership and the embedded terminal (the environment a session
//!   starts in comes from [`perseverance_env`]; everything with a terminal in
//!   it stays here)
//! - #49 two endings: spent, exited-but-unresolved, and Resume
//! - #50 silence taxonomy: quiet versus wedged, readiness, and the parked caret
//! - #51 quitting: one confirmation, clean shutdown, no orphans
//!
//! [`perseverance_env`]: https://github.com/javrasya/perseverance
