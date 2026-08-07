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

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use perseverance_env::{Environment, HarvestAttempt, Shell, Stderr, StderrKind, Tally};
use perseverance_github::{
    acquire_token, read_maps, Ahead, Attention, Fault, FreshRead, Held, Poke, Poker, ReadFailure,
    Tick, Timings, TokenOutcome, Watched,
};
use perseverance_model::{
    read_response, ChangeLog, Degraded, MapRead, Model, Provenance, ReadOutcome, Snapshot, Source,
};
use perseverance_store::{Folder, RepoBindingError, Store, StoreError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

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
    truncated: bool,
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
            truncated: read.truncation.any(),
            yielding_to_rate_limit: false,
        }
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

/// The cached read for a folder, as a view — or the *nothing read yet* state.
///
/// A cached body that cannot be parsed is reported as a failed read of the
/// cache rather than deleted: **only a successful GitHub read may delete
/// anything**, and that rule has no exception for a row we happen to dislike.
fn from_cache(store: &Store, folder_id: i64) -> MapsView {
    let cached = match store.cached_graph(folder_id, None) {
        Ok(Some(cached)) => cached,
        // A registry that cannot be read is not a map list that is empty, but
        // there is nothing to paint either way and the launcher already carries
        // the registry's own refusal.
        Ok(None) | Err(_) => return MapsView::nothing_read_yet(folder_id),
    };

    match read_response(&cached.graph_json) {
        Ok(read) => MapsView::of(folder_id, &read, Source::Cache, cached.fetched_at),
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
/// `map` is the map the answer was read *with*, and it is why this takes four
/// arguments now. The same verbatim body goes under the folder's own key and
/// under that map's, because the map's row is the **while you were away**
/// baseline — the only thing a cold start has to compare against. One row per
/// `(folder, map)`, replaced rather than appended: this is a cache, and #41
/// refused a second history on the grounds that GitHub already keeps the real
/// one. So there is no new table here, no migration and no schema bump.
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
    store.cache_graph(folder_id, None, fresh.body(), fresh.fetched_at())?;

    if let Some(number) = map {
        store.cache_graph(folder_id, Some(number), fresh.body(), fresh.fetched_at())?;
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
    match store.cached_graph(watched.folder_id, watched.map) {
        Ok(Some(cached)) => match read_response(&cached.graph_json) {
            Ok(read) => ChangeLog::resuming(Model::of(&read)),
            Err(_) => ChangeLog::first_open(),
        },
        Ok(None) | Err(_) => ChangeLog::first_open(),
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
    emit_snapshot(
        app,
        ledgers.observed(
            Model::of(fresh.read()),
            fresh.fetched_at(),
            &claims.originated(),
        ),
    );
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

/// Everything the diagnostics surface shows, in one value.
///
/// The environment itself has exactly one exit from Rust and this is it: nine
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Registry::open(app.handle()));
            app.manage(Ambient::harvesting());
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
            Ok(())
        })
        /*
         * Focus is read here rather than in the WebView, and that is the whole
         * of the difference. A `visibilitychange` listener would need the
         * WebView to be alive and correct to be believed, and a bug there would
         * leave the app convinced it was being watched; this is the window
         * manager's own account of itself, needs no capability the app does not
         * already have, and cannot be wrong about which window has the operator.
         */
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(has_it) = event {
                if let Some(poker) = window.try_state::<Poker>() {
                    poker.poke(Poke::Attention(if *has_it {
                        Attention::Focused
                    } else {
                        Attention::Unfocused
                    }));
                }
            }
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
            environment
        ])
        .run(tauri::generate_context!())
        .expect("perseverance failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(json.as_object().expect("an object").len(), 6);
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
            .cache_graph(folder_id, Some(99), "a map that has since gone", 10)
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
            .cache_graph(folder_id, None, "<html>a proxy got at it</html>", 100)
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
        Model::of(&read_response(body).expect("reads"))
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
            .cache_graph(folder_id, Some(AWKWARD_MAP), AWKWARD, 100)
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
            .cache_graph(folder_id, Some(AWKWARD_MAP), AWKWARD, 100)
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
                "<html>a proxy got at it</html>",
                100,
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
            .cache_graph(folder_id, Some(AWKWARD_MAP), AWKWARD, 100)
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
            .cache_graph(folder_id, Some(AWKWARD_MAP), AWKWARD_LATER, 100)
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
    /// It is a byte-level check because `crates/pty` is thirty-odd lines of doc
    /// comment and there is no behaviour to exercise yet. That is a real limit
    /// and README says so: this asserts a stub, and #47 is where it has to be
    /// re-asserted against a crate that actually owns a terminal.
    #[test]
    fn nothing_inside_the_terminal_can_raise_a_condition_on_the_graph() {
        const PTY_SOURCE: &str = include_str!("../../pty/src/lib.rs");

        // Every name a child process's failure would have to reach for to put
        // itself on the graph. A harness that narrated a compiler error would
        // be saying, less well, what is already three inches from your eyes.
        for surfaced in ["Degraded", "ReadOutcome", "MapsView", "Provenance", "emit"] {
            assert!(
                !PTY_SOURCE.contains(surfaced),
                "crates/pty names {surfaced}, so a failure inside a terminal can reach the graph"
            );
        }
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
    /// silent breakage there, and nine keys is the count both files assert.
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
        assert_eq!(json.as_object().expect("an object").len(), 9);
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
}
