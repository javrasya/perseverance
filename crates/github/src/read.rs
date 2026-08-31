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

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use perseverance_model::{
    epoch_from_rfc3339, read_response, rfc3339, Degraded, MapRead, ReadError,
};

use crate::{Budget, Token};

/// The one document. Held as a file rather than a string literal so that it can
/// be pasted into `gh api graphql -F query=@…` unchanged when someone needs to
/// ask GitHub the same question by hand.
pub const MAP_READ_QUERY: &str = include_str!("map-read.graphql");

/// An identity for the document above, taken from its own bytes.
///
/// The identity is the document, not a number beside it. A hand-maintained
/// version constant is a constant somebody edits `map-read.graphql` without
/// touching — and the whole point of stamping a cached body is that a body
/// recorded under a *narrower* document must not be believed. Every field of
/// the read model is `#[serde(default)]`-tolerant, so a narrower body parses
/// cleanly and simply answers with less: #61 widened both `labels` pages from
/// ten to a hundred and added `pageInfo`, and a body cached before it reads as
/// a child with no eleventh label and a `labelsTruncated` that is falsely
/// clean. Nothing has to be remembered here; the document cannot change without
/// this changing.
///
/// **What is hashed is the question, not the file.** The only thing the stamp
/// is ever asked is *could this body be narrower than what I would get now*,
/// and a comment cannot move that answer — GitHub never sees one. So a
/// `#`-comment is dropped and a run of whitespace collapses to one space before
/// a byte reaches the hash. Twenty-three of `map-read.graphql`'s sixty-two
/// lines are prose, and in this repo prose gets edited more often than fields
/// do; charging every operator a *first open* baseline plus a `labelsTruncated`
/// caveat for a reworded rationale would be spending the cold start on nothing.
///
/// Inside a string literal both rules are off, because there whitespace and `#`
/// are data rather than layout. `labels: ["wayfinder:map"]` is the document's
/// only one, and a narrowing hidden in it has to bite like any other.
///
/// FNV-1a rather than a real digest because nothing adversarial is being
/// resisted — the only question ever asked of it is *is this the document this
/// build sends* — and because a hash crate would be this crate's first new
/// dependency for a sixteen-character string.
const fn fnv1a_step(hash: u64, byte: u8) -> u64 {
    (hash ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3)
}

/// FNV-1a over the significant bytes of a GraphQL document, per the rules
/// above. The normalisation is folded into the walk rather than done to a
/// buffer first, because a `const fn` on the 1.82 floor cannot allocate one.
const fn fnv1a_64_of_document(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut index = 0;
    let mut in_string = false;
    // Whether a separator has been skipped since the last byte that counted,
    // and whether any byte has counted yet — together they turn every run of
    // layout into exactly one space, and leading layout into none.
    let mut separated = false;
    let mut emitted = false;

    while index < bytes.len() {
        let byte = bytes[index];

        if in_string {
            // A backslash takes the byte after it with it, so an escaped quote
            // cannot be read as the end of the string.
            if byte == b'\\' && index + 1 < bytes.len() {
                hash = fnv1a_step(hash, byte);
                hash = fnv1a_step(hash, bytes[index + 1]);
                index += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            hash = fnv1a_step(hash, byte);
            index += 1;
            continue;
        }

        if byte == b'#' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            // A comment sat between two tokens is a separator like the
            // whitespace around it, never a splice joining them.
            separated = true;
            continue;
        }

        if byte == b' ' || byte == b'\t' || byte == b'\n' || byte == b'\r' {
            separated = true;
            index += 1;
            continue;
        }

        if separated && emitted {
            hash = fnv1a_step(hash, b' ');
        }
        separated = false;

        if byte == b'"' {
            in_string = true;
        }
        hash = fnv1a_step(hash, byte);
        emitted = true;
        index += 1;
    }

    hash
}

/// The `u64` half, computed at compile time. Hex formatting is not `const` on
/// the workspace's 1.82 floor — `str::from_utf8` is not a `const fn` there — so
/// the rendering lives in [`map_read_query_id`] and only the arithmetic is
/// const.
const MAP_READ_QUERY_ID: u64 = fnv1a_64_of_document(MAP_READ_QUERY.as_bytes());

/// The rendering, done once. Sixteen hex digits fully determined at compile
/// time have no business being formatted afresh on every cache read.
static MAP_READ_QUERY_ID_HEX: OnceLock<String> = OnceLock::new();

/// What this build stamps a cached body with, as lowercase hex.
///
/// Public and free-standing so the reader side can ask what the current build
/// sends without holding a [`FreshRead`]: a cached row is believed only while
/// its stamp is byte-equal to this.
pub fn map_read_query_id() -> &'static str {
    MAP_READ_QUERY_ID_HEX
        .get_or_init(|| format!("{MAP_READ_QUERY_ID:016x}"))
        .as_str()
}

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
    /// The identity of the document that asked for `body`, set once beside it.
    ///
    /// A field rather than a lookup, and handed in by whoever chose the
    /// document rather than read off a global here: the day this crate ships a
    /// second query, a body produced by it cannot quietly wear the map read's
    /// stamp and pass a comparison it should fail.
    query_id: &'static str,
}

