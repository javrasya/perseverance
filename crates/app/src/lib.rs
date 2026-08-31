//! The thin Tauri shell.
//!
//! Wiring only. Every decision this app makes belongs to one of the other five
//! crates; what lives here is the window, the command surface, and the plumbing
//! between them. If logic starts accumulating in this crate it belongs
//! somewhere else.
//!
//! That charter is why the launcher registry is [`perseverance_store`] and not
//! a module of this one. Refusing a schema version this build does not speak,
//! keeping a folder whose drive is unplugged on the list, and telling three
//! kinds of not-a-repository apart are all decisions; the commands below only
//! carry their answers to the WebView. `docs/adr/0001` records that choice.
//!
//! [`perseverance_store`]: https://github.com/javrasya/perseverance

pub mod prompt;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use perseverance_agent::{agent, agent_named, AgentId, LaunchContext, Override, Platform, Scope};
use perseverance_env::{
    degradation_in, locate_in, probe_in, spawnable_form, Bounds, Degradation, Environment,
    FolderEnvironment, HarvestAttempt, Harvests, Located, ProbeOutcome, Shell, Stderr, StderrKind,
    Tally,
};
use perseverance_github::{
    acquire_token, map_read_query_id, read_login, read_maps, read_ticket_body, Ahead, Attention,
    Fault, FreshRead, Held, Poke, Poker, ReadFailure, Revalidated, RunHandle, Tick, Timings,
    TokenOutcome, Watched,
};
use perseverance_model::{
    read_response, ChangeLog, ChildKind, Degraded, Frontier, Machine, Map, MapRead, Model,
    NodeState, Phase, Provenance, ReadOutcome, Snapshot, Source, TicketType,
};
use perseverance_pty::{Delivery, Geometry, RunId, Runs, GRACE};
use perseverance_store::{CachedBody, CachedGraph, Folder, RepoBindingError, Store, StoreError};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// The whole model for one tick, in one call.
///
/// The WebView receives a [`Snapshot`] and nothing else — that is the primary
/// seam, and it is a structural fact rather than a convention because there is
/// no other command that hands the frontend map state.
///
/// A read, never a derivation. The poller derives, once per tick, and this
/// hands back whatever it last emitted — so a snapshot asked for and a snapshot
/// delivered are the same value rather than two derivations that can disagree.
/// Asking as well as subscribing is what covers the gap between a poll landing
/// and the WebView having a listener, exactly as it does for the environment.
#[tauri::command]
fn snapshot(ledgers: State<'_, Ledgers>) -> Snapshot {
    ledgers.held()
}

/* ---------------------------------------------------------------- maps --- */

/// One row of the map list.
///
/// Discovered by label rather than registered, which is why nothing here has an
/// id of ours: a map is an issue on GitHub, and the number is its whole
/// identity. Nothing is derived — no phase, no counts, no frontier — because
/// derivation is #33's and a number invented here would be a number the graph
/// could disagree with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MapEntry {
    number: u64,
    title: String,
    /// Closed maps group under *Completed*. This is a grouping fact, never a
    /// filter: a finished map is reopened to read the decisions it made.
    closed: bool,
    url: String,
    updated_at: String,
}

impl From<&perseverance_model::MapListing> for MapEntry {
    fn from(listing: &perseverance_model::MapListing) -> MapEntry {
        MapEntry {
            number: listing.number,
            title: listing.title.clone(),
            closed: listing.closed,
            url: listing.url.clone(),
            updated_at: listing.updated_at.clone(),
        }
    }
}

/// `rateLimit`, carried to the WebView and read by nobody on that side.
///
/// #39 spent it, and spent it in Rust: the poller paces itself from these
/// numbers and the WebView is handed the conclusion —
/// [`MapsView::yielding_to_rate_limit`] — rather than the arithmetic. This stays
/// on the wire as the diagnostic it always was, next to the flag derived from
/// it, so a readout that disagreed with the clause has something to disagree
/// with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRateLimit {
    cost: u32,
    node_count: u32,
    limit: u32,
    remaining: u32,
    reset_at: String,
}

/// The map list, and where it came from.
///
/// Provenance is *in* this value rather than beside it, for the same reason it
/// is fused into [`Snapshot`]: two streams would let a fresh list paint against
/// a stale stamp for a frame, which is absence disguised as presence.
///
/// `Clone` is here for one reason: Tauri's `Emitter::emit` asks for it, and the
/// live read now leaves this process as an event rather than as the answer to a
/// command. It moves nothing on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MapsView {
    folder_id: i64,
    maps: Vec<MapEntry>,
    provenance: Provenance,
    rate_limit: Option<WireRateLimit>,
    /// A page that cannot exist, if one ever does. Rendered as a caveat rather
    /// than paged through, because a paging loop for a page GitHub's own limits
    /// forbid is code nobody has ever run.
    ///
    /// [`Truncation::capped`] and not `any()`: the fourth flag crosses beside
    /// this one, because a page that *can* exist folded into this one would make
    /// the sentence it prints false.
    truncated: bool,
    /// A label list longer than one page, which is an ordinary thing for an
    /// issue to have and the one truncation that fails unsafe.
    ///
    /// Beside `truncated` rather than inside it because it is a different fact
    /// with a different consequence and its own sentence: a `platform:` label
    /// past the end of the page reads, in the model, as a ticket that said
    /// nothing about machines, so a ticket bound to a Mac can be offered here.
    /// The two cannot disagree — they read two disjoint halves of one
    /// [`Truncation`] — and either, both, or neither is a state the chrome
    /// draws.
    labels_truncated: bool,
    /// Whether the rate-limit budget is what is holding the poller's interval
    /// down, right now — already decided, on the Rust side, by the composition
    /// in `cadence.rs`. The WebView paints a clause from it and computes
    /// nothing: it has no `resetAt` arithmetic, no reserve to compare against
    /// and no notion of which floor won, which is the whole of ADR 0004 applied
    /// to one boolean.
    ///
    /// It lives here rather than on [`Provenance`] because it is a fact about
    /// the poller and the model crate may not know what a poller is. And it is
    /// the *winning term* rather than *a budget exists*, because the clause it
    /// feeds is only true while the yielding is what you are waiting for.
    ///
    /// **The `maps` command always answers `false`**: nothing is behind it but
    /// the store, and a cached list is not a statement about an interval. So the
    /// clause arrives with the first poll rather than with first paint.
    yielding_to_rate_limit: bool,
}

impl MapsView {
    /// The state a folder is in before anything has been read for it. An
    /// absence, never an empty list — a folder with no map is a normal thing to
    /// be, and *we have not looked yet* is a different thing again.
    fn nothing_read_yet(folder_id: i64) -> MapsView {
        MapsView {
            folder_id,
            maps: Vec::new(),
            provenance: Provenance {
                source: Source::None,
                outcome: ReadOutcome::NotAttempted,
                fetched_at: None,
            },
            rate_limit: None,
            truncated: false,
            labels_truncated: false,
            yielding_to_rate_limit: false,
        }
    }

    /// One parsed read, dressed as a view. `source` is the caller's to state,
    /// because the same bytes mean *live* the moment they arrive and *cache*
    /// every time afterwards.
    fn of(folder_id: i64, read: &MapRead, source: Source, fetched_at: i64) -> MapsView {
        MapsView {
            folder_id,
            maps: read.maps.iter().map(MapEntry::from).collect(),
            provenance: Provenance {
                source,
                outcome: ReadOutcome::Ok,
                fetched_at: Some(perseverance_model::rfc3339(fetched_at)),
            },
            rate_limit: read.rate_limit.as_ref().map(|limit| WireRateLimit {
                cost: limit.cost,
                node_count: limit.node_count,
                limit: limit.limit,
                remaining: limit.remaining,
                reset_at: limit.reset_at.clone(),
            }),
            truncated: read.truncation.capped(),
            labels_truncated: read.truncation.labels,
            yielding_to_rate_limit: false,
        }
    }

    /// The same list, read out of a body this build cannot identify the
    /// question behind.
    ///
    /// The maps themselves stay. Numbers, titles and states are the part of a
    /// body a widening leaves alone, and emptying the launcher over a stamp
    /// would be the assertion [`MapsView::stale`] already refuses to make —
    /// *your maps are gone* on the strength of not having been able to look.
    ///
    /// What cannot stay is `labels_truncated` reading clean. Nothing caps how
    /// many labels an issue carries, so that page really can exist, and the
    /// flag is derived from a `pageInfo` a narrower document may never have
    /// asked for — #61 is exactly that widening. A flag that answers clean
    /// because the question was never put is the harm #82 opened for: an
    /// operator who reads no caveat believes there is nothing past the end of
    /// the list, and a `platform:` label past the end is indistinguishable from
    /// a ticket that named no machine. So it goes to the caveat until a live
    /// read re-derives it, which is the direction [`Truncation::labels`] fails
    /// in everywhere else.
    ///
    /// **Setting it here does not assert that a list was cut off.** This build
    /// cannot know that, and an unknown printed as a fact is the thing
    /// [`MapsView::nothing_read_yet`] and `ChangeLog::first_open` refuse to do
    /// everywhere else in this app — an absence is not an empty list and a
    /// missing baseline is not *0 changes*. What the flag asserts is the
    /// sentence `LABELS_TRUNCATED_NOTE` actually prints, and that sentence was
    /// weakened by one word to make it true of both of the flag's producers:
    /// *some of the labels here may not have been read*, over a `hasNextPage` a
    /// live read really saw and over a `pageInfo` an unfamiliar document may
    /// never have asked for. The alternative — a second sentence of its own —
    /// buys a state on the wire and a fourth note to keep true for a difference
    /// an operator acts on identically, since the act is the same second look
    /// either way. ADR 0019 records the trade.
    ///
    /// `truncated` is deliberately left alone, and this is the whole of the
    /// asymmetry. Its sentence names GitHub — a page GitHub's own limits forbid
    /// was answered anyway — and the same weakening is not available to it: *a
    /// cap may have been broken* is not a cautious reading of that sentence but
    /// a different accusation, and a stamp is evidence about a `pageInfo`,
    /// never about what GitHub did. Setting it here would put that sentence in
    /// front of every operator on their first launch after the version-3
    /// upgrade, and keep it there for as long as the polls went on failing. A
    /// caveat that says something false is not a smaller lie than a flag that
    /// reads clean.
    ///
    /// That reasoning covers the `children` and `blocked_by` legs of
    /// [`Truncation::capped`], which are the ones `map-read.graphql` argues are
    /// impossible. It does **not** cover the `maps` leg: `issues(first: 100,
    /// labels: [...])` has no product cap behind it, so a second page of maps is
    /// ordinary and a narrower `maps` document would go unvouched and silent
    /// here. That grouping predates #82 and is not this change's to unpick; it
    /// is a known gap, recorded in ADR 0019, and closing it means splitting
    /// `capped()` rather than reusing a sentence that would be false.
    fn unvouched(mut self) -> MapsView {
        self.labels_truncated = true;
        self
    }

    /// Which floor holds the interval this view is being emitted *into*.
    ///
    /// The tense is load-bearing, and it is the poller's [`Ahead`] query that
    /// supplies it: whoever reads a stamp is about to wait, so the clause has to
    /// describe the wait ahead of them rather than the one that just ended. The
    /// two differ exactly where it matters — the poll that fires at the reset
    /// waited out a budget-held hour and is the first thing to see the refill.
    ///
    /// Applied by [`emit_view`] and by nothing else, so no branch of
    /// [`poll_once`] can construct a view and forget it. A default of `false`
    /// plus one place that sets it is the shape that makes *forgot to say* and
    /// *said not yielding* the same answer — which is the safe one of the two,
    /// because the clause it feeds asserts something is happening.
    fn yielding(mut self, held: Held) -> MapsView {
        self.yielding_to_rate_limit = held == Held::Budget;
        self
    }

    /// What is on screen when a read did not happen, or did not survive.
    ///
    /// The cached list stays; only the stamp changes. A failed poll that emptied
    /// the screen would be the harness asserting that the operator's maps are
    /// gone on the strength of not having been able to look.
    ///
    /// The yielding flag is left alone here on purpose: a read that failed does
    /// not stop the poller yielding, and the interval is a fact about the loop
    /// rather than about the answer. The stamp is where the two are reconciled —
    /// a failure and a yield are two reasons and one sentence, and the failure
    /// is the one about what is on screen.
    ///
    /// Two arguments, and neither is derivable from the other. `reason` is what
    /// this app concluded — the thing the graph paints a condition from and the
    /// poller times a backoff from — and `why` is the sentence the crate that
    /// refused actually wrote. A view carrying only the sentence would leave
    /// the WebView grepping prose for a condition; a view carrying only the
    /// condition would leave an operator with a category and no account of it.
    fn stale(mut self, reason: Degraded, why: String) -> MapsView {
        self.provenance.outcome = ReadOutcome::Failed {
            reason,
            detail: why,
        };
        self.rate_limit = None;
        self
    }
}

/// Whether a cached row answers the question this build asks.
///
/// The one place the comparison lives, and the whole of it: byte-equal or not.
/// A row written before anything was stamped at all — the one a version-2 file
/// brings through the upgrade — is not this build's either, because `None` is
/// not this build's id.
fn under_this_builds_query(cached: &CachedGraph) -> bool {
    cached.query_id.as_deref() == Some(map_read_query_id())
}

/// The cached row for a folder-and-map, but only if this build asked the
/// question it answers.
///
/// Every field of the read model tolerates absence, so a body recorded under a
/// **narrower** document parses perfectly and simply answers with less — #61
/// widened both `labels` pages from ten to a hundred and added `pageInfo`, and
/// a body cached before it reports a child with no eleventh label and a
/// `labelsTruncated` that is falsely clean. Believed as a cold-start baseline,
/// that body draws a *while you were away* row for a change that never
/// happened. So for a **derivation** — a baseline, a flag — an unfamiliar stamp
/// is **first open**: this is what a caller reaches for when the answer it is
/// about to compute would be a guess.
///
/// It is not what the map list reaches for. A stamp says nothing against the
/// numbers, titles and states already on screen, and [`from_cache`] goes on
/// painting them; what it does not do is repeat the body's `labelsTruncated`.
/// The rule is scoped to what cannot be trusted rather than to the whole row,
/// because the wider version would answer *your maps are gone* every time
/// somebody edits the query document.
///
/// Not an error, either way: there is nothing wrong with the row, we simply
/// cannot say what parts of it are missing. And not a deletion — only a
/// successful GitHub read may delete anything, and that rule has no exception
/// for a row we happen to dislike. The condition heals itself: the next
/// successful read overwrites the row, stamp included.
fn cached_under_this_builds_query(
    store: &Store,
    folder_id: i64,
    map: Option<u64>,
) -> Option<CachedGraph> {
    store
        .cached_graph(folder_id, map)
        .ok()
        .flatten()
        .filter(under_this_builds_query)
}

/// The cached read for a folder, as a view — or the *nothing read yet* state.
///
/// A cached body that cannot be parsed is reported as a failed read of the
/// cache rather than deleted: **only a successful GitHub read may delete
/// anything**, and that rule has no exception for a row we happen to dislike.
///
/// A row from another document still paints, with [`MapsView::unvouched`] over
/// its `labelsTruncated`. This is the copy [`poll_once`] holds across every
/// failing exit it has, so a stamp that blanked it would empty the launcher for
/// as long as the polls kept failing — and the stamp is evidence about a
/// `pageInfo`, not about whether the operator has any maps.
fn from_cache(store: &Store, folder_id: i64) -> MapsView {
    // A registry that cannot be read is not a map list that is empty, but there
    // is nothing to paint either way and the launcher already carries the
    // registry's own refusal.
    let Some(cached) = store.cached_graph(folder_id, None).ok().flatten() else {
        return MapsView::nothing_read_yet(folder_id);
    };

    match read_response(&cached.graph_json) {
        Ok(read) => {
            let view = MapsView::of(folder_id, &read, Source::Cache, cached.fetched_at);
            if under_this_builds_query(&cached) {
                view
            } else {
                view.unvouched()
            }
        }
        // A body this build cannot read is schema drift on a copy, and drift is
        // [`Degraded::Unreachable`] wherever it happens: the next live read
        // replaces it, and a condition that stopped the poller over a cached
        // row would be this app refusing to fetch the very thing that would
        // have fixed it.
        Err(unreadable) => MapsView {
            provenance: Provenance {
                source: Source::Cache,
                outcome: ReadOutcome::Failed {
                    reason: Degraded::Unreachable,
                    detail: unreadable.to_string(),
                },
                fetched_at: Some(perseverance_model::rfc3339(cached.fetched_at)),
            },
            ..MapsView::nothing_read_yet(folder_id)
        },
    }
}

/// The whole of *written only on a successful GitHub read*, as a signature.
///
/// [`FreshRead`] has no constructor outside `perseverance-github`, and the only
/// thing that hands one out is an answer from GitHub that parsed. So a cache
/// write from a cached value is not a rule someone has to remember — it is a
/// call nobody can spell.
///
/// The prune rides along for the same reason: the live list is the evidence
/// that entitles a deletion, and it arrives in the same value.
///
/// `map` is the map the answer was read *with*. The same verbatim body goes
/// under the folder's own key and under that map's, because the map's row is
/// the **while you were away** baseline — the only thing a cold start has to
/// compare against. One row per `(folder, map)`, replaced rather than appended:
/// this is a cache, and #41 refused a second history on the grounds that GitHub
/// already keeps the real one. So there is still no new table.
///
/// There is a new **column**, and a schema bump to 3 with it: `query_id`, the
/// identity of the document that produced the body, taken off the same
/// [`FreshRead`] that proves the read was live. A baseline is only trustworthy
/// if we know what question it answers — a body recorded under a narrower
/// document parses cleanly and answers with less, which is a phantom *while you
/// were away* row rather than an error. The stamp is spent twice and not
/// alike: [`cached_under_this_builds_query`] turns an unfamiliar one into
/// *first open* for whoever is about to derive something from the body, while
/// the map list itself still paints and only its `labelsTruncated` moves to the
/// caveat.
///
/// The prune is last on purpose. A map the live list no longer names loses its
/// row even if this call just wrote one, because the evidence entitling the
/// deletion is the same read that produced the body.
fn remember_read(
    store: &Store,
    folder_id: i64,
    map: Option<u64>,
    fresh: &FreshRead,
) -> Result<(), StoreError> {
    // Taken off the live read once. The body and the stamp of the document
    // that produced it are one value from here down, so the folder's row and
    // the map's row cannot be written from two readings of the same read.
    let body = CachedBody {
        graph_json: fresh.body(),
        fetched_at: fresh.fetched_at(),
        query_id: fresh.query_id(),
    };

    store.cache_graph(folder_id, None, &body)?;

    if let Some(number) = map {
        store.cache_graph(folder_id, Some(number), &body)?;
    }

    let still_listed: Vec<u64> = fresh
        .read()
        .maps
        .iter()
        .map(|listing| listing.number)
        .collect();
    store.forget_cached_maps_except(folder_id, &still_listed)?;

    Ok(())
}

/// The map list as the store last saw it — cache only, and structurally so.
///
/// This command cannot reach GitHub: nothing on this path holds a token. That
/// is what makes *first paint is cache-sourced* a property of the wiring rather
/// than an ordering someone has to preserve.
#[tauri::command]
fn maps(registry: State<'_, Registry>, folder_id: i64) -> Result<MapsView, String> {
    let store = registry.store()?;

    Ok(from_cache(&store, folder_id))
}

/// The event every live read arrives on. There is no command that performs one.
///
/// `refresh_maps` used to be that command, and deleting it is the point rather
/// than a side effect: two independent live readers — a button and a loop —
/// would both be entitled to write `graph_cache`, and *the cadence decided this*
/// would stop being true of any particular read. The poller is the only thing
/// that reaches GitHub now, and a click is a poke into it.
const MAPS_EVENT: &str = "maps";

/// Nobody listening is not a failure, exactly as it is not one for the harvest.
///
/// It stamps the floor that will hold the next wait onto every view that
/// leaves, which is why it takes one: `poll_once` returns from seven places and
/// a flag set at each of them would be a flag missing from one of them.
fn emit_view<R: Runtime>(app: &AppHandle<R>, view: MapsView, held: Held) {
    let _ = app.emit(MAPS_EVENT, view.yielding(held));
}

/// The event every tick's [`Snapshot`] arrives on, mirroring [`MAPS_EVENT`].
///
/// The `snapshot` command answers with the same value rather than deriving a
/// second one, so the command and the event cannot come to disagree about what
/// this tick said.
const SNAPSHOT_EVENT: &str = "snapshot";

/// Nobody listening is not a failure, exactly as it is not one for the maps.
fn emit_snapshot<R: Runtime>(app: &AppHandle<R>, snapshot: Snapshot) {
    let _ = app.emit(SNAPSHOT_EVENT, snapshot);
}

/* ---------------------------------------------------------- the ledger --- */

/// The change ledger for the map this window is watching, for as long as it
/// watches it.
///
/// Session-lifetime and nothing more: an append-only table would be a second,
/// less accurate copy of a history GitHub already keeps, and `graph_cache`
/// already holds the one row a cold start needs. So nothing behind this type is
/// a new table, a migration or a schema bump — the ring lives in
/// [`ChangeLog`], in memory, and dies with the process.
///
/// It holds the last snapshot beside the log because the two are one fact. The
/// ledger that crosses is the one written from the model it crosses with; a
/// snapshot assembled from a model held here and a log held there would be a
/// later record stapled onto an earlier graph, which is the disagreement
/// [`Snapshot`] fuses provenance in to prevent.
pub struct Ledgers(Mutex<Watching>);

/// One map's log, and the snapshot it last produced.
struct Watching {
    /// Which folder and map the log below is a log *of*. `None` until the first
    /// [`Ledgers::attend`], which is the only thing that ever sets it, and
    /// comparing it is the whole of *is this still the same map*.
    of: Option<Watched>,
    log: ChangeLog,
    latest: Snapshot,
}

impl Ledgers {
    pub fn new() -> Ledgers {
        Ledgers(Mutex::new(Watching {
            of: None,
            log: ChangeLog::first_open(),
            latest: Snapshot::no_map_open(),
        }))
    }

    /// A poisoned lock means an earlier poll panicked mid-entry. The log is not
    /// the thing that panicked, so the guard is taken back rather than the rest
    /// of the session being written off — the posture [`Registry::store`] takes,
    /// for the same reason.
    fn hold(&self) -> MutexGuard<'_, Watching> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The last snapshot emitted, or the state the app opens in.
    fn held(&self) -> Snapshot {
        self.hold().latest.clone()
    }

    /// Called at the top of every poll, before anything reaches a socket.
    ///
    /// **The ordering is load-bearing.** The baseline is the cached graph as it
    /// was *before* this poll overwrites it, so a log started after
    /// [`remember_read`] would be comparing an answer against itself and every
    /// cold start would report nothing having moved.
    ///
    /// A different `(folder, map)` starts a new log and clears the snapshot with
    /// it: the previous map's graph is not an older read of this one, and a
    /// ledger carried across would be one map's entries filed under another's.
    fn attend(&self, store: &Store, watched: &Watched) {
        let mut watching = self.hold();
        if watching.of == Some(*watched) {
            return;
        }

        *watching = Watching {
            of: Some(*watched),
            log: resuming_from(store, watched),
            latest: Snapshot::no_map_open(),
        };
    }

    /// One poll that landed.
    ///
    /// `ours` is the claims this session's harness originated, which is the one
    /// change on screen an operator could have predicted and so the one that
    /// does not announce. The decision itself is [`ChangeLog::observed`]'s, in
    /// the model crate; this only carries the slice across.
    fn observed(&self, model: Model, fetched_at: i64, ours: &[u64]) -> Snapshot {
        let mut watching = self.hold();
        watching.log.observed(&model, ours);

        let snapshot = Snapshot::read(
            model,
            Source::Github,
            perseverance_model::rfc3339(fetched_at),
        )
        .with_ledger(watching.log.ledger());
        watching.latest = snapshot.clone();
        snapshot
    }

    /// One poll that did not.
    ///
    /// The model and the stamp stay exactly as they were and only the outcome
    /// changes — what you were reading is still true of the last time anybody
    /// looked. **The log is not touched at all**, which is how *a failed poll
    /// draws no row* holds here: there is no method on [`ChangeLog`] that a
    /// failure could call even by accident, because its only mutator takes a
    /// `&Model` and a failure has none.
    fn aged(&self, reason: Degraded, why: String) -> Snapshot {
        let mut watching = self.hold();
        let aged = watching.latest.clone().aged(reason, why);
        watching.latest = aged.clone();
        aged
    }
}

impl Default for Ledgers {
    fn default() -> Ledgers {
        Ledgers::new()
    }
}

/// The baseline a new log starts from: the cached graph for this map, or none.
///
/// **Absence is *first open* and never a zero**, and every way of not having a
/// baseline lands in the same place — no row at all, a body this build cannot
/// read, or a registry that would not answer. A cached body that will not parse
/// is schema drift on a copy; the next successful read replaces it, and until
/// then the honest thing to say is that nothing has been compared yet. Nothing
/// here deletes it either: only a successful GitHub read may delete anything.
fn resuming_from(store: &Store, watched: &Watched) -> ChangeLog {
    match cached_under_this_builds_query(store, watched.folder_id, watched.map) {
        Some(cached) => match read_response(&cached.graph_json) {
            // The same machine the landed poll below derives for. If the
            // baseline and the poll could disagree about it, every cold start
            // would report a frontier move that never happened — so both call
            // the one argument-free `const fn` and there is nothing to keep in
            // step. The document cannot disagree either, now: the row got here
            // only because it was stamped with the query this build sends.
            Ok(read) => ChangeLog::resuming(Model::of(&read, Machine::host())),
            Err(_) => ChangeLog::first_open(),
        },
        None => ChangeLog::first_open(),
    }
}

/// The claims this session's harness originated.
///
/// Empty today, and honestly so: nothing in this workspace assigns anything
/// yet — `crates/github` is read-only by charter and `crates/agent` and
/// `crates/pty` are stubs — so every claim on screen is somebody else's and
/// every one of them announces, which is what the ledger should say. #48 *Start
/// Working* is what calls [`Claims::claimed`]; the rule it feeds is already
/// implemented and tested against an explicit slice, so the day that ticket
/// lands the only new thing is the caller.
pub struct Claims(Mutex<Vec<u64>>);

impl Claims {
    pub fn new() -> Claims {
        Claims(Mutex::new(Vec::new()))
    }

    /// This harness took node `number`. Idempotent, because a claim taken twice
    /// is still one claim and a list with it twice would say nothing new.
    pub fn claimed(&self, number: u64) {
        let mut ours = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !ours.contains(&number) {
            ours.push(number);
        }
    }

    fn originated(&self) -> Vec<u64> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Default for Claims {
    fn default() -> Claims {
        Claims::new()
    }
}

/// What a refusal that never reached a socket is, and the sentence it keeps.
///
/// One function rather than a `Degraded::Unreachable` spelled at five returns,
/// for the reason `poller.rs` extracted `folded`: a decision written out at
/// every site it is taken is a decision a test can only restate. Mutate this
/// and the table below it fails; mutate a return and there is nothing left in
/// the return to mutate.
///
/// The condition is always [`Degraded::Unreachable`] because the question the
/// taxonomy answers is *is waiting going to help*, and for every one of these
/// it is: a drive is plugged back in, a folder mid-rename finishes, a registry
/// that would not open this second may open the next. What it must never become
/// is a *diagnosis* — so the sentence handed back is the refusing crate's own,
/// unedited, because *this folder names no GitHub remote* may not be reported
/// as *could not reach GitHub*.
fn local_refusal(said: String) -> (Degraded, String) {
    (Degraded::Unreachable, said)
}

/// One poll, as the poller's thread runs it.
///
/// The registry guard is **taken twice and held across nothing**. That is the
/// whole difference between this and the command it replaces: that one took the
/// lock and kept it through `read_maps`, which at one click is invisible and at
/// a ten-second cadence against a twenty-second deadline would stall `maps`,
/// `launcher` and every other command for as long as GitHub was slow, forever.
/// So the folder and its path are resolved under the lock, the guard goes, the
/// socket is opened with nothing held, and the lock comes back only for the
/// cache write.
///
/// A failure emits the cached list with a stale stamp rather than nothing, and
/// **every failing return names the condition it is**. That is #40's change to
/// this function: a stamp used to cross in the words of whichever crate refused
/// and nothing more, and the poller could only ever wait longer. The words still
/// cross, unedited; what is new beside them is the app's own conclusion, taken
/// once per return by [`ReadFailure::degraded`] or written down here for the
/// refusals that never reached a socket.
///
/// The five local refusals are the ones worth arguing, and every one of them
/// goes through [`local_refusal`] rather than naming a condition here. A
/// registry that will not open, a folder id nothing answers to, a folder that
/// names no GitHub repository, and a cache write that failed all recover by
/// themselves, so none of them is a reason to stop reading. The mistake to
/// guard against is the *reading*, not the retrying: the condition classifies
/// whether waiting helps and nothing else, and the `detail` beside it stays the
/// refusing crate's own sentence — which is what the WebView prints, so *this
/// folder names no GitHub remote* is what an operator reads. The fifth,
/// [`ReadFailure::NoToken`], is `AuthFailed`, which is also what prints
/// `gh auth login`.
///
/// `ahead` is the poller's answer to *which floor will hold the next wait*,
/// asked with whatever this poll learned about the budget. It is stamped onto
/// every view [`emit_view`] sends and is not otherwise looked at here: what to
/// do about a budget is decided in `cadence.rs`, and this only carries the
/// answer across, exactly as it carries every other one.
///
/// The return now carries what the read saw of the budget, which is the only
/// route those numbers have back into the loop that paces against them.
fn poll_once<R: Runtime>(app: &AppHandle<R>, watched: &Watched, ahead: &Ahead<'_>) -> Tick {
    let registry = app.state::<Registry>();
    let ambient = app.state::<Ambient>();
    let ledgers = app.state::<Ledgers>();
    let claims = app.state::<Claims>();
    let folder_id = watched.folder_id;

    // One place where a condition becomes a stamp, a floor and a tick, so the
    // three cannot come to disagree about what just happened. The `ahead` it
    // asks is asked with the tick it is about to return — which is what makes
    // a failure change the floor the view is emitted into rather than the one
    // after that.
    //
    // The snapshot goes out from in here rather than from each failing return,
    // for the reason the view already does: there are seven ways out of this
    // function and an emit spelled at each of them is an emit missing from one
    // of them. Both surfaces age together, from one condition and one sentence.
    let failed = |view: MapsView, reason: Degraded, why: String| -> Tick {
        let tick = Tick::Failed(Fault::of(&reason, epoch_seconds()));
        emit_view(app, view.stale(reason.clone(), why.clone()), ahead(tick));
        emit_snapshot(app, ledgers.aged(reason, why));
        tick
    };

    let (held, path) = {
        let store = match registry.store() {
            Ok(store) => store,
            Err(refusal) => {
                let (reason, why) = local_refusal(refusal);
                return failed(MapsView::nothing_read_yet(folder_id), reason, why);
            }
        };
        // Under the guard this block already holds, and before anything is
        // read: the baseline is the cache row as it stands now, and the read
        // below is about to overwrite it.
        ledgers.attend(&store, watched);
        let held = from_cache(&store, folder_id);

        let folder = match store.folders() {
            Ok(folders) => folders.into_iter().find(|folder| folder.id == folder_id),
            Err(refusal) => {
                let (reason, why) = local_refusal(refusal.to_string());
                return failed(held, reason, why);
            }
        };
        match folder {
            Some(folder) => (held, folder.path),
            None => {
                let (reason, why) = local_refusal(StoreError::UnknownFolder(folder_id).to_string());
                return failed(held, reason, why);
            }
        }
    };

    // A fact about a folder on this disk, established without a network — and
    // the store's own sentence for it, so a folder with no GitHub remote never
    // reads as a failure to reach GitHub.
    let repo = match perseverance_store::bind_repo(Path::new(&path)) {
        Ok(repo) => repo,
        Err(refusal) => {
            // Retryable, because a folder is renamed and a drive is plugged
            // back in — and the sentence is the store's, so *this folder names
            // no GitHub remote* is what reaches the screen.
            let (reason, why) = local_refusal(refusal.to_string());
            return failed(held, reason, why);
        }
    };

    let token = match ambient.token.get() {
        Some(TokenOutcome::Acquired(token)) => token,
        // The harvest has not settled, so `gh` has not been asked yet. Nothing
        // was attempted and nothing failed, so nothing is stamped: the copy
        // stays exactly as it was, with the age it already had. Reporting *no
        // token* here would be a Windows launch — 1.5 to 1.9 seconds of real
        // harvest — telling an operator they have never signed in.
        None => {
            emit_view(app, held, ahead(Tick::NotAttempted));
            // Re-emitted exactly as it stands. Nothing was attempted, so
            // nothing is stamped and nothing is compared: the ledger keeps the
            // rows it had and the snapshot keeps the age it had.
            emit_snapshot(app, ledgers.held());
            return Tick::NotAttempted;
        }
        // Never signed in, or the harvest was discarded so `gh` was never
        // looked for. Both leave a working app with no poller, which is a
        // sentence rather than a stack — and both stop rather than back off,
        // because the remedy is `gh auth login` and no amount of waiting is it.
        Some(_) => {
            return failed(
                held,
                ReadFailure::NoToken.degraded(),
                ReadFailure::NoToken.to_string(),
            );
        }
    };

    // The map the WebView is looking at, spent at last. `map-read.graphql`
    // `@include`s the graph only when a number is supplied, so this is the one
    // call that decides whether this tick has a model to derive at all — and
    // the ledger's only input is that model's diff.
    let fresh = match read_maps(token, &repo.owner, &repo.name, watched.map) {
        Ok(fresh) => fresh,
        // The one classification this function does not make itself. The crate
        // that held the socket is the one that saw the status, the header and
        // the `type`, and asking it is what keeps one taxonomy from becoming
        // two.
        Err(failure) => {
            return failed(held, failure.degraded(), failure.to_string());
        }
    };

    let view = MapsView::of(folder_id, fresh.read(), Source::Github, fresh.fetched_at());
    // The one return that learned something. Asked with the numbers this answer
    // carried rather than with the ones the last one did, which is what makes
    // the poll that lands at the reset stop saying the poller is yielding.
    let paced_by = ahead(Tick::Read(fresh.budget()));
    // A cache the registry declined to write is not a read that did not happen:
    // the answer is on screen either way, the store's refusal is what the stamp
    // then carries, and the tick still counts as a read — the backoff counts
    // failures to reach GitHub, and this was not one. So the condition beside
    // that refusal is `Unreachable` and the tick is still `Read`: the stamp
    // says the copy will not survive the session, and nothing backs off.
    let stored = match registry.store() {
        Ok(store) => remember_read(&store, folder_id, watched.map, &fresh)
            .map_err(|refusal| refusal.to_string()),
        Err(refusal) => Err(refusal),
    };
    match stored {
        Ok(()) => emit_view(app, view, paced_by),
        Err(refusal) => {
            let (reason, why) = local_refusal(refusal);
            emit_view(app, view.stale(reason, why), paced_by)
        }
    }
    // The one derivation this process takes, and the ledger's only input. It is
    // taken from the answer rather than from the row that answer was written
    // to, so a cache the registry declined to write changes what survives the
    // session and nothing about what is on screen: the graph came from GitHub
    // either way, and the stamp beside the map list is where that refusal is
    // already reported.
    let snapshot = ledgers.observed(
        Model::of(fresh.read(), Machine::host()),
        fresh.fetched_at(),
        &claims.originated(),
    );
    // The ledger's lock is already released and the registry's is never taken:
    // this is a write to one small table, and the half of an ending the poller
    // owns. `Terminals::noticed` is where the latch is argued and where the
    // promise that a close touches no terminal is kept.
    if let Some(terminals) = app.try_state::<Terminals>() {
        terminals.noticed(&path, &snapshot.model);
    }
    emit_snapshot(app, snapshot);
    // What this answer said about the budget, anchored to when it landed. The
    // loop ages it against its own last tick; nothing here interprets it.
    Tick::Read(fresh.budget())
}

/// What the WebView is looking at, told to the poller.
///
/// Both the poke and the answer to *what should be read*: nothing on the Rust
/// side has ever known which folder is selected, because until now the only
/// thing that triggered a read was a command that was handed the id. `None` is
/// the launcher with nothing picked, and it is the state whose ladder floor is
/// *never* — a poller that kept reading a folder you closed would be spending
/// the budget on a screen nobody is looking at.
#[tauri::command]
fn watching(poker: State<'_, Poker>, folder_id: Option<i64>, map: Option<u64>) {
    poker.poke(Poke::Watching(
        folder_id.map(|folder_id| Watched { folder_id, map }),
    ));
}

/* ------------------------------------------------------------ registry --- */

/// One global registry, in the directory the OS keeps application data in, so
/// that the list of folders lives outside every folder it lists.
const REGISTRY_FILE: &str = "perseverance.db";

/// The registry as the shell holds it: opened once, at startup.
///
/// Opened once rather than per command because a connection carries the
/// write-ahead log and the busy timeout the store configured, and reopening
/// would throw both away on every click.
///
/// A refusal to open is *kept* rather than fatal. The store refuses a file
/// stamped with a schema version this build does not speak, and the window
/// still has to come up to say so — a launcher that cannot explain itself is
/// worse than one with no list.
struct Registry {
    opened: Result<Mutex<Store>, String>,
}

impl Registry {
    fn open(app: &AppHandle) -> Registry {
        Registry {
            opened: open_registry(app),
        }
    }

