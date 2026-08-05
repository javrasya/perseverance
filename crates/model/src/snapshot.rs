use serde::{Deserialize, Serialize};

use crate::derive::Model;

/// Forward-only. An unrecognised version is refused rather than guessed at.
pub const SCHEMA_VERSION: u32 = 1;

/// Everything the WebView is given for one tick.
///
/// One type, and the derivation is already done inside it. The same artifact is
/// [`crate::derive`]'s output and the frontend's input, which is what makes this
/// one seam rather than two — and it lands a cheap constraint that pays for
/// itself: **a snapshot must be constructible from a JSON file as easily as
/// from GitHub**, which is what lets `dev:web` boot the whole frontend with no
/// Rust, no GitHub and no PTY behind it.
///
/// **Provenance is fused into this value rather than streamed beside it.** Two
/// streams would let a fresh model paint against a stale stamp for a frame —
/// absence disguised as presence, which is the one failure this whole design is
/// arranged to make unrepresentable. Atomic replacement is what makes it so.
///
/// There is deliberately no `PartialEq` here. Comparing two snapshots would
/// compare their provenance, and provenance moves on every tick — so a
/// snapshot-level comparison answers *did we look again* when the question is
/// always *did anything change*. [`Snapshot::changed_from`] is the only
/// comparison there is, and it is the model's.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u32,
    pub model: Model,
    pub provenance: Provenance,
}

