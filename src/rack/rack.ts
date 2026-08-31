import { relativeAge, terseAge } from "../chrome/age";
import type { RunReadout } from "../terminal/runs";

/**
 * The rack: every run this window holds, one row each, at one of three widths.
 *
 * Pure on purpose — no React, no DOM, no measurement of its own — for the same
 * reason `src/panes/dial.ts` is: everything the rack claims about what fits and
 * what it dropped is a function of a **width in pixels** and a readout, so it is
 * checkable without mounting anything. `Rack.tsx` measures and renders; this
 * file holds no pixels of its own and no elements.
 *
 * Two claims live here rather than in the component, because both are the kind
 * that quietly stops being true when somebody edits JSX in a hurry:
 *
 * - **The tier is a function of width, and never of N.** Not of how many runs
 *   there are, not of how long a row's text came out, not of whether one of them
 *   is live. A rack that widened for a fifth run would be the world rearranging
 *   the window, and the whole reason this surface exists is that N runs can be
 *   supervised *without* the window moving under the operator. [`tierFor`] takes
 *   one number and reads nothing else, and the region it measures is sized from
 *   [`RACK_FLOOR`] and a fixed basis rather than from its content.
 * - **The narrow tiers say what they dropped, and draw what is left legibly.**
 *   Rule 10 of the encoding contract forbids putting load-bearing information
 *   behind hover, so a field a tier cannot afford is announced in visible text.
 *   [`SHOWN`] is what the component renders from and [`droppedSentence`] is
 *   derived from that same table, so the sentence cannot come to describe a rack
 *   that is drawing something else. The other half of that claim is that a field
 *   a tier *keeps* arrives whole: a `silence` shrunk to an ellipsis at the
 *   `studs` floor is a field the tier claims and does not draw, which is the
 *   same defect as a sentence that lies. So the narrow tiers say the same facts
 *   in fewer characters — [`phraseAt`] is where the two spellings live — and
 *   `tests/conformance/rack-width.spec.ts` measures a row at each narrow floor
 *   in a browser to check that nothing came out clipped.
 *
 * The third claim — that the one moving thing is the rack's lamp, and that a
 * landing is announced by that ping *ceasing* — is markup and CSS, and is argued
 * in `Rack.tsx` and `Rack.module.css` where it can be enforced.
 */

/**
 * The three widths, narrowest first.
 *
 * Scaffolding words, because the thing is a rack: **bays** is the full width
 * where a row is a sentence with every part in it, **boards** is the working
 * middle, and **studs** is what is left standing when the dial has given nearly
 * everything to the map. There is deliberately no fourth tier meaning *nothing*
 * — see [`RACK_FLOOR`] and [`TIER_FLOORS`].
 */
export type Tier = "studs" | "boards" | "bays";

export const TIERS: readonly Tier[] = ["studs", "boards", "bays"];

/**
 * The narrowest the region is ever laid out at, in pixels.
 *
 * `Rack.module.css` authors this same number as the region's `min-width`, which
 * is what makes *the rack never closes to zero* a property of the layout rather
 * than a hope: past this point the region stops getting narrower and the pane
 * beside it is what gives way. The dial (#52) reads this to know what the
 * terminal side owes the rack at every detent, which is why it is exported from
 * here rather than left in the stylesheet — a floor spelled twice is a floor
 * that drifts.
 *
 * Pixels rather than `rem`, because pixels are the unit the region is measured
 * in. A floor in `rem` and a measurement in pixels agree at the default root
 * size and nowhere else.
 */
export const RACK_FLOOR = 152;

/**
 * The gutter the terminal box keeps to the right of the rack, in pixels.
 *
 * `--s-space-base`, which `src/App.module.css` gives `.terminal` as padding.
 * Box-sizing is `border-box` everywhere, so [`RACK_FLOOR`] already covers the
 * region's own padding and border — but that padding is *outside* the region,
 * on the box the dial hands the pixels to, and a side floored at the region's
 * width alone clips the rack by a gutter at the detent that matters most.
 *
 * A number rather than a token read at runtime because the side it floors is
 * arithmetic in `src/panes/dial.ts`, which measures nothing and reads no
 * stylesheet; `tests/dial.test.ts` pins it against the token so the two cannot
 * drift apart.
 */