    /// The store, or the store's own refusal in its own words. Nothing here
    /// composes a message; the sentence the WebView renders was written by the
    /// crate that decided to refuse.
    fn store(&self) -> Result<MutexGuard<'_, Store>, String> {
        match &self.opened {
            // A poisoned lock means an earlier command panicked mid-statement.
            // The file is not the thing that panicked, so the guard is taken
            // back rather than the rest of the session being written off.
            Ok(store) => Ok(store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())),
            Err(refusal) => Err(refusal.clone()),
        }
    }
}

/// Seconds since the Unix epoch, saturating at zero for a clock set before
/// 1970 — the same shape `read.rs` and the registry both take, and for the same
/// reason: a stamp that is nonsense is not worth a crash.
///
/// The one clock reading this crate takes. [`Fault::of`] needs it because
/// `cadence.rs` deliberately has none, and this is the wiring layer that does.
fn epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/// `app_data_dir()/perseverance.db`. The store creates the directory if it is
/// not there yet, so this resolves a path and hands it over.
fn open_registry(app: &AppHandle) -> Result<Mutex<Store>, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    Store::open(&dir.join(REGISTRY_FILE))
        .map(Mutex::new)
        .map_err(|error| error.to_string())
}

/* -------------------------------------------------------- the launcher --- */

/// One row of the launcher list, as the WebView receives it.
///
/// This is [`Folder`] plus the two things the store answers on demand rather
/// than storing — the display name and whether the path is still on this
/// machine. Both are asked of the store; neither is worked out here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    id: i64,
    path: String,
    name: String,
    adapter: Option<String>,
    last_opened: i64,
    present: bool,
}

impl From<Folder> for FolderEntry {
    fn from(folder: Folder) -> FolderEntry {
        FolderEntry {
            id: folder.id,
            name: folder.display_name(),
            present: folder.is_present(),
            path: folder.path,
            adapter: folder.adapter,
            last_opened: folder.last_opened,
        }
    }
}

#[derive(Debug, Serialize)]
struct LauncherView {
    folders: Vec<FolderEntry>,
}

/// The folder list, whole, in one call.
///
/// Nothing is filtered: a folder whose path has gone missing is still a folder
/// you opened, and the launcher greys it rather than the shell hiding it.
#[tauri::command]
fn launcher(registry: State<'_, Registry>) -> Result<LauncherView, String> {
    let store = registry.store()?;
    let folders = store.folders().map_err(|error| error.to_string())?;

    Ok(LauncherView {
        folders: folders.into_iter().map(FolderEntry::from).collect(),
    })
}

#[tauri::command]
fn remember_folder(registry: State<'_, Registry>, path: String) -> Result<FolderEntry, String> {
    let store = registry.store()?;

    store
        .remember_folder(Path::new(&path))
        .map(FolderEntry::from)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn forget_folder(registry: State<'_, Registry>, id: i64) -> Result<(), String> {
    let store = registry.store()?;

    store.forget_folder(id).map_err(|error| error.to_string())
}

/// Re-points a folder. The id crosses unchanged in both directions, which is
/// what carries that folder's layout and cache through a move.
#[tauri::command]
fn relocate_folder(
    registry: State<'_, Registry>,
    id: i64,
    path: String,
) -> Result<FolderEntry, String> {
    let store = registry.store()?;

    store
        .relocate_folder(id, Path::new(&path))
        .map(FolderEntry::from)
        .map_err(|error| error.to_string())
}

/* ---------------------------------------------------------------- repo --- */

/// `owner/repo`, or which of the three local facts stopped it being derived.
///
/// A tagged union rather than a rejected call, because none of the three is an
/// error the shell is having — they are things that are true of a folder, and
/// the launcher has a sentence for each. Keeping them apart from a rejection is
/// what keeps them apart from "cannot reach GitHub" in the reading.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RepoBinding {
    Bound { owner: String, name: String },
    NotAGitRepo,
    NoGitHubRemote,
    AmbiguousRemotes { candidates: Vec<String> },
}

/// One refusal, one tag. The store decides which of the three a folder is; this
/// only says how it is spelled on the wire.
impl From<RepoBindingError> for RepoBinding {
    fn from(refusal: RepoBindingError) -> RepoBinding {
        match refusal {
            RepoBindingError::NotAGitRepo => RepoBinding::NotAGitRepo,
            RepoBindingError::NoGitHubRemote => RepoBinding::NoGitHubRemote,
            RepoBindingError::AmbiguousRemotes { candidates } => {
                RepoBinding::AmbiguousRemotes { candidates }
            }
        }
    }
}

/// Derived from the folder's git remote every time it is asked for, and stored
/// nowhere — which is why a repository renamed on GitHub cannot rot a row.
#[tauri::command]
fn bind_repo(path: String) -> RepoBinding {
    match perseverance_store::bind_repo(Path::new(&path)) {
        Ok(repo) => RepoBinding::Bound {
            owner: repo.owner,
            name: repo.name,
        },
        Err(refusal) => refusal.into(),
    }
}

/* -------------------------------------------------------------- picker --- */

/// Where a new path comes from, for *Open a new folder* and for *Locate…*.
///
/// The picker is answered on this side because a path is the only thing the
/// WebView needs from it: the frontend never has to be handed a file-system
/// permission for a folder to be named. Declining is `None` rather than an
/// error — changing your mind about a folder is not a failure, and the list is
/// left exactly as it was.
///
/// `(async)` is load-bearing. A command without it runs on the main thread, and
/// a blocking picker there would be waiting on the very thread that has to draw
/// the dialog.
#[tauri::command(async)]
fn choose_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Open a folder")
        .blocking_pick_folder()
        .map(|folder| folder.to_string())
}

/* --------------------------------------------------------- environment --- */

/// The harvest, the token it bought, and the readout, for the life of this
/// process.
///
/// Re-taken every launch and held nowhere else: there is no [`Store`] call on
/// this path and no file. The two [`OnceLock`]s are what make *once per launch*
/// structural rather than scheduled — whatever else happens, the environment
/// this process is running in cannot be replaced under it half-way through.
struct Ambient {
    readout: Mutex<EnvironmentReadout>,
    environment: OnceLock<Environment>,
    token: OnceLock<TokenOutcome>,
    /// Who this operator is on GitHub, asked beside the token and never carried
    /// with it — see [`perseverance_github::read_login`], which argues both
    /// halves of that. `None` is *this run does not know*, and the one thing
    /// that needs it refuses rather than guessing.
    ///
    /// **Filled on first need and not at launch.** It is a network round trip
    /// and the readout is not waiting on it: settling ahead of the `environment`
    /// event and the `EnvironmentSettled` poke would put up to a whole
    /// [`Bounds::for_this_machine`] between a launch and its first list, for a
    /// value only a press reads. The `OnceLock` is what makes a *learned* login
    /// once per launch — the first press to reach [`spawn_at`] that gets an
    /// answer seeds it, and every press after reads what that one learned.
    ///
    /// **Only a success is remembered**, which is why this holds a `String` and
    /// not the `Option<String>` [`perseverance_github::read_login`] answers
    /// with. Every way that read can fail — a DNS blip, a TLS reset, a timeout,
    /// a 502, a 429 — comes back as the same `None`, and a `None` written into a
    /// cell that fills once would make one cold network at one unlucky moment
    /// the answer this process gives every press for the rest of its life, with
    /// no way to ask again short of a restart nothing tells the operator to
    /// perform. So a press that learned nothing leaves the cell empty and the
    /// next press asks again; [`remembered_login`] is where that rule lives.
    login: OnceLock<String>,
}

impl Ambient {
    /// Seeded with the one state the WebView has to be able to draw before
    /// anything is known, because the window is already open by the time the
    /// shell is asked anything.
    fn harvesting() -> Ambient {
        Ambient {
            readout: Mutex::new(EnvironmentReadout::harvesting()),
            environment: OnceLock::new(),
            token: OnceLock::new(),
            login: OnceLock::new(),
        }
    }

    /// The command's whole body: a read, never a derivation.
    fn settled(&self) -> EnvironmentReadout {
        self.readout
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// The launch order, as one function rather than a comment.
///
/// Harvest, then ask `gh` inside whatever that produced, then settle. The two
/// steps are taken as closures so a test can assert that the token step received
/// the *harvested* environment rather than this process's own, and that each ran
/// exactly once — which is the whole of acceptance criterion 4's "once per
/// launch" and criterion 5's "inside the harvested environment" at this layer.
///
/// A discarded harvest does not go on to ask: `gh` was never looked for, and not
/// looking is a different fact from looking and not finding.
fn settle_into(
    ambient: &Ambient,
    take: impl FnOnce() -> HarvestAttempt,
    ask: impl FnOnce(&Environment) -> TokenOutcome,
) -> EnvironmentReadout {
    let attempt = take();
    let taken = &attempt.outcome;
    // Read out of the stream before anything decides what became of the
    // harvest, because the two are independent: an interpreter that declined
    // the operator's profile still frames, still closes and still exits 0.
    let degradation = DegradationState::from(degradation_in(&attempt.stderr));

    let environment = ambient.environment.get_or_init(|| match taken {
        Ok(harvest) => harvest.environment.clone(),
        // On a macOS bundle this is the launchd stub the harvest exists to leave
        // behind, and it is why a discarded harvest is survivable rather than
        // fatal: the app opens on what it was started with.
        Err(_) => Environment::inherited(),
    });

    let outcome = match taken {
        Ok(_) => ask(environment),
        Err(_) => TokenOutcome::NotAttempted,
    };
    let token = ambient.token.get_or_init(|| outcome);
    // And the login is *not* asked here. It is a second GitHub round trip, it
    // reaches no readout — a login is a coordinate a prompt carries, not a
    // state the WebView draws — and the readout below plus the poke that
    // follows it are what a launch is waiting on. [`Ambient::login`] is filled
    // on the first press that needs it instead.

    let path = environment.path().map(|path| path.into_owned());
    let readout = EnvironmentReadout {
        harvest: match taken {
            Ok(_) => HarvestState::Harvested,
            // The crate's own sentence, unedited. It names both possibilities
            // where there are two, and this layer is not the place to pick one.
            Err(condition) => HarvestState::Inherited {
                detail: condition.to_string(),
            },
        },
        // The shell that actually ran, on both paths, rather than the choice
        // this machine would make if it were asked a second time. Criterion 7
        // asks for the shell that was used, and a harvest that failed is when
        // an operator most needs to be told which one it was. `None` here is
        // the one case where nothing ran at all.
        shell: match &attempt.shell {
            Some(shell) => WireShell::from(shell),
            None => WireShell::None,
        },
        path_source: match (taken, &path) {
            (_, None) => PathSource::None,
            (Ok(_), Some(_)) => PathSource::Harvest,
            (Err(_), Some(_)) => PathSource::Inherited,
        },
        path,
        variable_count: environment.len(),
        // The run's own measurement rather than this thread's: it is spawn to
        // closing mark, which is the wait, and it is zero on the conditions
        // that are decided before anything is spawned.
        elapsed_ms: attempt.elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        tally: WireTally::from(
            taken
                .as_ref()
                .map(|harvest| harvest.tally)
                .unwrap_or_default(),
        ),
        // On both paths, because a discarded harvest is exactly when what the
        // shell wrote is the only account of itself there is — and reporting
        // an empty stream for a discarded one would read as a shell that said
        // nothing at all.
        stderr: WireStderr::from(&attempt.stderr),
        degradation,
        token: TokenState::from(token),
    };

    *ambient
        .readout
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = readout.clone();
    readout
}

/// One named thread, and `setup` returns.
///
/// The harvest cannot be a precondition for window paint: macOS's 187 ms hides
/// behind it and Windows's 1.5–1.9 s does not, and a design that is correct only
/// on the fast platform is not correct. Nothing here is async, because a runtime
/// for one blocking read that happens once a launch would be a scheduler
/// acquired to do what a thread already does.
fn start_harvesting(app: AppHandle) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("perseverance-environment".to_string())
        .spawn(move || {
            let readout = settle_into(
                app.state::<Ambient>().inner(),
                perseverance_env::harvest,
                acquire_token,
            );
            // Nobody listening is not a failure. The readout is in `Ambient`
            // either way and the WebView asks as well as subscribing, because a
            // fast harvest can settle before there is a WebView to hear it.
            let _ = app.emit("environment", &readout);
            // And the token this just bought is what the poller was missing. A
            // Windows launch spends 1.5–1.9 s here; without this poke its first
            // tick reports *nothing attempted* and the second one is a whole
            // rung away, so the first list anybody sees is a minute late.
            if let Some(poker) = app.try_state::<Poker>() {
                poker.poke(Poke::EnvironmentSettled);
            }
        })
        .map(|_| ())
}

/// What the harvest came to, and what became of the environment either way.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum HarvestState {
    /// The state that exists because the harvest is off the launch path. It is
    /// not a failure and must not read as one.
    Harvesting,
    Harvested,
    /// Carries the condition's own words, so the sentence an operator reads was
    /// written by the crate that decided to discard.
    Inherited {
        detail: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireShell {
    LoginShell { program: String, flags: Vec<String> },
    PowerShell { program: String, flags: Vec<String> },
    None,
}

/// The flags cross as they were sent. `-lic` is one argument and shows as one,
/// because a readout that tidied it into three would be showing an argv the
/// child was never given.
impl From<&Shell> for WireShell {
    fn from(shell: &Shell) -> WireShell {
        let program = shell.program().to_string();
        let flags = shell.flags();
        match shell {
            Shell::LoginShell { .. } => WireShell::LoginShell { program, flags },
            Shell::PowerShell { .. } => WireShell::PowerShell { program, flags },
        }
    }
}

/// Whether the `PATH` above it came from the shell or from the launcher.
///
/// Beside the verbatim `PATH` this is what lets an operator notice a harvest
/// that succeeded and returned nothing worth having — the four-directory stub
/// under `harvest` is the shape of a silent degradation.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PathSource {
    Harvest,
    Inherited,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireTally {
    records_seen: usize,
    records_dropped: usize,
    duplicates_dropped: usize,
    bytes_before_frame: usize,
    bytes_after_frame: usize,
    extra_opening_marks: usize,
}

impl From<Tally> for WireTally {
    fn from(tally: Tally) -> WireTally {
        WireTally {
            records_seen: tally.records_seen,
            records_dropped: tally.records_dropped,
            duplicates_dropped: tally.duplicates_dropped,
            bytes_before_frame: tally.bytes_before_frame,
            bytes_after_frame: tally.bytes_after_frame,
            extra_opening_marks: tally.extra_opening_marks,
        }
    }
}

/// What the shell wrote, verbatim, with its classification beside it and never
/// instead of it. Non-empty is not an error on Windows, where the stream carries
/// a 616-byte baseline with no profile at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireStderr {
    kind: WireStderrKind,
    bytes: usize,
    text: String,
}

impl From<&Stderr> for WireStderr {
    fn from(stderr: &Stderr) -> WireStderr {
        WireStderr {
            kind: match stderr.kind {
                StderrKind::Empty => WireStderrKind::Empty,
                StderrKind::Text => WireStderrKind::Text,
                StderrKind::Clixml => WireStderrKind::Clixml,
            },
            bytes: stderr.bytes,
            text: stderr.text.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum WireStderrKind {
    Empty,
    Text,
    Clixml,
}

/// The outcome only. It never carries the value, and there is no field it could
/// be put in — which is what makes "the token is never stored" a claim with
/// something on screen to check it against.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TokenState {
    Acquired,
    NotAttempted,
    Refused { detail: String },
}

impl From<&TokenOutcome> for TokenState {
    fn from(outcome: &TokenOutcome) -> TokenState {
        match outcome {
            TokenOutcome::Acquired(_) => TokenState::Acquired,
            TokenOutcome::NotAttempted => TokenState::NotAttempted,
            TokenOutcome::Refused(refusal) => TokenState::Refused {
                detail: refusal.to_string(),
            },
        }
    }
}

/// What the interpreter said about itself on its way to a clean-looking answer.
///
/// A degradation is not a [`HarvestState`] and cannot become one: the harvest
/// succeeded — exit 0, both marks, a plausible environment — and the only
/// artifact is a sentence in a stream whose Windows baseline is never empty. So
/// this is a separate field rather than a fourth harvest tag, and it is read by
/// content in `perseverance_env::degradation_in` rather than decided here.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DegradationState {
    /// Nothing nameable was said. Which is *not* the same as nothing having
    /// happened: an interpreter that declines silently, or in a language this
    /// does not read, lands here too.
    NotSeen,
    ProfileRefused,
}

impl From<Option<Degradation>> for DegradationState {
    fn from(named: Option<Degradation>) -> DegradationState {
        match named {
            None => DegradationState::NotSeen,
            Some(Degradation::ProfileRefused) => DegradationState::ProfileRefused,
        }
    }
}

/// Everything the diagnostics surface shows, in one value.
///
/// The environment itself has exactly one exit from Rust and this is it: ten
/// keys, none of which is a variable. `src/environment/environment.ts` is a
/// hand-written mirror of this, so a rename here is a silent breakage there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReadout {
    harvest: HarvestState,
    shell: WireShell,
    /// Verbatim and never split. The separator is a guess, and an entry
    /// containing the separator is precisely where the guess misleads; the
    /// WebView splits it for display and says that it did.
    path: Option<String>,
    path_source: PathSource,
    variable_count: usize,
    elapsed_ms: u64,
    tally: WireTally,
    stderr: WireStderr,
    degradation: DegradationState,
    token: TokenState,
}

impl EnvironmentReadout {
    fn harvesting() -> EnvironmentReadout {
        EnvironmentReadout {
            harvest: HarvestState::Harvesting,
            shell: WireShell::None,
            path: None,
            path_source: PathSource::None,
            variable_count: 0,
            elapsed_ms: 0,
            tally: WireTally::from(Tally::default()),
            // No shell has been asked yet, so nothing has been written: empty
            // here is the fact, and there is no state in this file that spells
            // *empty* for a stream it merely failed to keep.
            stderr: WireStderr {
                kind: WireStderrKind::Empty,
                bytes: 0,
                text: String::new(),
            },
            // Nothing has been said, because nothing has been asked. The tag
            // means the same thing here as it does after a harvest that said
            // nothing, and that ambiguity is the honest half of it.
            degradation: DegradationState::NotSeen,
            token: TokenState::NotAttempted,
        }
    }
}

/// The readout. Never a rejection: by the time this can be asked for the window
/// is already open, and a harvest that failed is a condition rather than
/// something the shell is having. The return type has no `Result` in it, so
/// acceptance criterion 6 is a compile-time fact rather than a test.
#[tauri::command]
fn environment(ambient: State<'_, Ambient>) -> EnvironmentReadout {
    ambient.settled()
}

/* ------------------------------------------------- per-folder resolution --- */

/*
 * Resolution has two tiers and no third one: the folder's own harvested
 * environment, and an explicit override the operator typed. There is no
 * install-location probing anywhere below, and `scripts/check-no-install-probing.mjs`
 * scans this file for the vocabulary of one. `docs/adr/0011` records why: the
 * failure mode of guessing at directories is not incompleteness but *divergence*
 * from what the operator's own shell resolves, and a silently wrong binary beats
 * a loud not-found in exactly the wrong direction.
 */

/// Where the app-global override is kept: one row of the same `app` key/value
/// table `default_adapter` already lives in.
///
/// App-global and deliberately not `folders.adapter`, which is per folder. The
/// composition rule is what makes one row enough: `argv[0]` is resolved against
/// each folder's environment, so a bare name follows that folder's pin and a
/// path pins the machine — the operator picks the scope by what they type, and
/// one stored vector expresses both.
const OVERRIDE_KEY: &str = "agent_override";

/// The override as it was written down, or nothing at all.
///
/// A cell that is not a JSON array of strings — or is one with nothing usable in
/// it — reads as *no override* rather than as a failure. This is asked on every
/// folder open, and a launcher held shut by a malformed preference row would be
/// the opposite of criterion 9.
fn stored_override(store: &Store) -> Option<Override> {
    let written = store.get_app(OVERRIDE_KEY).ok().flatten()?;
    let argv: Vec<String> = serde_json::from_str(&written).ok()?;
    Override::from_argv(argv.into_iter().map(OsString::from).collect()).ok()
}

/// Written as JSON here rather than in the store.
///
/// `perseverance-store` has no `serde_json` and gains none for a preference: the
/// `app` table is text, and what an argv vector means is the harness's business.
/// No schema change and no migration — `STORE_SCHEMA_VERSION` is untouched.
fn remember_override(store: &Store, argv: &[String]) -> Result<(), String> {
    let written = serde_json::to_string(argv).map_err(|error| error.to_string())?;
    store
        .set_app(OVERRIDE_KEY, &written)
        .map_err(|error| error.to_string())
}

/// The stored override, or none — including when the registry itself would not
/// open, because a folder still has to resolve on a build that cannot read its
/// own preferences.
fn remembered_override(registry: &Registry) -> Option<Override> {
    let store = registry.store().ok()?;
    stored_override(&store)
}

/// Which adapter resolved to what, and what its declared probes answered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterReading {
    id: String,
    resolution: WireResolution,
    probes: Vec<WireProbeReading>,
}

/// The **absolute path** is the headline fact, because it is the only visible
/// form a version pin has: a bare name that follows a pin resolves to a
/// different absolute path in two folders, and that difference is what says
/// which interpreter this folder is about to run under.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireResolution {
    Resolved {
        name: String,
        program: String,
        from: WireOrigin,
    },
    /// Only the names tried. The shell used, the harvest's outcome and the
    /// verbatim `PATH` are top-level on the same [`FolderReadout`] — one home
    /// per fact, so the error surface assembles all four from one value and
    /// there is no second copy to drift.
    NotFound { names: Vec<String> },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum WireOrigin {
    Candidate,
    Override,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireProbeReading {
    program: String,
    args: Vec<String>,
    outcome: WireProbeOutcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireProbeOutcome {
    Answered { status: Option<i32>, line: String },
    NotOnThisPath,
    DidNotRun { detail: String },
}

/// What the override is doing to this reading, in four states.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireOverride {
    None,
    InUse {
        argv: Vec<String>,
        scope: WireScope,
    },
    /// The store declined to write it down. It is **still in force for this
    /// run**: an operator who has just typed something that works should not be
    /// told it did not, on the strength of a preferences file.
    NotRemembered {
        argv: Vec<String>,
        detail: String,
    },
    /// Decidable from the vector alone, in the crate's own words. Nothing
    /// changed, so whatever was stored before is still what resolved.
    Refused {
        detail: String,
    },
}

/// Which of the two scopes the operator chose by what they typed.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum WireScope {
    FollowsTheFolder,
    PinnedGlobally,
}

/// Everything one folder's resolution came to, in one value. Twelve keys.
///
/// `src/environment/folder.ts` is a hand-written mirror of this, on the same
/// terms as the app-global readout: both sides count the keys, because a rename
/// on either is silent on the other.
///
/// No `tally` here. The frame's counts are a property of a *harvest*, and the
/// app-global panel already shows them for the harvest that settled this
/// process; a second set per folder would be four more numbers for a question
/// nobody asks per folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderReadout {
    /// The path as it was asked for, unchanged — so the operator can see that
    /// what they picked and what the child was given are the same directory,
    /// or that they are not.
    folder: String,
    /// The absolute, canonicalised directory the child was given, which is also
    /// the key this folder's harvest is kept on.
    spawn_directory: String,
    harvest: HarvestState,
    shell: WireShell,
    /// Verbatim and never split. This is the folder's own `PATH`, which is the
    /// whole point: it is what makes `claude: not found` falsifiable against
    /// your own terminal.
    path: Option<String>,
    path_source: PathSource,
    variable_count: usize,
    elapsed_ms: u64,
    stderr: WireStderr,
    degradation: DegradationState,
    adapters: Vec<AdapterReading>,
    r#override: WireOverride,
}

/// One folder, resolved.
///
/// Not a command, so it can be driven by a test with a harvest that never ran a
/// shell — the seam `settle_into` is for the app-global path. The steps are:
/// the folder's environment (harvested once and kept, or harvested again when
/// the operator says so), then every registered adapter resolved *in* that
/// environment, then its declared probes run in it.
///
/// This is the first consumer of `perseverance_agent::agent` and of
/// `Agent::discovery` anywhere in the tree.
fn read_folder(
    harvests: &Harvests,
    stored: Option<Override>,
    folder: &str,
    again: bool,
) -> FolderReadout {
    let asked = Path::new(folder);
    // Re-harvest *before* re-resolving, which is the whole of the operator's
    // retry: an answer re-read from the map would be the same stale answer,
    // faster.
    let settled = if again {
        harvests.again_in_folder(asked)
    } else {
        harvests.in_folder(asked)
    };

    let path = settled.environment.path().map(|path| path.into_owned());
    FolderReadout {
        folder: folder.to_string(),
        spawn_directory: settled.spawn_directory.to_string_lossy().into_owned(),
        harvest: match &settled.condition {
            None => HarvestState::Harvested,
            // The crate's own sentence, unedited.
            Some(condition) => HarvestState::Inherited {
                detail: condition.to_string(),
            },
        },
        shell: match &settled.shell {
            Some(shell) => WireShell::from(shell),
            None => WireShell::None,
        },
        path_source: match (settled.from_harvest, &path) {
            (_, None) => PathSource::None,
            (true, Some(_)) => PathSource::Harvest,
            (false, Some(_)) => PathSource::Inherited,
        },
        path,
        variable_count: settled.environment.len(),
        elapsed_ms: settled.elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        stderr: WireStderr::from(&settled.stderr),
        degradation: DegradationState::from(settled.degradation),
        adapters: adapters_in(&settled, stored.as_ref()),
        r#override: wire_override(stored.as_ref()),
    }
}

/// Every registered adapter, resolved in this folder's environment.
fn adapters_in(settled: &FolderEnvironment, chosen: Option<&Override>) -> Vec<AdapterReading> {
    // The directory the child was given, in the spelling a child can be given:
    // the key keeps Windows' verbatim prefix and `Command::current_dir` is not
    // known to take it.
    let directory = spawnable_form(&settled.spawn_directory);
    let bounds = Bounds::for_this_machine();

    AgentId::ALL
        .iter()
        .map(|id| {
            let declared = agent(*id).discovery();
            AdapterReading {
                id: id.as_str().to_string(),
                resolution: match chosen {
                    // One composition rule: `argv[0]` is resolved against the
                    // folder's environment, exactly as a candidate is. Nothing
                    // here re-implements the bare-name-versus-path decision —
                    // `Environment::resolve` has always made it.
                    Some(chosen) => resolved_under(
                        &settled.environment,
                        &chosen.program().to_string_lossy(),
                        WireOrigin::Override,
                    ),
                    None => match locate_in(&settled.environment, declared.candidates) {
                        Located::Found(found) => WireResolution::Resolved {
                            name: found.name,
                            program: found.program.to_string_lossy().into_owned(),
                            from: WireOrigin::Candidate,
                        },
                        Located::NotFound(missing) => WireResolution::NotFound {
                            names: missing.names,
                        },
                    },
                },
                // Per platform by type rather than by a tag every caller has to
                // remember to filter on: a probe run on the wrong platform is a
                // reading of nothing presented as a reading of something.
                probes: declared
                    .probes
                    .on(Platform::host())
                    .iter()
                    .map(|probe| {
                        let reading = probe_in(
                            &settled.environment,
                            &directory,
                            probe.program,
                            probe.args,
                            &bounds,
                        );
                        WireProbeReading {
                            program: reading.program,
                            args: reading.args,
                            outcome: match reading.outcome {
                                ProbeOutcome::Answered { status, line } => {
                                    WireProbeOutcome::Answered { status, line }
                                }
                                ProbeOutcome::NotOnThisPath => WireProbeOutcome::NotOnThisPath,
                                ProbeOutcome::DidNotRun { detail } => {
                                    WireProbeOutcome::DidNotRun { detail }
                                }
                            },
                        }
                    })
                    .collect(),
            }
        })
        .collect()
}

/// One name, resolved against one environment. The only resolver in the tree.
fn resolved_under(environment: &Environment, named: &str, from: WireOrigin) -> WireResolution {
    match environment.resolve(named) {
        Some(program) => WireResolution::Resolved {
            name: named.to_string(),
            program: program.to_string_lossy().into_owned(),
            from,
        },
        None => WireResolution::NotFound {
            names: vec![named.to_string()],
        },
    }
}

/// The override, as the surface shows it back. The scope is named rather than
/// decided: `Environment::resolve` already behaves both ways, and
/// [`Scope`] only says which of the two the typed vector picked.
fn wire_override(chosen: Option<&Override>) -> WireOverride {
    match chosen {
        None => WireOverride::None,
        Some(chosen) => WireOverride::InUse {
            argv: argv_of(chosen),
            scope: match chosen.scope(Platform::host()) {
                Scope::FollowsTheFolder => WireScope::FollowsTheFolder,
                Scope::PinnedGlobally => WireScope::PinnedGlobally,
            },
        },
    }
}

fn argv_of(chosen: &Override) -> Vec<String> {
    chosen
        .argv()
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect()
}

/*
 * None of the four below returns a `Result`, which is how "a missing CLI never
 * blocks the folder from opening" stays a compile-time fact rather than a test —
 * the same trick the `environment` command already uses. A folder whose adapter
 * is nowhere on its `PATH` produces a readout saying so; it cannot produce a
 * rejected call for the frontend to treat as a failure to open.
 *
 * `(async)` is load-bearing on every one of them, for the reason `choose_folder`
 * has it: a command without it runs on the main thread, and a Windows harvest is
 * bounded at 20 s.
 */

#[tauri::command(async)]
fn folder_environment(
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    path: String,
) -> FolderReadout {
    read_folder(&harvests, remembered_override(&registry), &path, false)
}

/// The operator's explicit retry, and the only thing that forgets.
///
/// Re-harvests *then* re-resolves. There is no clock and no watcher behind this:
/// the dangerous case is a pin that has not changed while the installed set has,
/// which no watcher over the folder can see.
#[tauri::command(async)]
fn retry_folder_environment(
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    path: String,
) -> FolderReadout {
    read_folder(&harvests, remembered_override(&registry), &path, true)
}

/// Sets the override and re-resolves against the environment already in hand.
///
/// Deliberately **not** a re-harvest: an override is a different answer to
/// *which program*, not a claim that the folder's environment has changed, and
/// running the operator's start-up files again to answer it would be a second
/// login shell for a question the first one already answered.
#[tauri::command(async)]
fn use_override(
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    path: String,
    argv: Vec<String>,
) -> FolderReadout {
    let chosen = Override::from_argv(argv.iter().map(OsString::from).collect());

    match chosen {
        Err(refusal) => {
            let mut readout = read_folder(&harvests, remembered_override(&registry), &path, false);
            // The crate's own sentence, unedited; nothing is composed here.
            readout.r#override = WireOverride::Refused {
                detail: refusal.to_string(),
            };
            readout
        }
        Ok(chosen) => {
            let wrote = match registry.store() {
                Ok(store) => remember_override(&store, &argv),
                Err(refusal) => Err(refusal),
            };
            let mut readout = read_folder(&harvests, Some(chosen), &path, false);
            if let Err(detail) = wrote {
                readout.r#override = WireOverride::NotRemembered { argv, detail };
            }
            readout
        }
    }
}

/// Puts the override back to nothing.
///
/// Written as an empty vector rather than deleted, because the store has no
/// delete and does not need one: [`stored_override`] reads an empty vector as
/// *no override*, which is the same reading it gives a row that was never
/// written.
#[tauri::command(async)]
fn clear_override(
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    path: String,
) -> FolderReadout {
    if let Ok(store) = registry.store() {
        // A store that would not take it leaves the override where it was, and
        // the readout below says what actually resolved either way.
        let _ = remember_override(&store, &[]);
    }
    read_folder(&harvests, remembered_override(&registry), &path, false)
}

/* ------------------------------------------------------------ terminals --- */

/// Every live run, and the one place bytes leave this process for a terminal.
///
/// The registry itself is [`perseverance_pty::Runs`] and every decision in it is
/// that crate's — which run bytes cross for, what may be sent, whether a gesture
/// is a resize. What is held here is the wiring: the lock, and the sink the
/// WebView registered.
pub struct Terminals {
    runs: Mutex<Runs>,
    /// Where the monitored run's bytes go, once the WebView has said where that
    /// is. One sink for the app rather than one per run, because there is one
    /// monitored run and a second sink would be a second thing entitled to
    /// disagree about which.
    bytes: Mutex<Option<Channel<InvokeResponseBody>>>,
    /// What each run is working on, beside the registry rather than in it.
    ///
    /// A side table because [`perseverance_pty::Runs`] carries a [`RunId`] and
    /// nothing else, deliberately: a ticket number, a folder and a run's kind
    /// are product knowledge, and the byte scan at the bottom of this file
    /// exists to keep that crate from acquiring any. So the join happens here,
    /// where the product vocabulary already lives, and a run whose stakes were
    /// never recorded is still a live run — [`what_it_loses`] says so rather
    /// than leaving it out.
    stakes: Mutex<BTreeMap<RunId, Stakes>>,
    /// The poller's count of live runs, one handle per child, held here for the
    /// same reason the stakes are: `crates/pty` knows a [`RunId`] and nothing
    /// about cadence, and [`perseverance_github::RunHandle`] is not `Clone`
    /// precisely so that *a run is live exactly while something holds it* is a
    /// property of the type. This table is that something, and dropping a row
    /// is the only thing that sends `Poke::RunExited`.
    live: Mutex<BTreeMap<RunId, RunHandle>>,
    /// The last state each run's ticket was seen in, which is the poller's half
    /// of [`Ending`] — and the half that has to be *remembered*, because the
    /// readout that renders it runs three times a second and a poll lands every
    /// ten seconds at best.
    ///
    /// Written only by [`Terminals::noticed`], which is where the latch and the
    /// absences are argued. Its own table rather than a field beside the stakes,
    /// for the reason the handles are: these are written by the poller's thread
    /// and read by the readouts', and the stakes are written once by a press and
    /// read by a quit. Four small mutexes taken one after another cost less than
    /// one that every one of those has to queue on.
    resolution: Mutex<BTreeMap<RunId, NodeState>>,
}

impl Terminals {
    pub fn new() -> Terminals {
        Terminals {
            runs: Mutex::new(Runs::new()),
            bytes: Mutex::new(None),
            stakes: Mutex::new(BTreeMap::new()),
            live: Mutex::new(BTreeMap::new()),
            resolution: Mutex::new(BTreeMap::new()),
        }
    }

    /// A poisoned lock means an earlier frame panicked. The runs are not the
    /// thing that panicked, and writing them off would leave live children with
    /// nothing holding them — the posture [`Registry::store`] takes, with more
    /// at stake.
    fn held(&self) -> MutexGuard<'_, Runs> {
        self.runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn sink(&self) -> MutexGuard<'_, Option<Channel<InvokeResponseBody>>> {
        self.bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn staked_here(&self) -> MutexGuard<'_, BTreeMap<RunId, Stakes>> {
        self.stakes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// This run is working on that ticket, in that folder, on those terms.
    ///
    /// No caller in the shipped app today, and honestly so: nothing in this
    /// workspace opens a run yet — [`perseverance_pty::Runs::open`] is reached
    /// only from a test — so the table is empty every launch and a quit has
    /// nothing to name. #48 *Start Working* is what calls this, at the moment it
    /// opens the run; the rule it feeds is implemented, and it is exercised
    /// end to end from a test that opens a real run through the registry and
    /// stakes it, so the day that ticket lands the only new thing is the caller.
    /// The same posture [`Claims::claimed`] takes, for the same reason.
    pub fn staked(&self, run: RunId, stakes: Stakes) {
        self.staked_here().insert(run, stakes);
    }

    /// Whether this window already holds a run staked on that ticket in that
    /// folder whose child has not exited.
    ///
    /// Matched on the folder as well as the number for the reason
    /// [`Terminals::noticed`] gives: an issue number is unique inside one
    /// repository and means nothing across two, so a run against `#77` here
    /// would otherwise be answered for by somebody else's `#77`.
    ///
    /// The two locks are taken one after the other and never nested, as
    /// everywhere else on this type.
    fn live_run_on(&self, ticket: u64, folder: &str) -> bool {
        let staked: Vec<RunId> = self
            .staked_here()
            .iter()
            .filter(|(_, stakes)| stakes.ticket == Some(ticket) && stakes.folder == folder)
            .map(|(run, _)| *run)
            .collect();

        !staked.is_empty()
            && self
                .held()
                .telemetry()
                .iter()
                .any(|telemetry| !telemetry.over && staked.contains(&telemetry.run))
    }

    /// This run is live, as far as the poller's ladder is concerned, until the
    /// handle handed in here is dropped.
    pub fn counting(&self, run: RunId, handle: RunHandle) {
        self.counted_here().insert(run, handle);
    }

