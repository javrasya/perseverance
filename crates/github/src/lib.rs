//! GitHub access and the poller.
//!
//! Boundary: this is the only crate in the workspace permitted to open a
//! socket. It is read-only — no assign, close, label, comment or edit ever
//! originates here — and the token comes from `gh auth token` at runtime and is
//! never stored.
//!
//! It depends on [`perseverance_model`] and never the other way round. That
//! direction is what keeps the model crate free of the network.
//!
//! Filled in by:
//! - #31 environment harvest and token acquisition
//! - #32 one query shape, discovery by label, the read cache
//! - #38 the cadence ladder and off-cadence pokes
//! - #39 the rate-limit budget floor
//! - #40 failure taxonomy, backoff, and the graph condition

/// The type every read in this crate ultimately produces. Re-exported so the
/// direction of the seam is visible from the crate that crosses it.
pub use perseverance_model::Snapshot;
