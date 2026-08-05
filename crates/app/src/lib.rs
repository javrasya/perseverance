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
use std::sync::{Mutex, MutexGuard};

use perseverance_model::Snapshot;
use perseverance_store::{Folder, RepoBindingError, Store};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Registry::open(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            launcher,
            remember_folder,
            forget_folder,
            relocate_folder,
            bind_repo,
            choose_folder
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
}
