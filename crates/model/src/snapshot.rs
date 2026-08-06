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

/// Why a read did not land, as a structure rather than as prose.
///
/// **Four conditions, and the question they answer is not *what happened* but
/// *is waiting going to help*.** Two of them say yes and two say no, and that
/// split is the whole of #40: backing off forever on a revoked token is silent
/// failure wearing a retry costume, and an operator watching a stamp age
/// assumes a flaky network when the fix is one command.
///
/// It lives in the model crate because it crosses the seam in both directions.
/// The WebView keys a condition on the graph off it; the poller keys a floor
/// off the same taxonomy. Classifying at either end instead would be two
/// classifiers, and two classifiers are two answers that disagree the day
/// somebody edits one of them.
///
/// The raw detail is deliberately **not** in here. It rides beside this on
/// [`ReadOutcome::Failed`], in the words of whichever crate established it, so
/// that what the app *concluded* and what it was *told* stay two things. A
/// reason with the sentence folded into it is a reason somebody parses.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum Degraded {
    /// Nothing answered, or what answered could not be read. Retrying is what
    /// fixes it. Schema drift lands here too: a build that cannot read today's
    /// answer keeps the last good model and tries again, because a parser this
    /// build is too old for is not a reason to assert the graph is gone.
    Unreachable,
    /// The token is wrong, revoked, or was never acquired. Waiting cannot fix
    /// it and the remedy is one command.
    AuthFailed,
    /// The answer arrived and denied the thing exists. Gone is reported as
    /// gone rather than retried until somebody notices.
    MapGone,
    /// RFC 3339, as `Retry-After` resolved against the moment the answer
    /// landed. `None` when nothing said when.
    ///
    /// The per-variant `rename_all` is not decoration: the enum-level one
    /// renames *variants*, and a struct variant's fields keep their Rust
    /// spelling without this — which crosses the seam as `resets_at` and
    /// deserialises back to `None` from the camel-cased text it wrote.
    #[serde(rename_all = "camelCase")]
    RateLimited { resets_at: Option<String> },
}

#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ReadOutcome {
    Ok,
    /// What the app concluded, and what it was told, side by side.
    ///
    /// Internally tagged now, where it used to be adjacently tagged. The
    /// `content = "detail"` spelling existed only because this was a newtype
    /// over a string; a variant carrying two fields has no single content for
    /// a `content` key to hold.
    Failed {
        reason: Degraded,
        detail: String,
    },
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
    ///
    /// Both arguments, always. `reason` is what the app concluded and `why` is
    /// the sentence it was handed; a signature that took one of them would
    /// force whoever holds the other to invent it, and a condition invented at
    /// the render site is a condition nobody established.
    pub fn aged(mut self, reason: Degraded, why: String) -> Self {
        self.provenance.outcome = ReadOutcome::Failed {
            reason,
            detail: why,
        };
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
    fn a_failed_read_carries_both_what_was_concluded_and_what_was_said() {
        let json = r#"{
            "schemaVersion": 1,
            "model": { "map": null },
            "provenance": {
                "source": "cache",
                "outcome": {
                    "kind": "failed",
                    "reason": { "reason": "rateLimited", "resetsAt": "2026-08-05T09:00:00Z" },
                    "detail": "rate limit exhausted"
                },
                "fetchedAt": "2026-08-05T08:00:00Z"
            }
        }"#;

        let snapshot = Snapshot::from_json_str(json).expect("parses");

        // Two fields and not one. The structure is what decides whether waiting
        // helps; the sentence is what an operator reads. A shape that folded
        // them together would leave one of the two to be guessed at.
        assert_eq!(
            snapshot.provenance.outcome,
            ReadOutcome::Failed {
                reason: Degraded::RateLimited {
                    resets_at: Some("2026-08-05T09:00:00Z".to_string())
                },
                detail: "rate limit exhausted".to_string(),
            }
        );
        assert_eq!(snapshot.provenance.source, Source::Cache);
    }

    #[test]
    fn every_condition_a_read_can_be_in_survives_a_round_trip_through_json() {
        // The taxonomy crosses the seam, so it has to survive the crossing.
        // One table, because four separate assertions are four chances to
        // check three of them.
        let conditions = [
            (Degraded::Unreachable, "unreachable"),
            (Degraded::AuthFailed, "authFailed"),
            (Degraded::MapGone, "mapGone"),
            (
                Degraded::RateLimited {
                    resets_at: Some("2026-08-05T09:00:00Z".to_string()),
                },
                "rateLimited",
            ),
            // Nothing said when, which is a different fact from a reset now.
            (Degraded::RateLimited { resets_at: None }, "rateLimited"),
        ];

        for (reason, tag) in conditions {
            let snapshot =
                Snapshot::read(a_read(), Source::Cache, "2026-08-05T08:00:00Z".to_string())
                    .aged(reason.clone(), "what the crate said".to_string());

            let json: serde_json::Value =
                serde_json::from_str(&snapshot.to_json_string().expect("serialises"))
                    .expect("is JSON");
            assert_eq!(json["provenance"]["outcome"]["kind"], "failed");
            assert_eq!(json["provenance"]["outcome"]["reason"]["reason"], tag);
            assert_eq!(
                json["provenance"]["outcome"]["detail"],
                "what the crate said"
            );

            let parsed = Snapshot::from_json_str(&snapshot.to_json_string().expect("serialises"))
                .expect("parses");
            assert_eq!(
                parsed.provenance.outcome,
                ReadOutcome::Failed {
                    reason,
                    detail: "what the crate said".to_string()
                }
            );
        }
    }

    #[test]
    fn a_poll_that_failed_still_emits_a_snapshot_with_the_model_it_already_had() {
        let held = Snapshot::read(a_read(), Source::Cache, "2026-08-05T08:00:00Z".to_string());
        let before = held.model.clone();

        let emitted = held.aged(Degraded::Unreachable, "could not reach GitHub".to_string());

        // Never silence: there is a snapshot, it carries the same graph, and
        // the stamp is the one the copy already had — which is what makes it
        // visibly age rather than quietly refresh.
        assert_eq!(emitted.model, before);
        assert_eq!(
            emitted.provenance.outcome,
            ReadOutcome::Failed {
                reason: Degraded::Unreachable,
                detail: "could not reach GitHub".to_string(),
            }
        );
        assert_eq!(
            emitted.provenance.fetched_at.as_deref(),
            Some("2026-08-05T08:00:00Z")
        );
    }

    #[test]
    fn a_failed_poll_is_not_a_change() {
        let held = Snapshot::read(a_read(), Source::Github, "2026-08-05T08:00:00Z".to_string());
        let aged = held
            .clone()
            .aged(Degraded::Unreachable, "could not reach GitHub".to_string());

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
