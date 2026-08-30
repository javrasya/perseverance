//! What moved since you last looked, as a record rather than as a feeling.
//!
//! The ledger's **only input is the model diff**. Run state is not in
//! [`Model`] and belongs to the rack, so the boundary is structural rather
//! than remembered: nothing in this file can reach a session, a process or a
//! log, because nothing in this file is handed one.
//!
//! **The tick is the entry.** One row per differing poll, the changes as
//! clauses inside it, ordered by the fixed precedence [`ClauseKind`] declares.
//! Same-kind changes collapse into one clause with a count and the numbers, so
//! two resolutions two seconds apart read as what they are — two things that
//! were true together when we looked. There is no causal attribution anywhere
//! here and there never can be: a diff that carries two resolutions cannot say
//! which one unblocked anything, and a row that said so would be a guess
//! dressed as a record.
//!
//! **A failed poll draws no row, as a shape rather than as a rule.**
//! [`ChangeLog::observed`] is the only mutator and it takes a `&Model`, which
//! only a landed read can produce. There is deliberately no method for a poll
//! that did not land, so there is nowhere for one to be recorded even by
//! accident — the stale stamp on the snapshot's provenance carries the health
//! instead.
//!
//! **Absence is never a zero.** A log that has not yet completed a comparison
//! reads [`Since::FirstOpen`], and only a successful poll that found nothing
//! produces the zero. The two are different facts and they are different
//! values.
//!
//! **Nothing here reads a clock or holds a timestamp**, for the reason
//! [`crate::derive`] gives: model equality is the diff unit, and a stamp
//! anywhere in this tree would either be a change that never happened or a
//! sort key somebody eventually trusts over the order of the entries
//! themselves. The entries are already in the order they were observed.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::derive::{ChildKind, Cut, Map, Model, Node, NodeState};

/// How many entries one map's log keeps, for the session and no longer.
///
/// The ledger is a notification surface, not an archive: an append-only table
/// would be a second, less accurate copy of the history GitHub already keeps.
pub const RING_CAPACITY: usize = 200;

/// The vocabulary a change can be named in, **and the fixed precedence**.
///
/// Declaration order *is* the precedence — issue-level, then edges, then
/// claims, then derived, then the catch-all — and [`Ord`] is derived from it.
/// That is why no sort site in this workspace spells the order out: there is
/// one place it could be wrong, and it is this list.
///
/// [`ClauseKind::Unnamed`] is load-bearing rather than a fallback. A curated
/// vocabulary is a chosen field set one layer up, and a chosen field set is a
/// field added later, forgotten, and a change going quietly unreported. So a
/// differing tick **always** draws a row, and a field this list cannot name is
/// carried in free.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClauseKind {
    /// A node that was not on the map the last time we looked.
    Created,
    /// A node that is no longer on the map.
    Removed,
    Resolved,
    /// A node the map document cut: closed on GitHub **and** named under
    /// `## Out of scope`, which reaches this file as
    /// [`crate::derive::Cut::FromScope`] on the node. Keyed on the decoration
    /// and not on the state, so a ticket that closed as done still draws
    /// [`ClauseKind::Resolved`].
    ///
    /// It is drawn **instead of** the resolution and never beside it — see the
    /// branch in [`clauses_of`], which is where that argument is made.
    CutFromScope,
    Reopened,
    /// A node whose classification became [`ChildKind::Unclassified`] — a
    /// label that stopped saying what this is.
    Unclassified,
    /// A node whose classification became [`ChildKind::Spec`].
    SpecAppeared,
    Unblocked,
    Blocked,
    Claimed,
    Released,
    FrontierMoved,
    /// The fog region moved: a line added under `## Not yet specified`, one
    /// struck off, or the heading itself appearing or going away. Keyed on
    /// [`crate::derive::Map::fog`], which is the section and not the body it
    /// came from — so a note taken elsewhere in the map document draws nothing.
    FogChanged,
    PhaseChanged,
    MapClosed,
    /// The catch-all. Whatever changed in the model that this list has no word
    /// for — a title, a URL, an edge, a field added after this file was
    /// written.
    Unnamed,
}

/// One named change inside an entry, already collapsed.
///
/// `numbers` is in map order — the operator's own drag order — and `count` is
/// its length, except where the change has no node to name: a map-level clause
/// counts as one, and the catch-all adds one for a map-level unnamed change
/// riding along with node-level ones. A clause is never split across an entry
/// and never merged across two.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clause {
    pub kind: ClauseKind,
    /// The nodes this clause is about, in map order. Empty on a map-level
    /// clause, which is about the map itself.
    pub numbers: Vec<u64>,
    /// How many changes this clause stands for. Usually `numbers.len()`, and
    /// `1` for a map-level clause that names no node; on the catch-all it may
    /// exceed the list, because a map-level unnamed change is one more change
    /// with no number to put in it. Carried rather than recomputed on the far
    /// side so that *two resolved* is a fact the record states rather than a
    /// length the renderer happens to take.
    pub count: usize,
    /// **Whether this clause counts towards the unread numeral**, decided here
    /// and nowhere else. See [`stamp`].
    pub announce: bool,
}

/// Why this entry was drawn.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Occasion {
    /// A poll that landed while this session was watching.
    Tick,
    /// The first comparison after resuming, against the graph the cache held.
    /// One row, however long the gap was — the ledger has no way to know how
    /// many polls it would have taken, and inventing them would be inventing
    /// history.
    WhileYouWereAway,
}

/// One differing tick, whole.
///
/// **Entries never revise.** Blocked then unblocked is two entries, because
/// each says what was true when we looked, and editing the first would make it
/// say something nobody observed.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Monotonic within one map's log, starting at one. The read marker on the
    /// far side is a `seq`, which is the whole of what the frontend holds.
    pub seq: u64,
    pub occasion: Occasion,
    /// In the precedence [`ClauseKind`] declares. Never empty.
    pub clauses: Vec<Clause>,
}

/// What the log has to say about its own beginning.
///
/// Two words, and neither of them is a clock reading: this answers *has a
/// comparison happened yet*, and nothing else.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Since {
    /// Nothing has been compared against anything. Renders as *first open*,
    /// never as `0 changes` — a map nobody has read is not a map that has not
    /// moved.
    FirstOpen,
    /// At least one comparison has completed, so an empty list is a real zero.
    Watching,
}

/// One map's log, as it crosses to the WebView.
///
/// No `PartialEq`, for the reason [`crate::Provenance`] has none: this rides on
/// the snapshot beside the model, and change detection is the model's business
/// and only the model's. A comparable ledger is a ledger that ends up inside
/// somebody's equality check, and every entry in it would then make the next
/// tick differ from the last.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub since: Since,
    /// Oldest first, at most [`RING_CAPACITY`] of them.
    pub entries: Vec<Entry>,
}

