/**
 * The thirteen rules of the encoding contract, as data.
 *
 * The contract is one sentence per rule and one *tier* per rule, and the tier
 * is the load-bearing half: it says what kind of thing keeps the rule, and
 * therefore what a violation even looks like. A rule nobody can violate needs
 * no test; a rule a test settles needs no reviewer; a rule that needs a
 * reviewer must say so out loud, because pretending otherwise is how a
 * judgement gets shipped as a green build.
 *
 * This module is data only — no React, no store, nothing from the running app.
 * It is read by tests and by whoever writes the browser-side assertions (#43),
 * and both read it from outside a rendered tree.
 *
 * What is deliberately not here: cells, states, views, fixtures, themes. The
 * fixture space is `src/snapshot/fixtures.ts` and the view list is
 * `src/views/views.ts`; a rule says only whether it is [`Rule.renderBound`],
 * and the fan-out over the fixture space is the assertion's business. Enumerate
 * the matrix here and the enumeration becomes the artifact — stale the first
 * time a fixture is added, and wrong in a way nothing fails.
 *
 * See `docs/adr/0020-the-contract-is-thirteen-rules-in-three-tiers.md`.
 */

export type RuleId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/**
 * The three things the thirteen rules bind.
 *
 * `codebase` — a claim about what the source can express. `rendering` — a claim
 * about what ends up on screen. `reading` — a claim about what a person takes
 * away from it, which is the only subject no machine has access to.
 */
export type Subject = "codebase" | "rendering" | "reading";

/**
 * How a rule is kept, weakest automation last.
 *
 * `structural` — violation is unexpressible: there is no field, no table, no
 * prop to write it into. `asserted` — a test decides, and its verdict is the
 * whole verdict. `judged` — some part of the obligation is about what a person
 * reads, so a person decides.
 */
export type Tier = "structural" | "asserted" | "judged";

export interface Rule {
  readonly id: RuleId;
  /** Short handle, for a matrix column or a failure message. */
  readonly name: string;
  /** The rule as written, verbatim. Restatements go in [`Rule.restatement`]. */
  readonly text: string;
  readonly subject: Subject;
  /**
   * The governing tier: the weakest automation this design allows. Judged if
   * any part of the obligation needs a person, else asserted, else structural.
   * Exactly one — a rule that is "structural and asserted" is asserted, because
   * the asserted half is the half that can go red.
   */
  readonly tier: Tier;
  /**
   * Whether checking it needs a rendering, and so needs the `dev:web` fixture
   * space. #43 fans its assertions out over the render-bound rules; the rest
   * are settled against source text, a schema, or a stylesheet.
   */
  readonly renderBound: boolean;
  /**
   * The mechanism, named precisely enough to argue with. For a structural rule:
   * the construction that makes violation unexpressible, and where it lives.
   * For an asserted rule: what is asserted, and over what surface.
   */
  readonly check: string;
  /** For a structural rule, the file the construction lives in. */
  readonly mechanismPath?: string;
  /** What a machine can settle of a judged rule, and no more. */
  readonly assertedFloor?: string;
  /** The part of an otherwise-asserted rule that only a reader can settle. */
  readonly judgedResidue?: string;
  /**
   * The registered form, where it differs from [`Rule.text`] — because the rule
   * as written is not the thing to check. Exactly two rules have one.
   */
  readonly restatement?: string;
  /**
   * A fact about the repo the entry would be dishonest without. Not a deviation
   * and not an excuse: an obligation still open, whose settling belongs to
   * whoever writes the assertion.
   */
  readonly tension?: string;
}

/**
 * Deviation is a function of tier, and so it is written once.
 *
 * The declaration slot exists only where deviating is a legitimate answer. An
 * asserted rule has no appeal — a red test is the failure, not the opening of a
 * conversation — and a structural rule has nothing to declare because there is
 * nothing to declare it about.
 */
export interface DeviationRoute {
  /** Whether the rule has a slot for a declared deviation at all. */
  readonly declarable: boolean;
  readonly policy: string;
}

export const DEVIATION: Readonly<Record<Tier, DeviationRoute>> = {
  structural: {
    declarable: false,
    policy:
      "No deviation and no declaration slot: the construction is the rule, so deviating would mean a code change that makes the violation expressible again.",
  },
  asserted: {
    declarable: false,
    policy: "A red test is a failure, with no appeal and nothing to declare.",
  },
  judged: {
    declarable: true,
    policy:
      "Deviation is legitimate and must be declared: a view may answer the rule differently, in writing, where a reader can weigh the answer.",
  },
};

export function deviationFor(rule: Rule): DeviationRoute {
  return DEVIATION[rule.tier];
}

