//! The read cache: a copy of what GitHub last said, and never an authority.
//!
//! Three rules govern every function here, and each one is a method's whole
//! shape rather than a comment above it:
//!
//! - **Written on read-from-GitHub only.** Nothing in this module composes a
//!   graph; it stores text it was handed. The proof that the text came from a
//!   live read is held one layer up, where the value that carries it has no
//!   constructor a caller can reach.
//! - **Never the basis of a mutation.** This crate cannot mutate anything on
//!   GitHub — it cannot open a socket — so the rule is structural here and only
//!   needs restating where the writer lives.
//! - **Age always rendered.** `fetched_at` is not nullable and travels with
//!   every read, so there is no way to hand a caller a cached graph without
//!   also handing them how old it is.
//!
//! And one deletion principle: **only a successful GitHub read may delete
//! anything**. [`Store::forget_cached_maps_except`] is the only deletion in
//! this module, and its name says what it needs to be told before it will run.

use rusqlite::{params, OptionalExtension};

use crate::{Store, StoreError};

/// One cached read, and how old it is.
///
/// The two are one value because they are one fact. Handing back a graph and
/// leaving its age to a second call is how a fresh-looking screen ends up
/// painted from a week-old copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedGraph {
    /// The GraphQL response, verbatim, as GitHub sent it.
    pub graph_json: String,
    /// Seconds since the Unix epoch, taken when the answer arrived.
    pub fetched_at: i64,
    /// The identity of the query document that produced `graph_json`.
    ///
    /// `None` means the row was written before this column existed, which the
    /// reader treats the same way it treats a stamp it does not recognise: as
    /// nothing having been read here yet. This crate does not know what the
    /// current document is — it cannot open a socket — so it stores the stamp
    /// and compares nothing.
    pub query_id: Option<String>,
}

