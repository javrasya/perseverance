//! What one recorded GraphQL response says — and nothing derived from it.
//!
//! The derivation is #33's. This module is the *parse*: which maps the label
//! found, which map the response carried the graph of, and the budget that rode
//! along. It lives in the model crate because "recorded GraphQL responses" is
//! what this crate's own charter says sits below it, and because a parser that
//! can be driven by a checked-in JSON file is a parser that can be tested with
//! no network anywhere near it.
//!
//! The children of the open map are deliberately **not** parsed here. They stay
//! in the response body, which is what gets cached, so that #33 derives its
//! model from exactly the bytes GitHub sent rather than from a lossy shadow of
//! them taken on the way past.

use crate::MapRef;

/// The label a map is discovered by.
///
/// Discovery is by label rather than by registration, so a map charted by an
/// agent session in your own terminal appears without your telling the app
/// about it. It is a constant here — beside the parser that reads the answer —
/// rather than in the crate that sends the query, because the two have to agree
/// and only one of them can be tested without a network.
pub const MAP_LABEL: &str = "wayfinder:map";

/// One map, as the label found it.
///
/// No phase, no counts, no children: those are derived, and derivation is #33's.
/// What a row of the map list needs is a number to open, a name to read, and
/// whether it is finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapListing {
    pub number: u64,
    pub title: String,
    /// GitHub's own state. A closed map groups under *Completed* rather than
    /// being hidden, so this is a grouping fact and never a filter.
    pub closed: bool,
    pub url: String,
    /// RFC 3339, as GitHub sent it.
    pub updated_at: String,
}

/// The whole of one read, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapRead {
    /// In the order GitHub answered in. Never re-sorted here: the order of an
    /// answer is a fact about the answer, and a harness that invents a ranking
    /// is the thing this spec keeps refusing to build.
    pub maps: Vec<MapListing>,
    /// Which map the response carried the graph of, if the query asked for one.
    pub map: Option<MapRef>,
    /// Carried, never acted on. The budget floor is #39's and the backoff is
    /// #40's; this slice only makes sure the numbers arrive.
    pub rate_limit: Option<RateLimit>,
    pub truncation: Truncation,
}

/// `rateLimit { … }`, which rides the same query for free.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimit {
    pub cost: u32,
    pub node_count: u32,
    pub limit: u32,
    pub remaining: u32,
    /// RFC 3339, as GitHub sent it. Carried as text for the same reason
    /// [`crate::Provenance::fetched_at`] is: this crate has no clock.
    pub reset_at: String,
}

/// Tripwires for pages that cannot exist.
///
/// GitHub caps sub-issues at 100 per parent and linked issues at 50 per
/// relationship, and both fit in one page — so a paging loop here would be code
/// nobody has ever run, which is worse than no code at all. These are parsed and
/// asserted on instead: if one ever fires, the fact is in the read rather than
/// silently missing from the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Truncation {
    pub maps: bool,
    pub children: bool,
    pub blocked_by: bool,
}

impl Truncation {
    /// Whether anything at all was cut off. One question, so a caller does not
    /// have to remember which three fields to ask about.
    pub fn any(&self) -> bool {
        self.maps || self.children || self.blocked_by
    }
}

/// Why a response could not be read.
///
/// None of these is a transport failure — a body only exists because something
/// answered. Telling them apart from *could not reach GitHub* is what stops the
/// reader being sent to their network when the answer arrived and said no.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadError {
    #[error("what came back was not JSON: {0}")]
    NotJson(String),

    /// GraphQL answers `200` with an `errors` array, so this is the ordinary
    /// shape of a refusal rather than an exotic one.
    #[error("GitHub answered the query with an error: {0}")]
    Answered(String),

    /// `data.repository` is null when the repository is not there, or not
    /// visible to this token. Either way the response is not an answer about
    /// this map, and treating it as an empty map list would erase every map the
    /// operator has.
    #[error("the answer carried no repository, so it is not an answer about this one")]
    NoRepository,
}