    /// Lets go of every run the registry says is over.
    ///
    /// Called from the readout tick, because that is the one thing in this
    /// process that already asks whether a child has ended — the alternative is
    /// a second watcher entitled to disagree with it about when a run stopped.
    /// The drop is what pokes the poller, so the falling edge reaches the
    /// cadence within a readout rather than within a rung.
    fn let_go_of(&self, over: &[RunId]) {
        let mut counted = self.counted_here();
        for run in over {
            counted.remove(run);
        }
    }

    fn counted_here(&self) -> MutexGuard<'_, BTreeMap<RunId, RunHandle>> {
        self.live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn resolved_here(&self) -> MutexGuard<'_, BTreeMap<RunId, NodeState>> {
        self.resolution
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What the poll that just landed says about the tickets these runs are
    /// working on.
    ///
    /// **Nothing here touches [`perseverance_pty::Runs`].** A ticket closing is
    /// a fact about GitHub, and the terminal beside it is not part of it: no
    /// session is closed, the monitored run stays monitored, no child is
    /// signalled and no geometry is disturbed. The two facts meet nowhere but
    /// in [`ending`], where a readout is written from both and neither is
    /// allowed to act on the other.
    ///
    /// **`Resolved` is a latch.** Once a run's ticket has been seen closed the
    /// run is spent for the rest of its life. The operator then opens another
    /// map, or this map stops listing the ticket, or GitHub is unreachable for
    /// an hour — none of that is the ticket re-opening, and a readout that
    /// flipped back to *live* because nobody was looking would be the app
    /// forgetting the one thing it is here to notice.
    ///
    /// **A ticket this model does not list writes nothing.** Absence is not a
    /// state: a run keeps whatever it was last seen as, which is why the loop
    /// below writes only on a hit.
    ///
    /// Matched on the folder as well as the number, because an issue number is
    /// unique inside one repository and means nothing across two — without it a
    /// run against `#77` here would be resolved by somebody else's `#77` in
    /// whichever folder happens to be on screen. Both spellings of the folder
    /// come from the same registry row (the press is handed it, and
    /// [`poll_once`] reads it back), and a run whose folder somehow does not
    /// match is left with the ending it had, which errs towards *live* rather
    /// than towards a close that never happened.
    pub fn noticed(&self, folder: &str, model: &Model) {
        let Some(map) = model.map.as_ref() else {
            return;
        };

        // A run that names no ticket has no node to be resolved by, so it never
        // reaches the table at all.
        let seen: Vec<(RunId, u64)> = self
            .staked_here()
            .iter()
            .filter(|(_, stakes)| stakes.folder == folder)
            .filter_map(|(run, stakes)| stakes.ticket.map(|ticket| (*run, ticket)))
            .collect();

        let mut resolution = self.resolved_here();
        for (run, ticket) in seen {
            if resolution.get(&run) == Some(&NodeState::Resolved) {
                continue;
            }
            if let Some(node) = map.nodes.iter().find(|node| node.number == ticket) {
                resolution.insert(run, node.state);
            }
        }
    }

    /// Every run's readout, with the ending this app has derived for it.
    ///
    /// The two locks are taken one after the other and never nested, for the
    /// reason [`Terminals::losses`] gives and with one more: this runs at three
    /// hertz against a table the poller writes, and neither thread may be made
    /// to wait on the other's work.
    fn readouts(&self) -> Vec<RunReadout> {
        let telemetry = self.held().telemetry();

        let staked: BTreeMap<RunId, Stakes> = self
            .staked_here()
            .iter()
            .map(|(run, stakes)| (*run, stakes.clone()))
            .collect();

        let resolution = self.resolved_here();
        telemetry
            .iter()
            .map(|telemetry| {
                let ending = ending(telemetry.over, resolution.get(&telemetry.run).copied());
                RunReadout::of(telemetry, ending, staked.get(&telemetry.run))
            })
            .collect()
    }

    /// One run, ended — the session closed, and every row this side kept about
    /// it dropped with it.
    ///
    /// Reached from [`end_run`] and from nothing else; that command is where the
    /// rule about who may call it is argued. The handle goes last and outside
    /// the lock, because dropping it wakes the poller and a table three threads
    /// read is not a thing to be holding while that happens.
    pub fn ended(&self, run: RunId) {
        self.held().close(run);
        self.staked_here().remove(&run);
        self.resolved_here().remove(&run);
        let counted = self.counted_here().remove(&run);
        drop(counted);
    }

    /// One sentence per live run, in the order they were opened — and the count
    /// a quit is decided on, because it is the length of this.
    ///
    /// **One snapshot, not two.** How many runs are live and what each of them
    /// loses used to be two separate reads of the registry lock, and a child
    /// that exited between them produced *0 runs are still live, and quitting
    /// ends every one of them* with nothing named under it. A confirmation that
    /// can be asked about nothing is the failure the whole gate exists to avoid,
    /// so there is one read and everything downstream counts these.
    ///
    /// Live rather than every run in the registry: a run whose child has exited
    /// is still there — its terminal stays readable until the ending is
    /// resolved, which is #49's — and a quit takes nothing from it.
    ///
    /// The two locks are taken one after the other and never nested, which is
    /// the whole of the care needed here: the frame thread takes the runs lock
    /// several times a second, and a quit is not entitled to be the thing that
    /// makes it wait on anything else.
    pub fn losses(&self) -> Vec<String> {
        let live: Vec<RunId> = self
            .held()
            .telemetry()
            .iter()
            .filter(|readout| !readout.over)
            .map(|readout| readout.run)
            .collect();

        let stakes = self.staked_here();
        live.into_iter()
            .map(|run| what_it_loses(run, stakes.get(&run)))
            .collect()
    }

    /// Whether a compose run for this map is still going.
    ///
    /// The one question a second *Compose Spec* press has to ask, and it is
    /// asked here rather than from the command because *live* is a join of the
    /// two tables this type owns: the registry says which runs have not ended,
    /// the stakes say what each of them is for, and a caller reaching into
    /// either one alone would be entitled to a different answer than
    /// [`Terminals::losses`] gives about the same run.
    ///
    /// **Liveness is the registry's reading and never the stake's.** A stake
    /// outlives its run on purpose — a run that has exited is still in the
    /// table so that what it was doing can still be named — so a guard written
    /// as *a compose is staked to this map* would refuse every press for the
    /// rest of the launch, and a compose that died before writing anything
    /// would leave its map with no way to compose a spec at all.
    ///
    /// The two locks are taken one after the other and never nested, for
    /// [`Terminals::losses`]'s reason: the frame thread takes the runs lock
    /// several times a second, and a press is not entitled to be the thing that
    /// makes it wait on anything else.
    pub fn composing(&self, map: u64) -> bool {
        let live: Vec<RunId> = self
            .held()
            .telemetry()
            .iter()
            .filter(|readout| !readout.over)
            .map(|readout| readout.run)
            .collect();

        let stakes = self.staked_here();
        live.into_iter().any(|run| {
            stakes
                .get(&run)
                .is_some_and(|staked| staked.kind == RunKind::Compose && staked.ticket == Some(map))
        })
    }
}

impl Default for Terminals {
    fn default() -> Terminals {
        Terminals::new()
    }
}

/// How often the byte channel is served.
///
/// **This is the coalescing.** The ring is written every time the PTY has
/// something, which for a build is hundreds of times a second; this reads it
/// once per frame and hands over everything that accumulated. There is no
/// buffer, no queue and no timer per run — one interval, one read, one message.
const FRAME: Duration = Duration::from_millis(16);

/// How often every run's readout is sent. Three hertz, inside the 2–4 the ticket
/// asks for.
///
/// **Nothing behind it is a GitHub read.** These are counts held in this
/// process, so no rate limit can make them stale and no poller condition has
/// anything to say about them — which is why they can be this frequent while the
/// map list is on a cadence ladder.
const READOUT: Duration = Duration::from_millis(333);

/// One delivery, framed, as it crosses to the WebView.
///
/// A header and then the bytes, rather than JSON with the bytes in it: a VT
/// stream is bytes, and JSON's only rendering of a byte is a number three or
/// four characters wide. Ten bytes of header is the whole cost of saying which
/// of the two kinds of delivery this is.
///
/// - byte 0 — `0` continues, `1` reset and replay
/// - byte 1 — whether this run has lost scrollback
/// - bytes 2..10 — the absolute offset this delivery ends at, big endian
fn framed(delivery: &Delivery) -> Option<Vec<u8>> {
    let (kind, truncated, through, bytes) = match delivery {
        Delivery::Nothing => return None,
        Delivery::Continues { bytes, through } => (0u8, 0u8, *through, bytes),
        Delivery::Replay {
            bytes,
            through,
            truncated,
        } => (1u8, u8::from(*truncated), *through, bytes),
    };

    let mut framed = Vec::with_capacity(bytes.len() + 10);
    framed.push(kind);
    framed.push(truncated);
    framed.extend_from_slice(&through.to_be_bytes());
    framed.extend_from_slice(bytes);
    Some(framed)
}

/// One run's readout, as the WebView receives it.
///
/// Every field is a count or a flag, and `truncation` is the one the chrome
/// prints. **It is here rather than in the byte stream**, which is the whole of
/// the rule: a terminal that had *scrollback lost* written into it would be a
/// terminal whose contents are no longer only what the agent said.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunReadout {
    run: u64,
    held: usize,
    dropped: u64,
    through: u64,
    end: u64,
    truncated: bool,
    desynced: bool,
    over: bool,
    code: Option<u32>,
    monitored: bool,
    /// Which ending this run has, or that it has none yet. Derived here and
    /// never in `crates/pty`: `over` above is the process, and this is the
    /// product's reading of it — see [`Ending`].
    ending: Ending,
    /// The ticket this run was staked on, or nothing for a run this app was
    /// never told about.
    ///
    /// Half of the value that joins a run to a node, and it is here because that
    /// join is what tells a claim with a live terminal from a claim with none —
    /// the difference Resume is offered on. Nothing else on a readout can make
    /// it, and `crates/pty` must not learn what a ticket is to help.
    ticket: Option<u64>,
    /// The folder that run was staked in, and the other half of the join.
    ///
    /// Here for the reason [`Terminals::live_run_on`] matches on it: an issue
    /// number is unique inside one repository and means nothing across two, and
    /// this window holds every folder's runs at once. A readout carrying the
    /// number alone let the chrome answer a claim in one repository with
    /// somebody else's `#77` in another — moving the pane onto an unrelated
    /// agent and sending no command at all, so that the folder-aware refusal
    /// next door was never even asked for.
    ///
    /// Derived in this crate from the stakes a press wrote, exactly as `ending`
    /// is: `crates/pty` carries no folder a product would recognise.
    folder: Option<String>,
}

impl RunReadout {
    /// A readout is the telemetry plus the things the telemetry cannot know.
    ///
    /// The stakes whole rather than the ticket out of them, because the join to
    /// a node is a folder and a number together, and a caller handed one of the
    /// two could not make it.
    ///
    /// Constructed rather than `From`, because a `From<&Telemetry>` would have
    /// to invent an ending out of a process fact alone — which is exactly the
    /// single state machine over the child that `docs/adr/0022` refuses.
    fn of(
        telemetry: &perseverance_pty::Telemetry,
        ending: Ending,
        stakes: Option<&Stakes>,
    ) -> RunReadout {
        RunReadout {
            run: telemetry.run.as_u64(),
            held: telemetry.held,
            dropped: telemetry.dropped,
            through: telemetry.through,
            end: telemetry.end,
            truncated: telemetry.truncated,
            desynced: telemetry.desynced,
            over: telemetry.over,
            code: telemetry.code,
            monitored: telemetry.monitored,
            ending,
            ticket: stakes.and_then(|stakes| stakes.ticket),
            folder: stakes.map(|stakes| stakes.folder.clone()),
        }
    }
}

/// How a run ended, or that it has not.
///
/// **Two independent facts, and never one state machine over the process.** The
/// ticket's resolution is seen by the poller and the child's exit is seen by
/// the PTY; neither causes the other, they arrive in either order, and a run can
/// sit in any pairing of them for hours. `docs/adr/0022` is the argument; what
/// it buys here is that no path in this app has to ask *what state is this run
/// in* — there is no such state, there are two facts and this table over them.
///
/// It is derived in this crate because it is product knowledge. `crates/pty`
/// carries `over` and an exit code and must not learn what a ticket is; the byte
/// scan at the bottom of this file is what keeps that true.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Ending {
    /// No ending yet: the child is running and the ticket is not closed.
    Live,

    /// The ticket closed. **The one ending that is good news**, and the one that
    /// says nothing at all about the child — which may still be printing. The
    /// run holds its slot in the rack until somebody presses to end it: see
    /// [`end_run`].
    Spent,

    /// The child exited with the ticket still open and still somebody's. The
    /// agent stopped without finishing, the claim is still on GitHub, and the
    /// terminal beside this is the only record of why.
    ExitedUnresolved,

    /// The child exited and nothing is claimed of it: the ticket is open and
    /// unassigned, or blocked, or on a map this app has never read.
    ///
    /// **An exit over an open-but-unassigned ticket reads as this and not as
    /// [`Ending::ExitedUnresolved`].** [`NodeState::Claimed`] is the only state
    /// that means the work is still held by somebody; `Takeable` says the
    /// assignment is gone — unassigned by hand, or never made — and `Blocked`
    /// says the same with something in the way. Calling either of those
    /// *unresolved* would have the readout assert a claim that is not there,
    /// which is the one lie this enum can tell that an operator would act on. A
    /// run whose ticket this app has never seen in a model is the same case for
    /// the same reason: nothing has been observed, so nothing is asserted.
    Exited,
}

/// The whole derivation, over the two facts and nothing else.
///
/// A free function over plain values, so the table can be read and tested
/// without a registry, a poller or a child process — the posture
/// [`what_it_loses`] takes next door.
fn ending(over: bool, seen: Option<NodeState>) -> Ending {
    match (seen, over) {
        // Resolution first, and in both columns: a ticket that closed is spent
        // whether or not the child is still running, and an exit afterwards does
        // not turn a finished piece of work into an abandoned one.
        (Some(NodeState::Resolved), _) => Ending::Spent,
        (_, false) => Ending::Live,
        (Some(NodeState::Claimed), true) => Ending::ExitedUnresolved,
        (_, true) => Ending::Exited,
    }
}

/// Where the monitored run's bytes go.
///
/// Registered once, at mount, and never per run — switching which run is
/// monitored does not re-register anything, which is what keeps a bind from
/// being a reset. A second call replaces the sink, which is what a reloaded
/// WebView needs.
#[tauri::command]
fn terminal_channel(terminals: State<'_, Terminals>, bytes: Channel<InvokeResponseBody>) {
    *terminals.sink() = Some(bytes);
}

/// Which run this window is looking at. A declaration and not a fetch — the same
/// shape [`watching`] takes for the map, and for the same reason: the bytes
/// arrive on the channel whenever the frame produced them, and a promise
/// resolving with a screenful here would be a second delivery path entitled to
/// disagree with the first.
#[tauri::command]
fn monitor_run(terminals: State<'_, Terminals>, run: Option<u64>) {
    terminals.held().monitor(run.map(RunId::from_u64));
}

/// The WebView confirming it has written this run's bytes up to `through`.
///
/// The whole of the backpressure signal. Without it a WebView that had stopped
/// writing would go on being sent to, and the only way that ends is a terminal
/// several megabytes behind with no way back.
#[tauri::command]
fn run_took(terminals: State<'_, Terminals>, run: u64, through: u64) {
    terminals.held().took(RunId::from_u64(run), through);
}

/// Keystrokes. xterm.js hands them over as a string and this crate turns it into
/// bytes; nothing here reads them.
#[tauri::command]
fn typed_at_run(terminals: State<'_, Terminals>, run: u64, text: String) -> Result<(), String> {
    terminals
        .held()
        .typed(RunId::from_u64(run), text.as_bytes())
        .map_err(|error| error.to_string())
}

/// A completed gesture settled on a pane size.
///
/// **The only thing in this process that resizes a PTY**, and the WebView calls
/// it once per settled gesture — never during a drag, never on bind, never on
/// peek, never on arrival. `src/panes/geometry.ts` is where that is decided and
/// `tests/panes.test.ts` is where it is asserted; what this side adds is that a
/// gesture settling on the size already in force resizes nothing at all.
#[tauri::command]
fn settled_geometry(terminals: State<'_, Terminals>, rows: u16, cols: u16) -> usize {
    terminals.held().settled(Geometry::new(rows, cols))
}

/// Every run's readout, on demand. The event carries the same value, so asking
/// as well as subscribing covers the gap between a tick landing and the WebView
/// having a listener — the ordering every other surface in this file uses.
#[tauri::command]
fn run_readouts(terminals: State<'_, Terminals>) -> Vec<RunReadout> {
    terminals.readouts()
}

/// One run, ended by a press.
///
/// **The only way a run leaves the rack**, and reachable from nowhere but the
/// WebView. A *spent* run — its ticket closed, its child possibly still
/// printing — holds its slot until this is called, because this app noticing a
/// close is not an operator being finished with what is on screen. If the poller
/// or a readout thread could reach this, the app would be closing terminals on
/// the strength of a GitHub read, and the last thing an agent printed is exactly
/// what a person goes looking for afterwards.
///
/// The child is ended with the session, which is what dropping it through
/// [`perseverance_pty::Runs::close`] means: a press is a decision to stop, and a
/// run left alive with nothing holding its bytes would be an orphan this app
/// could not name at the next quit.
#[tauri::command]
fn end_run(terminals: State<'_, Terminals>, run: u64) {
    terminals.ended(RunId::from_u64(run));
}

/// The frame pump and the readout tick, on one thread each.
///
/// Two rather than one because they are two different rates for two different
/// reasons — bytes at a frame because that is when a screen can change, readouts
/// at three hertz because that is as often as a number is worth reading — and
/// one thread doing both would make the slower one the faster one's jitter.
fn start_terminals(app: AppHandle) -> std::io::Result<()> {
    let frames = app.clone();
    std::thread::Builder::new()
        .name("perseverance-frames".to_string())
        .spawn(move || loop {
            std::thread::sleep(FRAME);

            let Some(terminals) = frames.try_state::<Terminals>() else {
                continue;
            };
            // The frame is taken before the sink is looked at, and the sink lock
            // is never held across it: this thread may not be what keeps a
            // command waiting.
            let Some((run, delivery)) = terminals.held().frame() else {
                continue;
            };
            let Some(message) = framed(&delivery) else {
                continue;
            };
            let sink = terminals.sink().clone();
            if let Some(sink) = sink {
                // A channel that will not take it is a WebView that has gone.
                // Nothing is retried and nothing is dropped from the stream: the
                // bytes are still in the ring, and the tap still says this run's
                // terminal has them — which is the one place a lie here would
                // cost a splice.
                if sink.send(InvokeResponseBody::Raw(message)).is_err() {
                    terminals.held().unsent(run);
                }
            }
        })?;

    std::thread::Builder::new()
        .name("perseverance-readouts".to_string())
        .spawn(move || loop {
            std::thread::sleep(READOUT);

            let Some(terminals) = app.try_state::<Terminals>() else {
                continue;
            };
            let readouts = terminals.readouts();
            // The falling edge of a run, taken from the same readout the screen
            // is drawn from. Dropping the handle is what tells the poller the
            // ladder has come down a rung.
            let over: Vec<RunId> = readouts
                .iter()
                .filter(|readout| readout.over)
                .map(|readout| RunId::from_u64(readout.run))
                .collect();
            terminals.let_go_of(&over);
            let _ = app.emit("run-readouts", readouts);
        })?;

    Ok(())
}

/* ----------------------------------------------------- starting working --- */

/// How long a press waits for its revalidation before giving up on the wait.
///
/// Longer than the read it is waiting for (~0.4 s) and the poke floor (1 s)
/// together; shorter than a person will hold still. A pass queued behind a read
/// already in flight can be a whole twenty-second deadline away, and waiting
/// that out is a button that looks broken. What runs out here is the *wait* and
/// never the read: the pass this poke bought still happens, still emits both
/// surfaces, and still lands in the graph and the ledger.
const CHECKING: Duration = Duration::from_secs(6);

/// A launch that has not finished starting up, in one sentence.
///
/// One string and two callers: the pre-guard [`why_the_check_is_not_a_read`]
/// puts it in front of [`spawn_at`], and [`chart_in`] — which has no pre-guard
/// — says it for itself. Two copies of a sentence this load-bearing would be
/// two sentences the moment one of them was edited.
const STILL_STARTING_UP: &str =
    "this run has not finished starting up, so nothing was checked and nothing was started";

/// Why a revalidation is not the fresh read a press may act on, or `None` when
/// it is one.
///
/// **Four answers, four sentences.** [`Revalidated::is_fresh`] is a single bit,
/// and this is the one place where the difference between its false answers is
/// the whole of what an operator needs: a deadline that ran out, a pass that
/// never asked anybody anything, and a read that landed and was refused are
/// different things to do next. Collapsing them prints *the check did not land
/// in time* over a revoked token, which is simply false — and
/// `docs/adr/0009`'s taxonomy exists so that the socket's note and the graph's
/// `Degraded` condition tell the same story about the same failure.
///
/// **`harvest_settled` splits the pass that asked nobody in two.** A
/// [`Tick::NotAttempted`] has two sources and they are about two different
/// machines: the poller reaches it when no map is being watched, and
/// [`poll_once`] reaches it when this launch's token harvest has not settled,
/// so there is nothing to read GitHub *with* yet. A Windows harvest is 1.5 to
/// 1.9 seconds of real work, so a folder can be on screen and a press can be
/// made while the token is still unknown — and telling that operator *no map
/// is being watched* sends them to look at the app instead of at a launch that
/// has not finished. The caller reads [`Ambient::token`], which is the only
/// place that fact lives.
fn why_the_check_is_not_a_read(answer: Revalidated, harvest_settled: bool) -> Option<String> {
    match answer {
        // The one answer a spawn is allowed to stand on.
        Revalidated::Ticked(Tick::Read(_)) => None,
        Revalidated::NotInTime => {
            Some("the check of GitHub did not land in time, so nothing was started".to_string())
        }
        // Nothing failed and nothing was asked because this launch has not
        // finished starting up: the harvest still owes this run a token, and a
        // press a second later is the whole of the remedy. The sentence is
        // about *this run* rather than about the folder, so nobody is sent to
        // look at a map that is being watched perfectly well.
        Revalidated::Ticked(Tick::NotAttempted) if !harvest_settled => {
            Some(STILL_STARTING_UP.to_string())
        }
        // Nothing failed and nothing was asked: no map is being watched, so the
        // pass had nothing to read. Naming a timeout here would send an
        // operator to look at their network for a state that is about the app.
        Revalidated::Ticked(Tick::NotAttempted) => Some(
            "no map is being watched, so there was nothing to check and nothing was started"
                .to_string(),
        ),
        // The read landed and GitHub refused it. The fault is named, so this
        // sentence and the condition on the graph are about the same thing.
        Revalidated::Ticked(Tick::Failed(fault)) => Some(what_github_refused(fault)),
    }
}

/// One fault, as the sentence the press gets back.
///
/// One exhaustive match, so a fifth [`Fault`] is a compile error here rather
/// than a refusal that quietly reads as a timeout.
fn what_github_refused(fault: Fault) -> String {
    let reason = match fault {
        Fault::Unreachable => "GitHub could not be reached".to_string(),
        Fault::AuthFailed => "GitHub would not accept this run's credentials".to_string(),
        Fault::MapGone => "GitHub no longer has the map this folder is watching".to_string(),
        // Zero or less is [`Fault::of`]'s *no moment was named*, not *the reset
        // is now*, so it is reported as a spent budget with no clock on it
        // rather than as a wait of zero seconds.
        Fault::RateLimited { seconds_to_reset } if seconds_to_reset > 0 => {
            format!("GitHub's rate limit is spent for another {seconds_to_reset}s")
        }
        Fault::RateLimited { .. } => "GitHub's rate limit is spent".to_string(),
    };

    format!("{reason}, so nothing was started")
}

/// What one press came to.
///
/// Two answers and no third — this is a socket return, not a condition on the
/// graph, and `docs/adr/0009`'s one-enum-twice is about the taxonomy the poller
/// and the WebView share, which nothing here joins.
///
/// **A refusal carries the frontier the fresh read established**, so the next
/// press is a press at the target that actually exists. Re-arming the button on
/// that number and requiring a second press is the WebView's, out of this
/// value: a press is never silently retargeted. `None` is *no fresh read
/// landed*, which is a different fact from *the frontier moved* — it names no
/// new target because it learned none.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Started {
    Spawned {
        run: u64,
        /// The text the child was actually started with, its length, and
        /// whether it came from our prose or the operator's — which is the
        /// badge, and the only reason a run under custom prose is diagnosable.
        prompt: prompt::Rendered,
    },
    Refused {
        detail: String,
        frontier: Option<Frontier>,
    },
}

impl Started {
    fn refused(detail: impl Into<String>, frontier: Option<Frontier>) -> Started {
        Started::Refused {
            detail: detail.into(),
            frontier,
        }
    }
}

/// Start Working, from the press to the child.
///
/// The order is the whole of it and none of it is rearrangeable: revalidate,
/// compare, render, resolve, plan, spawn, and only then stake, claim and count.
/// Nothing is written down before the spawn has succeeded, so a refusal at any
/// step leaves the graph and the ledger exactly as the revalidation left them.
///
/// **The re-read is an ordinary poll, awaited.** It is the same closure on the
/// same thread emitting the same two surfaces, so a race this press loses lands
/// on the graph and feeds the ledger by the route every other pass uses — and
/// there is no second read path to keep in step with the first. It is a UX
/// guard and not a correctness guard: two machines can check in the same second
/// and both spawn, and the guard that holds is the agent's conditional claim,
/// because the agent is the only writer.
///
/// **The adapter is an argument**, because the crossing owns the picker: which
/// agent to start is a fact about this press, resolved against this folder's
/// environment and this app's override, and never a global setting read here.
///
/// **The harness surfaces only its own failures.** Every refusal below is a
/// sentence returned to the socket. None of them is a `Degraded` on the graph,
/// and nothing the child prints is one either — agent stderr is the terminal's
/// to show.
// Eleven, and every one of them is either managed state this command needs or a
// fact about the press. Tauri resolves the first eight by type from the
// container; splitting them into a struct would be a struct assembled here for
// the sake of a lint.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
fn start_working(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    ambient: State<'_, Ambient>,
    ledgers: State<'_, Ledgers>,
    claims: State<'_, Claims>,
    poker: State<'_, Poker>,
    folder: String,
    ticket: u64,
    adapter: String,
) -> Started {
    // `None` is a harvest that has not settled, and it is the only thing that
    // tells a run that has not finished starting up apart from a folder
    // watching no map — both of which reach the gate below as the same
    // `NotAttempted`.
    let harvest_settled = ambient.token.get().is_some();
    if let Some(refusal) = why_the_check_is_not_a_read(poker.revalidate(CHECKING), harvest_settled)
    {
        return Started::refused(refusal, None);
    }

    // The frontier as the one resolver derived it, on the pass that press just
    // bought — read from the snapshot that pass emitted rather than from
    // anything this side kept, and structural rather than any view's opinion.
    let Some(map) = ledgers.held().model.map else {
        return Started::refused("no map is open, so there is nothing to start", None);
    };
    // The whole of the guard, in one comparison. `Frontier::Designated` is the
    // first *takeable* node in map order, so *somebody else got there first*,
    // *it was closed*, *it became blocked* and *it is not for this machine* are
    // all the same answer: not this one.
    if map.frontier != Frontier::Designated(ticket) {
        return Started::refused(
            format!("#{ticket} is not what this map offers to start any more"),
            Some(map.frontier),
        );
    }

    let standing = Some(map.frontier);
    match spawn_at(
        &app, &terminals, &harvests, &registry, &ambient, &map, ticket, &folder, &adapter,
    ) {
        Ok((run, rendered)) => {
            booked(
                &terminals,
                &claims,
                &poker,
                run,
                Stakes {
                    ticket: Some(ticket),
                    folder,
                    kind: kind_of(&map, ticket),
                },
            );

            Started::Spawned {
                run: run.as_u64(),
                prompt: rendered,
            }
        }
        Err(refusal) => Started::refused(refusal, standing),
    }
}

/// Start Charting, from the idea box to the child.
///
/// **Nearly every guard `start_working` opens with is absent here, and each
/// absence is the same fact twice: there is no ticket.** No awaited
/// revalidation and no frontier comparison — that gate exists so a press is
/// never silently retargeted, and nothing here has a target to be moved off.
/// No claim — the agent's own conditional claim is what makes a ticket safe,
/// and there is no ticket to make safe. No worktree — the spawn directory is
/// the folder itself, and worktrees are a research run's. And no write to
/// GitHub of any kind: the harness creates no label and opens no issue, the
/// run does all of that, and the map it produces is discovered by the same
/// label poll that discovers every other one.
///
/// A refusal here therefore always names `None` for the frontier: this press
/// learned no target because it asked about none.
// Nine, for the same reason `start_working` has eleven: managed state Tauri
// resolves by type, plus the three facts about this press. `poker` is not the
// frontend's business either — it is what puts the run on the live ladder.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
fn start_charting(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    ambient: State<'_, Ambient>,
    poker: State<'_, Poker>,
    folder: String,
    idea: String,
    adapter: String,
) -> Started {
    match chart_in(
        &app, &terminals, &harvests, &registry, &ambient, &folder, &idea, &adapter,
    ) {
        Ok((run, rendered)) => {
            // Two writes and a bind, and not one of them happens before there
            // is a run for them to be true of.
            terminals.staked(
                run,
                Stakes {
                    ticket: None,
                    folder,
                    kind: RunKind::Chart,
                },
            );
            terminals.counting(run, poker.run_started());
            // The operator watches what they started.
            terminals.held().monitor(Some(run));

            Started::Spawned {
                run: run.as_u64(),
                prompt: rendered,
            }
        }
        Err(refusal) => Started::refused(refusal, None),
    }
}

/// Everything between the press and the charting run, and every way it can
/// refuse — [`spawn_at`]'s shape, minus the three hops that need a map.
#[allow(clippy::too_many_arguments)]
fn chart_in(
    app: &AppHandle,
    terminals: &Terminals,
    harvests: &Harvests,
    registry: &Registry,
    ambient: &Ambient,
    folder: &str,
    idea: &str,
    adapter: &str,
) -> Result<(RunId, prompt::Rendered), String> {
    // The store's own sentence, unedited, exactly as `spawn_at` carries it.
    let repo =
        perseverance_store::bind_repo(Path::new(folder)).map_err(|refusal| refusal.to_string())?;

    // Wanted for one thing only — learning who is signed in — but a chart brief
    // with no operator in it is as unfollowable as a work brief with none.
    //
    // Two refusals, because `Ambient::token` holds two different absences and a
    // press can meet either. `None` is *the harvest is still out* — the folder
    // read and the map poll can both be answered from cache while a Windows
    // harvest is still 1.5 seconds of real work — and a press a second later is
    // the whole of the remedy. A settled harvest that acquired nothing is the
    // permanent one. There is no [`why_the_check_is_not_a_read`] ahead of this
    // chain to tell them apart the way [`spawn_at`]'s caller does, so it is told
    // here, in that function's sentence unedited.
    let token = match ambient.token.get() {
        Some(TokenOutcome::Acquired(token)) => token,
        None => return Err(STILL_STARTING_UP.to_string()),
        Some(_) => {
            return Err(
                "this run acquired no GitHub token, so no session can be started".to_string(),
            );
        }
    };
    let Some(operator) = remembered_login(&ambient.login, || read_login(token)) else {
        return Err(
            "this run never learned which GitHub account is signed in, and a brief names its \
             operator"
                .to_string(),
        );
    };

    let rendered = charting(app, &operator, &repo, idea);
    let (spawn, launch) = plan_in(harvests, registry, folder, adapter, &rendered.text)?;
    let accepted = perseverance_pty::accept(launch).map_err(|refusal| refusal.to_string())?;

    let run = terminals
        .held()
        .open(accepted, &spawn.directory, &spawn.environment)
        .map_err(|refusal| refusal.to_string())?;

    Ok((run, rendered))
}

/// The charting prompt, rendered at the moment of spawn — [`render`]'s rule
/// about the override, for the other template.
fn charting(
    app: &AppHandle,
    operator: &str,
    repo: &perseverance_store::RepoRef,
    idea: &str,
) -> prompt::Rendered {
    let overriding = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|directory| prompt::chart_override(&directory));

    prompt::chart(
        overriding.as_deref(),
        &prompt::Bearings {
            repo: format!("{}/{}", repo.owner, repo.name),
            // Built rather than carried: nothing has been read from GitHub yet,
            // so there is no issue URL to take a sibling from — and the binding
            // only answers for a remote it recognised as github.com in the
            // first place.
            repo_url: format!("https://github.com/{}/{}", repo.owner, repo.name),
            operator: operator.to_string(),
            idea: idea.to_string(),
        },
    )
}

/// A second press over a claim already made: a fresh session against a ticket
/// this map already reports as [`NodeState::Claimed`].
///
/// **The prompt is byte-identical to Start Working's.** Both render through the
/// one [`prompt::work_ticket`] with the same [`prompt::Coordinates`], and the
/// override is read at spawn wholesale exactly as it already is: there is no
/// verb in the template, no verb on the coordinates and no verb in this
/// command's arguments. A sixth template was rejected because Resume differs by
/// a *precondition* and not by a behaviour.
///
/// **The three-way step 1 is what makes it legal.** The brief tells the agent to
/// claim an unassigned ticket, to proceed over one already assigned to the
/// operator writing nothing, and to stop over one assigned to anybody else — so
/// a session handed a claim it must not touch refuses by reading its own brief.
/// This side consults no identity and cannot: the model carries a *count* of
/// assignees and no logins, and every run of this harness assigns the same
/// login, so *claimed by me* is liveness rather than identity. Resume is
/// therefore offered over any `Claimed` node.
///
/// **Nothing new is written down.** No session id, no reattach, no
/// adapter-native continuation flag. A run whose child is gone is picked up by
/// the sentence already in the template that sends the agent to the ticket's
/// existing comments before it starts.
// Eleven arguments for the reason [`start_working`] has eleven: the two
// commands take the same press and the same managed state, and it is the same
// press precisely because nothing in it names the verb.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
fn resume_working(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    ambient: State<'_, Ambient>,
    ledgers: State<'_, Ledgers>,
    claims: State<'_, Claims>,
    poker: State<'_, Poker>,
    folder: String,
    ticket: u64,
    adapter: String,
) -> Started {
    // The same awaited poke Start Working gates on, and a UX guard rather than
    // a correctness one: what makes a resume safe is the node this side reads
    // *after* it, never the freshness of the read on its own.
    let harvest_settled = ambient.token.get().is_some();
    if let Some(refusal) = why_the_check_is_not_a_read(poker.revalidate(CHECKING), harvest_settled)
    {
        return Started::refused(refusal, None);
    }

    let Some(map) = ledgers.held().model.map else {
        return Started::refused("no map is open, so there is nothing to resume", None);
    };
    let standing = Some(map.frontier);
    if let Some(refusal) = why_the_claim_cannot_be_resumed(&map, ticket) {
        return Started::refused(refusal, standing);
    }
    // One foreground run per crossing, and one pane: a claim whose child is
    // still alive is re-focused by the rail and never spawned over.
    if terminals.live_run_on(ticket, &folder) {
        return Started::refused(
            format!("#{ticket} already has a run in this window and it is still live"),
            standing,
        );
    }

    match spawn_at(
        &app, &terminals, &harvests, &registry, &ambient, &map, ticket, &folder, &adapter,
    ) {
        Ok((run, rendered)) => {
            booked(
                &terminals,
                &claims,
                &poker,
                run,
                Stakes {
                    ticket: Some(ticket),
                    folder,
                    kind: kind_of(&map, ticket),
                },
            );

            Started::Spawned {
                run: run.as_u64(),
                prompt: rendered,
            }
        }
        Err(refusal) => Started::refused(refusal, standing),
    }
}

/// Why this ticket is not a claim to resume, or nothing at all.
///
/// **Two refusals stand in front of the match, and they are the two guards
/// Resume does not inherit.** Start Working is aimed at the frontier, so the
/// frontier's own resolver had already answered *is this a wayfinder ticket* and
/// *is this bound to another machine* before a press could reach one; Resume is
/// aimed at the operator's selection, which no resolver has been through, so it
/// asks both here or not at all. A spec node and an unclassified child both read
/// [`NodeState::Claimed`] the moment they are assigned and unblocked — the
/// derivation reads state and never kind — and a ticket labelled for another
/// platform reads `Claimed` here as plainly as any other.
///
/// The state is still one exhaustive match, so a fifth [`NodeState`] is a
/// compile error here rather than a ticket that quietly reads as unclaimed.
///
/// **A ticket that has gained a blocker is not resumable**, however plainly it
/// is assigned to the operator. [`NodeState`] is derived in strict precedence —
/// resolved, then blocked, then claimed, then takeable — so an open blocker
/// takes the node off `Claimed` altogether. That is a consequence of the one
/// derivation the whole app reads, and not a rule this file is entitled to
/// soften with a second opinion about what *claimed* means.
fn why_the_claim_cannot_be_resumed(map: &Map, ticket: u64) -> Option<String> {
    let Some(node) = map.nodes.iter().find(|node| node.number == ticket) else {
        return Some(format!("#{ticket} is not on this map"));
    };

    // *Is a ticket*, which the frontier's resolver enforced for the other verb.
    // Without it `kind_of` below falls through to [`RunKind::Work`] and an agent
    // is spawned at the destination, or at an unclassified child, with a work
    // brief in its hands.
    if !matches!(node.kind, ChildKind::Ticket(_)) {
        return Some(format!(
            "#{ticket} is not a wayfinder ticket, so there is nothing to resume"
        ));
    }

    // *Is not bound to another machine.* `docs/adr/0015` promises of that label
    // family that nothing is hidden and nothing is launched, and a claim is not
    // the exception: the node stays on the map, selectable and legible, and the
    // press over it refuses.
    if node.bound_elsewhere {
        return Some(format!(
            "#{ticket} is bound to another machine, so it is not resumable here"
        ));
    }

    match node.state {
        NodeState::Claimed => None,
        NodeState::Resolved => Some(format!(
            "#{ticket} is closed, so there is nothing to resume"
        )),
        NodeState::Blocked => Some(format!(
            "#{ticket} has something open in its way, so it is not a claim to resume"
        )),
        NodeState::Takeable => Some(format!(
            "#{ticket} is not claimed, so there is nothing to resume"
        )),
    }
}