impl Store {
    /// The cached read for a folder — of the map that was open, or of the
    /// folder itself when none was.
    ///
    /// `None` means *nothing has been read here yet*, which is a first open and
    /// never an empty map list. The two are told apart by the caller having to
    /// pattern-match rather than by reading a length.
    pub fn cached_graph(
        &self,
        folder_id: i64,
        map_number: Option<u64>,
    ) -> Result<Option<CachedGraph>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT graph_json, fetched_at, query_id
                 FROM graph_cache
                 WHERE folder_id = ?1 AND IFNULL(map_number, 0) = ?2",
                params![folder_id, key_of(map_number)],
                |row| {
                    Ok(CachedGraph {
                        graph_json: row.get(0)?,
                        fetched_at: row.get(1)?,
                        query_id: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Replaces the cached read for one folder-and-map.
    ///
    /// One row per map, replaced rather than appended: this is a cache and not
    /// a history. The archive of what a map used to be is GitHub's, and keeping
    /// a second less accurate one here is the thing the ledger ticket already
    /// refused.
    ///
    /// Nothing in this signature can tell whether the text came from GitHub —
    /// which is why the caller that has that proof is the only one that may
    /// call it, and why the proof is a type rather than a promise. `query_id`
    /// travels for the same reason: it is the identity of the document that
    /// asked, and it comes off the same value that proves the answer was live.
    ///
    /// It is named in the `DO UPDATE SET` clause deliberately. A column left
    /// out of that clause keeps its old value on every write after the first,
    /// so a body from a widened document would go on wearing the stamp of the
    /// narrow one — which is precisely the bug the column exists to close.
    pub fn cache_graph(
        &self,
        folder_id: i64,
        map_number: Option<u64>,
        graph_json: &str,
        fetched_at: i64,
        query_id: &str,
    ) -> Result<(), StoreError> {
        let listed: bool = self
            .conn
            .query_row("SELECT 1 FROM folders WHERE id = ?1", [folder_id], |_| {
                Ok(true)
            })
            .optional()?
            .unwrap_or(false);
        if !listed {
            return Err(StoreError::UnknownFolder(folder_id));
        }

        self.conn.execute(
            "INSERT INTO graph_cache (folder_id, map_number, graph_json, fetched_at, query_id)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (folder_id, IFNULL(map_number, 0)) DO UPDATE SET
                 graph_json = excluded.graph_json,
                 fetched_at = excluded.fetched_at,
                 query_id = excluded.query_id",
            params![
                folder_id,
                map_number.map(|number| number as i64),
                graph_json,
                fetched_at,
                query_id
            ],
        )?;

        Ok(())
    }

    /// Drops cached reads for maps a **successful** read no longer lists.
    ///
    /// The only deletion in this module, and it takes the live list as its
    /// argument because that list is the evidence: a caller with nothing to
    /// pass has nothing that entitles it to delete. A failed poll cannot
    /// produce one, so a weekend offline cannot cost an operator their cache.
    ///
    /// The folder's own row — the one read with no map open — is never dropped
    /// here. It is the folder's map list, and a map list that is now empty is
    /// still the answer.
    ///
    /// Returns how many rows went, so a caller can say so rather than guess.
    pub fn forget_cached_maps_except(
        &self,
        folder_id: i64,
        still_listed: &[u64],
    ) -> Result<usize, StoreError> {
        let kept: Vec<i64> = still_listed
            .iter()
            .map(|number| *number as i64)
            .chain(std::iter::once(0))
            .collect();
        let placeholders = kept.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

        let sql = format!(
            "DELETE FROM graph_cache
             WHERE folder_id = ?1 AND IFNULL(map_number, 0) NOT IN ({placeholders})"
        );

        let mut arguments: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(folder_id)];
        for number in kept {
            arguments.push(Box::new(number));
        }
        let borrowed: Vec<&dyn rusqlite::ToSql> =
            arguments.iter().map(|value| value.as_ref()).collect();

        Ok(self.conn.execute(&sql, borrowed.as_slice())?)
    }
}

/// NULL and `0` share one slot in the unique index, and this is the one place
/// that translation is spelled. `0` is not an issue number GitHub can produce,
/// so no map can collide with the folder's own row.
fn key_of(map_number: Option<u64>) -> i64 {
    map_number.map(|number| number as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn store_with_folder() -> (Store, i64) {
        let store = Store::open_in_memory().expect("opens");
        let folder = store
            .remember_folder(Path::new("/work/perseverance"))
            .expect("remembers");
        (store, folder.id)
    }

    #[test]
    fn a_folder_nothing_has_been_read_for_reads_as_an_absence_and_not_as_an_empty_map_list() {
        let (store, folder_id) = store_with_folder();

        assert_eq!(store.cached_graph(folder_id, None).expect("reads"), None);
    }

    #[test]
    fn a_cached_read_comes_back_with_the_age_it_was_written_with() {
        let (store, folder_id) = store_with_folder();

        store
            .cache_graph(folder_id, None, r#"{"data":{}}"#, 1_785_888_000, "abc123")
            .expect("caches");

        assert_eq!(
            store.cached_graph(folder_id, None).expect("reads"),
            Some(CachedGraph {
                graph_json: r#"{"data":{}}"#.to_string(),
                fetched_at: 1_785_888_000,
                query_id: Some("abc123".to_string()),
            })
        );
    }

    #[test]
    fn a_second_read_of_the_same_map_replaces_the_first_rather_than_accumulating() {
        let (store, folder_id) = store_with_folder();

        store
            .cache_graph(folder_id, Some(28), "first", 100, "abc123")
            .expect("caches");
        store
            .cache_graph(folder_id, Some(28), "second", 200, "abc123")
            .expect("caches again");

        assert_eq!(
            store.cached_graph(folder_id, Some(28)).expect("reads"),
            Some(CachedGraph {
                graph_json: "second".to_string(),
                fetched_at: 200,
                query_id: Some("abc123".to_string()),
            })
        );
        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM graph_cache", [], |row| row.get(0))
            .expect("counts");
        assert_eq!(rows, 1);
    }

    #[test]
    fn the_folders_own_read_and_a_maps_read_are_two_rows_rather_than_one() {
        let (store, folder_id) = store_with_folder();

        store
            .cache_graph(folder_id, None, "the folder's map list", 100, "abc123")
            .expect("caches");
        store
            .cache_graph(folder_id, Some(28), "map 28's graph", 200, "abc123")
            .expect("caches");

        // No map open is not map zero, and a read taken with none open must not
        // be overwritten by the first map the operator happens to open.
        assert_eq!(
            store
                .cached_graph(folder_id, None)
                .expect("reads")
                .expect("is there")
                .graph_json,
            "the folder's map list"
        );
        assert_eq!(
            store
                .cached_graph(folder_id, Some(28))
                .expect("reads")
                .expect("is there")
                .graph_json,
            "map 28's graph"
        );
    }

    #[test]
    fn two_folders_reading_the_same_map_number_do_not_share_a_row() {
        let (store, first) = store_with_folder();
        let second = store
            .remember_folder(Path::new("/work/elsewhere"))
            .expect("remembers")
            .id;

        store
            .cache_graph(first, Some(1), "one", 10, "abc123")
            .expect("caches");
        store
            .cache_graph(second, Some(1), "another", 20, "abc123")
            .expect("caches");

        assert_eq!(
            store
                .cached_graph(first, Some(1))
                .expect("reads")
                .expect("is there")
                .graph_json,
            "one"
        );
    }

    #[test]
    fn a_map_a_successful_read_no_longer_lists_is_dropped_and_the_rest_are_kept() {
        let (store, folder_id) = store_with_folder();
        store
            .cache_graph(folder_id, None, "the map list", 10, "abc123")
            .expect("caches");
        store
            .cache_graph(folder_id, Some(1), "one", 10, "abc123")
            .expect("caches");
        store
            .cache_graph(folder_id, Some(2), "two", 10, "abc123")
            .expect("caches");

        let dropped = store
            .forget_cached_maps_except(folder_id, &[2])
            .expect("prunes");

        assert_eq!(dropped, 1);
        assert_eq!(store.cached_graph(folder_id, Some(1)).expect("reads"), None);
        assert!(store
            .cached_graph(folder_id, Some(2))
            .expect("reads")
            .is_some());
        // The folder's own read is its map list, and a map list is not a map.
        assert!(store
            .cached_graph(folder_id, None)
            .expect("reads")
            .is_some());
    }

    #[test]
    fn a_repository_whose_last_map_was_deleted_still_keeps_its_map_list_row() {
        let (store, folder_id) = store_with_folder();
        store
            .cache_graph(folder_id, None, "the map list", 10, "abc123")
            .expect("caches");
        store
            .cache_graph(folder_id, Some(1), "one", 10, "abc123")
            .expect("caches");

        let dropped = store
            .forget_cached_maps_except(folder_id, &[])
            .expect("prunes");

        assert_eq!(dropped, 1);
        assert!(store
            .cached_graph(folder_id, None)
            .expect("reads")
            .is_some());
    }

    #[test]
    fn pruning_one_folder_leaves_every_other_folders_cache_where_it_was() {
        let (store, first) = store_with_folder();
        let second = store
            .remember_folder(Path::new("/work/elsewhere"))
            .expect("remembers")
            .id;
        store
            .cache_graph(first, Some(1), "one", 10, "abc123")
            .expect("caches");
        store
            .cache_graph(second, Some(1), "one", 10, "abc123")
            .expect("caches");

        store.forget_cached_maps_except(first, &[]).expect("prunes");

        assert!(store
            .cached_graph(second, Some(1))
            .expect("reads")
            .is_some());
    }

    #[test]
    fn caching_against_a_folder_that_is_not_on_the_list_is_refused_rather_than_orphaned() {
        let store = Store::open_in_memory().expect("opens");

        let refusal = store
            .cache_graph(404, Some(1), "one", 10, "abc123")
            .expect_err("refuses");

        assert!(matches!(refusal, StoreError::UnknownFolder(404)));
    }

    #[test]
    fn a_relocated_folder_keeps_the_cache_it_had_before_the_move() {
        let (store, folder_id) = store_with_folder();
        store
            .cache_graph(folder_id, Some(28), "map 28's graph", 10, "abc123")
            .expect("caches");

        store
            .relocate_folder(folder_id, Path::new("/work/moved"))
            .expect("re-points");

        // The id was never the path, and this is the row that proves it.
        assert!(store
            .cached_graph(folder_id, Some(28))
            .expect("reads")
            .is_some());
    }

    #[test]
    fn forgetting_a_folder_takes_its_cache_with_it_rather_than_leaving_it_behind() {
        let (store, folder_id) = store_with_folder();
        store
            .cache_graph(folder_id, Some(28), "map 28's graph", 10, "abc123")
            .expect("caches");

        store.forget_folder(folder_id).expect("forgets");

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM graph_cache", [], |row| row.get(0))
            .expect("counts");
        assert_eq!(rows, 0);
    }

    #[test]
    fn re_caching_a_map_under_a_different_document_replaces_the_stamp_it_was_written_with() {
        let (store, folder_id) = store_with_folder();
        store
            .cache_graph(folder_id, Some(28), "ten labels", 100, "the narrow one")
            .expect("caches");

        store
            .cache_graph(folder_id, Some(28), "a hundred labels", 200, "the wide one")
            .expect("caches again");

        // A stamp left out of the `ON CONFLICT ... DO UPDATE SET` clause keeps
        // its first value forever, so the new body would go on claiming to have
        // come from the narrow document. That is the whole failure.
        assert_eq!(
            store
                .cached_graph(folder_id, Some(28))
                .expect("reads")
                .expect("is there")
                .query_id,
            Some("the wide one".to_string())
        );
    }
}
