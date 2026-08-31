//! What the harness says to a session, and nothing about what it runs.
//!
//! The other half of the spawn lives in `perseverance_agent`, whose charter is
//! *what to run, never what to say* — `LaunchContext { prompt }` is handed a
//! string that is **already rendered** (`crates/agent/src/launch.rs`). This is
//! where that string comes from. It is here rather than in that crate because
//! the crate may depend on nothing and may name almost none of `std`, and here
//! rather than in `perseverance_model` because prose is not a derivation.
//!
//! Two rules run through everything below.
//!
//! **Coordinates, not state.** A prompt carries where the work is — repo, map,
//! ticket, operator — and the ticket's own question. It never carries the
//! harness's reading of the map: no frontier, no counts, no node states, no
//! blocker list, no route. A session that inherited those would be acting on a
//! picture that stopped being true the moment it was written, and no amount of
//! freshness elsewhere could repair it.
//!
//! **Semantics travel inline, never by pointer.** Every rule the agent must
//! obey is in the text. Not a path, not a file reference, not "see the skill":
//! a sandboxed Codex turns a path into a mid-run permission prompt, and a
//! research run executing in a worktree resolves a relative one somewhere
//! wrong. A few thousand tokens per run is the accepted price.

use std::path::Path;

use serde::Serialize;

/// The revision of the wayfinder conventions this text derives from.
///
/// Nothing in the tree supplies or checks this value — it is introduced here,
/// and the header of every template carries it, so that a transcript found
/// months later says which vintage of the rules the session was working under.
/// Bump it when the *conventions* change, not when the wording does.
pub const WAYFINDER_REVISION: &str = "2026.1";

/// The template a session working one ticket is spawned from. Others
/// (`compose-spec`, `ask`) are their own tickets; the shape here takes a
/// template as an argument so a second one costs a `const` and a function.
const WORK_TICKET: &str = include_str!("prompts/work-ticket.md");

/// The template a charting session is spawned from.
///
/// **Its own template rather than a mode of the one above**, because the two
/// disagree about nearly everything: `chart` names a destination, fans out
/// breadth-first and creates the labels a repository does not have yet, and it
/// governs no write to an existing ticket at all. One template covering both
/// would need a conditional, and a template that wants a conditional is two
/// templates that have not been split yet.
const CHART: &str = include_str!("prompts/chart.md");

/// The brief for a map whose tickets are all closed, which composes the map's
/// one specification document.
const COMPOSE_SPEC: &str = include_str!("prompts/compose-spec.md");

/// The override's file name, resolved against `app_data_dir()`.
///
/// **A file beside the registry, not a row in the store's `app` table**, and
/// the difference is who writes it. The adapter override next door
/// (`stored_override`) is written by the app itself from a settings field; this
/// one is a page of prose an operator authors in an editor when our wording is
/// wrong for their repository, and a value only reachable through SQLite is a
/// value nobody will ever set. The read tolerates failure the same way its
/// neighbour does: unreadable or blank is *no override*, never a refusal.
pub const WORK_TICKET_OVERRIDE_FILE: &str = "work-ticket.md";

/// The charting override's file name, read on exactly the same terms.
pub const CHART_OVERRIDE_FILE: &str = "chart.md";

/// The `compose-spec` override, beside its neighbour and read the same way.
///
/// One file per template rather than one file of everything: an operator whose
/// wording is wrong for their repository is usually wrong about *one* job, and
/// a single blob would make them restate the other briefs to change this one.
pub const COMPOSE_SPEC_OVERRIDE_FILE: &str = "compose-spec.md";

/// Where the work is. Every field is a coordinate the agent can read its own
/// way in from, plus the ticket's question, which is the one piece of map
/// content that travels inline.
#[derive(Debug, Clone)]
pub struct Coordinates {
    /// `owner/name`.
    pub repo: String,
    pub map_number: u64,
    pub map_url: String,
    pub ticket_number: u64,
    pub ticket_url: String,
    pub ticket_title: String,
    /// The operator's GitHub login, which is what makes step 1's middle branch
    /// — *already assigned to you* — decidable by the agent.
    pub operator: String,
    /// The claimed ticket's own question, verbatim.
    pub question: String,
}