export const RACK_GUTTER = 16;

/**
 * What the terminal side owes the rack, in pixels, at every position.
 *
 * The one number the dial reserves and the one number the shell's layout takes
 * out of the map side's cap — spelled once here so the arithmetic and the
 * flexbox cannot disagree. A width `sides()` prints that the layout does not
 * produce is the exact failure every comment in that module exists to prevent.
 */
export const RACK_RESERVE = RACK_FLOOR + RACK_GUTTER;

/**
 * The width the region prefers, in pixels, before anything shrinks it.
 *
 * `Rack.module.css` authors it as `--c-rack-basis: 25rem`, and 25rem is this
 * number at the root size — nothing in this app sets a root `font-size`, so the
 * conversion is the browser default and `tests/rack.test.tsx` pins the two
 * spellings together. It is a preference rather than a measurement, which is why
 * the stylesheet may keep it in `rem` where [`RACK_FLOOR`] may not.
 *
 * Above the `bays` floor on purpose: a region whose preferred width fell inside
 * a narrower tier would have a widest tier that only ever appeared by accident.
 */
export const RACK_BASIS = 400;

/**
 * How wide the region is drawn when the terminal side is this wide.
 *
 * The flexbox, in arithmetic. The terminal box keeps [`RACK_GUTTER`] of its own
 * padding to the region's right; the pane beside the region is `flex: 1 1 0`,
 * so every pixel the line is short comes out of the region and none of it out of
 * the pane, down to [`RACK_FLOOR`] where the region stops giving and the pane
 * gives instead; and the region never grows past [`RACK_BASIS`], because its
 * `flex-grow` is zero.
 *
 * Here rather than in a test because it is what makes *the tier is a function of
 * the terminal side's width* checkable without a browser: [`tierFor`] of this is
 * the tier a detent draws, and the conformance spec measures the same number off
 * the real layout.
 */
export function regionFor(terminalSide: number): number {
  const box = Math.max(0, Math.floor(terminalSide) - RACK_GUTTER);
  return Math.min(RACK_BASIS, Math.max(RACK_FLOOR, box));
}

/**
 * The measured region width at which each tier starts.
 *
 * `studs` floors at zero, and that is the load-bearing entry: a box nobody has
 * laid out yet, a first paint, and every jsdom test all measure zero, and the
 * answer for all three has to be *draw the narrow rack* rather than *draw
 * nothing*. A tier that meant nothing would be the one state in which the rack
 * disappears, and a disappearance is a layout change caused by the world.
 */
export const TIER_FLOORS: Record<Tier, number> = {
  studs: 0,
  boards: 240,
  bays: 380,
};

/**
 * Which tier a region this wide is drawn at. Width, and nothing else.
 *
 * Monotone in width, and that is the non-negotiable part: a wider region may
 * never draw a narrower tier. #56 asks in one clause for "studs at glance", and
 * that clause cannot be honoured by any function of width, because `glance`
 * gives the *map* 0.3 (`src/panes/dial.ts`) and so leaves the terminal side 70%
 * — wider than at `split`, and the widest terminal side there is short of the
 * `terminal` detent itself. The ruling, and the tier each detent draws, is
 * written down in `docs/adr/0025-the-racks-tier-is-a-function-of-width-not-of-n.md`.
 */
export function tierFor(width: number): Tier {
  if (!Number.isFinite(width)) return "studs";
  let tier: Tier = "studs";
  for (const candidate of TIERS) {
    if (width >= TIER_FLOORS[candidate]) tier = candidate;
  }
  return tier;
}

/**
 * What a row is made of, in the order a row is read.
 *
 * The dropped sentence names things in this order too, so there is one sequence
 * to remember rather than two.
 */
export const FIELDS = ["kind", "ticket", "age", "unseen", "silence", "liveness"] as const;

export type Field = (typeof FIELDS)[number];

