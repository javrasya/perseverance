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
//! The contract is four members and a value. An adapter answers with its
//! [`AgentId`], with a [`Discovery`], and with a [`Launch`]; the fourth member
//! has a default, so no call site anywhere branches on whether an adapter
//! produces live signals. There is no fifth *required* member, and the test
//! double in `agent.rs` is what says so — it implements three members and
//! inherits one, and would stop compiling the day a member without a default
//! body arrived. A fifth member *with* one would not stop it: nothing counts
//! the members, so an optional one is caught by review rather than by the
//! compiler.
//!
//! Two things this vocabulary deliberately cannot say. There is no `Completed`
//! [`Signal`], because completion is a GitHub state transition and the absence
//! of the variant is what enforces it. And there is no way at all to express a
//! write to the operator's global configuration: [`Launch`] holds argv, an
//! environment delta and a readiness rule and nothing else, [`LaunchContext`]
//! is `Copy` and so cannot carry a handle to write through, its two
//! directory-shaped fields are [`Program`] and [`Cwd`] rather than paths so
//! that not even a *read* is reachable from what was handed in, and
//! `crates/app` reads these source files and fails the build unless every
//! `std` path they name is one of `ffi`, `fmt`, `time` and `error`. That last
//! one is an allowlist and not a list of forbidden names, because a
//! brace-grouped import pulls in the file and I/O modules while spelling
//! neither of them the way a forbidden-name scan looks for. Per-run
//! configuration is therefore argv and environment, as a property of three
//! types rather than as a rule anyone has to remember.
//!
//! One adapter ships: [`ClaudeCode`]. It takes the default `watch`, so the
//! shipped adapter is itself the proof that nothing downstream branches on
//! whether an adapter produces signals. Registration is a closed enum and a
//! lookup — [`AgentId`], one variant, one match arm in [`agent()`] — because the
//! set of adapters is a fact about the binary rather than about the order
//! modules happened to initialise in. Config-defined adapters are deferred, not
//! refused.
//!
//! Filled in by:
//! - #45 the adapter's declared probes, the readout's interpretation, and the
//!   override's resolution rule (the per-folder harvest itself, and the
//!   cwd-keyed cache, are [`perseverance_env`]'s)
//! - #46 Codex and Pi adapters
//!
//! [`perseverance_pty`]: https://github.com/javrasya/perseverance
//! [`perseverance_env`]: https://github.com/javrasya/perseverance

mod agent;
mod claude;
mod launch;
mod platform;
mod registry;
mod watch;

pub use agent::{Agent, Discovery, Probe};
pub use claude::ClaudeCode;
pub use launch::{Cwd, Launch, LaunchContext, PlanError, Program, Ready};
pub use platform::Platform;
pub use registry::{agent, agent_named, AgentId};
pub use watch::{NoWatch, Signal, Watch};
