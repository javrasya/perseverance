//! The launcher registry: one SQLite file, and the folder list it holds.
//!
//! Boundary: this crate owns the database file, its schema, the forward-only
//! migration, and the binding of a folder to the GitHub repository behind it.
//! It never opens a socket, never speaks to GitHub, never knows Tauri exists
//! and never spawns a child process. It is the sixth crate rather than a corner
//! of [`perseverance_app`] because it carries real policy — a refusal to guess
//! at an unrecognised schema, the meaning of a path that has gone missing, and
//! three distinct ways a folder can fail to be a repository — and the app
//! crate's charter is wiring only.
//!
//! Two absences are deliberate and are the reason the registry ages well:
//!
//! - **`owner/repo` is nowhere in the schema.** It is derived from the folder's
//!   git remote on every read by [`bind_repo`], so renaming or transferring a
//!   repository on GitHub cannot rot a row here.
//! - **Whether a folder still exists on disk is nowhere in the schema.** It is
//!   checked at read time by [`Folder::is_present`]. Nothing is ever
//!   auto-pruned, so unplugging an external drive does not cost you your list.
//!
//! Nothing secret is ever written here: the GitHub token comes from
//! `gh auth token` at runtime and never touches this file.
//!
//! Filled in by:
//! - #30 the launcher folder list
//! - #32 the read cache: `graph_cache`, a copy and never an authority
//!
//! [`perseverance_app`]: https://github.com/javrasya/perseverance

mod cache;
mod folders;
mod repo;
mod schema;
mod store;

pub use cache::CachedGraph;
pub use folders::Folder;
pub use repo::{bind_repo, RepoBindingError, RepoRef};
pub use schema::STORE_SCHEMA_VERSION;
pub use store::{Store, StoreError};
