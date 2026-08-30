//! What one answer *means* — the whole derivation, and the only copy of it.
//!
//! Rust owns this end to end and the WebView is pure paint. That is not a
//! stylistic preference: the four node states, the three child categories and
//! the frontier resolver are the rules an operator's *what next* rests on, and a
//! second implementation in TypeScript would be a second set of rules that can
//! disagree with the first. So everything below crosses to the WebView already
//! decided, and `blockedBy` and `assignees` never cross at all.
//!
//! Nothing here reads a clock or a timestamp. That is load-bearing rather than
//! incidental: model equality is the diff unit, and `updatedAt` has been
//! measured running a second *behind* its own close event — so a model carrying
//! one would report a change that never happened and, worse, would be reported
//! as changed by a poll that found nothing new.

use serde::{Deserialize, Serialize};

use crate::read::{ChildRead, MapGraph, MapRead};

/// Every label this app **classifies** by starts here.
///
/// The prefix is what makes a wayfinder label distinguishable from the
/// repository's own labels, so a child carrying `bug` and `priority:high` is
/// unclassified rather than accidentally something.
///
/// It is *classification* and no longer every judgement: [`PLATFORM_PREFIX`] is
/// deliberately outside this family, and its own doc argues why.
pub const WAYFINDER_PREFIX: &str = "wayfinder:";

/// Where a ticket says which machine its facts can be gathered on.
///
/// **Unprefixed, and the one label family that is.** The spec spells it
/// `platform:*` because that is what an operator types, and the two families
/// are not the same kind of statement: a `wayfinder:` label says what a child
/// *is* to this app, and this one states a fact about a machine that would be
/// just as true if this app did not exist. Prefixing it `wayfinder:platform:`
/// would have been the tidier rule and would also have been this app renaming
/// something it does not own.
///
/// The cost is a collision with a repository that runs its own `platform:`
/// taxonomy. It is bounded twice over: a collision only bites on a child that
/// *also* carries a `wayfinder:` label — an unclassified child is refused by
/// [`Node::is_takeable`] anyway — and the symptom is fail-closed and visible,
/// a ticket that stays on screen, stays counted, and is never designated until
/// somebody edits a label. Nothing is hidden and nothing is launched.
///
/// Spelled lower-case because that is the form [`bound_elsewhere`] folds a label
/// to before matching, not because an operator has to type it that way.
pub const PLATFORM_PREFIX: &str = "platform:";

/// Which machine a model is being derived **for**.
///
/// A parameter rather than a `cfg!`, for the reason
/// `perseverance_agent::Platform` is one: a derivation that asked
/// `cfg!(target_os)` inside itself would have exactly half of this ticket's
/// acceptance criteria checkable on any given runner, and the whole charter of
/// this crate is that a JSON fixture drives it. So the machine is handed in,
/// both readings of one recorded answer are asserted from one host, and
/// [`Machine::host`] is offered to callers and called nowhere below.
///
/// **Three variants, where that crate has two.** Its doc refuses a third
/// because macOS and Linux differ nowhere in argv construction — true there,
/// false here: `platform:macos` and `platform:linux` are two labels an operator
/// types, so this crate *can* point at the difference. No dependency edge is
/// added in either direction.
///
/// **Named `Machine` and not `Platform`**, because `crates/app` already imports
/// `perseverance_agent::Platform` and calls `Platform::host()` at six sites.
/// Two differently-shaped types under one name in one file is how the wrong one
/// gets passed. The label family stays spelled `platform:`, which is what an
/// operator types; the type is named for what it is a fact about.
///
/// No serde and no `ts-rs`: this never crosses the seam. What crosses is the
/// verdict — [`Node::bound_elsewhere`] — and the WebView has no business
/// knowing which machine it was taken against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Machine {
    Windows,
    MacOs,
    Linux,
}

impl Machine {
    /// The machine this build is really running on.
    ///
    /// The only place a `cfg!` is spoken in this crate, and it is spoken for
    /// callers rather than inside the derivation. `cfg!` rather than `#[cfg]`
    /// so the branches this build is not are still type-checked.
    pub const fn host() -> Machine {
        if cfg!(windows) {
            Machine::Windows
        } else if cfg!(target_os = "macos") {
            Machine::MacOs
        } else {
            Machine::Linux
        }
    }

    /// One spelling each, and no alias list.
    ///
    /// `win`, `osx`, `darwin` and `mac` are all things somebody might type, and
    /// accepting them would be this file guessing at a vocabulary nobody
    /// published. An unrecognised value is a machine that is not this one — see
    /// [`bound_elsewhere`].
    ///
    /// Case is not part of the spelling: the value arrives already folded, and
    /// [`bound_elsewhere`] is where and why.
    fn named(value: &str) -> Option<Machine> {
        match value {
            "windows" => Some(Machine::Windows),
            "macos" => Some(Machine::MacOs),
            "linux" => Some(Machine::Linux),
            _ => None,
        }
    }
}

/// Whether this child's labels say the work belongs on a machine that is not
/// this one.
///
/// One loop over every `platform:` label, in the shape [`ChildKind::of`]
/// already established, and three rules fall out of the one expression:
///
/// - **No `platform:` label at all is every machine.** A ticket with nothing to
///   say about machines is offered everywhere; the spec's own wording is
///   *whose `platform:*` label (if any) matches*.
/// - **Two of them are a union and not a conflict.** This is where the rule
///   parts company with [`ChildKind::of`], which refuses rather than chooses:
///   there, two classifications are two mutually exclusive readings and picking
///   one would be this app deciding what the operator meant. Here
///   `platform:windows` beside `platform:macos` has one plain reading — either
///   machine will do — so there is nothing to refuse. A repeated label is one
///   statement, as before.
/// - **An unrecognised value fails closed.** `platform:solaris`, or a typo'd
///   `platform:win`, is a machine that is not this one, so the ticket is held
///   back. [`ChildKind::of`] fails *open* on an unknown `wayfinder:` suffix
///   because the consequence there is `Unclassified`, which is itself the safe
///   answer; failing open here would launch an agent on a machine the operator
///   said the work cannot be done on. Held back, the ticket still renders,
///   still counts, and is fixed by editing a label.
///
/// **Case is folded before either half is matched**, which is the one thing here
/// that is not simply the shape [`ChildKind::of`] set. It has to be, because the
/// two halves fail in opposite directions. An unrecognised *value* fails closed,
/// so `platform:MacOS` read literally would only be over-cautious — but an
/// unrecognised *prefix* fails **open**: `Platform:macos` matched
/// case-sensitively is not a platform label at all, `named` stays false, and the
/// ticket is offered on every machine, which is exactly the outcome the rule
/// above exists to prevent. Folding is also what GitHub itself does — label
/// names are unique case-insensitively, so `Platform:macos` and `platform:macos`
/// cannot both exist on one repository and treating them as two things would be
/// this file inventing a distinction its source does not have. The same argument
/// does not reach [`ChildKind::of`]: an unrecognised `wayfinder:` prefix leaves
/// the child `Unclassified`, which `is_takeable` refuses, so that one fails
/// closed in both halves and is left alone.
///
/// It reads only the labels the answer carried. A label list GitHub cut off
/// short is not one of them — see [`crate::Truncation::labels`], which is the
/// tripwire that says so, because a `platform:` label past the end of the page
/// is indistinguishable here from a ticket that never had one.
fn bound_elsewhere(labels: &[String], machine: Machine) -> bool {
    let mut named = false;
    let mut matched = false;

    for label in labels {
        let folded = label.to_ascii_lowercase();
        let Some(rest) = folded.strip_prefix(PLATFORM_PREFIX) else {
            continue;
        };
        named = true;
        if Machine::named(rest) == Some(machine) {
            matched = true;
        }
    }

    named && !matched
}

