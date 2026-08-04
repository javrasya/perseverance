//! The thin Tauri shell.
//!
//! Wiring only. Every decision this app makes belongs to one of the other four
//! crates; what lives here is the window, the command surface, and the plumbing
//! between them. If logic starts accumulating in this crate it belongs
//! somewhere else.

use perseverance_model::Snapshot;

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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![snapshot])
        .run(tauri::generate_context!())
        .expect("perseverance failed to start");
}
