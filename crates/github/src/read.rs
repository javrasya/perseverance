//! The one query shape, and the socket it goes down.
//!
//! This is where the crate's charter is spent: `perseverance-github` is the only
//! crate in the workspace that opens a socket, and this module is the only place
//! in this crate that does. The token acquired at launch is *used* here and
//! nowhere else; it is put in a header, never in an argv, because an argument
//! vector is readable by every process on the machine and a header is not.
//!
//! The split mirrors [`crate::token`]: an impure [`read_maps`] that composes the
//! request, spends the token and reads the clock, and a pure [`interpret_read`]
//! that decides what a finished exchange *means*. Every branch of the meaning is
//! reachable in a test with no network and no token, which matters here for the
//! same reason it mattered there — no CI runner has signed in.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use perseverance_model::{epoch_from_rfc3339, read_response, MapRead, ReadError};

use crate::{Budget, Token};

/// The one document. Held as a file rather than a string literal so that it can
/// be pasted into `gh api graphql -F query=@…` unchanged when someone needs to
/// ask GitHub the same question by hand.
pub const MAP_READ_QUERY: &str = include_str!("map-read.graphql");

/// The only endpoint this app ever reaches.
pub const GRAPHQL_ENDPOINT: &str = "https://api.github.com/graphql";

/// Sent because GitHub asks for one, and named for the app rather than for a
/// library so that a rate-limit conversation with GitHub can identify us.
const USER_AGENT: &str = concat!("perseverance/", env!("CARGO_PKG_VERSION"));

/// Long enough for a slow answer at fifty times the ~0.4 s whole-query latency
/// measured, and short enough that a read which is never coming back cannot hold
/// the poller for a minute.
///
/// It is deliberately **longer than the fastest rung**, which is ten seconds
/// (`cadence.rs`), so a slow answer can still be in flight when the next tick
/// falls due. Nothing stacks: the loop is one thread, it is not back at its
/// channel while a read is running, and it stamps its next wait from when the
/// read *returned* rather than from when it started. A deadline shortened to fit
/// under the rung would be abandoning slow answers to protect an invariant the
/// loop's shape already holds.
const DEADLINE: Duration = Duration::from_secs(20);

/// A read that GitHub answered, successfully, once.
///
/// **It has no public constructor.** That is the whole mechanism behind
/// *`graph_cache` is written only on a successful GitHub read*: the write takes
/// one of these, and the only way to hold one is to have been handed it by
/// [`interpret_read`] after an answer that parsed. A cache write from a cached
/// value cannot be spelled, rather than being a rule someone has to remember.
///
/// It carries the response **verbatim** beside the parse, because the verbatim
/// bytes are what gets cached: #33 derives its model from exactly what GitHub
/// sent rather than from a lossy shadow taken on the way past.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshRead {
    body: String,
    read: MapRead,
    fetched_at: i64,
}

impl FreshRead {
    /// The response as GitHub sent it. This is what the cache stores.
    pub fn body(&self) -> &str {
        &self.body
    }

    /// What that response says. Parsed once, here, so that a body which cannot
    /// be read never becomes a successful read.
    pub fn read(&self) -> &MapRead {
        &self.read
    }

    /// Seconds since the Unix epoch, taken when the answer arrived. The age on
    /// screen is measured from this.
    pub fn fetched_at(&self) -> i64 {
        self.fetched_at
    }

