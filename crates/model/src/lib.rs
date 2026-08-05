//! Pure derivation of the map model.
//!
//! This crate is the primary seam. Below it: recorded GraphQL responses plus
//! map-body markdown. Above it: a [`Snapshot`] that the WebView receives and
//! nothing else. Both sides meet on one type, which is why the same artifact
//! can be a checked-in JSON fixture driving `dev:web`.
//!
//! The constraint that makes the seam real rather than claimed: **no Tauri, no
//! network and no browser anywhere in this crate's dependency tree**, tests
//! included. `scripts/check-model-purity.mjs` enforces it in CI.

/// The generated TypeScript and the `dev:web` fixtures, and the check that
/// keeps both equal to what this crate actually produces. Test-only, because
/// the `TS` derives it depends on are.
#[cfg(test)]
mod bindings;
pub mod derive;
mod read;
mod snapshot;

pub use derive::{
    ChildKind, Counts, Map, Model, Node, NodeState, Phase, TicketType, WAYFINDER_PREFIX,
};
pub use read::{
    read_response, rfc3339, ChildRead, MapGraph, MapListing, MapRead, RateLimit, ReadError,
    Truncation, MAP_LABEL,
};
pub use snapshot::{Provenance, ReadOutcome, Snapshot, SnapshotError, Source, SCHEMA_VERSION};