/// Where a charting session starts from, which is a shorter list than
/// [`Coordinates`] because nothing is charted yet.
///
/// No map number, no ticket and no question: there is no map to name, no ticket
/// to carry, and the whole subject of the run is the sentence the operator
/// typed. Its own struct rather than optional fields on [`Coordinates`], so
/// neither template ever renders a hole the other one filled.
#[derive(Debug, Clone)]
pub struct Bearings {
    /// `owner/name`.
    pub repo: String,
    pub repo_url: String,
    /// The operator's GitHub login. A brief with no operator in it is a brief a
    /// session cannot follow, so the caller refuses rather than render a hole.
    pub operator: String,
    /// What the operator typed, verbatim.
    pub idea: String,
}

/// Where the work is when the work is the *map* and not a ticket in it.
///
/// A second struct rather than a [`Coordinates`] with four fields left empty:
/// composing a spec has no ticket, no ticket title and no question, and a
/// placeholder ticket rendered into a brief is a coordinate pointing at nothing
/// — the session would read it and go somewhere. What a template cannot be
/// given, it cannot leak.
#[derive(Debug, Clone)]
pub struct MapCoordinates {
    /// `owner/name`.
    pub repo: String,
    pub map_number: u64,
    pub map_url: String,
    /// The operator's GitHub login, which is who the seam sketch goes to before
    /// the document is written.
    pub operator: String,
}

/// Which text a run was spawned from.
///
/// It reaches the terminal's collapsed prompt block, and it is the whole reason
/// a run spawned from an override is diagnosable: an agent misbehaving under
/// custom prose is a different bug report from one misbehaving under ours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    Stock,
    Custom,
}

/// A rendered prompt, with the two facts the UI prints beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub text: String,
    /// Characters and not bytes: it is a length a human reads, and the prose is
    /// full of em dashes.
    pub characters: usize,
    pub origin: Origin,
}

/// Dumb named substitution, and deliberately nothing more.
///
/// No conditionals and no loops: a template that wants a conditional is two
/// templates that have not been split yet. The workspace has no templating
/// dependency and gains none for this.
///
/// Each template substitutes from the coordinates it has and no others, so a
/// name a template's own coordinates cannot supply survives as `{{name}}` and
/// the conformance tests catch it — rather than resolving to a blank that reads
/// as a real, empty answer.
fn fill(template: &str, bindings: &[(&str, &str)]) -> String {
    std::iter::once(("{{revision}}", WAYFINDER_REVISION))
        .chain(bindings.iter().copied())
        .fold(template.to_string(), |text, (name, value)| {
            text.replace(name, value)
        })
}

/// One template, one pair list, one answer — the half both renderers below
/// share, so that *an override is the whole prompt* is written once.
fn rendered(overriding: Option<&str>, stock: &str, values: &[(&str, &str)]) -> Rendered {
    let (template, origin) = match overriding {
        Some(custom) => (custom, Origin::Custom),
        None => (stock, Origin::Stock),
    };
    let text = fill(template, values);

    Rendered {
        characters: text.chars().count(),
        text,
        origin,
    }
}

/// The override as it was written down, or nothing at all.
///
/// **Wholesale, with no merging**: a readable file is the entire prompt, and an
/// absent, unreadable or blank one is the compiled-in text. Nothing is stitched
/// together from both, because a half-overridden prompt is a prompt no one
/// wrote. Malformed reads as absent rather than as a failure, exactly as
/// `stored_override` treats an unparseable preference row — a spawn held shut
/// by a bad file in a settings directory would be the worse outcome.
pub fn work_ticket_override(app_data_dir: &Path) -> Option<String> {
    written_beside(app_data_dir, WORK_TICKET_OVERRIDE_FILE)
}

