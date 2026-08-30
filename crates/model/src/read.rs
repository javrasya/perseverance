//! What one recorded GraphQL response says — and nothing derived from it.
//!
//! The derivation is #33's. This module is the *parse*: which maps the label
//! found, which map the response carried the graph of, and the budget that rode
//! along. It lives in the model crate because "recorded GraphQL responses" is
//! what this crate's own charter says sits below it, and because a parser that
//! can be driven by a checked-in JSON file is a parser that can be tested with
//! no network anywhere near it.
//!
//! The children of the open map are parsed here and classified nowhere here.
//! What comes out of this file is what the response *said* about each child —
//! its labels as strings, GitHub's own count of open blockers, how many people
//! hold it — and every judgement made from those facts lives in [`crate::derive`].
//! The split is what keeps *what arrived* separable from *what we concluded*,
//! and it is why the whole of the derivation can be driven by a checked-in
//! response with no network anywhere near it.

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
    pub map: Option<MapGraph>,
    /// Carried, never acted on *here*. The poller's budget floor is what spends
    /// these numbers, and it needs a clock to do it; this crate has none, so
    /// what this file owes is only that they arrive intact.
    pub rate_limit: Option<RateLimit>,
    pub truncation: Truncation,
}

/// The open map, and the children the same answer carried under it.
///
/// Nothing here is derived: no state, no classification, no counts. What this
/// carries is the answer, and [`crate::derive`] is where an answer becomes a
/// model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapGraph {
    pub number: u64,
    pub title: String,
    /// GitHub's own state for the map itself, which is the top rung of the
    /// phase ladder and the one rung no ticket can put the map on.
    pub closed: bool,
    /// **Sub-issue order**, exactly as GitHub answered — which is the order the
    /// operator dragged them into in GitHub's own UI. Never re-sorted here, and
    /// never re-sorted anywhere: a ranking invented by this app is a ranking the
    /// graph on screen cannot justify.
    pub children: Vec<ChildRead>,
}

/// One child of the open map, as the answer described it.
///
/// The labels cross as strings rather than as a classification, because which
/// strings mean what is a decision and decisions live one file over. Everything
/// else here is a count GitHub itself computed, which is the reason none of it
/// has to be recomputed from the node lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildRead {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// GitHub's own state. A closed child is resolved whatever else is true of
    /// it, which is the top of the node-state precedence.
    pub closed: bool,
    /// `issueDependenciesSummary.blockedBy`, which counts **open** blockers
    /// only — `totalBlockedBy` is the one that counts them all. That is why
    /// this single number is the entire unblocked test and why nothing here
    /// walks the `blockedBy` node list to work it out again.
    pub blocked_by: u32,
    /// How many people hold it. *Claimed by me* is not a distinction this can
    /// make — every run assigns the same login — so identity is deliberately
    /// not carried and liveness is a later ticket's, not this one's.
    pub assignees: u32,
    /// The numbers of the issues this child waits on, in the order the answer
    /// listed them. The graph's edges, and the only adjacency there is.
    ///
    /// **Every blocker the answer named, resolved ones included.** That is what
    /// makes a rank read as *how far along*: a ticket whose one predecessor is
    /// finished is still one step in from the start, and an edge set that
    /// dropped the closed half would slide it back into the first column. How
    /// many of them are still in the way is a different question, and
    /// [`ChildRead::blocked_by`] is the one number that answers it.
    ///
    /// Blockers in another repository are not here. An issue number means
    /// nothing outside the repository that issued it, so keeping them would
    /// draw `other/repo#75` as an edge from whatever this map's `#75` happens
    /// to be.
    pub waits_on: Vec<u64>,
    /// Verbatim, in the order the answer listed them.
    pub labels: Vec<String>,
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

