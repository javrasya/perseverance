import { relativeAge, terseAge } from "../chrome/age";
import type { RunReadout } from "../terminal/runs";
import type { PendingRun } from "./pending";

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
  ask: "asking",
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

/**
 * Whether the lamp pings — the whole of the window's motion ration, decided.
 *
 * #56 rations motion by the *screen* and not by this subtree: at most one
 * animated element however many runs are live. The rack is not the only surface
 * licensed to move — the Route draws a halo on a `claimed` row, the closest
 * thing to liveness the snapshot side has — and a rack that counted only its
 * own children would meet the criterion in a subtree while the delivered window
 * animated two things at once. So the ration is arbitrated here, in one
 * function of two facts, and the shell tells the rack which side of the window
 * holds the licence: `elsewhere` is *the map side is drawn, and the screen's
 * one animation is its to spend*.
 *
 * Three properties this has to keep, and all three are checkable from the
 * arithmetic and its one input — `tests/motion-ration.test.ts` holds them:
 *
 * - **A landing never starts anything.** This is monotone in `live`: a run
 *   ending can only take the ping away, never bring it on, whatever the rest of
 *   the screen is doing. Cessation stays the announcement, which is the clause
 *   the whole arrangement exists for.
 * - **The two licences are never spent at once.** `elsewhere` suppresses this
 *   one outright rather than shortening it, so the count on screen is one or
 *   zero and never two — and the Route's side of it is one element too, drawn
 *   once for the pane by `pingOf` however many rows are claimed.
 * - **Only a press moves `elsewhere`.** The shell derives it from which view is
 *   open, whether the map side is worth a column and whether the view stood
 *   down, and from nothing the snapshot carries. A claim landing on GitHub can
 *   therefore neither stop this lamp nor start it, so a ping that ceases still
 *   means a landing and nothing here ever starts because something ended. It is
 *   held at the source, in `src/App.tsx`, because a boolean cannot say where it
 *   came from.
 *
 * The rack yields rather than the Route while the map side is up, spent licence
 * or not: the Route's halo is a view's own encoding, and an unspent licence
 * lent back would have to be reclaimed on arrival — which is the world moving
 * motion again. What the rack loses is the movement, never the fact — the
 * filled ring and `N of M still running` say the same thing standing still,
 * which is what a `prefers-reduced-motion` window has been reading all along.
 */
export function lampPings(live: number, elsewhere: boolean): boolean {
  return live > 0 && !elsewhere;
}

/* --------------------------------------------------- what has not started --- */

/**
 * The word a waiting entry answers the `liveness` field with.
 *
 * A third word beside `live` and `landed` rather than a shade of either: a
 * queue entry is not a run that has printed nothing yet and it is not a run
 * that ended, and rule 3 wants that difference readable with the colour taken
 * away. The form-level half of it is in `Rack.module.css` — a dashed rule where
 * a run has a solid one — because rule 12 forbids spending motion on it and hue
 * alone would not survive a retheme.
 */
export const WAITING = "waiting";

/** One accepted press that has not started, as words. */
export interface QueuedRow {
  /** The queue entry's identity, and never a run's. See `PendingRun.id`. */
  id: number;
  kind: string;
  /** `#61`. Never `null`: nothing is queued without a ticket to queue it on. */
  ticket: string;
  folder: string;
  /** How long it has been waiting, in `relativeAge`'s words. */
  waited: string;
  /** The word every tier draws, so a row says for itself what it is. */
  liveness: string;
}

/**
 * A queue entry, read as a row.
 *
 * The same clock and the same phrasing as [`rowFor`], for that function's
 * reason: one screen may not carry two spellings of *4 minutes ago*, and a
 * queue entry is drawn directly under the runs it is waiting behind.
 */
export function queuedRowFor(entry: PendingRun, now: number): QueuedRow {
  return {
    id: entry.id,
    kind: KIND_WORDS[entry.kind],
    ticket: `#${entry.ticket}`,
    folder: entry.folder,
    waited: relativeAge(entry.queued, now),
    liveness: WAITING,
  };
}

/**
 * Every entry, in the order the presses were made.
 *
 * No sort, and the same argument [`rowsFor`] carries: the queue arrives in
 * press order because that is the order it will be drained in, and a row that
 * moved for a reason nobody pressed is the defect either way. Here it would be
 * worse than on a run — the position *is* the meaning, since the entry at the
 * top is the one the next landing starts.
 */
export function queuedRowsFor(entries: readonly PendingRun[], now: number): readonly QueuedRow[] {
  return entries.map((entry) => queuedRowFor(entry, now));
}