    /// What this answer said about the rate limit, as the two numbers
    /// [`crate::budget_floor`] is a function of.
    ///
    /// It is here rather than in `cadence.rs` for the reason every clock in this
    /// crate is on this side of the line: turning GitHub's RFC 3339 `resetAt`
    /// into a number of seconds needs a moment to subtract it from, and the pure
    /// half deliberately has none. `perseverance_model` owns the text-to-second
    /// conversion because it already owns its inverse.
    ///
    /// **The horizon is anchored to [`FreshRead::fetched_at`]**, which is when
    /// this answer arrived and not when anybody is asking. That is what lets it
    /// compose with the loop's own subtraction rather than double-counting
    /// against it: the loop measures its wait from the tick that carried this
    /// read, ages the horizon by however much of it that tick has since
    /// consumed, and never re-bases either to *now*.
    ///
    /// `None` for an answer that carried no `rateLimit`, and for a stamp in a
    /// shape this build will not guess at. Both are *this answer said nothing
    /// about the budget*, which the floor reads as no constraint — a horizon of
    /// zero invented here would instead read as *the reset is now*.
    ///
    /// The subtraction is signed and stays that way. A reset already in the past
    /// is a fact, and deciding what it means is the floor's.
    pub fn budget(&self) -> Option<Budget> {
        let limit = self.read.rate_limit.as_ref()?;

        Some(Budget {
            remaining: limit.remaining,
            seconds_to_reset: epoch_from_rfc3339(&limit.reset_at)? - self.fetched_at,
        })
    }
}

/// What a finished exchange was, before anyone decides what it means.
///
/// A transport failure and an answer are different observations, and this is the
/// type that keeps them apart all the way to [`interpret_read`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub body: String,
}

/// Why a read produced no [`FreshRead`].
///
/// Deliberately **descriptive, not a taxonomy**. Classifying these into
/// `Unreachable` / `AuthFailed` / `MapGone` / `RateLimited`, and deciding which
/// of them retries, is #40's whole ticket; inventing half of that vocabulary
/// here would mean #40 arriving to find its decisions already made by a slice
/// that had no reason to make them. What this slice owes is that the three
/// observations stay distinguishable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadFailure {
    /// Nothing answered. The detail is the transport's own account of itself.
    #[error("the read did not complete: {0}")]
    NoAnswer(String),

    /// Something answered, and it was not an answer to the query.
    #[error("GitHub answered with status {code}: {detail}")]
    Status { code: u16, detail: String },

    /// It answered, and what came back could not be read as an answer.
    #[error(transparent)]
    Unreadable(#[from] ReadError),

    /// There is no token, so there is nothing to sign a read with. Not a
    /// failure of the read — a fact about this launch, kept apart from the
    /// three above because the fix is `gh auth login` rather than anything to
    /// do with a request.
    #[error("this run acquired no GitHub token, so no read was attempted")]
    NoToken,
}

/// Reads one repository's maps, and the graph of `map` if one is open.
///
/// The token goes in a header. Nothing about it is logged, measured, or put
/// anywhere a `Debug` could reach it — the request is built, sent, and dropped.
pub fn read_maps(
    token: &Token,
    owner: &str,
    repo: &str,
    map: Option<u64>,
) -> Result<FreshRead, ReadFailure> {
    let sent = send(token, &request_body(owner, repo, map));

    interpret_read(sent, epoch_seconds())
}

/// The request body, as JSON. Separated so a test can read the document this
/// build actually ships rather than a copy of it.
pub fn request_body(owner: &str, repo: &str, map: Option<u64>) -> String {
    // `number` is present on both paths and meaningless on one: `@include` in
    // the document skips the field entirely when `open` is false, and GraphQL
    // still requires every declared variable to be supplied.
    let variables = serde_json::json!({
        "owner": owner,
        "repo": repo,
        "number": map.unwrap_or(0),
        "open": map.is_some(),
    });

    serde_json::json!({ "query": MAP_READ_QUERY, "variables": variables }).to_string()
}

