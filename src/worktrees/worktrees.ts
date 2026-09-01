/**
 * The WebView's view of one folder's worktrees.
 *
 * A hand-written mirror of `perseverance-app`'s `WorktreeEntry`, on exactly the
 * terms `folder.ts` mirrors `FolderReadout`: both sides count the seven keys,
 * because a rename on either is silent on the other. The four unions that hang
 * off it — whose it is, what the working copy said, what this clone knows about
 * the branch, and what became of a call — are mirrored the same way.
 *
 * What crosses is a listing, never a permission. `removable` is a boolean and
 * deliberately not a slip: the `Removal` that authorises a removal has private
 * fields, is minted only by the classifier, and stays in Rust, so a value this
 * side could keep, replay or invent does not exist. The boolean answers one
 * question — draw the button, or draw the reason — and the press hands back a
 * **directory**, which Rust classifies again from a listing taken at that
 * instant.
 *
 * Nothing here is a table. The list is derived from git on every call and
 * written down nowhere, which is why a removal answers with the listing that
 * comes after it rather than with a success this side splices its own row out
 * of: a locally patched list is precisely the stored inventory the whole
 * feature refuses, and it would go stale in the one direction that costs
 * something — showing an offer to remove a directory somebody has since put
 * work in.
 *
 * `worktrees.fixture.json` is what stands behind the panel in a plain browser.
 * A worktree with uncommitted work in it, one whose directory the operator
 * deleted by hand, a lock somebody set, an orphan of a ticket no open map
 * knows: all of them are states JavaScript cannot conjure and a real machine
 * rarely shows on demand, so they are checked in and `?worktrees=<key>` picks
 * one.
 */

import { hasRustBehindIt } from "../snapshot/snapshot";
import fixture from "./worktrees.fixture.json";

/**
 * Whose worktree it is, and which of ours the open map has forgotten.
 *
 * *Ours* is `did this app make it?` and never `does it look like a research
 * worktree?` — the crate is emphatic about the difference, and this side gets
 * the answer rather than a spelling it could re-derive.
 */
export type Whose = { kind: "ours"; ticket: number; orphan: boolean } | { kind: "foreign" };

/** What `git status --porcelain` said in a worktree of ours. */
export type Working =
  | { kind: "clean" }
  /** Every line git printed, verbatim. Never a count — see {@link uncommittedLines}. */
  | { kind: "uncommitted"; lines: string[] }
  /** The registration is there and the directory is not. An ordinary entry. */
  | { kind: "gone" }
  | { kind: "unreadable"; detail: string };

/**
 * How much of the branch this clone has already seen on a remote.
 *
 * Read from remote-tracking refs on this disk, so *unpushed* means *this clone
 * has not seen it pushed*. Nothing on either side of the seam fetches, and no
 * sentence below is allowed to suggest a remote was asked.
 */
export type Publication =
  | { kind: "pushed" }
  | { kind: "unpushed"; commits: number }
  | { kind: "detached" }
  | { kind: "unknown"; detail: string };

/** Absent on a foreign entry, because a foreign worktree is never probed. */
export interface Probed {
  working: Working;
  publication: Publication;
}

/** Seven keys, and the Rust side carries the same seven. */
export interface WorktreeEntry {
  /** Absolute, as git spelled it, and the string a press hands back. */
  path: string;
  /** Absent on a detached or bare worktree — an absence, not an empty string. */
  branch: string | null;
  /** Git's own words. Empty where the operator gave the lock no reason. */
  locked: string | null;
  /** Git's own words for a registration whose directory is not there. */
  prunable: string | null;
  whose: Whose;
  probed: Probed | null;
  /** An offer that existed when this listing was derived, and never a right. */
  removable: boolean;
}

/**
 * What a call came back with: a listing, or Rust's own sentence for why not.
 *
 * A plain mirror of the command's `Result`. The refusal is carried unedited —
 * *git is not on this machine*, *this folder is not a repository*, git's own
 * `hint:` line under a removal it would not make — because every one of them
 * names a fact about this disk that this file has no better words for.
 */