/// The three writes and the bind that make a spawned run this harness's own.
///
/// One function because the two verbs must not be able to drift apart here, and
/// in the order that keeps each of them true of a run that already exists: what
/// it would lose, that this harness is the one that took the node — idempotent,
/// and what keeps a later assignment from announcing as foreign — and that the
/// ladder has a live run on it.
fn booked(terminals: &Terminals, claims: &Claims, poker: &Poker, run: RunId, stakes: Stakes) {
    let ticket = stakes.ticket;

    terminals.staked(run, stakes);
    // A run that names no ticket takes no claim — charting reaches a repository
    // before any ticket exists.
    if let Some(ticket) = ticket {
        claims.claimed(ticket);
    }
    terminals.counting(run, poker.run_started());
    // The operator watches what they started.
    terminals.held().monitor(Some(run));
}

/// What kind of run this ticket is, from the node the frontier named.
///
/// A ticket the frontier designates is a ticket by construction — `is_takeable`
/// says so — and a ticket Resume reaches has been through the kind refusal in
/// [`why_the_claim_cannot_be_resumed`], so the fallback is unreachable from both
/// verbs rather than a policy, and it is [`RunKind::Work`] because that is the
/// kind whose loss sentence is the safe one to be wrong with.
fn kind_of(map: &Map, ticket: u64) -> RunKind {
    match map
        .nodes
        .iter()
        .find(|node| node.number == ticket)
        .map(|node| node.kind)
    {
        Some(ChildKind::Ticket(ticket)) => RunKind::of(ticket),
        _ => RunKind::Work,
    }
}

/// What a spawn with no credentials says, and what one with no operator says.
///
/// Written once because both spawns ask the same two questions in the same
/// order and get to refuse for the same two reasons — the brief's step 1
/// branches on *already assigned to you* and the compose brief names who the
/// seam sketch goes to, so neither template can be rendered with a hole where
/// the operator belongs.
const NO_TOKEN: &str = "this run acquired no GitHub token, so no session can be started";
const NO_OPERATOR: &str =
    "this run never learned which GitHub account is signed in, and a brief names its operator";

/// Everything between the guard and the run, and every way it can refuse.
///
/// Split out so the command above is the *order* and this is the *chain*, and
/// so that one `?` per hop is what carries a refusal back rather than nine
/// early returns that each have to remember the frontier.
#[allow(clippy::too_many_arguments)]
fn spawn_at(
    app: &AppHandle,
    terminals: &Terminals,
    harvests: &Harvests,
    registry: &Registry,
    ambient: &Ambient,
    map: &Map,
    ticket: u64,
    folder: &str,
    adapter: &str,
) -> Result<(RunId, prompt::Rendered), String> {
    let node = map
        .nodes
        .iter()
        .find(|node| node.number == ticket)
        .ok_or_else(|| format!("#{ticket} is not on this map"))?;

    let repo = perseverance_store::bind_repo(Path::new(folder)).map_err(|refusal| {
        // The store's own sentence, unedited, exactly as `poll_once` carries it.
        refusal.to_string()
    })?;

    let Some(TokenOutcome::Acquired(token)) = ambient.token.get() else {
        return Err(NO_TOKEN.to_string());
    };
    // The brief's step 1 branches on *already assigned to you*, so a prompt with
    // no operator in it is a brief a session cannot follow. Refused rather than
    // rendered with a hole.
    // Asked here, over the socket, with the token above — and memoised on a
    // success alone, so the round trip is the first *answered* press's and every
    // press after is a read of a `OnceLock`, while a press that met a cold
    // network leaves the next one free to ask again. It is deliberately after
    // the token check: a run with no token has nothing to ask with.
    let Some(operator) = remembered_login(&ambient.login, || read_login(token)) else {
        return Err(NO_OPERATOR.to_string());
    };

    let question = read_ticket_body(token, &repo.owner, &repo.name, ticket)
        .map_err(|refusal| refusal.to_string())?;

    let rendered = render(app, &operator, &repo, map, node, question);

    start_child(terminals, harvests, registry, folder, adapter, rendered)
}

/// The login this process learned, asked once more if it has not learned it yet.
///
/// The seam exists because the difference between *memoise the answer* and
/// *memoise a success* is one line at a call site that cannot be tested — the
/// only real reader there is a GitHub round trip — so the rule is lifted out to
/// where the reader is an argument and both halves are ordinary tests.
///
/// A `None` from `ask` writes nothing, which is the whole point: it is not an
/// answer, it is *this press did not get one*, and the next press is entitled to
/// ask again. A `Some` fills the cell, and every call after it reads rather than
/// asks — including the one that raced and lost the `set`, which reads the
/// winner's answer instead of its own, since two presses that both learned a
/// login learned the same one.
fn remembered_login(
    cell: &OnceLock<String>,
    ask: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Some(known) = cell.get() {
        return Some(known.clone());
    }

    let learned = ask()?;
    let _ = cell.set(learned);

    cell.get().cloned()
}

/// The prompt, rendered at the moment of spawn.
///
/// **The override is read here and never cached**, so an operator who edits it
/// between two presses gets the text they just wrote — and it is wholesale, with
/// no merging, which is [`prompt::work_ticket_override`]'s rule and not one this
/// file gets to soften.
fn render(
    app: &AppHandle,
    operator: &str,
    repo: &perseverance_store::RepoRef,
    map: &Map,
    node: &perseverance_model::Node,
    question: String,
) -> prompt::Rendered {
    let overriding = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|directory| prompt::work_ticket_override(&directory));

    prompt::work_ticket(
        overriding.as_deref(),
        &prompt::Coordinates {
            repo: format!("{}/{}", repo.owner, repo.name),
            map_number: map.number,
            // The map's own URL never crosses the derivation — the graph
            // carries its number and its children's URLs — so it is built from
            // the sibling GitHub itself sent rather than from a template this
            // file would have to keep true.
            map_url: match node.url.rsplit_once('/') {
                Some((issues, _)) => format!("{issues}/{}", map.number),
                None => node.url.clone(),
            },
            ticket_number: node.number,
            ticket_url: node.url.clone(),
            ticket_title: node.title.clone(),
            operator: operator.to_string(),
            question,
        },
    )
}

/// The folder's environment, the chosen adapter's program in it, and the launch
/// that adapter planned — the hop this whole chain existed for.
///
/// Returned beside the directory and the environment pairs because the session
/// needs all three and they are one folder's answer: resolving the program
/// against one environment and starting the child in another is the bug the
/// harvest exists to prevent.
fn plan_in(
    harvests: &Harvests,
    registry: &Registry,
    folder: &str,
    adapter: &str,
    prompt: &str,
) -> Result<(SpawnIn, perseverance_agent::Launch), String> {
    let agent = agent_named(adapter).ok_or_else(|| format!("no adapter is named {adapter}"))?;
    let settled = harvests.in_folder(Path::new(folder));
    let chosen = remembered_override(registry);

    // The same two-tier resolution the folder readout already draws, and not a
    // second copy of it: an override's `argv[0]` goes through
    // `Environment::resolve`, and a candidate list through `locate_in`.
    let program = match &chosen {
        Some(chosen) => settled
            .environment
            .resolve(&chosen.program().to_string_lossy()),
        None => match locate_in(&settled.environment, agent.discovery().candidates) {
            Located::Found(found) => Some(found.program),
            Located::NotFound(_) => None,
        },
    };
    let program = program
        .ok_or_else(|| format!("nothing this folder's environment can run is named {adapter}"))?;

    // The directory in the spelling a child can be given: the harvest's key
    // keeps Windows' verbatim prefix and a spawn is not known to take it.
    let directory = spawnable_form(&settled.spawn_directory);
    let variables: Vec<(&str, &[u8])> = settled.environment.iter().collect();

    let planned = agent
        .plan(&LaunchContext::new(
            Platform::host(),
            program.as_os_str(),
            directory.as_os_str(),
            prompt,
            &variables,
        ))
        .map_err(|refusal| refusal.to_string())?;

    // The operator's interposed arguments, after the program and before the
    // adapter's own. One splice, and `Launch::under` is where it is spelled.
    let launch = match &chosen {
        Some(chosen) => planned.under(chosen.interposed()),
        None => planned,
    };

    Ok((
        SpawnIn {
            directory,
            environment: settled.environment.os_pairs(),
        },
        launch,
    ))
}

/// Where a child is started and what it inherits — one folder's answer, kept
/// together because resolving a program against one environment and starting it
/// in another is the bug the harvest exists to prevent.
struct SpawnIn {
    directory: PathBuf,
    environment: Vec<(OsString, OsString)>,
}

/// The last three hops of every spawn: plan the launch, accept the PTY, open the
/// run.
///
/// Shared rather than copied, because from here down a run is a run — a compose
/// press differs from a work press only in what it renders and in what it is
/// allowed to render *from*. A second copy of this tail is where the two would
/// quietly stop being the same foreground, monitored session.
fn start_child(
    terminals: &Terminals,
    harvests: &Harvests,
    registry: &Registry,
    folder: &str,
    adapter: &str,
    rendered: prompt::Rendered,
) -> Result<(RunId, prompt::Rendered), String> {
    let (spawn, launch) = plan_in(harvests, registry, folder, adapter, &rendered.text)?;
    let accepted = perseverance_pty::accept(launch).map_err(|refusal| refusal.to_string())?;

    let run = terminals
        .held()
        .open(accepted, &spawn.directory, &spawn.environment)
        .map_err(|refusal| refusal.to_string())?;

    Ok((run, rendered))
}

/* ------------------------------------------------------ composing a spec --- */

/// What one Compose press came to.
///
/// A second, smaller enum beside [`Started`] rather than a field added to it,
/// for the reason [`prompt::MapCoordinates`] is a second struct beside
/// [`prompt::Coordinates`]: a compose press has no frontier, so a `frontier`
/// here could only ever be null, and a field that is always null is a lie the
/// hand-mirrored TypeScript on the other side would have to keep reading. What
/// a value cannot carry, nobody can misread.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Composed {
    Spawned {
        run: u64,
        /// The text the child was actually started with, its length, and whose
        /// prose it came from — the same badge [`Started::Spawned`] carries and
        /// for the same reason.
        prompt: prompt::Rendered,
    },
    Refused {
        detail: String,
    },
}

impl Composed {
    fn refused(detail: impl Into<String>) -> Composed {
        Composed::Refused {
            detail: detail.into(),
        }
    }
}

/// Why this map is not one a spec can be composed on, when it is not.
///
/// [`Phase::SpecReady`] is exactly *every ticket on the map is closed and no
/// spec exists yet*, and it is the only rung a compose spawns from. The other
/// four each get a sentence naming what is actually true, because a refusal
/// that only says *not now* is one an operator cannot act on.
///
/// **Matched exhaustively, never with a wildcard.** A sixth rung on the ladder
/// has to be a compile error here rather than a map silently offered a compose
/// it has no business being offered.
///
/// A free function over the map alone, so all five rungs are ordinary tests
/// with no Tauri app anywhere near them.
fn why_the_spec_is_not_composable(map: &Map) -> Option<String> {
    let number = map.number;
    match map.phase {
        Phase::SpecReady => None,
        Phase::Wayfinding => Some(format!(
            "#{number} still has open tickets, and a spec is composed from a map that is finished"
        )),
        Phase::Specced => Some(format!(
            "#{number} already has a spec, so there is nothing left to compose"
        )),
        Phase::Unstarted => Some(format!(
            "nothing has been charted on #{number} yet, so there is nothing to compose from"
        )),
        Phase::Done => Some(format!("#{number} is closed, so nothing is composed on it")),
    }
}

/// What a second press is told, in the words the socket recesses with.
///
/// A sentence with a name rather than a `format!` at the guard, because both
/// sides of the seam say it: `startSocket` in `src/chrome/sockets.ts` recesses
/// the box with this text while the run it names is still going, so the
/// operator reads the same reason whether the rail worked it out or the harness
/// did.
fn a_compose_is_already_open(map: u64) -> String {
    format!("#{map} already has a compose run open")
}

/// The map's own URL, derived from a child's, exactly as [`render`] derives it.
///
/// The map's URL never crosses the seam — the graph carries the map's number
/// and its children's URLs — so it is rebuilt from a sibling GitHub itself sent
/// rather than from a template this file would have to keep true.
///
/// `None` is *this map sent no child to derive from*, which a
/// [`Phase::SpecReady`] map cannot be: zero tickets and zero specs reads
/// [`Phase::Unstarted`]. It is an `Option` and not an `unwrap` anyway, because
/// the alternative to refusing is a brief naming a map by a URL this side
/// invented, and a coordinate that points at nothing is one a session will
/// still go and read.
fn where_the_map_lives(map: &Map) -> Option<String> {
    let node = map.nodes.first()?;

    Some(match node.url.rsplit_once('/') {
        Some((issues, _)) => format!("{issues}/{}", map.number),
        None => node.url.clone(),
    })
}

/// Compose Spec, from the press to the child.
///
/// The order is [`start_working`]'s and it is the same order for the same
/// reason: revalidate, read the map, guard the phase, render, plan, spawn, and
/// only then stake and count. Nothing is written down before the spawn has
/// succeeded, so a refusal at any step leaves the graph and the ledger exactly
/// as the revalidation left them. The re-read is the same awaited poll — the
/// offer is checked against a fresh read and not against whatever the window
/// last drew.
///
/// **No claim is taken.** [`Claims`] records the ticket this harness assigned,
/// and a compose run has no ticket and does not assign the map — so `claimed`
/// is deliberately not called and this command never asks for a [`Claims`]
/// handle. What it stakes is the map's number, so the quit confirmation names
/// `#<map>` rather than a run id.
///
/// **The live run is the claim.** Nothing else can be: no assignment is taken,
/// and the map stays on the rung that offers the compose until the spec lands
/// at the end of the run — so a second press arrives at a harness that agrees
/// with it, and two sessions each attach their own `wayfinder:spec` child. That
/// is the set the sub-issue is not allowed to become, and the run staked to
/// this map is what refuses the second press.
///
/// **One run, in the foreground.** No reduce, no staged outline and no per-area
/// pass: the child goes down the ordinary PTY path and is monitored like any
/// work run, and the four harness rules it follows are prose in the template
/// rather than anything this side drives.
///
/// **The harness surfaces only its own failures**, exactly as above: every
/// refusal here is a sentence returned to the socket, none of them is a
/// `Degraded` on the graph, and nothing the child prints is one either.
// Nine, for [`start_working`]'s reason: managed state Tauri resolves by type,
// plus the two facts about this press.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
fn compose_spec(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    harvests: State<'_, Harvests>,
    registry: State<'_, Registry>,
    ambient: State<'_, Ambient>,
    ledgers: State<'_, Ledgers>,
    poker: State<'_, Poker>,
    folder: String,
    adapter: String,
) -> Composed {
    // `None` is a harvest that has not settled, and it is the only thing that
    // tells a run still starting up apart from a folder watching no map.
    let harvest_settled = ambient.token.get().is_some();
    if let Some(refusal) = why_the_check_is_not_a_read(poker.revalidate(CHECKING), harvest_settled)
    {
        return Composed::refused(refusal);
    }

    let Some(map) = ledgers.held().model.map else {
        return Composed::refused("no map is open, so there is nothing to compose");
    };
    if let Some(refusal) = why_the_spec_is_not_composable(&map) {
        return Composed::refused(refusal);
    }
    // The rung says nothing about a compose already under way: a run assigns
    // nobody and the spec is its very last act, so the map reads
    // `Phase::SpecReady` for the whole of it and every guard above this line
    // answers a second press exactly as it answered the first. The live run is
    // the only trace there is, so it is what this reads.
    if terminals.composing(map.number) {
        return Composed::refused(a_compose_is_already_open(map.number));
    }

    match compose_at(
        &app, &terminals, &harvests, &registry, &ambient, &map, &folder, &adapter,
    ) {
        Ok((run, rendered)) => {
            // Two writes and a bind, and one fewer than a work press: what this
            // run would lose, and that the ladder has a live run on it. No
            // claim, because there is nothing here to claim.
            terminals.staked(
                run,
                Stakes {
                    ticket: Some(map.number),
                    folder,
                    kind: RunKind::Compose,
                },
            );
            terminals.counting(run, poker.run_started());
            // The operator watches what they started.
            terminals.held().monitor(Some(run));

            Composed::Spawned {
                run: run.as_u64(),
                prompt: rendered,
            }
        }
        Err(refusal) => Composed::refused(refusal),
    }
}

/// Everything between the phase guard and the run, and every way it can refuse.
///
/// [`spawn_at`]'s shape with the ticket hops removed, and the removal is the
/// point: no ticket number, no ticket body and no `read_ticket_body`. The
/// coordinates are the whole of what the template gets, and what a template is
/// never given it cannot leak.
#[allow(clippy::too_many_arguments)]
fn compose_at(
    app: &AppHandle,
    terminals: &Terminals,
    harvests: &Harvests,
    registry: &Registry,
    ambient: &Ambient,
    map: &Map,
    folder: &str,
    adapter: &str,
) -> Result<(RunId, prompt::Rendered), String> {
    let repo = perseverance_store::bind_repo(Path::new(folder))
        // The store's own sentence, unedited, exactly as `poll_once` carries it.
        .map_err(|refusal| refusal.to_string())?;

    let Some(TokenOutcome::Acquired(token)) = ambient.token.get() else {
        return Err(NO_TOKEN.to_string());
    };
    let Some(operator) = remembered_login(&ambient.login, || read_login(token)) else {
        return Err(NO_OPERATOR.to_string());
    };

    let map_url = where_the_map_lives(map).ok_or_else(|| {
        format!(
            "#{} lists no child to derive its own address from, so no brief could name it",
            map.number
        )
    })?;

    // Read at the moment of spawn and never cached, which is
    // [`prompt::compose_spec_override`]'s rule and not one this file softens:
    // an operator who edits it between two presses gets the text they wrote.
    let overriding = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|directory| prompt::compose_spec_override(&directory));

    let rendered = prompt::compose_spec(
        overriding.as_deref(),
        &prompt::MapCoordinates {
            repo: format!("{}/{}", repo.owner, repo.name),
            map_number: map.number,
            map_url,
            operator,
        },
    );

    start_child(terminals, harvests, registry, folder, adapter, rendered)
}

/* --------------------------------------------------- what a quit costs --- */

/// Whether losing a run costs a claim that can be picked back up, or everything
/// it has not already posted.
///
/// Derived from the ticket, not from the process: `crates/pty` has no notion of
/// either and must not acquire one.
///
/// **Not a third vocabulary.** [`perseverance_model::TicketType`] is the noun
/// this repository already has, and `Attendance` in `src/views/route/route.ts`
/// is the same one-bit split of it the frontend already draws — its own comment
/// calls itself *a rule with exactly one home*. This is that home's Rust half
/// rather than a second rule, which is why [`RunKind::of`] exists and is the
/// only way one of these is meant to be made: the mapping is written once, here,
/// and #48 calls it instead of writing it again. The day the model carries the
/// distinction itself, both spellings move together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Work,
    Research,
    /// A charting run, which is neither: it holds no claim because there is no
    /// ticket yet, and it is the run that creates the ones the other two work.
    Chart,
    /// A spec being composed, which is no ticket at all.
    ///
    /// Chosen at the call site rather than mapped, because there is nothing to
    /// map from: [`RunKind::of`] stays the only mapping *from a ticket*, and a
    /// compose press has no ticket to hand it.
    Compose,
}

impl RunKind {
    /// The mapping, and the only one. Research runs AFK and everything else has
    /// somebody at the keyboard — the same line `attendanceOf` draws in
    /// `route.ts`, and drawn from the same enum so the two cannot drift.
    ///
    /// [`RunKind::Chart`] is deliberately not reachable from here: a charting
    /// run has no ticket to be derived from, and the day one does it will be a
    /// ticket somebody else already charted.
    pub fn of(ticket: TicketType) -> RunKind {
        match ticket {
            TicketType::Research => RunKind::Research,
            TicketType::Prototype | TicketType::Grilling | TicketType::Task => RunKind::Work,
        }
    }
}

/// What one live run would lose if the app quit now.
#[derive(Debug, Clone)]
pub struct Stakes {
    /// What the confirmation names: the ticket a work run took, or the map a
    /// compose run is writing a spec for. A number an operator can find, and
    /// never a claim — a compose run holds none.
    ///
    /// `None` is *this run names no issue at all*, which today is exactly a
    /// charting run — the one run that reaches a repository before any ticket
    /// exists. Optional rather than a sentinel number, because a run named
    /// `#0` is a run an operator would go looking for.
    pub ticket: Option<u64>,
    pub folder: String,
    pub kind: RunKind,
}

/// A work run's loss, which is not the work.
///
/// The claim is a GitHub assignment and nothing this process holds, so quitting
/// does not drop it: the next launch reads the same assignment back as a claimed
/// node with no live run beside it, and that is exactly the stranded claim
/// Resume is for. Nothing is written down to make this true, which is why there
/// is no reattach machinery to write.
const WORK_LOSS: &str = "the claim stays yours and Resume picks it up on the next launch";

/// A research run's loss, which is everything.
///
/// There is no worktree, no queue row and no transcript kept on this side, so
/// what the agent has not already posted to the ticket goes with the process.
/// The mitigation is upstream in the prompt and never here.
const RESEARCH_LOSS: &str =
    "a research run keeps nothing, so whatever it has not already posted goes with it";

/// A charting run's loss, which is the session and nothing else.
///
/// It strands no claim because it holds none — nothing is assigned until the
/// tickets it is writing exist — and it keeps nothing on this side, so what it
/// has already pushed to GitHub survives and what it has not does not. The
/// labels, the map and the tickets it managed to create are all already there.
const CHART_LOSS: &str =
    "a charting session strands no claim, and keeps nothing it has not already pushed to GitHub";

/// A composing run's loss, which is the document.
///
/// The spec is posted in one piece at the end, so a run ended before that has
/// written nothing anywhere — and the sentence may not borrow [`WORK_LOSS`]'s
/// promise, because there is no claim here for Resume to pick up and the map is
/// left exactly as `SpecReady` as it was found.
const COMPOSE_LOSS: &str =
    "a compose run posts its spec in one piece, so a spec it has not posted yet goes with it";

/// A live run this app cannot describe.
///
/// It is named anyway. A confirmation that quietly omitted a run because the
/// side table had no row for it would be a confirmation that under-reports
/// exactly when the app is most confused, and *I do not know what this costs* is
/// a thing an operator can act on where silence is not.
const UNKNOWN_LOSS: &str =
    "this app was not told what it is working on, so it cannot say what this one loses";

/// The question, as the window manager asks it.
const QUIT_TITLE: &str = "Quit perseverance?";

/// The two answers. Named for what they do rather than *OK* and *Cancel*,
/// because a destructive confirmation whose buttons are both agreements is a
/// confirmation answered by whichever one the hand was already over.
const QUIT_LABEL: &str = "Quit anyway";
const KEEP_LABEL: &str = "Keep working";

/// What one live run loses, in one sentence.
///
/// A free function over plain values rather than a method on anything, so the
/// prose is testable with no Tauri app, no PTY and no child process — which is
/// the only way it can be tested at all today, since nothing opens a run yet.
fn what_it_loses(run: RunId, stakes: Option<&Stakes>) -> String {
    match stakes {
        Some(stakes) => format!(
            "{} — {}",
            // A charting run is named by the folder it is charting, because the
            // ticket numbers it would be named by are the ones it is creating.
            match stakes.ticket {
                Some(ticket) => format!("#{ticket} in {}", stakes.folder),
                None => format!("charting {}", stakes.folder),
            },
            match stakes.kind {
                RunKind::Work => WORK_LOSS,
                RunKind::Research => RESEARCH_LOSS,
                RunKind::Chart => CHART_LOSS,
                RunKind::Compose => COMPOSE_LOSS,
            }
        ),
        // `RunId`'s own `Display` is *run 7*, which is the most this side can
        // truthfully say about a run it was never told anything about.
        None => format!("{run} — {UNKNOWN_LOSS}"),
    }
}

/// The last line, and the only place the grace is ever spoken to an operator.
///
/// The number is read off [`perseverance_pty::GRACE`] rather than written out,
/// so a figure that is a labelled guess cannot drift from the sentence that
/// describes it: change the constant and this sentence changes with it.
fn closing() -> String {
    format!(
        "each one is asked to stop first, and anything still running {} seconds later is ended",
        GRACE.as_secs()
    )
}

/// **One** confirmation, however many runs are live.
///
/// A headline saying how many there are, then one line per run, then what the
/// quit will actually do. One dialog rather than one per run for the reason the
/// grace is one deadline rather than one per run: four terminals must not cost
/// four questions, and a question asked four times is a question answered
/// without being read.
fn confirmation(losses: &[String]) -> String {
    let mut said = match losses.len() {
        1 => "one run is still live, and quitting ends it".to_string(),
        many => format!("{many} runs are still live, and quitting ends every one of them"),
    };

    for loss in losses {
        said.push_str("\n\n");
        said.push_str(loss);
    }
    said.push_str("\n\n");
    said.push_str(&closing());
    said
}

/// Whether this launch has been asked about quitting yet.
///
/// Three states and not a boolean, because *asked and waiting* is a state a
/// boolean cannot hold: the dialog is shown on its own thread, and every close
/// request that arrives while it is up has to be refused without asking a second
/// time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quit {
    NotAsked,
    Asking,
    Confirmed,
}

/// The gate on the way out.
pub struct Quitting(Mutex<Quit>);

impl Quitting {
    pub fn new() -> Quitting {
        Quitting(Mutex::new(Quit::NotAsked))
    }

    /// A poisoned lock is an earlier panic and not an answer, and the posture
    /// [`Terminals::held`] takes applies with more force here: writing this off
    /// would leave the app either unquittable or quitting unasked.
    fn held(&self) -> MutexGuard<'_, Quit> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn asked(&self) -> Quit {
        *self.held()
    }

    fn now(&self, quit: Quit) {
        *self.held() = quit;
    }

    /// The dialog is no longer up, whatever became of it.
    ///
    /// Only [`Quit::Asking`] is cleared, so an answer that already landed is not
    /// undone. This exists because *asked and waiting* is the one state that can
    /// be entered and never left: the thread that shows the dialog is the only
    /// thing that can clear it, and `blocking_show` has a `recv().unwrap()` in
    /// it, so a panic there would leave every later close request answered with
    /// *wait for the answer* — an app that can no longer be quit by any clean
    /// path, holding every PTY. Released from a `Drop` rather than from the
    /// happy path, so unwinding releases it too.
    fn no_longer_asking(&self) {
        let mut held = self.held();
        if *held == Quit::Asking {
            *held = Quit::NotAsked;
        }
    }
}

impl Default for Quitting {
    fn default() -> Quitting {
        Quitting::new()
    }
}

/// What a close request means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnClose {
    GoNow,
    Ask,
    WaitForTheAnswer,
}

/// What a close request means, given how many runs are live and what has already
/// been asked. A function rather than a branch inside the handler because
/// getting it wrong yields either an unquittable app or a confirmation that is
/// skipped, and neither is reachable from a test that needs a window.
///
/// `live` is the length of [`Terminals::losses`] and never a second count of its
/// own: the number in the headline and the sentences under it come from one
/// snapshot, so *0 runs are still live* cannot be asked.
fn on_close(live: usize, asked: &Quit) -> OnClose {
    match (live, asked) {
        // Nothing live is nothing to lose, and an app that asked anyway would be
        // an app whose confirmation means nothing by the time it matters.
        (0, _) | (_, Quit::Confirmed) => OnClose::GoNow,
        (_, Quit::Asking) => OnClose::WaitForTheAnswer,
        (_, Quit::NotAsked) => OnClose::Ask,
    }
}

/// Whether a quit may proceed, and the confirmation started if it may not yet.
///
/// **The one door out**, and there are three ways in: the window's close button,
/// macOS's Quit menu item, and the dialog's own *Quit anyway* coming back
/// through [`AppHandle::exit`]. All three ask this, so the gate cannot be
/// reached around.
///
/// Returns `true` when the caller should let the quit happen. When it returns
/// `false` the caller must **keep its window**: the whole point of asking here
/// rather than at `ExitRequested` is that the operator who answers *Keep
/// working* still has the app they were working in. `ExitRequested` arrives only
/// after the last window has already been destroyed — that is where tao emits it
/// from — so a confirmation hung off it would be a question whose safe answer
/// leaves a headless process holding every live run.
fn may_quit<R: Runtime>(app: &AppHandle<R>) -> bool {
    // One snapshot of the runs, and the count is its length. Absent state is
    // read as *already confirmed* rather than *not asked*: of the two ways to be
    // wrong about a gate that is not there, only one of them leaves a process
    // tree behind.
    let losses = app
        .try_state::<Terminals>()
        .map(|terminals| terminals.losses())
        .unwrap_or_default();
    let asked = app
        .try_state::<Quitting>()
        .map_or(Quit::Confirmed, |quitting| quitting.asked());

    match on_close(losses.len(), &asked) {
        OnClose::GoNow => true,
        OnClose::WaitForTheAnswer => false,
        OnClose::Ask => {
            ask(app.clone(), losses);
            false
        }
    }
}

/// The gate released however the asking ends, including by unwinding.
///
/// A `Drop` rather than a line at the end of the thread, because the ways the
/// asking does not reach its end are the ways that matter: `blocking_show` has a
/// `recv().unwrap()` inside it, and a panic there with nothing to clear `Asking`
/// leaves an app that answers every later close request with *wait for the
/// answer* — unquittable by any clean path, still holding every PTY.
struct Released<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Drop for Released<R> {
    fn drop(&mut self) {
        if let Some(quitting) = self.0.try_state::<Quitting>() {
            quitting.no_longer_asking();
        }
    }
}

/// Show the one confirmation, on a thread of its own.
///
/// A message box drawn from the event loop would be waiting on the very thread
/// that has to draw it — the same reason `choose_folder` is `(async)` — so the
/// answer comes back by re-entering through [`AppHandle::exit`] rather than by
/// returning.
fn ask<R: Runtime>(app: AppHandle<R>, losses: Vec<String>) {
    if let Some(quitting) = app.try_state::<Quitting>() {
        quitting.now(Quit::Asking);
    }

    std::thread::spawn(move || {
        let released = Released(app.clone());

        let quit = app
            .dialog()
            .message(confirmation(&losses))
            .title(QUIT_TITLE)
            .buttons(MessageDialogButtons::OkCancelCustom(
                QUIT_LABEL.to_string(),
                KEEP_LABEL.to_string(),
            ))
            .blocking_show();

        if quit {
            if let Some(quitting) = app.try_state::<Quitting>() {
                quitting.now(Quit::Confirmed);
            }
        }
        // Before the exit rather than at the end of the thread, so the state the
        // exit path reads is the one this answer left. A confirmed answer is not
        // undone by it.
        drop(released);

        // Back through the same door, which this time finds the gate open.
        // Asking again would be asking a question already answered.
        if quit {
            app.exit(0);
        }
    });
}

/// The id of the Quit item on the menu macOS is given.
///
/// macOS never routes its own Quit through a window: `[NSApp terminate:]` is
/// answered by tao's `applicationWillTerminate:`, which becomes `RunEvent::Exit`
/// and never `ExitRequested`, and `applicationShouldTerminate:` is not
/// implemented at all — so the default menu's predefined Quit cannot be asked
/// about, only observed on the way past. The app therefore declines the default
/// menu and owns this one item, whose handler is [`may_quit`] like every other
/// way out.
const QUIT_ITEM: &str = "perseverance-quit";

