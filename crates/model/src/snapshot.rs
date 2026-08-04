use serde::{Deserialize, Serialize};

/// Forward-only. An unrecognised version is refused rather than guessed at.
pub const SCHEMA_VERSION: u32 = 1;

/// Everything the WebView is given for one tick.
///
/// The derivation itself lands in a later ticket; what is fixed here is that
/// there is exactly one such type, that provenance is fused into it rather
/// than travelling alongside, and that it round-trips through JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u32,
    /// `None` is the *no map open* state — an absence, never a zero. The chrome
    /// exists before it holds anything.
    pub map: Option<MapRef>,
    pub provenance: Provenance,
}

/// Identity of the map a snapshot was derived from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRef {
    pub number: u64,
    pub title: String,
}

/// How this snapshot came to exist, and when. Age is always renderable because
/// provenance is part of the snapshot rather than a sibling of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source: Source,
    pub outcome: ReadOutcome,
    /// RFC 3339. Carried as text so this crate needs no clock and no time
    /// dependency — the caller that has a clock stamps it.
    pub fetched_at: Option<String>,
}

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
            map: None,
            provenance: Provenance {
                source: Source::None,
                outcome: ReadOutcome::NotAttempted,
                fetched_at: None,
            },
        }
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

    const NO_MAP_OPEN_FIXTURE: &str = include_str!("../fixtures/no-map-open.json");

    #[test]
    fn a_fresh_snapshot_reports_absence_rather_than_an_empty_map() {
        let snapshot = Snapshot::no_map_open();

        assert!(snapshot.map.is_none());
        assert_eq!(snapshot.provenance.outcome, ReadOutcome::NotAttempted);
        assert_eq!(snapshot.provenance.fetched_at, None);
    }

    #[test]
    fn a_snapshot_survives_a_round_trip_through_json() {
        let snapshot = Snapshot {
            schema_version: SCHEMA_VERSION,
            map: Some(MapRef {
                number: 1,
                title: "Wayfinder harness".to_string(),
            }),
            provenance: Provenance {
                source: Source::Github,
                outcome: ReadOutcome::Ok,
                fetched_at: Some("2026-08-05T09:00:00Z".to_string()),
            },
        };

        let json = snapshot.to_json_string().expect("serialises");
        let parsed = Snapshot::from_json_str(&json).expect("parses");

        assert_eq!(parsed, snapshot);
    }

    #[test]
    fn a_checked_in_fixture_loads_the_same_way_a_github_read_would() {
        let snapshot = Snapshot::from_json_str(NO_MAP_OPEN_FIXTURE).expect("fixture parses");

        assert_eq!(snapshot, Snapshot::no_map_open());
    }

    #[test]
    fn an_unrecognised_schema_version_is_refused_rather_than_guessed_at() {
        let json = r#"{
            "schemaVersion": 99,
            "map": null,
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
            "map": null,
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
}