/**
 * What one field says on a waiting row at this tier, or `null` where the row
 * has nothing to say for it.
 *
 * [`SHOWN`] is still the one table a row is mapped from — a queue entry may not
 * draw a field its tier dropped, or the tier would have come to mean two
 * different racks — but two of those fields are about a run, and a waiting
 * entry has none:
 *
 * - **`unseen`** is `end - through`, and there is no stream. `0 B` is rule 4's
 *   exact failure: an absence rendered as a number, and a number an operator
 *   reads as *this one has printed nothing yet* about a thing that was never
 *   spawned.
 * - **`silence`** is `now - spoke`, and nothing has ever spoken. `quiet 0m`
 *   would report a run behaving itself.
 *
 * So they are not claimed rather than filled in, and the row draws no span for
 * them at all. What the tier promised is still on the screen: the promise is
 * over the rack rather than over each row, which is why
 * `tests/conformance/rack-width.spec.ts` takes the union across rows — the same
 * allowance a run staked on no ticket already relies on.
 */
export function queuedPhraseAt(tier: Tier, row: QueuedRow, field: Field): string | null {
  if (!shows(tier, field)) return null;
  switch (field) {
    case "kind":
      return row.kind;
    case "ticket":
      return row.ticket;
    case "age":
      return `queued ${row.waited}`;
    case "unseen":
    case "silence":
      return null;
    case "liveness":
      return row.liveness;
  }
}

/**
 * What is waiting, said on its own — never folded into `N of M still running`.
 *
 * That sentence counts *runs*, and a queue entry is not one: no run number,
 * nothing executing, nothing for the lamp to be lit by. Adding it to either
 * half would make `M` mean two different things depending on what the ceiling
 * was doing, and a rack saying `4 of 6 still running` with two of the six never
 * spawned is a rack asserting two runs that do not exist. So the count stays
 * runs-only and this stands beside it, saying the other fact plainly.
 */
export function waitingSentence(waiting: number): string | null {
  if (waiting <= 0) return null;
  return waiting === 1
    ? "1 press is waiting to start."
    : `${waiting} presses are waiting to start.`;
}

/**
 * A deferred spawn's refusal, as the one line that will ever report it.
 *
 * The press it came from was accepted and answered minutes ago, so there is no
 * socket left to print it on and no run to print it in: `Pending::announced`
 * hands it over on exactly one emission and drains it as it reads, and the
 * command carries none. Whoever holds it on this side is the whole record. It
 * names the folder as well as the ticket because an issue number is unique
 * inside one repository and this window holds several.
 */
export function refusalLine(entry: PendingRun): string {
  return `#${entry.ticket} in ${entry.folder} was going to start and did not: ${entry.refused}`;
}

/**
 * How many refused sentences the shell holds at once.
 *
 * A labelled guess with a stated basis, in the queue ceiling's manner, and it
 * is a *reading* bound rather than a capacity one. Nothing on this side knows
 * how many refusals a tick can produce — one navigation away can fail every
 * deferred spawn in the queue at once, and the ceiling that bounds *that*
 * number lives in Rust and is deliberately not spelled a second time here (see
 * `pending.ts`). What this number is about is the operator: refusals arrive
 * newest-last in a box a few lines tall, and a list longer than a screenful of
 * folder paths is one whose far end nobody scrolls back to. Eight is about that
 * screenful at the rack's narrowest tier — and it is a guess with a basis, not
 * a settled number.
 *
 * **The oldest go and never the newest, and the drop is named rather than
 * quiet.** An unbounded list is not the safe reading of *nothing may be dropped
 * silently*: it ends with the live rows squeezed to nothing and the dock
 * clipped out of a region that hides its overflow, which loses the sentences
 * as surely as deleting them would. What leaves here has been on screen and
 * unread for as long as it took eight further spawns to fail, and the operator
 * can take any of them off the list by hand before then.
 */
export const REFUSALS_HELD = 8;

/**
 * The refusals to hold, given what is already held and what just spoke.
 *
 * Held rather than shown once, because this is the only delivery there will
 * ever be: `Pending::announced` drains a refusal as it reads it and the command
 * carries none, so an emission that is not kept is a failure nobody will hear
 * about again.
 *
 * De-duplicated by the entry's own id — a re-emission cannot happen today and
 * would be a Rust-side defect if it did, and printing the same failure twice is
 * a worse answer to it than printing it once — and bounded by
 * [`REFUSALS_HELD`], oldest first. The array is returned unchanged when nothing
 * is new, so a tick that only moved the queue does not re-render the list.
 */
export function heldRefusals(
  held: readonly PendingRun[],
  spoken: readonly PendingRun[],
): readonly PendingRun[] {
  const fresh = spoken.filter((one) => !held.some((was) => was.id === one.id));
  if (fresh.length === 0) return held;
  return [...held, ...fresh].slice(-REFUSALS_HELD);
}

/** One held refusal taken off the list by hand, which is the only way one goes. */
export function withoutRefusal(
  held: readonly PendingRun[],
  id: number,
): readonly PendingRun[] {
  return held.filter((one) => one.id !== id);
}