/// The menu macOS gets, because the default one has a Quit this app cannot
/// intercept.
///
/// It is the default menu minus that item and plus [`QUIT_ITEM`]. Everything
/// else is kept as predefined items rather than reinvented — the Edit submenu in
/// particular is what makes `Cmd+C` and `Cmd+V` work in a WebView on macOS, so
/// dropping it to save code would break copy and paste to buy nothing.
#[cfg(target_os = "macos")]
fn a_menu_with_our_own_quit<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, QUIT_ITEM, "Quit", true, Some("Cmd+Q"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // macOS is given a menu of this app's own, below in `setup`, and the one
        // thing it changes is the Quit item. Declining the default here is what
        // makes that possible: with neither a menu nor this call, Tauri installs
        // `Menu::default`, whose Quit is AppKit's `terminate:` — a quit that
        // reaches no handler in this file at all. On every other platform this
        // is a flag nothing reads.
        .enable_macos_default_menu(false)
        .setup(|app| {
            app.manage(Registry::open(app.handle()));
            app.manage(Ambient::harvesting());
            // Adjacent to `Ambient` and never a widening of it. `Ambient`'s two
            // `OnceLock`s are what make *one environment per launch* structural
            // for the app-global harvest, and a per-folder cache the operator
            // can explicitly forget cannot be that shape.
            app.manage(Harvests::new());
            // Before the poller, for the reason the poller is managed before
            // the harvest: `poll_once` reads both of these on every tick, and a
            // tick that arrived before they existed would be a panic rather
            // than a missed row.
            app.manage(Ledgers::new());
            app.manage(Claims::new());
            // Before the harvest, because the harvest's thread pokes the poller
            // the moment it settles and a poke into a state nobody manages yet
            // would be the first read of a launch, dropped.
            let handle = app.handle().clone();
            app.manage(perseverance_github::start(
                Timings::shipped(),
                move |watched, ahead| poll_once(&handle, watched, ahead),
            )?);
            start_harvesting(app.handle().clone())?;
            // Managed before its threads are started, for the reason the poller
            // is: a frame that arrived before this existed would be a panic
            // rather than a missed screenful.
            app.manage(Terminals::new());
            start_terminals(app.handle().clone())?;
            // The gate every way out reads. Managed here rather than lazily,
            // because a close request that found no gate would be a quit that
            // skipped the confirmation — the one failure of this machinery that
            // costs an operator something.
            app.manage(Quitting::new());
            // The one platform whose primary quit gesture never touches a
            // window. Built here rather than through `Builder::menu`, because a
            // menu set on Windows or Linux is a menu *bar* in the window and
            // this app has no use for one.
            #[cfg(target_os = "macos")]
            app.set_menu(a_menu_with_our_own_quit(app.handle())?)?;
            Ok(())
        })
        /*
         * The Quit item macOS gets. Every other menu item here is predefined and
         * answered by the operating system; this one is ours precisely so the
         * gesture goes through the same gate the window's close button does.
         *
         * `exit` is only reached when the gate is already open — either nothing
         * is live, or the confirmation has been answered — and it is safe from
         * this thread because `request_exit` posts to the event loop rather than
         * running inline.
         */
        .on_menu_event(|app, event| {
            if event.id() == QUIT_ITEM && may_quit(app) {
                app.exit(0);
            }
        })
        /*
         * Focus is read here rather than in the WebView, and that is the whole
         * of the difference. A `visibilitychange` listener would need the
         * WebView to be alive and correct to be believed, and a bug there would
         * leave the app convinced it was being watched; this is the window
         * manager's own account of itself, needs no capability the app does not
         * already have, and cannot be wrong about which window has the operator.
         */
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(has_it) => {
                if let Some(poker) = window.try_state::<Poker>() {
                    poker.poke(Poke::Attention(if *has_it {
                        Attention::Focused
                    } else {
                        Attention::Unfocused
                    }));
                }
            }
            /*
             * The confirmation, and this is the only place it can be asked
             * from.
             *
             * `RunEvent::ExitRequested` is emitted from tao's `Destroyed`, i.e.
             * after the window has already been torn down — asking there and
             * preventing the exit would leave *Keep working* meaning a headless
             * process holding every PTY, invisible, reachable only through Task
             * Manager. So the question is asked here, where `prevent_close`
             * still has a window to keep, and the exit path below is left as
             * shutdown only.
             */
            tauri::WindowEvent::CloseRequested { api, .. } if !may_quit(window.app_handle()) => {
                api.prevent_close();
            }
            _ => (),
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            maps,
            watching,
            launcher,
            remember_folder,
            forget_folder,
            relocate_folder,
            bind_repo,
            choose_folder,
            environment,
            folder_environment,
            retry_folder_environment,
            use_override,
            clear_override,
            terminal_channel,
            monitor_run,
            run_took,
            typed_at_run,
            settled_geometry,
            run_readouts,
            end_run,
            start_working,
            resume_working,
            start_charting,
            compose_spec
        ])
        .build(tauri::generate_context!())
        .expect("perseverance failed to start")
        /*
         * Every session ended before the process is. **No question is asked
         * here** — that is `CloseRequested`'s, above, because by the time either
         * of these arrives the window is already gone.
         *
         * Tauri cleans up no child of ours — its own tracker has years of issues
         * about exactly that — so this is the hook and the behaviour is entirely
         * ours. `shut_down` hangs every run up, gives them all one deadline, and
         * then drops each session, which drops its guard: on Windows that closes
         * the pseudoconsole and the job object and takes the whole tree with it.
         *
         * It blocks this thread for up to `GRACE`, and that is deliberate. The
         * event loop has nothing left to draw and the alternative is returning
         * before the children are gone, which is the orphan the whole promise is
         * about.
         *
         * **Both events, and neither is redundant.** `ExitRequested` is the way
         * out on Windows and Linux and from this app's own `exit`. `Exit` is the
         * only one macOS delivers when AppKit terminates the process — the Dock's
         * Quit and anything else that reaches `[NSApp terminate:]` produce
         * `applicationWillTerminate:`, which tao maps to `LoopDestroyed` and
         * Tauri to `Exit`, with no `ExitRequested` anywhere in it. Running the
         * shutdown twice on the ordinary path costs nothing: the second one has
         * an empty registry, takes no grace and kills nothing.
         *
         * This is the *clean* path only. It does not fire on a crash or on Task
         * Manager's End Task, which is why the guard exists as well: the kernel
         * closes a dead process's handles however it died.
         */
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(terminals) = app.try_state::<Terminals>() {
                    terminals.held().shut_down();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A login this run did not learn is not an answer, and the cell that holds
    /// one is only allowed to remember answers. The failing reader here stands
    /// in for every way [`perseverance_github::read_login`] returns `None` — a
    /// DNS blip, a TLS reset, a timeout, a 502, a 429 — and the press after it
    /// has to be able to ask again, because otherwise one cold network at one
    /// unlucky moment is what Start Working says for the life of the process.
    #[test]
    fn a_login_that_was_not_learned_is_asked_for_again() {
        let cell = OnceLock::new();

        assert_eq!(remembered_login(&cell, || None), None);

        let mut asked = false;
        let second = remembered_login(&cell, || {
            asked = true;
            Some("javrasya".to_string())
        });

        assert!(asked, "the second press has to reach the reader");
        assert_eq!(second, Some("javrasya".to_string()));
    }

    /// The other half of the same rule: an answer *is* remembered, so the round
    /// trip belongs to the press that got one and every press after it is a read
    /// rather than a second trip to GitHub.
    #[test]
    fn a_login_that_was_learned_is_never_asked_for_twice() {
        let cell = OnceLock::new();

        assert_eq!(
            remembered_login(&cell, || Some("javrasya".to_string())),
            Some("javrasya".to_string())
        );

        let second = remembered_login(&cell, || panic!("the second press must not ask"));

        assert_eq!(second, Some("javrasya".to_string()));
    }

    /// The only Rust types the WebView ever sees are the ones in this file, and
    /// `src/launcher/launcher.ts` is a hand-written mirror of them. A rename
    /// here is a silent breakage there, so the shapes are pinned from this side
    /// as well as from the TypeScript side.
    #[test]
    fn a_launcher_row_crosses_in_the_shape_the_frontend_declares() {
        let entry = FolderEntry::from(Folder {
            id: 3,
            path: "/volumes/backup/perseverance".to_string(),
            adapter: None,
            last_opened: 1_770_000_000,
        });

        let json = serde_json::to_value(&entry).expect("serialises");

        assert_eq!(json["id"], 3);
        assert_eq!(json["path"], "/volumes/backup/perseverance");
        assert_eq!(json["name"], "perseverance");
        assert_eq!(json["adapter"], serde_json::Value::Null);
        assert_eq!(json["lastOpened"], 1_770_000_000_i64);
        // Nothing answers to that path here, and presence is asked of the disk
        // rather than stored, so this row crosses as missing.
        assert_eq!(json["present"], false);
        assert_eq!(json.as_object().expect("an object").len(), 6);
    }

    /// #48's answer is hand-mirrored in TypeScript rather than generated, so
    /// both shapes are pinned from this side — including the refusal's
    /// frontier, which is the value the button re-arms on and asks for a second
    /// press.
    #[test]
    fn what_start_working_answers_crosses_in_the_shape_the_frontend_declares() {
        let spawned = serde_json::to_value(Started::Spawned {
            run: 7,
            prompt: prompt::Rendered {
                text: "work #48".to_string(),
                characters: 8,
                origin: prompt::Origin::Custom,
            },
        })
        .expect("serialises");

        assert_eq!(spawned["kind"], "spawned");
        assert_eq!(spawned["run"], 7);
        assert_eq!(spawned["prompt"]["text"], "work #48");
        assert_eq!(spawned["prompt"]["characters"], 8);
        // The badge, and the only reason a run under an operator's own prose is
        // diagnosable from a screenshot.
        assert_eq!(spawned["prompt"]["origin"], "custom");
        assert_eq!(spawned.as_object().expect("an object").len(), 3);

        let moved = serde_json::to_value(Started::refused(
            "#48 is not what this map offers to start any more",
            Some(Frontier::Designated(91)),
        ))
        .expect("serialises");

        assert_eq!(moved["kind"], "refused");
        assert_eq!(
            moved["detail"],
            "#48 is not what this map offers to start any more"
        );
        assert_eq!(moved["frontier"]["frontier"], "designated");
        assert_eq!(moved["frontier"]["number"], 91);

        // And the refusal that learned no target names none, rather than
        // reporting the last one anybody happened to know.
        let unchecked =
            serde_json::to_value(Started::refused("nothing landed", None)).expect("serialises");

        assert_eq!(unchecked["frontier"], serde_json::Value::Null);
    }

    use perseverance_model::{Counts, Cut, Fog, Node, NodeState};

    fn a_child(url: &str) -> Node {
        Node {
            number: 66,
            title: "a closed ticket".to_string(),
            url: url.to_string(),
            kind: ChildKind::Ticket(TicketType::Task),
            state: NodeState::Resolved,
            waits_on: Vec::new(),
            bound_elsewhere: false,
            cut: Cut::InScope,
        }
    }

    fn a_map_of(phase: Phase, nodes: Vec<Node>) -> Map {
        Map {
            number: 28,
            title: "a map".to_string(),
            closed: matches!(phase, Phase::Done),
            phase,
            counts: Counts {
                tickets: nodes.len(),
                open: 0,
                specs: 0,
            },
            nodes,
            frontier: Frontier::NothingToStart,
            fog: Fog::Unsurveyed,
        }
    }

    fn a_map_in(phase: Phase) -> Map {
        a_map_of(
            phase,
            vec![a_child(
                "https://github.com/javrasya/perseverance/issues/66",
            )],
        )
    }

    /// The ladder, one rung at a time. `SpecReady` is the only rung a compose
    /// spawns from, and the other four each have to say what is actually true:
    /// a refusal that only says *not now* is one an operator cannot act on.
    #[test]
    fn a_spec_composes_on_a_finished_map_and_the_other_four_rungs_say_why_not() {
        assert_eq!(
            why_the_spec_is_not_composable(&a_map_in(Phase::SpecReady)),
            None
        );

        let open = why_the_spec_is_not_composable(&a_map_in(Phase::Wayfinding)).expect("a refusal");
        assert!(open.contains("#28"), "{open}");
        assert!(open.contains("still has open tickets"), "{open}");

        let twice = why_the_spec_is_not_composable(&a_map_in(Phase::Specced)).expect("a refusal");
        assert!(twice.contains("already has a spec"), "{twice}");

        let empty = why_the_spec_is_not_composable(&a_map_in(Phase::Unstarted)).expect("a refusal");
        assert!(empty.contains("nothing has been charted"), "{empty}");

        let done = why_the_spec_is_not_composable(&a_map_in(Phase::Done)).expect("a refusal");
        assert!(done.contains("is closed"), "{done}");
    }

    /// The map's address is rebuilt from a sibling GitHub itself sent, because
    /// the map's own URL never crosses the seam — and a map that sent no
    /// sibling names nothing rather than having an address invented for it.
    #[test]
    fn a_map_names_itself_through_a_child_and_says_nothing_when_it_has_none() {
        assert_eq!(
            where_the_map_lives(&a_map_in(Phase::SpecReady)).as_deref(),
            Some("https://github.com/javrasya/perseverance/issues/28")
        );

        // Nothing to replace the last segment of is carried across whole rather
        // than mangled into an address that resolves somewhere else.
        assert_eq!(
            where_the_map_lives(&a_map_of(Phase::SpecReady, vec![a_child("66")])).as_deref(),
            Some("66")
        );

        // Unreachable on a `SpecReady` map — zero tickets and zero specs reads
        // `Unstarted` — and refused rather than unwrapped anyway.
        assert_eq!(
            where_the_map_lives(&a_map_of(Phase::SpecReady, Vec::new())),
            None
        );
    }

    /// #66's answer is hand-mirrored in TypeScript by the slice that presses
    /// this button, so the shape is pinned from this side — including the
    /// field count, which is how the *no frontier here* decision stays a
    /// decision rather than an omission somebody later fills in.
    #[test]
    fn what_compose_spec_answers_crosses_in_the_shape_the_frontend_declares() {
        let spawned = serde_json::to_value(Composed::Spawned {
            run: 3,
            prompt: prompt::Rendered {
                text: "compose #28".to_string(),
                characters: 11,
                origin: prompt::Origin::Custom,
            },
        })
        .expect("serialises");

        assert_eq!(spawned["kind"], "spawned");
        assert_eq!(spawned["run"], 3);
        assert_eq!(spawned["prompt"]["text"], "compose #28");
        assert_eq!(spawned["prompt"]["characters"], 11);
        // The badge, and the only reason a run under an operator's own prose is
        // diagnosable from a screenshot.
        assert_eq!(spawned["prompt"]["origin"], "custom");
        assert_eq!(spawned.as_object().expect("an object").len(), 3);

        let refused = serde_json::to_value(Composed::refused(
            "#28 already has a spec, so there is nothing left to compose",
        ))
        .expect("serialises");

        assert_eq!(refused["kind"], "refused");
        assert_eq!(
            refused["detail"],
            "#28 already has a spec, so there is nothing left to compose"
        );
        // Two fields and no third: a compose press has no frontier, so there is
        // no null here for the other side to read as one.
        assert_eq!(refused.as_object().expect("an object").len(), 2);
    }

    /// A compose run holds no claim, so it may not borrow the work run's
    /// promise that Resume picks something back up. What it loses is the
    /// document nobody has posted yet.
    #[test]
    fn a_compose_run_loses_the_unposted_document_and_never_names_a_claim() {
        let loss = what_it_loses(
            RunId::from_u64(3),
            Some(&a_stake(28, "perseverance", RunKind::Compose)),
        );

        // The map, so the confirmation names something an operator can find
        // rather than a run id.
        assert!(loss.contains("#28"), "{loss}");
        assert!(loss.contains("perseverance"), "{loss}");
        assert!(loss.contains("has not posted yet"), "{loss}");
        assert!(!loss.contains("claim"), "{loss}");
    }

    /// Every answer the awaited revalidation can give, told apart — which is
    /// the whole point of the gate: one of these five is a spawn and the other
    /// four are four different things to tell an operator.
    #[test]
    fn a_check_that_is_not_a_read_says_which_of_the_four_it_was() {
        // A read is the only answer that is not a refusal, budget or no budget.
        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::Ticked(Tick::Read(None)), true),
            None
        );

        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::NotInTime, true).as_deref(),
            Some("the check of GitHub did not land in time, so nothing was started")
        );

        // Not a timeout and not a failure: nothing was asked, because nothing
        // is being watched.
        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::Ticked(Tick::NotAttempted), true).as_deref(),
            Some("no map is being watched, so there was nothing to check and nothing was started")
        );

        // The same `NotAttempted`, from the other of its two sources: the token
        // harvest has not settled, so this launch has nothing to read GitHub
        // with yet. Telling this operator that no map is being watched would
        // send them to the app for a state that is one second of startup.
        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::Ticked(Tick::NotAttempted), false).as_deref(),
            Some(
                "this run has not finished starting up, so nothing was checked and nothing was \
                 started"
            )
        );

        // And it is the one sentence, not a copy of it: `chart_in` has no
        // pre-guard ahead of it, so it says this for itself off the same const.
        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::Ticked(Tick::NotAttempted), false).as_deref(),
            Some(STILL_STARTING_UP)
        );

        // And the read that landed and was refused names the fault, so this
        // sentence and the `Degraded` condition on the graph agree. A revoked
        // token used to print the timeout sentence above.
        assert_eq!(
            why_the_check_is_not_a_read(Revalidated::Ticked(Tick::Failed(Fault::AuthFailed)), true)
                .as_deref(),
            Some("GitHub would not accept this run's credentials, so nothing was started")
        );
    }

    /// Each fault as its own sentence, including the two a rate limit has.
    #[test]
    fn each_fault_a_check_can_land_on_is_named_rather_than_collapsed() {
        assert_eq!(
            what_github_refused(Fault::Unreachable),
            "GitHub could not be reached, so nothing was started"
        );
        assert_eq!(
            what_github_refused(Fault::MapGone),
            "GitHub no longer has the map this folder is watching, so nothing was started"
        );
        assert_eq!(
            what_github_refused(Fault::RateLimited {
                seconds_to_reset: 42
            }),
            "GitHub's rate limit is spent for another 42s, so nothing was started"
        );
        // Zero is `Fault::of`'s *no moment was named*, and a wait of zero
        // seconds is not what an operator should be told to do.
        assert_eq!(
            what_github_refused(Fault::RateLimited {
                seconds_to_reset: 0
            }),
            "GitHub's rate limit is spent, so nothing was started"
        );
    }

    #[test]
    fn each_repo_binding_crosses_as_the_tag_the_launcher_switches_on() {
        let bindings = [
            (
                RepoBinding::from(RepoBindingError::NotAGitRepo),
                "notAGitRepo",
            ),
            (
                RepoBinding::from(RepoBindingError::NoGitHubRemote),
                "noGitHubRemote",
            ),
            (
                RepoBinding::from(RepoBindingError::AmbiguousRemotes {
                    candidates: vec!["origin".to_string(), "upstream".to_string()],
                }),
                "ambiguousRemotes",
            ),
        ];

        for (binding, tag) in bindings {
            let json = serde_json::to_value(&binding).expect("serialises");
            assert_eq!(json["kind"], tag);
        }

        let bound = serde_json::to_value(RepoBinding::Bound {
            owner: "javrasya".to_string(),
            name: "perseverance".to_string(),
        })
        .expect("serialises");
        assert_eq!(bound["kind"], "bound");
        assert_eq!(bound["owner"], "javrasya");
        assert_eq!(bound["name"], "perseverance");
    }

    /* -------------------------------------------------------------- maps --- */

    const TWO_MAPS: &str = include_str!("../../model/fixtures/two-maps-one-open.json");

    /// An answer whose only truncation is a label list, written here rather than
    /// recorded as a fixture: `crates/model/fixtures/` is a directory the model
    /// crate's own tests walk and enumerate, and a tenth file in it that no
    /// generated snapshot corresponds to is a failure there for a reason that
    /// has nothing to do with this assertion.
    const LABELS_RAN_LONG: &str = r#"{
        "data": {
            "repository": {
                "maps": { "pageInfo": { "hasNextPage": false }, "nodes": [] },
                "issue": {
                    "number": 28,
                    "title": "Spec: perseverance",
                    "labels": {
                        "pageInfo": { "hasNextPage": true },
                        "nodes": [ { "name": "wayfinder:map" } ]
                    },
                    "subIssues": { "pageInfo": { "hasNextPage": false }, "nodes": [] }
                }
            },
            "rateLimit": null
        }
    }"#;

    /// The only way to hold one, here as anywhere: an answer from GitHub that
    /// parsed. There is no constructor, which is the whole mechanism this slice
    /// rests on — so a test that wants one has to produce an answer too.
    fn a_fresh_read(body: &str, fetched_at: i64) -> FreshRead {
        perseverance_github::interpret_read(
            Ok(perseverance_github::Answer {
                status: 200,
                body: body.to_string(),
                retry_after: None,
                rate_limit_remaining: None,
                rate_limit_reset: None,
            }),
            fetched_at,
            map_read_query_id(),
        )
        .expect("reads")
    }

    fn registry_with_a_folder() -> (Store, i64) {
        let store = Store::open_in_memory().expect("opens");
        let folder = store
            .remember_folder(Path::new("/work/perseverance"))
            .expect("remembers");
        (store, folder.id)
    }

    /// `src/maps/maps.ts` is a hand-written mirror of this, pinned from both
    /// sides for the same reason [`FolderEntry`] is.
    #[test]
    fn a_map_row_crosses_in_the_shape_the_frontend_declares() {
        let read = read_response(TWO_MAPS).expect("reads");
        let view = MapsView::of(3, &read, Source::Github, 1_785_888_000);

        let json = serde_json::to_value(&view).expect("serialises");

        assert_eq!(json["folderId"], 3);
        assert_eq!(json["provenance"]["source"], "github");
        assert_eq!(json["provenance"]["outcome"]["kind"], "ok");
        assert_eq!(json["provenance"]["fetchedAt"], "2026-08-05T00:00:00Z");
        assert_eq!(json["truncated"], false);
        // Two flags and not one, because the sentence each draws is different.
        assert_eq!(json["labelsTruncated"], false);
        assert_eq!(json["rateLimit"]["remaining"], 4_417);
        assert_eq!(json["rateLimit"]["resetAt"], "2026-08-05T11:02:14Z");
        // A view nobody has told which floor held the poller says *not
        // yielding*, which is what the `maps` command answers because there is
        // no poller behind it.
        assert_eq!(json["yieldingToRateLimit"], false);

        let first = &json["maps"][0];
        assert_eq!(first["number"], 28);
        assert_eq!(first["title"], "Spec: perseverance");
        assert_eq!(first["closed"], false);
        assert_eq!(first["url"], "https://github.com/o/r/issues/28");
        assert_eq!(first["updatedAt"], "2026-08-05T09:12:44Z");
        assert_eq!(first.as_object().expect("an object").len(), 5);
        // The finished map is in the list rather than filtered out of it.
        assert_eq!(json["maps"][1]["closed"], true);
        assert_eq!(json.as_object().expect("an object").len(), 7);
    }

    /// The two truncation readings are two fields because they are two
    /// sentences, and this is what stops the can-happen one being folded into
    /// the caveat that says an impossible thing happened.
    #[test]
    fn a_label_list_that_ran_long_crosses_apart_from_a_page_that_cannot_exist() {
        let read = read_response(LABELS_RAN_LONG).expect("reads");
        let view = MapsView::of(3, &read, Source::Github, 1_785_888_000);

        let json = serde_json::to_value(&view).expect("serialises");

        assert_eq!(json["labelsTruncated"], true);
        // Nothing overran a cap here — GitHub kept every promise it makes about
        // page sizes — so the caveat that says otherwise stays unsaid.
        assert_eq!(json["truncated"], false);
    }

    /// `src/terminal/runs.ts` is a hand-written mirror of this, pinned from both
    /// sides for the same reason [`FolderEntry`] is.
    ///
    /// Every field is a count or a flag. **There is no field on it that carries
    /// a byte**, and that absence is the rule rather than an economy: truncation
    /// and desync are facts *about* a stream, and a terminal that had either of
    /// them written into its buffer would be a terminal whose contents are no
    /// longer only what the agent said — with nothing afterwards able to tell
    /// the two apart.
    #[test]
    fn a_run_readout_crosses_in_the_shape_the_frontend_declares() {
        let readout = RunReadout {
            run: 4,
            held: 2_048,
            dropped: 1_024,
            through: 3_000,
            end: 3_072,
            truncated: true,
            desynced: true,
            over: true,
            code: Some(0),
            monitored: true,
            ending: Ending::ExitedUnresolved,
            ticket: Some(48),
            folder: Some("/work/repo".to_string()),
        };

        let json = serde_json::to_value(&readout).expect("serialises");

        assert_eq!(json["run"], 4);
        assert_eq!(json["held"], 2_048);
        assert_eq!(json["dropped"], 1_024);
        assert_eq!(json["through"], 3_000);
        assert_eq!(json["end"], 3_072);
        assert_eq!(json["truncated"], true);
        assert_eq!(json["desynced"], true);
        assert_eq!(json["over"], true);
        assert_eq!(json["code"], 0);
        assert_eq!(json["monitored"], true);
        // A tagged string and not a pair of booleans: `over` is the process and
        // `ending` is what this app makes of it, and a WebView handed both
        // halves would be a second place the crossing is derived.
        assert_eq!(json["ending"], "exitedUnresolved");
        // The join to a node, and the two values on a readout that make it:
        // without them the rail cannot tell a claim with a live terminal from a
        // claim with none — and without the folder it cannot tell this
        // repository's `#48` from another repository's.
        assert_eq!(json["ticket"], 48);
        assert_eq!(json["folder"], "/work/repo");
        assert_eq!(json.as_object().expect("an object").len(), 13);

        for (ending, spelt) in [
            (Ending::Live, "live"),
            (Ending::Spent, "spent"),
            (Ending::ExitedUnresolved, "exitedUnresolved"),
            (Ending::Exited, "exited"),
        ] {
            let crossed = serde_json::to_value(RunReadout {
                ending,
                ..readout.clone()
            })
            .expect("serialises")["ending"]
                .clone();
            assert_eq!(crossed, spelt);
        }

        // A run still going says so by having no code rather than by a zero,
        // which is a real exit status and the commonest one there is.
        let running = RunReadout {
            over: false,
            code: None,
            ..readout.clone()
        };
        assert!(serde_json::to_value(running).expect("serialises")["code"].is_null());

        // A run this app was never told the stakes of names no ticket and no
        // folder, rather than a zero and an empty string that would join it to a
        // node nobody staked, in a repository nobody named.
        let unstaked = RunReadout {
            ticket: None,
            folder: None,
            ..readout
        };
        let crossed = serde_json::to_value(unstaked).expect("serialises");
        assert!(crossed["ticket"].is_null());
        assert!(crossed["folder"].is_null());
    }

    /// The framing is a header and then the bytes, and the header is ten bytes.
    ///
    /// Asserted byte for byte because `src/terminal/runs.ts` reads it with a
    /// `DataView` and hard-coded offsets: this is the one seam in the app where
    /// a field moving by one byte is not a type error on either side, it is a
    /// terminal full of garbage.
    #[test]
    fn a_delivery_is_framed_as_a_header_and_then_the_stream_untouched() {
        let carried = framed(&Delivery::Continues {
            bytes: b"hi".to_vec(),
            through: 1_234,
        })
        .expect("something to send");

        assert_eq!(carried[0], 0, "continues");
        assert_eq!(carried[1], 0, "not truncated");
        assert_eq!(&carried[2..10], &1_234u64.to_be_bytes());
        // The bytes cross exactly as they came off the wire. Anything this side
        // rewrote would be a stream the terminal renders differently from the
        // one the agent produced.
        assert_eq!(&carried[10..], b"hi");

        let replayed = framed(&Delivery::Replay {
            bytes: b"whole ring".to_vec(),
            through: 10,
            truncated: true,
        })
        .expect("something to send");

        assert_eq!(replayed[0], 1, "replay");
        assert_eq!(replayed[1], 1, "truncated");
        assert_eq!(&replayed[10..], b"whole ring");

        // Nothing to say is nothing sent, rather than a header with no bytes
        // after it — an empty write is still a message, and a channel that
        // carried sixty of them a second would be a channel doing nothing
        // sixty times a second.
        assert_eq!(framed(&Delivery::Nothing), None);
    }

    /// The clause on the stamp appears only while the budget is the winning
    /// term, so the flag it keys on has to be exactly *the budget won* and never
    /// *a budget exists*.
    #[test]
    fn a_view_says_the_budget_is_holding_it_only_while_the_budget_is() {
        let read = read_response(TWO_MAPS).expect("reads");

        let held = [
            (Held::Budget, true),
            (Held::Ladder, false),
            // Named rather than left to a wildcard: #40's backoff is a different
            // reason to be waiting, and it must not inherit this ticket's copy.
            (Held::Backoff, false),
        ];

        for (floor, expected) in held {
            let view = MapsView::of(3, &read, Source::Github, 1_785_888_000).yielding(floor);
            let json = serde_json::to_value(&view).expect("serialises");

            assert_eq!(json["yieldingToRateLimit"], expected, "{floor:?}");
        }
    }

    #[test]
    fn a_folder_nothing_has_been_read_for_crosses_as_an_absence_and_not_as_an_empty_list() {
        let (store, folder_id) = registry_with_a_folder();

        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");

        // *Nobody has looked* and *there are no maps here* are different facts,
        // and the source is the field that keeps them apart.
        assert_eq!(json["provenance"]["source"], "none");
        assert_eq!(json["provenance"]["outcome"]["kind"], "notAttempted");
        assert_eq!(json["provenance"]["fetchedAt"], serde_json::Value::Null);
        assert_eq!(json["maps"].as_array().expect("an array").len(), 0);
    }

    #[test]
    fn the_first_paint_after_a_read_comes_from_the_cache_and_says_so() {
        let (store, folder_id) = registry_with_a_folder();

        remember_read(
            &store,
            folder_id,
            None,
            &a_fresh_read(TWO_MAPS, 1_785_888_000),
        )
        .expect("caches");

        // The same bytes, read back the way the next launch will read them.
        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");
        assert_eq!(json["provenance"]["source"], "cache");
        assert_eq!(json["provenance"]["fetchedAt"], "2026-08-05T00:00:00Z");
        assert_eq!(json["maps"][0]["number"], 28);
    }

    /// The rule, mechanically. A read that failed has no [`FreshRead`] to pass,
    /// so the only thing it can do to the cache is nothing.
    #[test]
    fn a_read_that_did_not_succeed_leaves_the_cache_exactly_as_it_was() {
        let (store, folder_id) = registry_with_a_folder();
        remember_read(&store, folder_id, None, &a_fresh_read(TWO_MAPS, 100)).expect("caches");
        let before = store.cached_graph(folder_id, None).expect("reads");

        let failed = perseverance_github::interpret_read(
            Ok(perseverance_github::Answer {
                status: 401,
                body: "{\"message\":\"Bad credentials\"}".to_string(),
                retry_after: None,
                rate_limit_remaining: None,
                rate_limit_reset: None,
            }),
            200,
            map_read_query_id(),
        );
        let refusal = failed.expect_err("refuses");
        let held = from_cache(&store, folder_id).stale(refusal.degraded(), refusal.to_string());

        assert_eq!(store.cached_graph(folder_id, None).expect("reads"), before);
        // What was read last time is still on screen; only the stamp moved.
        let json = serde_json::to_value(held).expect("serialises");
        assert_eq!(json["provenance"]["source"], "cache");
        assert_eq!(json["provenance"]["outcome"]["kind"], "failed");
        // A 401 stops rather than backs off, and the sentence beside it is
        // still `read.rs`'s own rather than one composed here.
        assert_eq!(
            json["provenance"]["outcome"]["reason"]["reason"],
            "authFailed"
        );
        assert!(json["provenance"]["outcome"]["detail"]
            .as_str()
            .expect("a sentence")
            .contains("Bad credentials"));
        assert_eq!(json["provenance"]["fetchedAt"], "1970-01-01T00:01:40Z");
        assert_eq!(json["maps"][0]["number"], 28);
    }

    /* ------------------------------------------------ poll_once, for real --- */

    use perseverance_github::TokenRefusal;
    use std::sync::mpsc::{self, Receiver};
    use tauri::test::{mock_app, MockRuntime};
    use tauri::Listener;

    /// A window with a registry and an ambient of this test's choosing, and
    /// every view [`poll_once`] emits into it.
    ///
    /// `poll_once` is the only place in this workspace where the refusals that
    /// never reach a socket are classified, and it takes an `AppHandle` — so
    /// until `tauri/test` was a dev-dependency the only assertions available to
    /// a test were restatements of the values it had written down itself. This
    /// stands a real window up, so every assertion below consumes a value
    /// `poll_once` produced.
    struct Window {
        app: tauri::App<MockRuntime>,
        emitted: Receiver<serde_json::Value>,
        snapshots: Receiver<serde_json::Value>,
    }

    impl Window {
        fn holding(registry: Registry, ambient: Ambient) -> Window {
            let app = mock_app();
            app.manage(registry);
            app.manage(ambient);
            app.manage(Ledgers::new());
            app.manage(Claims::new());

            let (tx, emitted) = mpsc::channel();
            app.listen(MAPS_EVENT, move |event| {
                let _ = tx.send(serde_json::from_str(event.payload()).expect("a view"));
            });
            let (tx, snapshots) = mpsc::channel();
            app.listen(SNAPSHOT_EVENT, move |event| {
                let _ = tx.send(serde_json::from_str(event.payload()).expect("a snapshot"));
            });

            Window {
                app,
                emitted,
                snapshots,
            }
        }

        /// A window whose registry opened, over a folder at `path`.
        fn over(path: &Path, ambient: Ambient) -> (Window, i64) {
            let store = Store::open_in_memory().expect("opens");
            let folder = store.remember_folder(path).expect("remembers");
            let registry = Registry {
                opened: Ok(Mutex::new(store)),
            };
            (Window::holding(registry, ambient), folder.id)
        }

        /// One poll: the tick it returned, and the view it put on screen.
        ///
        /// `Held::Ladder` for the floor because none of these tests is about
        /// the cadence — the tables in `cadence.rs` own that — and every return
        /// stamps whatever `ahead` answers without reading it.
        fn poll(&self, folder_id: i64) -> (Tick, serde_json::Value) {
            let ahead = |_: Tick| Held::Ladder;
            let tick = poll_once(
                self.app.handle(),
                &Watched {
                    folder_id,
                    map: None,
                },
                &ahead,
            );
            let view = self
                .emitted
                .try_recv()
                .expect("every return of poll_once emits a view");
            // Both surfaces, from every return. A failing branch that emitted
            // one and forgot the other would leave a fresh graph beside a stale
            // list, or a stale graph nobody was told about.
            self.snapshots
                .try_recv()
                .expect("every return of poll_once emits a snapshot");
            (tick, view)
        }
    }

    /// A registry whose file would not open, in a sentence of the shape the
    /// store writes. It never reaches `local_refusal` as anything but a string.
    const REGISTRY_CLOSED: &str = "the launcher registry could not be opened";

    /// A config naming one repository on GitHub, so `bind_repo` gets past the
    /// binding and the token branch is the next thing `poll_once` reaches.
    const BOUND_TO_GITHUB: &str = "[remote \"origin\"]
	url = https://github.com/javrasya/perseverance.git
";

    /// A real git repository whose remotes name nothing on GitHub.
    const NO_GITHUB_REMOTE: &str = "[remote \"origin\"]
	url = git@example.com:someone/thing.git
