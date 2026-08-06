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

/// Every label this app classifies by starts here.
///
/// The prefix is what makes a wayfinder label distinguishable from the
/// repository's own labels, so a child carrying `bug` and `priority:high` is
/// unclassified rather than accidentally something.
pub const WAYFINDER_PREFIX: &str = "wayfinder:";

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
    /// The designated frontier: the number of the first node in map order that
    /// [`Node::is_takeable`] admits. `None` when nothing on this map can be
    /// started, which is a state with its own reading and not a zero.
    pub frontier: Option<u64>,
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
}

impl Node {
    fn of(child: &ChildRead) -> Node {
        Node {
            number: child.number,
            title: child.title.clone(),
            url: child.url.clone(),
            kind: ChildKind::of(&child.labels),
            state: NodeState::of(child),
            waits_on: child.waits_on.clone(),
        }
    }

    /// Whether an agent may be launched at this node — the whole of frontier
    /// eligibility, spelled once.
    ///
    /// Two conditions, and the second is the one the four states cannot express
    /// on their own: a child has to be a **ticket**. Without that clause a spec
    /// child that is open, unblocked and unassigned satisfies every state
    /// predicate there is, and *Start Working* launches an agent at the
    /// destination. An unclassified child is refused for the same reason from
    /// the other direction: a stray issue dragged onto the map fails safe
    /// rather than being silently reinterpreted as a task.
    pub fn is_takeable(&self) -> bool {
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
    fn of(graph: &MapGraph) -> Map {
        let nodes: Vec<Node> = graph.children.iter().map(Node::of).collect();

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
            // First in map order, and *first* is the whole resolver. Nothing
            // scores, ranks, or prefers the ticket that unblocks the most: the
            // order is the operator's and the harness never invents one.
            frontier: nodes
                .iter()
                .find(|node| node.is_takeable())
                .map(|node| node.number),
            counts,
            nodes,
        }
    }
}

impl Model {
    /// The state the app opens in: chrome, and no map behind it.
    pub fn no_map_open() -> Model {
        Model { map: None }
    }

    /// One parsed answer, derived. The whole of the derivation is reachable
    /// from here and from nowhere else.
    pub fn of(read: &MapRead) -> Model {
        Model {
            map: read.map.as_ref().map(Map::of),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_response;

    const TWO_MAPS: &str = include_str!("../fixtures/two-maps-one-open.json");
    const AWKWARD: &str = include_str!("../fixtures/awkward-children.json");
    const EMPTY_MAP: &str = include_str!("../fixtures/empty-map.json");
    const SPEC_COMPOSED: &str = include_str!("../fixtures/spec-composed.json");
    const MAP_CLOSED: &str = include_str!("../fixtures/map-closed.json");
    const NO_MAP: &str = include_str!("../fixtures/no-map-in-this-repo.json");

    fn model_of(body: &str) -> Model {
        Model::of(&read_response(body).expect("reads"))
    }

    fn map_of(body: &str) -> Map {
        model_of(body).map.expect("a map")
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
        assert_eq!(map.frontier, Some(75));
    }

    #[test]
    fn the_frontier_is_never_the_spec_even_when_the_spec_would_otherwise_be_takeable() {
        let map = map_of(AWKWARD);

        let spec = node(&map, 73);
        assert_eq!(spec.kind, ChildKind::Spec);
        assert_eq!(spec.state, NodeState::Takeable);
        assert!(!spec.is_takeable());
        assert_ne!(map.frontier, Some(73));
    }

    #[test]
    fn a_map_with_nothing_startable_on_it_has_no_frontier_rather_than_a_first_row() {
        let map = map_of(SPEC_COMPOSED);

        // Every ticket is closed. *Nothing to start* is a state with its own
        // reading, and pointing at row one would be inventing a target.
        assert_eq!(map.frontier, None);
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
        assert_eq!(map.frontier, None);
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