/// The derived model for one tick, whole.
///
/// `PartialEq` is the point of this type: **changed means `new.model !=
/// old.model`**, structural equality over the whole of it. No hash, no
/// fingerprint and no chosen field set — a shortlist is a field added later,
/// forgotten, and the graph going quietly wrong with nothing on screen to say
/// so.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// `None` is *no map open* — an absence, never an empty map. The chrome
    /// exists before it holds anything, and a map with no tickets in it is a
    /// different fact again (see [`Phase::Unstarted`]).
    pub map: Option<Map>,
}

/// One map, derived.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Map {
    pub number: u64,
    pub title: String,
    /// The map's own state, carried because it is the top rung of the ladder
    /// and no ticket can put the map on it.
    pub closed: bool,
    pub phase: Phase,
    pub counts: Counts,
    /// **Sub-issue order.** The operator dragged these into this order in
    /// GitHub's own UI, so it is their order and this app never re-sorts it —
    /// not by number, and emphatically not by a ranking of its own. A frontier
    /// picked by a ranking is a frontier the graph on screen cannot justify.
    pub nodes: Vec<Node>,
    /// What this map has to say about *what next* — see [`Frontier`].
    pub frontier: Frontier,
    /// What this map says nobody has specified yet — see [`Fog`].
    ///
    /// Only the section, never the body it was cut from. The map document also
    /// holds Notes and Decisions-so-far, and model equality is the diff unit
    /// (see [`Model`]), so carrying the whole body here would make every
    /// keystroke in an unrelated section a change on screen.
    pub fog: Fog,
}

/// The designated frontier, in the only three readings there are.
///
/// **An enum and not `Option<u64>` beside a flag.** The absence has always been
/// "a state with its own reading and not a zero", and there are two of those
/// readings rather than one: a map with work left on it that this machine
/// cannot start is a different fact from a map with nothing left at all. Two
/// fields would be two things that can disagree — the argument [`Counts`] makes
/// against a fourth number — and the WebView would have to decide *which
/// reading applies* from a conjunction, which is resolving, which is the one
/// thing that side may not do.
///
/// Adjacently tagged, with a payload on one variant and none on the others,
/// which is [`ChildKind`]'s existing shape on the wire.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "frontier", content = "number", rename_all = "camelCase")]
pub enum Frontier {
    /// The number of the first node in map order that [`Node::is_takeable`]
    /// admits.
    Designated(u64),
    /// Nothing is takeable here, and work this machine cannot do is why. The
    /// tickets are still on the map, still counted, and still rendered — they
    /// are only not offered.
    ///
    /// It carries no payload. Not the machine, which never crosses the seam,
    /// and not the numbers held back, because every row already carries
    /// [`Node::bound_elsewhere`] and a list here would be a second copy of that
    /// which can disagree with it.
    NotOnThisMachine,
    /// Nothing on this map can be started by anybody, on any machine.
    NothingToStart,
}

impl Frontier {
    /// **The frontier resolver, and there is only this one.**
    ///
    /// First in map order, and *first* is the whole of it. Nothing scores,
    /// ranks, or prefers the ticket that unblocks the most: the order is the
    /// operator's and the harness never invents one.
    ///
    /// The second arm is what makes an empty frontier legible. It asks for work
    /// that would be startable but for the machine — not merely for a node
    /// carrying a `platform:` label — so a *blocked* ticket labelled for this
    /// very machine cannot make a map read as *nothing for this machine*.
    pub(crate) fn of(nodes: &[Node]) -> Frontier {
        match nodes.iter().find(|node| node.is_takeable()) {
            Some(node) => Frontier::Designated(node.number),
            None if nodes
                .iter()
                .any(|node| node.bound_elsewhere && node.is_startable_work()) =>
            {
                Frontier::NotOnThisMachine
            }
            None => Frontier::NothingToStart,
        }
    }
}

/// The literal heading the fog is found under, and the whole of what is
/// matched.
///
/// A string compared against a line, and never a pattern, a synonym list or a
/// fuzzy match. The map document is written by an agent session against a
/// convention, so *the heading is spelled this way or there is no fog section*
/// is a fact and not a guess — and a parser that accepted `## Unspecified` too
/// would be this crate deciding what an operator meant.
pub const FOG_HEADING: &str = "## Not yet specified";

/// The known unknowns, in the only two readings there are.
///
/// **An enum and not `Option<usize>`**, for the reason [`Frontier`] is one:
/// *nobody surveyed* and *somebody surveyed and found nothing* are different
/// facts about the same map, and a count is capable of expressing only the
/// second. A map whose body never names the fog has not declared that
/// everything is charted — it has said nothing at all, and `0` in that slot is
/// the harness inventing a claim on the operator's behalf.
///
/// Adjacently tagged, with a payload on one variant and none on the other,
/// which is [`Frontier`]'s and [`ChildKind`]'s existing shape on the wire.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "fog", content = "region", rename_all = "camelCase")]
pub enum Fog {
    /// No [`FOG_HEADING`] line anywhere in the map's body. Nobody has been
    /// here, and what stands in the count's place on screen is `—`.
    Unsurveyed,
    /// The heading is there, and what is under it — including nothing.
    Surveyed(FogRegion),
}

/// One surveyed fog region: how many things are named in it, and the words they
/// are named in.
///
/// Both, and never only the count. The fog is the one region of the map with no
/// identity of its own — no number, no title, no URL — so a bare count is a
/// smudge an operator cannot act on, and the words are the whole of what makes
/// it somewhere to go.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FogRegion {
    /// Top-level bullets under the heading, counted and never interpreted. A
    /// nested bullet is a detail of the thing above it rather than a second
    /// thing nobody specified, so the count is of lines that begin at column
    /// zero and nothing else.
    pub count: usize,
    /// **The section, verbatim.**
    ///
    /// The parse chooses boundaries; it never edits content. Every line between
    /// the heading and the next one survives with its indentation, its bullet
    /// marker and its blank lines intact, rejoined with `\n`. Blank lines at
    /// the two ends are outside the boundary rather than trimmed off the inside
    /// — a distinction worth keeping, because *nothing is modified* is a claim
    /// a renderer can rely on and *almost nothing is modified* is not.
    pub text: String,
}

