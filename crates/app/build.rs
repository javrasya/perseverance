fn main() {
    tauri_build::build();

    embed_the_common_controls_dependency();
}

/// The one linker flag this crate adds, and it exists for the test binary.
///
/// `cargo test` links a harness that `tauri_build` never sees, so it gets no
/// application manifest — while still importing `TaskDialogIndirect`,
/// `SetWindowSubclass` and `DefSubclassProc`, which are reached through the
/// dialog plugin and exist only in version 6 of the common controls. With no
/// manifest naming that version the loader binds them against the version 5
/// `comctl32.dll` in `System32`, which does not export them, and **every test
/// in this crate dies at process load** with `STATUS_ENTRYPOINT_NOT_FOUND`
/// before one of them runs. That is what stood between `poll_once` and a test
/// that could call it.
///
/// Deliberately *not* `/MANIFEST:EMBED`. Cargo has no way to pass a link
/// argument to the test harness alone, so this reaches the shipped binary too —
/// and that binary already carries a manifest as a resource, which an embedded
/// second one collides with (`CVT1100: duplicate resource`). Without `:EMBED`
/// the linker writes `<exe>.manifest` beside each output instead: the shipped
/// binary ignores it in favour of the resource it already has, and the test
/// harness, which has no resource, loads it. Nothing about the shipped app
/// changes.
fn embed_the_common_controls_dependency() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }

    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32'          name='Microsoft.Windows.Common-Controls' version='6.0.0.0'          processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