export type Inventory =
  { kind: "listed"; entries: WorktreeEntry[] } | { kind: "refused"; detail: string };

/* ------------------------------------------------------------- loading --- */

/** Both names are the Rust side's; neither is a string this file invented. */
const LIST = "folder_worktrees";
const REMOVE = "remove_worktree";

/**
 * Every worktree of the repository under `path`, derived from git on this call.
 *
 * Two processes per worktree of ours is the price of never keeping one of these
 * lists, and it is the right price: a row drawn from something remembered would
 * offer to delete a directory that has had an hour of unsaved work put in it
 * since.
 */
export async function loadWorktrees(path: string): Promise<Inventory> {
  if (!hasRustBehindIt()) return fixtureWorktrees(chosenFixtureKey());
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return inventoryFrom(await invoke<unknown>(LIST, { path }));
  } catch (refusal) {
    return { kind: "refused", detail: sentenceOf(refusal, LISTING_UNREADABLE) };
  }
}

/**
 * Unregisters one worktree and answers with the listing that comes after it.
 *
 * The directory is the argument and the permission is not. Rust lists the folder
 * again on the press, finds the entry naming this directory, and mints a slip
 * only if every rule still clears it — so a worktree that was clean when the
 * button was drawn and is dirty now refuses, and refuses in the one place that
 * can actually know.
 */
export async function removeWorktree(path: string, worktree: string): Promise<Inventory> {
  if (!hasRustBehindIt()) return { kind: "refused", detail: NOTHING_BEHIND_THIS_WINDOW };
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return inventoryFrom(await invoke<unknown>(REMOVE, { path, worktree }));
  } catch (refusal) {
    return {
      kind: "refused",
      detail: sentenceOf(refusal, REMOVAL_REFUSED_FALLBACK),
    };
  }
}

/* ------------------------------------------------------------- fixture --- */

const DEFAULT_STATE = "everyState";

type FixtureStates = Record<string, unknown>;

function states(): FixtureStates {
  return fixture as FixtureStates;
}

/** Every state the fixture carries, so a test can walk them all. */
export function worktreeFixtureKeys(): string[] {
  return Object.keys(states());
}

/** One named listing, narrowed and therefore copied. */
export function fixtureWorktrees(key: string = DEFAULT_STATE): Inventory {
  const named = states();
  return inventoryFrom(key in named ? named[key] : named[DEFAULT_STATE]);
}

function chosenFixtureKey(): string {
  if (typeof window === "undefined") return DEFAULT_STATE;
  return new URLSearchParams(window.location.search).get("worktrees") ?? DEFAULT_STATE;
}

/* ----------------------------------------------------------- narrowing --- */

/**
 * The fixture is untyped JSON at a boundary and an `invoke` answer is untyped
 * at another, so both are narrowed rather than trusted. Anything that is not a
 * list of records reads as a refusal, which is the reading that claims the
 * least: no entry, and therefore no button.
 */
export function inventoryFrom(raw: unknown): Inventory {
  if (!Array.isArray(raw)) return { kind: "refused", detail: LISTING_UNREADABLE };
  return { kind: "listed", entries: raw.map(entryFrom) };
}

function entryFrom(raw: unknown): WorktreeEntry {
  const record = objectOr(raw);
  return {
    path: typeof record.path === "string" ? record.path : "",
    branch: typeof record.branch === "string" ? record.branch : null,
    // Verbatim, and `""` kept apart from absent: git's two lock states are *no
    // lock* and *a lock whose reason the operator did not give*.
    locked: typeof record.locked === "string" ? record.locked : null,
    prunable: typeof record.prunable === "string" ? record.prunable : null,
    whose: whoseFrom(record.whose),
    probed:
      record.probed === undefined || record.probed === null ? null : probedFrom(record.probed),
    /*
     * Anything but `true` is no offer. An unreadable answer must never draw a
     * button: the fail-safe direction here is the one where nothing is deleted.
     */
    removable: record.removable === true,
  };
}

