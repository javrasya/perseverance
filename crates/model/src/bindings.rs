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

use crate::{read_response, ChangeLog, Degraded, Machine, Model, Snapshot, Source};

/// The machine every fixture below is derived for, unless its own table names
/// another.
///
/// **Load-bearing, and the reason it is a constant rather than
/// [`Machine::host`].** No recorded answer outside `platform-bound.json` reads
/// differently on one machine than another — which is asserted over the whole
/// fixture directory by
/// `every_recorded_answer_but_the_bound_one_derives_the_same_on_every_machine`
/// next door, not assumed here — so the choice cannot show in any of their
/// output. But `Machine::host()` here would regenerate different bytes on a
/// macOS runner than on a Windows one the moment one of them grew a label, and
/// `every_dev_web_fixture_is_this_crate_s_own_output` would fail for a reason
/// that has nothing to do with the model.
const FIXTURE_MACHINE: Machine = Machine::Windows;

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
    Case {
        slug: "fog-unsurveyed",
        answer: Some("fog-unsurveyed.json"),
        why: "A map document that was written and a fog that was never \
              surveyed: Notes and Decisions-so-far are there and the heading \
              is not. The region still names itself and stands an em dash \
              where a count would go — the fact a `0` would destroy, and the \
              only fixture that can show it.",
    },
    Case {
        slug: "fog-empty",
        answer: Some("fog-empty.json"),
        why: "The other absence: somebody surveyed and found nothing. The \
              heading is there with no bullets under it, so the count is a \
              real zero — and this fixture beside `fog-unsurveyed` is what \
              makes *nobody looked* and *nothing there* distinguishable on \
              screen rather than merely in the type.",
    },
    Case {
        slug: "fog-charted",
        answer: Some("fog-charted.json"),
        why: "A surveyed fog with something in it: three top-level bullets, a \
              nested one that is a detail rather than a fourth thing, a blank \
              line inside the section, and a heading after it that bounds it. \
              It is the only fixture where *rendered verbatim* and *counted \
              structurally* can both be seen, and the only one where the \
              region is drawn under real sections.",
    },
    Case {
        slug: "out-of-scope",
        answer: Some("out-of-scope.json"),
        why: "Two branches that stopped, and the map document says which. #106 \
              is closed and named under `## Out of scope`, so it is resolved \
              with a cut on it: drawn with its reason as visible text, and gone \
              from the counts. #105 is named there too and is still open, so \
              nothing happens to it at all — it stays takeable, stays counted, \
              and nothing warns anybody. #107 is closed and only named through \
              another repository's prefix, so it stays plain resolved, which is \
              what keeps a resolved row on screen beside the cut one and makes \
              the smaller resolved count visible rather than merely asserted. \
              #999 is a number with no row here, and the nested bullet is a \
              detail of the line above it rather than a second cut.",
    },
];

/// One `dev:web` fixture for a read that did not land: what it is called, which
/// recorded answer it aged, what the app concluded, and what it was told.
///
/// A struct rather than a four-column tuple, for the reason [`Case`] is one —
/// the columns name themselves, and nothing downstream has to be read as
/// `.map(|(slug, _, _, _)| …)`.
///
/// It holds [`crate::Degraded`] itself, and there is deliberately no borrowed
/// copy of that enum in this module. A private `Degraded` shadowing the public
/// one made every mention in the file a question about which was meant, and it
/// made the conversion exhaustive over the *private* set — so a fifth public
/// condition would have compiled here and quietly produced no fixture at all,
/// while `the_fixture_directory_holds_exactly_the_cases_this_module_names` went
/// on comparing slugs. ADR 0009 says the taxonomy lives in exactly two places;
/// this is what keeps this file from being a third. The cost is a function
/// rather than a `const`, which buys nothing at test time.
struct AgedCase {
    slug: &'static str,
    /// The recorded GraphQL answer beside this crate, aged rather than refused:
    /// what a failed poll shows is the last copy, not an empty screen.
    answer: &'static str,
    /// What the app concluded — the condition, in the enum that crosses.
    concluded: Degraded,
    /// What it was told, in the words of the crate that established it. A real
    /// sentence from that crate, because a fixture carrying invented prose is a
    /// fixture the copy on screen was never checked against — and, for
    /// `Unreachable` especially, because the sentence and the condition's short
    /// name are not the same claim and must not be able to look like it.
    told: &'static str,
}

