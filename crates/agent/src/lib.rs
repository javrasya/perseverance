//! The agent trait and its adapters.
//!
//! Boundary: an adapter decides *what to run* and never *how to run it*.
//! Planning is pure — no async, no `&mut self`, no I/O — so an adapter is
//! testable with a golden-argv assertion, no async runtime, no PTY and no
//! installed CLI. Spawning belongs to [`perseverance_pty`].
//!
//! Deliberately depends on nothing. A dependency here would be a claim that
//! planning needs the world, which is the thing this boundary denies.
//!
//! Filled in by:
//! - #44 the adapter contract, and the Claude Code adapter
//! - #45 per-folder resolution, the environment readout, and the override
//! - #46 Codex and Pi adapters
//!
//! [`perseverance_pty`]: https://github.com/javrasya/perseverance
