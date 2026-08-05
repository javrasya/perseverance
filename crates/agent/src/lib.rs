//! The agent trait and its adapters.
//!
//! Boundary: an adapter decides *what to run* and never *how to run it*.
//! Planning is pure — no async, no `&mut self`, no I/O — so an adapter is
//! testable with a golden-argv assertion, no async runtime, no PTY and no
//! installed CLI. Spawning belongs to [`perseverance_pty`].
//!
//! Deliberately depends on nothing. A dependency here would be a claim that
//! planning needs the world, which is the thing this boundary denies —
//! `npm run check:agent-solitude` fails the build on the first edge, so the
//! claim is checked rather than reviewed.
//!
//! That survives #45, whose environment work is split. *Acquiring* a per-folder
//! environment, and caching it by working directory, is
//! [`perseverance_env`]'s — it is a child process, and this crate spawns
//! nothing. What an adapter *declares* it needs, how a readout is interpreted
//! against that, and the rule an override resolves by are planning and stay
//! here. None of that needs an edge: every accessor on a harvested environment
//! hands back a `std` type. `docs/adr/0002` records the split and why it was a
//! re-attribution rather than a reading of the ticket.
//!
//! Filled in by:
//! - #44 the adapter contract, and the Claude Code adapter
//! - #45 the adapter's declared probes, the readout's interpretation, and the
//!   override's resolution rule (the per-folder harvest itself, and the
//!   cwd-keyed cache, are [`perseverance_env`]'s)
//! - #46 Codex and Pi adapters
//!
//! [`perseverance_pty`]: https://github.com/javrasya/perseverance
//! [`perseverance_env`]: https://github.com/javrasya/perseverance