/// The fixtures that are not successful reads: the same graph as
/// `awkward-map`, aged by a poll that failed, once per condition the taxonomy
/// can be in.
///
/// One was enough while a failure was a sentence. It is not enough now that a
/// failure is a *structure* the graph paints a condition from: two of these
/// four stop the poller and print a remedy, two of them keep trying, and a
/// browser with no Rust behind it has no way to reach any of them. These are
/// exactly the states the fixture set exists for.
fn aged_cases() -> Vec<AgedCase> {
    vec![
        AgedCase {
            slug: "unreachable",
            answer: "awkward-children.json",
            concluded: Degraded::Unreachable,
            told: "the read did not complete: dns error: failed to look up the address of api.github.com",
        },
        AgedCase {
            slug: "auth-failed",
            answer: "awkward-children.json",
            concluded: Degraded::AuthFailed,
            told: "GitHub answered with status 401: Bad credentials",
        },
        AgedCase {
            slug: "map-gone",
            answer: "awkward-children.json",
            concluded: Degraded::MapGone,
            told: "the answer carried no repository, so it is not an answer about this one",
        },
        AgedCase {
            slug: "rate-limited",
            answer: "awkward-children.json",
            concluded: Degraded::RateLimited {
                resets_at: Some("2026-08-05T09:00:00Z".to_string()),
            },
            told: "GitHub answered with status 403: API rate limit exceeded",
        },
    ]
}

/// One `dev:web` fixture for a snapshot whose ledger has something in it: two
/// recorded answers about **the same map**, the second read later than the
/// first.
///
/// A struct with two answers rather than one, because that is what a ledger
/// entry *is* — the difference between two reads. A fixture that carried a
/// hand-written entry beside an unrelated graph would be exactly the second,
/// drifting account of the model that this module exists to prevent: the row on
/// screen has to be the row the diff produces from the graph beside it, or the
/// frontend is being shown something the app can never show.
struct LedgerCase {
    slug: &'static str,
    /// The recorded answer the cache would have held — the baseline the first
    /// comparison after resuming is taken against.
    baseline: &'static str,
    /// The recorded answer this session's first landed poll returned.
    later: &'static str,
    why: &'static str,
}

/// The fixtures whose ledger is not empty.
///
/// One, and it is the *while you were away* row rather than an ordinary tick:
/// the cold-start comparison against `graph_cache` is the entry a browser has
/// no way to conjure, because reaching it needs a cache row from a previous
/// session and there is no previous session in a `dev:web` tab. An ordinary
/// tick is reachable by leaving the app open, and so does not need a fixture.
fn ledger_cases() -> Vec<LedgerCase> {
    vec![LedgerCase {
        slug: "while-you-were-away",
        baseline: "awkward-children.json",
        later: "awkward-children-later.json",
        why: "The cold start: a cached graph as the baseline, one landed poll \
              against it, and the single row that comes out of the comparison. \
              It carries one clause from each tier of the precedence at once — \
              a resolution, an edge that went away, the frontier \
              moving off the ticket it had designated, and a catch-all holding \
              both a renamed child and the dropped adjacency of the very node \
              the `unblocked` clause names — the catch-all being a residual and \
              not an alternative, a named change does not swallow the rest of \
              the node it happened to land on — so \
              the precedence between clause kinds is visible in one entry \
              rather than inferred from four fixtures. It is also the only \
              fixture whose ledger reads `watching`, which is what makes a real \
              zero distinguishable on screen from a map nobody has opened.",
    }]
}

/// One `dev:web` fixture for a map read **for a particular machine**: what it
/// is called, which recorded answer it is derived from, which machine it is
/// derived for, and what it is here to show.
///
/// A parallel table with its own extra column rather than a fourth column on
/// [`Case`], following the [`AgedCase`] and [`LedgerCase`] precedent: the
/// machine is a question only these fixtures ask, and a column every other case
/// had to answer `Machine::Windows` to would read as a property of all of them.
struct MachineCase {
    slug: &'static str,
    answer: &'static str,
    /// The machine this one is derived **for**, which is the whole of what
    /// separates it from its sibling.
    machine: Machine,
    why: &'static str,
}

/// The fixtures that are one map read twice.
///
/// Two entries against a single recorded answer, because *a frontier this
/// machine can start* and *nothing this machine can start* have to be the same
/// graph or the comparison proves nothing. A browser has no way to reach the
/// second: it is a fact about the host the app is running on, and `dev:web` is
/// not running on one.
fn machine_cases() -> Vec<MachineCase> {
    vec![
        MachineCase {
            slug: "platform-bound-macos",
            answer: "platform-bound.json",
            machine: Machine::MacOs,
            why: "The same map as `platform-bound-windows`, read on the machine \
                  its work belongs to: the first ticket bound elsewhere is \
                  skipped past rather than moved, and the frontier is the first \
                  of the two this machine can start.",
        },
        MachineCase {
            slug: "platform-bound-windows",
            answer: "platform-bound.json",
            machine: Machine::Windows,
            why: "The same map as `platform-bound-macos`, read on a machine \
                  none of its startable work belongs to: every row is still \
                  here and still counted, nothing is designated, and the \
                  frontier says *not on this machine* rather than reading as a \
                  map with nothing left on it.",
        },
    ]
}