/**
 * What each tier draws.
 *
 * Which field goes first is an ordering of *what a rack is for*, and it is not
 * for telling you what a run is called: `ticket` and `age` are how you recognise
 * a run you already know about, and they are the two that go. What survives to
 * the narrowest tier is the triple that answers the question this surface exists
 * to answer — whether each run is alive, whether it is progressing and whether
 * it is wedged: `liveness`, `unseen` and `silence`, with `kind` kept beside them
 * because research and work are not supervised the same way.
 *
 * Classifying that silence into quiet-versus-wedged is #50's; this prints the
 * duration and stops.
 */
export const SHOWN: Record<Tier, readonly Field[]> = {
  bays: FIELDS,
  boards: ["kind", "ticket", "unseen", "silence", "liveness"],
  studs: ["kind", "unseen", "silence", "liveness"],
};

export function shows(tier: Tier, field: Field): boolean {
  return SHOWN[tier].includes(field);
}

/** What this tier cannot afford, in reading order. */
export function droppedAt(tier: Tier): readonly Field[] {
  return FIELDS.filter((field) => !shows(tier, field));
}

/**
 * What each dropped field is, in words rather than as a column heading.
 *
 * A narrow rack has no headings left to lose the meaning of, so the sentence has
 * to carry the whole of it.
 */
const DROPPED_WORDS: Record<Field, string> = {
  kind: "what kind of run each one is",
  ticket: "the ticket each run is staked on",
  age: "how long ago each run opened",
  unseen: "how much output is waiting",
  silence: "how long each run has been quiet",
  liveness: "whether each run is still going",
};

/**
 * The tier saying what it dropped, or `null` at the width that dropped nothing.
 *
 * Text, in the flow, under the rack's own heading — never a `title`, never a
 * tooltip. Rule 10 is about disclosure and this is disclosure: an operator
 * reading a studs rack has to be able to tell *this rack is not showing you the
 * ticket* from *this run has no ticket*, and hover cannot be the difference
 * between them.
 */
export function droppedSentence(tier: Tier): string | null {
  const words = droppedAt(tier).map((field) => DROPPED_WORDS[field]);
  if (words.length === 0) return null;
  const listed =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Too narrow to show ${listed}.`;
}

/**
 * What each kind of run is called on a row.
 *
 * `null` — a run the harness was never told the stakes of — is named as the
 * absence it is rather than defaulted to *work*: a row that guessed would be
 * asserting something nobody said. The fixture carries one of these precisely so
 * the guess cannot creep back in unseen.
 */
const KIND_WORDS: Record<NonNullable<RunReadout["kind"]>, string> = {
  work: "work",
  research: "research",
  chart: "charting",
  compose: "composing",
};

export const NO_STAKES = "no stakes recorded";

/** One run, as words. Every field here is already a string a row can print. */
export interface RackRow {
  run: number;
  kind: string;
  /** `#214`, or `null` for a run staked on no ticket at all. */
  ticket: string | null;
  /** How long ago it opened, in `relativeAge`'s words. */
  age: string;
  /** Bytes this run has printed that its terminal has not been handed. */
  unseenBytes: number;
  /** The same count, in words. */
  unseen: string;
  /** The same count again, in the characters a narrow tier can afford: `2.1 KB`. */
  unseenBrief: string;
  /** How long it has been quiet, in `relativeAge`'s words. */
  silence: string;
  /** The same silence, terse enough for a narrow row: `quiet 6m`. */
  silenceBrief: string;
  live: boolean;
  /** `live` or `landed` — printed whether or not anything on screen moves. */
  liveness: string;
}

/**
 * A readout, read as a row.
 *
 * Both ages go through `relativeAge` and neither is phrased here, because one
 * screen may not carry two spellings of *2 minutes ago*: the launcher, the cache
 * stamp and this rack say it the same way, or the words stop meaning a duration
 * and start meaning which surface you happen to be looking at. `now` is a
 * parameter for the reason `useNow` exists — one clock for the window, rather
 * than one per row.
 *
 * **Unseen output is derived and is not a field**: `end - through` is what the
 * run has printed less what its terminal has been handed, and nothing else on
 * the readout means that. `dropped` and `truncated` are the ring's losses and
 * belong to the pane's chrome — a rack that folded them in would be reporting
 * bytes nobody will ever be handed as bytes that are waiting.
 */