/// What a finished exchange means. Pure, and the reason every branch below is
/// reachable on a runner that has never signed in to anything.
pub fn interpret_read(
    sent: Result<Answer, ReadFailure>,
    fetched_at: i64,
) -> Result<FreshRead, ReadFailure> {
    let answer = sent?;

    // GraphQL answers a refused *query* with 200 and an `errors` array, so a
    // status check alone would let a refusal through as a success — and a
    // success is the thing that writes the cache.
    if !(200..300).contains(&answer.status) {
        return Err(ReadFailure::Status {
            code: answer.status,
            detail: first_line_of(&answer.body, answer.status),
        });
    }

    let read = read_response(&answer.body)?;

    Ok(FreshRead {
        body: answer.body,
        read,
        fetched_at,
    })
}

/// The exchange itself, and the only function in this workspace that opens a
/// socket.
fn send(token: &Token, body: &str) -> Result<Answer, ReadFailure> {
    let sent = ureq::post(GRAPHQL_ENDPOINT)
        .header("Authorization", &format!("bearer {}", token.expose()))
        .header("Content-Type", "application/json")
        .header("User-Agent", USER_AGENT)
        .config()
        // A status is an observation, not an exception: 401 and 403 are answers
        // this app has to read and report, and turning them into transport
        // errors would lose the one number that tells them apart.
        .http_status_as_error(false)
        .timeout_global(Some(DEADLINE))
        .build()
        .send(body);

    let mut answered = match sent {
        Ok(answered) => answered,
        Err(refused) => return Err(ReadFailure::NoAnswer(refused.to_string())),
    };

    let status = answered.status().as_u16();
    match answered.body_mut().read_to_string() {
        Ok(body) => Ok(Answer { status, body }),
        Err(unread) => Err(ReadFailure::NoAnswer(unread.to_string())),
    }
}

/// One line of whatever a non-answer said, or the status if it said nothing.
///
/// A transcript is not a refusal, and an HTML error page pasted into a sentence
/// is not information. When the body is empty the code is the only thing anyone
/// observed, and it is reported as the fact it is.
fn first_line_of(body: &str, status: u16) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect::<String>())
        .unwrap_or_else(|| format!("it said nothing at all (status {status})"))
}

