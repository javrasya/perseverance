use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// One entry on the launcher list.
///
/// The folder — not the map — is the top-level thing you pick, so a repository
/// hosting several maps is one row here rather than several.
///
/// What this row does *not* hold is as deliberate as what it does: no
/// `owner/repo` (derived from the git remote on every read, so a rename on
/// GitHub cannot rot it) and no presence flag (checked against the disk on every
/// read, so an unmounted drive cannot silently delete your list).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub adapter: Option<String>,
    /// Seconds since the Unix epoch. See [`Store::remember_folder`] for why this
    /// can run a second or two ahead of the wall clock.
    pub last_opened: i64,
}

impl Folder {
    /// The name to put on the list. A path is what identifies a folder; a
    /// basename is what a human recognises, and computing it here means the
    /// shell does not have to know how paths are spelled on each platform.
    pub fn display_name(&self) -> String {
        let path = Path::new(&self.path);
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.clone())
    }

    /// Whether the path is still a directory on this machine, asked now.
    ///
    /// Never persisted. A folder on an unplugged drive stays on the list and is
    /// shown greyed with a *missing* badge; it is removed when you say so and
    /// not before, and *Locate…* re-points it while keeping its id.
    pub fn is_present(&self) -> bool {
        Path::new(&self.path).is_dir()
    }
}

impl Store {
    /// The list, most recently opened first.
    ///
    /// Nothing is filtered out. A folder whose path has gone missing is still a
    /// folder you opened, and the caller decides how to draw it.
    pub fn folders(&self) -> Result<Vec<Folder>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT id, path, adapter, last_opened
             FROM folders
             ORDER BY last_opened DESC, id DESC",
        )?;
        let rows = statement.query_map([], row_to_folder)?;

        let mut folders = Vec::new();
        for folder in rows {
            folders.push(folder?);
        }
        Ok(folders)
    }

    /// Records a folder as opened, or moves one already listed to the front.
    ///
    /// The id is stable across reopening, which is the whole point: the layout
    /// and the caches that later tickets key on `folder_id` stay attached to the
    /// folder you keep coming back to.
    ///
    /// The stamp is wall-clock seconds, except that it is nudged past the
    /// newest row when two folders are opened inside the same second. A list
    /// whose order flickers is worse than a timestamp that is a second
    /// optimistic, and second granularity is what the schema and the IPC
    /// contract both name.
    pub fn remember_folder(&self, path: &Path) -> Result<Folder, StoreError> {
        let path = path_text(path);
        let stamp = self.next_stamp()?;

        self.conn.execute(
            "INSERT INTO folders (path, adapter, last_opened) VALUES (?1, NULL, ?2)
             ON CONFLICT(path) DO UPDATE SET last_opened = excluded.last_opened",
            params![&path, stamp],
        )?;

        self.folder_by_path(&path)
    }

    /// Takes a folder off the list, and nothing else.
    ///
    /// Removal is explicit because the list is yours to curate. Nothing in this
    /// crate ever removes a row on your behalf.
    pub fn forget_folder(&self, id: i64) -> Result<(), StoreError> {
        let removed = self
            .conn
            .execute("DELETE FROM folders WHERE id = ?1", [id])?;

        if removed == 0 {
            return Err(StoreError::UnknownFolder(id));
        }
        Ok(())
    }

    /// Points an existing entry at a new path, **keeping its id**.
    ///
    /// That is the entire mechanism behind "moving a repo is not a data loss":
    /// every row a later ticket keys on `folder_id` — map layout, graph cache —
    /// keeps pointing at the same folder, because the identity was never the
    /// path.
    pub fn relocate_folder(&self, id: i64, new_path: &Path) -> Result<Folder, StoreError> {
        let path = path_text(new_path);

        let holder: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM folders WHERE path = ?1",
                [path.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(holder) = holder {
            if holder != id {
                return Err(StoreError::PathAlreadyListed(path));
            }
        }

        let changed = self.conn.execute(
            "UPDATE folders SET path = ?1 WHERE id = ?2",
            params![&path, id],
        )?;
        if changed == 0 {
            return Err(StoreError::UnknownFolder(id));
        }

        self.folder_by_id(id)
    }

    fn folder_by_id(&self, id: i64) -> Result<Folder, StoreError> {
        self.conn
            .query_row(
                "SELECT id, path, adapter, last_opened FROM folders WHERE id = ?1",
                [id],
                row_to_folder,
            )
            .optional()?
            .ok_or(StoreError::UnknownFolder(id))
    }

    fn folder_by_path(&self, path: &str) -> Result<Folder, StoreError> {
        Ok(self.conn.query_row(
            "SELECT id, path, adapter, last_opened FROM folders WHERE path = ?1",
            [path],
            row_to_folder,
        )?)
    }

    fn next_stamp(&self) -> Result<i64, StoreError> {
        let newest: i64 = self.conn.query_row(
            "SELECT IFNULL(MAX(last_opened), 0) FROM folders",
            [],
            |row| row.get(0),
        )?;
        Ok(epoch_seconds().max(newest + 1))
    }
}

fn row_to_folder(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        path: row.get(1)?,
        adapter: row.get(2)?,
        last_opened: row.get(3)?,
    })
}