function whoseFrom(raw: unknown): Whose {
  const record = objectOr(raw);
  if (record.kind !== "ours") return { kind: "foreign" };
  return {
    kind: "ours",
    ticket: countOf(record.ticket),
    orphan: record.orphan === true,
  };
}

function probedFrom(raw: unknown): Probed {
  const record = objectOr(raw);
  return {
    working: workingFrom(record.working),
    publication: publicationFrom(record.publication),
  };
}

function workingFrom(raw: unknown): Working {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "clean":
      return { kind: "clean" };
    case "uncommitted":
      return { kind: "uncommitted", lines: textsOf(record.lines) };
    case "gone":
      return { kind: "gone" };
    default:
      return {
        kind: "unreadable",
        detail: textOr(record.detail, WORKING_UNREADABLE_FALLBACK),
      };
  }
}

function publicationFrom(raw: unknown): Publication {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "pushed":
      return { kind: "pushed" };
    case "unpushed":
      return { kind: "unpushed", commits: countOf(record.commits) };
    case "detached":
      return { kind: "detached" };
    default:
      return {
        kind: "unknown",
        detail: textOr(record.detail, PUBLICATION_UNKNOWN_FALLBACK),
      };
  }
}

/** Rust's `Err` arrives as a string; anything else gets the local sentence. */
function sentenceOf(refusal: unknown, fallback: string): string {
  if (typeof refusal === "string" && refusal.trim() !== "") return refusal.trim();
  if (refusal instanceof Error && refusal.message.trim() !== "") return refusal.message.trim();
  return fallback;
}

function textsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : [];
}