/// Tripwires for pages that were cut off.
///
/// Three of these are for pages that cannot exist: GitHub caps sub-issues at 100
/// per parent and linked issues at 50 per relationship, and both fit in one page
/// — so a paging loop here would be code nobody has ever run, which is worse than
/// no code at all. They are parsed and asserted on instead: if one ever fires,
/// the fact is in the read rather than silently missing from the graph.
///
/// [`Truncation::labels`] is the fourth and is a different animal. Nothing caps
/// how many labels an issue may carry, so its page *can* exist — and it is the
/// one truncation that fails **unsafe** rather than merely incomplete. A
/// `platform:` label cut off the end of the list is indistinguishable from a
/// ticket that said nothing about machines, and a ticket that said nothing about
/// machines is offered on all of them. The query asks for 100, which is the most
/// GitHub will answer in one page; past that, this flag is the only thing
/// standing between a truncated answer and an agent launched on a machine the
/// operator ruled out.
///
/// Which is why the two are asked about separately —
/// [`Truncation::capped`] for the three and [`Truncation::labels`] for the
/// fourth. They reach an operator as two sentences because they are two facts:
/// *something that cannot happen has, and some of this is not on screen* is
/// the whole of the first, and it names no action because there is none; the
/// second has a named consequence and something to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Truncation {
    pub maps: bool,
    pub children: bool,
    pub blocked_by: bool,
    /// A child (or the map itself) carried more labels than one page holds.
    ///
    /// Not part of [`Truncation::capped`], and the one flag here that is about
    /// a page which can ordinarily exist.
    pub labels: bool,
}

impl Truncation {
    /// Whether anything at all was cut off. One question, so a caller does not
    /// have to remember which four fields to ask about.
    ///
    /// This is `capped() || labels`, and it is the right question for a test or
    /// an assertion — *was this answer whole*. It is the **wrong** question for
    /// copy, because the two halves are two different facts with two different
    /// consequences, and one sentence over both would have to be either false
    /// about one of them or too vague to act on. What the chrome prints is
    /// [`Truncation::capped`] and [`Truncation::labels`], separately.
    pub fn any(&self) -> bool {
        self.capped() || self.labels
    }

