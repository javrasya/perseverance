/**
 * The model's own words, said the same way by every view that says them.
 *
 * These are not copy. Copy is a view's own voice — what The Route calls a row
 * and Deep Field calls a plate, what each of them says when it will not fit —
 * and it belongs to the view, one per view, free to differ. What is here is the
 * *vocabulary*: the words that name a thing in the model, where two views
 * saying it differently would be two vocabularies for one thing. An operator
 * reading *unclassified* and a developer reading `ChildKind::Unclassified` are
 * meant to be reading the same word, and that promise is not per-view.
 *
 * It lives beside `graph.ts` for the reason that file exists: a second copy
 * written beside the first is a second answer, free to disagree with it about
 * the one thing both are for. `STATE_NAMES` in two files goes red nowhere when
 * one of them starts saying *done* instead of *resolved* — the drift is silent,
 * and the thing that drifts is the shared vocabulary itself.
 *
 * What is deliberately *not* here: `NOBODY_SURVEYED`, the em dash. One dash for
 * one meaning across the window, declared per module as `environment.ts` and
 * `folder.ts` each declare their own — a character is not a vocabulary, and an
 * import between two views for one is worse than the repetition.
 */

import type { NodeState } from "../snapshot/model.generated";

/** The word on the cold tag, and the only place the designation is named. */
export const DESIGNATED_TAG = "designated";

/**
 * Names the ticket's binding — a fact about the reader's machine — and says
 * nothing about why the node is where it is.
 *
 * The verdict is decided per node from the labels alone, so the tag travels
 * with it onto every row or plate that carries it, including ones the frontier
 * would not offer anyway because they are blocked, resolved or not tickets. On
 * those the machine is not the reason; it is only the reason on a node that is
 * otherwise startable.
 *
 * A tag beside the others rather than a group of its own: the node keeps the
 * section or rank its state puts it in and is counted there. Moving it would be
 * a view re-grouping the map by a fact that is about the reader, and a group is
 * a claim about the work.
 */
export const BOUND_ELSEWHERE_TAG = "not on this machine";

/**
 * The two kinds of child that are not tickets, said in the model's own words.
 *
 * The screen and the type read one vocabulary, exactly as `STATE_NAMES` keeps
 * them: an operator reading *unclassified* and a developer reading
 * `ChildKind::Unclassified` are reading the same thing. And the word is the
 * whole of why a stray issue fails safe rather than fails silently — it is set
 * apart, wearing a shape of its own, and it also *says* what it is, so nothing
 * about it depends on the reader knowing the shapes.
 */
export const SPEC_TAG = "spec";
export const UNCLASSIFIED_TAG = "unclassified";

/**
 * The fog names itself, and the name is the map's rather than a view's.
 *
 * Everything else on this map has an identity — a number, a title, a URL — and
 * the fog has none of the three, because it is the work nobody has cut a ticket
 * for yet. That is exactly why it is named rather than left as a figure in the
 * margin: a region with a name is somewhere an operator can go, and an
 * unlabelled number is a smudge.
 *
 * **Vocabulary and not view copy**, which is a decision and not an accident:
 * the region is rule 4's, one region on one map, and a view that renamed it
 * would be claiming the operator is looking at something else. Both views name
 * it from here. What stays per-view is only how the region is *drawn* — a
 * section heading on The Route, a band under the field in Deep Field.
 *
 * Sentence case like the section headings, and uppercased by the stylesheet, so
 * a hard-coded capital here would be a divergence from the design nobody sees
 * until they read the DOM.
 */
export const FOG_HEADING = "Fog";

/**
 * Said under the heading when the survey happened and turned up nothing.
 *
 * A real claim, and the reason the surveyed branch always draws something under
 * its heading: an empty region and an unsurveyed one would otherwise look
 * identical below the count, and the count is not the only place the difference
 * is meant to be legible. Shared for `FOG_HEADING`'s reason — *surveyed and
 * found nothing* is a fact about the map, so two wordings would be two facts.
 */
export const FOG_ALL_CHARTED = "nothing left unspecified";

/**
 * The on-screen word for each of the four states.
 *
 * The model's own words, deliberately unchanged, in the shape `PHASE_NAMES`
 * already established: the screen and the type say the same thing, so an
 * operator reading *blocked* and a developer reading `NodeState::Blocked` are
 * reading one vocabulary. Every view leans on the word rather than on colour —
 * The Route's palette is neutrals and one indigo, and Deep Field's mark is a
 * disc of a few pixels — so the word is doing most of the work in both, and a
 * synonym in either would be a second vocabulary for the same four states.
 */
export const STATE_NAMES: Record<NodeState, string> = {
  resolved: "resolved",
  blocked: "blocked",
  claimed: "claimed",
  takeable: "takeable",
};