impl FreshRead {
    /// The response as GitHub sent it. This is what the cache stores.
    pub fn body(&self) -> &str {
        &self.body
    }

    /// The identity of the document that asked for this body.
    ///
    /// It rides on the value that already proves a read was live — the same
    /// value, written at the same moment — so the stamp and the body cannot be
    /// written from two different places and disagree. See
    /// [`map_read_query_id`] for why the identity is the document itself.
    pub fn query_id(&self) -> &'static str {
        self.query_id
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
    /// `Retry-After`, in seconds, exactly as the response header said — and the
    /// reason this type exists separately from [`FreshRead`] at all.
    ///
    /// A header is not in the body, so nothing downstream of the parse can ever
    /// recover it; carrying it here is what lets #19 §5's *honour the header
    /// exactly, never guess* be something the code does rather than something
    /// the ticket says. `None` covers both *no header* and *a header in a shape
    /// this build will not guess at* — GitHub sends a count of seconds, and an
    /// HTTP-date read as a small integer would put the reset in 1970.
    pub retry_after: Option<u64>,

    /// `x-ratelimit-remaining`, and the whole reason the field beside it is not
    /// enough.
    ///
    /// GitHub documents the secondary rate limit in **two** forms: a
    /// `Retry-After` when it sends one, and otherwise
    /// `x-ratelimit-remaining: 0` with the moment in `x-ratelimit-reset`. A
    /// build that read only the first classified the second as a permission
    /// failure — which stops the poller for the life of the process and prints
    /// `gh auth login` at an operator whose token is fine, for a condition that
    /// heals itself in minutes. That is the inversion of the whole ticket, so
    /// both forms are read.
    pub rate_limit_remaining: Option<u64>,

    /// `x-ratelimit-reset`: seconds since the epoch, absolute, unlike
    /// `Retry-After`'s count forward from now. Both are resolved to the same
    /// RFC 3339 moment in [`interpret_read`], which is the last thing here
    /// holding a clock reading.
    pub rate_limit_reset: Option<i64>,
}

/// Why a read produced no [`FreshRead`].
///
/// **These stay observations, and [`ReadFailure::degraded`] is the one place
/// they become a condition.** That split is what #38 and #39 were protecting
/// when they called this "deliberately not a taxonomy" — the paragraph that
/// stood here said #40 owned the vocabulary, and #40 has now written it one
/// file's width away rather than inside these variants. What arrived is a fact;
/// whether waiting helps is a judgement; a variant set that fused the two would
/// have to be reshaped every time the judgement moved.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadFailure {
    /// Nothing answered. The detail is the transport's own account of itself.
    #[error("the read did not complete: {0}")]
    NoAnswer(String),

    /// Something answered, and it was not an answer to the query.
    ///
    /// `resets_at` is `Retry-After` already resolved against the moment the
    /// answer landed, because [`interpret_read`] is the last thing in this
    /// crate holding a clock reading — so the taxonomy below never needs one,
    /// and `cadence.rs` never sees a stamp at all.
    #[error("GitHub answered with status {code}: {detail}")]
    Status {
        code: u16,
        detail: String,
        resets_at: Option<String>,
    },

    /// It answered, and what came back could not be read as an answer.
    #[error(transparent)]
    Unreadable(#[from] ReadError),

    /// GitHub answered `200` and refused the *query* on the budget, which is
    /// what a primary rate limit looks like on GraphQL.
    ///
    /// Kept apart from [`ReadFailure::Unreadable`] for one reason: the reset is
    /// on the response headers and `ReadError` is parsed from the body, so this
    /// is the only refusal whose *when* has to be carried across the parse by
    /// hand. Folding it back into `Unreadable` would mean the condition it
    /// produces could never name a moment, and a rate limit with no moment
    /// falls back on the doubling — polling a limit that lasts an hour every
    /// five minutes for the whole of it.
    #[error("GitHub refused the query: {message}")]
    RateLimitedQuery {
        message: String,
        resets_at: Option<String>,
    },

    /// There is no token, so there is nothing to sign a read with. Not a
    /// failure of the read — a fact about this launch, kept apart from the
    /// three above because the fix is `gh auth login` rather than anything to
    /// do with a request.
    #[error("this run acquired no GitHub token, so no read was attempted")]
    NoToken,
}

