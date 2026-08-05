use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::schema;

/// The one global registry. Not one database per folder: the list of folders is
/// itself the thing being remembered, so it cannot live inside any one of them.
pub struct Store {
    /// Visible to the crate because the folder registry is a sibling module of
    /// this one, not because anything outside is entitled to raw SQL.
    pub(crate) conn: Connection,
}

/// A registry has nothing worth printing: the file path is the caller's, and
/// the rows are read with the API rather than peered at. This exists so a
/// refusal can be asserted on without leaking either.
impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

/// Every way the registry can refuse.
///
/// None of these is a network condition — this crate cannot reach a network —
/// so a caller rendering one of them must not dress it as one.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The file was written by a build that speaks a schema this one does not.
    /// It is refused, not upgraded and not wiped, and the file is left as found.
    #[error(
        "this launcher registry records schema version {found}; this build speaks version {speaks} \
         and will not guess at the difference"
    )]
    UnsupportedSchemaVersion { found: u32, speaks: u32 },
    #[error("no folder with id {0} is on the list")]
    UnknownFolder(i64),
    #[error("{0} is already on the list")]
    PathAlreadyListed(String),
    #[error("the launcher registry could not be read or written: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("the launcher registry file could not be created: {0}")]
    Io(#[from] std::io::Error),
}

impl Store {
    /// Opens — or creates — the registry at `db_path`.
    ///
    /// The caller chooses the path so that this crate needs no notion of an
    /// application-data directory, and so that a test can point it at a
    /// temporary file without ceremony. In the shipped app it is
    /// `app_data_dir()/perseverance.db`.
    pub fn open(db_path: &Path) -> Result<Store, StoreError> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let mut conn = Connection::open(db_path)?;
        // The version is read before anything is written, and `configure` is a
        // write: `journal_mode` lives in the file header rather than in this
        // connection. A file this build is about to refuse must not be touched
        // on the way to refusing it.
        schema::refuse_unrecognised(&conn)?;
        schema::configure(&conn)?;
        schema::migrate(&mut conn)?;

        Ok(Store { conn })
    }

    /// A registry that vanishes with the process. For tests only — note that
    /// SQLite has no write-ahead log for an in-memory database, which is why
    /// the WAL claim is asserted against a file-backed one.
    pub fn open_in_memory() -> Result<Store, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        schema::configure(&conn)?;
        schema::migrate(&mut conn)?;

        Ok(Store { conn })
    }

    /// Reads an app-level preference. `None` is *never written*, which is a
    /// different thing from written-and-empty, and callers get to tell them
    /// apart.
    pub fn get_app(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM app WHERE key = ?1", [key], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten())
    }

    /// Writes an app-level preference — the default adapter, window prefs, and
    /// nothing that is a secret. The schema version is written here too, by the
    /// migration; callers have no business overwriting it.
    pub fn set_app(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO app (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_key_that_was_never_written_reads_as_an_absence() {
        let store = Store::open_in_memory().expect("opens");

        assert_eq!(store.get_app("default_adapter").expect("reads"), None);
    }

    #[test]
    fn an_app_preference_that_was_written_reads_back_and_can_be_replaced() {
        let store = Store::open_in_memory().expect("opens");

        store.set_app("default_adapter", "claude").expect("writes");
        store.set_app("default_adapter", "codex").expect("rewrites");

        assert_eq!(
            store.get_app("default_adapter").expect("reads"),
            Some("codex".to_string())
        );
    }

    /// Every variant, including the two that wrap someone else's words. The
    /// interpolated half of those two is the operating system's and cannot be
    /// vetted here — a Windows I/O error on a mapped drive says what it says —
    /// but the sentence around it is ours, and that half is held to the rule.
    #[test]
    fn no_store_refusal_reads_like_a_network_failure() {
        let refusals = [
            StoreError::UnsupportedSchemaVersion {
                found: 99,
                speaks: 1,
            }
            .to_string(),
            StoreError::UnknownFolder(7).to_string(),
            StoreError::PathAlreadyListed("/work/perseverance".to_string()).to_string(),
            StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows).to_string(),
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied",
            ))
            .to_string(),
        ];

        for refusal in refusals {
            let lowered = refusal.to_lowercase();
            for word in crate::repo::NETWORK_VOCABULARY {
                assert!(
                    !lowered.contains(word),
                    "{refusal:?} reads like a network failure because of {word:?}"
                );
            }
        }
    }
}
