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
use perseverance_github::{acquire_token, read_maps, FreshRead, ReadFailure, TokenOutcome};
use perseverance_model::{read_response, MapRead, Provenance, ReadOutcome, Snapshot, Source};
use perseverance_store::{Folder, RepoBindingError, Store, StoreError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The whole model for one tick, in one call.
///
/// The WebView receives a [`Snapshot`] and nothing else — that is the primary
/// seam, and it is a structural fact rather than a convention because there is
/// no other command that hands the frontend map state.
#[tauri::command]
fn snapshot() -> Snapshot {
    // No map is open yet, and no read has been attempted. Later tickets replace
    // this constant with the poller's latest derivation.
    Snapshot::no_map_open()
}

/* ---------------------------------------------------------------- maps --- */

/// One row of the map list.
///
/// Discovered by label rather than registered, which is why nothing here has an
/// id of ours: a map is an issue on GitHub, and the number is its whole
/// identity. Nothing is derived — no phase, no counts, no frontier — because
/// derivation is #33's and a number invented here would be a number the graph
/// could disagree with.
#[derive(Debug, Serialize)]
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

/// `rateLimit`, carried to the WebView and acted on by nobody yet.
///
/// It rides the query for free and #39 is the ticket that spends it. Putting it
/// on screen now would be inventing that ticket's UI; dropping it would mean
/// #39 arrives to find the field it needs is not being read.
#[derive(Debug, Serialize)]
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
#[derive(Debug, Serialize)]
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
        }
    }

    /// What is on screen when a read did not happen, or did not survive.
    ///
    /// The cached list stays; only the stamp changes. A failed poll that emptied
    /// the screen would be the harness asserting that the operator's maps are
    /// gone on the strength of not having been able to look.
    fn stale(mut self, why: String) -> MapsView {
        self.provenance.outcome = ReadOutcome::Failed(why);
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
        Err(unreadable) => MapsView {
            provenance: Provenance {
                source: Source::Cache,
                outcome: ReadOutcome::Failed(unreadable.to_string()),
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
fn remember_read(store: &Store, folder_id: i64, fresh: &FreshRead) -> Result<(), StoreError> {
    store.cache_graph(folder_id, None, fresh.body(), fresh.fetched_at())?;

    let still_listed: Vec<u64> = fresh.read().maps.iter().map(|map| map.number).collect();
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

/// One live read, and the cache write it entitles.
///
/// `(async)` is load-bearing for the same reason the picker's is: this blocks on
/// a socket, and blocking the main thread would stop the window drawing while
/// it waited.
///
/// A failure returns the cached list with a stale stamp rather than a rejected
/// call. Nothing here classifies *why* — `Unreachable` versus `AuthFailed`
/// versus `MapGone`, and which of them retries, is #40's whole ticket — so the
/// condition crosses in the words of whichever crate established it.
#[tauri::command(async)]
fn refresh_maps(
    registry: State<'_, Registry>,
    ambient: State<'_, Ambient>,
    folder_id: i64,
) -> Result<MapsView, String> {
    let store = registry.store()?;
    let held = from_cache(&store, folder_id);

    let folder = match store.folders() {
        Ok(folders) => folders.into_iter().find(|folder| folder.id == folder_id),
        Err(refusal) => return Ok(held.stale(refusal.to_string())),
    };
    let Some(folder) = folder else {
        return Ok(held.stale(StoreError::UnknownFolder(folder_id).to_string()));
    };

    // A fact about a folder on this disk, established without a network — and
    // the store's own sentence for it, so a folder with no GitHub remote never
    // reads as a failure to reach GitHub.
    let repo = match perseverance_store::bind_repo(Path::new(&folder.path)) {
        Ok(repo) => repo,
        Err(refusal) => return Ok(held.stale(refusal.to_string())),
    };

    let token = match ambient.token.get() {
        Some(TokenOutcome::Acquired(token)) => token,
        // Never signed in, or the harvest was discarded so `gh` was never
        // looked for. Both leave a working app with no poller, which is a
        // sentence rather than a stack.
        _ => return Ok(held.stale(ReadFailure::NoToken.to_string())),
    };

    match read_maps(token, &repo.owner, &repo.name, None) {
        Ok(fresh) => {
            let view = MapsView::of(folder_id, fresh.read(), Source::Github, fresh.fetched_at());
            // A cache the registry declined to write is not a read that did not
            // happen: the answer is on screen either way, and the store's
            // refusal is what the stamp then carries.
            match remember_read(&store, folder_id, &fresh) {
                Ok(()) => Ok(view),
                Err(refusal) => Ok(view.stale(refusal.to_string())),
            }
        }
        Err(failure) => Ok(held.stale(failure.to_string())),
    }
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
            start_harvesting(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            maps,
            refresh_maps,
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

        let first = &json["maps"][0];
        assert_eq!(first["number"], 28);
        assert_eq!(first["title"], "Spec: perseverance");
        assert_eq!(first["closed"], false);
        assert_eq!(first["url"], "https://github.com/o/r/issues/28");
        assert_eq!(first["updatedAt"], "2026-08-05T09:12:44Z");
        assert_eq!(first.as_object().expect("an object").len(), 5);
        // The finished map is in the list rather than filtered out of it.
        assert_eq!(json["maps"][1]["closed"], true);
        assert_eq!(json.as_object().expect("an object").len(), 5);
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

        remember_read(&store, folder_id, &a_fresh_read(TWO_MAPS, 1_785_888_000)).expect("caches");

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
        remember_read(&store, folder_id, &a_fresh_read(TWO_MAPS, 100)).expect("caches");
        let before = store.cached_graph(folder_id, None).expect("reads");

        let failed = perseverance_github::interpret_read(
            Ok(perseverance_github::Answer {
                status: 401,
                body: "{\"message\":\"Bad credentials\"}".to_string(),
            }),
            200,
        );
        assert!(failed.is_err());
        let held = from_cache(&store, folder_id).stale("Bad credentials".to_string());

        assert_eq!(store.cached_graph(folder_id, None).expect("reads"), before);
        // What was read last time is still on screen; only the stamp moved.
        let json = serde_json::to_value(held).expect("serialises");
        assert_eq!(json["provenance"]["source"], "cache");
        assert_eq!(json["provenance"]["outcome"]["kind"], "failed");
        assert_eq!(json["provenance"]["fetchedAt"], "1970-01-01T00:01:40Z");
        assert_eq!(json["maps"][0]["number"], 28);
    }

    #[test]
    fn a_map_the_last_successful_read_no_longer_lists_is_dropped_by_that_read() {
        let (store, folder_id) = registry_with_a_folder();
        // A map that was cached under its own number by an earlier read.
        store
            .cache_graph(folder_id, Some(99), "a map that has since gone", 10)
            .expect("caches");

        remember_read(&store, folder_id, &a_fresh_read(TWO_MAPS, 100)).expect("caches");

        assert_eq!(
            store.cached_graph(folder_id, Some(99)).expect("reads"),
            None
        );
    }

    #[test]
    fn a_cached_body_that_cannot_be_read_is_reported_rather_than_deleted() {
        let (store, folder_id) = registry_with_a_folder();
        remember_read(&store, folder_id, &a_fresh_read(TWO_MAPS, 100)).expect("caches");
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

        remember_read(&store, folder_id, &a_fresh_read(TWO_MAPS, 100)).expect("caches");

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
