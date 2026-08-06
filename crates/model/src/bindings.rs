//! The two artifacts this crate hands the frontend, and the guard that keeps
//! them honest.
//!
//! The first is `src/snapshot/model.generated.ts` — the TypeScript the WebView
//! compiles against, **generated from the Rust types rather than mirrored by
//! hand**. Every other seam in this workspace is hand-mirrored and pinned from
//! both sides with a pair of tests, which works and which costs a test per
//! field forever. This one is generated, so a field added in Rust and not
//! propagated is not a test somebody has to have written: it is a diff, and the
//! diff is a failing build.
//!
//! The second is `src/snapshot/fixtures/*.json` — whole [`Snapshot`]s, derived
//! from the recorded GraphQL answers next door, which is what `dev:web` boots
//! from with no Rust, no GitHub and no PTY behind it. Deriving them rather than
//! writing them by hand is what stops them being a second, drifting account of
//! what the model does: a fixture is the model's own output or it is fiction.
//!
//! Both are **compared, not written**, on an ordinary run. `cargo test` tells
//! you they moved; `UPDATE_GENERATED=1 cargo test -p perseverance-model` is
//! what moves them, and it is a separate keystroke on purpose — regenerating
//! silently would make the guard a formality.
//!
//! This module is `#[cfg(test)]` and has to be: the `TS` derives are behind
//! `cfg_attr(test, …)`, so the trait implementations exist only inside this
//! crate's own test harness. An integration test under `tests/` links the
//! library compiled *without* `cfg(test)` and would not find them.

use std::path::{Path, PathBuf};

use ts_rs::TS;

use crate::{read_response, Model, Snapshot, Source};

/// Where the generated TypeScript lands, relative to the repository root.
const GENERATED_TYPES: &str = "src/snapshot/model.generated.ts";

/// Where the `dev:web` snapshots land, relative to the repository root.
const FIXTURE_DIR: &str = "src/snapshot/fixtures";

/// 2026-08-05T08:00:00Z. One stamp for every fixture, so the age `dev:web`
/// renders is a property of the clock in the browser rather than of which
/// fixture happens to be loaded.
const FIXTURE_STAMP: i64 = 1_785_916_800;

/// The environment variable that turns this module from a check into a writer.
const UPDATE: &str = "UPDATE_GENERATED";

/// One `dev:web` fixture: what it is called, which recorded answer it is
/// derived from, and what it is here to show.
///
/// The third column is not decoration. These are the states a graph is hard to
/// get into on purpose, and a fixture whose reason nobody wrote down is a
/// fixture the next person deletes.
struct Case {
    slug: &'static str,
    /// The recorded GraphQL answer beside this crate, or `None` for the state
    /// that exists before any answer at all.
    answer: Option<&'static str>,
    why: &'static str,
}

const CASES: &[Case] = &[
    Case {
        slug: "no-map-open",
        answer: None,
        why: "The state the app opens in. An absence, and not an empty map.",
    },
    Case {
        slug: "empty-map",
        answer: Some("empty-map.json"),
        why: "A map with nothing charted on it: unstarted, and no frontier.",
    },
    Case {
        slug: "awkward-map",
        answer: Some("awkward-children.json"),
        why: "An unclassified child, a closed ticket with an open blocker, two \
              spec children, a spec child that would otherwise be takeable, a \
              ticket that is both blocked and claimed, and two takeable \
              tickets so that the frontier is visibly the first and not the \
              only. Its dependencies also close a cycle, so the view that ranks \
              it has to say on screen that no order among those three is the \
              true one.",
    },
    Case {
        slug: "two-maps-one-open",
        answer: Some("two-maps-one-open.json"),
        why: "The ordinary case, and the one every other fixture is awkward \
              relative to.",
    },
    Case {
        slug: "spec-composed",
        answer: Some("spec-composed.json"),
        why: "Every ticket closed and a spec published: specced, and nothing \
              left to start.",
    },
    Case {
        slug: "map-closed",
        answer: Some("map-closed.json"),
        why: "A closed map with an open ticket still on it: done beats \
              everything the children could say.",
    },
];

/// The one fixture that is not a successful read: the same graph as
/// `awkward-map`, aged by a poll that failed.
///
/// It exists because *a failed poll still emits a snapshot* is the kind of
/// claim that is easy to believe and hard to see, and this is what seeing it
/// looks like — the graph exactly as it was, and a stamp that has stopped
/// moving.
const AGED_CASE: (&str, &str, &str) = (
    "unreachable",
    "awkward-children.json",
    "could not reach GitHub",
);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the workspace root is two directories above this crate")
}

fn recorded(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|why| panic!("reading {path:?}: {why}"))
}