function objectOr(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/* ---------------------------------------------------------- derivation --- */

/**
 * Whether this entry may be offered a button at all.
 *
 * Two conditions where Rust's boolean would have done, and the second one is
 * the point: *foreign is never removed* is a compiler fact over there, and this
 * is the same rule spelled where the button is drawn. A foreign entry that
 * somehow arrived with `removable` set gets no button, no menu and no disabled
 * control to argue with — the read-only rule applied to somebody else's
 * directory, visible.
 */
export function offersRemoval(entry: WorktreeEntry): boolean {
  return entry.whose.kind === "ours" && entry.removable;
}

/**
 * Why there is no offer, in the same order Rust applies its rules — or `null`
 * where there is one.
 *
 * This does not decide anything. The offer was decided in the crate that can
 * see the disk, and the boolean already said what it decided; what is left is
 * telling the operator which of the facts already on this row is the one in the
 * way. Where none of them is, it says only that there is no offer rather than
 * inventing a reason the listing does not carry.
 */
export function whyNoOffer(entry: WorktreeEntry): string | null {
  if (offersRemoval(entry)) return null;
  if (entry.whose.kind === "foreign") return FOREIGN_IS_NOT_OURS;
  if (entry.locked !== null) return LOCKED_IS_A_NO;

  const probed = entry.probed;
  if (probed === null) return NO_OFFER_AND_NO_REASON;

  switch (probed.working.kind) {
    case "uncommitted":
      return UNCOMMITTED_IS_A_NO;
    case "unreadable":
      return `${probed.working.detail} ${UNREADABLE_IS_A_NO}`;
    default:
      break;
  }

  switch (probed.publication.kind) {
    case "unpushed":
      return UNPUSHED_IS_A_NO;
    case "detached":
      return DETACHED_IS_A_NO;
    case "unknown":
      return `${probed.publication.detail} ${UNKNOWN_IS_A_NO}`;
    default:
      return NO_OFFER_AND_NO_REASON;
  }
}

/**
 * Every uncommitted line, verbatim, or nothing.
 *
 * The list rather than its length, everywhere and always: the operator is being
 * told why the directory they wanted gone is staying, and *three changes* does
 * not answer that while `?? notes/scratch.md` does.
 */
export function uncommittedLines(entry: WorktreeEntry): string[] {
  const working = entry.probed?.working;
  return working?.kind === "uncommitted" ? working.lines : [];
}

/** Whose it is, and whether the open map has forgotten the ticket. */
export function whoseLabel(entry: WorktreeEntry): string {
  if (entry.whose.kind === "foreign") return "not this app's";
  return entry.whose.orphan ? `#${entry.whose.ticket} · orphan` : `#${entry.whose.ticket}`;
}

/** The branch, or the absence of one said as an absence. */
export function branchLine(entry: WorktreeEntry): string {
  return entry.branch === null ? "no branch — this worktree is detached" : entry.branch;
}

/** What the working copy said, in one line. The lines themselves are separate. */
export function workingLine(entry: WorktreeEntry): string {
  const working = entry.probed?.working;
  if (working === undefined) return FOREIGN_IS_NOT_ASKED;
  switch (working.kind) {
    case "clean":
      return "nothing uncommitted here";
    case "uncommitted":
      return "uncommitted work is in this directory";
    case "gone":
      return "the directory is not there — only git's registration of it is";
    case "unreadable":
      return working.detail;
  }
}

/**
 * What this clone already knows about the branch.
 *
 * *Knows*, and never *has checked*: the counted commits are the ones no
 * remote-tracking ref on this disk contains, which is a smaller claim than *no
 * remote has them* and the only one anything here is entitled to make.
 */
export function publicationLine(entry: WorktreeEntry): string {
  const publication = entry.probed?.publication;
  if (publication === undefined) return FOREIGN_IS_NOT_ASKED;
  switch (publication.kind) {
    case "pushed":
      return "this clone has already seen every commit of it on a remote";
    case "unpushed":
      return `${publication.commits} ${
        publication.commits === 1 ? "commit" : "commits"
      } on no remote this clone knows about`;
    case "detached":
      return "no branch, so there is nothing that could have been pushed";
    case "unknown":
      return publication.detail;
  }
}

/** Git's own words for a lock the operator set, or `null` where none is set. */
export function lockedLine(entry: WorktreeEntry): string | null {
  if (entry.locked === null) return null;
  return entry.locked === ""
    ? "locked in git, with no reason given"
    : `locked in git: ${entry.locked}`;
}

/** Git's own words for a registration whose directory is gone. */
export function prunableLine(entry: WorktreeEntry): string | null {
  return entry.prunable === null ? null : `git calls this prunable: ${entry.prunable}`;
}

/**
 * The closed state: how many directories, and how many of them this app made.
 *
 * Never how many are removable. A count of offers on a collapsed bar is an
 * invitation to clear them all, and there is no bulk anything here — every
 * removal is one press on one row that was read from git a moment ago.
 */
export function inventorySummary(inventory: Inventory): string {
  if (inventory.kind === "refused") return "nothing could be listed";
  const total = inventory.entries.length;
  if (total === 0) return "no worktrees listed";
  const ours = inventory.entries.filter((entry) => entry.whose.kind === "ours").length;
  return `${total} ${total === 1 ? "worktree" : "worktrees"} · ${ours} this app's`;
}

/* --------------------------------------------------------------- copy --- */

/*
 * Two rules over every sentence below, and both have a test.
 *
 * Nothing here may read as a failure to reach GitHub — no worktree fact is a
 * network fact, and the word *fetch* appears only to say that none happened.
 * And nothing here calls a removal safe, tidy or finished: it says what the
 * command does — one registration, one directory — and leaves the judgement to
 * the operator, who is the only one who knows what is in it.
 */

export const REMOVE_LABEL = "Remove this worktree";

export const LOOK_AGAIN_LABEL = "Look again";

export const REMOVAL_KEEPS_THE_BRANCH =
  "Removing takes the working copy off git's register and deletes that directory. The branch is left exactly where it is, pointing at the same commit: nothing here deletes a branch, and everything that was committed in the directory is still on one.";

export const NOTHING_WAS_FETCHED =
  "Nothing here contacted a remote. Pushed means this clone has already seen those commits on a remote-tracking ref on this disk, so whatever a remote has gained since your last fetch is not in this answer — and neither is anything you pushed from another machine.";

export const LIST_IS_DERIVED =
  "This list is read from git every time it is drawn and is kept nowhere. A row offering a removal is saying what was true when the row was drawn; the press asks git again and refuses if the answer has changed since.";

export const ORPHAN_NOTE =
  "An orphan is one this app made for a ticket the map now open does not have. It is listed here under the same rules as everything else — there is no separate section and no button that clears them together, because a ticket falling out of a map is not evidence about what is in the directory.";

export const FOREIGN_NOTE =
  "Worktrees this app did not make are listed and nothing else. There is no action on them at all — not a greyed-out one — because the rule is that this app does not touch them rather than that it would rather you did not.";

export const FOREIGN_IS_NOT_OURS = "This app did not make this worktree, so it does nothing to it.";

export const FOREIGN_IS_NOT_ASKED = "not asked — this app did not make this worktree";

export const UNCOMMITTED_IS_A_NO =
  "There is uncommitted work in this directory, printed in full below. There is no offer to remove it while that is true, and no confirmation behind which this becomes one.";

export const UNREADABLE_IS_A_NO =
  "So nothing is claimed about what is in this directory, and nothing is offered.";

export const UNPUSHED_IS_A_NO =
  "This branch has commits this clone has not seen on any remote, so removing the directory is not offered.";

export const DETACHED_IS_A_NO =
  "This worktree is on no branch, so there is nothing that could have been pushed and nothing is offered.";

export const UNKNOWN_IS_A_NO =
  "So how much of this branch has been pushed is not known here, and nothing is offered.";

export const LOCKED_IS_A_NO =
  "You locked this worktree in git yourself. The only spelling that removes it anyway is the forcing one, which this app does not say.";

export const NO_OFFER_AND_NO_REASON =
  "There is no offer to remove this one. Nothing on this row says which rule is in the way.";

export const GONE_IS_ORDINARY =
  "The directory is gone and git's registration of it is not. That is an ordinary row here rather than an error, and removing it clears the registration and nothing else.";

export const WORKING_UNREADABLE_FALLBACK =
  "What is uncommitted in this directory could not be read, and no reason came back with it.";

export const PUBLICATION_UNKNOWN_FALLBACK =
  "How much of this branch this clone has seen on a remote could not be read, and no reason came back with it.";

export const LISTING_UNREADABLE =
  "Nothing arrived here that could be read as a worktree listing, so nothing is claimed about this folder.";

export const REMOVAL_REFUSED_FALLBACK =
  "That worktree was not removed, and no reason came back with it.";

export const NOTHING_BEHIND_THIS_WINDOW =
  "There is nothing behind this window that could remove a directory, so nothing was removed. The list below is the checked-in example this app opens with in a plain browser.";

/** The honest limits, in the panel rather than in a document nobody opens. */
export const WORKTREES_CANNOT_TELL_YOU: readonly string[] = [
  "Pushed is read from remote-tracking refs on this disk. A branch you pushed from another machine reads as unpushed here until this clone fetches, and nothing here fetches.",
  "Uncommitted means the tracked changes and untracked files git itself would report. A file your excludes hide is invisible to this list and would go with the directory.",
  "Nothing here says whether the work was merged, reviewed or wanted. It says the commits are on a remote, which is a claim about where the bytes are and not about what anybody thinks of them.",
  "This answer is about the instant it was drawn. Anything at all can happen in these directories between two presses, which is why the press asks git again rather than trusting the row.",
];