impl ReadFailure {
    /// The taxonomy, in one exhaustive match.
    ///
    /// One function, because the alternative is the condition being decided
    /// twice — once by the poller working out how long to wait, once by the
    /// view working out what to print — and two decisions from one observation
    /// are two decisions that come to disagree.
    ///
    /// Every row of #19 §5's table is here, and three are worth the ink:
    ///
    /// **`403` splits on the headers rather than on the number.** GitHub spends
    /// one status on *you may not* and on *not so fast*, and only the headers
    /// tell them apart. Both documented forms are read — a `Retry-After`, and
    /// otherwise `x-ratelimit-remaining: 0` with `x-ratelimit-reset` — because
    /// reading only the first left a secondary rate limit that sent no
    /// `Retry-After` classified as a revoked token: the poller stops for the
    /// life of the process, the screen prints `gh auth login`, and the token
    /// was never the problem. [`when_it_resets`] is where the two forms become
    /// one moment. A 403 that named a reset in neither form is authorisation
    /// having failed, which stops rather than retries — the safe direction of
    /// what is left, because a stopped poller says so on screen and prints a
    /// command, while a permission failure read as a rate limit ages a stamp
    /// forever.
    ///
    /// **A refusal is classified by GitHub's `type` and never by its prose.**
    /// `NOT_FOUND`, `RATE_LIMITED`, `FORBIDDEN` are structured fields; the
    /// message beside them is a sentence GitHub is free to reword. A type this
    /// build has no name for is [`Degraded::Unreachable`], which keeps the last
    /// good model and tries again — exactly what #19 §5 asks of schema drift.
    ///
    /// **`NoRepository` is [`Degraded::MapGone`], and it is the one
    /// non-obvious row.** The answer arrived and denied the repository exists;
    /// that is not transient, and the remedy is picking another folder rather
    /// than waiting for a network.
    pub fn degraded(&self) -> Degraded {
        match self {
            // Nothing answered, which is the definition of a thing to retry.
            ReadFailure::NoAnswer(_) => Degraded::Unreachable,

            ReadFailure::Status { code: 401, .. } => Degraded::AuthFailed,
            ReadFailure::Status {
                code: 403,
                resets_at: Some(resets_at),
                ..
            } => Degraded::RateLimited {
                resets_at: Some(resets_at.clone()),
            },
            // A 403 that named no reset in either form. The response said the
            // budget is not why, so the remaining reading of the status is
            // that authorisation failed.
            ReadFailure::Status { code: 403, .. } => Degraded::AuthFailed,
            ReadFailure::Status {
                code: 429,
                resets_at,
                ..
            } => Degraded::RateLimited {
                resets_at: resets_at.clone(),
            },
            ReadFailure::Status { code: 404, .. } => Degraded::MapGone,
            // Every 5xx, every proxy, every gateway. Something stood between
            // this app and GitHub, and it may not be there next time.
            ReadFailure::Status { .. } => Degraded::Unreachable,

            // The moment came off the headers in `interpret_read`, which is
            // the only place that still had them. `None` here is an answer
            // that named no reset at all, not an answer nobody looked at.
            ReadFailure::RateLimitedQuery { resets_at, .. } => Degraded::RateLimited {
                resets_at: resets_at.clone(),
            },

            ReadFailure::Unreadable(ReadError::Answered { kind, .. }) => match kind.as_str() {
                "NOT_FOUND" => Degraded::MapGone,
                // `interpret_read` lifts this one out into
                // `RateLimitedQuery` so it can carry the reset off the
                // headers, so nothing in this build reaches here — the row
                // stays because the condition is a property of the `type` and
                // not of the route it travelled, and a refusal arriving by some
                // other path must not read as schema drift.
                RATE_LIMITED => Degraded::RateLimited { resets_at: None },
                "FORBIDDEN" | "UNAUTHORIZED" => Degraded::AuthFailed,
                _ => Degraded::Unreachable,
            },
            ReadFailure::Unreadable(ReadError::NotJson(_)) => Degraded::Unreachable,
            ReadFailure::Unreadable(ReadError::NoRepository) => Degraded::MapGone,

            // The fix is `gh auth login`, which is what that variant's own doc
            // says and what the remedy on screen prints.
            ReadFailure::NoToken => Degraded::AuthFailed,
        }
    }
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

    // The stamp is handed over here because here is where the document was
    // chosen: `request_body` above is the one call that decides which query
    // this exchange is an answer to.
    interpret_read(sent, epoch_seconds(), map_read_query_id())
}

/// The document one ticket's own question is asked with — see the file for why
/// it is a second document rather than a field on the first.
pub const TICKET_READ_QUERY: &str = include_str!("ticket-read.graphql");

/// One ticket's body: the question the `work-ticket` prompt carries verbatim.
///
/// Not part of a tick and not cached anywhere. It is asked once, on the press
/// that is about to spawn, after the awaited revalidation has already said the
/// frontier is where the press thought it was.
///
/// No [`FreshRead`], because there is nothing here to stamp: this answers no
/// map, writes no cache row and feeds no ledger. What it shares with the read
/// next door is the socket, the status classification and the taxonomy — a
/// refusal here is a [`ReadFailure`] like any other, so `degraded()` is still
/// the one place an observation becomes a condition.
pub fn read_ticket_body(
    token: &Token,
    owner: &str,
    repo: &str,
    number: u64,
) -> Result<String, ReadFailure> {
    let variables = serde_json::json!({ "owner": owner, "repo": repo, "number": number });
    let body = serde_json::json!({ "query": TICKET_READ_QUERY, "variables": variables });
    let answer = send(token, &body.to_string())?;
    let fetched_at = epoch_seconds();

    if !(200..300).contains(&answer.status) {
        return Err(ReadFailure::Status {
            code: answer.status,
            detail: first_line_of(&answer.body, answer.status),
            resets_at: when_it_resets(&answer, fetched_at),
        });
    }

    interpret_ticket(&answer.body)
}