fn snapshot_for(case: &Case) -> Snapshot {
    let model = match case.answer {
        None => return Snapshot::no_map_open(),
        Some(answer) => Model::of(&read_response(&recorded(answer)).expect("the answer reads")),
    };

    Snapshot::read(model, Source::Fixture, crate::rfc3339(FIXTURE_STAMP))
}

/// Compare, or rewrite when asked. Line endings are normalised on the way in
/// because a checkout with `core.autocrlf` on would otherwise fail every one of
/// these on Windows for a reason that has nothing to do with the model.
fn agrees(path: &Path, produced: &str, how_to_fix: &str) {
    let normalise = |text: &str| text.replace("\r\n", "\n");

    if std::env::var_os(UPDATE).is_some() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("creating the directory");
        }
        std::fs::write(path, produced).expect("writing the regenerated file");
        return;
    }

    let checked_in = std::fs::read_to_string(path).unwrap_or_else(|why| {
        panic!("{path:?} is missing ({why}).\n{how_to_fix}");
    });

    assert_eq!(
        normalise(&checked_in),
        normalise(produced),
        "\n{path:?} no longer matches what this crate produces.\n{how_to_fix}\n"
    );
}

const HOW_TO_FIX: &str = "The Rust model changed and the checked-in artifact did not. Run:\n\
     \n    UPDATE_GENERATED=1 cargo test -p perseverance-model\n\n\
     then commit what it wrote, and fix whatever `npm run typecheck` then \
     objects to. That second step is the point of generating this: a model \
     change the frontend has not caught up with is a compile error rather than \
     a surprise at runtime.";

#[test]
fn the_typescript_the_webview_compiles_against_is_generated_from_these_types() {
    let scratch =
        std::env::temp_dir().join(format!("perseverance-bindings-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("creating a scratch directory");

    // `with_large_int("number")` is load-bearing. `u64` and `usize` become
    // `bigint` by default, and `bigint` is a type no JSON fixture and no Tauri
    // `invoke` result can ever inhabit — `serde_json` writes plain numbers. The
    // generated types would have been unusable and wrong in the same stroke.
    let config = ts_rs::Config::new()
        .with_out_dir(&scratch)
        .with_large_int("number");

    Snapshot::export_all(&config).expect("exports");

    let produced = std::fs::read_to_string(scratch.join("model.generated.ts"))
        .expect("reading what ts-rs wrote");
    let _ = std::fs::remove_dir_all(&scratch);

    agrees(&repo_root().join(GENERATED_TYPES), &produced, HOW_TO_FIX);
}

#[test]
fn every_dev_web_fixture_is_this_crate_s_own_output() {
    let root = repo_root();

    for case in CASES {
        let json = snapshot_for(case).to_json_string().expect("serialises");
        agrees(
            &root.join(FIXTURE_DIR).join(format!("{}.json", case.slug)),
            &format!("{json}\n"),
            HOW_TO_FIX,
        );
    }

    let (slug, answer, why) = AGED_CASE;
    let model = Model::of(&read_response(&recorded(answer)).expect("the answer reads"));
    let aged =
        Snapshot::read(model, Source::Cache, crate::rfc3339(FIXTURE_STAMP)).aged(why.to_string());
    let json = aged.to_json_string().expect("serialises");
    agrees(
        &root.join(FIXTURE_DIR).join(format!("{slug}.json")),
        &format!("{json}\n"),
        HOW_TO_FIX,
    );
}

/// Every fixture on disk is one this module produces, and every case this
/// module names is on disk.
///
/// Without this, deleting a `Case` leaves an orphan JSON file that `dev:web`
/// goes on offering and nothing goes on checking — a fixture that has quietly
/// stopped being the model's output, which is the one thing these files may
/// never become.
#[test]
fn the_fixture_directory_holds_exactly_the_cases_this_module_names() {
    let directory = repo_root().join(FIXTURE_DIR);
    if std::env::var_os(UPDATE).is_some() {
        return;
    }

    let mut on_disk: Vec<String> = std::fs::read_dir(&directory)
        .unwrap_or_else(|why| panic!("reading {directory:?}: {why}"))
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".json"))
        .collect();
    on_disk.sort();

    let mut named: Vec<String> = CASES
        .iter()
        .map(|case| format!("{}.json", case.slug))
        .chain(std::iter::once(format!("{}.json", AGED_CASE.0)))
        .collect();
    named.sort();

    assert_eq!(on_disk, named);
}

/// Each fixture says why it is here, in the module that produces it. A case
/// with no reason is a case the next person cannot judge the deletion of.
#[test]
fn every_case_says_what_it_is_here_to_show() {
    for case in CASES {
        assert!(!case.why.trim().is_empty(), "{} has no reason", case.slug);
    }
}