/// The snapshot one [`LedgerCase`] produces: the later read, stamped, carrying
/// the log that compared it against the baseline.
fn snapshot_for_ledger(case: &LedgerCase) -> Snapshot {
    let model_of = |answer: &str| {
        Model::of(
            &read_response(&recorded(answer)).expect("the answer reads"),
            FIXTURE_MACHINE,
        )
    };

    let mut log = ChangeLog::resuming(model_of(case.baseline));
    let later = model_of(case.later);
    // `&[]` is the honest slice: nothing in this app can start work yet, so
    // every claim in a fixture is somebody else's and announces.
    log.observed(&later, &[]);

    Snapshot::read(later, Source::Fixture, crate::rfc3339(FIXTURE_STAMP)).with_ledger(log.ledger())
}

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
        Some(answer) => Model::of(
            &read_response(&recorded(answer)).expect("the answer reads"),
            FIXTURE_MACHINE,
        ),
    };

    Snapshot::read(model, Source::Fixture, crate::rfc3339(FIXTURE_STAMP))
}

/// The snapshot one [`MachineCase`] produces: the same read, derived for the
/// machine the case names.
fn snapshot_for_machine(case: &MachineCase) -> Snapshot {
    let model = Model::of(
        &read_response(&recorded(case.answer)).expect("the answer reads"),
        case.machine,
    );

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

    for case in machine_cases() {
        let json = snapshot_for_machine(&case)
            .to_json_string()
            .expect("serialises");
        agrees(
            &root.join(FIXTURE_DIR).join(format!("{}.json", case.slug)),
            &format!("{json}\n"),
            HOW_TO_FIX,
        );
    }

    for case in aged_cases() {
        let model = Model::of(
            &read_response(&recorded(case.answer)).expect("the answer reads"),
            FIXTURE_MACHINE,
        );
        // Aged from a **live read**, which is the only way one of these
        // actually happens: a poll landed, a later one did not, and what is
        // left on screen is the copy the first read left behind. Stamping the
        // fixture `Cache` by hand would have been the fixture agreeing with
        // itself — it is [`Snapshot::aged`] that decides a failed poll is no
        // longer a live read, so the source written below is its answer rather
        // than this table's, and a regression that stopped downgrading would
        // land here as a fixture that no longer matches.
        let aged = Snapshot::read(model, Source::Github, crate::rfc3339(FIXTURE_STAMP))
            .aged(case.concluded, case.told.to_string());
        let json = aged.to_json_string().expect("serialises");
        agrees(
            &root.join(FIXTURE_DIR).join(format!("{}.json", case.slug)),
            &format!("{json}\n"),
            HOW_TO_FIX,
        );
    }

    for case in ledger_cases() {
        let json = snapshot_for_ledger(&case)
            .to_json_string()
            .expect("serialises");
        agrees(
            &root.join(FIXTURE_DIR).join(format!("{}.json", case.slug)),
            &format!("{json}\n"),
            HOW_TO_FIX,
        );
    }
}