/// Whether a line opens an ATX heading — the only boundary this parse knows.
///
/// One to six `#` at column zero, then a space or the end of the line. There is
/// no fence tracking and no markdown grammar behind it: a `#` at column zero
/// inside a fenced code block ends the region, and that is the correct trade
/// for a scan asked to be structural rather than semantic — fence tracking is
/// the first step to a markdown grammar in a crate whose charter is a boring
/// dependency tree. Setext headings are not a boundary either, because the
/// convention this reads writes ATX.
fn opens_a_heading(line: &str) -> bool {
    let hashes = line.len() - line.trim_start_matches('#').len();
    (1..=6).contains(&hashes) && matches!(line.as_bytes().get(hashes), None | Some(b' '))
}

/// Whether a line is a bullet nobody nested. Column zero, one marker, one
/// space.
fn opens_a_top_level_bullet(line: &str) -> bool {
    line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ ")
}

impl Fog {
    /// **The whole of the fog parse, and it is a line scan.**
    ///
    /// Find the one line that is [`FOG_HEADING`], take the lines up to the next
    /// heading, count the ones that start a top-level bullet, and carry the
    /// rest of them across unchanged. Nothing here reads a word.
    pub(crate) fn of(body: &str) -> Fog {
        // `str::lines` strips a trailing `\r`, so a CRLF document and an LF one
        // parse identically: a line terminator is a delimiter and not content.
        let lines: Vec<&str> = body.lines().collect();

        // `trim_end` and nothing more: trailing spaces on a heading line are
        // invisible in every editor, and refusing a section over one would be a
        // fog that vanishes for a reason nobody can see. Everything else about
        // the match is exact, case included.
        let Some(heading) = lines.iter().position(|line| line.trim_end() == FOG_HEADING) else {
            return Fog::Unsurveyed;
        };

        let after = &lines[heading + 1..];
        let end = after
            .iter()
            .position(|line| opens_a_heading(line))
            .unwrap_or(after.len());
        let region = &after[..end];

        // The boundary, moved past the blank lines at each end. A section is
        // always written with a blank line under its heading, and rendering it
        // as an empty first row would be the document's punctuation on screen.
        let region = match region.iter().position(|line| !line.trim().is_empty()) {
            None => &region[..0],
            Some(first) => {
                let last = region
                    .iter()
                    .rposition(|line| !line.trim().is_empty())
                    .unwrap_or(first);
                &region[first..=last]
            }
        };

        Fog::Surveyed(FogRegion {
            count: region
                .iter()
                .filter(|line| opens_a_top_level_bullet(line))
                .count(),
            text: region.join("\n"),
        })
    }
}

/// One child of the map, derived.
///
/// What is *not* here is as deliberate as what is: no blocker count, no
/// assignee list, no `updatedAt`. The first two are the inputs to a decision
/// already made, and re-exporting them is how a second frontier resolver gets
/// written by accident; the third is a timestamp, and this model reads none.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub kind: ChildKind,
    pub state: NodeState,
    /// What this one waits on, by number, in the order the answer listed them.
    /// The graph's edges, and the only adjacency that crosses.
    ///
    /// Adjacency is not one of the inputs above and cannot be turned back into
    /// one. A node's state is decided from GitHub's count of the blockers still
    /// in the way, which stays behind; these numbers are *every* blocker the
    /// answer named, finished ones included, and one of them may be an issue
    /// that is not a child of this map and so has no state on this side at all.
    /// A second state resolver written from these would be wrong in both
    /// directions, which is the reason the count it would need is still absent.
    ///
    /// It crosses as edges rather than as a count of what each node opens up,
    /// because a rank is *how far along* and there is no way to compute one
    /// from a number.
    pub waits_on: Vec<u64>,
    /// Labelled for a machine that is not this one.
    ///
    /// **A verdict and not an input.** The labels themselves still do not cross
    /// the seam, for the reason the blocker count and the assignee list do not:
    /// what crosses is already decided, so there is nothing here for a second
    /// resolver to be written from. This is the same kind of value `kind` and
    /// `state` are — a conclusion drawn from labels and counts that stayed
    /// behind.
    ///
    /// It is on the node rather than only on the map because *not offered* has
    /// to be legible on the row an operator is looking at, and because
    /// [`Frontier::of`] needs it per node to tell *nothing for this machine*
    /// from *nothing left at all*.
    pub bound_elsewhere: bool,
}

impl Node {
    fn of(child: &ChildRead, machine: Machine) -> Node {
        Node {
            number: child.number,
            title: child.title.clone(),
            url: child.url.clone(),
            kind: ChildKind::of(&child.labels),
            state: NodeState::of(child),
            waits_on: child.waits_on.clone(),
            bound_elsewhere: bound_elsewhere(&child.labels, machine),
        }
    }

    /// Whether an agent may be launched at this node — the whole of frontier
    /// eligibility, spelled once.
    ///
    /// Three conditions. The first is the one the four states cannot express on
    /// their own: a child has to be a **ticket**. Without that clause a spec
    /// child that is open, unblocked and unassigned satisfies every state
    /// predicate there is, and *Start Working* launches an agent at the
    /// destination. An unclassified child is refused for the same reason from
    /// the other direction: a stray issue dragged onto the map fails safe
    /// rather than being silently reinterpreted as a task.
    ///
    /// The third is the machine, and it is last because it is the only one that
    /// is about the operator's hardware rather than about the work. A ticket it
    /// refuses is still a ticket, still open and still counted — see
    /// [`Node::bound_elsewhere`].
    pub fn is_takeable(&self) -> bool {
        self.is_startable_work() && !self.bound_elsewhere
    }

    /// The two clauses that are about the *work* rather than about the machine.
    ///
    /// Private, and it exists so that [`Frontier::of`]'s second arm and
    /// [`Node::is_takeable`] cannot drift: *would be startable but for the
    /// machine* is `is_startable_work() && bound_elsewhere`, which is only a
    /// true sentence while this is the exact complement of the last clause
    /// above.
    fn is_startable_work(&self) -> bool {
        self.kind.is_ticket() && self.state == NodeState::Takeable
    }
}

/// The four states, and there is no fifth.
///
/// The precedence is strict and top-down — **closed beats blocked beats
/// claimed** — which is why a closed ticket with an open blocker reads as
/// resolved rather than as blocked. Work that is finished is finished; that
/// something still points at it is a fact about the blocker.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeState {
    /// `state == CLOSED`.
    Resolved,
    /// Open, and something open is in its way.
    Blocked,
    /// Open, unblocked, and somebody holds it.
    ///
    /// *Claimed by me* is deliberately not a state. Every run assigns the same
    /// login, so identity cannot tell one claim from another; the distinction
    /// the UI eventually needs is claimed-with-a-live-session versus
    /// claimed-with-none, and that is liveness, which arrives with the sessions
    /// that make it observable.
    Claimed,
    /// Open, unblocked, unclaimed. Necessary for the frontier and not
    /// sufficient — see [`Node::is_takeable`].
    Takeable,
}

impl NodeState {
    fn of(child: &ChildRead) -> NodeState {
        if child.closed {
            NodeState::Resolved
        } else if child.blocked_by > 0 {
            // GitHub counts *open* blockers here, so this single comparison is
            // the entire unblocked test.
            NodeState::Blocked
        } else if child.assignees > 0 {
            NodeState::Claimed
        } else {
            NodeState::Takeable
        }
    }
}