/// Reads one response body.
///
/// Pure, and the reason the whole of this file can be tested from checked-in
/// text with no token, no network and no `gh` on either runner.
pub fn read_response(body: &str) -> Result<MapRead, ReadError> {
    let response: wire::Response =
        serde_json::from_str(body).map_err(|error| ReadError::NotJson(error.to_string()))?;

    // Checked before `data`, and on purpose: GraphQL will answer with a partial
    // `data` beside an `errors` array, and a partial answer is not an answer.
    // Reading it anyway would put a half-populated map list on screen with
    // nothing on it saying so.
    if let Some(first) = response.errors.into_iter().flatten().next() {
        return Err(ReadError::Answered(first.message));
    }

    let repository = response
        .data
        .and_then(|data| {
            let rate_limit = data.rate_limit;
            data.repository.map(|repository| (repository, rate_limit))
        })
        .ok_or(ReadError::NoRepository)?;
    let (repository, rate_limit) = repository;

    let mut truncation = Truncation {
        maps: repository.maps.page_info.has_next_page,
        ..Truncation::default()
    };

    // Twice, deliberately: the connection may be absent, and GraphQL's own type
    // says any single node in a list may be null. Both are *nothing here*, and
    // neither is worth a variant.
    let maps = repository
        .maps
        .nodes
        .into_iter()
        .flatten()
        .flatten()
        .map(|node| MapListing {
            number: node.number,
            title: node.title,
            closed: node.state.eq_ignore_ascii_case("CLOSED"),
            url: node.url,
            updated_at: node.updated_at,
        })
        .collect();

    let map = repository.issue.map(|issue| {
        truncation.children |= issue.sub_issues.page_info.has_next_page;
        for child in issue.sub_issues.nodes.iter().flatten().flatten() {
            truncation.blocked_by |= child.blocked_by.page_info.has_next_page;
        }
        MapRef {
            number: issue.number,
            title: issue.title,
        }
    });

    Ok(MapRead {
        maps,
        map,
        rate_limit: rate_limit.map(|limit| RateLimit {
            cost: limit.cost,
            node_count: limit.node_count,
            limit: limit.limit,
            remaining: limit.remaining,
            reset_at: limit.reset_at,
        }),
        truncation,
    })
}