/// The row the *while you were away* fixture ships is the one the diff draws,
/// and it is drawn here rather than described here.
///
/// Without this the fixture would still regenerate — it just would not say
/// anything. The clauses named below are the four the two recorded answers
/// differ by, down to which numbers sit on each; if somebody edits either
/// answer, this is what tells them the fixture has stopped showing what its
/// `why` claims it shows.
#[test]
fn the_while_you_were_away_fixture_ships_the_row_its_two_answers_produce() {
    use crate::{ClauseKind, Occasion, Since};

    let case = ledger_cases()
        .into_iter()
        .find(|case| case.slug == "while-you-were-away")
        .expect("the case is named above");
    let snapshot = snapshot_for_ledger(&case);

    assert!(matches!(snapshot.ledger.since, Since::Watching));
    assert_eq!(snapshot.ledger.entries.len(), 1);

    let entry = &snapshot.ledger.entries[0];
    assert_eq!(entry.seq, 1);
    assert!(matches!(entry.occasion, Occasion::WhileYouWereAway));

    // In the precedence the enum declares: issue-level, then edges, then
    // derived, then the catch-all.
    let kinds: Vec<ClauseKind> = entry.clauses.iter().map(|clause| clause.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ClauseKind::Resolved,
            ClauseKind::Unblocked,
            ClauseKind::FrontierMoved,
            ClauseKind::Unnamed,
        ]
    );

    let numbers = |kind: ClauseKind| {
        entry
            .clauses
            .iter()
            .find(|clause| clause.kind == kind)
            .map(|clause| clause.numbers.clone())
            .unwrap_or_else(|| panic!("no {kind:?} clause"))
    };
    assert_eq!(numbers(ClauseKind::Resolved), vec![77]);
    assert_eq!(numbers(ClauseKind::Unblocked), vec![72]);
    // #76 was renamed, and #72 — the node the `unblocked` clause above already
    // names — also dropped the two edges it waited on, which is a change the
    // vocabulary has no word for. Both are on the catch-all, in map order,
    // because it reports the residual the named clauses left rather than only
    // the nodes those clauses missed entirely.
    assert_eq!(numbers(ClauseKind::Unnamed), vec![72, 76]);

    // The catch-all is carried, never shouted about; everything the vocabulary
    // names announces, because nothing here is this session's own doing.
    let announces: Vec<bool> = entry.clauses.iter().map(|clause| clause.announce).collect();
    assert_eq!(announces, vec![true, true, true, false]);

    // And the frontier really did move, so the derived clause is the model's
    // own statement rather than a word this test asked for.
    let baseline = Model::of(
        &read_response(&recorded(case.baseline)).expect("reads"),
        FIXTURE_MACHINE,
    );
    assert_eq!(
        baseline.map.expect("a map").frontier,
        crate::Frontier::Designated(75)
    );
    assert_eq!(
        snapshot.model.map.expect("a map").frontier,
        crate::Frontier::Designated(72)
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
        .chain(
            aged_cases()
                .iter()
                .map(|case| format!("{}.json", case.slug)),
        )
        .chain(
            ledger_cases()
                .iter()
                .map(|case| format!("{}.json", case.slug)),
        )
        .chain(
            machine_cases()
                .iter()
                .map(|case| format!("{}.json", case.slug)),
        )
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
    for case in ledger_cases() {
        assert!(!case.why.trim().is_empty(), "{} has no reason", case.slug);
    }
    for case in machine_cases() {
        assert!(!case.why.trim().is_empty(), "{} has no reason", case.slug);
    }
}

/// **Criterion 5 and criterion 2, asserted against the generated artifacts.**
///
/// One recorded answer, derived twice, and the only two things that may differ
/// are the frontier and the per-node verdict it is drawn from. Everything an
/// operator can count — the rows, the numbers over them, what each row *is* and
/// what state GitHub put it in — is identical, because a machine is a fact
/// about the reader and not about the map.
#[test]
fn the_same_map_reads_differently_on_two_machines() {
    use crate::Frontier;

    let cases = machine_cases();
    let snapshot = |slug: &str| {
        let case = cases
            .iter()
            .find(|case| case.slug == slug)
            .unwrap_or_else(|| panic!("{slug} is named above"));
        snapshot_for_machine(case)
    };

    let mac = snapshot("platform-bound-macos").model.map.expect("a map");
    let windows = snapshot("platform-bound-windows").model.map.expect("a map");

    // The one difference an operator is meant to see.
    assert_eq!(mac.frontier, Frontier::Designated(81));
    assert_eq!(windows.frontier, Frontier::NotOnThisMachine);

    assert_eq!(mac.counts, windows.counts);
    assert_eq!(mac.nodes.len(), windows.nodes.len());
    assert_eq!(mac.phase, windows.phase);

    for (here, there) in windows.nodes.iter().zip(mac.nodes.iter()) {
        assert_eq!(here.number, there.number);
        assert_eq!(here.kind, there.kind);
        assert_eq!(here.state, there.state);
        assert_eq!(here.waits_on, there.waits_on);
        // And the *only* per-node difference is the verdict, which is what
        // makes the equalities above a statement about the model rather than
        // about the two nodes that happened to be checked.
        let same = crate::Node {
            bound_elsewhere: there.bound_elsewhere,
            ..here.clone()
        };
        assert_eq!(&same, there, "#{}", here.number);
    }

    // #80 is bound away from both hosts, so it is held back on either.
    let held_back = |map: &crate::Map, number: u64| {
        map.nodes
            .iter()
            .find(|node| node.number == number)
            .map(|node| node.bound_elsewhere)
    };
    assert_eq!(held_back(&windows, 80), Some(true));
    assert_eq!(held_back(&mac, 80), Some(true));
    assert_eq!(held_back(&windows, 81), Some(true));
    assert_eq!(held_back(&mac, 81), Some(false));
}