/// The three categories a child of a map can fall into.
///
/// The third row is the one that is easy to leave out and expensive to have
/// left out: without it every child is either a ticket or a spec, and a child
/// that is neither becomes whichever of the two the code happened to default
/// to. Both defaults are wrong in a way an operator cannot see.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "type", rename_all = "camelCase")]
pub enum ChildKind {
    /// Frontier-eligible, and counted.
    Ticket(TicketType),
    /// The destination. Never the frontier, and never counted — a spec among
    /// the tickets would make the map look one ticket further from done than
    /// it is.
    Spec,
    /// Anything else. Rendered as needing attention, and unspawnable.
    Unclassified,
}

impl ChildKind {
    /// One rule, applied to every `wayfinder:` label the child carries:
    /// **exactly one recognised classification, or unclassified.**
    ///
    /// The awkward case the rule exists for is a child carrying two of them —
    /// `wayfinder:task` beside `wayfinder:spec`, say. Picking one would be this
    /// app deciding which of two things the operator meant, and the two
    /// available answers are *launch an agent at the spec* and *hide a ticket
    /// from the frontier*. Refusing to choose puts it on screen as
    /// unclassified, where a person can fix the label in the place labels live.
    ///
    /// A repeated label is not a conflict: GitHub cannot apply the same label
    /// twice, but a response that listed one twice is still saying one thing.
    fn of(labels: &[String]) -> ChildKind {
        let mut named: Option<ChildKind> = None;

        for label in labels {
            let Some(rest) = label.strip_prefix(WAYFINDER_PREFIX) else {
                continue;
            };
            let recognised = match rest {
                "research" => ChildKind::Ticket(TicketType::Research),
                "prototype" => ChildKind::Ticket(TicketType::Prototype),
                "grilling" => ChildKind::Ticket(TicketType::Grilling),
                "task" => ChildKind::Ticket(TicketType::Task),
                "spec" => ChildKind::Spec,
                // `wayfinder:map` on a child, or a type this build has never
                // heard of. Neither is a classification, and neither is an
                // error worth stopping the map for.
                _ => continue,
            };

            match named {
                None => named = Some(recognised),
                Some(already) if already == recognised => {}
                Some(_) => return ChildKind::Unclassified,
            }
        }

        named.unwrap_or(ChildKind::Unclassified)
    }

    fn is_ticket(self) -> bool {
        matches!(self, ChildKind::Ticket(_))
    }
}

/// The kinds of work a ticket can be, as `/to-issues` labels them.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketType {
    Research,
    Prototype,
    Grilling,
    Task,
}

/// Three counts, and the ladder is built from them.
///
/// *Resolved* is not a fourth field: it is `tickets - open`, and a fourth
/// number is a fourth thing that can disagree with the other three.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    /// Ticket-classified children. The spec is not one, and neither is an
    /// unclassified child — counting either would put a number on screen the
    /// frontier can never work through.
    pub tickets: usize,
    /// Ticket-classified children still open.
    pub open: usize,
    /// Children labelled `wayfinder:spec`. Plural on purpose: more than one is
    /// a state the map can be in and a thing an operator has to be able to see,
    /// not an invariant this file gets to assume.
    pub specs: usize,
}

/// Where the map is in the loop, derived rather than stored.
///
/// Stored, it could disagree with the tickets. Derived, it cannot — which is
/// the whole reason this is a function of the counts and not a field somebody
/// maintains.
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "model.generated.ts"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// The map itself is closed.
    Done,
    /// No tickets and no spec: nothing has been charted yet.
    Unstarted,
    /// Tickets are still open. **Beats `Specced` deliberately.**
    Wayfinding,
    /// Every ticket is closed and a spec exists.
    Specced,
    /// Every ticket is closed and no spec exists yet.
    SpecReady,
}

impl Phase {
    /// The ladder, strict and top-down. The order of these clauses *is* the
    /// rule, which is why they are five `if`s in one function rather than five
    /// predicates scattered over a file.
    ///
    /// `Wayfinding` above `Specced` is the clause worth defending: a spec
    /// existing while the map has open tickets means the map **reopened** —
    /// somebody charted more work after composing. So `specced` is not sticky.
    /// A ladder that made it sticky would show a map as finished while an
    /// operator was still working it.
    fn of(map_closed: bool, counts: &Counts) -> Phase {
        if map_closed {
            Phase::Done
        } else if counts.tickets == 0 && counts.specs == 0 {
            Phase::Unstarted
        } else if counts.open > 0 {
            Phase::Wayfinding
        } else if counts.specs >= 1 {
            Phase::Specced
        } else {
            Phase::SpecReady
        }
    }
}

impl Map {
    fn of(graph: &MapGraph, machine: Machine) -> Map {
        // Every child, in the operator's own order. Nothing is filtered out of
        // the model here and nothing ever may be: a ticket this machine cannot
        // start is a ticket that is on the map.
        let nodes: Vec<Node> = graph
            .children
            .iter()
            .map(|child| Node::of(child, machine))
            .collect();

        // **The machine is deliberately absent from all three of these.** A
        // ticket bound elsewhere is still ticket-classified and still open, so
        // it is still counted — otherwise the map would look one ticket closer
        // to done on whichever machine happens to be reading it.
        let counts = Counts {
            tickets: nodes.iter().filter(|node| node.kind.is_ticket()).count(),
            open: nodes
                .iter()
                .filter(|node| node.kind.is_ticket() && node.state != NodeState::Resolved)
                .count(),
            specs: nodes
                .iter()
                .filter(|node| node.kind == ChildKind::Spec)
                .count(),
        };

        Map {
            number: graph.number,
            title: graph.title.clone(),
            closed: graph.closed,
            phase: Phase::of(graph.closed, &counts),
            frontier: Frontier::of(&nodes),
            counts,
            nodes,
            fog: Fog::of(&graph.body),
        }
    }
}

impl Model {
    /// The state the app opens in: chrome, and no map behind it.
    pub fn no_map_open() -> Model {
        Model { map: None }
    }