    /// Whether a page GitHub's own limits forbid was answered anyway.
    ///
    /// The three capped connections and deliberately not [`Truncation::labels`].
    /// These three are one sentence on screen because they are one fact — a page
    /// that cannot exist has — and that sentence stays true only while the flag
    /// behind it is fed by the three connections that really are capped. Labels
    /// have no product cap, so folding them in here is what would turn *which
    /// its own limits say cannot happen* into a lie.
    pub fn capped(&self) -> bool {
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
    ///
    /// `kind` is GitHub's own `type` on the error object — `NOT_FOUND`,
    /// `RATE_LIMITED`, `FORBIDDEN` — carried as the structured field it is so
    /// that whoever decides whether retrying helps can read it. The
    /// alternative is grepping `message` for words, which is the thing this
    /// repository keeps refusing to do: a sentence GitHub rewords is a
    /// classification that silently changes. Empty when the answer named no
    /// type, which is *unclassified* and never *ordinary*.
    #[error("GitHub answered the query with an error: {message}")]
    Answered { kind: String, message: String },

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
        return Err(ReadError::Answered {
            kind: first.kind,
            message: first.message,
        });
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

    // Which repository the whole answer is about, so that a blocker naming
    // another one can be told apart from a blocker naming a child of this map.
    let repository_name = repository.name_with_owner;

    let map = repository.issue.map(|issue| {
        truncation.children |= issue.sub_issues.page_info.has_next_page;
        truncation.labels |= issue.labels.page_info.has_next_page;

        // Flattened twice for the reason the map list is: the connection may be
        // absent, and any single node in a GraphQL list may be null.
        let children = issue
            .sub_issues
            .nodes
            .into_iter()
            .flatten()
            .flatten()
            .map(|child| {
                let blocked_by = child.blocked_by;
                truncation.blocked_by |= blocked_by.page_info.has_next_page;
                // The one that decides whether a `platform:` label was even
                // there to read — see [`Truncation::labels`].
                truncation.labels |= child.labels.page_info.has_next_page;
                ChildRead {
                    number: child.number,
                    title: child.title,
                    url: child.url,
                    closed: child.state.eq_ignore_ascii_case("CLOSED"),
                    // Absent means nothing blocks it. A missing summary read as
                    // *blocked* would hide a takeable ticket, and read as an
                    // error would stop the whole map drawing over one field.
                    blocked_by: child
                        .issue_dependencies_summary
                        .map(|summary| summary.blocked_by)
                        .unwrap_or(0),
                    assignees: child
                        .assignees
                        .nodes
                        .iter()
                        .flatten()
                        .flatten()
                        .count()
                        .min(u32::MAX as usize) as u32,
                    labels: child
                        .labels
                        .nodes
                        .into_iter()
                        .flatten()
                        .flatten()
                        .map(|label| label.name)
                        .collect(),
                    waits_on: blocked_by
                        .nodes
                        .into_iter()
                        .flatten()
                        .flatten()
                        .filter(|blocker| blocker.belongs_to(&repository_name))
                        .filter_map(|blocker| blocker.number)
                        .collect(),
                }
            })
            .collect();

        MapGraph {
            number: issue.number,
            // Absent is open. The field was added to the query by the ticket
            // that needed it, and a recorded response taken before that is a
            // response about a map that was open at the time.
            closed: issue.state.eq_ignore_ascii_case("CLOSED"),
            title: issue.title,
            children,
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

/// The inverse: the second an RFC 3339 stamp names, or nothing.
///
/// It exists because GitHub sends `resetAt` as text and the poller's budget
/// floor is a number of seconds, and it lives beside [`rfc3339`] because a
/// conversion and its inverse that drift apart are the failure worth spending a
/// file's attention on — the round trip is one assertion when they are three
/// lines apart and no assertion at all when they are two crates apart.
///
/// **Strict about the one shape GitHub sends**: `YYYY-MM-DDTHH:MM:SSZ`, UTC,
/// no fraction and no offset. Everything else is `None` rather than a best
/// guess, because the caller reads `None` as *this answer said nothing about
/// when the budget resets* and degrades to no constraint at all. Failing open
/// costs one poll at the ordinary rung; guessing an offset and then pacing an
/// hour's spending against the guess costs the reserve.
pub fn epoch_from_rfc3339(text: &str) -> Option<i64> {
    const SECONDS_PER_DAY: i64 = 86_400;
    const SHAPE: [(usize, u8); 6] = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'Z'),
    ];

    let bytes = text.as_bytes();
    if bytes.len() != 20 || SHAPE.iter().any(|&(at, expected)| bytes[at] != expected) {
        return None;
    }

    // `parse` alone would accept a sign and a leading space, neither of which is
    // this shape, and both of which would land inside a fixed-width field.
    let number = |from: usize, to: usize| -> Option<i64> {
        let field = &text[from..to];
        field
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| field.parse().ok())
            .flatten()
    };

    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;

    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    Some(days_from_civil(year, month, day)? * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second)
}

/// Hinnant's `days_from_civil`, and the whole of what makes a date a date.
///
/// The 31st of February is six digits that parse and is not a day, and the
/// month lengths are already known to [`civil_from_days`] — so rather than a
/// second table that could disagree with the first, the answer is read back.
/// A day that comes back as a different day was never that day, and that one
/// comparison covers every month length and every leap-year rule at once.
fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let shifted = year - i64::from(month <= 2);
    let era = shifted.div_euclid(400);
    let year_of_era = shifted.rem_euclid(400);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    (civil_from_days(days) == (year, month as u32, day as u32)).then_some(days)
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
        /// GitHub's own classification of the refusal. `type` is a keyword
        /// here, so it is renamed rather than spelled `r#type` — and it is
        /// defaulted because an error object without one is a refusal this
        /// build has no name for, not a parse failure.
        #[serde(rename = "type", default)]
        pub kind: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Data {
        pub repository: Option<Repository>,
        pub rate_limit: Option<RateLimit>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Repository {
        /// `owner/name`, as GitHub spells it on both ends of a dependency.
        #[serde(default)]
        pub name_with_owner: String,
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
        pub state: String,
        /// Read for its `pageInfo` alone. The map's own labels decide nothing —
        /// discovery already happened by the time this answer exists — but a
        /// truncated page here is the same tripwire as a truncated page on a
        /// child, and a selection with no tripwire is the thing this file keeps
        /// arguing against.
        #[serde(default)]
        pub labels: Connection<Label>,
        #[serde(default)]
        pub sub_issues: Connection<Child>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Child {
        pub number: u64,
        #[serde(default)]
        pub title: String,
        #[serde(default)]
        pub state: String,
        #[serde(default)]
        pub url: String,
        #[serde(default)]
        pub labels: Connection<Label>,
        #[serde(default)]
        pub assignees: Connection<serde_json::Value>,
        /// Optional rather than defaulted, so *the field was not in the answer*
        /// and *the answer said zero* stay different facts on the way in. What
        /// they mean is decided at the call site, once, in the open.
        pub issue_dependencies_summary: Option<DependenciesSummary>,
        #[serde(default)]
        pub blocked_by: Connection<Blocker>,
    }

    /// One end of one dependency edge.
    #[derive(Deserialize)]
    pub(super) struct Blocker {
        /// Optional rather than defaulted: a blocker with no number is not
        /// blocker zero, and an answer that carried one must not become an edge
        /// to whatever `#0` would be.
        #[serde(default)]
        pub number: Option<u64>,
        pub repository: Option<BlockerRepository>,
    }

    impl Blocker {
        /// Whether this blocker is an issue of the repository the answer was
        /// about — the whole of the cross-repository test, spelled once.
        ///
        /// A name that neither end stated is not evidence of a difference, so a
        /// silence never drops an edge: only two names that are both known and
        /// unequal do. The failure that ordering avoids is a recorded answer
        /// from before either field was asked for losing its whole graph.
        pub(super) fn belongs_to(&self, repository: &str) -> bool {
            let named = self
                .repository
                .as_ref()
                .map(|repository| repository.name_with_owner.as_str())
                .unwrap_or_default();

            named.is_empty() || repository.is_empty() || named == repository
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct BlockerRepository {
        #[serde(default)]
        pub name_with_owner: String,
    }

    #[derive(Deserialize)]
    pub(super) struct Label {
        #[serde(default)]
        pub name: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct DependenciesSummary {
        /// Open blockers. `totalBlockedBy` rides the same query and is
        /// deliberately not read: it counts closed blockers too, and a ticket
        /// whose blockers are all closed is takeable.
        #[serde(default)]
        pub blocked_by: u32,
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
    const AWKWARD: &str = include_str!("../fixtures/awkward-children.json");
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
        let map = read_response(TWO_MAPS).expect("reads").map.expect("a map");

        assert_eq!(map.number, 28);
        assert_eq!(map.title, "Spec: perseverance");
        assert!(!map.closed);
    }

    #[test]
    fn the_children_arrive_in_the_order_the_operator_dragged_them_into() {
        let map = read_response(TWO_MAPS).expect("reads").map.expect("a map");

        let numbers: Vec<u64> = map.children.iter().map(|child| child.number).collect();
        assert_eq!(numbers, vec![32, 33]);
    }

    #[test]
    fn a_child_carries_what_the_answer_said_about_it_and_nothing_concluded_from_it() {
        let map = read_response(TWO_MAPS).expect("reads").map.expect("a map");

        let unclaimed = &map.children[0];
        assert_eq!(unclaimed.number, 32);
        assert_eq!(unclaimed.title, "Maps on screen");
        assert_eq!(unclaimed.url, "https://github.com/o/r/issues/32");
        assert!(!unclaimed.closed);
        assert_eq!(unclaimed.labels, vec!["wayfinder:task".to_string()]);
        assert_eq!(unclaimed.assignees, 0);
        // One blocker, and it is closed — so the count of *open* blockers is
        // zero while `totalBlockedBy` says two. Reading the wrong one of those
        // two numbers is the whole difference between a takeable ticket and a
        // frontier that never moves.
        assert_eq!(unclaimed.blocked_by, 0);

        let claimed = &map.children[1];
        assert_eq!(claimed.assignees, 1);
        assert_eq!(claimed.blocked_by, 1);
    }

    #[test]
    fn a_child_carries_the_numbers_it_waits_on_in_the_order_the_answer_listed_them() {
        let map = read_response(AWKWARD).expect("reads").map.expect("a map");

        let held_up = map
            .children
            .iter()
            .find(|child| child.number == 72)
            .expect("#72 is on this map");
        assert_eq!(held_up.waits_on, vec![75, 76]);
    }

    #[test]
    fn a_blocker_that_has_since_closed_is_still_an_edge_of_the_graph() {
        let map = read_response(AWKWARD).expect("reads").map.expect("a map");

        let startable = map
            .children
            .iter()
            .find(|child| child.number == 75)
            .expect("#75 is on this map");
        // Nothing is in its way — and it is still one step in from the start.
        // The count and the edge list answer different questions, and an edge
        // set that dropped the resolved half would answer neither.
        assert_eq!(startable.blocked_by, 0);
        assert_eq!(startable.waits_on, vec![71]);
    }

    #[test]
    fn a_blocker_in_another_repository_is_not_an_edge_on_this_map() {
        // `other/repo#75` and this map's `#75` are different tickets, and an
        // edge drawn between the two boxes this map has would be a dependency
        // nobody declared.
        let body = r#"{
            "data": {
                "repository": {
                    "nameWithOwner": "o/r",
                    "maps": { "nodes": [] },
                    "issue": {
                        "number": 1, "title": "One", "state": "OPEN",
                        "subIssues": { "nodes": [
                            { "number": 2, "title": "Two", "state": "OPEN", "url": "u",
                              "labels": { "nodes": [] }, "assignees": { "nodes": [] },
                              "blockedBy": { "nodes": [
                                { "number": 75, "repository": { "nameWithOwner": "other/repo" } },
                                { "number": 3, "repository": { "nameWithOwner": "o/r" } }
                              ] } }
                        ] }
                    }
                },
                "rateLimit": null
            }
        }"#;

        let map = read_response(body).expect("reads").map.expect("a map");

        assert_eq!(map.children[0].waits_on, vec![3]);
    }

    #[test]
    fn an_answer_that_named_no_repository_at_either_end_keeps_its_edges() {
        // A silence is not a difference. Dropping an edge for want of a name
        // would lose the whole graph of a recorded answer taken before either
        // field was asked for.
        let body = r#"{
            "data": {
                "repository": {
                    "maps": { "nodes": [] },
                    "issue": {
                        "number": 1, "title": "One", "state": "OPEN",
                        "subIssues": { "nodes": [
                            { "number": 2, "title": "Two", "state": "OPEN", "url": "u",
                              "labels": { "nodes": [] }, "assignees": { "nodes": [] },
                              "blockedBy": { "nodes": [ { "number": 3 } ] } }
                        ] }
                    }
                },
                "rateLimit": null
            }
        }"#;

        let map = read_response(body).expect("reads").map.expect("a map");

        assert_eq!(map.children[0].waits_on, vec![3]);
    }

    #[test]
    fn a_child_whose_answer_carried_no_dependency_summary_is_read_as_nothing_blocking_it() {
        // Absent is not *blocked*. A field GitHub declined to answer with must
        // not be the thing that hides the one ticket you could have started.
        let body = r#"{
            "data": {
                "repository": {
                    "maps": { "nodes": [] },
                    "issue": {
                        "number": 1, "title": "One", "state": "OPEN",
                        "subIssues": { "nodes": [
                            { "number": 2, "title": "Two", "state": "OPEN", "url": "u",
                              "labels": { "nodes": [] }, "assignees": { "nodes": [] } }
                        ] }
                    }
                },
                "rateLimit": null
            }
        }"#;

        let map = read_response(body).expect("reads").map.expect("a map");

        assert_eq!(map.children[0].blocked_by, 0);
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
                                { "number": 2,
                                  "labels": { "pageInfo": { "hasNextPage": true }, "nodes": [] },
                                  "blockedBy": { "pageInfo": { "hasNextPage": true }, "nodes": [] } }
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
                labels: true,
            }
        );
    }

    #[test]
    fn a_child_whose_labels_did_not_all_fit_says_so_rather_than_reading_as_unlabelled() {
        // The one truncation that fails unsafe. A `platform:` label past the end
        // of the page is indistinguishable, in `ChildRead::labels`, from a ticket
        // that said nothing about machines — and a ticket that said nothing about
        // machines is offered on all of them. The flag is what turns that from a
        // silent mis-derivation into something the chrome prints.
        let body = r#"{
            "data": {
                "repository": {
                    "maps": { "pageInfo": { "hasNextPage": false }, "nodes": [] },
                    "issue": {
                        "number": 1,
                        "title": "One",
                        "subIssues": {
                            "pageInfo": { "hasNextPage": false },
                            "nodes": [
                                { "number": 2,
                                  "labels": {
                                      "pageInfo": { "hasNextPage": true },
                                      "nodes": [ { "name": "wayfinder:task" } ]
                                  } }
                            ]
                        }
                    }
                },
                "rateLimit": null
            }
        }"#;

        let read = read_response(body).expect("reads");

        assert!(read.truncation.labels);
        assert!(read.truncation.any());
        // And only that one: nothing else about this answer was cut off.
        assert!(!read.truncation.maps);
        assert!(!read.truncation.children);
        assert!(!read.truncation.blocked_by);
        // **And it is not a capped page.** This is the assertion that keeps the
        // chrome's sentence honest: *a page GitHub's own limits say cannot
        // exist* is fed by `capped()`, and a label list that overran has not
        // overrun any cap — nothing limits how many labels an issue may carry.
        // Folding it in would print an impossibility at an operator whose issue
        // is merely well-labelled, and would print it in place of the one
        // sentence that names what the overrun actually costs.
        assert!(!read.truncation.capped());
    }