/// The registry stores a path as text because the contract that crosses to the
/// WebView is text. A path that is not valid UTF-8 is stored lossily rather than
/// refused: a folder you can see on the list and re-point is worth more than an
/// exact byte sequence you cannot.
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Saturates at 0 for a clock set before 1970 rather than panicking. A launcher
/// row with a nonsense timestamp is not worth a crash.
fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reopening_a_folder_keeps_its_id_and_moves_it_to_the_front_of_the_list() {
        let store = Store::open_in_memory().expect("opens");
        let first = store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers");
        store
            .remember_folder(Path::new("/work/beta"))
            .expect("remembers");

        let reopened = store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers again");

        assert_eq!(reopened.id, first.id);
        let listed: Vec<String> = store
            .folders()
            .expect("lists")
            .into_iter()
            .map(|folder| folder.path)
            .collect();
        assert_eq!(listed, vec!["/work/alpha", "/work/beta"]);
    }

    #[test]
    fn reopening_a_folder_adds_no_second_entry_for_the_same_path() {
        let store = Store::open_in_memory().expect("opens");

        store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers");
        store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers again");

        assert_eq!(store.folders().expect("lists").len(), 1);
    }

    #[test]
    fn re_pointing_a_folder_preserves_its_id_so_rows_keyed_on_it_survive_a_move() {
        let store = Store::open_in_memory().expect("opens");
        let folder = store
            .remember_folder(Path::new("/volumes/backup/perseverance"))
            .expect("remembers");
        // Stands in for the map_view and graph_cache tables later tickets add:
        // whatever they are, they hang off folder_id.
        store
            .conn
            .execute_batch("CREATE TABLE scratch_layout (folder_id INTEGER NOT NULL, note TEXT);")
            .expect("creates a table keyed on folder_id");
        store
            .conn
            .execute(
                "INSERT INTO scratch_layout (folder_id, note) VALUES (?1, 'a hand-placed node')",
                [folder.id],
            )
            .expect("writes a dependent row");

        let moved = store
            .relocate_folder(folder.id, Path::new("/work/perseverance"))
            .expect("re-points");

        assert_eq!(moved.id, folder.id);
        assert_eq!(moved.path, "/work/perseverance");
        let surviving: String = store
            .conn
            .query_row(
                "SELECT note FROM scratch_layout WHERE folder_id = ?1",
                [folder.id],
                |row| row.get(0),
            )
            .expect("the dependent row is still attached");
        assert_eq!(surviving, "a hand-placed node");
    }

    #[test]
    fn re_pointing_a_folder_keeps_the_adapter_it_was_configured_with() {
        let store = Store::open_in_memory().expect("opens");
        let folder = store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers");
        store
            .conn
            .execute(
                "UPDATE folders SET adapter = 'claude' WHERE id = ?1",
                [folder.id],
            )
            .expect("configures an adapter");

        let moved = store
            .relocate_folder(folder.id, Path::new("/work/alpha-moved"))
            .expect("re-points");

        assert_eq!(moved.adapter, Some("claude".to_string()));
    }

    #[test]
    fn re_pointing_a_folder_at_a_path_another_entry_already_holds_is_refused() {
        let store = Store::open_in_memory().expect("opens");
        let alpha = store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers");
        store
            .remember_folder(Path::new("/work/beta"))
            .expect("remembers");

        let refusal = store
            .relocate_folder(alpha.id, Path::new("/work/beta"))
            .expect_err("refuses");

        assert!(matches!(refusal, StoreError::PathAlreadyListed(path) if path == "/work/beta"));
        assert_eq!(store.folders().expect("lists").len(), 2);
    }

    #[test]
    fn re_pointing_a_folder_that_is_not_listed_says_so_rather_than_inventing_one() {
        let store = Store::open_in_memory().expect("opens");

        let refusal = store
            .relocate_folder(404, Path::new("/work/alpha"))
            .expect_err("refuses");

        assert!(matches!(refusal, StoreError::UnknownFolder(404)));
        assert!(store.folders().expect("lists").is_empty());
    }

    #[test]
    fn an_explicit_remove_forgets_that_folder_and_nothing_else() {
        let store = Store::open_in_memory().expect("opens");
        let alpha = store
            .remember_folder(Path::new("/work/alpha"))
            .expect("remembers");
        let beta = store
            .remember_folder(Path::new("/work/beta"))
            .expect("remembers");

        store.forget_folder(alpha.id).expect("forgets");

        assert_eq!(store.folders().expect("lists"), vec![beta]);
    }

    #[test]
    fn forgetting_a_folder_that_is_not_listed_says_so_rather_than_succeeding_quietly() {
        let store = Store::open_in_memory().expect("opens");

        let refusal = store.forget_folder(404).expect_err("refuses");

        assert!(matches!(refusal, StoreError::UnknownFolder(404)));
    }

    #[test]
    fn a_folder_whose_path_has_gone_missing_is_still_listed_and_never_auto_pruned() {
        let vanished = TempDir::new().expect("a temporary directory");
        let vanished_path = vanished.path().to_path_buf();
        let store = Store::open_in_memory().expect("opens");
        let folder = store.remember_folder(&vanished_path).expect("remembers");
        assert!(folder.is_present());

        vanished.close().expect("unplugs the drive, so to speak");

        let listed = store.folders().expect("lists");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, folder.id);
        assert!(!listed[0].is_present());
    }

    #[test]
    fn a_missing_folder_can_be_re_pointed_and_becomes_present_again() {
        let moved_to = TempDir::new().expect("a temporary directory");
        let store = Store::open_in_memory().expect("opens");
        let folder = store
            .remember_folder(Path::new("/volumes/backup/perseverance"))
            .expect("remembers");
        assert!(!folder.is_present());

        let relocated = store
            .relocate_folder(folder.id, moved_to.path())
            .expect("re-points");

        assert_eq!(relocated.id, folder.id);
        assert!(relocated.is_present());
    }

    #[test]
    fn a_folder_shows_its_basename_rather_than_the_whole_path() {
        let store = Store::open_in_memory().expect("opens");

        let folder = store
            .remember_folder(Path::new("/work/nested/perseverance"))
            .expect("remembers");

        assert_eq!(folder.display_name(), "perseverance");
    }
}