export function rowFor(readout: RunReadout, now: number): RackRow {
  const unseenBytes = Math.max(0, readout.end - readout.through);
  return {
    run: readout.run,
    kind: readout.kind === null ? NO_STAKES : KIND_WORDS[readout.kind],
    ticket: readout.ticket === null ? null : `#${readout.ticket}`,
    age: relativeAge(readout.opened, now),
    unseenBytes,
    unseen: unseenBytes === 0 ? "nothing unseen" : `${unseenBytes.toLocaleString()} bytes unseen`,
    unseenBrief: briefBytes(unseenBytes),
    silence: relativeAge(readout.spoke, now),
    silenceBrief: `quiet ${terseAge(readout.spoke, now)}`,
    live: !readout.over,
    liveness: readout.over ? "landed" : "live",
  };
}

/**
 * A byte count in at most seven characters, so a narrow row can hold it.
 *
 * Powers of ten rather than of two, and one decimal place, because the number is
 * read as *how far behind this terminal is* and not as an allocation: `1.2 MB`
 * answers that question and `1,204,880 bytes unseen` — which is what the wide
 * row says — answers it in a hundred and thirty pixels the `studs` floor does
 * not have. The unit ladder stops at `GB` because a run that has printed a
 * terabyte into a ring buffer has other problems.
 */
function briefBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * What one field says on a row at this tier, or `null` when it is not drawn.
 *
 * The whole of a row's wording, in one place the component maps over rather than
 * six literals in JSX — and the reason it is here rather than there is that the
 * *narrow* wordings are load-bearing. A tier's promise is [`SHOWN`], and a rack
 * keeps that promise only if the field arrives whole: the wide row's
 * `last printed 6 minutes ago` is a hundred and forty-five pixels, and at the
 * `studs` floor the row has a hundred and twenty-seven for four fields
 * altogether. Shrunk to fit, it renders as an ellipsis, and an ellipsis is not a
 * field — it is `SHOWN` claiming something the screen does not show, the same
 * defect ADR 0025 lists as *a sentence naming a field the tier is in fact
 * drawing*, arrived at from the other side.
 *
 * So the narrow tiers say the same facts in fewer characters. They are not
 * different facts and they are not rounded further than the wide ones: `2.1 KB`
 * is `2,112 bytes unseen` at one decimal place, `quiet 6m` is
 * `last printed 6 minutes ago` on `terseAge`'s ladder, and `ticket` and `age` —
 * the two that could only be shortened by lying about which run they name — are
 * dropped outright and named in [`droppedSentence`] instead.
 *
 * `null` for a `ticket` a run has none of: a row that printed an empty span
 * would be a tier drawing a field about a run that has nothing to say for it.
 */
export function phraseAt(tier: Tier, row: RackRow, field: Field): string | null {
  if (!shows(tier, field)) return null;
  const wide = tier === "bays";
  switch (field) {
    case "kind":
      return row.kind;
    case "ticket":
      return row.ticket;
    case "age":
      return `opened ${row.age}`;
    case "unseen":
      return wide ? row.unseen : row.unseenBrief;
    case "silence":
      return wide ? `last printed ${row.silence}` : row.silenceBrief;
    case "liveness":
      return row.liveness;
  }
}

/**
 * Every run, in the order the window already holds them.
 *
 * No sort. The readouts arrive in the order the runs were opened and they leave
 * in it, because re-sorting by activity would move a row out from under a
 * pointer for a reason nobody pressed — the rule the region's width is under,
 * applied down the other axis. A landed run keeps its row for the same reason:
 * a row that vanished when a run ended would be a layout change caused by the
 * world, and `endRun` — a press — is the only thing that takes a run out of
 * this list.
 */
export function rowsFor(readouts: readonly RunReadout[], now: number): readonly RackRow[] {
  return readouts.map((readout) => rowFor(readout, now));
}

/** How many are still going — the count the rack's one lamp is spent on. */
export function liveCount(rows: readonly RackRow[]): number {
  return rows.filter((row) => row.live).length;
}