/// Seconds since the Unix epoch, as the RFC 3339 text every stamp in this
/// workspace is carried in.
///
/// Hand-rolled rather than taken as a dependency, for the reason ADR 0002
/// hand-rolled base64: the whole of what is needed is one civil-date conversion,
/// and a date library in the crate whose defining property is having almost no
/// dependencies is a poor trade. UTC only — a stamp that changes meaning when
/// the operator flies somewhere is not a stamp.
pub fn rfc3339(epoch_seconds: i64) -> String {
    const SECONDS_PER_DAY: i64 = 86_400;

    let days = epoch_seconds.div_euclid(SECONDS_PER_DAY);
    let seconds = epoch_seconds.rem_euclid(SECONDS_PER_DAY);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// Howard Hinnant's `civil_from_days`, which is the shortest correct answer to
/// "what date is day *n* after the epoch" and needs no table and no leap-year
/// special case at the call site.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;

    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// The response as GitHub spells it, and nowhere else.
///
/// Kept private so that a field GitHub renames is a compile error in one file
/// rather than a type the rest of the workspace has learned to name. Nothing
/// here denies unknown fields: GitHub adds them, and a read that refused an
/// answer for carrying more than it was asked for would be a poller that stops
/// working on a Tuesday for no reason the operator can see.
mod wire {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub(super) struct Response {
        pub data: Option<Data>,
        pub errors: Option<Vec<GraphQlError>>,
    }

    #[derive(Deserialize)]
    pub(super) struct GraphQlError {
        #[serde(default)]
        pub message: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Data {
        pub repository: Option<Repository>,
        pub rate_limit: Option<RateLimit>,
    }

    #[derive(Deserialize)]
    pub(super) struct Repository {
        #[serde(default)]
        pub maps: Connection<MapNode>,
        /// Absent when no map is open, because the query skips the field rather
        /// than asking for issue number zero.
        pub issue: Option<Issue>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct MapNode {
        pub number: u64,
        #[serde(default)]
        pub title: String,
        #[serde(default)]
        pub state: String,
        #[serde(default)]
        pub url: String,
        #[serde(default)]
        pub updated_at: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Issue {
        pub number: u64,
        #[serde(default)]
        pub title: String,
        #[serde(default)]
        pub sub_issues: Connection<Child>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Child {
        #[serde(default)]
        pub blocked_by: Connection<serde_json::Value>,
    }

    /// The bound is written out because `serde`'s derive would otherwise
    /// require `T: Default` of every node type — an artefact of the
    /// `#[serde(default)]` above, and a requirement none of these types has any
    /// business satisfying.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", bound(deserialize = "T: Deserialize<'de>"))]
    pub(super) struct Connection<T> {
        #[serde(default = "no_nodes")]
        pub nodes: Option<Vec<Option<T>>>,
        #[serde(default)]
        pub page_info: PageInfo,
    }

    /// Named rather than `Default::default`, so the bound above stays the only
    /// thing the generic parameter has to satisfy.
    fn no_nodes<T>() -> Option<Vec<Option<T>>> {
        None
    }

    /// A connection GitHub omitted is an empty one that was not truncated, which
    /// is the only reading that does not invent a page nobody was told about.
    impl<T> Default for Connection<T> {
        fn default() -> Self {
            Connection {
                nodes: None,
                page_info: PageInfo::default(),
            }
        }
    }

    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct PageInfo {
        #[serde(default)]
        pub has_next_page: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct RateLimit {
        #[serde(default)]
        pub cost: u32,
        #[serde(default)]
        pub node_count: u32,
        #[serde(default)]
        pub limit: u32,
        #[serde(default)]
        pub remaining: u32,
        #[serde(default)]
        pub reset_at: String,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_MAPS: &str = include_str!("../fixtures/two-maps-one-open.json");
    const NO_MAP: &str = include_str!("../fixtures/no-map-in-this-repo.json");

    #[test]
    fn a_response_yields_the_maps_the_label_found_in_the_order_they_arrived() {
        let read = read_response(TWO_MAPS).expect("reads");

        let numbers: Vec<u64> = read.maps.iter().map(|map| map.number).collect();
        assert_eq!(numbers, vec![28, 1]);
        assert_eq!(read.maps[0].title, "Spec: perseverance");
        assert_eq!(read.maps[0].url, "https://github.com/o/r/issues/28");
    }

    #[test]
    fn a_closed_map_is_carried_as_finished_rather_than_dropped_from_the_answer() {
        let read = read_response(TWO_MAPS).expect("reads");

        let closed: Vec<u64> = read
            .maps
            .iter()
            .filter(|map| map.closed)
            .map(|map| map.number)
            .collect();
        // The finished map is in the list. Grouping it under *Completed* is the
        // view's job; losing it would be this file's failure.
        assert_eq!(closed, vec![1]);
    }

    #[test]
    fn a_repository_with_no_map_reads_as_an_empty_list_rather_than_a_refusal() {
        let read = read_response(NO_MAP).expect("reads");

        assert!(read.maps.is_empty());
        assert_eq!(read.map, None);
        // A folder whose first charting session judged the work small enough to
        // just do has no map, and that is not a failure of anything.
        assert!(read.rate_limit.is_some());
    }

    #[test]
    fn the_budget_rides_the_same_answer_as_the_maps() {
        let read = read_response(TWO_MAPS).expect("reads");

        let budget = read.rate_limit.expect("the budget rode along");
        assert_eq!(budget.cost, 2);
        assert_eq!(budget.remaining, 4_417);
        assert_eq!(budget.limit, 5_000);
        assert_eq!(budget.reset_at, "2026-08-05T11:02:14Z");
    }

    #[test]
    fn the_open_map_is_named_by_the_same_answer_that_listed_the_maps() {
        let read = read_response(TWO_MAPS).expect("reads");

        assert_eq!(
            read.map,
            Some(MapRef {
                number: 28,
                title: "Spec: perseverance".to_string(),
            })
        );
    }

    #[test]
    fn a_response_with_no_map_open_is_read_without_one_rather_than_refused() {
        let read = read_response(NO_MAP).expect("reads");

        assert_eq!(read.map, None);
    }

    #[test]
    fn nothing_is_reported_as_truncated_when_every_page_was_the_only_page() {
        let read = read_response(TWO_MAPS).expect("reads");

        assert!(!read.truncation.any(), "{:?}", read.truncation);
    }

    #[test]
    fn a_page_that_cannot_exist_is_reported_rather_than_silently_dropped() {
        let body = r#"{
            "data": {
                "repository": {
                    "maps": {
                        "pageInfo": { "hasNextPage": true },
                        "nodes": [ { "number": 1, "title": "One", "state": "OPEN", "url": "u" } ]
                    },
                    "issue": {
                        "number": 1,
                        "title": "One",
                        "subIssues": {
                            "pageInfo": { "hasNextPage": true },
                            "nodes": [
                                { "blockedBy": { "pageInfo": { "hasNextPage": true }, "nodes": [] } }
                            ]
                        }
                    }
                },
                "rateLimit": null
            }
        }"#;

        let read = read_response(body).expect("reads");

        assert_eq!(
            read.truncation,
            Truncation {
                maps: true,
                children: true,
                blocked_by: true,
            }
        );
    }

    #[test]
    fn an_answer_carrying_an_error_beside_its_data_is_refused_rather_than_half_read() {
        let body = r#"{
            "data": { "repository": null, "rateLimit": null },
            "errors": [ { "message": "Could not resolve to a Repository with the name 'o/r'." } ]
        }"#;

        let refusal = read_response(body).expect_err("refuses");

        assert_eq!(
            refusal,
            ReadError::Answered(
                "Could not resolve to a Repository with the name 'o/r'.".to_string()
            )
        );
    }

    #[test]
    fn an_answer_with_no_repository_in_it_is_not_read_as_a_repository_with_no_maps() {
        // The difference that matters: an empty list means *this repo has no
        // maps*, and erasing every map an operator has because a token lost
        // sight of the repository would be exactly the silent data loss the
        // cache rules exist to prevent.
        let body = r#"{ "data": { "repository": null, "rateLimit": null } }"#;

        assert_eq!(
            read_response(body).expect_err("refuses"),
            ReadError::NoRepository
        );
    }

    #[test]
    fn something_that_is_not_json_is_refused_in_terms_of_what_arrived() {
        let refusal = read_response("<html>502 Bad Gateway</html>").expect_err("refuses");

        assert!(matches!(refusal, ReadError::NotJson(_)));
    }

    #[test]
    fn a_field_github_added_since_this_build_shipped_does_not_stop_the_read() {
        let body = r#"{
            "data": {
                "repository": {
                    "maps": {
                        "pageInfo": { "hasNextPage": false, "endCursor": "Y3Vyc29y" },
                        "nodes": [
                            { "number": 7, "title": "Seven", "state": "OPEN", "url": "u",
                              "somethingNewInAPril": true }
                        ]
                    }
                },
                "rateLimit": null,
                "somethingElseNew": 3
            }
        }"#;

        let read = read_response(body).expect("reads");

        assert_eq!(read.maps.len(), 1);
        assert_eq!(read.maps[0].number, 7);
    }

    #[test]
    fn no_read_refusal_reads_like_a_failure_to_reach_github() {
        // A body only exists because something answered. Every sentence here
        // has to send the reader somewhere other than their network.
        const NETWORK_VOCABULARY: &[&str] = &[
            "reach",
            "connect",
            "offline",
            "timeout",
            "retry",
            "unreachable",
        ];

        let refusals = [
            ReadError::NotJson("expected value at line 1".to_string()).to_string(),
            ReadError::Answered("Could not resolve to a Repository".to_string()).to_string(),
            ReadError::NoRepository.to_string(),
        ];

        for refusal in refusals {
            let lowered = refusal.to_lowercase();
            for word in NETWORK_VOCABULARY {
                assert!(
                    !lowered.contains(word),
                    "{refusal:?} reads like a failure to reach GitHub because of {word:?}"
                );
            }
        }
    }

    #[test]
    fn an_epoch_second_is_stamped_as_the_utc_text_every_other_stamp_is_carried_in() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_785_888_000), "2026-08-05T00:00:00Z");
        assert_eq!(rfc3339(1_785_945_600), "2026-08-05T16:00:00Z");
        // A leap day, because the one-line date conversion above is where a
        // leap year goes wrong if it is going to.
        assert_eq!(rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        // 1900 was not a leap year; 2100 will not be either.
        assert_eq!(rfc3339(4_107_542_400), "2100-03-01T00:00:00Z");
    }

    #[test]
    fn a_clock_set_before_the_epoch_still_stamps_a_date_rather_than_panicking() {
        assert_eq!(rfc3339(-1), "1969-12-31T23:59:59Z");
    }
}