";

    /// A harvest that settled on `outcome`, or one that has not settled at all.
    fn ambient_with(outcome: Option<TokenOutcome>) -> Ambient {
        let ambient = Ambient::harvesting();
        if let Some(outcome) = outcome {
            ambient.token.set(outcome).expect("nothing set it first");
        }
        ambient
    }

    /// A folder on disk with the `.git/config` this test wants it to have, or
    /// none at all. Returned whole, because dropping it deletes the directory.
    fn folder_with(config: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a directory");
        if let Some(config) = config {
            let git = dir.path().join(".git");
            std::fs::create_dir_all(&git).expect("a .git");
            std::fs::write(git.join("config"), config).expect("a config");
        }
        dir
    }

    /// The condition and the sentence a view carries, as the WebView reads them.
    fn condition(view: &serde_json::Value) -> (String, String) {
        let outcome = &view["provenance"]["outcome"];
        assert_eq!(outcome["kind"], "failed", "{view}");
        (
            outcome["reason"]["reason"]
                .as_str()
                .expect("a condition")
                .to_string(),
            outcome["detail"].as_str().expect("a sentence").to_string(),
        )
    }

    /// **Every refusal that never reaches a socket, driven through the function
    /// that classifies it.**
    ///
    /// Four of the five local refusals are reachable without a network, and all
    /// four are here: a registry that will not open, a folder id nothing
    /// answers to, a folder with no usable `.git`, and a folder whose remotes
    /// name nothing on GitHub. Each has to answer a *retryable* condition — a
    /// folder whose drive is unplugged is not a reason to stop reading GitHub —
    /// and each has to carry the refusing crate's own sentence unedited, which
    /// is what the screen prints. A folder that names no GitHub remote being
    /// classified `MapGone`, and so stopping the poller for the life of the
    /// process, is the failure this exists to catch.
    ///
    /// The fifth, a cache write the registry declined, needs a store that
    /// breaks mid-session; it is covered by `local_refusal`'s own table below
    /// rather than through here.
    #[test]
    fn every_refusal_that_never_reaches_a_socket_still_names_the_condition_it_is() {
        // A registry that would not open at all. Nothing was ever read, so the
        // view is the empty one and the sentence is the registry's.
        let closed = Window::holding(
            Registry {
                opened: Err(REGISTRY_CLOSED.to_string()),
            },
            ambient_with(None),
        );
        let (tick, view) = closed.poll(7);
        assert_eq!(tick, Tick::Failed(Fault::Unreachable));
        assert_eq!(view["provenance"]["source"], "none");
        assert_eq!(
            condition(&view),
            ("unreachable".to_string(), REGISTRY_CLOSED.to_string())
        );

        // A folder id nothing on the list answers to.
        let here = folder_with(Some(BOUND_TO_GITHUB));
        let (window, folder_id) = Window::over(here.path(), ambient_with(None));
        let (tick, view) = window.poll(folder_id + 1_000);
        assert_eq!(tick, Tick::Failed(Fault::Unreachable));
        assert_eq!(
            condition(&view),
            (
                "unreachable".to_string(),
                StoreError::UnknownFolder(folder_id + 1_000).to_string()
            )
        );

        // The two the store establishes about a folder on this disk. Neither
        // ever reached GitHub, and neither may say it failed to.
        for (config, refusal) in [
            (None, RepoBindingError::NotAGitRepo),
            (Some(NO_GITHUB_REMOTE), RepoBindingError::NoGitHubRemote),
        ] {
            let dir = folder_with(config);
            let (window, folder_id) = Window::over(dir.path(), ambient_with(None));

            let (tick, view) = window.poll(folder_id);

            assert_eq!(tick, Tick::Failed(Fault::Unreachable), "{refusal}");
            assert_eq!(
                condition(&view),
                ("unreachable".to_string(), refusal.to_string()),
                "{refusal}"
            );
        }
    }

    /// The two returns the token branch owns, which are not failures of a read.
    ///
    /// A harvest that has not settled has not failed to reach GitHub — it has
    /// not asked yet — so nothing is stamped and the copy keeps the age it had.
    /// A harvest that settled on *no token* is `AuthFailed`, which stops rather
    /// than backs off, because the remedy is `gh auth login` and no amount of
    /// waiting is it.
    #[test]
    fn a_launch_with_no_token_yet_stamps_nothing_and_one_with_none_at_all_stops() {
        let here = folder_with(Some(BOUND_TO_GITHUB));

        let (waiting, folder_id) = Window::over(here.path(), ambient_with(None));
        let (tick, view) = waiting.poll(folder_id);
        assert_eq!(tick, Tick::NotAttempted);
        assert_eq!(view["provenance"]["outcome"]["kind"], "notAttempted");

        let (refused, folder_id) = Window::over(
            here.path(),
            ambient_with(Some(TokenOutcome::Refused(TokenRefusal::NoToken))),
        );
        let (tick, view) = refused.poll(folder_id);
        assert_eq!(tick, Tick::Failed(Fault::AuthFailed));
        assert_eq!(
            condition(&view),
            ("authFailed".to_string(), ReadFailure::NoToken.to_string())
        );
    }

    /// The classification itself, over every sentence that reaches it.
    ///
    /// [`poll_once`] drives four of these for real above; this is the rule they
    /// all go through, including the cache write no test can break a store
    /// into. Two things can fail here: the condition ceasing to be retryable,
    /// and the sentence ceasing to be the refusing crate's own.
    #[test]
    fn a_refusal_established_without_a_socket_is_retryable_and_keeps_its_own_words() {
        for said in [
            "the launcher registry could not be written".to_string(),
            StoreError::UnknownFolder(3).to_string(),
            RepoBindingError::NotAGitRepo.to_string(),
            RepoBindingError::NoGitHubRemote.to_string(),
            RepoBindingError::AmbiguousRemotes {
                candidates: vec!["origin".to_string(), "upstream".to_string()],
            }
            .to_string(),
        ] {
            let (reason, why) = local_refusal(said.clone());

            assert_eq!(reason, Degraded::Unreachable, "{said}");
            // Verbatim. The condition is this app's conclusion about whether
            // waiting helps; the sentence is the refusing crate's account of
            // what happened, and an operator reads both.
            assert_eq!(why, said);
        }

        // And the one whose remedy is a command rather than a wait.
        assert_eq!(ReadFailure::NoToken.degraded(), Degraded::AuthFailed);
    }

    #[test]
    fn a_map_the_last_successful_read_no_longer_lists_is_dropped_by_that_read() {
        let (store, folder_id) = registry_with_a_folder();
        // A map that was cached under its own number by an earlier read.
        store
            .cache_graph(
                folder_id,
                Some(99),
                &CachedBody {
                    graph_json: "a map that has since gone",
                    fetched_at: 10,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        remember_read(&store, folder_id, None, &a_fresh_read(TWO_MAPS, 100)).expect("caches");

        assert_eq!(
            store.cached_graph(folder_id, Some(99)).expect("reads"),
            None
        );
    }

    #[test]
    fn a_cached_body_that_cannot_be_read_is_reported_rather_than_deleted() {
        let (store, folder_id) = registry_with_a_folder();
        remember_read(&store, folder_id, None, &a_fresh_read(TWO_MAPS, 100)).expect("caches");
        store
            .cache_graph(
                folder_id,
                None,
                &CachedBody {
                    graph_json: "<html>a proxy got at it</html>",
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("overwrites with something unreadable");

        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");

        assert_eq!(json["provenance"]["source"], "cache");
        assert_eq!(json["provenance"]["outcome"]["kind"], "failed");
        // Only a successful GitHub read may delete anything, and that rule has
        // no exception for a row this build happens to dislike.
        assert!(store
            .cached_graph(folder_id, None)
            .expect("reads")
            .is_some());
    }

    #[test]
    fn the_cached_body_is_the_one_github_sent_rather_than_a_shadow_of_it() {
        let (store, folder_id) = registry_with_a_folder();

        remember_read(&store, folder_id, None, &a_fresh_read(TWO_MAPS, 100)).expect("caches");

        // #33 derives its model from this, so it has to be the bytes and not a
        // re-serialisation of what this slice happened to parse out of them.
        assert_eq!(
            store
                .cached_graph(folder_id, None)
                .expect("reads")
                .expect("is there")
                .graph_json,
            TWO_MAPS
        );
    }

    /* ------------------------------------------------------ the ledger --- */

    use perseverance_model::{ClauseKind, Occasion, Since};

    /// The map the two fixtures below are two reads of. Not 28 — that is
    /// `two-maps-one-open.json`'s.
    const AWKWARD_MAP: u64 = 60;
    const AWKWARD: &str = include_str!("../../model/fixtures/awkward-children.json");
    /// The same map read again: #77 closed, #72 became takeable and took the
    /// frontier off #75, and #76 was renamed.
    const AWKWARD_LATER: &str = include_str!("../../model/fixtures/awkward-children-later.json");

    fn model_of(body: &str) -> Model {
        Model::of(&read_response(body).expect("reads"), Machine::host())
    }

    fn watching_map(folder_id: i64, map: u64) -> Watched {
        Watched {
            folder_id,
            map: Some(map),
        }
    }

    /// The clauses on the one entry a snapshot's ledger carries.
    fn only_entry(snapshot: &Snapshot) -> &perseverance_model::Entry {
        assert_eq!(
            snapshot.ledger.entries.len(),
            1,
            "{:?}",
            snapshot.ledger.entries
        );
        &snapshot.ledger.entries[0]
    }

    /// Which clauses on that entry count towards the unread numeral. The far
    /// side sums exactly this and holds nothing else.
    fn announced(snapshot: &Snapshot) -> Vec<ClauseKind> {
        only_entry(snapshot)
            .clauses
            .iter()
            .filter(|clause| clause.announce)
            .map(|clause| clause.kind)
            .collect()
    }

    /// **A map nobody has read reads *first open*, not `0 changes`.**
    ///
    /// And it goes on reading *first open* through the first landed poll, which
    /// is the case worth pinning: one read is not a comparison, so the zero is
    /// still not available to be told. Only the second poll — the first one with
    /// something to compare against — can produce a number.
    #[test]
    fn a_map_with_no_cache_row_starts_at_first_open_rather_than_at_zero_changes() {
        let (store, folder_id) = registry_with_a_folder();
        let ledgers = Ledgers::new();

        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        assert_eq!(ledgers.held().ledger.since, Since::FirstOpen);

        let first = ledgers.observed(model_of(AWKWARD), 100, &[]);
        assert_eq!(first.ledger.since, Since::FirstOpen);
        assert!(first.ledger.entries.is_empty());

        let second = ledgers.observed(model_of(AWKWARD_LATER), 200, &[]);
        assert_eq!(second.ledger.since, Since::Watching);
        // A poll that landed while this session was watching, rather than a gap
        // it was away for.
        assert_eq!(only_entry(&second).occasion, Occasion::Tick);
        assert_eq!(only_entry(&second).seq, 1);
    }

    /// **The cold start, whole**: the row `graph_cache` alone is what makes
    /// drawable.
    ///
    /// One row for the gap however long it was, because the ledger has no way to
    /// know how many polls it would have taken and inventing them would be
    /// inventing history. The three changes collapse by kind, and the numbers
    /// are on the clauses rather than in a sentence.
    #[test]
    fn a_cached_graph_is_the_baseline_the_while_you_were_away_row_is_drawn_from() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: AWKWARD,
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        let ledgers = Ledgers::new();
        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let snapshot = ledgers.observed(model_of(AWKWARD_LATER), 200, &[]);

        assert_eq!(snapshot.ledger.since, Since::Watching);
        let entry = only_entry(&snapshot);
        assert_eq!(entry.occasion, Occasion::WhileYouWereAway);
        assert_eq!(
            entry
                .clauses
                .iter()
                .map(|clause| (clause.kind, clause.numbers.clone()))
                .collect::<Vec<_>>(),
            vec![
                (ClauseKind::Resolved, vec![77]),
                (ClauseKind::Unblocked, vec![72]),
                (ClauseKind::FrontierMoved, Vec::new()),
                // #76 was renamed, and a rename has no word in the vocabulary.
                // #72 is on here too, beside the `unblocked` clause that also
                // names it: it dropped both the edges it waited on, and the
                // catch-all reports what the named clauses did not consume
                // rather than only the nodes they missed altogether.
                (ClauseKind::Unnamed, vec![72, 76]),
            ]
        );
        // Everything the vocabulary named announces; the catch-all never does.
        assert_eq!(
            announced(&snapshot),
            vec![
                ClauseKind::Resolved,
                ClauseKind::Unblocked,
                ClauseKind::FrontierMoved
            ]
        );
    }

    /// **The phantom row, refused.** A body recorded under a different document
    /// is not a baseline, and the ledger says so by having none.
    ///
    /// The failure this closes has no parse error in it: every field of the read
    /// model tolerates absence, so a body cached under a narrower query comes
    /// back clean and merely says less — a child whose eleventh label was never
    /// asked for reads as a child that lost it, and the gap row reports a change
    /// nobody made. A stamp that is not this build's is *first open*.
    #[test]
    fn a_cached_body_from_another_query_document_is_a_first_open_rather_than_a_baseline() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: AWKWARD,
                    fetched_at: 100,
                    query_id: "the narrower document that shipped before #61",
                },
            )
            .expect("caches");

        let ledgers = Ledgers::new();
        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let snapshot = ledgers.observed(model_of(AWKWARD_LATER), 200, &[]);

        assert_eq!(snapshot.ledger.since, Since::FirstOpen);
        assert!(snapshot.ledger.entries.is_empty());
        // Not deleted, either. The next successful read overwrites it, stamp
        // and all, and only that read is entitled to remove anything.
        assert!(store
            .cached_graph(folder_id, Some(AWKWARD_MAP))
            .expect("reads")
            .is_some());
    }

    /// The same stamp on the other reader, and a different answer: the first
    /// paint of a folder keeps its list.
    ///
    /// The rule is scoped to what the stamp is evidence about. A document this
    /// build does not send may have asked for fewer labels; it did not ask for
    /// fewer maps, and this view is the copy `poll_once` holds across every one
    /// of its failing exits. Blanking it would report *your maps are gone* on
    /// the strength of somebody having edited a query — the same assertion
    /// `MapsView::stale` exists to refuse — and it would go on reporting it for
    /// as long as the polls kept failing, rather than for the one poll ADR 0019
    /// costs.
    #[test]
    fn a_folders_cached_map_list_from_another_query_document_still_paints() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                None,
                &CachedBody {
                    graph_json: TWO_MAPS,
                    fetched_at: 1_785_888_000,
                    query_id: "some older shape",
                },
            )
            .expect("caches");

        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");

        assert_eq!(json["provenance"]["source"], "cache");
        assert_eq!(json["provenance"]["outcome"]["kind"], "ok");
        assert_eq!(json["provenance"]["fetchedAt"], "2026-08-05T00:00:00Z");
        assert_eq!(json["maps"].as_array().expect("an array").len(), 2);
        assert_eq!(json["maps"][0]["number"], 28);
        // The unstamped row a version-2 file upgrades into is this same case —
        // `None` is not this build's id either, and
        // `a_row_with_no_stamp_at_all_is_not_this_builds_query_either` below
        // says so against the gate both readers ask.
        assert!(store
            .cached_graph(folder_id, None)
            .expect("reads")
            .is_some());
    }

    /// The row shape every existing operator actually has on the first launch
    /// after the upgrade — and the one no other test here can write.
    ///
    /// A wrong stamp arrives only once somebody has edited the document; `None`
    /// arrives for everybody, off the version-2 migration. Nothing in this
    /// crate can produce it — every write comes off a [`FreshRead`], which is
    /// always stamped — so the row is built directly, which `CachedGraph`'s
    /// public fields allow.
    ///
    /// Pinning the gate pins both readers, because both ask this and nothing
    /// else: [`resuming_from`] filters its baseline through it, so `None` is
    /// *first open*, and [`from_cache`] paints
    /// [`MapsView::unvouched`] on the same answer, so `None` caveats
    /// `labelsTruncated`.
    #[test]
    fn a_row_with_no_stamp_at_all_is_not_this_builds_query_either() {
        let unstamped = CachedGraph {
            graph_json: TWO_MAPS.to_string(),
            fetched_at: 1_785_888_000,
            query_id: None,
        };

        assert!(!under_this_builds_query(&unstamped));

        // The controls, so the `false` above is the missing stamp and not the
        // row: the same body is believed under this build's own id, and
        // refused under somebody else's.
        assert!(under_this_builds_query(&CachedGraph {
            query_id: Some(map_read_query_id().to_string()),
            ..unstamped.clone()
        }));
        assert!(!under_this_builds_query(&CachedGraph {
            query_id: Some("some older shape".to_string()),
            ..unstamped
        }));
    }

    /// What the stamp *is* evidence about, on this reader: `labelsTruncated`,
    /// and only it.
    ///
    /// That flag is derived from a `pageInfo` a narrower document may never
    /// have asked for, so it answers clean by never having asked — and a
    /// `labelsTruncated` that reads clean because the question was skipped is
    /// worse than no flag, because an operator believes it. The same bytes
    /// under this build's own stamp report clean, which is how this test says
    /// it is the stamp doing the work and not the body.
    ///
    /// Raising it here is not a claim that a list *was* cut off. The sentence
    /// behind the flag — `LABELS_TRUNCATED_NOTE`, pinned on the TS side — says
    /// some labels *may* not have been read, which is the true statement under
    /// both a `hasNextPage` and an unfamiliar document. See ADR 0019 for why
    /// one weakened sentence was taken over a second one on the wire.
    ///
    /// `truncated` stays clean throughout, and that is the second assertion
    /// this test exists to hold. It is `Truncation::capped`, whose sentence
    /// claims GitHub answered a page its own limits forbid; a stamp is no
    /// evidence of that, and firing it here would print that sentence to every
    /// operator on the first launch after the version-3 upgrade.
    #[test]
    fn an_unfamiliar_document_caveats_labels_truncated_and_leaves_capped_clean() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                None,
                &CachedBody {
                    graph_json: TWO_MAPS,
                    fetched_at: 1_785_888_000,
                    query_id: "some older shape",
                },
            )
            .expect("caches");

        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");

        assert_eq!(json["labelsTruncated"], true);
        assert_eq!(json["truncated"], false, "a stamp is not a broken cap");

        store
            .cache_graph(
                folder_id,
                None,
                &CachedBody {
                    graph_json: TWO_MAPS,
                    fetched_at: 1_785_888_000,
                    query_id: map_read_query_id(),
                },
            )
            .expect("re-caches under the document this build sends");

        let json = serde_json::to_value(from_cache(&store, folder_id)).expect("serialises");

        assert_eq!(json["truncated"], false);
        assert_eq!(json["labelsTruncated"], false);
    }

    /// **A failed poll draws no row**, and the copy on screen keeps the age it
    /// already had.
    ///
    /// The ledger is untouched rather than appended with a failure, because a
    /// failure is not a thing that happened to the map — the stale stamp beside
    /// it is where the health lives, and it is the only thing that moves.
    #[test]
    fn a_failed_poll_ages_the_held_snapshot_and_draws_no_row() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: AWKWARD,
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        let ledgers = Ledgers::new();
        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let landed = ledgers.observed(model_of(AWKWARD_LATER), 1_785_888_000, &[]);

        let aged = ledgers.aged(Degraded::Unreachable, "nothing answered".to_string());

        // The same entries, and the same one row: nothing was compared, so
        // nothing was recorded.
        assert_eq!(aged.ledger.entries, landed.ledger.entries);
        assert_eq!(aged.ledger.since, Since::Watching);
        // The model and the stamp stay exactly as they were; only the outcome
        // changes, which is what makes staleness visible rather than emptiness.
        assert_eq!(aged.model, landed.model);
        assert_eq!(
            aged.provenance.fetched_at.as_deref(),
            Some("2026-08-05T00:00:00Z")
        );
        // And what is on screen stops calling itself a live read. The last poll
        // landed from GitHub and this one did not, so the graph beside the
        // stamp is the copy that read left behind — the stamp saying *read from
        // GitHub* about an answer GitHub did not give would be the health
        // reading as its own opposite, and on this surface `github` beside a
        // failure is the WebView's sentence for a read that **landed** and
        // could not be stored.
        assert_eq!(landed.provenance.source, Source::Github);
        assert_eq!(aged.provenance.source, Source::Cache);
        assert!(matches!(
            aged.provenance.outcome,
            ReadOutcome::Failed {
                reason: Degraded::Unreachable,
                ..
            }
        ));
        // And it is what the `snapshot` command answers from here on.
        assert_eq!(ledgers.held().ledger.entries, landed.ledger.entries);
    }

    /// Schema drift on a copy is *first open*, not a map that has not moved —
    /// and emphatically not a deletion.
    ///
    /// The next successful read replaces the row. Until then there is nothing to
    /// compare against, and saying so is the only honest answer: a build that
    /// cannot read yesterday's cache has not established that nothing changed.
    #[test]
    fn a_cached_body_this_build_cannot_read_is_a_first_open_rather_than_a_deletion() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: "<html>a proxy got at it</html>",
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        let ledgers = Ledgers::new();
        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let snapshot = ledgers.observed(model_of(AWKWARD_LATER), 200, &[]);

        assert_eq!(snapshot.ledger.since, Since::FirstOpen);
        assert!(snapshot.ledger.entries.is_empty());
        // Only a successful GitHub read may delete anything, and that rule has
        // no exception for a row this build happens to be unable to parse.
        assert!(store
            .cached_graph(folder_id, Some(AWKWARD_MAP))
            .expect("reads")
            .is_some());
    }

    /// A different map is a different log, and the same one is the same log.
    ///
    /// The second half is what stops the first from being a bug: `attend` runs
    /// at the top of every poll, so a comparison of `(folder, map)` that was
    /// wrong in the other direction would throw the ring away ten seconds after
    /// filling it.
    #[test]
    fn watching_a_different_map_starts_a_new_ledger() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: AWKWARD,
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        let ledgers = Ledgers::new();
        ledgers.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        ledgers.observed(model_of(AWKWARD_LATER), 200, &[]);
        assert_eq!(ledgers.held().ledger.entries.len(), 1);

        // Another map on the same folder, which nothing has ever been read for.
        // The row belonging to the map we just left is not an older read of
        // this one, so nothing crosses: no entries, and no graph either.
        ledgers.attend(&store, &watching_map(folder_id, 28));
        let opened = ledgers.held();
        assert_eq!(opened.ledger.since, Since::FirstOpen);
        assert!(opened.ledger.entries.is_empty());
        assert!(opened.model.map.is_none());

        // The same pair again, on the next tick of the same session.
        ledgers.observed(model_of(AWKWARD), 300, &[]);
        ledgers.observed(model_of(AWKWARD_LATER), 400, &[]);
        ledgers.attend(&store, &watching_map(folder_id, 28));
        assert_eq!(ledgers.held().ledger.entries.len(), 1);
    }

    /// **The claim this harness originated, and the frontier move with it, are
    /// the two clauses that do not count.**
    ///
    /// The same two facts twice, differing only in whether [`Claims`] was told.
    /// Somebody else claiming the frontier is the whole reason the numeral
    /// exists; this harness claiming it is the one change on screen an operator
    /// could have predicted, and the move that follows is that same fact told a
    /// second time.
    ///
    /// The record is complete either way — both clauses are on the row in both
    /// runs, with their numbers. Only the announcement is selective.
    #[test]
    fn a_claim_this_harness_originated_and_the_move_after_it_leave_the_numeral_alone() {
        let (store, folder_id) = registry_with_a_folder();
        store
            .cache_graph(
                folder_id,
                Some(AWKWARD_MAP),
                &CachedBody {
                    graph_json: AWKWARD_LATER,
                    fetched_at: 100,
                    query_id: map_read_query_id(),
                },
            )
            .expect("caches");

        // Somebody else took #72, which was the frontier.
        let theirs = Ledgers::new();
        theirs.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let snapshot = theirs.observed(somebody_holds_72(), 200, &Claims::new().originated());
        assert_eq!(
            announced(&snapshot),
            vec![ClauseKind::Claimed, ClauseKind::FrontierMoved]
        );

        // The same two facts, with this session's harness having claimed it.
        let ours = Ledgers::new();
        ours.attend(&store, &watching_map(folder_id, AWKWARD_MAP));
        let claims = Claims::new();
        claims.claimed(72);
        // Twice, because a claim taken twice is still one claim.
        claims.claimed(72);
        let snapshot = ours.observed(somebody_holds_72(), 200, &claims.originated());

        assert_eq!(announced(&snapshot), Vec::new());
        assert_eq!(
            only_entry(&snapshot)
                .clauses
                .iter()
                .map(|clause| (clause.kind, clause.numbers.clone(), clause.count))
                .collect::<Vec<_>>(),
            vec![
                (ClauseKind::Claimed, vec![72], 1),
                (ClauseKind::FrontierMoved, Vec::new(), 1),
            ]
        );
    }

    /// The *later* read with one more thing true of it: somebody now holds #72,
    /// which is the node that read as the frontier.
    ///
    /// Assembled by editing the **answer** rather than the model, so what comes
    /// out is a graph the derivation could actually produce — counts, phase and
    /// frontier included. A hand-built `Model` would let this test assert
    /// against a state GitHub can never send.
    fn somebody_holds_72() -> Model {
        let mut answer: serde_json::Value = serde_json::from_str(AWKWARD_LATER).expect("json");
        let children = answer["data"]["repository"]["issue"]["subIssues"]["nodes"]
            .as_array_mut()
            .expect("the children of the map");
        let held = children
            .iter_mut()
            .find(|child| child["number"] == 72)
            .expect("#72 is on this map");
        held["assignees"]["nodes"] = serde_json::json!([{ "login": "javrasya" }]);

        model_of(&answer.to_string())
    }

    /// The map's own row is written by the same read that writes the folder's,
    /// and it is the verbatim body rather than a shadow of it — because the
    /// next launch derives its baseline from exactly these bytes.
    #[test]
    fn a_read_taken_with_a_map_open_caches_that_map_s_own_row_as_well() {
        let (store, folder_id) = registry_with_a_folder();

        remember_read(
            &store,
            folder_id,
            Some(28),
            &a_fresh_read(TWO_MAPS, 1_785_888_000),
        )
        .expect("caches");

        let cached = store
            .cached_graph(folder_id, Some(28))
            .expect("reads")
            .expect("is there");
        assert_eq!(cached.graph_json, TWO_MAPS);
        assert_eq!(cached.fetched_at, 1_785_888_000);
        // And the folder's own row is still the list, unchanged by any of it.
        assert_eq!(
            store
                .cached_graph(folder_id, None)
                .expect("reads")
                .expect("is there")
                .graph_json,
            TWO_MAPS
        );
    }

    /// **Nothing printed inside a PTY is a condition on the graph.**
    ///
    /// The rule is `crates/pty`'s and the test is here, for the reason #38 gave
    /// for putting the purity check in `poller.rs`: the needle does not go in
    /// the haystack it is searching. A test living in the crate it reads would
    /// be a test whose own source satisfies the thing it looks for.
    ///
    /// It is a byte-level check, and #47 is where it had to hold against a crate
    /// that actually owns a terminal: a PTY that fails to open, a child that
    /// will not start, a job object that cannot be made and a ring that has
    /// overrun are all things that crate now knows about, and not one of them is
    /// a condition on the graph.
    ///
    /// Every file in the crate is named below, and that is the limit README
    /// records — a file added to `crates/pty/src` escapes this scan until someone
    /// adds it here. The count is part of the array's type, so adding a file
    /// without adding a line here is a compile error in whichever direction it
    /// is noticed.
    #[test]
    fn nothing_inside_the_terminal_can_raise_a_condition_on_the_graph() {
        const PTY_SOURCES: [(&str, &str); 9] = [
            ("geometry.rs", include_str!("../../pty/src/geometry.rs")),
            ("guard.rs", include_str!("../../pty/src/guard.rs")),
            ("lib.rs", include_str!("../../pty/src/lib.rs")),
            ("queries.rs", include_str!("../../pty/src/queries.rs")),
            ("ring.rs", include_str!("../../pty/src/ring.rs")),
            ("runs.rs", include_str!("../../pty/src/runs.rs")),
            ("session.rs", include_str!("../../pty/src/session.rs")),
            ("shim.rs", include_str!("../../pty/src/shim.rs")),
            ("tap.rs", include_str!("../../pty/src/tap.rs")),
        ];

        // Every name a child process's failure would have to reach for to put
        // itself on the graph. A harness that narrated a compiler error would
        // be saying, less well, what is already three inches from your eyes.
        for (file, source) in PTY_SOURCES {
            for surfaced in ["Degraded", "ReadOutcome", "MapsView", "Provenance", "emit"] {
                assert!(
                    !source.contains(surfaced),
                    "crates/pty/src/{file} names {surfaced}, so a failure inside a terminal \
                     can reach the graph"
                );
            }
        }
    }

    /// The whole of `std` `crates/agent` may name.
    ///
    /// An allowlist and not a list of forbidden modules, which is the only form
    /// of this rule that survives contact with Rust's import syntax: a
    /// brace-grouped `use` pulls in the file and I/O modules while spelling
    /// neither of them as a qualified path, and an aliased one renames whatever
    /// it likes. Four names cover everything planning does — `OsStr` and
    /// `OsString` for argv, `Duration` for a readiness rule, `fmt` and `error`
    /// for a `PlanError` that a caller can box.
    ///
    /// `time` is the one entry admitted for less than the whole of itself:
    /// planning needs a *length* and never a *moment*, and the names that turn
    /// the module into a reading of the machine are refused by token in
    /// [`READS_THE_CLOCK`] rather than by this list, because a list over
    /// modules cannot say *only `Duration`*. That refusal is a list of named
    /// tokens and not a proof, which makes `time` the one knowingly soft entry
    /// here — see [`READS_THE_CLOCK`] for what that costs.
    ///
    /// The empty string is how [`std_paths_named`] reports `std` bound whole
    /// (`use std as anything;`), which is not on the list either.
    const PERMITTED_STD: [&str; 4] = ["ffi", "fmt", "time", "error"];

    /// Nothing in `crates/agent` may reach the machine at *build* time either.
    ///
    /// These are macros in the prelude, so they need no import at all and no
    /// allowlist over paths would ever see them. `env!("HOME")` inside a plan
    /// is the exact failure the allowlist exists to prevent — planning against
    /// the environment the binary was compiled in rather than against the one
    /// `perseverance-env` harvested — and it would be baked into the binary
    /// rather than merely done at runtime. `include!` reaches the same disk at
    /// the same moment and splices what it finds there in as *code*, which is
    /// the widest of the five and the one that was missing.
    ///
    /// Named tokens, among others: nothing here proves the prelude has no sixth
    /// macro that reads the build machine, and a scan over text cannot be made
    /// to prove it. It is a list that grows when someone finds one.
    const REACHES_THE_BUILD_MACHINE: [&str; 5] = [
        "env!",
        "option_env!",
        "include_str!",
        "include_bytes!",
        "include!",
    ];

    /// Nothing in `crates/agent` may read a clock either.
    ///
    /// Three names in `std::time` that ask the machine what time it is, and
    /// `time` is on [`PERMITTED_STD`] whole because `Duration` lives there too.
    /// A `plan` that read the clock would name nothing but `time`, pass the
    /// allowlist, and falsify the one thing
    /// `perseverance_agent::Agent::plan` promises — *same context in, same
    /// launch out, every time*. Refused by token for the same reason
    /// [`REACHES_THE_BUILD_MACHINE`] is: there is no qualified path for
    /// [`std_paths_named`] to walk that would distinguish the moment from the
    /// length.
    ///
    /// Named tokens, among others — and `UNIX_EPOCH` is why that weakening is
    /// the honest wording rather than a hedge. It is a `SystemTime` constant
    /// with `elapsed` on it, so `UNIX_EPOCH.elapsed()` reads the wall clock
    /// while spelling neither of the other two names, and it sat outside this
    /// list until someone went looking. The list is what is known to reach a
    /// clock, not a proof that nothing else in `std::time` does; the form that
    /// *would* be a proof is an allowlist over the names inside a module, which
    /// a reader over text cannot express.
    const READS_THE_CLOCK: [&str; 3] = ["SystemTime", "Instant", "UNIX_EPOCH"];

    /// The source with its comments gone, so a rule about what the *code* names
    /// is not a rule about what a doc comment may discuss.
    ///
    /// Whitespace is left where it is, and the reader below steps over it
    /// instead — `std :: fs` and a path broken across two lines are both legal
    /// spellings, and squashing whitespace out to catch them would weld `use`
    /// onto `std` and lose the token boundary that says which `std` is the one.
    fn code_of(source: &str) -> String {
        let mut kept = String::with_capacity(source.len());
        let mut chars = source.chars().peekable();

        while let Some(ch) = chars.next() {
            match ch {
                '/' if chars.peek() == Some(&'/') => {
                    for skipped in chars.by_ref() {
                        if skipped == '\n' {
                            break;
                        }
                    }
                }
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    let mut previous = '\0';
                    for skipped in chars.by_ref() {
                        if previous == '*' && skipped == '/' {
                            break;
                        }
                        previous = skipped;
                    }
                }
                // Kept whole. A string is code, and one that spelled out a
                // forbidden path should fail rather than be read past.
                '"' => {
                    kept.push(ch);
                    let mut escaped = false;
                    for inside in chars.by_ref() {
                        kept.push(inside);
                        if escaped {
                            escaped = false;
                        } else if inside == '\\' {
                            escaped = true;
                        } else if inside == '"' {
                            break;
                        }
                    }
                }
                _ => kept.push(ch),
            }
        }

        kept
    }

    /// Which *other files* one source declares, by the name it declares them
    /// under.
    ///
    /// A declaration and never a block: `mod x;` is another file on disk, and
    /// `mod x { … }` is source already inside the file being read — which is
    /// what every `#[cfg(test)] mod tests` in the crate is, and why the
    /// semicolon is required rather than incidental.
    ///
    /// Names rather than a count, because the guard below compares a *set*. A
    /// count is satisfied by the wrong file: a declaration this reader could
    /// not see left the total where it was, the arithmetic went on agreeing,
    /// and the new file was never read. A set cannot be satisfied by the wrong
    /// file, and it says which one.
    ///
    /// Attributes are stripped first and visibility second, because
    /// `#[cfg(windows)] mod platform_windows;` and `#[path = "extra.rs"] mod
    /// extra;` are each a file on disk and each invisible to a reader that
    /// looked for `mod ` behind nothing but an optional `pub`. Comments go
    /// before both, by the same rule as everywhere else here: a `mod` inside
    /// one is discussion.
    fn modules_declared_in(source: &str) -> Vec<String> {
        /// One line with any leading attributes taken off, so a declaration
        /// that carries one is the same declaration to the reader below.
        ///
        /// Bracket depth rather than a search for `]`, because an attribute may
        /// contain one (`#[doc = "a [link]"]`) and stopping at the first would
        /// leave the rest of the attribute looking like code.
        fn without_attributes(line: &str) -> &str {
            let mut rest = line.trim_start();

            while let Some(after_hash) = rest.strip_prefix('#') {
                let Some(inside) = after_hash
                    .strip_prefix('!')
                    .unwrap_or(after_hash)
                    .strip_prefix('[')
                else {
                    return rest;
                };

                let mut depth = 1usize;
                let mut closed = None;
                for (index, ch) in inside.char_indices() {
                    match ch {
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                closed = Some(index);
                                break;
                            }
                        }
                        _ => {}
                    }
                }

                match closed {
                    Some(index) => rest = inside[index + 1..].trim_start(),
                    // An attribute running past the end of the line, which
                    // means the declaration is not on this line either.
                    None => return rest,
                }
            }

            rest
        }

        code_of(source)
            .lines()
            .filter_map(|line| {
                let line = without_attributes(line);
                let after_visibility = line.strip_prefix("pub").map_or(line, |rest| {
                    rest.strip_prefix('(')
                        .and_then(|restriction| restriction.split_once(')'))
                        .map_or(rest, |(_, after)| after)
                });
                after_visibility
                    .trim_start()
                    .strip_prefix("mod ")
                    .and_then(|declared| declared.trim_end().strip_suffix(';'))
                    .map(|declared| declared.trim().to_string())
            })
            .collect()
    }

    /// The same source with the whitespace squashed out as well, for the rules
    /// that are about a *name* rather than about a path.
    ///
    /// `env !` and `SystemTime :: now` are both legal spellings, and neither a
    /// macro nor a type has a path for [`std_paths_named`] to walk — so these
    /// rules match a token, and the token has to be found however it was typed.
    fn tokens_of(source: &str) -> String {
        code_of(source)
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect()
    }

    /// Every module of `std` a source names, whatever syntax it names it with.
    ///
    /// A path names one (`std::ffi::OsStr` → `ffi`), a brace group names as
    /// many as it has entries at its own depth (`std::{path::Path, env::var}` →
    /// `path`, `env`), and `std` bound whole is reported as the empty string
    /// because an alias can call it anything afterwards.
    fn std_paths_named(source: &str) -> Vec<String> {
        fn leading_ident(text: &str) -> String {
            text.chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect()
        }

        fn named_after(rest: &str) -> Vec<String> {
            let rest = rest.trim_start();
            if !rest.starts_with('{') {
                return vec![leading_ident(rest)];
            }

            let mut named = Vec::new();
            let mut depth = 0usize;
            let mut entry_begins = false;

            for (index, ch) in rest.char_indices() {
                match ch {
                    '{' => {
                        depth += 1;
                        entry_begins = depth == 1;
                    }
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    ',' if depth == 1 => entry_begins = true,
                    _ if entry_begins && depth == 1 && !ch.is_whitespace() => {
                        named.push(leading_ident(&rest[index..]));
                        entry_begins = false;
                    }
                    _ => {}
                }
            }

            named
        }

        let code = code_of(source);
        let bytes = code.as_bytes();
        let mut named = Vec::new();
        let mut at = 0;

        while let Some(found) = code[at..].find("std") {
            let start = at + found;
            at = start + "std".len();

            let after_an_identifier =
                start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_');
            let inside_an_identifier =
                at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_');
            if after_an_identifier || inside_an_identifier {
                continue;
            }

            match code[at..].trim_start().strip_prefix("::") {
                Some(rest) => named.extend(named_after(rest)),
                // `use std as anything;` — no path to read, so nothing an
                // allowlist over paths would ever see again.
                None => named.push(String::new()),
            }
        }

        named
    }

    /// **An adapter plans from what it was handed, and from nothing it could go
    /// and read.**
    ///
    /// Criterion 7 of #44 — *nothing in the trait can express a write to the
    /// operator's global config* — rests on three things, and this is the third
    /// and only mechanical one. The first is that [`perseverance_agent::Launch`]
    /// holds argv, an environment delta and a readiness rule and has nowhere
    /// else to put an intention. The second is that `LaunchContext` derives
    /// `Copy` and hands out `Program` and `Cwd` rather than paths, so no
    /// writable handle can be a field of it and no *readable* one either — a
    /// `&Path` field would have carried `exists`, `metadata`, `read_dir` and
    /// `canonicalize` as inherent methods that need no import and that no scan
    /// of the source could see. The third is that the crate has no dependencies
    /// at all, which leaves `std` as the only tool in scope — and this scan
    /// closes that.
    ///
    /// Here rather than in `crates/agent` for the same reason as the test
    /// above: the needle does not go in the haystack. A file naming the
    /// forbidden modules inside the crate it searches would fail against
    /// itself.
    ///
    /// It is an allowlist, and the previous version of it was not. A list of
    /// forbidden qualified paths is defeated by one brace group, which is the
    /// most ordinary import idiom there is; [`PERMITTED_STD`] cannot be got
    /// round by syntax, because every route to a module of `std` in a crate
    /// with no dependencies has to name it after `std::` somewhere.
    ///
    /// The environment module is the sharp exclusion, and `path` is the quiet
    /// one. Forbidding the first is what makes "plan from what you were handed"
    /// mechanical: an adapter that read `HOME` from the process would be
    /// planning against this app's launchd stub rather than against the
    /// environment `perseverance-env` harvested for the folder. Forbidding the
    /// second is what makes it complete: a path type is the one value in `std`
    /// that does filesystem I/O through inherent methods, so it is the one that
    /// could have got there while naming nothing at all.
    #[test]
    fn an_adapter_plans_from_what_it_was_handed_and_from_nothing_it_could_go_and_read() {
        // **The directory, and not a list of it.** This was nine `include_str!`
        // lines until #46, and the tenth was the fourth file an adapter cost to
        // add — a hand-written list of the haystack, where forgetting a line
        // meant a file nothing scanned. Reading the directory removes both: the
        // list cannot be short of the disk, because it *is* the disk, and
        // `crates/app` stops being somewhere an adapter has to be registered.
        //
        // Reading at test time rather than baking at compile time is the whole
        // of the change. `include_str!` bakes the bytes and so needs the path
        // spelled out; a test runs beside the checkout that built it, and
        // `crates/model/src/bindings.rs` already walks its fixture directory
        // from `CARGO_MANIFEST_DIR` for exactly this reason. The scan is over
        // `crates/agent`, never over this crate, so nothing here is subject to
        // the rule it applies — the needle still does not go in the haystack.
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("agent")
            .join("src");
        let mut agent_sources: Vec<(String, String)> = std::fs::read_dir(&directory)
            .unwrap_or_else(|why| panic!("reading {directory:?}: {why}"))
            .map(|entry| {
                entry
                    .expect("an entry of crates/agent/src")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|file| file.ends_with(".rs"))
            .map(|file| {
                let path = directory.join(&file);
                let source = std::fs::read_to_string(&path)
                    .unwrap_or_else(|why| panic!("reading {path:?}: {why}"));
                (file, source)
            })
            .collect();
        agent_sources.sort();

        assert!(
            !agent_sources.is_empty(),
            "nothing was read from {directory:?}, so this scan would pass by having looked at \
             no adapter at all"
        );

        // The two halves are now *the files on disk* and *the crate's own `mod`
        // declarations*, and they are still compared — for the opposite failure
        // to the one the old list had. A file cannot escape the scan any more,
        // so what is left to catch is a file on disk that no `mod` declares
        // (dead source nobody compiles, which would go on being scanned and
        // read as evidence) and a `mod` with no file of its name.
        //
        // A set of names and not a count of them. A count was satisfiable by
        // the wrong file: `#[cfg(windows)] mod platform_windows;` is a
        // declaration `modules_declared_in` cannot see, so a count could cancel
        // two errors against each other. A set has no arithmetic for them to
        // cancel in — it names the file that is on one side and not the other.
        //
        // Every scanned file is asked for its declarations, not just `lib.rs`,
        // because a submodule declared in one of the others is a file on disk
        // the same way — and `lib` is put in by hand, because nothing declares
        // it.
        //
        // What this deliberately does not model is `#[path = "elsewhere.rs"]
        // mod name;`, where the module's name and the file's are different on
        // purpose. That fails here rather than passing, which is the safe
        // direction to be wrong in: a test to go and edit, not a file that
        // slipped through.
        let mut declared: std::collections::BTreeSet<String> = agent_sources
            .iter()
            .flat_map(|(_, source)| modules_declared_in(source))
            .collect();
        declared.insert("lib".to_string());

        let scanned: std::collections::BTreeSet<String> = agent_sources
            .iter()
            .map(|(file, _)| file.strip_suffix(".rs").unwrap_or(file).to_string())
            .collect();

        assert_eq!(
            declared, scanned,
            "crates/agent's own `mod` declarations and the files in its src directory name \
             different modules, so either a file on disk is compiled by nothing and read here as \
             evidence, or a declared module has no file of its name"
        );

        for (file, source) in &agent_sources {
            for named in std_paths_named(source) {
                assert!(
                    PERMITTED_STD.contains(&named.as_str()),
                    "crates/agent/src/{file} names {}, and planning may name only {} of std, so \
                     an adapter could now read something it was not handed — or write the \
                     operator's global config",
                    if named.is_empty() {
                        "std itself, which an alias can then call anything".to_string()
                    } else {
                        format!("std::{named}")
                    },
                    PERMITTED_STD.join(", ")
                );
            }

            // Squashed for these two, because `env !` is a legal spelling and
            // neither a macro nor a type has a path for the reader above to
            // walk.
            let invoked = tokens_of(source);
            for reached_for in REACHES_THE_BUILD_MACHINE {
                assert!(
                    !invoked.contains(reached_for),
                    "crates/agent/src/{file} uses {reached_for}, which reaches the machine the \
                     binary was built on without naming a module of std at all"
                );
            }
            for read in READS_THE_CLOCK {
                assert!(
                    !invoked.contains(read),
                    "crates/agent/src/{file} names {read}, which reads a clock while naming only \
                     std::time — and time is on the allowlist for Duration, so a plan that asked \
                     what time it is would pass this scan and stop being the same launch for the \
                     same context"
                );
            }
        }
    }

    /// **The scan above is checked against the imports it exists to catch.**
    ///
    /// Every line in the first table reaches the world, and most of them walk
    /// straight past the forbidden-substring rule the allowlist replaced
    /// (`docs/adr/0010`): a brace group pulls in a module without ever spelling
    /// it after `std::`, an alias renames it, `std` can be bound whole, and a
    /// path can be spaced out or broken across lines. Only the ones that spell
    /// a forbidden path literally were ever caught. That is the argument for
    /// putting known-bad input through a check rather than trusting that a
    /// check which passes is a check that works — the same argument
    /// `check:agent-solitude` makes by feeding its verdict function `cargo
    /// tree` output it knows to be bad.
    #[test]
    fn the_purity_scan_is_not_defeated_by_the_way_an_import_happens_to_be_written() {
        let escapes = |source: &str| {
            std_paths_named(source)
                .iter()
                .any(|named| !PERMITTED_STD.contains(&named.as_str()))
        };

        for bypass in [
            "use std::{env, fs};",
            "use std::{path::Path, env::var};",
            "use std::env::{self, var};",
            "use std::env as ambient;",
            "use std as everything;",
            "use std :: io :: Write;",
            "use std::\n    process::Command;",
            "use std::{ffi::OsString, fs::OpenOptions};",
            "use std::{ffi::{OsStr, OsString}, net::TcpStream};",
            "let there = std::path::Path::new(handed).exists();",
        ] {
            assert!(
                escapes(bypass),
                "{bypass:?} reaches the world and the scan lets it through"
            );
        }

        for planning in [
            "use std::ffi::{OsStr, OsString};",
            "use std::{fmt, time::Duration};",
            "impl std::error::Error for PlanError {}",
            // Comments are discussion, not code. The crate's own doc comments
            // talk about the modules it may not name, and must go on being able
            // to.
            "/// names the file and environment modules of std in prose\nuse std::fmt;",
            "// use std::fs::write(global_config, bytes);",
            "/* use std::env; */",
            // Not the module: an identifier that merely starts with the same
            // three letters.
            "let stdout_like = 1;\nlet a = something.stdin;",
        ] {
            assert!(
                !escapes(planning),
                "{planning:?} is how an adapter is written and the scan refuses it"
            );
        }
    }

    /// **A plan that reaches the build machine is caught, though it names no
    /// module of `std` at all.**
    ///
    /// The allowlist is over paths and these are macros in the prelude, so
    /// every line below reports *nothing* to the path reader — the allowlist
    /// passes all of them and [`REACHES_THE_BUILD_MACHINE`] is the whole of
    /// what stands between a plan and the machine it was compiled on. Asserted
    /// from both ends for the same reason the clock rule is: a rule that merely
    /// duplicated the allowlist would be caught by neither.
    ///
    /// `include!` is the entry this table was written for. It reads the build
    /// machine's disk exactly as `include_str!` does and then splices the bytes
    /// in as code, and it sat outside the list because four macros ending in
    /// `env!` or `include_…!` looked like the whole family.
    #[test]
    fn a_plan_that_reaches_the_build_machine_is_refused_though_it_names_no_module_of_std() {
        let reaches = |source: &str| {
            let invoked = tokens_of(source);
            REACHES_THE_BUILD_MACHINE
                .iter()
                .any(|reached_for| invoked.contains(reached_for))
        };

        for reach in [
            "let home = env!(\"HOME\");",
            "let home = option_env!(\"HOME\");",
            "const BAKED: &str = include_str!(\"../../../.env\");",
            "const BAKED: &[u8] = include_bytes!(\"../../../.env\");",
            "include!(\"planned_elsewhere.rs\");",
            "include !(\"planned_elsewhere.rs\");",
        ] {
            assert!(
                std_paths_named(reach).is_empty(),
                "{reach:?} names a module of std, so it is not the hole this rule exists for"
            );
            assert!(
                reaches(reach),
                "{reach:?} reads the machine the binary was built on and the scan lets it \
                 through, so a plan can be compiled against an environment nobody harvested"
            );
        }

        for planning in [
            "use std::ffi::{OsStr, OsString};",
            // The tokens carry their punctuation, so the bare word `include`
            // in a string is not a read of the build machine — an adapter that
            // planned a `--include` flag is planning argv and nothing more.
            "const ARGV: [&str; 1] = [\"--include\"];",
            // Comments are discussion here as everywhere else.
            "/// never include_str! the operator's environment\nuse std::fmt;",
        ] {
            assert!(
                !reaches(planning),
                "{planning:?} is how an adapter is written and the scan refuses it"
            );
        }
    }

    /// **A plan that read the clock is caught, though `std::time` is
    /// permitted.**
    ///
    /// The allowlist is over modules and the hole is inside one: every line
    /// below names `time` and nothing else, so the path reader passes all of
    /// them and [`READS_THE_CLOCK`] is the whole of what stands between a plan
    /// and the wall clock. Asserted from both ends here, because a rule that
    /// duplicated the allowlist would be caught by neither.
    #[test]
    fn a_plan_that_asks_what_time_it_is_is_refused_though_it_names_only_time() {
        let reads_a_clock = |source: &str| {
            let invoked = tokens_of(source);
            READS_THE_CLOCK.iter().any(|read| invoked.contains(read))
        };

        for clock in [
            "use std::time::SystemTime;\nlet at = SystemTime::now();",
            "let since = std::time::Instant::now();",
            "use std::time::{Duration, SystemTime};",
            "use std :: time :: Instant ;",
            "use std::time::SystemTime as Clock;",
            "use std::time::*;\nlet at = Instant::now();",
            // The one that was through: a `SystemTime` constant carrying
            // `elapsed`, which reads the wall clock while spelling neither
            // `SystemTime` nor `Instant` anywhere in the line.
            "use std::time::UNIX_EPOCH;\nlet at = UNIX_EPOCH.elapsed();",
        ] {
            assert!(
                std_paths_named(clock)
                    .iter()
                    .all(|named| PERMITTED_STD.contains(&named.as_str())),
                "{clock:?} names a module the allowlist forbids, so it is not the hole this rule \
                 exists for"
            );
            assert!(
                reads_a_clock(clock),
                "{clock:?} reads a clock and the scan lets it through, so the same context stops \
                 giving the same launch"
            );
        }

        for planning in [
            "use std::time::Duration;",
            "Ready::AltScreen { timeout: Duration::from_secs(10) }",
            // Comments are discussion here as everywhere else: the crate's doc
            // comments talk about what planning may not do, and must go on
            // being able to.
            "/// measured against Instant::now on one machine, one day\nuse std::time::Duration;",
        ] {
            assert!(
                !reads_a_clock(planning),
                "{planning:?} is how a readiness rule is written and the scan refuses it"
            );
        }
    }

    /// **The guard on the list of scanned files names a module however it is
    /// declared.**
    ///
    /// The guard is what README and `docs/adr/0010` advertise as the thing that
    /// stops the list rotting, and every spelling it cannot see is a file that
    /// escapes the scan while the guard goes on passing. It has been wrong
    /// twice in that direction — first for `pub mod extra;`, then for
    /// `#[cfg(windows)] mod platform_windows;` — which is the argument for
    /// asserting the *name* here rather than a count, and for the set
    /// comparison the guard now makes with it.
    #[test]
    fn a_module_declared_behind_an_attribute_or_a_visibility_is_named_as_a_file_to_scan() {
        for (declaration, file) in [
            ("mod watch;", "watch"),
            ("pub mod watch;", "watch"),
            ("pub(crate) mod watch;", "watch"),
            ("    pub(super) mod watch;", "watch"),
            ("pub(in crate::agent) mod watch;", "watch"),
            ("#[cfg(windows)] mod win;", "win"),
            ("#[cfg(windows)] pub(crate) mod win;", "win"),
            ("#[path = \"x.rs\"] mod x;", "x"),
            ("#[doc = \"a [link]\"] mod x;", "x"),
            ("#[cfg(windows)] #[allow(dead_code)] mod win;", "win"),
        ] {
            assert_eq!(
                modules_declared_in(declaration),
                vec![file.to_string()],
                "{declaration:?} is a file on disk and the guard does not name it, so that file \
                 escapes the scan while the guard goes on passing"
            );
        }

        // A block is source already inside the file being read, which is what
        // every `#[cfg(test)] mod tests` in the crate is.
        assert!(modules_declared_in("mod tests {\n    mod deeper {}\n}").is_empty());
        assert!(modules_declared_in("// mod gone;\n/* mod also_gone; */").is_empty());
        assert!(modules_declared_in("/// mod discussed;").is_empty());
    }

    /* ------------------------------------------------------- environment --- */

    use perseverance_env::{Capture, Harvest, HarvestCondition, Reading};
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::time::Duration;

    /// Not a GitHub token and never was. `ghp_` is the prefix a leak scanner
    /// greps for, which is the whole reason for choosing it.
    const NOT_A_TOKEN: &str = "ghp_notreal";

    /// An attempt with the shape of a real one that worked, assembled here
    /// because a test that had to run a login shell to say what a readout looks
    /// like would be testing the runner's start-up files.
    fn harvest_of(pairs: &[(&str, &[u8])]) -> HarvestAttempt {
        let variables: BTreeMap<String, Vec<u8>> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_vec()))
            .collect();

        HarvestAttempt {
            outcome: Ok(Harvest {
                tally: Tally {
                    records_seen: variables.len(),
                    ..Tally::default()
                },
                environment: Environment::from_reading(Reading {
                    variables,
                    tally: Tally::default(),
                }),
            }),
            shell: Some(Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            }),
            stderr: Stderr {
                text: String::new(),
                bytes: 0,
                kind: StderrKind::Empty,
            },
            elapsed: Duration::from_millis(187),
        }
    }

    /// The same shape, discarded — a shell that ran, said something, and never
    /// closed its frame.
    fn discarded_after(said: &str) -> HarvestAttempt {
        HarvestAttempt {
            outcome: Err(HarvestCondition::FrameNeverClosed { after_ms: 8000 }),
            shell: Some(Shell::LoginShell {
                program: "/bin/zsh".to_string(),
            }),
            stderr: Stderr {
                text: said.to_string(),
                bytes: said.len(),
                // Classified by the crate that owns the rule rather than by a
                // guess here, so an empty stream in a test is spelled the same
                // way the harvest spells one.
                kind: perseverance_env::classify_stderr(said.as_bytes()),
            },
            elapsed: Duration::from_millis(8003),
        }
    }

    /// Built by the same function that builds a real one, because `Token` has no
    /// constructor a caller can reach — which is the point of it.
    fn a_token() -> TokenOutcome {
        perseverance_github::interpret(Ok(Capture {
            status: Some(0),
            stdout: NOT_A_TOKEN.as_bytes().to_vec(),
            stderr: Vec::new(),
        }))
    }

    /// `src/environment/environment.ts` is a hand-written mirror of this, pinned
    /// from both sides for the same reason [`FolderEntry`] is: a rename here is a
    /// silent breakage there, and ten keys is the count both files assert.
    #[test]
    fn an_environment_readout_crosses_in_the_shape_the_frontend_declares() {
        let ambient = Ambient::harvesting();

        let readout = settle_into(
            &ambient,
            || harvest_of(&[("PATH", b"/opt/homebrew/bin:/usr/bin")]),
            |_| a_token(),
        );

        let json = serde_json::to_value(&readout).expect("serialises");
        assert_eq!(json["harvest"]["kind"], "harvested");
        assert_eq!(json["shell"]["kind"], "loginShell");
        assert_eq!(json["shell"]["program"], "/bin/zsh");
        assert_eq!(json["shell"]["flags"][0], "-lic");
        assert_eq!(json["path"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(json["pathSource"], "harvest");
        assert_eq!(json["variableCount"], 1);
        // The crate's own measurement, carried rather than re-taken here.
        assert_eq!(json["elapsedMs"], 187);
        assert_eq!(json["tally"]["recordsSeen"], 1);
        assert_eq!(json["tally"]["recordsDropped"], 0);
        assert_eq!(json["tally"]["duplicatesDropped"], 0);
        assert_eq!(json["tally"]["bytesBeforeFrame"], 0);
        assert_eq!(json["tally"]["bytesAfterFrame"], 0);
        assert_eq!(json["tally"]["extraOpeningMarks"], 0);
        assert_eq!(json["tally"].as_object().expect("an object").len(), 6);
        assert_eq!(json["stderr"]["kind"], "empty");
        assert_eq!(json["stderr"]["bytes"], 0);
        assert_eq!(json["stderr"]["text"], "");
        assert_eq!(json["token"]["kind"], "acquired");
        // Read out of the stream on every path, and *not seen* is not the same
        // claim as *did not happen* — an interpreter that declines silently
        // lands here too, which is what the panel's limits say out loud.
        assert_eq!(json["degradation"]["kind"], "notSeen");
        assert_eq!(json.as_object().expect("an object").len(), 10);
    }

    /// The `AllSigned` case, which every earlier slice recorded as undetectable.
    /// It still is in general; what changed is that when the interpreter names
    /// it in its own words, the readout names it back.
    #[test]
    fn a_profile_the_interpreter_declined_is_named_beside_a_harvest_that_worked() {
        let refused = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">File \
                       C:\\Users\\you\\profile.ps1 cannot _x000D__x000A_be loaded. The file is \
                       not digitally signed._x000D__x000A_</S></Objs>";
        let mut attempt = harvest_of(&[("PATH", b"C:\\Windows\\system32")]);
        attempt.stderr = Stderr {
            text: refused.to_string(),
            bytes: refused.len(),
            kind: perseverance_env::classify_stderr(refused.as_bytes()),
        };

        let named = settle_into(&Ambient::harvesting(), || attempt, |_| a_token());
        let quiet = settle_into(
            &Ambient::harvesting(),
            || harvest_of(&[("PATH", b"C:\\Windows\\system32")]),
            |_| a_token(),
        );

        let json = serde_json::to_value(&named).expect("serialises");
        // Exit 0, both marks, a plausible environment — and still degraded. So
        // it is a field beside the harvest state rather than a fourth tag on
        // it: `harvested` is what happened, and both of these harvested.
        assert_eq!(json["harvest"]["kind"], "harvested");
        assert_eq!(json["degradation"]["kind"], "profileRefused");
        // And the classification is not the signal: the Windows baseline is a
        // non-empty CLIXML stream with no profile at all.
        assert_eq!(json["stderr"]["kind"], "clixml");
        assert_eq!(
            serde_json::to_value(&quiet).expect("serialises")["degradation"]["kind"],
            "notSeen"
        );
    }

    #[test]
    fn each_state_crosses_as_the_tag_the_readout_switches_on() {
        let states = [
            (HarvestState::Harvesting, "harvesting"),
            (HarvestState::Harvested, "harvested"),
            (
                HarvestState::Inherited {
                    detail: "no shell".to_string(),
                },
                "inherited",
            ),
        ];
        for (state, tag) in states {
            assert_eq!(
                serde_json::to_value(&state).expect("serialises")["kind"],
                tag
            );
        }

        let shells = [
            (
                WireShell::from(&Shell::LoginShell {
                    program: "/bin/zsh".to_string(),
                }),
                "loginShell",
            ),
            (
                WireShell::from(&Shell::PowerShell {
                    program: "powershell.exe".to_string(),
                }),
                "powerShell",
            ),
            (WireShell::None, "none"),
        ];
        for (shell, tag) in shells {
            assert_eq!(
                serde_json::to_value(&shell).expect("serialises")["kind"],
                tag
            );
        }

        let streams = [
            (StderrKind::Empty, "empty"),
            (StderrKind::Text, "text"),
            (StderrKind::Clixml, "clixml"),
        ];
        for (kind, tag) in streams {
            let stderr = WireStderr::from(&Stderr {
                text: "#< CLIXML".to_string(),
                bytes: 9,
                kind,
            });
            let json = serde_json::to_value(&stderr).expect("serialises");
            assert_eq!(json["kind"], tag);
            // The text crosses whatever the classification is, because on
            // Windows the classification is never the verdict.
            assert_eq!(json["text"], "#< CLIXML");
            assert_eq!(json["bytes"], 9);
        }

        let tokens = [
            (TokenState::from(&a_token()), "acquired"),
            (
                TokenState::from(&TokenOutcome::NotAttempted),
                "notAttempted",
            ),
            (
                TokenState::from(&perseverance_github::interpret(Ok(Capture {
                    status: Some(1),
                    stdout: Vec::new(),
                    stderr: b"not logged in to any hosts\n".to_vec(),
                }))),
                "refused",
            ),
        ];
        for (token, tag) in tokens {
            assert_eq!(
                serde_json::to_value(&token).expect("serialises")["kind"],
                tag
            );
        }
    }

    #[test]
    fn a_failed_harvest_still_crosses_as_a_readout_rather_than_a_rejection() {
        let ambient = Ambient::harvesting();

        let readout = settle_into(
            &ambient,
            || discarded_after("command not found: fnm\n"),
            // `gh` is never looked for, so this is never called. A closure that
            // would panic is how that is asserted.
            |_| panic!("a discarded harvest asked gh for a token"),
        );

        let json = serde_json::to_value(&readout).expect("serialises");
        assert_eq!(json["harvest"]["kind"], "inherited");
        assert_eq!(
            json["harvest"]["detail"],
            HarvestCondition::FrameNeverClosed { after_ms: 8000 }.to_string()
        );
        // The app is running on what it was launched with, and says so.
        assert_eq!(json["pathSource"], "inherited");
        assert_eq!(
            json["path"],
            Environment::inherited()
                .path()
                .expect("this process has a PATH")
                .into_owned()
        );
        assert_eq!(json["token"]["kind"], "notAttempted");
        // What the shell said on its way to being discarded crosses too, and
        // the shell named is the one that ran rather than a second guess at
        // which one this machine would pick. Both are what an operator opened
        // the panel for.
        assert_eq!(json["stderr"]["kind"], "text");
        assert_eq!(json["stderr"]["text"], "command not found: fnm\n");
        assert_eq!(json["stderr"]["bytes"], 23);
        assert_eq!(json["shell"]["kind"], "loginShell");
        assert_eq!(json["shell"]["program"], "/bin/zsh");
        assert_eq!(json["elapsedMs"], 8003);
    }

    /// The state the readout previously could not tell apart from a shell that
    /// wrote nothing, and the reason [`HarvestAttempt`] carries its stream
    /// outside its outcome.
    #[test]
    fn a_shell_that_wrote_nothing_and_one_that_was_discarded_do_not_read_alike() {
        let quiet = settle_into(
            &Ambient::harvesting(),
            || discarded_after(""),
            |_| TokenOutcome::NotAttempted,
        );
        let spoken = settle_into(
            &Ambient::harvesting(),
            || discarded_after("profile cannot be loaded. The file is not digitally signed."),
            |_| TokenOutcome::NotAttempted,
        );

        // Both harvests were discarded and both fell back to inheritance, so
        // every other field on these two readouts agrees. The stream is the
        // only place the difference can show, which is why it may not be
        // dropped.
        assert_eq!(quiet.stderr.bytes, 0);
        assert!(spoken.stderr.bytes > 0);
        assert_ne!(
            serde_json::to_value(&quiet).expect("serialises")["stderr"],
            serde_json::to_value(&spoken).expect("serialises")["stderr"]
        );
    }

    #[test]
    fn a_secret_in_the_harvested_environment_never_reaches_the_webview() {
        let ambient = Ambient::harvesting();

        let readout = settle_into(
            &ambient,
            || {
                harvest_of(&[
                    ("PATH", b"/usr/bin"),
                    ("GITHUB_TOKEN", NOT_A_TOKEN.as_bytes()),
                    ("AWS_SECRET_ACCESS_KEY", b"wJalrXUtnFEMIK7MDENG"),
                ])
            },
            |_| a_token(),
        );

        // The environment has exactly one exit from Rust and this is it.
        let json = serde_json::to_string(&readout).expect("serialises");
        assert!(!json.contains("GITHUB_TOKEN"), "{json}");
        assert!(!json.contains("AWS_SECRET_ACCESS_KEY"), "{json}");
        assert!(!json.contains(NOT_A_TOKEN), "{json}");
        assert!(!json.contains("wJalrXUtnFEMIK7MDENG"), "{json}");
        // All three were carried, and the count is the only trace of them.
        assert_eq!(readout.variable_count, 3);
        assert_eq!(
            serde_json::to_value(&readout).expect("serialises")["token"]["kind"],
            "acquired"
        );
    }

    #[test]
    fn the_token_is_asked_for_inside_the_environment_the_harvest_returned() {
        let ambient = Ambient::harvesting();
        let asked_inside = RefCell::new(None);

        settle_into(
            &ambient,
            || harvest_of(&[("PATH", b"/opt/homebrew/bin")]),
            |environment| {
                *asked_inside.borrow_mut() = environment.path().map(|path| path.into_owned());
                a_token()
            },
        );

        // The launch order, tested. `gh` is not on a GUI bundle's PATH, so a
        // token asked for in this process's own environment is a token nobody
        // gets — which is what makes the order a data dependency and not a
        // schedule.
        let asked_inside = asked_inside.into_inner();
        assert_eq!(asked_inside.as_deref(), Some("/opt/homebrew/bin"));
        assert_ne!(
            asked_inside,
            Environment::inherited()
                .path()
                .map(|path| path.into_owned())
        );
    }

    #[test]
    fn a_launch_harvests_once() {
        let ambient = Ambient::harvesting();
        let harvests = Cell::new(0);
        let asks = Cell::new(0);

        let settled = settle_into(
            &ambient,
            || {
                harvests.set(harvests.get() + 1);
                harvest_of(&[("PATH", b"/usr/bin")])
            },
            |_| {
                asks.set(asks.get() + 1);
                a_token()
            },
        );

        // Asking for the readout is the command's whole body, and it re-reads
        // rather than re-deriving: a second login shell per click would be a
        // second set of the operator's start-up files per click.
        let asked_for = ambient.settled();
        assert_eq!((harvests.get(), asks.get()), (1, 1));
        assert_eq!(
            serde_json::to_value(&asked_for).expect("serialises"),
            serde_json::to_value(&settled).expect("serialises")
        );
    }

    /// The compile-time half of *never touches disk* is that [`Environment`]
    /// derives no `Serialize` and cannot, there being no serde in that crate's
    /// tree. This is the other half, and the only mechanical one: a real child,
    /// a real frame, a real settling, and a directory that is exactly as it was.
    ///
    /// unix only, because the stub is `/bin/cat` and a Windows equivalent that
    /// hands NUL-delimited bytes back unmangled is a second thing to get right
    /// for a claim that would be no stronger. `perseverance-env`'s own pump
    /// tests cover the process behaviour on both runners.
    #[cfg(unix)]
    #[test]
    fn a_settled_launch_writes_no_file_where_the_harvest_ran() {
        use perseverance_env::{closing_mark, opening_mark, Bounds, HarvestCommand, Nonce};
        use tempfile::TempDir;

        let directory = TempDir::new().expect("a temporary directory");
        let nonce = Nonce::from_literal("deadbeefdeadbeef");
        let mut frame = opening_mark(&nonce);
        frame.extend_from_slice(b"PATH=/usr/bin:/bin\0");
        frame.extend_from_slice(&closing_mark(&nonce));
        let transcript = directory.path().join("transcript");
        std::fs::write(&transcript, &frame).expect("writes the transcript");

        let command = HarvestCommand {
            shell: Shell::LoginShell {
                program: "/bin/cat".to_string(),
            },
            program: "/bin/cat".to_string(),
            args: vec![transcript.to_string_lossy().into_owned()],
            cwd: directory.path().to_path_buf(),
            env_overlay: Vec::new(),
        };

        let ambient = Ambient::harvesting();
        let readout = settle_into(
            &ambient,
            || perseverance_env::harvest_with(&command, &nonce, &Bounds::for_this_machine()),
            |_| TokenOutcome::NotAttempted,
        );

        let json = serde_json::to_value(&readout).expect("serialises");
        assert_eq!(json["harvest"]["kind"], "harvested");
        assert_eq!(json["path"], "/usr/bin:/bin");

        let left: Vec<_> = std::fs::read_dir(directory.path())
            .expect("reads the directory")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("transcript")]);
    }

    /* --------------------------------------------- per-folder resolution --- */

    use perseverance_agent::OverrideRefusal;
    use tempfile::TempDir;

    /// A file this platform would agree to execute. On unix that is the
    /// executable bit; on Windows it is being a file at all, because
    /// `Environment::spellings` tries the bare name before any `PATHEXT`
    /// spelling and this is that bare name.
    fn runnable_file(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("writes the program");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("makes it a program");
        }
        path
    }

    /// The host's `PATH` spelling for a list of directories. The separator is
    /// the one `Environment::resolve` splits on, so a test that built the other
    /// one would be asserting against a `PATH` this machine cannot have.
    fn path_over(directories: &[&Path]) -> String {
        let separator = if cfg!(windows) { ";" } else { ":" };
        directories
            .iter()
            .map(|directory| directory.to_string_lossy().into_owned())
            .collect::<Vec<String>>()
            .join(separator)
    }

    /// A folder whose harvest is already settled, so nothing below runs a login
    /// shell. Priming the cell is the whole trick: `read_folder` asks the same
    /// map on the same key and the taker is never called.
    fn folder_resolving_over(path: &str) -> (Harvests, TempDir) {
        let folder = TempDir::new().expect("the folder being opened");
        let harvests = Harvests::new();
        harvests.in_folder_with(folder.path(), &|_| {
            harvest_of(&[
                ("PATH", path.as_bytes()),
                ("PATHEXT", b".COM;.EXE;.BAT;.CMD"),
            ])
        });
        (harvests, folder)
    }

    /// `src/environment/folder.ts` is a hand-written mirror of this, and twelve
    /// keys is the count both files assert — the same defence, and the same
    /// cost, as the app-global readout's ten.
    /// One reading, found by id rather than by position.
    ///
    /// Index 0 was fine while one adapter shipped and is a latent identity
    /// assumption now that three do: the guarantee `adapters_in` gives is one
    /// entry per registered adapter in `AgentId::ALL` order, and a test that
    /// reads `[0]` is asserting against whichever happens to be first.
    fn reading_for(json: &serde_json::Value, id: AgentId) -> &serde_json::Value {
        json["adapters"]
            .as_array()
            .expect("an array")
            .iter()
            .find(|reading| reading["id"] == id.as_str())
            .unwrap_or_else(|| panic!("{id} is registered and produced no reading"))
    }

    /// **Every registered adapter is read, and `adapters_in` never learned
    /// which.**
    ///
    /// The evidence for criterion 5 of #46, and it is an absence: `adapters_in`
    /// was written at #45 against one adapter, loops `AgentId::ALL`, resolves
    /// through `locate_in` and selects probes with `probes.on(Platform::host())`
    /// — and picked up two more adapters at #46 without a line changing. This
    /// asserts the shape that makes that true: one reading per registered
    /// adapter, in the registry's own order, and nothing in the readout keyed to
    /// a particular one.
    fn every_adapter_was_read(json: &serde_json::Value) {
        let read: Vec<&str> = json["adapters"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|reading| reading["id"].as_str().expect("an id"))
            .collect();
        let registered: Vec<&str> = AgentId::ALL.iter().map(|id| id.as_str()).collect();

        assert_eq!(
            read, registered,
            "the readout is one row per registered adapter, in the registry's order"
        );
    }

    #[test]
    fn a_folder_readout_crosses_in_the_shape_the_frontend_declares() {
        let on_the_path = TempDir::new().expect("the one directory the PATH names");
        runnable_file(on_the_path.path(), "claude");
        let (harvests, folder) = folder_resolving_over(&path_over(&[on_the_path.path()]));

        let readout = read_folder(&harvests, None, &folder.path().to_string_lossy(), false);

        let json = serde_json::to_value(&readout).expect("serialises");
        assert_eq!(json["folder"], folder.path().to_string_lossy().into_owned());
        assert!(json["spawnDirectory"].is_string());
        assert_eq!(json["harvest"]["kind"], "harvested");
        assert_eq!(json["shell"]["kind"], "loginShell");
        assert_eq!(json["path"], path_over(&[on_the_path.path()]));
        assert_eq!(json["pathSource"], "harvest");
        assert_eq!(json["variableCount"], 2);
        assert_eq!(json["elapsedMs"], 187);
        assert_eq!(json["stderr"]["kind"], "empty");
        assert_eq!(json["degradation"]["kind"], "notSeen");
        assert_eq!(json["override"]["kind"], "none");

        // Three adapters ship, all of them read here, and the absolute path is
        // the headline fact for each: it is the only visible form a version pin
        // has. Only `claude` is on this `PATH`, so it is the one that resolved —
        // and the other two producing a *not found* row rather than no row is
        // the point.
        every_adapter_was_read(&json);
        let claude = reading_for(&json, AgentId::ClaudeCode);
        assert_eq!(claude["resolution"]["kind"], "resolved");
        assert_eq!(claude["resolution"]["name"], "claude");
        assert_eq!(claude["resolution"]["from"], "candidate");
        assert!(Path::new(claude["resolution"]["program"].as_str().expect("a path")).is_absolute());
        // Empty, and on purpose: Claude Code declares `Probes::NONE`, because a
        // supported install is a native image and a shim is refused at spawn by
        // `perseverance_pty::accept` rather than sniffed here. The panel says so
        // rather than showing a blank.
        assert_eq!(claude["probes"].as_array().expect("an array").len(), 0);

        // And the two #46 added declare one, so the probe rows in the panel now
        // have a producer. Nothing is asserted about what the probe *said* —
        // whether this machine has a `node` is not this test's business, and
        // reading a probe for a verdict is what `docs/adr/0011` refuses.
        for (id, declared) in [(AgentId::Codex, 1), (AgentId::Pi, expected_pi_probes())] {
            let reading = reading_for(&json, id);
            assert_eq!(reading["resolution"]["kind"], "notFound");
            assert_eq!(reading["resolution"]["names"][0], id.as_str());
            assert_eq!(
                reading["probes"].as_array().expect("an array").len(),
                declared,
                "{id} declared a different number of probes than the panel was handed"
            );
        }

        assert_eq!(json.as_object().expect("an object").len(), 12);
    }

    /// Pi is the first adapter whose probes differ by platform: `node` on unix,
    /// `node` and the `bash` one of its own tools needs on Windows. The readout
    /// runs the host's, so the count this test expects is the host's too.
    fn expected_pi_probes() -> usize {
        perseverance_agent::agent(AgentId::Pi)
            .discovery()
            .probes
            .on(Platform::host())
            .len()
    }

    /// The one place `perseverance_agent::Scope` and
    /// `perseverance_env::Environment::resolve` can be put beside each other:
    /// the agent crate depends on nothing and the env crate has never heard of
    /// it, so only the wiring layer can check that the name the operator is
    /// shown matches the behaviour they get.
    #[test]
    fn the_two_readings_of_a_bare_name_agree() {
        /// `resolve`'s own rule, spelled from `std::path` — a name with a
        /// non-empty parent is taken at its word, anything else walks `PATH`.
        fn taken_at_its_word(named: &str) -> bool {
            Path::new(named)
                .parent()
                .is_some_and(|parent| !parent.as_os_str().is_empty())
        }

        for named in [
            "claude",
            "node",
            "/usr/local/bin/claude",
            r"C:\tools\claude.exe",
        ] {
            let chosen = Override::from_argv(vec![OsString::from(named)]).expect("a program");
            let pinned = matches!(chosen.scope(Platform::host()), Scope::PinnedGlobally);

            assert_eq!(
                pinned,
                taken_at_its_word(named),
                "{named} is read one way by Scope and another by resolve"
            );
        }

        // And that rule, mechanically, against a real `PATH` and real files.
        // The pinned spelling wins over a `PATH` that names a different program
        // of the same name, which is the whole of "an absolute path pins
        // globally"; the bare one comes back from the `PATH` walk, which is the
        // whole of "a bare name follows the folder's pin".
        let on_the_path = TempDir::new().expect("the one directory the PATH names");
        let elsewhere = TempDir::new().expect("somewhere the PATH does not name");
        let walked = runnable_file(on_the_path.path(), "wf45claude");
        let pinned = runnable_file(elsewhere.path(), "wf45claude");
        let environment = harvest_of(&[
            ("PATH", path_over(&[on_the_path.path()]).as_bytes()),
            ("PATHEXT", b".COM;.EXE;.BAT;.CMD"),
        ])
        .outcome
        .expect("harvested")
        .environment;

        assert_eq!(environment.resolve("wf45claude"), Some(walked));
        assert_eq!(
            environment.resolve(&pinned.to_string_lossy()),
            Some(pinned.clone())
        );
        assert!(matches!(
            Override::from_argv(vec![OsString::from("wf45claude")])
                .expect("a program")
                .scope(Platform::host()),
            Scope::FollowsTheFolder
        ));
        assert!(matches!(
            Override::from_argv(vec![pinned.into_os_string()])
                .expect("a program")
                .scope(Platform::host()),
            Scope::PinnedGlobally
        ));
    }

    /// Criterion 9 at this layer. `read_folder`'s return type carries no
    /// `Result`, and neither does any of the four commands over it, so a folder
    /// whose adapter is nowhere cannot become a rejected call.
    #[test]
    fn a_folder_whose_cli_is_missing_still_produces_a_readout() {
        let nothing_here = TempDir::new().expect("a directory with no programs in it");
        let (harvests, folder) = folder_resolving_over(&path_over(&[nothing_here.path()]));

        let readout: FolderReadout =
            read_folder(&harvests, None, &folder.path().to_string_lossy(), false);

        let json = serde_json::to_value(&readout).expect("serialises");
        // Every registered adapter, every one of them nowhere, and a readout
        // rather than a refusal for all three.
        every_adapter_was_read(&json);
        for id in AgentId::ALL.iter().copied() {
            let reading = reading_for(&json, id);
            assert_eq!(reading["resolution"]["kind"], "notFound");
            assert_eq!(reading["resolution"]["names"][0], id.as_str());
        }
        // Criterion 7's four facts, all on the one value the error surface is
        // handed: the names tried, the shell that ran, what became of the
        // harvest, and the verbatim `PATH`. None of them is copied into the
        // refusal, because there is one home per fact.
        assert_eq!(json["shell"]["kind"], "loginShell");
        assert_eq!(json["shell"]["program"], "/bin/zsh");
        assert_eq!(json["harvest"]["kind"], "harvested");
        assert_eq!(json["path"], path_over(&[nothing_here.path()]));
        assert_eq!(json["pathSource"], "harvest");
    }

    /// The key, echoed. Two spellings of one folder are one harvest because the
    /// key is canonicalised, and this is where an operator can see which
    /// directory the child was actually given.
    #[test]
    fn a_folder_readout_names_the_directory_the_child_was_given() {
        let nothing_here = TempDir::new().expect("a directory with no programs in it");
        let (harvests, folder) = folder_resolving_over(&path_over(&[nothing_here.path()]));
        let spelled = folder.path().join(".");

        let asked = read_folder(&harvests, None, &folder.path().to_string_lossy(), false);
        let same = read_folder(&harvests, None, &spelled.to_string_lossy(), false);

        assert_eq!(
            asked.spawn_directory,
            perseverance_env::spawn_directory(folder.path())
                .to_string_lossy()
                .into_owned()
        );
        // The folder crosses as it was asked for and the directory as it was
        // resolved, which is how two rows that are one directory can be seen to
        // be one.
        assert_ne!(asked.folder, same.folder);
        assert_eq!(asked.spawn_directory, same.spawn_directory);
    }

    /// The override resolves through the same one resolver a candidate does,
    /// and the scope it is shown under is the one it actually got.
    #[test]
    fn an_override_is_resolved_against_the_folders_own_environment() {
        let on_the_path = TempDir::new().expect("the one directory the PATH names");
        runnable_file(on_the_path.path(), "wf45node");
        let (harvests, folder) = folder_resolving_over(&path_over(&[on_the_path.path()]));
        let chosen = Override::from_argv(vec![
            OsString::from("wf45node"),
            OsString::from("/opt/claude/cli.js"),
        ])
        .expect("a program");

        let readout = read_folder(
            &harvests,
            Some(chosen),
            &folder.path().to_string_lossy(),
            false,
        );

        let json = serde_json::to_value(&readout).expect("serialises");
        // A path string could not have said this: `argv[0]` is the interpreter
        // and the rest is interposed ahead of whatever the adapter plans.
        assert_eq!(json["override"]["kind"], "inUse");
        assert_eq!(json["override"]["argv"][0], "wf45node");
        assert_eq!(json["override"]["argv"][1], "/opt/claude/cli.js");
        assert_eq!(json["override"]["scope"], "followsTheFolder");

        // **The override is app-global, so at three adapters every row resolves
        // to the same program.** #45 decided one row and one key with one
        // adapter in the tree, where that was invisible; it is visible now and
        // it is the decision working rather than a fault, so the panel says so
        // in as many words. A per-adapter key would be a different decision and
        // is not this ticket's.
        every_adapter_was_read(&json);
        for id in AgentId::ALL.iter().copied() {
            let reading = reading_for(&json, id);
            assert_eq!(reading["resolution"]["kind"], "resolved");
            assert_eq!(reading["resolution"]["from"], "override");
            assert_eq!(
                reading["resolution"]["program"],
                on_the_path
                    .path()
                    .join("wf45node")
                    .to_string_lossy()
                    .into_owned(),
                "{id} resolved somewhere other than the one override that is stored"
            );
        }
    }

    /// One row of the `app` table the default adapter already lives in — no
    /// schema change, no migration, and deliberately not `folders.adapter`,
    /// which is per folder.
    #[test]
    fn the_override_is_one_app_wide_row_and_a_row_that_is_nonsense_reads_as_none() {
        let store = Store::open_in_memory().expect("opens");

        assert_eq!(stored_override(&store), None);

        remember_override(&store, &["node".to_string(), "/opt/cli.js".to_string()])
            .expect("writes");
        let read = stored_override(&store).expect("an override");
        assert_eq!(
            read.argv(),
            [OsString::from("node"), OsString::from("/opt/cli.js")]
        );

        // A malformed cell is not a reason to hold a folder shut, so it reads
        // as *no override* rather than as a failure.
        store.set_app(OVERRIDE_KEY, "not json").expect("writes");
        assert_eq!(stored_override(&store), None);

        // The two the crate refuses from the vector alone, both of which reach
        // this row only if something else wrote it: clearing writes `[]`, and
        // that is the same reading as never having written at all.
        for written in ["[]", "[\"\"]", "[\"   \"]"] {
            store.set_app(OVERRIDE_KEY, written).expect("writes");
            assert_eq!(stored_override(&store), None, "{written}");
        }
        assert_eq!(
            Override::from_argv(Vec::new()),
            Err(OverrideRefusal::Nothing)
        );
        assert_eq!(
            Override::from_argv(vec![OsString::from(" ")]),
            Err(OverrideRefusal::BlankProgram)
        );
    }

    /* ----------------------------------------------- what a quit costs --- */

    fn a_stake(ticket: u64, folder: &str, kind: RunKind) -> Stakes {
        Stakes {
            ticket: Some(ticket),
            folder: folder.to_string(),
            kind,
        }
    }

    /// The third run kind, whose whole difference from the other two is that
    /// it has no ticket: it is named by the folder it is charting, and its
    /// sentence promises no Resume, because there is no claim to pick back up.
    ///
    /// A pure call rather than a run through the registry — the end-to-end join
    /// is covered below, and this is the prose.
    #[test]
    fn a_charting_run_is_named_by_its_folder_and_strands_no_claim() {
        let charting = what_it_loses(
            RunId::from_u64(4),
            Some(&Stakes {
                ticket: None,
                folder: "perseverance".to_string(),
                kind: RunKind::Chart,
            }),
        );

        assert!(charting.contains("charting perseverance"), "{charting}");
        assert!(charting.contains(CHART_LOSS), "{charting}");
        // Not `#0`, which is a run an operator would go looking for.
        assert!(
            !charting.contains('#'),
            "a charting run names a ticket it does not have: {charting}"
        );

        // And the run nobody staked still answers, unchanged by the ticket
        // becoming optional beside it.
        assert!(what_it_loses(RunId::from_u64(5), None).contains(UNKNOWN_LOSS));
    }

    /// Charting answers in [`Started`] and not in a second enum, so the
    /// WebView has one shape to mirror — and every refusal of it names no
    /// frontier, because a chart press asked about no target and learned none.
    #[test]
    fn what_start_charting_answers_crosses_in_the_shape_start_working_already_declares() {
        let spawned = serde_json::to_value(Started::Spawned {
            run: 9,
            prompt: prompt::chart(
                None,
                &prompt::Bearings {
                    repo: "javrasya/perseverance".to_string(),
                    repo_url: "https://github.com/javrasya/perseverance".to_string(),
                    operator: "javrasya".to_string(),
                    idea: "an idea box on an empty folder".to_string(),
                },
            ),
        })
        .expect("serialises");

        assert_eq!(spawned["kind"], "spawned");
        assert_eq!(spawned["run"], 9);
        assert_eq!(spawned["prompt"]["origin"], "stock");
        assert_eq!(spawned.as_object().expect("an object").len(), 3);

        let refused = serde_json::to_value(Started::refused(
            "this folder holds no usable .git",
            // The only frontier a chart refusal ever carries.
            None,
        ))
        .expect("serialises");

        assert_eq!(refused["kind"], "refused");
        assert_eq!(refused["detail"], "this folder holds no usable .git");
        assert_eq!(refused["frontier"], serde_json::Value::Null);
    }

    /// A run this app really opened, so the join between the registry and the
    /// stakes table is exercised against a run rather than against a value the
    /// test wrote down itself.
    ///
    /// Nothing in the shipped app opens a run yet — that is #48's — but nothing
    /// stops a test from doing it, and the sentence a quit shows is the wrong
    /// thing to leave standing on a pure function alone.
    fn a_live_run_in(terminals: &Terminals, directory: &Path) -> RunId {
        #[cfg(windows)]
        let (argv, line) = (
            vec![
                std::env::var_os("COMSPEC").expect("a command interpreter"),
                OsString::from("/c"),
            ],
            "timeout /t 30 /nobreak >nul",
        );
        #[cfg(not(windows))]
        let (argv, line) = (
            vec![OsString::from("/bin/sh"), OsString::from("-c")],
            "sleep 30",
        );

        let mut argv = argv;
        argv.push(OsString::from(line));

        // The child's environment is cleared before it starts, so a sleeper
        // given only `TERM` has no `PATH` and is not a sleeper at all — it is a
        // run that ended before the assertions got to it.
        #[cfg(windows)]
        let system = {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            [
                ("PATH".to_string(), format!("{root}\\system32")),
                ("SystemRoot".to_string(), root),
            ]
        };
        #[cfg(not(windows))]
        let system: [(String, String); 0] = [];

        let mut environment = vec![("TERM".to_string(), "xterm-256color".to_string())];
        environment.extend(system);

        let accepted = perseverance_pty::accept(perseverance_agent::Launch::new(
            argv,
            &[],
            environment,
            perseverance_agent::Ready::Quiet {
                quiet: std::time::Duration::from_millis(400),
                max: std::time::Duration::from_secs(10),
            },
        ))
        .expect("a system shell is a native image");

        terminals
            .held()
            .open(accepted, directory, &[])
            .expect("a shell starts")
    }

    /// The first criterion, end to end: a run opened through the registry, given
    /// stakes, and named by what it loses.
    ///
    /// The pure function is well covered elsewhere; this is the part that was
    /// not — that `staked` and `losses` join the two sides at all, and that a
    /// work run and a research run come out of a real registry saying different
    /// things. A run nobody staked is here too, because that is the only
    /// sentence the shipped app can produce until #48 lands and it must not be
    /// the one nobody looked at.
    #[test]
    fn a_staked_run_is_named_by_what_it_loses_and_an_unstaked_one_is_still_named() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();

        let work = a_live_run_in(&terminals, directory.path());
        let research = a_live_run_in(&terminals, directory.path());
        let _unstaked = a_live_run_in(&terminals, directory.path());

        terminals.staked(work, a_stake(51, "perseverance", RunKind::Work));
        terminals.staked(research, a_stake(58, "controlayer", RunKind::Research));

        let losses = terminals.losses();
        assert_eq!(losses.len(), 3, "{losses:?}");
        assert!(losses[0].contains("#51 in perseverance"), "{}", losses[0]);
        assert!(losses[0].contains(WORK_LOSS), "{}", losses[0]);
        assert!(losses[1].contains("#58 in controlayer"), "{}", losses[1]);
        assert!(losses[1].contains(RESEARCH_LOSS), "{}", losses[1]);
        assert!(losses[2].contains(UNKNOWN_LOSS), "{}", losses[2]);

        // And the confirmation those three produce is the one an operator would
        // be shown, counted off the same snapshot the gate decided on.
        assert_eq!(on_close(losses.len(), &Quit::NotAsked), OnClose::Ask);
        let said = confirmation(&losses);
        assert!(said.contains("3 runs are still live"), "{said}");

        // After the quit there is nothing left to name, and a second close
        // request goes straight through rather than asking about nothing.
        terminals.held().shut_down();
        assert!(terminals.losses().is_empty());
        assert_eq!(
            on_close(terminals.losses().len(), &Quit::NotAsked),
            OnClose::GoNow
        );
    }

    /// The count the poller's ten-second rung is a function of, and the only
    /// thing that ever brings it back down.
    ///
    /// A real run and a real poller, because the property is about a handle
    /// living in a table beside the stakes rather than about a number: nothing
    /// else in this process can increment it, and letting go of the row is what
    /// sends `Poke::RunExited`.
    #[test]
    fn a_started_run_is_counted_live_until_the_readout_says_it_is_over() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();
        let poker =
            perseverance_github::start(Timings::shipped(), |_watched, _ahead| Tick::NotAttempted)
                .expect("a poller thread");

        let run = a_live_run_in(&terminals, directory.path());
        terminals.counting(run, poker.run_started());
        assert_eq!(poker.runs_live(), 1);

        // The falling edge, exactly as the readout tick takes it.
        terminals.let_go_of(&[run]);
        assert_eq!(poker.runs_live(), 0);
    }

    /// The second press, and the only evidence there is for it to be refused on.
    ///
    /// A compose takes no claim and its map stays `Phase::SpecReady` until the
    /// spec lands at the end of the run, so every guard the command has already
    /// answers a second press exactly as it answered the first — the live run
    /// is the whole of what is left. And it has to be *live*: a stake outlives
    /// the run it describes, so reading the table alone would refuse every
    /// press for the rest of the launch and leave a map whose compose died with
    /// no way to compose a spec at all.
    #[test]
    fn a_live_compose_refuses_a_second_one_and_a_finished_compose_refuses_nothing() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();

        let composing = a_live_run_in(&terminals, directory.path());
        let working = a_live_run_in(&terminals, directory.path());
        terminals.staked(composing, a_stake(28, "perseverance", RunKind::Compose));
        terminals.staked(working, a_stake(75, "perseverance", RunKind::Work));

        assert!(terminals.composing(28));
        assert_eq!(
            a_compose_is_already_open(28),
            "#28 already has a compose run open"
        );
        // By map and by kind: a work run that happens to be numbered like a map
        // is not a compose, and another map's compose is not this map's.
        assert!(!terminals.composing(75));
        assert!(!terminals.composing(29));

        // The run ends. Its stake stays — what it was doing is still nameable —
        // and the offer comes back, because liveness is the registry's reading
        // rather than the table's.
        terminals.held().shut_down();
        assert!(!terminals.composing(28));
    }

    /// The whole of [`ending`], as a table over the two facts.
    ///
    /// Written out rather than derived from anything, because the value of the
    /// table is exactly that it can be read: every pairing an operator can
    /// arrive at is one line here, and the two rows worth arguing are the last
    /// ones — an exit over a ticket nobody holds is `Exited`, not
    /// `ExitedUnresolved`, and so is an exit over a ticket this app has never
    /// seen. Neither may assert a claim that is not there.
    #[test]
    fn an_ending_is_the_two_facts_crossed_and_nothing_else() {
        assert_eq!(ending(false, None), Ending::Live);
        assert_eq!(ending(false, Some(NodeState::Claimed)), Ending::Live);
        assert_eq!(ending(false, Some(NodeState::Takeable)), Ending::Live);

        // Resolution outranks the process in both columns, which is what makes
        // *spent* independent of the child rather than a state after it.
        assert_eq!(ending(false, Some(NodeState::Resolved)), Ending::Spent);
        assert_eq!(ending(true, Some(NodeState::Resolved)), Ending::Spent);

        assert_eq!(
            ending(true, Some(NodeState::Claimed)),
            Ending::ExitedUnresolved
        );
        assert_eq!(ending(true, Some(NodeState::Takeable)), Ending::Exited);
        assert_eq!(ending(true, Some(NodeState::Blocked)), Ending::Exited);
        assert_eq!(ending(true, None), Ending::Exited);
    }

    /// A closed ticket is the end of the story, and no later tick reopens it.
    ///
    /// The two reads are the same map before and after #77 closed, so the
    /// *earlier* one is fed back last: that is a map the operator re-opened, a
    /// cache replayed, a poll that landed out of order — and none of them is a
    /// ticket being re-opened. A run staked on a number this map has never
    /// listed is here for the other absence: nothing observed, nothing written,
    /// and the run keeps the ending it had.
    #[test]
    fn a_ticket_seen_closed_leaves_its_run_spent_for_the_rest_of_its_life() {
        let terminals = Terminals::new();
        let (open, elsewhere) = (RunId::from_u64(1), RunId::from_u64(2));
        terminals.staked(open, a_stake(77, "/repos/perseverance", RunKind::Work));
        terminals.staked(elsewhere, a_stake(77, "/repos/controlayer", RunKind::Work));

        terminals.noticed("/repos/perseverance", &model_of(AWKWARD));
        assert_ne!(
            terminals.resolved_here().get(&open),
            Some(&NodeState::Resolved)
        );

        terminals.noticed("/repos/perseverance", &model_of(AWKWARD_LATER));
        assert_eq!(
            terminals.resolved_here().get(&open),
            Some(&NodeState::Resolved)
        );

        // The earlier read again, and the latch holds.
        terminals.noticed("/repos/perseverance", &model_of(AWKWARD));
        assert_eq!(
            terminals.resolved_here().get(&open),
            Some(&NodeState::Resolved)
        );

        // #77 in another folder is another ticket entirely, and the poll that
        // closed this one says nothing about it.
        assert_eq!(terminals.resolved_here().get(&elsewhere), None);

        // A ticket no read has ever listed writes nothing at all, which is what
        // keeps *absent* from being read as *open*.
        let unlisted = RunId::from_u64(3);
        terminals.staked(
            unlisted,
            a_stake(9_999, "/repos/perseverance", RunKind::Work),
        );
        terminals.noticed("/repos/perseverance", &model_of(AWKWARD_LATER));
        assert_eq!(terminals.resolved_here().get(&unlisted), None);
    }

    /// The first criterion's other half: the node flips and **the terminal is
    /// untouched**.
    ///
    /// A real run, a real registry and the real derivation, because the promise
    /// is about what a resolution does *not* do and a pure function cannot be
    /// asked. Everything the pane depends on is compared across the tick: the
    /// run is still open, still monitored, still not over, and still holds the
    /// bytes it held.
    #[test]
    fn a_ticket_closing_makes_a_run_spent_and_leaves_its_terminal_exactly_as_it_was() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();

        let run = a_live_run_in(&terminals, directory.path());
        terminals.staked(run, a_stake(77, "/repos/perseverance", RunKind::Work));
        terminals.held().monitor(Some(run));

        let registry = |terminals: &Terminals| -> Vec<(u64, bool, bool, u64)> {
            terminals
                .held()
                .telemetry()
                .iter()
                .map(|readout| {
                    (
                        readout.run.as_u64(),
                        readout.monitored,
                        readout.over,
                        readout.end,
                    )
                })
                .collect()
        };
        let before = registry(&terminals);
        assert_eq!(before.len(), 1);

        terminals.noticed("/repos/perseverance", &model_of(AWKWARD_LATER));

        assert_eq!(registry(&terminals), before);
        let readouts = terminals.readouts();
        assert_eq!(readouts.len(), 1);
        assert_eq!(readouts[0].ending, Ending::Spent);
        // Spent while the child is still running, which is the pairing the two
        // facts are independent *for*.
        assert!(!readouts[0].over);
        assert_eq!(terminals.losses().len(), 1);
    }

    /// Spent holds its slot, and only a press takes it.
    ///
    /// Every tick this app takes by itself is exercised first — a resolution and
    /// a readout, twice over — and the run is still there afterwards. Then the
    /// press, which is the one thing that closes the session, drops the stakes,
    /// forgets the resolution and lets go of the handle the ladder counts.
    #[test]
    fn a_spent_run_holds_its_slot_until_a_press_ends_it() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();
        let poker =
            perseverance_github::start(Timings::shipped(), |_watched, _ahead| Tick::NotAttempted)
                .expect("a poller thread");

        let run = a_live_run_in(&terminals, directory.path());
        terminals.staked(run, a_stake(77, "/repos/perseverance", RunKind::Work));
        terminals.counting(run, poker.run_started());

        terminals.noticed("/repos/perseverance", &model_of(AWKWARD_LATER));
        assert_eq!(terminals.readouts()[0].ending, Ending::Spent);
        terminals.noticed("/repos/perseverance", &model_of(AWKWARD_LATER));
        assert_eq!(terminals.readouts().len(), 1);
        assert_eq!(poker.runs_live(), 1);

        terminals.ended(run);

        assert!(terminals.readouts().is_empty());
        assert!(terminals.losses().is_empty());
        assert!(terminals.staked_here().is_empty());
        assert!(terminals.resolved_here().is_empty());
        assert_eq!(poker.runs_live(), 0);
    }

    /// The mapping is written once. `route.ts` draws the same line for
    /// `Attendance`, and both read [`TicketType`] rather than a second enum.
    #[test]
    fn a_run_kind_is_read_off_the_ticket_type_and_not_spelled_again() {
        assert_eq!(RunKind::of(TicketType::Research), RunKind::Research);
        assert_eq!(RunKind::of(TicketType::Prototype), RunKind::Work);
        assert_eq!(RunKind::of(TicketType::Grilling), RunKind::Work);
        assert_eq!(RunKind::of(TicketType::Task), RunKind::Work);
    }

    #[test]
    fn one_confirmation_names_what_every_live_run_loses() {
        let losses = [
            what_it_loses(
                RunId::from_u64(1),
                Some(&a_stake(51, "perseverance", RunKind::Work)),
            ),
            what_it_loses(
                RunId::from_u64(2),
                Some(&a_stake(58, "controlayer", RunKind::Research)),
            ),
        ];

        let said = confirmation(&losses);

        assert!(said.contains("#51"), "{said}");
        assert!(said.contains("perseverance"), "{said}");
        assert!(said.contains("#58"), "{said}");
        assert!(said.contains("controlayer"), "{said}");
        assert!(said.contains("2 runs are still live"), "{said}");

        // The distinction the ticket is about: a work run strands something
        // that can be picked back up, and a research run strands nothing
        // because there was nothing kept to strand.
        assert!(losses[0].contains("claim"), "{}", losses[0]);
        assert!(!losses[1].contains("claim"), "{}", losses[1]);
        assert!(losses[1].contains("keeps nothing"), "{}", losses[1]);

        // One confirmation and not one per run. The headline is counted once
        // and the sentence saying what a quit will do appears once, however
        // many runs are named between them — which is what makes this a single
        // question rather than a queue of them.
        assert_eq!(said.matches("still live").count(), 1, "{said}");
        assert_eq!(said.matches(&closing()).count(), 1, "{said}");
    }

    /// A run with no row in the stakes table is still a live run, and a quit
    /// still ends it. Leaving it out would make the confirmation quietest
    /// exactly where the app is least sure.
    #[test]
    fn a_live_run_this_app_cannot_name_is_still_named_in_the_confirmation() {
        let loss = what_it_loses(RunId::from_u64(7), None);

        assert!(loss.contains("run 7"), "{loss}");
        assert!(loss.contains("cannot say what this one loses"), "{loss}");
        // It says it does not know rather than guessing a kind, which is the
        // one thing a sentence about an unrecoverable loss may not do.
        assert!(!loss.contains("claim"), "{loss}");
        assert!(!loss.contains("keeps nothing"), "{loss}");

        let said = confirmation(std::slice::from_ref(&loss));
        assert!(said.contains("one run is still live"), "{said}");
        assert!(said.contains(&loss), "{said}");
    }

    #[test]
    fn a_quit_with_nothing_live_asks_nothing() {
        assert_eq!(on_close(0, &Quit::NotAsked), OnClose::GoNow);
    }

    #[test]
    fn the_confirmation_is_asked_once_however_many_runs_are_live() {
        assert_eq!(on_close(4, &Quit::NotAsked), OnClose::Ask);
        // Every close request that arrives while the dialog is up is refused
        // rather than answered with a second dialog.
        assert_eq!(on_close(4, &Quit::Asking), OnClose::WaitForTheAnswer);
        // And the one the confirmed dialog itself sends goes straight through,
        // because the question has already been answered.
        assert_eq!(on_close(4, &Quit::Confirmed), OnClose::GoNow);
    }

    /// *Keep working* is the answer that has to leave the app exactly as it was,
    /// and the transition that makes that true is the gate going back to *not
    /// asked* — so a second close request asks again rather than quitting
    /// silently or wedging.
    #[test]
    fn keeping_working_puts_the_gate_back_and_a_second_close_request_asks_again() {
        let quitting = Quitting::new();
        assert_eq!(quitting.asked(), Quit::NotAsked);

        quitting.now(Quit::Asking);
        assert_eq!(on_close(2, &quitting.asked()), OnClose::WaitForTheAnswer);

        quitting.no_longer_asking();
        assert_eq!(quitting.asked(), Quit::NotAsked);
        assert_eq!(on_close(2, &quitting.asked()), OnClose::Ask);
    }

    /// And the other half of that transition: an answer that already landed is
    /// not undone by the thread that carried it ending.
    #[test]
    fn an_answered_quit_is_not_taken_back_when_the_asking_ends() {
        let quitting = Quitting::new();
        quitting.now(Quit::Asking);
        quitting.now(Quit::Confirmed);

        quitting.no_longer_asking();

        assert_eq!(quitting.asked(), Quit::Confirmed);
        assert_eq!(on_close(2, &quitting.asked()), OnClose::GoNow);
    }

    /// The failure mode nothing else would catch: the asking thread dies without
    /// reaching an answer. `Released` is the whole of the defence and it is a
    /// `Drop`, so unwinding out of `blocking_show` releases the gate too.
    #[test]
    fn a_question_that_never_gets_an_answer_still_lets_go_of_the_gate() {
        let app = mock_app();
        app.manage(Quitting::new());
        app.state::<Quitting>().now(Quit::Asking);

        drop(Released(app.handle().clone()));

        assert_eq!(app.state::<Quitting>().asked(), Quit::NotAsked);
    }

    /// Nothing live is let through without a word, and the gate is left alone —
    /// an app that recorded a question it never asked would ask nothing the next
    /// time either.
    #[test]
    fn a_quit_with_nothing_live_is_let_through_and_asks_nobody() {
        let app = mock_app();
        app.manage(Terminals::new());
        app.manage(Quitting::new());

        assert!(may_quit(app.handle()));
        assert_eq!(app.state::<Quitting>().asked(), Quit::NotAsked);
    }

    /// A close request that lands while the question is up is refused, and no
    /// second dialog is started. Asserted through the door the operator uses
    /// rather than through the rule alone.
    #[test]
    fn a_close_request_while_the_question_is_up_is_refused_and_asks_nothing_twice() {
        let directory = TempDir::new().expect("temp dir");
        let app = mock_app();
        app.manage(Terminals::new());
        app.manage(Quitting::new());
        a_live_run_in(&app.state::<Terminals>(), directory.path());
        app.state::<Quitting>().now(Quit::Asking);

        assert!(!may_quit(app.handle()));
        assert_eq!(app.state::<Quitting>().asked(), Quit::Asking);

        app.state::<Terminals>().held().shut_down();
    }

    /// The same three properties `crates/pty`'s guard asserts of every refusal
    /// it can raise: long enough to be a sentence, no trailing full stop, and
    /// no capital at the front. A quit is the last thing an operator reads from
    /// this app and it is not exempt.
    #[test]
    fn every_sentence_a_quit_shows_is_a_sentence() {
        let lines = [
            what_it_loses(
                RunId::from_u64(1),
                Some(&a_stake(51, "perseverance", RunKind::Work)),
            ),
            what_it_loses(
                RunId::from_u64(2),
                Some(&a_stake(58, "controlayer", RunKind::Research)),
            ),
            what_it_loses(RunId::from_u64(7), None),
        ];

        for line in &lines {
            assert!(
                line.len() > 40,
                "{line:?} is a label rather than a sentence"
            );
            assert!(
                !line.ends_with('.'),
                "{line:?} ends in a full stop; house style does not"
            );
            assert!(
                line.chars()
                    .next()
                    .is_some_and(|opening| !opening.is_uppercase()),
                "{line:?} opens upper case; house style does not"
            );
        }

        let said = confirmation(&lines);
        assert!(said.len() > 40, "{said:?} is a label rather than a message");
        assert!(
            said.chars()
                .next()
                .is_some_and(|opening| !opening.is_uppercase()),
            "{said:?} opens upper case; house style does not"
        );
        for line in said.lines().filter(|line| !line.is_empty()) {
            assert!(
                !line.ends_with('.'),
                "{line:?} ends in a full stop; house style does not"
            );
        }
        // The grace is spoken by reading the constant, so the sentence cannot
        // drift from the number it describes.
        assert!(
            said.contains(&format!("{} seconds later is ended", GRACE.as_secs())),
            "{said}"
        );
    }

    /// *No reattach machinery* is discharged by absence, and this is what keeps
    /// it discharged. A quit writes nothing about a run down — no session id,
    /// no run row, no claim — so the next launch has nothing to reattach to and
    /// a stranded claim is found the only way it ever was: by reading GitHub,
    /// where it is still an assignment.
    ///
    /// It is asserted against `crates/store` rather than against a behaviour
    /// because absence has no behaviour to test. The store's whole schema is
    /// three tables and this ticket added none of them.
    #[test]
    fn nothing_about_a_run_is_written_down_when_the_app_quits() {
        const STORE_SOURCES: [(&str, &str); 6] = [
            ("cache.rs", include_str!("../../store/src/cache.rs")),
            ("folders.rs", include_str!("../../store/src/folders.rs")),
            ("lib.rs", include_str!("../../store/src/lib.rs")),
            ("repo.rs", include_str!("../../store/src/repo.rs")),
            ("schema.rs", include_str!("../../store/src/schema.rs")),
            ("store.rs", include_str!("../../store/src/store.rs")),
        ];

        // A column is not a table: #82 stamped `graph_cache` with the identity
        // of the query document that filled it, which is version 3 and still
        // the same three tables.
        assert_eq!(perseverance_store::STORE_SCHEMA_VERSION, 3);

        // Down to the test module and no further: that crate's own tests write
        // a table nobody ships, to prove a foreign file is refused rather than
        // migrated over, and counting it here would be counting a fixture.
        let schema = include_str!("../../store/src/schema.rs");
        let shipped = schema
            .split_once("#[cfg(test)]")
            .map_or(schema, |(before, _)| before);
        let tables: Vec<&str> = shipped
            .match_indices("CREATE TABLE ")
            .map(|(at, marker)| {
                shipped[at + marker.len()..]
                    .split_whitespace()
                    .next()
                    .expect("a table name follows CREATE TABLE")
            })
            .collect();
        assert_eq!(tables, ["folders", "app", "graph_cache"]);

        // Every name a reattach would have to reach for. A run is a process and
        // a process does not survive its harness, so none of these belongs in a
        // file that outlives the launch.
        for (file, source) in STORE_SOURCES {
            for written in ["session", "Session", "run_id", "RunId", "runs"] {
                assert!(
                    !source.contains(written),
                    "crates/store/src/{file} names {written}, so something about a run \
                     outlives the process that had it"
                );
            }
        }
    }

    /* ------------------------------------------------- resuming a claim --- */

    /// A map whose nodes are exactly the states a resume has to tell apart.
    fn a_map_of(nodes: &[(u64, NodeState)]) -> Map {
        Map {
            number: 28,
            title: "The prompt is the product".to_string(),
            closed: false,
            phase: perseverance_model::Phase::Wayfinding,
            counts: perseverance_model::Counts {
                tickets: nodes.len(),
                open: nodes.len(),
                specs: 0,
            },
            nodes: nodes
                .iter()
                .map(|(number, state)| perseverance_model::Node {
                    number: *number,
                    title: format!("#{number}"),
                    url: format!("https://github.com/javrasya/perseverance/issues/{number}"),
                    kind: ChildKind::Ticket(TicketType::Task),
                    state: *state,
                    waits_on: Vec::new(),
                    bound_elsewhere: false,
                    cut: perseverance_model::Cut::InScope,
                })
                .collect(),
            frontier: Frontier::NothingToStart,
            fog: perseverance_model::Fog::Unsurveyed,
        }
    }

    /// **The first criterion.** Resume sends the prompt Start Working sends, and
    /// nothing in what either press carries says which of the two it was.
    ///
    /// Asserted against this file's own source, because the property is an
    /// absence: there is no second rendering whose output could be compared —
    /// there is one, and the ways it could stop being one are a second call site
    /// or a verb added to a signature. Both are pinned here, and a sixth
    /// template would have to introduce one of them.
    #[test]
    fn a_resume_renders_what_start_working_renders_and_neither_press_names_the_verb() {
        const SOURCE: &str = include_str!("lib.rs");

        // Built rather than written out, so this assertion is not counting
        // itself.
        let rendering = format!("{}::work_ticket(", "prompt");
        assert_eq!(
            SOURCE.matches(&rendering).count(),
            1,
            "a second call site is where a second prompt starts"
        );

        let press = |command: &str| -> String {
            let signature = format!("fn {command}(");
            let after = SOURCE
                .split(&signature)
                .nth(1)
                .unwrap_or_else(|| panic!("{command} is a command in this file"));
            after
                .split_once(") -> Started")
                .unwrap_or_else(|| panic!("{command} answers a Started"))
                .0
                .to_string()
        };
        assert_eq!(
            press("start_working"),
            press("resume_working"),
            "one press, and a verb in either signature is a prompt that can tell them apart"
        );

        // The third criterion on this side of the seam: no reattach machinery
        // anywhere, so there is nothing a resumed session could be handed that a
        // started one could not.
        for continuation in [
            format!("--{}", "continue"),
            format!("--{}", "resume"),
            format!("--{}-id", "session"),
            format!("{}_id", "session"),
        ] {
            assert!(
                !SOURCE.contains(&continuation),
                "{continuation} would be a transcript this harness kept"
            );
        }
    }

    /// **The second criterion, and the precedence consequence that comes with
    /// it.**
    ///
    /// A claim is resumable and every other reading of a node is a sentence — a
    /// different one each time, because *closed*, *something is in the way* and
    /// *nobody holds it* are three different things to tell an operator who has
    /// just pressed.
    ///
    /// **And two refusals before any state is read**, because Resume is aimed at
    /// the selection rather than at the frontier and inherits neither of the
    /// guards the frontier's resolver applies: a spec node and an unclassified
    /// child read `Claimed` the moment they are assigned, and so does a ticket
    /// this machine is not allowed to take.
    #[test]
    fn a_resume_is_offered_over_a_claim_and_refused_over_every_other_node() {
        let mut map = a_map_of(&[
            (70, NodeState::Claimed),
            (71, NodeState::Takeable),
            (72, NodeState::Blocked),
            (73, NodeState::Resolved),
        ]);

        // Assigned, unblocked and not a ticket: `NodeState` is derived from
        // state alone, so all three of these read `Claimed`.
        let claim = map.nodes[0].clone();
        map.nodes.push(perseverance_model::Node {
            number: 74,
            kind: ChildKind::Spec,
            ..claim.clone()
        });
        map.nodes.push(perseverance_model::Node {
            number: 75,
            kind: ChildKind::Unclassified,
            ..claim.clone()
        });
        // A claim on a ticket labelled for another platform. `docs/adr/0015`:
        // nothing is hidden and nothing is launched.
        map.nodes.push(perseverance_model::Node {
            number: 76,
            bound_elsewhere: true,
            ..claim
        });

        assert_eq!(why_the_claim_cannot_be_resumed(&map, 70), None);

        // The spec renders as the destination and never as something to launch
        // at, and an unclassified child has no brief to hand an agent: both
        // would otherwise fall through `kind_of` into a work run.
        for node in [74, 75] {
            let refusal = why_the_claim_cannot_be_resumed(&map, node)
                .unwrap_or_else(|| panic!("#{node} is not a ticket"));
            assert!(refusal.contains("not a wayfinder ticket"), "{refusal}");
        }
        // Nothing is hidden and nothing is launched: the node is on the map and
        // the press over it refuses.
        let elsewhere =
            why_the_claim_cannot_be_resumed(&map, 76).expect("#76 is another machine's");
        assert!(elsewhere.contains("another machine"), "{elsewhere}");

        let refusals: Vec<String> = [71, 72, 73]
            .iter()
            .map(|ticket| {
                let refusal = why_the_claim_cannot_be_resumed(&map, *ticket)
                    .unwrap_or_else(|| panic!("#{ticket} is not a claim"));
                assert!(refusal.contains(&format!("#{ticket}")), "{refusal}");
                refusal
            })
            .collect();
        assert_eq!(
            refusals
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3,
            "three readings, and an operator told which of them they met"
        );

        // A ticket assigned to the operator that has since gained an open
        // blocker reads `Blocked` and not `Claimed`, so it is not resumable —
        // strict precedence in the one derivation, and not this file's to soften
        // with a second opinion about what *claimed* means.
        assert!(refusals[1].contains("in its way"), "{}", refusals[1]);

        // A number this map does not carry is refused before any state is read.
        assert_eq!(
            why_the_claim_cannot_be_resumed(&map, 99).as_deref(),
            Some("#99 is not on this map")
        );
    }

    /// **Never a second claiming run against the same ticket from this window.**
    ///
    /// A real run, because the property is about a child that has not exited and
    /// a stakes row on its own cannot say that. The folder is half the match for
    /// the reason [`Terminals::noticed`] gives, and the two misses below are the
    /// same number in another repository and another number in this one.
    #[test]
    fn a_claim_this_window_already_has_a_live_run_on_is_not_spawned_over_again() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();

        let run = a_live_run_in(&terminals, directory.path());
        terminals.staked(run, a_stake(70, "/repos/perseverance", RunKind::Work));

        assert!(terminals.live_run_on(70, "/repos/perseverance"));
        assert!(!terminals.live_run_on(70, "/repos/controlayer"));
        assert!(!terminals.live_run_on(71, "/repos/perseverance"));

        // The pane closed, and the claim on GitHub outlives it: that stranded
        // claim is exactly what Resume is for, and it is resumable again the
        // moment nothing here is holding it.
        terminals.ended(run);
        assert!(!terminals.live_run_on(70, "/repos/perseverance"));
    }

    /// **The three writes and the bind, made by the one writer both verbs use.**
    ///
    /// A real registry and a real poller: a quit's sentence, the claim this
    /// harness will not later announce as somebody else's, the ladder's count,
    /// and the pane the operator ends up looking at. The unstaked run beside it
    /// is what a readout says when this app was never told what a run is for.
    #[test]
    fn a_run_this_harness_booked_is_staked_claimed_counted_and_watched() {
        let directory = TempDir::new().expect("temp dir");
        let terminals = Terminals::new();
        let claims = Claims::new();
        let poker =
            perseverance_github::start(Timings::shipped(), |_watched, _ahead| Tick::NotAttempted)
                .expect("a poller thread");

        let unstaked = a_live_run_in(&terminals, directory.path());
        let run = a_live_run_in(&terminals, directory.path());

        booked(
            &terminals,
            &claims,
            &poker,
            run,
            a_stake(70, "/repos/perseverance", RunKind::Work),
        );

        assert_eq!(terminals.losses().len(), 2, "one staked run and one not");
        assert_eq!(claims.originated(), vec![70]);
        assert_eq!(poker.runs_live(), 1);

        let readout = |of: RunId| {
            terminals
                .readouts()
                .into_iter()
                .find(|readout| readout.run == of.as_u64())
                .expect("a readout for a run that is open")
        };
        assert!(
            readout(run).monitored,
            "the operator watches what they started"
        );
        assert_eq!(readout(run).ticket, Some(70));
        assert_eq!(readout(unstaked).ticket, None);

        // A claim taken twice is still one claim, which is what keeps a resume
        // over a node this harness already took from announcing as foreign.
        booked(
            &terminals,
            &claims,
            &poker,
            unstaked,
            a_stake(70, "/repos/perseverance", RunKind::Work),
        );
        assert_eq!(claims.originated(), vec![70]);
    }
}
