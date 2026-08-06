//! GitHub access and the poller.
//!
//! Boundary: this is the only crate in the workspace permitted to open a
//! socket, and [`read::send`] is the only place in it that does. It is
//! read-only — no assign, close, label, comment or edit ever originates here —
//! and the token comes from `gh auth token` at runtime, is spent in a header,
//! and is never stored.
//!
//! [`read::send`]: read
//!
//! It depends on [`perseverance_model`] and never the other way round. That
//! direction is what keeps the model crate free of the network.
//!
//! It also depends on [`perseverance_env`], and after that dependency it still
//! constructs no child process: [`acquire_token`] names `run_in` and nothing
//! else.
//! Which command to ask, what a refusal is called and the rule that a refusal
//! never repeats what `gh` printed to stdout are policy and belong here; running
//! it belongs to the crate whose subject that is.
//!
//! The poller is two modules and the split between them is the same one
//! `read.rs` makes: `cadence.rs` is the arithmetic — `max(ladder_floor,
//! budget_floor, backoff_floor)` over a value that has no clock in it — and
//! `poller.rs` is the one thread, the one clock and the channel every
//! off-cadence poke arrives on. Two of the three floors are stubbed at zero
//! here and named after the tickets that fill them.
//!
//! Filled in by:
//! - #31 token acquisition, in the environment `perseverance-env` harvested
//! - #32 one query shape, discovery by label, the read cache
//! - #38 the cadence ladder and off-cadence pokes
//! - #39 the rate-limit budget floor
//! - #40 failure taxonomy, backoff, and the graph condition
//!
//! [`perseverance_env`]: https://github.com/javrasya/perseverance

mod cadence;
mod poller;
mod read;
mod token;

pub use cadence::{
    backoff_floor, budget_floor, interval, ladder_floor, next_wake, Attention, Authority, Budget,
    Cadence, Floor, Held, Interval, Rung, Wake, AWAY, POKE_FLOOR, RUN_LIVE, WATCHING,
};
/// The type every read in this crate ultimately produces. Re-exported so the
/// direction of the seam is visible from the crate that crosses it.
pub use perseverance_model::Snapshot;
pub use poller::{start, Poke, Poker, RunHandle, Tick, Timings, Watched};
pub use read::{
    interpret_read, read_maps, request_body, Answer, FreshRead, ReadFailure, GRAPHQL_ENDPOINT,
    MAP_READ_QUERY,
};
pub use token::{acquire_token, interpret, Token, TokenOutcome, TokenRefusal};
