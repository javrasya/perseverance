use rusqlite::{params, Connection, OptionalExtension};

use crate::StoreError;

/// The schema version this build speaks. Forward-only: a file recording a
/// version this binary does not know is refused rather than guessed at, because
/// the alternative is a silent upgrade or a wipe, and both of those lose data
/// that is not ours to lose.
pub const STORE_SCHEMA_VERSION: u32 = 1;

/// The version lives as a row in `app` rather than in `PRAGMA user_version`
/// because the ticket's schema names it, and because a value you can read with
/// `SELECT` is a value a human can inspect when a build refuses to open.
const SCHEMA_VERSION_KEY: &str = "schema_version";

/// Index `n` takes the database from version `n` to version `n + 1`. Append
/// only — never edit a shipped entry, because a database in the wild has
/// already run it.
///
/// `map_view` and `graph_cache` are deliberately absent: they belong to later
/// tickets, and a table nobody writes is a claim the schema cannot keep.
const MIGRATIONS: &[&str] = &[
    // 0 -> 1: the folder list, and the app-level key/value bag.
    "CREATE TABLE folders (
         id          INTEGER PRIMARY KEY,
         path        TEXT    UNIQUE NOT NULL,
         adapter     TEXT,
         last_opened INTEGER NOT NULL
     );
     CREATE TABLE app (
         key   TEXT PRIMARY KEY,
         value TEXT
     );",
];

// The two must agree or a fresh file would be stamped with a version whose
// tables were never created.
const _: () = assert!(MIGRATIONS.len() == STORE_SCHEMA_VERSION as usize);

/// Write-ahead logging is set once and persists in the file header; the rest are
/// per-connection and are therefore set on every open. `NORMAL` synchronous is
/// the safe pairing with WAL, and a busy timeout means a second window waits its
/// turn rather than failing outright.
pub(crate) fn configure(conn: &Connection) -> Result<(), StoreError> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

/// The version check, run before the first write to the file.
///
/// It is separate from [`migrate`] because "left exactly as it was found" has to
/// include the file header, and [`configure`] writes to it: `journal_mode` is a
/// property of the database, not of the connection that asked for it. A build
/// that refuses a file it cannot read must not have changed a byte of it on the
/// way to saying so — least of all a byte that decides how the file is written.
pub(crate) fn refuse_unrecognised(conn: &Connection) -> Result<(), StoreError> {
    match recorded_version(conn)? {
        Some(version) if version > STORE_SCHEMA_VERSION => {
            Err(StoreError::UnsupportedSchemaVersion {
                found: version,
                speaks: STORE_SCHEMA_VERSION,
            })
        }
        _ => Ok(()),
    }
}

/// Brings the database up to [`STORE_SCHEMA_VERSION`], or refuses.
///
/// A file whose recorded version is ahead of this build is left exactly as it
/// was found. Refusing costs the user one clear sentence; guessing costs them
/// their layout and their cache.
///
/// The check is made here as well as in [`refuse_unrecognised`] because this is
/// the function that writes, and the guard belongs where the writing is.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    let mut version = recorded_version(conn)?.unwrap_or(0);

    if version > STORE_SCHEMA_VERSION {
        return Err(StoreError::UnsupportedSchemaVersion {
            found: version,
            speaks: STORE_SCHEMA_VERSION,
        });
    }

    while (version as usize) < MIGRATIONS.len() {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATIONS[version as usize])?;
        version += 1;
        tx.execute(
            "INSERT INTO app (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION_KEY, version.to_string()],
        )?;
        tx.commit()?;
    }

    Ok(())
}