impl Ledger {
    /// The ledger for a map nothing has ever been read for.
    pub fn first_open() -> Ledger {
        Ledger {
            since: Since::FirstOpen,
            entries: Vec::new(),
        }
    }
}

/// The holder: one map's log, for the length of this session.
///
/// **Not a crossing type.** It holds the previous model so it can diff against
/// it, and that model is an implementation detail of the comparison rather than
/// something the WebView is owed a second copy of. [`ChangeLog::ledger`] is the
/// whole of what crosses.
///
/// There is deliberately **no method for a poll that failed**. [`Self::observed`]
/// is the only mutator and its argument is a `&Model`, which only a landed read
/// can produce — so *a failed poll draws no row* needs no discipline to hold.
#[derive(Debug, Clone)]
pub struct ChangeLog {
    /// What the last landed read derived. `None` until the first one lands.
    held: Option<Model>,
    entries: VecDeque<Entry>,
    next_seq: u64,
    /// Whether a comparison has ever completed. This, and not the entry count,
    /// is what separates *first open* from a zero.
    compared: bool,
    /// Whether the baseline came from cache, so the first comparison is the
    /// one that happened while nobody was looking.
    resumed: bool,
}

impl ChangeLog {
    /// Nothing has ever been read for this map.
    pub fn first_open() -> ChangeLog {
        ChangeLog {
            held: None,
            entries: VecDeque::new(),
            next_seq: 1,
            compared: false,
            resumed: false,
        }
    }

    /// A cached graph is the baseline; the next observation draws a *while you
    /// were away* row.
    pub fn resuming(baseline: Model) -> ChangeLog {
        ChangeLog {
            held: Some(baseline),
            entries: VecDeque::new(),
            next_seq: 1,
            compared: false,
            resumed: true,
        }
    }

    /// One poll that landed.
    ///
    /// `ours` names the node numbers whose claim this session's harness
    /// originated — the one change on screen you could have predicted, and so
    /// the one that does not announce. An empty slice is the honest answer
    /// before anything in this app can start work: every claim is somebody
    /// else's, and every one of them announces.
    pub fn observed(&mut self, next: &Model, ours: &[u64]) {
        let Some(previous) = self.held.as_ref() else {
            // The first read of the session with no cached baseline. There is
            // nothing to compare it against, so there is no entry and the log
            // still reads *first open* — which is the true statement.
            self.held = Some(next.clone());
            return;
        };

        let mut clauses = clauses_of(previous, next);
        if !clauses.is_empty() {
            stamp(&mut clauses, ours);
            let occasion = if self.resumed {
                Occasion::WhileYouWereAway
            } else {
                Occasion::Tick
            };
            self.entries.push_back(Entry {
                seq: self.next_seq,
                occasion,
                clauses,
            });
            self.next_seq += 1;
        }

        // The gap is closed by the first comparison whether or not anything
        // moved across it: a resume that found nothing is a session that was
        // away and missed nothing.
        self.resumed = false;
        self.compared = true;
        self.held = Some(next.clone());

        while self.entries.len() > RING_CAPACITY {
            self.entries.pop_front();
        }
    }

    /// What crosses: the whole ring, oldest first.
    pub fn ledger(&self) -> Ledger {
        Ledger {
            since: if self.compared {
                Since::Watching
            } else {
                Since::FirstOpen
            },
            entries: self.entries.iter().cloned().collect(),
        }
    }
}

/// **The only place `announce` is decided.**
///
/// It is decided here, in Rust, over one entry's finished clause list, because
/// the alternative is liveness in the render path — a rule about which changes
/// are interesting, evaluated where the paint happens, drifting from the record
/// it is filtering. The other side of the seam holds a read marker and nothing
/// more: the highest `seq` it has read, and a sum over the clauses stamped
/// `true`.
///
/// Three rules:
///
/// - The catch-all never announces. It is there so nothing is lost, not so
///   everything is shouted about.
/// - A [`ClauseKind::Claimed`] clause does not announce **iff every number in
///   it is one this session's harness claimed**. A mixed clause announces: it
///   contains a claim you could not have predicted, and announcing is the safe
///   direction.
/// - A [`ClauseKind::FrontierMoved`] clause inherits `false` from a
///   non-announcing claim in the same entry — claiming the frontier is what
///   moves it, and the move is the same fact told twice.
///
/// Everything else announces. After a restart nothing is ours, so everything
/// announces, which is correct anyway.
fn stamp(clauses: &mut [Clause], ours: &[u64]) {
    /// Every number in this clause is one we claimed ourselves — and there is
    /// at least one, because an empty clause is nobody's doing and would
    /// otherwise fall out of `all` as vacuously ours.
    fn all_ours(clause: &Clause, ours: &[u64]) -> bool {
        !clause.numbers.is_empty() && clause.numbers.iter().all(|number| ours.contains(number))
    }

    for clause in clauses.iter_mut() {
        clause.announce = match clause.kind {
            ClauseKind::Unnamed => false,
            ClauseKind::Claimed => !all_ours(clause, ours),
            _ => true,
        };
    }

    let ours_alone = clauses
        .iter()
        .any(|clause| clause.kind == ClauseKind::Claimed && !clause.announce);
    if ours_alone {
        for clause in clauses.iter_mut() {
            if clause.kind == ClauseKind::FrontierMoved {
                clause.announce = false;
            }
        }
    }
}

/// One kind's numbers, in the order they were met, kept as a list rather than
/// a map so that *map order* survives the collapse.
#[derive(Default)]
struct Buckets(Vec<(ClauseKind, Vec<u64>)>);

impl Buckets {
    fn note(&mut self, kind: ClauseKind, number: u64) {
        match self.0.iter_mut().find(|(held, _)| *held == kind) {
            Some((_, numbers)) => numbers.push(number),
            None => self.0.push((kind, vec![number])),
        }
    }
}

/// At most one **state** clause per node, from the table the four states
/// admit.
///
/// One clause and not two, even where two facts moved together. A node holds
/// one [`NodeState`], so a blocked node that came back claimed arrived as a
/// single value; reporting it as both *unblocked* and *claimed* would invent an
/// ordering between two things that were never separately observed. Edges
/// outrank claims in the precedence, so the edge is what the row says.
fn state_clause(before: NodeState, after: NodeState) -> Option<ClauseKind> {
    match (before, after) {
        _ if before == after => None,
        (_, NodeState::Resolved) => Some(ClauseKind::Resolved),
        (NodeState::Resolved, _) => Some(ClauseKind::Reopened),
        (_, NodeState::Blocked) => Some(ClauseKind::Blocked),
        (NodeState::Blocked, NodeState::Claimed | NodeState::Takeable) => {
            Some(ClauseKind::Unblocked)
        }
        (NodeState::Takeable, NodeState::Claimed) => Some(ClauseKind::Claimed),
        (NodeState::Claimed, NodeState::Takeable) => Some(ClauseKind::Released),
        // Every pair left has `before == after` and was caught by the guard.
        _ => None,
    }
}