/// What the ticket document's answer says. Pure, so every branch is reachable
/// with no token and no network.
fn interpret_ticket(body: &str) -> Result<String, ReadFailure> {
    let answered: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| ReadFailure::Unreadable(ReadError::NotJson(error.to_string())))?;

    // A refused query is a 200 with an `errors` array, exactly as it is for the
    // map read — and it is classified by GitHub's own `type` rather than by the
    // sentence beside it.
    if let Some(first) = answered
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|errors| errors.first())
    {
        let text = |name: &str| {
            first
                .get(name)
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string()
        };
        return Err(ReadFailure::Unreadable(ReadError::Answered {
            kind: text("type"),
            message: text("message"),
        }));
    }

    match answered.pointer("/data/repository/issue/body") {
        Some(serde_json::Value::String(question)) => Ok(question.clone()),
        // A repository or an issue that came back null. Either way this is not
        // an answer about that ticket, and a spawn on an empty question would
        // hand a session a brief with nothing in it.
        _ => Err(ReadFailure::Unreadable(ReadError::NoRepository)),
    }
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

/// GitHub's own `type` for a query it refused on the budget. Matched as the
/// structured field it is, never by grepping the message beside it.
const RATE_LIMITED: &str = "RATE_LIMITED";

/// When GitHub said it would take this token back, as one moment.
///
/// Two headers, one answer, and the order is the rule. `Retry-After` is
/// honoured exactly wherever it is present — #19 §5's *never guess* — and it is
/// a count forward from the moment the answer landed. Otherwise the documented
/// second form: `x-ratelimit-remaining: 0` with the reset in
/// `x-ratelimit-reset`, which is already absolute.
///
/// **The `remaining == 0` guard is what keeps this from swallowing the other
/// 403.** Every GitHub answer carries `x-ratelimit-reset`, including a plain
/// permission failure with thousands of points left; reading it unconditionally
/// would turn *you may not* into *not so fast* and leave a revoked token
/// retrying quietly forever, which is the failure the taxonomy exists to
/// prevent. A zero remaining is the response saying the budget is why.
fn when_it_resets(answer: &Answer, fetched_at: i64) -> Option<String> {
    if let Some(seconds) = answer.retry_after {
        return Some(rfc3339(fetched_at.saturating_add(seconds as i64)));
    }

    match (answer.rate_limit_remaining, answer.rate_limit_reset) {
        (Some(0), Some(at)) => Some(rfc3339(at)),
        _ => None,
    }
}

