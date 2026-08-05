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

use perseverance_model::{read_response, MapRead, ReadError};

use crate::Token;

/// The one document. Held as a file rather than a string literal so that it can
/// be pasted into `gh api graphql -F query=@…` unchanged when someone needs to
/// ask GitHub the same question by hand.
pub const MAP_READ_QUERY: &str = include_str!("map-read.graphql");

/// The only endpoint this app ever reaches.
pub const GRAPHQL_ENDPOINT: &str = "https://api.github.com/graphql";

/// Sent because GitHub asks for one, and named for the app rather than for a
/// library so that a rate-limit conversation with GitHub can identify us.
const USER_AGENT: &str = concat!("perseverance/", env!("CARGO_PKG_VERSION"));

/// Long enough for a slow answer, short enough that a poll cannot outlive the
/// cadence that scheduled it. Measured whole-query latency is ~0.4 s.
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
        assert!(
            budget.cost <= 2,
            "the one query shape costs {}",
            budget.cost
        );
        assert!(
            !fresh.read().truncation.any(),
            "a page that cannot exist fired: {:?}",
            fresh.read().truncation
        );
    }
}