    /// One parsed answer, derived for one machine. The whole of the derivation
    /// is reachable from here and from nowhere else.
    ///
    /// `machine` is a parameter and never [`Machine::host`] taken inside: two
    /// readings of one recorded answer have to be assertable from one runner,
    /// which is what keeps the platform clause fixture-driven like everything
    /// else here. Callers that mean *this machine* say so at the call site.
    pub fn of(read: &MapRead, machine: Machine) -> Model {
        Model {
            map: read.map.as_ref().map(|graph| Map::of(graph, machine)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::read_response;

    const TWO_MAPS: &str = include_str!("../fixtures/two-maps-one-open.json");
    const AWKWARD: &str = include_str!("../fixtures/awkward-children.json");
    const EMPTY_MAP: &str = include_str!("../fixtures/empty-map.json");
    const SPEC_COMPOSED: &str = include_str!("../fixtures/spec-composed.json");
    const MAP_CLOSED: &str = include_str!("../fixtures/map-closed.json");
    const NO_MAP: &str = include_str!("../fixtures/no-map-in-this-repo.json");
    const PLATFORM_BOUND: &str = include_str!("../fixtures/platform-bound.json");
    const FOG_UNSURVEYED: &str = include_str!("../fixtures/fog-unsurveyed.json");
    const FOG_EMPTY: &str = include_str!("../fixtures/fog-empty.json");
    const FOG_CHARTED: &str = include_str!("../fixtures/fog-charted.json");

    /// The machine every test that is not *about* machines derives for.
    ///
    /// Named rather than [`Machine::host`], so that this whole module answers
    /// the same on every runner — a suite whose expectations moved with the
    /// developer's laptop would be a suite nobody could read a failure out of.
    /// The choice cannot show in any answer but `platform-bound.json`, and
    /// `every_recorded_answer_but_the_bound_one_derives_the_same_on_every_machine`
    /// is what makes that an assertion over the whole fixture directory rather
    /// than a sentence somebody wrote once.
    const ANY_MACHINE: Machine = Machine::Windows;

    /// All three, in the order the guards above compare them in.
    const EVERY_MACHINE: [Machine; 3] = [Machine::Windows, Machine::MacOs, Machine::Linux];

    fn model_of(body: &str) -> Model {
        model_for(body, ANY_MACHINE)
    }

    fn model_for(body: &str, machine: Machine) -> Model {
        Model::of(&read_response(body).expect("reads"), machine)
    }

    fn map_of(body: &str) -> Map {
        model_of(body).map.expect("a map")
    }

    fn map_for(body: &str, machine: Machine) -> Map {
        model_for(body, machine).map.expect("a map")
    }

    fn node(map: &Map, number: u64) -> &Node {
        map.nodes
            .iter()
            .find(|node| node.number == number)
            .unwrap_or_else(|| panic!("no node {number} on this map"))
    }

    /* ------------------------------------------------------------ states --- */

    #[test]
    fn a_closed_child_is_resolved_whatever_else_is_true_of_it() {
        let map = map_of(AWKWARD);

        // Closed, and something open still points at it. Closed wins: the work
        // is finished, and that a blocker outlived it is the blocker's problem.
        let closed_but_blocked = node(&map, 71);
        assert_eq!(closed_but_blocked.state, NodeState::Resolved);
    }

    #[test]
    fn an_open_child_with_an_open_blocker_is_blocked_rather_than_claimed() {
        let map = map_of(AWKWARD);

        // Blocked *and* assigned. Blocked wins, because starting it is not
        // available to whoever holds it either.
        assert_eq!(node(&map, 72).state, NodeState::Blocked);
    }

    #[test]
    fn an_open_unblocked_child_somebody_holds_is_claimed() {
        assert_eq!(node(&map_of(AWKWARD), 77).state, NodeState::Claimed);
    }

    #[test]
    fn an_open_unblocked_unheld_child_is_takeable() {
        assert_eq!(node(&map_of(TWO_MAPS), 32).state, NodeState::Takeable);
    }

    #[test]
    fn a_blocker_that_has_since_closed_does_not_go_on_blocking() {
        // #32's one blocker is closed, and `totalBlockedBy` still says two.
        // Reading the total rather than the open count would leave a ticket
        // that is ready to start sitting on screen as blocked forever.
        assert_eq!(node(&map_of(TWO_MAPS), 32).state, NodeState::Takeable);
    }

    /* ---------------------------------------------------- classification --- */

    #[test]
    fn each_recognised_wayfinder_type_is_a_ticket() {
        let types = [
            ("wayfinder:research", TicketType::Research),
            ("wayfinder:prototype", TicketType::Prototype),
            ("wayfinder:grilling", TicketType::Grilling),
            ("wayfinder:task", TicketType::Task),
        ];

        for (label, expected) in types {
            assert_eq!(
                ChildKind::of(&[label.to_string()]),
                ChildKind::Ticket(expected)
            );
        }
    }

    #[test]
    fn a_child_carrying_no_wayfinder_label_at_all_is_unclassified() {
        let map = map_of(AWKWARD);

        assert_eq!(node(&map, 70).kind, ChildKind::Unclassified);
        // A stray issue dragged onto the map. Every state predicate says
        // takeable, and it is still not the frontier — which is the whole
        // point of the third category.
        assert_eq!(node(&map, 70).state, NodeState::Takeable);
        assert!(!node(&map, 70).is_takeable());
    }

    #[test]
    fn a_repository_label_that_is_not_ours_never_classifies_anything() {
        assert_eq!(
            ChildKind::of(&["bug".to_string(), "priority:high".to_string()]),
            ChildKind::Unclassified
        );
        // Ours by prefix, and still not a classification this build knows.
        assert_eq!(
            ChildKind::of(&["wayfinder:map".to_string()]),
            ChildKind::Unclassified
        );
        assert_eq!(
            ChildKind::of(&["wayfinder:pondering".to_string()]),
            ChildKind::Unclassified
        );
    }

    #[test]
    fn a_child_labelled_two_different_things_is_refused_rather_than_chosen_between() {
        // The two available answers are *launch an agent at the spec* and
        // *hide a ticket from the frontier*, and this app is not entitled to
        // pick either on the operator's behalf.
        assert_eq!(
            ChildKind::of(&["wayfinder:task".to_string(), "wayfinder:spec".to_string()]),
            ChildKind::Unclassified
        );
        assert_eq!(
            ChildKind::of(&[
                "wayfinder:research".to_string(),
                "wayfinder:task".to_string()
            ]),
            ChildKind::Unclassified
        );
        // The same thing said twice is still one thing.
        assert_eq!(
            ChildKind::of(&["wayfinder:task".to_string(), "wayfinder:task".to_string()]),
            ChildKind::Ticket(TicketType::Task)
        );
    }

    /* -------------------------------------------------------- the frontier --- */

    #[test]
    fn the_frontier_is_the_first_takeable_ticket_in_map_order() {
        let map = map_of(AWKWARD);

        // Everything before #75 in the operator's own order is disqualified,
        // and each by a different clause: #70 is unclassified, #71 is resolved,
        // #73 and #74 are specs, #72 is blocked, #77 is claimed. The frontier
        // is the first thing left, and #76 proves *first* is not *only*.
        assert_eq!(map.frontier, Frontier::Designated(75));
    }

    #[test]
    fn the_frontier_is_never_the_spec_even_when_the_spec_would_otherwise_be_takeable() {
        let map = map_of(AWKWARD);

        let spec = node(&map, 73);
        assert_eq!(spec.kind, ChildKind::Spec);
        assert_eq!(spec.state, NodeState::Takeable);
        assert!(!spec.is_takeable());
        assert_ne!(map.frontier, Frontier::Designated(73));
    }

    #[test]
    fn a_map_with_nothing_startable_on_it_has_no_frontier_rather_than_a_first_row() {
        let map = map_of(SPEC_COMPOSED);

        // Every ticket is closed. *Nothing to start* is a state with its own
        // reading, and pointing at row one would be inventing a target.
        assert_eq!(map.frontier, Frontier::NothingToStart);
    }

    #[test]
    fn nothing_re_orders_the_children_on_the_way_through() {
        let map = map_of(AWKWARD);

        let numbers: Vec<u64> = map.nodes.iter().map(|node| node.number).collect();
        // Ascending, then back down, then up again: any sort at all would show
        // here, and the numbers are chosen so that a number sort and the
        // operator's order cannot be confused for one another.
        assert_eq!(numbers, vec![70, 71, 73, 74, 72, 77, 75, 76]);
    }

    /* --------------------------------------------- work bound to a machine --- */

    #[test]
    fn a_ticket_labelled_for_another_machine_is_not_offered_here() {
        // One recorded answer, two machines, two readings. #81 and #82 can only
        // be gathered on a Mac, so on Windows there is nothing to offer at all
        // — and on the Mac the frontier is the first of them.
        assert_eq!(
            map_for(PLATFORM_BOUND, Machine::Windows).frontier,
            Frontier::NotOnThisMachine
        );
        assert_eq!(
            map_for(PLATFORM_BOUND, Machine::MacOs).frontier,
            Frontier::Designated(81)
        );
    }

    #[test]
    fn a_ticket_labelled_for_another_machine_still_has_a_row_and_is_still_counted() {
        let here = map_for(PLATFORM_BOUND, Machine::Windows);
        let there = map_for(PLATFORM_BOUND, Machine::MacOs);

        // Five rows and four tickets, on the machine that will not be offered
        // any of them. Filtering the model by machine would make the map look
        // closer to done on whichever host happened to be reading it.
        assert_eq!(here.nodes.len(), 5);
        assert_eq!(
            here.counts,
            Counts {
                tickets: 4,
                open: 4,
                specs: 1
            }
        );

        for number in [80, 81, 82] {
            let held_back = node(&here, number);
            assert_eq!(held_back.kind, ChildKind::Ticket(TicketType::Task));
            // Still takeable: the state is what GitHub decided, and the machine
            // is a different question asked afterwards.
            assert_eq!(held_back.state, NodeState::Takeable);
            assert!(held_back.bound_elsewhere, "#{number}");
            assert!(!held_back.is_takeable(), "#{number}");
        }

        // And the counts are the same number on both machines, which is the
        // whole of *still counted*.
        assert_eq!(here.counts, there.counts);
        assert_eq!(here.nodes.len(), there.nodes.len());
    }

    #[test]
    fn the_machine_is_the_last_clause_and_never_a_re_ordering() {
        let map = map_for(PLATFORM_BOUND, Machine::MacOs);

        let numbers: Vec<u64> = map.nodes.iter().map(|node| node.number).collect();
        assert_eq!(numbers, vec![80, 81, 82, 83, 84]);
        // #80 is skipped past rather than moved: it keeps its slot at the top
        // of the map and the frontier is simply the next thing this machine can
        // start.
        assert!(node(&map, 80).bound_elsewhere);
        assert_eq!(map.frontier, Frontier::Designated(81));
    }

    #[test]
    fn nothing_for_this_machine_is_not_the_same_answer_as_nothing_left_at_all() {
        let bound = map_for(PLATFORM_BOUND, Machine::Windows).frontier;

        // A map with work left on it that this machine cannot start, and two
        // maps with nothing left for anybody. One `None` for all three is what
        // would make the first read as the second.
        assert_eq!(bound, Frontier::NotOnThisMachine);
        assert_eq!(map_of(SPEC_COMPOSED).frontier, Frontier::NothingToStart);
        assert_eq!(map_of(EMPTY_MAP).frontier, Frontier::NothingToStart);
        assert_ne!(bound, Frontier::NothingToStart);
    }

    #[test]
    fn a_blocked_ticket_for_this_machine_does_not_make_the_map_read_as_startable() {
        let map = map_for(PLATFORM_BOUND, Machine::Windows);

        // #83 is labelled for this very machine and is blocked. The reading is
        // still *nothing for this machine*, because the alternative — asking
        // whether any node carries a `platform:` label naming us — would answer
        // *nothing to start* on a map whose only obstacle is the machine.
        let ours = node(&map, 83);
        assert!(!ours.bound_elsewhere);
        assert_eq!(ours.state, NodeState::Blocked);
        assert_eq!(map.frontier, Frontier::NotOnThisMachine);
    }

    #[test]
    fn a_ticket_with_no_platform_label_is_offered_on_every_machine() {
        for machine in EVERY_MACHINE {
            let map = map_for(AWKWARD, machine);
            assert_eq!(map.frontier, Frontier::Designated(75), "{machine:?}");
            assert!(map.nodes.iter().all(|node| !node.bound_elsewhere));
        }
    }

    #[test]
    fn every_recorded_answer_but_the_bound_one_derives_the_same_on_every_machine() {
        /*
         * What lets the rest of this module name one machine and stop thinking
         * about it — and it is a walk of the directory rather than a list,
         * because a list is a thing a future fixture is added without. A
         * recorded answer that grew a `platform:` label would make this suite's
         * expectations move with whichever laptop ran it, and the failure would
         * arrive as an unrelated assertion somewhere else.
         *
         * `platform-bound.json` is the one exception and is asserted to be one:
         * a skip that is never checked is how a guard quietly comes to skip
         * everything.
         */
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let mut checked = 0;

        for entry in fs::read_dir(&directory).expect("the fixture directory") {
            let path = entry.expect("a directory entry").path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .expect("a file name")
                .to_string();
            let body = fs::read_to_string(&path).expect("a readable fixture");

            // The directory also holds serialised snapshots, which are not
            // answers and do not parse as one.
            let Ok(read) = read_response(&body) else {
                continue;
            };

            let derived: Vec<Model> = EVERY_MACHINE
                .iter()
                .map(|machine| Model::of(&read, *machine))
                .collect();

            if name == "platform-bound.json" {
                assert_ne!(derived[0], derived[1], "{name} is the machine-bound one");
                continue;
            }

            assert_eq!(derived[0], derived[1], "{name} on Windows versus macOS");
            assert_eq!(derived[1], derived[2], "{name} on macOS versus Linux");
            checked += 1;
        }

        // A walk that found nothing would pass every assertion above.
        assert!(checked >= 6, "only {checked} recorded answers were walked");
    }

    #[test]
    fn two_platform_labels_mean_either_machine_rather_than_a_conflict() {
        let both = ["platform:windows".to_string(), "platform:macos".to_string()];

        // Unlike two `wayfinder:` classifications, these are not two mutually
        // exclusive readings — *either machine will do* is the one plain
        // meaning — so there is nothing to refuse.
        assert!(!bound_elsewhere(&both, Machine::Windows));
        assert!(!bound_elsewhere(&both, Machine::MacOs));
        // And it is still a statement about machines, so a third one is out.
        assert!(bound_elsewhere(&both, Machine::Linux));

        // The same thing said twice is still one thing.
        let twice = [
            "platform:windows".to_string(),
            "platform:windows".to_string(),
        ];
        assert!(!bound_elsewhere(&twice, Machine::Windows));
        assert!(bound_elsewhere(&twice, Machine::MacOs));
    }

    #[test]
    fn an_unrecognised_platform_label_is_a_machine_that_is_not_this_one() {
        // Every rule in one table, over every machine, because the rules are a
        // single expression and five separate tests would be five chances to
        // check four of them.
        let cases: [(&[&str], [bool; 3]); 9] = [
            // Nothing to say about machines is every machine.
            (&[], [false, false, false]),
            (&["platform:windows"], [false, true, true]),
            (&["platform:macos"], [true, false, true]),
            // A machine this build has never heard of, and a typo. Both fail
            // *closed*: failing open would launch an agent on a machine the
            // operator said the work cannot be done on, and closed leaves the
            // ticket on screen, counted, and fixable by editing a label.
            (&["platform:solaris"], [true, true, true]),
            (&["platform:win"], [true, true, true]),
            // Case is not a spelling. The prefix is the half that matters most:
            // read case-sensitively, `Platform:macos` is not a platform label at
            // all, so it would fail *open* and be offered on Windows — the one
            // outcome every rule above is arranged against.
            (&["Platform:macos"], [true, false, true]),
            (&["PLATFORM:MACOS"], [true, false, true]),
            (&["platform:Windows"], [false, true, true]),
            // And an unrecognised value stays unrecognised however it is cased.
            (&["Platform:Win"], [true, true, true]),
        ];

        for (labels, expected) in cases {
            let owned: Vec<String> = labels.iter().map(|label| label.to_string()).collect();
            let got = [
                bound_elsewhere(&owned, Machine::Windows),
                bound_elsewhere(&owned, Machine::MacOs),
                bound_elsewhere(&owned, Machine::Linux),
            ];
            assert_eq!(got, expected, "{labels:?}");
        }
    }

    #[test]
    fn the_two_label_families_fold_case_differently_because_they_fail_differently() {
        // The platform prefix is folded, and this is the reason. Matched
        // literally, `Platform:macos` is not a platform label, `named` stays
        // false, and a ticket the operator bound to a Mac is offered — and
        // designated — on Windows.
        assert!(bound_elsewhere(
            &["Platform:macos".to_string()],
            Machine::Windows
        ));

        // The `wayfinder:` prefix is deliberately not folded, because the same
        // slip there lands on `Unclassified`, which `is_takeable` refuses. It
        // fails closed already, so folding it would be a behaviour change made
        // for symmetry rather than for safety.
        assert_eq!(
            ChildKind::of(&["Wayfinder:task".to_string()]),
            ChildKind::Unclassified
        );
    }

    #[test]
    fn a_platform_label_never_changes_what_a_child_is() {
        // Two label families, two questions. The machine is asked after the
        // classification and cannot disturb it — a ticket bound elsewhere is
        // still a task, and a `platform:` label on its own classifies nothing.
        assert_eq!(
            ChildKind::of(&["wayfinder:task".to_string(), "platform:macos".to_string()]),
            ChildKind::Ticket(TicketType::Task)
        );
        assert_eq!(
            ChildKind::of(&["platform:macos".to_string()]),
            ChildKind::Unclassified
        );
    }

    #[test]
    fn the_machine_a_model_is_derived_for_is_a_parameter_and_not_the_one_this_build_runs_on() {
        /*
         * One recorded answer, three machines, three *different* readings — and
         * that is the assertion, rather than the three variants being nameable.
         * Naming them proves nothing: `EVERY_MACHINE` is a list this module
         * wrote and `Machine::host()` returns one of its members by
         * construction.
         *
         * Three distinct answers cannot be produced by a derivation that asked
         * `cfg!(target_os)` inside itself. Such a derivation would ignore the
         * parameter and answer with the host's reading all three times, and this
         * test would fail on every runner — which is the direction its name
         * claims and the direction it now actually points.
         */
        let readings: Vec<(Machine, Frontier)> = EVERY_MACHINE
            .into_iter()
            .map(|machine| (machine, map_for(PLATFORM_BOUND, machine).frontier))
            .collect();

        assert_eq!(
            readings,
            vec![
                (Machine::Windows, Frontier::NotOnThisMachine),
                (Machine::MacOs, Frontier::Designated(81)),
                (Machine::Linux, Frontier::Designated(80)),
            ]
        );
    }

    /* ------------------------------------------------------------- edges --- */

    #[test]
    fn what_each_node_waits_on_crosses_beside_the_node_that_waits() {
        let map = map_of(AWKWARD);

        assert_eq!(node(&map, 72).waits_on, vec![75, 76]);
        assert!(node(&map, 70).waits_on.is_empty());
        // Nothing is in #75's way any more, and it is still one step in from
        // the start. The state answers *can I begin* and the edges answer *how
        // far along*, and neither is recoverable from the other.
        assert_eq!(node(&map, 75).state, NodeState::Takeable);
        assert_eq!(node(&map, 75).waits_on, vec![71]);
    }

    #[test]
    fn a_ticket_waiting_on_something_that_is_not_on_this_map_still_says_what() {
        let map = map_of(TWO_MAPS);

        // #30 is what #32 waited on, and it is not a child of this map. Filtered
        // out here, a rank drawn from it would rest on something the screen has
        // no row for and no way to admit to.
        assert_eq!(node(&map, 32).waits_on, vec![30]);
        assert!(!map.nodes.iter().any(|node| node.number == 30));
    }

    #[test]
    fn an_edge_that_moved_is_a_change_in_the_whole_model() {
        let before = map_of(AWKWARD);
        let after = {
            let mut map = before.clone();
            map.nodes[0].waits_on.push(76);
            map
        };

        assert_ne!(before, after);
    }

    /* ------------------------------------------------------------ counts --- */

    #[test]
    fn only_tickets_are_counted() {
        let map = map_of(AWKWARD);

        // Eight children: one unclassified, two specs, five tickets. The
        // unclassified one and the two specs are children an operator can see
        // and are not work the frontier will ever work through, which is why
        // *eight* and *five* are both on screen and neither is the other.
        assert_eq!(map.nodes.len(), 8);
        assert_eq!(map.counts.tickets, 5);
        assert_eq!(map.counts.specs, 2);
        // #71 is the closed one.
        assert_eq!(map.counts.open, 4);
    }

    #[test]
    fn more_than_one_spec_child_is_a_state_the_map_can_be_in_and_says_so() {
        assert_eq!(map_of(AWKWARD).counts.specs, 2);
    }

    /* ------------------------------------------------------------- phase --- */

    #[test]
    fn a_closed_map_is_done_whatever_its_tickets_say() {
        let map = map_of(MAP_CLOSED);

        assert!(map.closed);
        // It still has an open, takeable ticket on it. The map being closed is
        // the operator's own statement about the map, and it is above every
        // conclusion this file could draw from the children.
        assert!(map.counts.open > 0);
        assert_eq!(map.phase, Phase::Done);
    }

    #[test]
    fn a_map_with_nothing_charted_on_it_is_unstarted_rather_than_ready_for_a_spec() {
        let map = map_of(EMPTY_MAP);

        assert_eq!(map.nodes.len(), 0);
        assert_eq!(
            map.counts,
            Counts {
                tickets: 0,
                open: 0,
                specs: 0
            }
        );
        assert_eq!(map.phase, Phase::Unstarted);
        assert_eq!(map.frontier, Frontier::NothingToStart);
    }

    #[test]
    fn open_tickets_mean_wayfinding_even_when_a_spec_already_exists() {
        let map = map_of(AWKWARD);

        // A spec exists *and* tickets are open, which means the map reopened —
        // somebody charted more work after composing. `specced` is not sticky,
        // and a ladder that made it sticky would show this map as finished
        // while its operator was still working it.
        assert!(map.counts.specs >= 1);
        assert!(map.counts.open > 0);
        assert_eq!(map.phase, Phase::Wayfinding);
    }

    #[test]
    fn every_ticket_closed_with_a_spec_is_specced() {
        assert_eq!(map_of(SPEC_COMPOSED).phase, Phase::Specced);
    }

    #[test]
    fn every_ticket_closed_with_no_spec_is_ready_for_one() {
        let map = map_of(EMPTY_MAP);
        // The same fixture with its one closed ticket and no spec: the ladder
        // is a function of the counts, so this is the honest way to reach the
        // rung without a fixture whose only purpose is to reach it.
        assert_eq!(
            Phase::of(
                false,
                &Counts {
                    tickets: 3,
                    open: 0,
                    specs: 0
                }
            ),
            Phase::SpecReady
        );
        assert_eq!(map.phase, Phase::Unstarted);
    }

    #[test]
    fn the_ladder_is_read_top_down_and_the_order_is_the_rule() {
        // Every rung, in one table, so the precedence is visible as precedence
        // rather than as five tests that happen to disagree about which wins.
        let rungs = [
            (true, 0, 0, 0, Phase::Done),
            (true, 9, 9, 1, Phase::Done),
            (false, 0, 0, 0, Phase::Unstarted),
            (false, 0, 0, 1, Phase::Specced),
            (false, 3, 1, 0, Phase::Wayfinding),
            (false, 3, 1, 1, Phase::Wayfinding),
            (false, 3, 0, 1, Phase::Specced),
            (false, 3, 0, 0, Phase::SpecReady),
        ];

        for (closed, tickets, open, specs, expected) in rungs {
            let counts = Counts {
                tickets,
                open,
                specs,
            };
            assert_eq!(
                Phase::of(closed, &counts),
                expected,
                "closed={closed} {counts:?}"
            );
        }
    }

    /* --------------------------------------------------------------- fog --- */

    #[test]
    fn a_map_whose_body_never_names_the_fog_is_unsurveyed_rather_than_empty() {
        // The body is written — Notes, Decisions, and a bullet under one of
        // them. What it does not have is a survey, and `Surveyed { count: 0 }`
        // here would be this crate claiming somebody looked.
        assert_eq!(map_of(FOG_UNSURVEYED).fog, Fog::Unsurveyed);
    }

    #[test]
    fn a_map_with_no_body_at_all_is_unsurveyed() {
        assert_eq!(map_of(TWO_MAPS).fog, Fog::Unsurveyed);
        assert_eq!(map_of(EMPTY_MAP).fog, Fog::Unsurveyed);
    }

    #[test]
    fn a_fog_heading_with_nothing_under_it_is_a_survey_that_found_nothing() {
        assert_eq!(
            map_of(FOG_EMPTY).fog,
            Fog::Surveyed(FogRegion {
                count: 0,
                text: String::new()
            })
        );
    }

    #[test]
    fn the_fog_is_bounded_by_the_next_heading_and_counts_only_its_own_bullets() {
        let Fog::Surveyed(region) = map_of(FOG_CHARTED).fog else {
            panic!("the charted fixture was surveyed");
        };

        // Three, and not four: the bullet under *Decisions so far* is past the
        // boundary, and the indented one is a detail of the line above it.
        assert_eq!(region.count, 3);
        assert!(!region.text.contains("The Route is a grouped list"));
        assert!(!region.text.contains("## "));
    }

    #[test]
    fn the_fog_section_crosses_verbatim_down_to_the_blank_line_inside_it() {
        let Fog::Surveyed(region) = map_of(FOG_CHARTED).fog else {
            panic!("the charted fixture was surveyed");
        };

        assert_eq!(
            region.text,
            "- Whether the ledger survives a restart\n\
             - How the terminal splits\n\
             \u{20}\u{20}- and whether the split is remembered\n\
             - What happens to a map that is deleted mid-run\n\
             \n\
             Each of these needs a session with the operator."
        );
    }

    #[test]
    fn nothing_of_the_map_body_but_the_fog_reaches_the_derived_model() {
        // The Notes and the Decisions are in the answer and must not be in the
        // model: equality here is the diff unit, and a note taken during a
        // session would otherwise draw a change on every poll.
        let json = serde_json::to_string(&model_of(FOG_CHARTED)).expect("serialises");

        assert!(!json.contains("Charted on the second pass"));
        assert!(!json.contains("Decisions so far"));
        assert!(json.contains("Whether the ledger survives a restart"));
    }

    /* ------------------------------------------------------- no map open --- */

    #[test]
    fn a_repository_with_no_map_derives_an_absence_rather_than_an_empty_map() {
        // *Nobody charted one* and *a map with nothing on it* are different
        // facts, and they are different values here.
        assert_eq!(model_of(NO_MAP), Model::no_map_open());
        assert_ne!(model_of(EMPTY_MAP), Model::no_map_open());
    }

    /* --------------------------------------------------------- equality --- */

    #[test]
    fn the_same_answer_read_twice_derives_an_equal_model() {
        assert_eq!(model_of(AWKWARD), model_of(AWKWARD));
    }

    #[test]
    fn one_ticket_moving_state_is_a_change_in_the_whole_model() {
        let before = map_of(TWO_MAPS);
        let after = {
            let mut map = before.clone();
            map.nodes[0].state = NodeState::Claimed;
            map
        };

        assert_ne!(before, after);
    }

    /// The guard on the field nobody would add on purpose. `updatedAt` on a
    /// node would make every poll after an edit report a change, and — because
    /// GitHub has been measured stamping it a second *behind* the close event
    /// it describes — would also report one where nothing moved.
    #[test]
    fn nothing_in_the_derived_model_is_a_timestamp() {
        fn walk(value: &serde_json::Value, path: &str) {
            match value {
                serde_json::Value::Object(fields) => {
                    for (name, held) in fields {
                        // `…At` is how every stamp in this workspace is spelled
                        // once serde has camelCased it — `updatedAt`,
                        // `fetchedAt`, `resetAt`. The words beside it catch the
                        // ones that would arrive under a different name.
                        let lowered = name.to_lowercase();
                        let stamped = name.ends_with("At")
                            || ["time", "date", "stamp", "epoch", "second", "since"]
                                .iter()
                                .any(|word| lowered.contains(word));
                        assert!(
                            !stamped,
                            "{path}.{name} looks like a timestamp, \
                             and model equality is the diff unit"
                        );
                        walk(held, &format!("{path}.{name}"));
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

        walk(
            &serde_json::to_value(model_of(AWKWARD)).expect("serialises"),
            "model",
        );
    }
}
