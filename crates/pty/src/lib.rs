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
//! Filled in by:
//! - #47 PTY ownership and the embedded terminal
//! - #49 two endings: spent, exited-but-unresolved, and Resume
//! - #50 silence taxonomy: quiet versus wedged, readiness, and the parked caret
//! - #51 quitting: one confirmation, clean shutdown, no orphans
