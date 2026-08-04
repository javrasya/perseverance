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

mod snapshot;

pub use snapshot::{
    MapRef, Provenance, ReadOutcome, Snapshot, SnapshotError, Source, SCHEMA_VERSION,
};
