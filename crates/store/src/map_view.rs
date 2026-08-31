//! The fourth table: how much window a map was worth, last time it was open.
//!
//! Per map and never app-global — see `src/panes/position.ts`, which is the
//! other end of this seam and says why: a twelve-node map is read at a glance
//! and a hundred-node one is worked at, and coming back to a map you spent an
//! afternoon widening to find it back at the default is the app forgetting what
//! you were doing.
//!
//! Two rules shape every function here:
//!
//! - **Lazily created.** A map nobody has moved the dial on has no row. The
//!   default belongs to the frontend, which is the only side that knows where a
//!   dial with nothing remembered opens.
//! - **A layout that cannot be read is an absence.** This module stores text
//!   and reads text back; what the envelope means is the app crate's business,
//!   and the crate that parses it treats anything it cannot parse the way
//!   `agent_override` already does — as nothing having been remembered. A store
//!   that has gone bad costs an operator a remembered position, not a working
//!   window.
//!
//! The column is `layout_json` rather than a dial number because the dial is
//! the first layout fact this app has and will not be the last: a second one
//! joins the envelope rather than arriving as a fifth migration.

use rusqlite::{params, OptionalExtension};

use crate::{Store, StoreError};

impl Store {
    /// The layout remembered for one map, verbatim, or nothing at all.
    ///
    /// `None` is *the dial has never been moved on this map*, which is the
    /// caller's cue to open at its own default. It is never a position, because
    /// this crate has no opinion about where a dial sits.
    pub fn map_layout(
        &self,
        folder_id: i64,
        map_number: u64,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT layout_json FROM map_view WHERE folder_id = ?1 AND map_number = ?2",
                params![folder_id, map_number as i64],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Replaces what is remembered about one map's layout.
    ///
    /// One row per map, replaced rather than appended: this is where the dial
    /// is, not where it has been. A folder that is not on the list is refused
    /// by name rather than as a foreign-key violation, the same way
    /// [`Store::cache_graph`] refuses one.
    pub fn remember_map_layout(
        &self,
        folder_id: i64,
        map_number: u64,
        layout_json: &str,
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
            "INSERT INTO map_view (folder_id, map_number, layout_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (folder_id, map_number) DO UPDATE SET
                 layout_json = excluded.layout_json",
            params![folder_id, map_number as i64, layout_json],
        )?;

        Ok(())
    }
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
    fn a_map_nobody_has_moved_the_dial_on_has_no_row_at_all() {
        let (store, folder_id) = store_with_folder();

        assert_eq!(store.map_layout(folder_id, 12).expect("reads"), None);

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM map_view", [], |row| row.get(0))
            .expect("counts");
        assert_eq!(rows, 0, "reading a map is not a reason to write a row");
    }

    #[test]
    fn a_layout_written_for_one_map_comes_back_on_that_map_and_no_other() {
        let (store, folder_id) = store_with_folder();

        store
            .remember_map_layout(folder_id, 12, "{\"dial\":1}")
            .expect("remembers");
        store
            .remember_map_layout(folder_id, 12, "{\"dial\":0.3}")
            .expect("replaces");

        assert_eq!(
            store.map_layout(folder_id, 12).expect("reads"),
            Some("{\"dial\":0.3}".to_string())
        );
        assert_eq!(store.map_layout(folder_id, 13).expect("reads"), None);
    }

    #[test]
    fn a_folder_that_is_not_on_the_list_is_refused_by_name() {
        let store = Store::open_in_memory().expect("opens");

        let refusal = store
            .remember_map_layout(404, 12, "{\"dial\":0.3}")
            .expect_err("refuses");

        assert!(matches!(refusal, StoreError::UnknownFolder(404)));
    }

    #[test]
    fn a_folder_taken_off_the_list_takes_its_remembered_layouts_with_it() {
        let (store, folder_id) = store_with_folder();
        store
            .remember_map_layout(folder_id, 12, "{\"dial\":0.3}")
            .expect("remembers");

        store.forget_folder(folder_id).expect("forgets");

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM map_view", [], |row| row.get(0))
            .expect("counts");
        assert_eq!(rows, 0);
    }
}
