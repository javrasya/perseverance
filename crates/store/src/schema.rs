use rusqlite::{params, Connection, OptionalExtension};

use crate::StoreError;

/// The schema version this build speaks. Forward-only: a file recording a
/// version this binary does not know is refused rather than guessed at, because
/// the alternative is a silent upgrade or a wipe, and both of those lose data
/// that is not ours to lose.
pub const STORE_SCHEMA_VERSION: u32 = 4;

/// The version lives as a row in `app` rather than in `PRAGMA user_version`
/// because the ticket's schema names it, and because a value you can read with
/// `SELECT` is a value a human can inspect when a build refuses to open.
const SCHEMA_VERSION_KEY: &str = "schema_version";

/// Index `n` takes the database from version `n` to version `n + 1`. Append
/// only — never edit a shipped entry, because a database in the wild has
/// already run it.
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
    // 1 -> 2: the read cache. A copy, never an authority.
    //
    // No `fingerprint` column, although the spec's SQL sketch carries one. The
    // fingerprint existed to decide whether the expensive half of a poll/refetch
    // split was worth running, and #32 killed the split: there is one query
    // shape, always, so there is nothing left for a fingerprint to gate. A
    // column nobody writes is the same unkeepable claim as a table nobody
    // writes.
    //
    // `map_number` is **nullable**, and NULL means *no map was open when this
    // was read*. That is a different fact from any number, and the response
    // still carries the folder's whole map list — which is exactly what the
    // first paint of a folder needs and what a sentinel `0` would have
    // disguised as a map that cannot exist.
    //
    // `ON DELETE CASCADE` is the one deletion that is not a GitHub read's:
    // taking a folder off the list is the operator disposing of their own row,
    // not the cache being invalidated behind their back. Everything else here
    // is deleted only by a successful read.
    "CREATE TABLE graph_cache (
         folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
         map_number INTEGER,
         graph_json TEXT    NOT NULL,
         fetched_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX graph_cache_one_row_per_map
         ON graph_cache (folder_id, IFNULL(map_number, 0));",
    // 2 -> 3: which document produced the body in the row above.
    //
    // This is not the `fingerprint` #32 killed and the entry above explains.
    // That one was a fingerprint *of the response*, and its only job was to
    // gate a poll/refetch split that no longer exists. This is an identity of
    // the *request document*, and it decides whether a stored body may be
    // believed at all: every field of the read model tolerates absence, so a
    // body recorded under a narrower query parses cleanly and quietly answers
    // with less.
    //
    // Nullable because SQLite cannot `ADD COLUMN` a bare `NOT NULL`, and
    // because NULL is already this schema's word for *this fact was not
    // recorded* — as it is for `map_number`. A NULL stamp is a row written
    // before any build stamped anything, and the reader treats it exactly as
    // it treats a stamp from another document: as no cached row at all.
    "ALTER TABLE graph_cache ADD COLUMN query_id TEXT;",
    // 3 -> 4: how much window each map was worth, last time it was open.
    //
    // The fourth table, and the only one an operator's hand writes directly:
    // every row here is a dial they moved. It is `layout_json` rather than a
    // `dial` column because the dial is the first layout fact this app has and
    // will not be the last — a second one joins the envelope instead of
    // arriving as a fifth migration.
    //
    // `nickname` is absent, although the ticket's schema sketch names it.
    // Nothing in this app renames a map, so the column would be written by
    // nobody — the same unkeepable claim as the `fingerprint` the entry above
    // refuses, and the same claim `map_view` itself was refused for until this
    // ticket had something to write in it.
    //
    // `map_number` is `NOT NULL` here, unlike in `graph_cache`, and the
    // difference is not an oversight: a cached read with no map open is the
    // folder's own map list, but *nothing open* is not a place the dial can
    // come back to. There is no row for it because there is nothing to
    // remember.
    //
    // `ON DELETE CASCADE` for `graph_cache`'s reason: a folder the operator
    // takes off their list is them disposing of their own rows, and a
    // remembered dial position outliving the folder it was measured in would be
    // a layout nobody can reach and nobody asked to keep.
    "CREATE TABLE map_view (
         folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
         map_number  INTEGER NOT NULL,
         layout_json TEXT    NOT NULL,
         PRIMARY KEY (folder_id, map_number)
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

    /// Every table this registry has, spelled out — and the point of spelling
    /// them out is the one that is missing.
    ///
    /// Worktrees are derived from `git worktree list` on every call and written
    /// down nowhere: a remembered worktree is a row that goes on offering to
    /// remove a directory somebody has since put an hour of unsaved work into.
    /// The claim is asserted as an exact set rather than as the absence of a
    /// `worktrees` table, because an absence is a check the next migration
    /// passes by naming its table `worktree_state` instead.
    #[test]
    fn the_registry_has_these_tables_and_keeps_no_worktree_among_them() {
        let (_dir, path) = scratch();
        let _store = Store::open(&path).expect("opens");

        let connection = Connection::open(&path).expect("opens");
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("prepares");
        let tables: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("queries")
            .collect::<Result<Vec<_>, _>>()
            .expect("reads");

        assert_eq!(tables, ["app", "folders", "graph_cache", "map_view"]);
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

    /// The first migration this schema has ever had to perform on a file that
    /// already existed. Forward-only means the folders an operator accumulated
    /// under version 1 are still theirs under version 2 — and the read cache
    /// arrives empty rather than arriving instead of them.
    #[test]
    fn a_registry_written_by_the_previous_version_keeps_its_folders_through_the_upgrade() {
        let (_dir, path) = scratch();
        {
            let mut version_one = Connection::open(&path).expect("opens");
            configure(&version_one).expect("configures");
            let tx = version_one.transaction().expect("begins");
            tx.execute_batch(MIGRATIONS[0]).expect("creates version 1");
            tx.execute(
                "INSERT INTO app (key, value) VALUES (?1, '1')",
                [SCHEMA_VERSION_KEY],
            )
            .expect("stamps version 1");
            tx.execute(
                "INSERT INTO folders (path, adapter, last_opened) VALUES ('/work/perseverance', 'claude', 42)",
                [],
            )
            .expect("writes a folder the operator opened under version 1");
            tx.commit().expect("commits");
        }

        let store = Store::open(&path).expect("opens and upgrades");

        assert_eq!(
            store.get_app(SCHEMA_VERSION_KEY).expect("reads"),
            Some(STORE_SCHEMA_VERSION.to_string())
        );
        let folders = store.folders().expect("lists");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, "/work/perseverance");
        assert_eq!(folders[0].adapter, Some("claude".to_string()));
        // The cache exists and is empty, which is *first open* rather than a
        // map list of zero.
        assert_eq!(
            store.cached_graph(folders[0].id, None).expect("reads"),
            None
        );
    }

    /// The same promise one version on: a body cached under version 2 is still
    /// there under version 3, and the stamp that version could not write
    /// arrives empty rather than arriving instead of it.
    #[test]
    fn a_cache_written_by_the_previous_version_keeps_its_body_and_gains_an_empty_stamp() {
        let (_dir, path) = scratch();
        {
            let mut version_two = Connection::open(&path).expect("opens");
            configure(&version_two).expect("configures");
            let tx = version_two.transaction().expect("begins");
            tx.execute_batch(MIGRATIONS[0]).expect("creates version 1");
            tx.execute_batch(MIGRATIONS[1]).expect("creates version 2");
            tx.execute(
                "INSERT INTO app (key, value) VALUES (?1, '2')",
                [SCHEMA_VERSION_KEY],
            )
            .expect("stamps version 2");
            tx.execute(
                "INSERT INTO folders (path, adapter, last_opened) VALUES ('/work/perseverance', 'claude', 42)",
                [],
            )
            .expect("writes a folder the operator opened under version 2");
            tx.execute(
                "INSERT INTO graph_cache (folder_id, map_number, graph_json, fetched_at)
                 VALUES ((SELECT id FROM folders), NULL, '{\"data\":{}}', 1785888000)",
                [],
            )
            .expect("writes a body read under version 2");
            tx.commit().expect("commits");
        }

        let store = Store::open(&path).expect("opens and upgrades");

        assert_eq!(
            store.get_app(SCHEMA_VERSION_KEY).expect("reads"),
            Some(STORE_SCHEMA_VERSION.to_string())
        );
        let folders = store.folders().expect("lists");
        assert_eq!(folders.len(), 1);
        let cached = store
            .cached_graph(folders[0].id, None)
            .expect("reads")
            .expect("survived the upgrade");
        assert_eq!(cached.graph_json, "{\"data\":{}}");
        assert_eq!(cached.fetched_at, 1_785_888_000);
        // Nobody knows which document produced it, which is the same answer as
        // a stamp this build does not recognise: the reader treats it as
        // nothing having been read yet.
        assert_eq!(cached.query_id, None);
    }

    /// The promise a third time, for the table that arrived last. A file an
    /// operator has been using since version 3 gains `map_view` empty — every
    /// map opens at the default detent, which is what *nothing remembered*
    /// looks like — and loses neither its folders nor its cache to get it.
    #[test]
    fn a_registry_written_by_version_three_gains_an_empty_map_view_and_keeps_everything_else() {
        let (_dir, path) = scratch();
        {
            let mut version_three = Connection::open(&path).expect("opens");
            configure(&version_three).expect("configures");
            let tx = version_three.transaction().expect("begins");
            for migration in &MIGRATIONS[..3] {
                tx.execute_batch(migration).expect("creates version 3");
            }
            tx.execute(
                "INSERT INTO app (key, value) VALUES (?1, '3')",
                [SCHEMA_VERSION_KEY],
            )
            .expect("stamps version 3");
            tx.execute(
                "INSERT INTO folders (path, adapter, last_opened) VALUES ('/work/perseverance', 'claude', 42)",
                [],
            )
            .expect("writes a folder the operator opened under version 3");
            tx.execute(
                "INSERT INTO graph_cache (folder_id, map_number, graph_json, fetched_at, query_id)
                 VALUES ((SELECT id FROM folders), 12, '{\"data\":{}}', 1785888000, 'maps/v1')",
                [],
            )
            .expect("writes a body read under version 3");
            tx.commit().expect("commits");
        }

        let store = Store::open(&path).expect("opens and upgrades");

        assert_eq!(
            store.get_app(SCHEMA_VERSION_KEY).expect("reads"),
            Some(STORE_SCHEMA_VERSION.to_string())
        );
        let folders = store.folders().expect("lists");
        assert_eq!(folders.len(), 1);
        assert!(store
            .cached_graph(folders[0].id, Some(12))
            .expect("reads")
            .is_some());
        assert_eq!(store.map_layout(folders[0].id, 12).expect("reads"), None);
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