/// The charting override, on exactly the terms argued above.
pub fn chart_override(app_data_dir: &Path) -> Option<String> {
    written_beside(app_data_dir, CHART_OVERRIDE_FILE)
}

/// The `compose-spec` override, on the same terms as its neighbour.
pub fn compose_spec_override(app_data_dir: &Path) -> Option<String> {
    written_beside(app_data_dir, COMPOSE_SPEC_OVERRIDE_FILE)
}

fn written_beside(app_data_dir: &Path, file: &str) -> Option<String> {
    let written = std::fs::read_to_string(app_data_dir.join(file)).ok()?;
    (!written.trim().is_empty()).then_some(written)
}

/// The `work-ticket` prompt, rendered from the override when there is one and
/// from the compiled-in text when there is not.
pub fn work_ticket(overriding: Option<&str>, at: &Coordinates) -> Rendered {
    let map_number = at.map_number.to_string();
    let ticket_number = at.ticket_number.to_string();

    rendered(
        overriding,
        WORK_TICKET,
        &[
            ("{{revision}}", WAYFINDER_REVISION),
            ("{{repo}}", at.repo.as_str()),
            ("{{map_number}}", map_number.as_str()),
            ("{{map_url}}", at.map_url.as_str()),
            ("{{ticket_number}}", ticket_number.as_str()),
            ("{{ticket_url}}", at.ticket_url.as_str()),
            ("{{ticket_title}}", at.ticket_title.as_str()),
            ("{{operator}}", at.operator.as_str()),
            ("{{question}}", at.question.as_str()),
        ],
    )
}

/// The `chart` prompt, rendered from the override when there is one and from
/// the compiled-in text when there is not.
pub fn chart(overriding: Option<&str>, at: &Bearings) -> Rendered {
    rendered(
        overriding,
        CHART,
        &[
            ("{{revision}}", WAYFINDER_REVISION),
            ("{{repo}}", at.repo.as_str()),
            ("{{repo_url}}", at.repo_url.as_str()),
            ("{{operator}}", at.operator.as_str()),
            ("{{idea}}", at.idea.as_str()),
        ],
    )
}