    #[test]
    fn a_page_that_cannot_exist_and_a_label_list_that_ran_long_are_two_readings() {
        // `any()` is the question a test asks; `capped()` and `labels` are the
        // two an operator is answered with. The three capped connections are one
        // fact with no action attached to it — GitHub broke its own promise, and
        // some of the graph is missing. A label list that ran long is a fact
        // about an ordinary issue with a consequence that can be acted on. One
        // sentence over both would have to be false about one of them.
        let capped = Truncation {
            maps: true,
            ..Truncation::default()
        };
        let ran_long = Truncation {
            labels: true,
            ..Truncation::default()
        };

        assert!(capped.any() && ran_long.any());
        assert!(capped.capped() && !capped.labels);
        assert!(!ran_long.capped() && ran_long.labels);
    }

    #[test]
    fn an_answer_carrying_an_error_beside_its_data_is_refused_rather_than_half_read() {
        let body = r#"{
            "data": { "repository": null, "rateLimit": null },
            "errors": [ { "type": "NOT_FOUND",
                          "message": "Could not resolve to a Repository with the name 'o/r'." } ]
        }"#;

        let refusal = read_response(body).expect_err("refuses");

        assert_eq!(
            refusal,
            ReadError::Answered {
                kind: "NOT_FOUND".to_string(),
                message: "Could not resolve to a Repository with the name 'o/r'.".to_string(),
            }
        );
    }

    #[test]
    fn the_type_github_names_a_refusal_by_is_carried_rather_than_read_out_of_its_prose() {
        // The whole reason `kind` exists: whether retrying helps is decided
        // from this field and never from the sentence beside it. GitHub rewords
        // messages; it does not rename `NOT_FOUND`.
        let typed = r#"{ "errors": [ { "type": "RATE_LIMITED",
                                       "message": "API rate limit exceeded" } ] }"#;

        assert_eq!(
            read_response(typed).expect_err("refuses"),
            ReadError::Answered {
                kind: "RATE_LIMITED".to_string(),
                message: "API rate limit exceeded".to_string(),
            }
        );

        // And an error object with no `type` at all is a refusal this build has
        // no name for — an empty string, which is a fact, rather than a guess
        // at which of the four conditions it was.
        let untyped = r#"{ "errors": [ { "message": "Something went wrong" } ] }"#;

        assert_eq!(
            read_response(untyped).expect_err("refuses"),
            ReadError::Answered {
                kind: String::new(),
                message: "Something went wrong".to_string(),
            }
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
            ReadError::Answered {
                kind: "NOT_FOUND".to_string(),
                message: "Could not resolve to a Repository".to_string(),
            }
            .to_string(),
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

    #[test]
    fn the_stamp_text_this_crate_writes_reads_back_as_the_second_it_came_from() {
        // Round-trip first, because a conversion that disagrees with its own
        // inverse is worse than one that refuses: the two halves are three lines
        // apart and would still be wrong in opposite directions.
        let stamps = [
            0,
            1_785_888_000,
            // A leap day and the last second of a year — the two places the
            // one-line civil-date arithmetic goes wrong if it is going to.
            1_709_164_800,
            1_798_761_599,
            951_782_400,
            -1,
        ];

        for epoch in stamps {
            assert_eq!(epoch_from_rfc3339(&rfc3339(epoch)), Some(epoch), "{epoch}");
        }

        // GitHub's own text, taken from the checked-in answer rather than
        // written out here, because the shape it sends is the whole contract.
        assert_eq!(
            epoch_from_rfc3339(
                &read_response(TWO_MAPS)
                    .expect("reads")
                    .rate_limit
                    .expect("a budget")
                    .reset_at
            ),
            Some(1_785_927_734)
        );
    }

    #[test]
    fn a_stamp_in_any_shape_but_the_one_github_sends_is_refused_rather_than_guessed() {
        // The caller reads `None` as *this answer said nothing about when the
        // budget resets*, which degrades to no constraint at all. Failing open
        // is safe; guessing an offset and then pacing an hour's spending against
        // the guess is not.
        let refused = [
            "",
            "nonsense",
            "2026-08-05",
            // An offset is a different instant, not a different spelling.
            "2026-08-05T11:02:14+02:00",
            "2026-08-05 11:02:14Z",
            "2026-08-05T11:02:14.5Z",
            "2026-13-05T00:00:00Z",
            "2026-08-32T00:00:00Z",
            // Digits that are not a date. The month lengths are known to the
            // conversion already, so this must not need a second table.
            "2026-02-31T00:00:00Z",
            "2026-08-05T25:00:00Z",
            "2026-08-05T11:62:14Z",
            "2026-08-05T11:02:99Z",
        ];

        for text in refused {
            assert_eq!(epoch_from_rfc3339(text), None, "{text:?}");
        }
    }
}