/// `None` means the file has no schema at all — a fresh database, which is the
/// only state we are entitled to create tables in.
///
/// An `app` table that exists but records no readable version is refused rather
/// than treated as fresh: creating tables over someone else's file is exactly
/// the guess this schema policy exists to forbid. It is reported as `found: 0`,
/// the version a database with no schema would have.
fn recorded_version(conn: &Connection) -> Result<Option<u32>, StoreError> {
    let has_app_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);

    if !has_app_table {
        return Ok(None);
    }

    let recorded: Option<String> = conn
        .query_row(
            "SELECT value FROM app WHERE key = ?1",
            [SCHEMA_VERSION_KEY],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    let unreadable = || StoreError::UnsupportedSchemaVersion {
        found: 0,
        speaks: STORE_SCHEMA_VERSION,
    };

    let recorded = recorded.ok_or_else(unreadable)?;
    let version = recorded.trim().parse::<u32>().map_err(|_| unreadable())?;

    Ok(Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use tempfile::TempDir;

    fn scratch() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("a temporary directory");
        let path = dir.path().join("perseverance.db");
        (dir, path)
    }

    #[test]
    fn a_fresh_database_opens_at_the_current_schema_version() {
        let (_dir, path) = scratch();

        let store = Store::open(&path).expect("opens");

        assert_eq!(
            store.get_app(SCHEMA_VERSION_KEY).expect("reads"),
            Some(STORE_SCHEMA_VERSION.to_string())
        );
        assert!(store.folders().expect("lists").is_empty());
    }

    #[test]
    fn the_registry_file_is_kept_in_write_ahead_logging_mode() {
        let (_dir, path) = scratch();

        let store = Store::open(&path).expect("opens");
        store
            .remember_folder(std::path::Path::new("/work/perseverance"))
            .expect("remembers");

        // The log is a file beside the registry, which is the visible form of
        // the claim — no need to reach inside the connection to ask.
        assert!(path.with_file_name("perseverance.db-wal").exists());
    }

    #[test]
    fn an_unrecognised_schema_version_is_refused_rather_than_guessed_at() {
        let (_dir, path) = scratch();
        {
            let mut ahead = Connection::open(&path).expect("opens");
            migrate(&mut ahead).expect("migrates");
            ahead
                .execute(
                    "UPDATE app SET value = '99' WHERE key = ?1",
                    [SCHEMA_VERSION_KEY],
                )
                .expect("stamps a future version");
            ahead
                .execute(
                    "INSERT INTO folders (path, adapter, last_opened) VALUES ('/somewhere', NULL, 1)",
                    [],
                )
                .expect("writes a row a newer build owns");
        }

        let refusal = Store::open(&path).expect_err("refuses");

        assert!(matches!(
            refusal,
            StoreError::UnsupportedSchemaVersion { found: 99, speaks } if speaks == STORE_SCHEMA_VERSION
        ));

        let after = Connection::open(&path).expect("reopens");
        let version: String = after
            .query_row(
                "SELECT value FROM app WHERE key = ?1",
                [SCHEMA_VERSION_KEY],
                |row| row.get(0),
            )
            .expect("still recorded");
        let rows: i64 = after
            .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
            .expect("still counted");
        assert_eq!(version, "99");
        assert_eq!(rows, 1);
    }

    #[test]
    fn a_registry_this_build_refuses_is_not_written_to_on_the_way_to_refusing_it() {
        let (_dir, path) = scratch();
        {
            let mut ahead = Connection::open(&path).expect("opens");
            migrate(&mut ahead).expect("migrates");
            ahead
                .execute(
                    "UPDATE app SET value = '99' WHERE key = ?1",
                    [SCHEMA_VERSION_KEY],
                )
                .expect("stamps a future version");
        }
        let before = std::fs::read(&path).expect("reads the file as it was found");

        Store::open(&path).expect_err("refuses");

        assert_eq!(
            std::fs::read(&path).expect("reads it again"),
            before,
            "a refused registry is left byte for byte as it was found"
        );
        assert!(
            !path.with_file_name("perseverance.db-wal").exists(),
            "a refused registry gains no write-ahead log either"
        );
    }

    #[test]
    fn an_app_table_with_no_readable_version_is_refused_rather_than_treated_as_fresh() {
        let (_dir, path) = scratch();
        {
            let foreign = Connection::open(&path).expect("opens");
            foreign
                .execute_batch("CREATE TABLE app (key TEXT PRIMARY KEY, value TEXT);")
                .expect("creates a table we did not write");
        }

        let refusal = Store::open(&path).expect_err("refuses");

        assert!(matches!(
            refusal,
            StoreError::UnsupportedSchemaVersion { .. }
        ));
    }

    #[test]
    fn the_refusal_says_which_version_it_found_and_which_it_speaks() {
        let message = StoreError::UnsupportedSchemaVersion {
            found: 99,
            speaks: STORE_SCHEMA_VERSION,
        }
        .to_string();

        assert!(message.contains("99"));
        assert!(message.contains(&STORE_SCHEMA_VERSION.to_string()));
    }

    #[test]
    fn a_database_reopened_finds_the_folders_it_left_behind() {
        let (_dir, path) = scratch();
        let remembered = {
            let store = Store::open(&path).expect("opens");
            store
                .remember_folder(std::path::Path::new("/work/perseverance"))
                .expect("remembers")
        };

        let store = Store::open(&path).expect("reopens");

        let folders = store.folders().expect("lists");
        assert_eq!(folders, vec![remembered]);
    }
}