export const RULES: readonly Rule[] = [
  {
    id: 1,
    name: "One derived model",
    text: "One derived model, no view-local state. A view renders the derived model and computes nothing of its own. Switching views can never change what is true — only how it looks.",
    subject: "codebase",
    tier: "structural",
    renderBound: false,
    mechanismPath: "src/snapshot/model.generated.ts",
    check:
      "Rust ships the model complete and this side receives it generated — `src/snapshot/model.generated.ts` is ts-rs output nobody edits — so there is no second derivation here to disagree with the first. Viewport, hover and read-marks stay legitimately view-local: they are not what is true, they are where the operator is looking.",
  },
  {
    id: 2,
    name: "Singular frontier",
    text: "The frontier is singular and structural. Every view renders exactly one designated node, and Start Working reads its target from the frontier resolver, never from the view. Spec and unclassified nodes are unspawnable by construction in all four.",
    subject: "rendering",
    tier: "asserted",
    renderBound: true,
    check:
      "Structural half: one resolver, in Rust, filtering to the wayfinder type, and the two fields it decides from do not cross the seam — a second resolver here has no input rather than a prohibition. Asserted half, which is why the entry is asserted and not structural: in a rendering, exactly one node carries the designated encoding.",
  },
  {
    id: 3,
    name: "Fail-safe is not styling",
    text: "Fail-safe is not styling. Unclassified must be visible and never actionable in every view, and must survive a retheme.",
    subject: "rendering",
    tier: "asserted",
    renderBound: true,
    check:
      "Collapse every semantic token to one value at `:root`, render, and assert unclassified is still told apart from a ticket and still carries no action. The three token tiers (`tests/token-tiers.test.ts`) are the *precondition* for that test — they are what makes one reassignment reach everything — not the test itself.",
  },
  {
    id: 4,
    name: "Absence is never zero",
    text: "Absence is never zero. `—` and `0` get form-level distinct renderings in every view. No view may render a missing fog heading as a count. Extension: a view's fog region must name itself, not only count itself.",
    subject: "rendering",
    tier: "judged",
    renderBound: true,
    check: "The floor is a fixture-level absence assertion; the extension is read.",
    assertedFloor:
      "Over the missing-fog fixture: no `0` anywhere the fog is rendered, and the absence renders as `—` at form level rather than as a differently-styled numeral.",
    judgedResidue:
      "*Names itself* — whether the region says what is missing rather than only that something is. No assertion tells a name from a label that happens to be there.",
  },
  {
    id: 5,
    name: "No progress bar",
    text: "No progress bar, in any view. Three integers. A bar asserts a denominator and fog can grow.",
    subject: "rendering",
    tier: "asserted",
    renderBound: true,
    restatement:
      "Progress is exactly three numerals, with no continuous element between them.",
    check:
      "The positive form is what is asserted, over every fixture: three numerals, and nothing between or behind them whose extent stands for a proportion. The rule as written names one widget and there are a hundred ways to build the same claim out of a div; the negative is untestable, and a check that only knows the word *bar* passes the first gradient.",
  },
  {
    id: 6,
    name: "Out-of-scope is never progress",
    text: "Out-of-scope is never progress. A decoration on resolved, excluded from the resolved count, carrying its reason as visible text rather than a hover.",
    subject: "rendering",
    tier: "asserted",
    renderBound: true,
    check:
      "Structural half: the model subtracts a cut ticket from both `tickets` and `open`, so no view can add it back — there is no fourth number to add it to (ADR 0017). Asserted half: in a rendering, the reason is text in the document, and the element carrying it has no hover-revealed disclosure and no `title`.",
  },
  {
    id: 7,
    name: "The ledger is chrome",
    text: 'The change ledger is chrome on the divider\'s spine, shared across every view and every dial position. No view renders it. Corollary: chrome that the contract binds but the view matrix does not cover is delivered to the chrome layer, not to views; its snapshot field sits outside the view prop type — which makes "no view renders it" structural for every such object rather than an assertion per object.',
    subject: "codebase",
    tier: "structural",
    renderBound: false,
    mechanismPath: "src/views/views.ts",
    restatement:
      "The prop type is narrowed instead: `ViewProps` names `model` and stops, so the record — which rides on the `Snapshot` beside `model` — is unwritable by a view for want of anything to write it from.",
    check:
      "`src/views/views.ts` declares `ViewProps` once, naming `model`, `selected` and `onSelect` and nothing else; `tests/views.test.ts` holds it to that and refuses every other file under `src/views/` a props declaration. One narrowing covers every view there will ever be and every object delivered to the chrome layer — per-view assertions would cover today's views and today's objects.",
  },
  {
    id: 8,
    name: "No stored positions",
    text: "No stored node positions — except Deep Field, the sole view needing a plate, which stores it under its own key.",
    subject: "codebase",
    tier: "structural",
    renderBound: false,
    mechanismPath: "crates/store/src/schema.rs",
    check:
      "The store's migration list has no column for a node position, and no `map_view` table at all — a position has nowhere to be written rather than a rule against writing it. Deep Field's exception arrives as its own key when Deep Field does; until then the exception has no subject.",
  },
  {
    id: 9,
    name: "Motion is rationed",
    text: 'Liveness is motion, and motion is rationed. Running vs stale claim is "is it moving" in every view. No view spends motion on anything else.',
    subject: "rendering",
    tier: "asserted",
    renderBound: true,
    check:
      "SMIL is banned stack-wide (`tests/no-smil.test.ts`), so every animation in this app is a CSS animation and the ration is *enumerable over the stylesheets*: collect every `animation` declaration and every keyframes block under `src/`, and assert each animated selector lands on an element carrying the running-vs-stale claim. Transitions on colour, border and opacity are not motion spent and are not counted.",
    tension:
      "Today `src/` holds exactly one animation — `ping`, on `.markClaimed::after` in `src/views/route/Route.module.css` — and it rides on *someone holds this ticket*, not on running-vs-stale. `NodeState` is `resolved | blocked | claimed | takeable`, so the rule's actual subject is not representable on this side of the seam at all. The enumeration is registerable now; what the one enumerated animation is allowed to mean is an open obligation for whoever writes the assertion (#43). It is not a deviation — an asserted rule has no deviation route.",
  },
  {
    id: 10,
    name: "Hover discloses nothing",
    text: "Hover is governed by each view's own semantics, and no view may put load-bearing information behind it. (Carve-out: native `title` tooltips recovering clipped text are recovery, not disclosure.)",
    subject: "reading",
    tier: "judged",
    renderBound: true,
    check:
      "The floor is assertable; *load-bearing* is not. Whether a fact the operator needs is reachable without a pointer is a claim about the task, and two views may answer it differently and both be right — which is what \"governed by each view's own semantics\" says.",
    assertedFloor:
      "Nothing revealed on hover that is not already present elsewhere in the rendering or is not a native `title` recovering text the layout clipped.",
  },
  {
    id: 11,
    name: "The field is not the label surface",
    text: "A view's graph field may not double as its label surface. Annotation gets reserved space the topology cannot grow into. Corollary: a zone boundary needs clearance from the graph's own marks.",
    subject: "reading",
    tier: "judged",
    renderBound: true,
    check:
      "Wholly judged: the claim is about misreading — a label read as a node, a boundary read as an edge — and misreading has no DOM signature. Reserved space is checkable only against a number, and the number belongs to one view's layout: asserting the figure one view arrived at would cargo-cult that view's fix into the contract, which is exactly what the meta-rule prohibits.",
  },
  {
    id: 12,
    name: "Still-state equivalent",
    text: "Any distinction carried by motion must have a still-state equivalent that carries it alone. A view whose reduced-motion fallback loses a state has not satisfied the contract.",
    subject: "rendering",
    tier: "judged",
    renderBound: true,
    check:
      "The floor is a fixture-pair assertion under `prefers-reduced-motion`; the residue is read.",
    assertedFloor:
      "The reduced-motion fixture pair: two states told apart by motion stay told apart with the media query on, and the difference left standing is in the still form.",
    judgedResidue:
      "*Carries it alone.* A machine can prove the two renderings still differ; it cannot prove the difference left standing is the same distinction the motion was carrying rather than an unrelated one that happens to survive.",
  },
  {
    id: 13,
    name: "Resolved stays locatable",
    text: "Resolved must remain locatable. Receding is a reduction in salience, never a reduction in visibility.",
    subject: "reading",
    tier: "judged",
    renderBound: true,
    check:
      "The floor is four DOM facts asserted over every fixture; the residue is read.",
    assertedFloor:
      "In the rendering: present in the DOM, non-zero opacity, hit-testable, keyboard-focusable.",
    judgedResidue:
      "Salience, not visibility. A node can clear all four floors and still be gone as far as a reader is concerned; how far a view may recede resolved before that happens is the judgement.",
  },
];

export const RULE_IDS: readonly RuleId[] = RULES.map((rule) => rule.id);

export function ruleById(id: RuleId): Rule {
  const rule = RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`no rule ${id} in the registry`);
  return rule;
}

/** What #43 fans its assertions out over. The fixture space is the fixtures'. */
export function renderBoundRules(): readonly Rule[] {
  return RULES.filter((rule) => rule.renderBound);
}

/**
 * The meta-rule, which is not one of the thirteen because it governs what may
 * become one.
 */
export const META_RULE =
  "The contract binds meaning, never geometry. Edge geometry is view identity and must not be standardised: if a proposed rule would make two views look more alike without making either more correct, it does not belong in the contract.";