/// Saturates at 0 for a clock set before 1970, for the same reason the
/// registry's does: a stamp that is nonsense is not worth a crash.
fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_MAPS: &str = include_str!("../../model/fixtures/two-maps-one-open.json");

    fn answered(status: u16, body: &str) -> Result<Answer, ReadFailure> {
        Ok(Answer {
            status,
            body: body.to_string(),
        })
    }

    #[test]
    fn a_successful_answer_becomes_a_read_carrying_the_body_github_actually_sent() {
        let fresh = interpret_read(answered(200, TWO_MAPS), 1_785_888_000).expect("reads");

        // Verbatim, because the cache stores this and #33 derives from it.
        assert_eq!(fresh.body(), TWO_MAPS);
        assert_eq!(fresh.fetched_at(), 1_785_888_000);
        assert_eq!(fresh.read().maps.len(), 2);
    }

    #[test]
    fn a_query_refused_with_an_error_array_is_not_a_successful_read() {
        // The branch that matters most: GraphQL says 200 here, so a status check
        // alone would let this write the cache.
        let refused = r#"{ "data": null, "errors": [ { "message": "Bad credentials" } ] }"#;

        let failure = interpret_read(answered(200, refused), 0).expect_err("refuses");

        assert!(matches!(failure, ReadFailure::Unreadable(_)), "{failure:?}");
        assert!(failure.to_string().contains("Bad credentials"));
    }

    #[test]
    fn a_status_that_is_not_success_is_reported_with_the_code_that_tells_them_apart() {
        let failure = interpret_read(answered(401, "{\"message\":\"Bad credentials\"}"), 0)
            .expect_err("refuses");

        match failure {
            ReadFailure::Status { code, detail } => {
                assert_eq!(code, 401);
                assert!(detail.contains("Bad credentials"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_non_answer_that_said_nothing_is_reported_as_the_code_and_nothing_more() {
        let failure = interpret_read(answered(502, "   \n  "), 0).expect_err("refuses");

        match failure {
            ReadFailure::Status { code, detail } => {
                assert_eq!(code, 502);
                assert!(detail.contains("502"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_page_of_html_from_a_proxy_is_quoted_at_a_length_a_sentence_can_hold() {
        let page = format!("<html>{}</html>", "x".repeat(4000));

        let failure = interpret_read(answered(503, &page), 0).expect_err("refuses");

        assert!(failure.to_string().len() < 400, "{failure}");
    }

    #[test]
    fn nothing_answering_at_all_is_told_apart_from_something_answering_badly() {
        let failure = interpret_read(
            Err(ReadFailure::NoAnswer("connection closed".to_string())),
            0,
        )
        .expect_err("refuses");

        assert!(matches!(failure, ReadFailure::NoAnswer(_)));
    }

    #[test]
    fn the_budget_a_read_reports_is_measured_from_the_moment_that_read_landed() {
        // The fixture's reset is 2026-08-05T11:02:14Z, and this read landed at
        // midnight the same day — so the horizon is the eleven hours between
        // them, anchored to the answer rather than to whenever anybody asks.
        let fresh = interpret_read(answered(200, TWO_MAPS), 1_785_888_000).expect("reads");

        assert_eq!(
            fresh.budget(),
            Some(Budget {
                remaining: 4_417,
                seconds_to_reset: 39_734,
            })
        );

        // A read that landed on the reset itself, and one that landed after it.
        // The negative is carried honestly rather than clamped here: what a
        // reset in the past *means* is the floor's decision, and a zero invented
        // on the way would be indistinguishable from a reset arriving now.
        let landed = [
            (1_785_927_734, 0),
            (1_785_930_000, -2_266),
            (1_785_888_000, 39_734),
        ];

        for (fetched_at, seconds_to_reset) in landed {
            let fresh = interpret_read(answered(200, TWO_MAPS), fetched_at).expect("reads");
            assert_eq!(
                fresh.budget().expect("a budget").seconds_to_reset,
                seconds_to_reset,
                "{fetched_at}"
            );
        }
    }

    #[test]
    fn an_answer_that_said_nothing_usable_about_the_budget_reports_none_of_one() {
        // Both silences, and they are the same silence to the loop: no
        // constraint. A stamp GitHub sent in a shape this build cannot read must
        // not become a horizon of zero, which the floor would read as *the reset
        // is now* — an answer nobody established.
        let unbudgeted = [
            r#"{ "data": { "repository": { "maps": { "nodes": [] } }, "rateLimit": null } }"#,
            r#"{ "data": { "repository": { "maps": { "nodes": [] } }, "rateLimit": {
                 "cost": 2, "nodeCount": 4, "limit": 5000, "remaining": 4417,
                 "resetAt": "the fifth of August" } } }"#,
        ];

        for body in unbudgeted {
            let fresh = interpret_read(answered(200, body), 1_785_888_000).expect("reads");
            assert_eq!(fresh.budget(), None, "{body}");
        }
    }

    #[test]
    fn the_query_costs_what_the_budget_floor_paces_for() {
        // The pacing is two points a poll and this is the document that spends
        // them. A field added here that repriced the query would under-wait by
        // whatever it added, and the reserve assertions next door would go on
        // passing against a number that had stopped being true.
        let read = perseverance_model::read_response(TWO_MAPS).expect("reads");

        assert_eq!(
            read.rate_limit.expect("the budget rode along").cost,
            crate::QUERY_COST
        );
    }

    #[test]
    fn the_shipped_document_asks_for_the_four_things_the_slice_is_named_after() {
        // A typo in the document is invisible to every test that does not read
        // the document, and the live test below is `#[ignore]`d on every runner.
        assert!(MAP_READ_QUERY.contains("labels: [\"wayfinder:map\"]"));
        assert!(MAP_READ_QUERY.contains("states: [OPEN, CLOSED]"));
        assert!(MAP_READ_QUERY.contains("assignees(first: 5)"));
        assert!(MAP_READ_QUERY.contains("issueDependenciesSummary"));
        assert!(MAP_READ_QUERY.contains("rateLimit"));
        assert_eq!(MAP_READ_QUERY.matches("query MapRead").count(), 1);
    }

    #[test]
    fn a_read_with_no_map_open_still_sends_every_variable_the_document_declares() {
        let body = request_body("javrasya", "perseverance", None);
        let sent: serde_json::Value = serde_json::from_str(&body).expect("is JSON");

        assert_eq!(sent["variables"]["open"], false);
        assert_eq!(sent["variables"]["number"], 0);
        assert_eq!(sent["variables"]["owner"], "javrasya");
        assert_eq!(sent["query"], MAP_READ_QUERY);
    }

    #[test]
    fn a_read_of_an_open_map_names_it_and_asks_for_its_graph() {
        let body = request_body("javrasya", "perseverance", Some(28));
        let sent: serde_json::Value = serde_json::from_str(&body).expect("is JSON");

        assert_eq!(sent["variables"]["open"], true);
        assert_eq!(sent["variables"]["number"], 28);
    }

    /// The token reaches exactly one place — a header — and this is the check
    /// that it reaches no other. A request body containing the token would put
    /// it in whatever logs a request body.
    #[test]
    fn the_token_is_nowhere_in_anything_this_module_composes() {
        const NOT_A_TOKEN: &str = "ghp_notarealtoken";

        let body = request_body("javrasya", "perseverance", Some(28));

        assert!(!body.contains(NOT_A_TOKEN));
        assert!(!body.to_lowercase().contains("authorization"));
        assert!(!body.to_lowercase().contains("bearer"));
    }

    /// Unrun here and unrunnable on either runner: no CI image has signed in.
    /// It is the one place the shipped document meets a real schema — a field
    /// GitHub renamed, a bad argument name, or a query that costs more than it
    /// should are all invisible to everything above.
    ///
    /// It asserts shape and never content: whatever maps this repository has are
    /// the operator's, and the test may not care how many there are.
    #[test]
    #[ignore = "asks GitHub for a real answer with this machine's own token; no CI runner has signed in"]
    fn a_signed_in_machine_gets_an_answer_to_the_document_this_crate_actually_ships() {
        let harvested = perseverance_env::harvest()
            .outcome
            .expect("this machine's own shell harvests");
        let token = match crate::acquire_token(&harvested.environment) {
            crate::TokenOutcome::Acquired(token) => token,
            other => panic!("{other:?}"),
        };

        let fresh = read_maps(&token, "javrasya", "perseverance", None).expect("reads");

        let budget = fresh
            .read()
            .rate_limit
            .as_ref()
            .expect("the budget rides the same query");
        assert!(budget.remaining > 0);
        // Against the constant the pacing is built on, so a legitimate reprice
        // moves this and the fixture test together rather than leaving a bare
        // literal here that nothing points at. One-sided, and that is not
        // slack: this call opens no map, `map-read.graphql` guards the whole
        // issue subtree behind `@include(if: $open)`, and a strictly smaller
        // query may honestly cost less than the fixture it was captured from.
        // What the pacing needs to know is that it has not grown.
        assert!(
            budget.cost <= crate::QUERY_COST,
            "the one query shape costs {} rather than the {} the pacing is built on",
            budget.cost,
            crate::QUERY_COST
        );
        // The one place GitHub's own `resetAt` meets the conversion the pacing
        // is built on. Every test above drives it from a stamp this repository
        // wrote down; only this one has been sent a real one.
        assert!(
            fresh.budget().is_some(),
            "GitHub's own resetAt did not read back as a second: {:?}",
            budget.reset_at
        );
        assert!(
            !fresh.read().truncation.any(),
            "a page that cannot exist fired: {:?}",
            fresh.read().truncation
        );
    }
}