/// The `compose-spec` prompt, on the same terms, from map coordinates only.
pub fn compose_spec(overriding: Option<&str>, at: &MapCoordinates) -> Rendered {
    let map_number = at.map_number.to_string();

    rendered(
        overriding,
        COMPOSE_SPEC,
        &[
            ("{{repo}}", at.repo.as_str()),
            ("{{map_number}}", map_number.as_str()),
            ("{{map_url}}", at.map_url.as_str()),
            ("{{operator}}", at.operator.as_str()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use perseverance_model::{FOG_HEADING, MAP_LABEL, OUT_OF_SCOPE_HEADING, WAYFINDER_PREFIX};

    fn somewhere() -> Coordinates {
        Coordinates {
            repo: "javrasya/perseverance".to_string(),
            map_number: 28,
            map_url: "https://github.com/javrasya/perseverance/issues/28".to_string(),
            ticket_number: 48,
            ticket_url: "https://github.com/javrasya/perseverance/issues/48".to_string(),
            ticket_title: "The prompt is the product".to_string(),
            operator: "javrasya".to_string(),
            question: "What does the harness say to a session?".to_string(),
        }
    }

    /// The parser's own source, so a rename of a ticket-type string over there
    /// fails here — those five are matched as literals in `derive.rs` and are
    /// not constants a test can name.
    const DERIVE: &str = include_str!("../../model/src/derive.rs");

    /// **The conformance check.**
    ///
    /// Prose drift is harmless and structural drift is the risk: reword any
    /// sentence below freely, but stop instructing sub-issues and the graph
    /// silently reads a map with no children — no error anywhere, just a map
    /// that is wrong. So every structure the parser keys on is asserted here,
    /// against the model crate's own constants rather than against restated
    /// strings, so that a rename on *either* side fails this test.
    ///
    /// It is pointed at our templates and never at anyone's installed skills,
    /// and it attempts no drift detection against upstream conventions: there
    /// is nothing in the tree to compare against, and a check that cannot be
    /// built honestly is worse than no check.
    #[test]
    fn the_template_still_instructs_every_structure_the_parser_reads() {
        for kind in ["research", "prototype", "grilling", "task", "spec"] {
            assert!(
                DERIVE.contains(&format!("\"{kind}\" =>")),
                "crates/model no longer classifies {kind:?}, so the template teaches a label \
                 nothing reads"
            );
            assert!(
                WORK_TICKET.contains(&format!("{WAYFINDER_PREFIX}{kind}")),
                "the template no longer names {WAYFINDER_PREFIX}{kind}, so a session can create \
                 a child the map cannot classify"
            );
        }

        assert!(
            WORK_TICKET.contains(FOG_HEADING),
            "the template no longer names the literal fog heading, and the parser matches no \
             other spelling"
        );
        assert!(
            WORK_TICKET.contains(OUT_OF_SCOPE_HEADING),
            "the template no longer names the literal out-of-scope heading, and the parser \
             matches no other spelling"
        );
        // The cut is keyed on the link, so a bullet without one is invisible
        // however clearly it is worded.
        assert!(
            WORK_TICKET.contains("link to the issue it cuts"),
            "the template no longer requires an issue link in an out-of-scope bullet"
        );

        assert!(
            WORK_TICKET.contains("sub-issue"),
            "the template no longer says children are attached as sub-issues"
        );
        assert!(
            WORK_TICKET.contains("dependency link"),
            "the template no longer says blocking is recorded as a native dependency link"
        );
        assert!(
            WORK_TICKET.contains("never as a sentence"),
            "the template no longer forbids recording blocking as prose"
        );

        for act in ["**Comment**", "**Close**", "**Index line**"] {
            assert!(
                WORK_TICKET.contains(act),
                "the template no longer instructs {act} as part of resolving a ticket"
            );
        }
    }

    /// Step 1 is the correctness guard — the agent is the only writer — and it
    /// is also what makes Resume possible without a second template: Resume
    /// sends byte-identical prose and the agent never learns which verb was
    /// pressed.
    #[test]
    fn step_one_is_a_three_way_and_prior_comments_are_read() {
        for branch in [
            "**Unassigned**",
            "**Assigned to @javrasya**",
            "**Assigned to anyone else**",
        ] {
            assert!(
                work_ticket(None, &somewhere()).text.contains(branch),
                "step 1 no longer offers {branch}"
            );
        }
        assert!(work_ticket(None, &somewhere())
            .text
            .contains("read the ticket's existing comments"));
    }

    #[test]
    fn the_prompt_carries_coordinates_and_the_question_and_no_graph() {
        let rendered = work_ticket(None, &somewhere());

        for coordinate in [
            "javrasya/perseverance",
            "#28",
            "https://github.com/javrasya/perseverance/issues/28",
            "#48",
            "https://github.com/javrasya/perseverance/issues/48",
            "The prompt is the product",
            "@javrasya",
            "What does the harness say to a session?",
        ] {
            assert!(
                rendered.text.contains(coordinate),
                "{coordinate} is missing"
            );
        }

        assert!(
            !rendered.text.contains("{{"),
            "a placeholder went unsubstituted"
        );
        assert_eq!(rendered.origin, Origin::Stock);
        assert_eq!(rendered.characters, rendered.text.chars().count());
    }

    /// Not a list of every word the graph could be described with — the rule is
    /// upstream of the text, and this pins the shape of the argument: nothing
    /// derived is a field of [`Coordinates`], so no render can leak one.
    #[test]
    fn no_derived_state_can_reach_a_prompt() {
        let mut at = somewhere();
        at.question = "frontier".to_string();

        // The only route a word like this has into a prompt is the ticket's own
        // question, quoted verbatim from the ticket the agent is about to read.
        // (The template names the frontier once itself, to say it is withheld.)
        let quiet = work_ticket(None, &somewhere())
            .text
            .matches("frontier")
            .count();
        assert_eq!(
            work_ticket(None, &at).text.matches("frontier").count(),
            quiet + 1
        );
    }

    #[test]
    fn an_override_is_the_whole_prompt_and_an_unreadable_one_is_absent() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        assert!(work_ticket_override(dir.path()).is_none());

        let file = dir.path().join(WORK_TICKET_OVERRIDE_FILE);
        std::fs::write(&file, "   \n\t\n").expect("writes");
        assert!(
            work_ticket_override(dir.path()).is_none(),
            "a blank override is absent, not an empty prompt"
        );

        std::fs::write(&file, "Work #{{ticket_number}} in {{repo}}.").expect("writes");
        let custom = work_ticket_override(dir.path()).expect("an override");
        let rendered = work_ticket(Some(&custom), &somewhere());

        // Wholesale: nothing of the compiled-in text survives.
        assert_eq!(rendered.text, "Work #48 in javrasya/perseverance.");
        assert_eq!(rendered.origin, Origin::Custom);
        assert_eq!(rendered.characters, 34);
    }

    /* ------------------------------------------------------------ chart --- */

    fn an_idea() -> Bearings {
        Bearings {
            repo: "javrasya/perseverance".to_string(),
            repo_url: "https://github.com/javrasya/perseverance".to_string(),
            operator: "javrasya".to_string(),
            idea: "Charting should be startable from an empty folder".to_string(),
        }
    }

    /// The conformance check above, for the template that creates the
    /// structures rather than adding to them. Same rule and same reason: every
    /// literal the parser keys on is asserted against the model crate's own
    /// constants, so a rename on either side fails here.
    #[test]
    fn the_chart_template_still_instructs_every_structure_the_parser_reads() {
        for kind in ["research", "prototype", "grilling", "task", "spec"] {
            assert!(
                DERIVE.contains(&format!("\"{kind}\" =>")),
                "crates/model no longer classifies {kind:?}, so the template teaches a label \
                 nothing reads"
            );
            assert!(
                CHART.contains(&format!("{WAYFINDER_PREFIX}{kind}")),
                "the chart template no longer names {WAYFINDER_PREFIX}{kind}, so a charting run \
                 creates a child the map cannot classify"
            );
        }

        // The map's own label, which no other template has to name: this is the
        // run that opens the issue the poller discovers.
        assert!(
            CHART.contains(MAP_LABEL),
            "the chart template no longer names {MAP_LABEL}, so the map it opens is invisible to \
             the poll"
        );

        assert!(
            CHART.contains(FOG_HEADING),
            "the chart template no longer names the literal fog heading, and the parser matches \
             no other spelling"
        );
        assert!(
            CHART.contains(OUT_OF_SCOPE_HEADING),
            "the chart template no longer names the literal out-of-scope heading, and the parser \
             matches no other spelling"
        );
        assert!(
            CHART.contains("link to the issue it cuts"),
            "the chart template no longer requires an issue link in an out-of-scope bullet"
        );

        assert!(
            CHART.contains("sub-issue"),
            "the chart template no longer says children are attached as sub-issues"
        );
        assert!(
            CHART.contains("dependency link"),
            "the chart template no longer says blocking is recorded as a native dependency link"
        );
        assert!(
            CHART.contains("never as a sentence"),
            "the chart template no longer forbids recording blocking as prose"
        );
    }

    /// The three rules that live only here, and the one suppression that is the
    /// whole reason the harness spawns research runs itself.
    #[test]
    fn charting_creates_the_labels_fires_nothing_and_may_end_with_no_map() {
        let text = chart(None, &an_idea()).text;

        // Nothing else in the tree creates a label — the harness never writes
        // to GitHub — so a chart run that stopped doing this leaves a
        // repository whose tickets no poll can classify.
        assert!(
            text.contains("every label the harness reads"),
            "the template no longer instructs creating the labels"
        );

        assert!(
            text.contains("Do not fire research subagents"),
            "the template no longer suppresses the fire-the-subagents step"
        );
        assert!(
            text.contains("Leave every research ticket you created open and unresolved."),
            "the template no longer leaves the research tickets for the harness to spawn"
        );

        // A charting session that judged the work small enough to just do is a
        // success, and the prose has to say so in those terms or the agent
        // invents fog to justify a map.
        assert!(
            text.contains("**Producing no map is a normal outcome.**"),
            "the template no longer calls a run with no map a normal outcome"
        );
        assert!(
            text.contains("is a success, not a failure"),
            "the template no longer says a run that produced no map succeeded"
        );

        // The two steps `work-ticket` deliberately dropped.
        assert!(
            text.contains("name the destination"),
            "the template no longer settles the destination first"
        );
        assert!(
            text.contains("breadth-first"),
            "the template no longer maps the frontier breadth-first"
        );
    }

    #[test]
    fn the_chart_prompt_carries_bearings_and_nothing_charted() {
        let rendered = chart(None, &an_idea());

        for bearing in [
            "javrasya/perseverance",
            "https://github.com/javrasya/perseverance",
            "@javrasya",
            "Charting should be startable from an empty folder",
        ] {
            assert!(rendered.text.contains(bearing), "{bearing} is missing");
        }
        assert!(
            !rendered.text.contains("{{"),
            "a placeholder went unsubstituted"
        );

        // Nothing is charted yet, so no issue number can be true of this run —
        // and the harness's own reading of a map is never an input to one.
        let numbered: Vec<&str> = rendered
            .text
            .match_indices('#')
            .filter(|(at, _)| {
                rendered.text[at + 1..]
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_ascii_digit())
            })
            .map(|(at, _)| &rendered.text[at..(at + 6).min(rendered.text.len())])
            .collect();
        assert!(
            numbered.is_empty(),
            "the chart prompt names an issue number: {numbered:?}"
        );
        // The word appears exactly once, naming the act of mapping the space —
        // never a frontier the harness derived, which is not an input to any
        // run and least of all to the one that has no map to derive it from.
        assert_eq!(
            rendered.text.matches("frontier").count(),
            1,
            "the chart prompt has grown a second sense of the frontier"
        );
        assert_eq!(rendered.origin, Origin::Stock);
        assert_eq!(rendered.characters, rendered.text.chars().count());
    }

    /* ------------------------------------------------------ compose-spec --- */

    fn a_map() -> MapCoordinates {
        MapCoordinates {
            repo: "javrasya/perseverance".to_string(),
            map_number: 28,
            map_url: "https://github.com/javrasya/perseverance/issues/28".to_string(),
            operator: "javrasya".to_string(),
        }
    }

    /// **The conformance check for `compose-spec`.**
    ///
    /// The same argument as its neighbour above, one template over: reword any
    /// sentence freely, but stop instructing the sub-issue API and the spec is
    /// an orphan issue the map never sees; stop instructing the label and the
    /// map never reaches `Specced`; stop instructing the spill and a document
    /// past the body limit comes back truncated, or as a second issue that
    /// makes `wayfinder:spec` a set. None of those fail loudly at runtime.
    #[test]
    fn the_compose_spec_template_still_instructs_the_four_harness_rules() {
        let text = compose_spec(None, &a_map()).text;

        assert!(
            DERIVE.contains("\"spec\" =>"),
            "crates/model no longer classifies a spec child, so the template teaches a label \
             nothing reads"
        );
        assert!(
            text.contains(&format!("{WAYFINDER_PREFIX}spec")),
            "the template no longer names {WAYFINDER_PREFIX}spec, so the composed spec is a \
             child the map cannot classify"
        );
        assert!(
            text.contains(&format!("gh label create {WAYFINDER_PREFIX}spec")),
            "the template no longer has the run create the label, so composing into a repository \
             that lacks it fails at the last step"
        );

        // Rule 1. Attachment is the sub-issue API and never an edit, so the
        // command is asserted and not only the word.
        assert!(
            text.contains("sub-issue"),
            "the template no longer says the spec is attached as a sub-issue"
        );
        assert!(
            text.contains("/sub_issues"),
            "the template no longer names the sub-issue API, and `gh issue edit` cannot attach"
        );
        assert!(
            text.contains("ready-for-agent"),
            "the template no longer applies the triage label /to-spec applies"
        );

        // Rule 2. The index routes; a structure is opened and a measurement is
        // trusted.
        assert!(
            text.contains("routing table"),
            "the template no longer says the map's index is a routing table rather than the input"
        );
        assert!(
            text.contains("compresses without loss and a structure does not"),
            "the template no longer carries the structure-versus-measurement test, and a session \
             either opens every child or none"
        );

        // Rule 3. Past the limit, spill — never truncate, never split.
        assert!(
            text.contains("65,536"),
            "the template no longer names GitHub's body limit"
        );
        for rule in [
            "**Never truncate.**",
            "**Never split into several issues.**",
            "**one issue**",
            "--comments",
        ] {
            assert!(
                text.contains(rule),
                "the template no longer instructs {rule} as part of spilling past the body limit"
            );
        }

        // Rule 4.
        assert!(
            text.contains("Enumerate the sources you did not read."),
            "the template no longer requires the document to name what it did not open"
        );

        // The three sentences the ticket pins: HITL, greenfield, one run.
        assert!(
            text.contains("human-in-the-loop"),
            "the template no longer says the run is HITL"
        );
        assert!(
            text.contains("before the document is written"),
            "the seam check no longer precedes the document, which is the whole reason it is HITL"
        );
        assert!(
            text.contains("greenfield"),
            "the template no longer tells a greenfield spec to derive seams from its own module \
             boundaries"
        );
        for once in [
            "**This is one run.**",
            "no staged outline",
            "per-area passes",
        ] {
            assert!(
                text.contains(once),
                "the template no longer forbids {once}, and composing becomes a multi-pass job"
            );
        }
    }

    /// The copied `/to-spec` document shape. `/to-spec` itself is never read at
    /// runtime and never modified; this is the copy, and drift here is a spec
    /// missing a section its readers expect.
    #[test]
    fn the_compose_spec_template_carries_the_spec_document_section_for_section() {
        let text = compose_spec(None, &a_map()).text;

        for heading in [
            "## Problem Statement",
            "## Solution",
            "## User Stories",
            "## Implementation Decisions",
            "## Testing Decisions",
            "## Out of Scope",
            "## Further Notes",
        ] {
            assert!(
                text.contains(heading),
                "the copied spec template no longer asks for {heading}"
            );
        }
        assert!(
            text.contains("As an <actor>, I want a <feature>, so that <benefit>"),
            "the user-story form is gone, and a numbered list of anything would satisfy the brief"
        );
    }

    /// Map coordinates and nothing below them: composing targets the map, so a
    /// ticket number rendered here would be a coordinate pointing at nothing.
    #[test]
    fn the_compose_spec_prompt_carries_the_map_and_no_ticket() {
        let rendered = compose_spec(None, &a_map());

        for coordinate in [
            "javrasya/perseverance",
            "#28",
            "https://github.com/javrasya/perseverance/issues/28",
            "@javrasya",
        ] {
            assert!(
                rendered.text.contains(coordinate),
                "{coordinate} is missing"
            );
        }

        assert!(
            rendered
                .text
                .lines()
                .next()
                .expect("a header line")
                .contains(WAYFINDER_REVISION),
            "the header no longer declares the wayfinder revision it derives from"
        );
        assert!(
            !rendered.text.contains("{{"),
            "a placeholder went unsubstituted"
        );
        assert!(
            rendered
                .text
                .contains("Read the live issues with `gh` yourself."),
            "the template no longer says the harness's own reading of the map is withheld"
        );
        assert_eq!(rendered.origin, Origin::Stock);
        assert_eq!(rendered.characters, rendered.text.chars().count());
    }

    #[test]
    fn a_chart_override_is_the_whole_prompt_and_a_blank_one_is_absent() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        assert!(chart_override(dir.path()).is_none());

        let file = dir.path().join(CHART_OVERRIDE_FILE);
        std::fs::write(&file, "   \n\t\n").expect("writes");
        assert!(
            chart_override(dir.path()).is_none(),
            "a blank override is absent, not an empty prompt"
        );

        std::fs::write(&file, "Chart {{repo}} for @{{operator}}: {{idea}}").expect("writes");
        let custom = chart_override(dir.path()).expect("an override");
        let rendered = chart(Some(&custom), &an_idea());

        assert_eq!(
            rendered.text,
            "Chart javrasya/perseverance for @javrasya: Charting should be startable from an \
             empty folder"
        );
        assert_eq!(rendered.origin, Origin::Custom);

        // The two overrides are separate files, so the one beside it is
        // untouched by either write above.
        assert!(work_ticket_override(dir.path()).is_none());
        assert!(compose_spec_override(dir.path()).is_none());
    }

    #[test]
    fn a_compose_spec_override_is_the_whole_prompt_and_an_unreadable_one_is_absent() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        assert!(compose_spec_override(dir.path()).is_none());

        let file = dir.path().join(COMPOSE_SPEC_OVERRIDE_FILE);
        std::fs::write(&file, "   \n\t\n").expect("writes");
        assert!(
            compose_spec_override(dir.path()).is_none(),
            "a blank override is absent, not an empty prompt"
        );

        // The ticket name is left in deliberately: this template substitutes
        // from map coordinates only, so a name it cannot supply stays visible
        // rather than resolving to a blank that reads as an answer.
        std::fs::write(
            &file,
            "Compose for #{{map_number}} in {{repo}}, not #{{ticket_number}}.",
        )
        .expect("writes");
        let custom = compose_spec_override(dir.path()).expect("an override");
        let rendered = compose_spec(Some(&custom), &a_map());

        assert_eq!(
            rendered.text,
            "Compose for #28 in javrasya/perseverance, not #{{ticket_number}}."
        );
        assert_eq!(rendered.origin, Origin::Custom);
        assert_eq!(rendered.characters, rendered.text.chars().count());

        // And the two overrides are separate files: writing one leaves the
        // other's prompt on the compiled-in text.
        assert!(work_ticket_override(dir.path()).is_none());
    }

    /// **The prompt carries no verb, so a session cannot tell which press
    /// rendered it.**
    ///
    /// Resume differs from Start Working by a *precondition* and never by a
    /// behaviour, which is why there is one template here and not a sixth. What
    /// that buys is the thing a second template would quietly lose: a resumed
    /// session behaves exactly as a started one, and the whole of the difference
    /// is its step 1, which it decides from GitHub rather than from anything the
    /// harness told it about itself.
    #[test]
    fn the_prompt_carries_no_verb_for_a_session_to_tell_two_presses_apart() {
        const SOURCE: &str = include_str!("prompt.rs");

        let at = somewhere();
        // The same coordinates are the same bytes, whoever asked for them —
        // there is no argument here that a verb could arrive on.
        assert_eq!(work_ticket(None, &at).text, work_ticket(None, &at).text);

        let fields = SOURCE
            .split_once("pub struct Coordinates {")
            .expect("the coordinates are declared in this file")
            .1
            .split_once("\n}")
            .expect("and the declaration ends")
            .0;

        // Built rather than written out, so the assertion is not reading itself
        // back out of the source.
        for verb in [
            format!("{}_working", "start"),
            format!("{}_working", "resume"),
        ] {
            assert!(
                !WORK_TICKET.contains(&verb),
                "the template names {verb}, so the two presses no longer render one prompt"
            );
            assert!(
                !fields.contains(&verb),
                "a coordinate names {verb}, so a press can say which press it was"
            );
        }

        // And the whole of the mitigation for a claim whose session is gone: the
        // agent is sent to what the last one left on the ticket. Nothing on this
        // side reconstructs a transcript, and this sentence is why it does not
        // have to.
        assert!(
            WORK_TICKET.contains("existing comments"),
            "a resumed session has nothing to continue from"
        );
    }
}