/// What a finished exchange means. Pure, and the reason every branch below is
/// reachable on a runner that has never signed in to anything.
///
/// `query_id` is the identity of the document the request was built from, and
/// it is a parameter rather than a constant read here so that the stamp on a
/// [`FreshRead`] is always the document that actually produced it.
pub fn interpret_read(
    sent: Result<Answer, ReadFailure>,
    fetched_at: i64,
    query_id: &'static str,
) -> Result<FreshRead, ReadFailure> {
    let answer = sent?;

    // Resolved here and nowhere later. This function is handed the moment the
    // answer landed, which is the only moment a count of seconds is measured
    // from; a clock read further downstream would be measuring from whenever
    // somebody got round to asking.
    let resets_at = when_it_resets(&answer, fetched_at);

    // GraphQL answers a refused *query* with 200 and an `errors` array, so a
    // status check alone would let a refusal through as a success — and a
    // success is the thing that writes the cache.
    if !(200..300).contains(&answer.status) {
        return Err(ReadFailure::Status {
            code: answer.status,
            detail: first_line_of(&answer.body, answer.status),
            resets_at,
        });
    }

    let read = match read_response(&answer.body) {
        Ok(read) => read,
        // The one refusal whose *when* is not in the thing that carries it. A
        // primary rate limit on GraphQL is a 200 with `type: RATE_LIMITED` in
        // the body, and the reset rides the headers — which `ReadError` is
        // parsed without ever seeing. So it is lifted out here, where both
        // halves are still in hand, rather than reaching `degraded()` as a
        // refusal that has to answer *no idea when* to a question the response
        // did answer.
        Err(ReadError::Answered { kind, message }) if kind == RATE_LIMITED => {
            return Err(ReadFailure::RateLimitedQuery { message, resets_at });
        }
        Err(unreadable) => return Err(ReadFailure::Unreadable(unreadable)),
    };

    Ok(FreshRead {
        body: answer.body,
        read,
        fetched_at,
        query_id,
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
    // All three taken before the body, because reading the body consumes the
    // response and a header nobody copied is a header that never existed.
    // Whole numbers only: `Retry-After` also has an HTTP-date form this
    // deliberately declines to parse, and it reads as *nothing said when*
    // rather than as a wrong number.
    let number = |name: &str| {
        answered
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|said| said.trim().parse::<i64>().ok())
    };
    let retry_after = number("retry-after").and_then(|seconds| u64::try_from(seconds).ok());
    let rate_limit_remaining =
        number("x-ratelimit-remaining").and_then(|left| u64::try_from(left).ok());
    let rate_limit_reset = number("x-ratelimit-reset");

    match answered.body_mut().read_to_string() {
        Ok(body) => Ok(Answer {
            status,
            body,
            retry_after,
            rate_limit_remaining,
            rate_limit_reset,
        }),
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

    /// An answer that carried no rate-limit headers at all.
    fn answered(status: u16, body: &str) -> Result<Answer, ReadFailure> {
        Ok(Answer {
            status,
            body: body.to_string(),
            retry_after: None,
            rate_limit_remaining: None,
            rate_limit_reset: None,
        })
    }

    /// The same, with GitHub having said when to come back in the first of the
    /// two documented forms: a count of seconds in `Retry-After`.
    fn answered_after(status: u16, body: &str, retry_after: u64) -> Result<Answer, ReadFailure> {
        Ok(Answer {
            status,
            body: body.to_string(),
            retry_after: Some(retry_after),
            rate_limit_remaining: None,
            rate_limit_reset: None,
        })
    }

    /// And in the second: no `Retry-After`, a budget reported spent, and the
    /// moment it refills as an absolute epoch second. This is the commoner
    /// shape of a secondary rate limit and the one this build used to read as
    /// a revoked token.
    fn answered_drained(
        status: u16,
        body: &str,
        remaining: u64,
        reset: i64,
    ) -> Result<Answer, ReadFailure> {
        Ok(Answer {
            status,
            body: body.to_string(),
            retry_after: None,
            rate_limit_remaining: Some(remaining),
            rate_limit_reset: Some(reset),
        })
    }

    /// The ticket document's three answers, from text in this file: the body, a
    /// refused query, and an answer about no issue at all.
    #[test]
    fn a_ticket_read_is_the_body_when_there_is_one_and_a_refusal_when_there_is_not() {
        assert_eq!(
            interpret_ticket(r#"{"data":{"repository":{"issue":{"body":"What next?"}}}}"#),
            Ok("What next?".to_string())
        );

        assert_eq!(
            interpret_ticket(r#"{"errors":[{"type":"NOT_FOUND","message":"no such issue"}]}"#),
            Err(ReadFailure::Unreadable(ReadError::Answered {
                kind: "NOT_FOUND".to_string(),
                message: "no such issue".to_string(),
            }))
        );

        // An answer about a repository this token cannot see, which is not an
        // answer about that ticket — and must never render as a prompt with an
        // empty question in it.
        assert_eq!(
            interpret_ticket(r#"{"data":{"repository":null}}"#),
            Err(ReadFailure::Unreadable(ReadError::NoRepository))
        );
    }

    #[test]
    fn a_successful_answer_becomes_a_read_carrying_the_body_github_actually_sent() {
        let fresh = interpret_read(answered(200, TWO_MAPS), 1_785_888_000, map_read_query_id())
            .expect("reads");

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

        let failure =
            interpret_read(answered(200, refused), 0, map_read_query_id()).expect_err("refuses");

        assert!(matches!(failure, ReadFailure::Unreadable(_)), "{failure:?}");
        assert!(failure.to_string().contains("Bad credentials"));
    }

    #[test]
    fn a_status_that_is_not_success_is_reported_with_the_code_that_tells_them_apart() {
        let failure = interpret_read(
            answered(401, "{\"message\":\"Bad credentials\"}"),
            0,
            map_read_query_id(),
        )
        .expect_err("refuses");

        match failure {
            ReadFailure::Status { code, detail, .. } => {
                assert_eq!(code, 401);
                assert!(detail.contains("Bad credentials"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_non_answer_that_said_nothing_is_reported_as_the_code_and_nothing_more() {
        let failure =
            interpret_read(answered(502, "   \n  "), 0, map_read_query_id()).expect_err("refuses");

        match failure {
            ReadFailure::Status { code, detail, .. } => {
                assert_eq!(code, 502);
                assert!(detail.contains("502"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_moment_github_said_to_come_back_is_resolved_against_the_moment_it_answered() {
        // A count of seconds is not a time until somebody subtracts it from
        // one, and this function is the last thing in the crate holding the
        // moment the answer landed. Sixty seconds after midnight on the fifth.
        let failure = interpret_read(
            answered_after(403, "{\"message\":\"API rate limit exceeded\"}", 60),
            1_785_888_000,
            map_read_query_id(),
        )
        .expect_err("refuses");

        match &failure {
            ReadFailure::Status {
                code, resets_at, ..
            } => {
                assert_eq!(*code, 403);
                assert_eq!(resets_at.as_deref(), Some("2026-08-05T00:01:00Z"));
            }
            other => panic!("{other:?}"),
        }

        // And the header is what the condition carries, unrounded and never
        // guessed at.
        assert_eq!(
            failure.degraded(),
            Degraded::RateLimited {
                resets_at: Some("2026-08-05T00:01:00Z".to_string())
            }
        );

        // A header this build will not read is *nothing said when* rather than
        // *the reset is now*, which is a horizon nobody established.
        let unsaid = interpret_read(
            answered(429, "{\"message\":\"slow down\"}"),
            0,
            map_read_query_id(),
        )
        .expect_err("refuses");
        assert_eq!(unsaid.degraded(), Degraded::RateLimited { resets_at: None });
    }

    /// **The other documented form of *not so fast*, which used to read as a
    /// revoked token.**
    ///
    /// GitHub sends `Retry-After` on some secondary rate limits and, on the
    /// rest, `x-ratelimit-remaining: 0` beside `x-ratelimit-reset`. A build
    /// that read only the first classified the second as `AuthFailed` — the
    /// poller answers `Floor::Never`, stops for the life of the process, and
    /// the screen tells an operator with a perfectly good token to run
    /// `gh auth login`. The only way back was refocusing the window, which
    /// fires an immediate poke, re-trips the same limit and stops again. This
    /// is the inversion of the whole ticket: a condition that heals itself,
    /// presented as permanent, with a remedy that cannot help.
    #[test]
    fn a_403_that_reports_a_spent_budget_is_a_pause_and_not_a_refused_token() {
        // Midnight on the fifth, refilling an hour later. Absolute, unlike
        // `Retry-After`'s count forward from now.
        let refills_at = 1_785_888_000 + 3_600;
        let limited = interpret_read(
            answered_drained(
                403,
                "{\"message\":\"You have exceeded a secondary rate limit\"}",
                0,
                refills_at,
            ),
            1_785_888_000,
            map_read_query_id(),
        )
        .expect_err("refuses");

        assert_eq!(
            limited.degraded(),
            Degraded::RateLimited {
                resets_at: Some("2026-08-05T01:00:00Z".to_string())
            }
        );

        // And the guard that keeps this from swallowing the other 403. Every
        // answer carries `x-ratelimit-reset`, including a plain permission
        // failure with most of the budget untouched; reading it there would
        // leave a revoked token retrying quietly forever.
        let forbidden = interpret_read(
            answered_drained(
                403,
                "{\"message\":\"Resource not accessible\"}",
                4_872,
                refills_at,
            ),
            1_785_888_000,
            map_read_query_id(),
        )
        .expect_err("refuses");

        assert_eq!(forbidden.degraded(), Degraded::AuthFailed);
    }

    /// A primary rate limit on GraphQL: `200`, an `errors` array, and the reset
    /// on the headers of the very same response.
    ///
    /// The reset has to be lifted across the body parse by hand, because
    /// `ReadError` is parsed from the body and never sees a header. Without
    /// that the condition can only ever say *no idea when*, and a rate limit
    /// with no moment falls back on the doubling — a poll every five minutes
    /// against a limit that lasts an hour, for the whole hour.
    #[test]
    fn a_query_refused_on_the_budget_carries_the_reset_the_same_response_named() {
        let refused = r#"{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}"#;

        let failure = interpret_read(
            answered_drained(200, refused, 0, 1_785_888_000 + 3_600),
            1_785_888_000,
            map_read_query_id(),
        )
        .expect_err("refuses");

        assert_eq!(
            failure.degraded(),
            Degraded::RateLimited {
                resets_at: Some("2026-08-05T01:00:00Z".to_string())
            }
        );
        // Still GitHub's own sentence, and still not the status line: nothing
        // about this answer was a bad status.
        assert!(
            failure.to_string().contains("API rate limit exceeded"),
            "{failure}"
        );
    }

    #[test]
    fn a_page_of_html_from_a_proxy_is_quoted_at_a_length_a_sentence_can_hold() {
        let page = format!("<html>{}</html>", "x".repeat(4000));

        let failure =
            interpret_read(answered(503, &page), 0, map_read_query_id()).expect_err("refuses");

        assert!(failure.to_string().len() < 400, "{failure}");
    }

    /// A status, without repeating the number in three places.
    fn status(code: u16, resets_at: Option<&str>) -> ReadFailure {
        ReadFailure::Status {
            code,
            detail: "whatever the body said".to_string(),
            resets_at: resets_at.map(str::to_string),
        }
    }

    /// A refused query, classified by the `type` GitHub sent and never by the
    /// sentence beside it.
    fn refused(kind: &str) -> ReadFailure {
        ReadFailure::Unreadable(ReadError::Answered {
            kind: kind.to_string(),
            message: "whatever GitHub happened to say".to_string(),
        })
    }

    #[test]
    fn each_way_a_read_can_fail_lands_on_the_condition_that_decides_whether_to_retry() {
        /*
         * The whole taxonomy in one table, because four tests over four
         * conditions are four chances to classify three of them. #19 §5's own
         * table, plus the rows it leaves to judgement, each with the judgement
         * written beside it.
         */
        const AT: &str = "2026-08-05T00:01:00Z";
        let at = || Some(AT.to_string());

        let table = [
            (
                ReadFailure::NoAnswer("connection closed".to_string()),
                Degraded::Unreachable,
            ),
            (status(401, None), Degraded::AuthFailed),
            // 403 with a reset is *not so fast*; 403 without one is *you may
            // not*. The header is the only thing that tells them apart.
            (
                status(403, Some(AT)),
                Degraded::RateLimited { resets_at: at() },
            ),
            (status(403, None), Degraded::AuthFailed),
            (
                status(429, Some(AT)),
                Degraded::RateLimited { resets_at: at() },
            ),
            (status(429, None), Degraded::RateLimited { resets_at: None }),
            (status(404, None), Degraded::MapGone),
            // Every other status: a gateway between here and GitHub having a
            // bad afternoon, and it may not be there next time.
            (status(500, None), Degraded::Unreachable),
            (status(502, None), Degraded::Unreachable),
            (status(503, None), Degraded::Unreachable),
            (refused("NOT_FOUND"), Degraded::MapGone),
            // Reached by no route this build takes — `interpret_read` lifts
            // it into `RateLimitedQuery` so it can carry a reset — and still
            // classified by its type rather than by how it arrived.
            (
                refused("RATE_LIMITED"),
                Degraded::RateLimited { resets_at: None },
            ),
            (refused("FORBIDDEN"), Degraded::AuthFailed),
            (refused("UNAUTHORIZED"), Degraded::AuthFailed),
            // Schema drift keeps the last good model and tries again, per
            // #19 §5 — including the refusal that named no type at all.
            (refused("SOMETHING_NEW_IN_APRIL"), Degraded::Unreachable),
            (refused(""), Degraded::Unreachable),
            (
                ReadFailure::Unreadable(ReadError::NotJson("expected value".to_string())),
                Degraded::Unreachable,
            ),
            // The one non-obvious row. The answer arrived and denied the
            // repository exists; that is not transient, and the remedy is
            // picking another folder rather than waiting for a network.
            (
                ReadFailure::Unreadable(ReadError::NoRepository),
                Degraded::MapGone,
            ),
            // The GraphQL form of a rate limit, whose reset came off the
            // headers rather than out of the body.
            (
                ReadFailure::RateLimitedQuery {
                    message: "API rate limit exceeded".to_string(),
                    resets_at: at(),
                },
                Degraded::RateLimited { resets_at: at() },
            ),
            (
                ReadFailure::RateLimitedQuery {
                    message: "API rate limit exceeded".to_string(),
                    resets_at: None,
                },
                Degraded::RateLimited { resets_at: None },
            ),
            // Not a failure of a read at all, and the remedy is one command.
            (ReadFailure::NoToken, Degraded::AuthFailed),
        ];

        for (failure, expected) in table {
            assert_eq!(failure.degraded(), expected, "{failure:?}");
        }
    }

    #[test]
    fn a_refusal_is_told_apart_by_the_type_github_sent_and_never_by_its_wording() {
        // Two refusals whose prose points the opposite way from their type.
        // Anything grepping the sentence gets both of these backwards, which is
        // the whole reason `kind` is carried.
        let misleading = ReadFailure::Unreadable(ReadError::Answered {
            kind: "NOT_FOUND".to_string(),
            message: "API rate limit exceeded for user ID 1".to_string(),
        });
        assert_eq!(misleading.degraded(), Degraded::MapGone);

        let other_way = ReadFailure::Unreadable(ReadError::Answered {
            kind: "RATE_LIMITED".to_string(),
            message: "Could not resolve to a Repository".to_string(),
        });
        assert_eq!(
            other_way.degraded(),
            Degraded::RateLimited { resets_at: None }
        );
    }

    #[test]
    fn the_conditions_that_stop_the_poller_are_the_two_that_retrying_cannot_fix() {
        // The partition, stated as the property rather than as a list of names:
        // this is why the taxonomy exists at all.
        let stops = |failure: &ReadFailure| {
            matches!(failure.degraded(), Degraded::AuthFailed | Degraded::MapGone)
        };

        assert!(stops(&ReadFailure::NoToken));
        assert!(stops(&status(401, None)));
        assert!(stops(&status(404, None)));
        assert!(stops(&ReadFailure::Unreadable(ReadError::NoRepository)));

        assert!(!stops(&ReadFailure::NoAnswer("closed".to_string())));
        assert!(!stops(&status(503, None)));
        assert!(!stops(&status(429, None)));
        assert!(!stops(&refused("SOMETHING_NEW_IN_APRIL")));
    }

    #[test]
    fn nothing_answering_at_all_is_told_apart_from_something_answering_badly() {
        let failure = interpret_read(
            Err(ReadFailure::NoAnswer("connection closed".to_string())),
            0,
            map_read_query_id(),
        )
        .expect_err("refuses");

        assert!(matches!(failure, ReadFailure::NoAnswer(_)));
    }

    #[test]
    fn the_budget_a_read_reports_is_measured_from_the_moment_that_read_landed() {
        // The fixture's reset is 2026-08-05T11:02:14Z, and this read landed at
        // midnight the same day — so the horizon is the eleven hours between
        // them, anchored to the answer rather than to whenever anybody asks.
        let fresh = interpret_read(answered(200, TWO_MAPS), 1_785_888_000, map_read_query_id())
            .expect("reads");

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
            let fresh = interpret_read(answered(200, TWO_MAPS), fetched_at, map_read_query_id())
                .expect("reads");
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
            let fresh = interpret_read(answered(200, body), 1_785_888_000, map_read_query_id())
                .expect("reads");
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
        assert_eq!(MAP_READ_QUERY.matches("labels(first: 100)").count(), 2);
        assert!(MAP_READ_QUERY.contains("issueDependenciesSummary"));
        assert!(MAP_READ_QUERY.contains("rateLimit"));
        assert_eq!(MAP_READ_QUERY.matches("query MapRead").count(), 1);
    }

    #[test]
    fn the_hash_the_stamp_is_built_from_is_the_published_fnv_1a_64() {
        // Vectors from the FNV reference (Landon Curt Noll). A hash that stopped
        // being a function of the document — reduced to a constant, or seeded
        // wrongly — would still let every stamp comparison in the app pass, so
        // the arithmetic is pinned here against numbers this repo did not
        // choose. None of the three carries a comment or a space, so the
        // normalisation is the identity on them and what is left is the
        // arithmetic.
        assert_eq!(fnv1a_64_of_document(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64_of_document(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a_64_of_document(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn prose_and_layout_are_not_part_of_what_the_document_asks_for() {
        // The stamp answers *could this body be narrower than what I would get
        // now*, and GitHub is never shown a comment. Twenty-three of this
        // file's sixty-two lines are prose; a reworded paragraph that cost
        // every operator a cold start would be spending it on nothing.
        let without_prose: String = MAP_READ_QUERY
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        assert_ne!(
            without_prose, MAP_READ_QUERY,
            "the document has prose in it"
        );
        assert_eq!(
            fnv1a_64_of_document(without_prose.as_bytes()),
            MAP_READ_QUERY_ID
        );

        // Nor is the layout: the same tokens re-wrapped and re-indented are the
        // same question.
        let reflowed = without_prose
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("\n      ");
        assert_ne!(reflowed, without_prose, "the reflow has to bite");
        assert_eq!(fnv1a_64_of_document(reflowed.as_bytes()), MAP_READ_QUERY_ID);
    }

    #[test]
    fn inside_a_string_literal_a_space_and_a_hash_are_data() {
        // `labels: ["wayfinder:map"]` is the document's only string, and it is
        // a filter: a body read under a different one is a different answer.
        // So neither rule reaches inside the quotes.
        assert_ne!(
            fnv1a_64_of_document(b"labels: [\"wayfinder:map\"]"),
            fnv1a_64_of_document(b"labels: [\"wayfinder: map\"]")
        );
        // A `#` in a string starts no comment — if it did, both of these would
        // hash the same prefix and stop.
        assert_ne!(
            fnv1a_64_of_document(b"labels: [\"a#one\"]"),
            fnv1a_64_of_document(b"labels: [\"a#two\"]")
        );
    }

    #[test]
    fn two_different_documents_cannot_share_an_identity() {
        // The claim the whole slice rests on: editing the bytes changes the
        // stamp. A one-character difference, and the narrowing that actually
        // happened in #61 — ten labels widened to a hundred.
        assert_ne!(
            fnv1a_64_of_document(b"query MapRead"),
            fnv1a_64_of_document(b"query MapReab")
        );
        assert_ne!(
            fnv1a_64_of_document(b"labels(first: 10)"),
            fnv1a_64_of_document(b"labels(first: 100)")
        );

        let narrower = MAP_READ_QUERY.replace("labels(first: 100)", "labels(first: 10)");
        assert_ne!(narrower, MAP_READ_QUERY, "the substitution has to bite");
        assert_ne!(
            fnv1a_64_of_document(narrower.as_bytes()),
            fnv1a_64_of_document(MAP_READ_QUERY.as_bytes())
        );
    }

    #[test]
    fn the_stamp_this_build_sends_is_the_hex_of_the_shipped_documents_own_bytes() {
        // Sixteen lowercase hex digits, and nothing between the document and
        // them: no hand-maintained version constant to forget to bump.
        let stamp = map_read_query_id();

        assert_eq!(
            stamp,
            format!("{:016x}", fnv1a_64_of_document(MAP_READ_QUERY.as_bytes()))
        );
        assert_eq!(stamp.len(), 16);
        assert!(stamp
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
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