/// How this snapshot came to exist, and when. Age is always renderable because
/// provenance is part of the snapshot rather than a sibling of it.
///
/// **No `PartialEq`, on purpose.** Change detection is the model's business and
/// only the model's; a `Provenance` that could be compared is a `Provenance`
/// that ends up inside somebody's equality check, and the field most likely to
/// be reached for there is a timestamp. The absence of the trait is what makes
/// that a compile error rather than a code-review habit.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: Source,
    pub outcome: ReadOutcome,
    /// RFC 3339. Carried as text so this crate needs no clock and no time
    /// dependency — the caller that has a clock stamps it.
    pub fetched_at: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// A live read. The only source permitted to write or delete cache.
    Github,
    /// A copy, never an authority.
    Cache,
    /// A checked-in JSON file driving `dev:web`.
    Fixture,
    /// Nothing has been read yet.
    None,
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum ReadOutcome {
    Ok,
    Failed(String),
    /// No read has been attempted.
    NotAttempted,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot is not valid JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("snapshot schema version {found} is not supported (this build speaks {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
}

impl Snapshot {
    /// The state the app opens in: chrome, and no map behind it.
    pub fn no_map_open() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            model: Model::no_map_open(),
            provenance: Provenance {
                source: Source::None,
                outcome: ReadOutcome::NotAttempted,
                fetched_at: None,
            },
        }
    }

    /// One read that landed, derived and stamped.
    pub fn read(model: Model, source: Source, fetched_at: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            model,
            provenance: Provenance {
                source,
                outcome: ReadOutcome::Ok,
                fetched_at: Some(fetched_at),
            },
        }
    }

    /// **A failed poll still emits a snapshot, never silence.**
    ///
    /// The model stays exactly as it was and only the outcome changes: what you
    /// were reading is still true of the last time anybody looked, and emptying
    /// the graph would assert that the operator's tickets are gone on the
    /// strength of not having been able to look. The stamp does not move
    /// either — the copy on screen has the age it always had, and it goes on
    /// ageing, which is what makes staleness visible at exactly the moment
    /// staleness starts mattering.
    ///
    /// Taking `self` by value is the mechanism: there is no way to emit the
    /// failure *beside* the snapshot it aged, so *no silent retry* is a shape
    /// rather than a rule somebody keeps.
    pub fn aged(mut self, why: String) -> Self {
        self.provenance.outcome = ReadOutcome::Failed(why);
        self
    }

    /// **Changed means the model changed** — structural equality over the whole
    /// of it, and the only comparison in this crate.
    ///
    /// Whole-model rather than a hash or a chosen field set. A shortlist is a
    /// field added later, forgotten, and the graph going quietly wrong with no
    /// error anywhere; a hash is the same failure with an extra step. And
    /// nothing here reaches a timestamp, because the model has none to reach —
    /// see [`crate::derive`].
    pub fn changed_from(&self, previous: &Snapshot) -> bool {
        self.model != previous.model
    }

    /// Constructible from a JSON file as easily as from GitHub. This is the
    /// cheap constraint the shared seam lands on the model crate, and the
    /// reason `dev:web` can boot with no Rust, no GitHub and no PTY.
    pub fn from_json_str(json: &str) -> Result<Self, SnapshotError> {
        let snapshot: Snapshot = serde_json::from_str(json)?;
        if snapshot.schema_version != SCHEMA_VERSION {
            return Err(SnapshotError::UnsupportedSchemaVersion {
                found: snapshot.schema_version,
                expected: SCHEMA_VERSION,
            });
        }
        Ok(snapshot)
    }

    pub fn to_json_string(&self) -> Result<String, SnapshotError> {
        Ok(serde_json::to_string_pretty(self)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::{Counts, Phase};
    use crate::read_response;

    const NO_MAP_OPEN_FIXTURE: &str = include_str!("../fixtures/no-map-open.json");
    const TWO_MAPS: &str = include_str!("../fixtures/two-maps-one-open.json");

    fn a_read() -> Model {
        Model::of(&read_response(TWO_MAPS).expect("reads"))
    }

    #[test]
    fn a_fresh_snapshot_reports_absence_rather_than_an_empty_map() {
        let snapshot = Snapshot::no_map_open();

        assert!(snapshot.model.map.is_none());
        assert_eq!(snapshot.provenance.outcome, ReadOutcome::NotAttempted);
        assert_eq!(snapshot.provenance.fetched_at, None);
    }

    #[test]
    fn a_snapshot_survives_a_round_trip_through_json() {
        let snapshot = Snapshot::read(a_read(), Source::Github, "2026-08-05T09:00:00Z".to_string());

        let json = snapshot.to_json_string().expect("serialises");
        let parsed = Snapshot::from_json_str(&json).expect("parses");

        // The model compares; the provenance is checked field by field, there
        // being no equality on it to reach for.
        assert_eq!(parsed.model, snapshot.model);
        assert_eq!(parsed.provenance.source, Source::Github);
        assert_eq!(parsed.provenance.outcome, ReadOutcome::Ok);
        assert_eq!(
            parsed.provenance.fetched_at.as_deref(),
            Some("2026-08-05T09:00:00Z")
        );
    }

    #[test]
    fn a_checked_in_fixture_loads_the_same_way_a_github_read_would() {
        let snapshot = Snapshot::from_json_str(NO_MAP_OPEN_FIXTURE).expect("fixture parses");

        assert_eq!(snapshot.model, Model::no_map_open());
        assert_eq!(snapshot.provenance.source, Source::None);
    }

    #[test]
    fn a_derived_map_survives_a_round_trip_through_json() {
        // The whole model, not just its outline: a fixture is only as good as
        // the states it can carry, and `dev:web` boots from one of these.
        let snapshot = Snapshot::read(
            a_read(),
            Source::Fixture,
            "2026-08-05T09:00:00Z".to_string(),
        );

        let parsed = Snapshot::from_json_str(&snapshot.to_json_string().expect("serialises"))
            .expect("parses");
        let map = parsed.model.map.expect("a map");

        assert_eq!(map.number, 28);
        assert_eq!(map.phase, Phase::Wayfinding);
        assert_eq!(
            map.counts,
            Counts {
                tickets: 2,
                open: 2,
                specs: 0
            }
        );
        assert_eq!(map.frontier, Some(32));
    }

    #[test]
    fn an_unrecognised_schema_version_is_refused_rather_than_guessed_at() {
        let json = r#"{
            "schemaVersion": 99,
            "model": { "map": null },
            "provenance": { "source": "none", "outcome": { "kind": "notAttempted" }, "fetchedAt": null }
        }"#;

        let error = Snapshot::from_json_str(json).expect_err("refuses");

        assert!(matches!(
            error,
            SnapshotError::UnsupportedSchemaVersion { found: 99, .. }
        ));
    }

    #[test]
    fn a_failed_read_carries_its_reason_into_the_snapshot() {
        let json = r#"{
            "schemaVersion": 1,
            "model": { "map": null },
            "provenance": {
                "source": "cache",
                "outcome": { "kind": "failed", "detail": "rate limit exhausted" },
                "fetchedAt": "2026-08-05T08:00:00Z"
            }
        }"#;

        let snapshot = Snapshot::from_json_str(json).expect("parses");

        assert_eq!(
            snapshot.provenance.outcome,
            ReadOutcome::Failed("rate limit exhausted".to_string())
        );
        assert_eq!(snapshot.provenance.source, Source::Cache);
    }

    #[test]
    fn a_poll_that_failed_still_emits_a_snapshot_with_the_model_it_already_had() {
        let held = Snapshot::read(a_read(), Source::Cache, "2026-08-05T08:00:00Z".to_string());
        let before = held.model.clone();

        let emitted = held.aged("could not reach GitHub".to_string());

        // Never silence: there is a snapshot, it carries the same graph, and
        // the stamp is the one the copy already had — which is what makes it
        // visibly age rather than quietly refresh.
        assert_eq!(emitted.model, before);
        assert_eq!(
            emitted.provenance.outcome,
            ReadOutcome::Failed("could not reach GitHub".to_string())
        );
        assert_eq!(
            emitted.provenance.fetched_at.as_deref(),
            Some("2026-08-05T08:00:00Z")
        );
    }

    #[test]
    fn a_failed_poll_is_not_a_change() {
        let held = Snapshot::read(a_read(), Source::Github, "2026-08-05T08:00:00Z".to_string());
        let aged = held.clone().aged("could not reach GitHub".to_string());

        // The whole reason change detection is the model's and not the
        // snapshot's: a poll that failed moved the stamp and nothing else, and
        // a ledger entry for it would be an entry about the poller rather than
        // about the graph.
        assert!(!aged.changed_from(&held));
    }

    #[test]
    fn a_second_read_at_a_different_moment_is_not_a_change() {
        let first = Snapshot::read(a_read(), Source::Github, "2026-08-05T08:00:00Z".to_string());
        let second = Snapshot::read(a_read(), Source::Github, "2026-08-05T09:00:00Z".to_string());

        assert!(!second.changed_from(&first));
    }

    #[test]
    fn a_ticket_that_moved_is_a_change() {
        let first = Snapshot::read(a_read(), Source::Github, "2026-08-05T08:00:00Z".to_string());
        let mut model = a_read();
        model.map.as_mut().expect("a map").nodes.remove(0);
        let second = Snapshot::read(model, Source::Github, "2026-08-05T08:00:00Z".to_string());

        assert!(second.changed_from(&first));
    }
}