/// The whole diff, and the only reader of two models at once.
///
/// **A differing tick always draws a row.** Every path out of this function
/// that was reached with `previous != next` returns at least one clause, and
/// the catch-all at the end is what guarantees it — see the `debug_assert` it
/// is guarded by.
///
/// **And the catch-all is a residual, not an `else`.** Both here and in the
/// node loop it is computed by rebuilding the value the named clauses fully
/// account for and comparing that against what actually arrived, with `..`
/// filling the rest. So a change the vocabulary has no word for is reported
/// even when a change it *does* have a word for landed on the same node in the
/// same poll window — a ticket renamed on its way to closed draws both
/// `resolved` and the catch-all — and a field added to [`Node`] or [`Map`]
/// after this file was written is carried without this file being touched.
fn clauses_of(previous: &Model, next: &Model) -> Vec<Clause> {
    if previous == next {
        return Vec::new();
    }

    // A different map, or a map arriving or leaving. There is no diff to take
    // across two graphs, and pretending there is would report every node of the
    // new map as created. One unnamed row says *this is something else now*,
    // which is the whole of what is known.
    let (before, after) = match (previous.map.as_ref(), next.map.as_ref()) {
        (Some(before), Some(after)) if before.number == after.number => (before, after),
        _ => {
            return vec![Clause {
                kind: ClauseKind::Unnamed,
                numbers: Vec::new(),
                count: 1,
                announce: false,
            }]
        }
    };

    let mut buckets = Buckets::default();
    let mut map_level: Vec<ClauseKind> = Vec::new();
    let mut unnamed: Vec<u64> = Vec::new();

    let was: HashMap<u64, &Node> = before
        .nodes
        .iter()
        .map(|node| (node.number, node))
        .collect();
    let is: HashMap<u64, &Node> = after.nodes.iter().map(|node| (node.number, node)).collect();

    for node in &after.nodes {
        let Some(held) = was.get(&node.number) else {
            buckets.note(ClauseKind::Created, node.number);
            continue;
        };
        if *held == node {
            continue;
        }

        // **One clause and not two.** A ticket that closed as cut arrived as
        // one fact — the document named it under `## Out of scope` and GitHub
        // says `CLOSED` — and drawing both *resolved* and *cut from scope*
        // would report progress that is the opposite of what happened. So the
        // cut is the row, and the resolution it rode in on is not a second one.
        //
        // Keyed on the decoration arriving rather than on the state, and
        // one-directional for the reason `map closed` is: a cut taken back is a
        // change the vocabulary has no word for, so it falls past this branch
        // and reaches the residual below.
        let cut_named = matches!((&held.cut, &node.cut), (Cut::InScope, Cut::FromScope(_)));
        if cut_named {
            buckets.note(ClauseKind::CutFromScope, node.number);
        } else if let Some(kind) = state_clause(held.state, node.state) {
            buckets.note(kind, node.number);
        }

        // One ticket type becoming another is a real change with no word for
        // it: *research became a task* is not in the vocabulary and is not
        // worth inventing a word for, so it goes to the catch-all below with
        // everything else the vocabulary could not consume.
        let unnameable_kind = held.kind != node.kind
            && match node.kind {
                ChildKind::Unclassified => {
                    buckets.note(ClauseKind::Unclassified, node.number);
                    false
                }
                ChildKind::Spec => {
                    buckets.note(ClauseKind::SpecAppeared, node.number);
                    false
                }
                ChildKind::Ticket(_) => true,
            };

        // **The residual, not a fallback.** The clauses above account for
        // exactly three fields, so the node they fully explain is the held one
        // wearing the new `state`, the new `kind` and — where the branch above
        // actually fired — the new `cut`. Anything left over — a title, a URL,
        // an edge, or a field added to [`Node`] after this file was written —
        // makes that reconstruction differ from what actually arrived, and the
        // catch-all carries it.
        //
        // The `..` is what makes this field-exhaustive rather than a second
        // chosen field set: a new field arrives from `held` and any change to
        // it shows up here without this file being touched. And because it is
        // a residual rather than an `else`, a rename landing in the same poll
        // window as a close draws both `resolved` and the catch-all, instead of
        // the rename being swallowed by the named clause.
        //
        // `cut` takes the new value only where the clause above named it, the
        // way `closed` does at the map level below. A cut taken back and a
        // reason reworded in place are both changes with no word in the
        // vocabulary, so they keep the held value here, differ from what
        // arrived, and reach the catch-all — which is where a change nothing
        // can name belongs.
        let cut_accounted = if cut_named {
            node.cut.clone()
        } else {
            held.cut.clone()
        };
        let accounted = Node {
            state: node.state,
            kind: node.kind,
            cut: cut_accounted,
            ..(*held).clone()
        };
        if unnameable_kind || accounted != *node {
            unnamed.push(node.number);
        }
    }

    for node in &before.nodes {
        if !is.contains_key(&node.number) {
            buckets.note(ClauseKind::Removed, node.number);
        }
    }

    // One-directional on purpose: *map closed* is a word the vocabulary has,
    // and *map reopened* is not. Whether the clause actually fired is carried
    // rather than re-derived, because the residual below has to know which of
    // the two directions this was — a reopen is a change with no name and must
    // reach the catch-all.
    let closed_named = !before.closed && after.closed;
    if closed_named {
        map_level.push(ClauseKind::MapClosed);
    }
    if before.phase != after.phase {
        map_level.push(ClauseKind::PhaseChanged);
    }
    if before.frontier != after.frontier {
        map_level.push(ClauseKind::FrontierMoved);
    }
    if before.fog != after.fog {
        map_level.push(ClauseKind::FogChanged);
    }

    // **The nodes are rebuilt rather than pre-accounted**, and this is the one
    // field where the difference bites. The loop above is order-blind — it keys
    // through a map of numbers and compares each node's content — but
    // `Vec<Node>` equality is not, because **map order is the operator's own
    // drag order** (see [`crate::derive::Map::nodes`]) and this app never
    // re-sorts it. The vocabulary has no word for a reorder, so handing
    // `after.nodes` in here would pre-account a field no clause spoke for, and
    // a drag would go unreported the moment anything else on the same poll drew
    // a clause. Which it readily does: the frontier is the first takeable node
    // in map order, so dragging one above it draws `frontier moved` all by
    // itself and would have swallowed its own cause.
    //
    // What the clauses genuinely explain is *which* nodes are here and what
    // each holds: [`ClauseKind::Created`] names an arrival — the slot it
    // arrived in included, because arriving somewhere is what that is —
    // [`ClauseKind::Removed`] a departure, and the loop explains every
    // survivor's content down to the catch-all it pushed for a field it could
    // not name. So the arrivals keep their slots and the survivors fill the
    // rest **in the order `before` had them**. That reconstruction equals
    // `after.nodes` exactly when the survivors' relative order is untouched,
    // and differs the moment two of them swapped — which reaches the catch-all
    // like any other change nothing can name.
    let mut survivors = before
        .nodes
        .iter()
        .filter_map(|node| is.get(&node.number).copied());
    let accounted_nodes: Vec<Node> = after
        .nodes
        .iter()
        // The two cannot run out of step: a slot this admits is a node
        // `before` also had, and there are exactly as many of those as
        // `survivors` yields.
        .map(|node| match was.contains_key(&node.number) {
            true => survivors.next().unwrap_or(node),
            false => node,
        })
        .cloned()
        .collect();

    // The map's own residual, taken the same way and for the same reason. The
    // listed fields are the ones something else on this row already accounts
    // for: `phase` and `frontier` by the map-level clauses just pushed, `nodes`
    // by the reconstruction above — and `counts`, which is a pure function of
    // `nodes` (see [`crate::derive::Map::of`]) and so is named by whichever
    // node clause explains the nodes that moved. Counting it as unnamed would
    // hang a catch-all off every single resolution, which is the opposite of
    // the catch-all's job.
    //
    // And `fog`, by the clause just pushed. Leaving it out would send every fog
    // change to the catch-all, which is the state this ticket found the
    // vocabulary in.
    //
    // `closed` takes the new value only where the clause above actually named
    // it. A map that *reopened* is a change the vocabulary has no word for, so
    // it keeps the old value here, differs from `after`, and reaches the
    // catch-all — pre-accounting a field no clause spoke for is how a change
    // goes silently unreported.
    //
    // Everything else — the title, and any field added to [`Map`] later —
    // comes from `before` and so differs from `after` exactly when it changed.
    let closed_accounted = if closed_named {
        after.closed
    } else {
        before.closed
    };
    let accounted = Map {
        closed: closed_accounted,
        phase: after.phase,
        frontier: after.frontier,
        counts: after.counts,
        nodes: accounted_nodes,
        fog: after.fog.clone(),
        ..before.clone()
    };
    let unnamed_map = accounted != *after;

    let mut clauses: Vec<Clause> = buckets
        .0
        .into_iter()
        .map(|(kind, numbers)| Clause {
            kind,
            count: numbers.len(),
            numbers,
            announce: false,
        })
        .collect();

    for kind in map_level {
        clauses.push(Clause {
            kind,
            numbers: Vec::new(),
            count: 1,
            announce: false,
        });
    }

    // **One Unnamed clause, carrying both residuals.** A second one would break
    // the one-clause-per-kind invariant the renderer keys on, so the map's own
    // unnamed change rides on the node clause as an extra unit of `count`. That
    // is legitimate precisely because [`Clause::count`] is carried rather than
    // recomputed from `numbers`: *three things changed and two of them were
    // these nodes* is a truer sentence than a list that quietly drops the map.
    if !unnamed.is_empty() {
        clauses.push(Clause {
            kind: ClauseKind::Unnamed,
            count: unnamed.len() + usize::from(unnamed_map),
            numbers: unnamed,
            announce: false,
        });
    } else if unnamed_map || clauses.is_empty() {
        clauses.push(Clause {
            kind: ClauseKind::Unnamed,
            numbers: Vec::new(),
            count: 1,
            announce: false,
        });
    }

    debug_assert!(
        !clauses.is_empty(),
        "the models differ, so something has to be on the row"
    );

    // Stable, so the collapse order inside one kind is untouched and the only
    // thing this decides is the precedence between kinds.
    clauses.sort_by_key(|clause| clause.kind);
    clauses
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::{Cut, Fog, FogRegion, Frontier, Machine, Map, Phase, TicketType};
    use crate::read_response;

    const AWKWARD: &str = include_str!("../fixtures/awkward-children.json");
    const FOG_CHARTED: &str = include_str!("../fixtures/fog-charted.json");

    /// Named rather than [`Machine::host`], so these entries read the same on
    /// every runner. Nothing in this fixture carries a `platform:` label, so
    /// the choice cannot show — see the guard in [`crate::derive`].
    const MACHINE: Machine = Machine::Windows;

    fn base() -> Model {
        Model::of(&read_response(AWKWARD).expect("reads"), MACHINE)
    }

    fn map_of(model: &mut Model) -> &mut Map {
        model.map.as_mut().expect("a map")
    }

    fn node_of(model: &mut Model, number: u64) -> &mut Node {
        map_of(model)
            .nodes
            .iter_mut()
            .find(|node| node.number == number)
            .unwrap_or_else(|| panic!("no node {number} on this map"))
    }

    /// Re-derive everything the map holds about its children after a test has
    /// moved one of them. Counts, phase and frontier are functions of the
    /// nodes, and a hand-mutated clone that left them alone would be a model
    /// the derivation could never produce.
    fn settle(model: &mut Model) {
        /// The one filter `tickets` and `open` share, spelled here because
        /// `Node::is_counted` is private to [`crate::derive`] and a test helper
        /// is not a reason to widen it. A cut ticket leaves **both**, so a
        /// hand-mutated cut settles to the counts the derivation would have
        /// produced rather than to a subtraction of two populations.
        fn counted(node: &Node) -> bool {
            matches!(node.kind, ChildKind::Ticket(_)) && matches!(node.cut, Cut::InScope)
        }

        let map = map_of(model);
        let tickets = map.nodes.iter().filter(|node| counted(node)).count();
        let open = map
            .nodes
            .iter()
            .filter(|node| counted(node) && node.state != NodeState::Resolved)
            .count();
        let specs = map
            .nodes
            .iter()
            .filter(|node| node.kind == ChildKind::Spec)
            .count();
        map.counts.tickets = tickets;
        map.counts.open = open;
        map.counts.specs = specs;
        // The resolver itself and not a second copy of it. This helper used to
        // hold a hand-written `find(…)` that compiled fine and would have gone
        // on silently disagreeing with the real one the moment the real one
        // grew a clause — which is exactly what happened when it grew the
        // machine.
        map.frontier = Frontier::of(&map.nodes);
        map.phase = if map.closed {
            Phase::Done
        } else if tickets == 0 && specs == 0 {
            Phase::Unstarted
        } else if open > 0 {
            Phase::Wayfinding
        } else if specs >= 1 {
            Phase::Specced
        } else {
            Phase::SpecReady
        };
    }

    /// Two nodes dragged past each other in map order, and nothing else
    /// touched. The whole of the change is the order, which is a model fact
    /// (`Vec<Node>` equality is order-sensitive) and one the vocabulary has no
    /// word for.
    fn drag_past(model: &mut Model, one: u64, other: u64) {
        let nodes = &mut map_of(model).nodes;
        let here = nodes
            .iter()
            .position(|node| node.number == one)
            .unwrap_or_else(|| panic!("no node {one} on this map"));
        let there = nodes
            .iter()
            .position(|node| node.number == other)
            .unwrap_or_else(|| panic!("no node {other} on this map"));
        nodes.swap(here, there);
    }

    /// A ticket closed **and** named under `## Out of scope`, which is the only
    /// way a cut ever arrives: the document cuts it, the API calls it closed,
    /// and [`Cut`] refuses the decoration to anything the API still calls open.
    /// Written as one helper so no test can hand-build the half of that pair
    /// the derivation would never produce.
    fn cut_from_scope(model: &mut Model, number: u64, reason: &str) {
        let node = node_of(model, number);
        node.state = NodeState::Resolved;
        node.cut = Cut::FromScope(reason.to_string());
    }

    fn kinds(entry: &Entry) -> Vec<ClauseKind> {
        entry.clauses.iter().map(|clause| clause.kind).collect()
    }

    fn clause(entry: &Entry, kind: ClauseKind) -> &Clause {
        entry
            .clauses
            .iter()
            .find(|clause| clause.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} clause among {:?}", kinds(entry)))
    }

    /// A log that has already seen the fixture once, so the next observation
    /// is a comparison.
    fn watching() -> ChangeLog {
        let mut log = ChangeLog::first_open();
        log.observed(&base(), &[]);
        log
    }

    fn only_entry(log: &ChangeLog) -> Entry {
        let ledger = log.ledger();
        assert_eq!(ledger.entries.len(), 1, "expected exactly one entry");
        ledger.entries.into_iter().next().expect("an entry")
    }

    /* -------------------------------------------------------- the entry --- */

    #[test]
    fn a_tick_that_changed_nothing_draws_no_row() {
        let mut log = watching();
        log.observed(&base(), &[]);

        assert!(log.ledger().entries.is_empty());
    }

    #[test]
    fn two_resolutions_in_one_tick_are_one_clause_with_a_count_and_the_numbers() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Resolved;
        node_of(&mut next, 76).state = NodeState::Resolved;
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        // One clause, not two rows and not two entries. Two things that were
        // true together when we looked.
        let resolved = clause(&entry, ClauseKind::Resolved);
        assert_eq!(resolved.numbers, vec![75, 76]);
        assert_eq!(resolved.count, 2);
        assert_eq!(
            entry
                .clauses
                .iter()
                .filter(|clause| clause.kind == ClauseKind::Resolved)
                .count(),
            1
        );
    }

    #[test]
    fn clauses_are_ordered_by_the_precedence_the_enum_declares() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Resolved;
        node_of(&mut next, 76).state = NodeState::Blocked;
        node_of(&mut next, 70).state = NodeState::Claimed;
        // The cut sits between the resolution it is not and the reopen it is
        // not — the seat #36 reserved for it before it had a producer, and the
        // reason landing that producer shifted nothing else on this row.
        cut_from_scope(&mut next, 77, "- #77 covered by the adapter rewrite");
        node_of(&mut next, 71).state = NodeState::Blocked;
        settle(&mut next);

        log.observed(&next, &[]);

        // Issue-level, then edges, then claims, then derived. The nodes were
        // touched in the other order on purpose.
        assert_eq!(
            kinds(&only_entry(&log)),
            vec![
                ClauseKind::Resolved,
                ClauseKind::CutFromScope,
                ClauseKind::Reopened,
                ClauseKind::Blocked,
                ClauseKind::Claimed,
                ClauseKind::FrontierMoved,
            ]
        );
    }

    #[test]
    fn a_node_that_appeared_and_one_that_left_are_named_separately() {
        let mut log = watching();
        let mut next = base();
        let arrival = Node {
            number: 99,
            title: "Charted just now".to_string(),
            url: "https://github.com/o/r/issues/99".to_string(),
            kind: ChildKind::Ticket(TicketType::Task),
            state: NodeState::Blocked,
            waits_on: vec![72],
            bound_elsewhere: false,
            cut: Cut::InScope,
        };
        map_of(&mut next).nodes.push(arrival);
        map_of(&mut next).nodes.retain(|node| node.number != 74);
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(clause(&entry, ClauseKind::Created).numbers, vec![99]);
        assert_eq!(clause(&entry, ClauseKind::Removed).numbers, vec![74]);
    }

    #[test]
    fn a_map_that_closed_draws_the_map_level_clauses_it_can_name() {
        let mut log = watching();
        let mut next = base();
        map_of(&mut next).closed = true;
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::PhaseChanged, ClauseKind::MapClosed]
        );
        // A map-level clause names no node and counts as one.
        assert!(clause(&entry, ClauseKind::MapClosed).numbers.is_empty());
        assert_eq!(clause(&entry, ClauseKind::MapClosed).count, 1);
    }

    #[test]
    fn a_map_that_reopened_draws_the_catch_all_because_the_vocabulary_has_no_word_for_it() {
        let mut closed = base();
        map_of(&mut closed).closed = true;
        settle(&mut closed);

        let mut log = ChangeLog::first_open();
        log.observed(&closed, &[]);

        // A map issue reopened on GitHub. `map closed` is one-directional, so
        // the only honest report of the other direction is the catch-all — the
        // operator has to be told the map came back, not just that the phase
        // moved.
        log.observed(&base(), &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::PhaseChanged, ClauseKind::Unnamed]
        );
        assert!(clause(&entry, ClauseKind::Unnamed).numbers.is_empty());
        assert_eq!(clause(&entry, ClauseKind::Unnamed).count, 1);
    }

    #[test]
    fn switching_to_another_map_is_one_unnamed_row_rather_than_a_diff_across_two_graphs() {
        let mut log = watching();
        let mut next = base();
        map_of(&mut next).number = 61;

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        // Not eight creations and eight removals. Diffing two different maps
        // would report every node on the new one as new, which is a sentence
        // about the reader rather than about the graph.
        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert_eq!(entry.clauses[0].count, 1);
    }

    /// The word that had no producer until #35, producing.
    #[test]
    fn a_fog_that_moved_is_named_rather_than_carried_by_the_catch_all() {
        let mut log = watching();
        let mut next = base();
        map_of(&mut next).fog = Fog::Surveyed(FogRegion {
            count: 1,
            text: "- Whether the ledger survives a restart".to_string(),
        });

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::FogChanged]);
        // A map-level clause names no node and counts as one.
        assert!(clause(&entry, ClauseKind::FogChanged).numbers.is_empty());
        assert_eq!(clause(&entry, ClauseKind::FogChanged).count, 1);
    }

    /// The reason the model carries the section and not the document.
    ///
    /// Two answers about one map whose bodies differ only under *Notes*. The
    /// fog is the same section either way, so the two derive equal models and
    /// the tick draws nothing — where a `Map` carrying the whole body would
    /// have written a row for a sentence somebody typed during a session.
    #[test]
    fn a_map_document_edited_outside_the_fog_is_not_a_change_at_all() {
        let charted = |notes: &str| {
            Model::of(
                &read_response(&FOG_CHARTED.replace("Charted on the second pass.", notes))
                    .expect("reads"),
                MACHINE,
            )
        };
        let before = charted("Charted on the second pass.");
        let after = charted("Charted on the second pass, and again on the third.");

        // The substitution really did land, so this is not two identical
        // answers agreeing with each other.
        assert_ne!(
            read_response(FOG_CHARTED)
                .expect("reads")
                .map
                .expect("a map")
                .body,
            read_response(&FOG_CHARTED.replace("Charted on the second pass.", "Something else."))
                .expect("reads")
                .map
                .expect("a map")
                .body
        );
        assert_eq!(before, after);

        let mut log = ChangeLog::resuming(before);
        log.observed(&after, &[]);
        assert!(log.ledger().entries.is_empty());
    }

    /* ------------------------------------------------------ out of scope --- */

    /// The word that had no producer until #36, producing — and producing
    /// **instead of** the resolution rather than beside it. A ticket the
    /// operator cut is not a decision made, and a row that said `resolved`
    /// about one would report progress that is the opposite of what happened.
    #[test]
    fn a_ticket_cut_from_scope_draws_the_cut_rather_than_a_resolution() {
        let mut log = watching();
        let mut next = base();
        // #77 is claimed and is not the frontier, so the cut is the whole of
        // what moved and the row is exactly the fact under test.
        cut_from_scope(&mut next, 77, "- #77 covered by the adapter rewrite");
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::CutFromScope]);
        assert_eq!(clause(&entry, ClauseKind::CutFromScope).numbers, vec![77]);
        assert_eq!(clause(&entry, ClauseKind::CutFromScope).count, 1);
        // In the vocabulary, so it announces like everything else in it.
        assert!(clause(&entry, ClauseKind::CutFromScope).announce);
    }

    /// A cut taken back is not a resolution, not a reopen and not anything else
    /// this list names — the ticket was closed before and is closed still, and
    /// all that moved is the document's mind. The catch-all is the honest row,
    /// which is why the clause pre-accounts `cut` only where it actually fired.
    #[test]
    fn a_cut_taken_back_draws_the_catch_all_because_the_vocabulary_has_no_word_for_it() {
        let mut before = base();
        cut_from_scope(&mut before, 77, "- #77 covered by the adapter rewrite");
        settle(&mut before);

        // The same closed ticket, its bullet struck off the section.
        let mut after = base();
        node_of(&mut after, 77).state = NodeState::Resolved;
        settle(&mut after);

        let mut log = ChangeLog::resuming(before);
        log.observed(&after, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert_eq!(clause(&entry, ClauseKind::Unnamed).numbers, vec![77]);
    }

    /// And a reason reworded in place, for the same reason. The cut is the same
    /// cut, so *cut from scope* would be a second announcement of a fact
    /// already announced; the words changed, and that is a change with no name.
    #[test]
    fn a_reason_reworded_in_place_draws_the_catch_all_as_well() {
        let mut before = base();
        cut_from_scope(&mut before, 77, "- #77 covered by the adapter rewrite");
        settle(&mut before);

        let mut after = base();
        cut_from_scope(
            &mut after,
            77,
            "- #77 the adapter rewrite already covers this",
        );
        settle(&mut after);

        let mut log = ChangeLog::resuming(before);
        log.observed(&after, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert_eq!(clause(&entry, ClauseKind::Unnamed).numbers, vec![77]);
    }

    /// The residual holds under the new clause too: a ticket renamed on its way
    /// out of scope draws both the cut and the catch-all, exactly as it draws
    /// both `resolved` and the catch-all on its way to done.
    #[test]
    fn a_cut_beside_a_rename_draws_both_the_cut_and_the_catch_all() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 77).title = "Renamed on the way out of scope".to_string();
        cut_from_scope(&mut next, 77, "- #77 covered by the adapter rewrite");
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::CutFromScope, ClauseKind::Unnamed]
        );
        assert_eq!(clause(&entry, ClauseKind::CutFromScope).numbers, vec![77]);
        assert_eq!(clause(&entry, ClauseKind::Unnamed).numbers, vec![77]);
    }

    /* ------------------------------------------------------ the catch-all --- */

    #[test]
    fn a_field_the_vocabulary_cannot_name_still_draws_a_catch_all_row() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 77).title = "Somebody renamed this one".to_string();

        log.observed(&next, &[]);
        let entry = only_entry(&log);
        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert_eq!(entry.clauses[0].numbers, vec![77]);

        // And the same from the map level, where there is no node to name.
        let mut log = watching();
        let mut next = base();
        map_of(&mut next).title = "The awkward map, renamed".to_string();

        log.observed(&next, &[]);
        let entry = only_entry(&log);
        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert!(entry.clauses[0].numbers.is_empty());
        assert_eq!(entry.clauses[0].count, 1);
    }

    /// The catch-all is a **residual**, not an `else`. A change the vocabulary
    /// can name does not consume the rest of the node: renaming a ticket and
    /// closing it between two polls is ordinary GitHub behaviour, and a
    /// fallback would report the close and lose the rename.
    #[test]
    fn a_named_change_beside_an_unnameable_one_does_not_swallow_it() {
        let mut log = watching();
        let mut next = base();
        // #77 is claimed and is not the frontier, so resolving it moves
        // nothing else and the row is exactly the two facts under test.
        node_of(&mut next, 77).title = "Renamed on the way out".to_string();
        node_of(&mut next, 77).state = NodeState::Resolved;
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::Resolved, ClauseKind::Unnamed]
        );
        assert_eq!(clause(&entry, ClauseKind::Resolved).numbers, vec![77]);
        assert_eq!(clause(&entry, ClauseKind::Unnamed).numbers, vec![77]);
    }

    /// Two unnameable changes, one with a number and one without, on the one
    /// clause the precedence allows — and the count says two, because two
    /// things changed. A map rename is not something a node rename gets to
    /// absorb.
    #[test]
    fn a_map_level_unnameable_change_rides_the_same_catch_all_as_a_node_level_one() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 77).title = "Somebody renamed this one".to_string();
        map_of(&mut next).title = "The awkward map, renamed".to_string();

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        // One clause per kind, still.
        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        let unnamed = clause(&entry, ClauseKind::Unnamed);
        assert_eq!(unnamed.numbers, vec![77]);
        assert_eq!(unnamed.count, 2);
    }

    #[test]
    fn a_kind_change_the_vocabulary_cannot_name_lands_in_the_catch_all() {
        let mut log = watching();
        let mut next = base();
        // A task that is now research. Both are tickets, both are takeable,
        // the frontier does not move — and *research became a task* is not a
        // sentence this vocabulary has.
        node_of(&mut next, 75).kind = ChildKind::Ticket(TicketType::Research);
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::Unnamed]);
        assert_eq!(entry.clauses[0].numbers, vec![75]);
    }

    #[test]
    fn a_kind_change_the_vocabulary_can_name_is_named_rather_than_carried() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).kind = ChildKind::Spec;
        settle(&mut next);
        log.observed(&next, &[]);
        assert_eq!(
            kinds(&only_entry(&log)),
            vec![ClauseKind::SpecAppeared, ClauseKind::FrontierMoved]
        );

        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 76).kind = ChildKind::Unclassified;
        settle(&mut next);
        log.observed(&next, &[]);
        assert_eq!(kinds(&only_entry(&log)), vec![ClauseKind::Unclassified]);
    }

    /// **A drag is a change, and the catch-all is what reports it.** Map order
    /// is the operator's own (see [`crate::derive::Map::nodes`]) and this app
    /// never re-sorts it, so two nodes swapping places is a model fact — one
    /// with no word in the vocabulary.
    ///
    /// It is also the trap this row exists to catch: the frontier is the first
    /// takeable node *in map order*, so dragging one takeable above another
    /// moves it, and a residual that pre-accounted the new node list would have
    /// reported the move while silently losing the drag that caused it.
    #[test]
    fn dragging_a_node_past_another_draws_the_catch_all_beside_the_move_it_caused() {
        let mut log = watching();
        let mut next = base();
        // #75 and #76 are the two takeable tickets, in that order. Swapping
        // them hands the frontier to #76 and changes nothing else at all.
        drag_past(&mut next, 75, 76);
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::FrontierMoved, ClauseKind::Unnamed]
        );
        // No node's own content moved, so there is no number to hang it on:
        // what changed is the map's order, which is the map's own fact.
        assert!(clause(&entry, ClauseKind::Unnamed).numbers.is_empty());
        assert_eq!(clause(&entry, ClauseKind::Unnamed).count, 1);
    }

    /// And the same drag beside a change the vocabulary *can* name, which is
    /// the case a fallback would lose: one clause on the row is all it takes
    /// for an `else` to stop looking.
    #[test]
    fn a_reorder_arriving_with_a_resolution_is_not_swallowed_by_it() {
        let mut log = watching();
        let mut next = base();
        // Two specs dragged past each other — neither is takeable, so the
        // frontier stays where it is and the reorder has no clause of its own
        // to hide behind — while a claimed ticket elsewhere closed.
        drag_past(&mut next, 73, 74);
        node_of(&mut next, 77).state = NodeState::Resolved;
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::Resolved, ClauseKind::Unnamed]
        );
        assert_eq!(clause(&entry, ClauseKind::Resolved).numbers, vec![77]);
        assert!(clause(&entry, ClauseKind::Unnamed).numbers.is_empty());
    }

    /// A node arriving is not a reorder. `created` names the arrival and the
    /// slot it arrived in, so the row says that and only that — a catch-all
    /// hung off every new sub-issue would be the noise this file's residual is
    /// carefully not.
    #[test]
    fn a_node_arriving_partway_up_the_map_is_named_rather_than_carried() {
        let mut log = watching();
        let mut next = base();
        let arrival = Node {
            number: 99,
            title: "Charted just now, and dragged up".to_string(),
            url: "https://github.com/o/r/issues/99".to_string(),
            kind: ChildKind::Ticket(TicketType::Task),
            state: NodeState::Blocked,
            waits_on: vec![72],
            bound_elsewhere: false,
            cut: Cut::InScope,
        };
        map_of(&mut next).nodes.insert(2, arrival);
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert_eq!(kinds(&entry), vec![ClauseKind::Created]);
        assert_eq!(clause(&entry, ClauseKind::Created).numbers, vec![99]);
    }

    #[test]
    fn the_catch_all_never_announces() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 77).title = "Somebody renamed this one".to_string();

        log.observed(&next, &[]);

        assert!(!only_entry(&log).clauses[0].announce);
    }

    /* -------------------------------------------------------- announcing --- */

    #[test]
    fn a_claim_this_harness_originated_does_not_announce_and_neither_does_the_frontier_move_beside_it(
    ) {
        let mut log = watching();
        let mut next = base();
        // #75 is the frontier, and claiming it is what moves the frontier to
        // #76. Both are this session's own doing.
        node_of(&mut next, 75).state = NodeState::Claimed;
        settle(&mut next);

        log.observed(&next, &[75]);
        let entry = only_entry(&log);

        assert_eq!(
            kinds(&entry),
            vec![ClauseKind::Claimed, ClauseKind::FrontierMoved]
        );
        assert!(!clause(&entry, ClauseKind::Claimed).announce);
        assert!(!clause(&entry, ClauseKind::FrontierMoved).announce);
    }

    #[test]
    fn a_claim_somebody_else_made_announces() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Claimed;
        settle(&mut next);

        log.observed(&next, &[]);
        let entry = only_entry(&log);

        assert!(clause(&entry, ClauseKind::Claimed).announce);
        assert!(clause(&entry, ClauseKind::FrontierMoved).announce);
    }

    #[test]
    fn a_claim_that_is_only_partly_ours_announces() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Claimed;
        node_of(&mut next, 76).state = NodeState::Claimed;
        settle(&mut next);

        // One of the two is ours. The clause still holds a claim nobody here
        // could have predicted, and announcing is the safe direction.
        log.observed(&next, &[75]);
        let entry = only_entry(&log);

        assert_eq!(clause(&entry, ClauseKind::Claimed).numbers, vec![75, 76]);
        assert!(clause(&entry, ClauseKind::Claimed).announce);
        assert!(clause(&entry, ClauseKind::FrontierMoved).announce);
    }

    #[test]
    fn everything_the_vocabulary_names_announces() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 76).state = NodeState::Blocked;
        settle(&mut next);

        log.observed(&next, &[]);

        assert!(clause(&only_entry(&log), ClauseKind::Blocked).announce);
    }

    /* ------------------------------------------------------ immutability --- */

    #[test]
    fn blocked_then_unblocked_is_two_entries_and_neither_is_revised() {
        let mut log = watching();

        let mut blocked = base();
        node_of(&mut blocked, 75).state = NodeState::Blocked;
        settle(&mut blocked);
        log.observed(&blocked, &[]);

        let first = only_entry(&log);
        assert_eq!(
            kinds(&first),
            vec![ClauseKind::Blocked, ClauseKind::FrontierMoved]
        );

        log.observed(&base(), &[]);
        let ledger = log.ledger();

        // Two rows, and the first still says what was true when we looked.
        assert_eq!(ledger.entries.len(), 2);
        assert_eq!(ledger.entries[0].clauses, first.clauses);
        assert_eq!(ledger.entries[0].seq, 1);
        assert_eq!(
            kinds(&ledger.entries[1]),
            vec![ClauseKind::Unblocked, ClauseKind::FrontierMoved]
        );
        assert_eq!(ledger.entries[1].seq, 2);
    }

    #[test]
    fn the_ring_keeps_only_the_last_two_hundred_entries() {
        let mut log = watching();

        for tick in 1..=250u64 {
            let mut next = base();
            map_of(&mut next).title = format!("The awkward map, take {tick}");
            log.observed(&next, &[]);
        }

        let ledger = log.ledger();
        assert_eq!(ledger.entries.len(), RING_CAPACITY);
        // Oldest first, and the oldest fifty have been dropped from the front.
        assert_eq!(ledger.entries[0].seq, 51);
        assert_eq!(ledger.entries[RING_CAPACITY - 1].seq, 250);
    }

    /* ----------------------------------------------------------- absence --- */

    #[test]
    fn a_map_nothing_has_been_read_for_reads_as_first_open_rather_than_as_a_zero() {
        let log = ChangeLog::first_open();
        assert!(matches!(log.ledger().since, Since::FirstOpen));
        assert!(log.ledger().entries.is_empty());

        // The first read that lands has nothing to be compared against, so it
        // is still *first open* and emphatically not `0 changes`.
        let mut log = log;
        log.observed(&base(), &[]);
        assert!(matches!(log.ledger().since, Since::FirstOpen));
        assert!(log.ledger().entries.is_empty());

        assert!(matches!(Ledger::first_open().since, Since::FirstOpen));
    }

    #[test]
    fn a_successful_poll_that_found_nothing_is_a_zero_rather_than_first_open() {
        let mut log = watching();
        log.observed(&base(), &[]);

        // A comparison completed and found nothing. That is a number.
        assert!(matches!(log.ledger().since, Since::Watching));
        assert!(log.ledger().entries.is_empty());
    }

    #[test]
    fn a_cached_baseline_draws_one_while_you_were_away_row() {
        let mut log = ChangeLog::resuming(base());

        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Resolved;
        settle(&mut next);
        log.observed(&next, &[]);

        let ledger = log.ledger();
        assert_eq!(ledger.entries.len(), 1);
        assert!(matches!(
            ledger.entries[0].occasion,
            Occasion::WhileYouWereAway
        ));
        assert!(matches!(ledger.since, Since::Watching));

        // One row for the gap, and the session's own polls from then on.
        let mut later = next.clone();
        node_of(&mut later, 76).state = NodeState::Resolved;
        settle(&mut later);
        log.observed(&later, &[]);

        let ledger = log.ledger();
        assert_eq!(ledger.entries.len(), 2);
        assert!(matches!(ledger.entries[1].occasion, Occasion::Tick));
    }

    #[test]
    fn a_resume_that_missed_nothing_still_stops_being_a_resume() {
        let mut log = ChangeLog::resuming(base());
        log.observed(&base(), &[]);

        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Resolved;
        settle(&mut next);
        log.observed(&next, &[]);

        // The gap was closed by the comparison that found nothing across it,
        // so this is an ordinary tick rather than a second homecoming.
        assert!(matches!(only_entry(&log).occasion, Occasion::Tick));
    }

    /* --------------------------------------------------------- no clocks --- */

    /// The same guard [`crate::derive`] puts on the model, on the value that
    /// rides beside it. A stamp anywhere in the ledger would become a sort key
    /// somebody trusts over the order the entries were actually observed in,
    /// and — because GitHub has been measured stamping `updatedAt` a second
    /// *behind* the event it describes — would be wrong exactly when it
    /// mattered.
    #[test]
    fn nothing_in_the_ledger_is_a_timestamp() {
        /// `ledger.since` is exempt, and only there. The word matches because
        /// the guard catches `since` as a clock word, but this one holds
        /// `firstOpen | watching`: it answers *has a comparison happened yet*,
        /// which is the very distinction that keeps a never-read map from
        /// rendering as a zero. Nothing reads it as a moment and nothing can —
        /// it is an enum of two words.
        const EXEMPT: &str = "ledger.since";

        fn walk(value: &serde_json::Value, path: &str) {
            match value {
                serde_json::Value::Object(fields) => {
                    for (name, held) in fields {
                        let here = format!("{path}.{name}");
                        let lowered = name.to_lowercase();
                        let stamped = name.ends_with("At")
                            || ["time", "date", "stamp", "epoch", "second", "since"]
                                .iter()
                                .any(|word| lowered.contains(word));
                        assert!(
                            !stamped || here == EXEMPT,
                            "{here} looks like a timestamp, and the ledger reads no clock"
                        );
                        walk(held, &here);
                    }
                }
                serde_json::Value::Array(items) => {
                    for (index, item) in items.iter().enumerate() {
                        walk(item, &format!("{path}[{index}]"));
                    }
                }
                _ => {}
            }
        }

        // A populated ledger, so every field of every entry is walked and not
        // just the outline of an empty one.
        let mut log = ChangeLog::resuming(base());
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Claimed;
        node_of(&mut next, 77).title = "Renamed".to_string();
        settle(&mut next);
        log.observed(&next, &[75]);

        let ledger = log.ledger();
        assert!(!ledger.entries.is_empty());
        walk(
            &serde_json::to_value(&ledger).expect("serialises"),
            "ledger",
        );
    }

    #[test]
    fn a_ledger_survives_a_round_trip_through_json() {
        let mut log = watching();
        let mut next = base();
        node_of(&mut next, 75).state = NodeState::Resolved;
        settle(&mut next);
        log.observed(&next, &[]);

        let json = serde_json::to_string(&log.ledger()).expect("serialises");
        let parsed: Ledger = serde_json::from_str(&json).expect("parses");

        assert!(matches!(parsed.since, Since::Watching));
        assert_eq!(parsed.entries, log.ledger().entries);
        // The vocabulary crosses camelCased, like everything else on the seam.
        assert!(json.contains("\"frontierMoved\""));
    }
}
