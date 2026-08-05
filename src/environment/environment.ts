/**
 * The WebView's view of the environment harvest.
 *
 * These types mirror `perseverance-app`'s `EnvironmentReadout` exactly, for the
 * same reason `launcher.ts` mirrors `Folder`: one seam rather than two. Both
 * sides count the nine keys, because a rename on either side is a silent
 * breakage on the other and nothing else would notice.
 *
 * What crosses is a readout, never the environment. The names, the values and
 * the token stay in Rust; what arrives here is which shell was asked, what
 * became of the answer, the verbatim `PATH`, and counts. There is nothing in
 * this module that could write any of it down, and nothing in it that knows how
 * to open a socket — every sentence below is a fact about this machine.
 *
 * `environment.fixture.json` is what stands behind the panel in a plain
 * browser. A harvest is a state JavaScript cannot conjure: you cannot run a
 * login shell from a WebView, and you certainly cannot make one hang. So the
 * seven states worth looking at are checked in, and `?env=<key>` picks one.
 */

import { hasRustBehindIt } from "../snapshot/snapshot";
import fixture from "./environment.fixture.json";

/** Where the harvest got to. `harvesting` is what the first paint renders. */
export type HarvestState =
  | { kind: "harvesting" }
  | { kind: "harvested" }
  | { kind: "inherited"; detail: string };

/** Which interpreter was asked, and with which flags. Never the payload. */
export type WireShell =
  | { kind: "loginShell"; program: string; flags: string[] }
  | { kind: "powerShell"; program: string; flags: string[] }
  | { kind: "none" };

/**
 * Classified by content rather than by platform, and never a verdict: on
 * Windows this stream carries a non-empty baseline with no profile at all.
 */
export type StderrKind = "empty" | "text" | "clixml";

export interface WireStderr {
  kind: StderrKind;
  /**
   * How many bytes of stderr were read, after the 4 MiB cap in
   * `Bounds::stderr_cap` — the same bytes `text` is the decode of, and never
   * more than that cap.
   *
   * Not `text.length`, which counts UTF-16 units, and not recomputable from
   * `text` at all: `text` is a lossy decode, and each invalid subsequence
   * became a 3-byte U+FFFD on the way. So `bytes` can only be less than or
   * equal to the UTF-8 length of `text`, never above it.
   */
  bytes: number;
  text: string;
}

/** The outcome of asking `gh` for a token. Never the token. */
export type TokenState =
  | { kind: "acquired" }
  | { kind: "notAttempted" }
  | { kind: "refused"; detail: string };

/**
 * What the parser found either side of the block, and what it threw away
 * inside it. A harvest that dropped nine records is a different fact from one
 * that dropped none, and neither of them is a failure.
 */
export interface Tally {
  recordsSeen: number;
  recordsDropped: number;
  duplicatesDropped: number;
  bytesBeforeFrame: number;
  bytesAfterFrame: number;
  extraOpeningMarks: number;
}

/** Nine keys, and the Rust side asserts the same nine. */
export interface EnvironmentReadout {
  harvest: HarvestState;
  shell: WireShell;
  /** Verbatim and unsplit. Splitting it is a guess; see `pathEntries`. */
  path: string | null;
  pathSource: PathSource;
  variableCount: number;
  elapsedMs: number;
  tally: Tally;
  stderr: WireStderr;
  token: TokenState;
}

export type PathSource = "harvest" | "inherited" | "none";

/* ------------------------------------------------------------- loading --- */

/** Both names are the Rust side's; neither is a string this file invented. */
const COMMAND = "environment";
const EVENT = "environment";

/**
 * The state the first paint renders. Nothing has been asked yet, so no shell is
 * named and there is no `PATH` to show — which is also exactly what the shell
 * seeds its own state with.
 */
export function stillHarvesting(): EnvironmentReadout {
  return {
    harvest: { kind: "harvesting" },
    shell: { kind: "none" },
    path: null,
    pathSource: "none",
    variableCount: 0,
    elapsedMs: 0,
    tally: {
      recordsSeen: 0,
      recordsDropped: 0,
      duplicatesDropped: 0,
      bytesBeforeFrame: 0,
      bytesAfterFrame: 0,
      extraOpeningMarks: 0,
    },
    stderr: { kind: "empty", bytes: 0, text: "" },
    token: { kind: "notAttempted" },
  };
}

/**
 * Asks the shell what the harvest came to.
 *
 * The call cannot be rejected — the command's return type carries no `Result`,
 * which is how a failed harvest stays a condition rather than something the app
 * is having. A build with no such command at all is the one way this can throw,
 * and that reads as an inherited environment, because it is one.
 */
export async function loadEnvironment(): Promise<EnvironmentReadout> {
  if (!hasRustBehindIt()) {
    return fixtureState(chosenFixtureKey());
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<EnvironmentReadout>(COMMAND);
  } catch {
    return readoutFrom(undefined);
  }
}

/**
 * The settled readout, whenever it arrives.
 *
 * **Subscribe before you ask.** A macOS harvest takes about 187 ms and can
 * settle before the WebView exists, in which case the emit lands on nobody and
 * the answer only ever comes back from the command; a Windows profile takes
 * 1.5–1.9 s and the command answers `harvesting` long before the event fires.
 * Both paths deliver the same value and a second identical readout changes
 * nothing, so the only ordering that loses is asking first.
 *
 * Returns the way to stop listening, because a subscription that outlives the
 * component it belongs to is a leak. A browser subscribes to nothing: you
 * cannot run a login shell from JavaScript, so there is nothing to be told.
 */
export async function watchEnvironment(
  onSettled: (readout: EnvironmentReadout) => void,
): Promise<() => void> {
  if (!hasRustBehindIt()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<EnvironmentReadout>(EVENT, ({ payload }) => onSettled(payload));
}

/**
 * Which of two arrivals to keep.
 *
 * The command and the event race by design, and the command may well answer
 * `harvesting` after the event has already delivered the settled readout. A
 * readout that went back to *harvesting* would be a harvest this app is not
 * taking, so it does not.
 */
export function settledOver(
  current: EnvironmentReadout,
  arriving: EnvironmentReadout,
): EnvironmentReadout {
  const backwards =
    arriving.harvest.kind === "harvesting" && current.harvest.kind !== "harvesting";
  return backwards ? current : arriving;
}

/* ------------------------------------------------------------- fixture --- */

/**
 * The state a plain browser shows unless `?env=<key>` says otherwise. You
 * cannot fail a harvest from JavaScript, so which unconjurable state the
 * preview renders is a query parameter the shell ignores entirely.
 */
const DEFAULT_STATE = "harvested";

type FixtureStates = Record<string, unknown>;

function states(): FixtureStates {
  return fixture as FixtureStates;
}

/** Every state the fixture carries, so a test can walk them all. */
export function fixtureKeys(): string[] {
  return Object.keys(states());
}

/**
 * One named state, narrowed and therefore copied: everything below builds new
 * objects, so the preview cannot scribble on the imported JSON and change what
 * the next reader sees.
 */
export function fixtureState(key: string = DEFAULT_STATE): EnvironmentReadout {
  const named = states();
  return readoutFrom(key in named ? named[key] : named[DEFAULT_STATE]);
}

function chosenFixtureKey(): string {
  if (typeof window === "undefined") return DEFAULT_STATE;
  return new URLSearchParams(window.location.search).get("env") ?? DEFAULT_STATE;
}

/* ------------------------------------------------------------ narrowing --- */

/**
 * The fixture is untyped JSON at a boundary, so it is narrowed rather than
 * trusted. Anything unrecognised reads as an inherited environment, which is
 * the reading that asks the least of anyone: it claims no harvest happened and
 * shows what the app is running on instead.
 */
export function readoutFrom(raw: unknown): EnvironmentReadout {
  if (typeof raw !== "object" || raw === null) return unreadable();
  const record = raw as Record<string, unknown>;

  return {
    harvest: harvestFrom(record.harvest),
    shell: shellFrom(record.shell),
    // Verbatim: not trimmed, not defaulted to the empty string. A `PATH` is
    // evidence, and the one thing that must survive this crossing untouched.
    path: typeof record.path === "string" ? record.path : null,
    pathSource: pathSourceFrom(record.pathSource),
    variableCount: countOf(record.variableCount),
    elapsedMs: countOf(record.elapsedMs),
    tally: tallyFrom(record.tally),
    stderr: stderrFrom(record.stderr),
    token: tokenFrom(record.token),
  };
}

function unreadable(): EnvironmentReadout {
  return { ...stillHarvesting(), harvest: { kind: "inherited", detail: READOUT_UNREADABLE } };
}

function harvestFrom(raw: unknown): HarvestState {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "harvesting":
      return { kind: "harvesting" };
    case "harvested":
      return { kind: "harvested" };
    case "inherited":
      return { kind: "inherited", detail: textOr(record.detail, READOUT_UNREADABLE) };
    default:
      return { kind: "inherited", detail: READOUT_UNREADABLE };
  }
}

function shellFrom(raw: unknown): WireShell {
  const record = objectOr(raw);
  const kind = textOr(record.kind, "");
  if (kind !== "loginShell" && kind !== "powerShell") return { kind: "none" };
  return {
    kind,
    program: textOr(record.program, "unknown"),
    flags: Array.isArray(record.flags)
      ? record.flags.filter((one): one is string => typeof one === "string")
      : [],
  };
}

function stderrFrom(raw: unknown): WireStderr {
  const record = objectOr(raw);
  const kind = textOr(record.kind, "");
  return {
    kind: kind === "text" || kind === "clixml" ? kind : "empty",
    bytes: countOf(record.bytes),
    // Verbatim, for the same reason the `PATH` is: it is the only artifact a
    // profile that was refused ever leaves behind.
    text: typeof record.text === "string" ? record.text : "",
  };
}

function tokenFrom(raw: unknown): TokenState {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "acquired":
      return { kind: "acquired" };
    case "refused":
      return { kind: "refused", detail: textOr(record.detail, TOKEN_REFUSED_FALLBACK) };
    default:
      return { kind: "notAttempted" };
  }
}

function tallyFrom(raw: unknown): Tally {
  const record = objectOr(raw);
  return {
    recordsSeen: countOf(record.recordsSeen),
    recordsDropped: countOf(record.recordsDropped),
    duplicatesDropped: countOf(record.duplicatesDropped),
    bytesBeforeFrame: countOf(record.bytesBeforeFrame),
    bytesAfterFrame: countOf(record.bytesAfterFrame),
    extraOpeningMarks: countOf(record.extraOpeningMarks),
  };
}

function pathSourceFrom(raw: unknown): PathSource {
  const named = textOr(raw, "");
  return named === "harvest" || named === "inherited" ? named : "none";
}

function objectOr(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** A count is a count: nothing negative, nothing fractional, nothing infinite. */
function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/* ---------------------------------------------------------- derivation --- */

/**
 * What stands where a fact will be, and never the word *failed*. A readout
 * that has not arrived yet is not a readout that went wrong.
 */
const NOTHING_YET = "—";

/** The command line as it was run: program then flags, never the payload. */
export function shellLine(readout: EnvironmentReadout): string {
  if (readout.shell.kind === "none") return NOTHING_YET;
  return [readout.shell.program, ...readout.shell.flags].join(" ");
}

/**
 * The verbatim `PATH`, split for reading only.
 *
 * Which character separates two entries is a guess — a `;` anywhere means the
 * Windows one, because a Windows `PATH` is full of `:` and cannot be split on
 * it — and an entry that contains the separator is precisely where the guess
 * misleads. The unsplit string is shown above this and is the evidence.
 */
export function pathEntries(readout: EnvironmentReadout): string[] {
  const path = readout.path;
  if (path === null || path === "") return [];
  const separator = path.includes(";") ? ";" : ":";
  return path.split(separator).filter((entry) => entry !== "");
}

/** The summary the footer carries, in the footer's own mono voice. */
export function footerSummary(readout: EnvironmentReadout): string {
  if (readout.harvest.kind === "harvesting") return `harvesting · ${NOTHING_YET}`;
  return `${shellLine(readout)} · ${readout.harvest.kind} · ${readout.variableCount} vars`;
}

/** What the harvest cost and carried. An em dash until it has answered. */
export function factsLine(readout: EnvironmentReadout): string {
  if (readout.harvest.kind === "harvesting") {
    return `${NOTHING_YET} variables · ${NOTHING_YET} ms`;
  }
  const source =
    readout.pathSource === "harvest"
      ? "PATH from the harvest"
      : readout.pathSource === "inherited"
        ? "PATH as this app was started with"
        : "no PATH at all";
  return `${readout.variableCount} variables · ${readout.elapsedMs} ms · ${source}`;
}

/* --------------------------------------------------------------- copy --- */

/*
 * Every sentence below names something true of this machine: which shell was
 * asked, what it wrote, and what became of the answer. None of them may read as
 * a failure to talk to GitHub, because the fix for that is a different fix —
 * enforced by tests/environment.test.ts, which greps this copy for network
 * vocabulary exactly as the launcher's does.
 *
 * Two further rules, and both have a test: a harvest that worked is never
 * called a *correct* one, because resolvable is not spawnable and spawnable is
 * not correct; and a harvest that did not close is never blamed on the
 * operator's start-up files, because a drain in the wrong order deadlocks
 * indistinguishably from a profile that is genuinely still working, and one of
 * those two is our own bug.
 */

export function harvestHeadline(readout: EnvironmentReadout): string {
  switch (readout.harvest.kind) {
    case "harvesting":
      return "Still harvesting";
    case "harvested":
      return "Harvested";
    case "inherited":
      return "Inherited";
  }
}

export function describeHarvest(readout: EnvironmentReadout): string {
  switch (readout.harvest.kind) {
    case "harvesting":
      return HARVESTING_COPY;
    case "harvested":
      return HARVESTED_COPY;
    case "inherited":
      // The condition wrote the reason; this only adds what became of it.
      return `${ended(readout.harvest.detail, HARVEST_DISCARDED_FALLBACK)} ${INHERITED_COUNSEL}`;
  }
}

export const HARVESTING_COPY =
  "The login shell has been asked and has not answered yet. A Windows profile takes a second or two before it says anything at all, so this is what start-up looks like.";

/*
 * No claim that anything is *correct*, *ready* or *working*: a `PATH` that
 * resolves a command says nothing about whether that command's own interpreter
 * resolves at the moment it is run, and a version pin to something uninstalled
 * starts cleanly under the wrong one. This is a readout, and it says what was
 * read.
 */
export const HARVESTED_COPY =
  "The login shell answered, and this app is using what it sent back for as long as it is open. It is asked again the next time the app starts, so nothing here is a record of how this machine used to be.";

export const INHERITED_COUNSEL =
  "The app is running on the environment it was started with. Nothing was changed and nothing was written down.";

export const HARVEST_DISCARDED_FALLBACK =
  "The harvest did not come back with an environment, and no reason came back with it.";

export const READOUT_UNREADABLE =
  "Nothing arrived here that could be read as a readout, so what is shown is the environment this app was started with.";

/**
 * Why both flags are there, in the operator's own terms.
 *
 * Measured on this machine, from the launchd stub, against a 159-line rc:
 * `-lc` resolves `gh` and loses `node`; `-ic` resolves `node` and loses `gh`,
 * because homebrew's directory is added only by the login `path_helper`. Each
 * single flag brings back a plausible environment missing exactly what the
 * other one carries, which is why neither is dropped.
 */
export const LOGIN_FLAGS_NOTE =
  "The login and interactive flags are both there on purpose. Either one alone brings back an environment that looks right and is not: on this machine the login flag alone finds gh and loses node, and the interactive flag alone finds node and loses gh.";

export const POWERSHELL_PROFILE_NOTE =
  "Your own PowerShell profile runs. That is the point, and it is why the flag that would skip it is not here.";

export const NO_SHELL_NAMED =
  "The environment this app was started with names no shell, and nothing here guesses at one: a guess would run start-up files nobody asked this app to run.";

export const SHELL_NOT_SETTLED_YET =
  "Which shell is asked, and with which flags, is settled by the harvest itself. It has not answered yet.";

export function shellNote(readout: EnvironmentReadout): string {
  if (readout.harvest.kind === "harvesting") return SHELL_NOT_SETTLED_YET;
  switch (readout.shell.kind) {
    case "loginShell":
      return LOGIN_FLAGS_NOTE;
    case "powerShell":
      return POWERSHELL_PROFILE_NOTE;
    case "none":
      return readout.harvest.kind === "inherited"
        ? ended(readout.harvest.detail, NO_SHELL_NAMED)
        : NO_SHELL_NAMED;
  }
}

/**
 * What contamination left behind, or nothing at all.
 *
 * A record that was dropped is indistinguishable from a variable the operator
 * does not have — the count can say how many, never which — so this says how
 * many and stops there.
 */
export function describeContamination(readout: EnvironmentReadout): string | null {
  const dropped = readout.tally.recordsDropped;
  if (dropped === 0) return null;
  const plural = dropped === 1 ? "record" : "records";
  const was = dropped === 1 ? "was" : "were";
  return `${dropped} ${plural} inside the block did not look like a variable and ${was} left out. Something other than the shell was writing while it answered — and a record left out is indistinguishable from a variable you do not have.`;
}

export function tokenLabel(readout: EnvironmentReadout): string {
  switch (readout.token.kind) {
    case "acquired":
      return "acquired";
    case "notAttempted":
      return "not asked";
    case "refused":
      return ended(readout.token.detail, TOKEN_REFUSED_FALLBACK);
  }
}

export const TOKEN_REFUSED_FALLBACK = "gh was asked for a token and gave none.";

export const TOKEN_NOTE =
  "Asked for with gh auth token, inside the environment above, and held for as long as this app is open. It is asked for again next launch and written down nowhere — which is why this line names an outcome and shows no value.";

/*
 * Verbatim stderr looks broken, and the copy above it says so rather than
 * tidying it into something that is no longer evidence. On Windows the stream
 * carries a non-empty baseline with no profile at all, hard-wrapped mid-word
 * before it is serialised, so its presence is never a verdict about anything.
 */
export const STDERR_NOTE =
  "Shown exactly as it arrived. On Windows this is never empty, even with no profile at all, and it is wrapped mid-word before it gets here — so it will look odd, and there is nothing in it to read a verdict from.";

export const PATH_SPLIT_NOTE =
  "Split below for reading only. Where one entry ends and the next begins is a guess about the separator, and an entry containing that character is exactly where the guess misleads. The line above is what arrived.";

/**
 * The honest limits, in the panel rather than in a document nobody opens. The
 * verbatim `PATH` above them exists partly so an operator *could* notice a
 * degradation that nothing will tell them about.
 */
export const CANNOT_TELL_YOU: readonly string[] = [
  "A profile that stops half-way still writes a complete-looking block: both marks, a plausible number of variables, and a stderr no different from having no profile at all. Nothing here can see the difference.",
  "A policy that declines to run your profile looks exactly like not having one. The harvest quietly becomes the environment this app was started with, and the PATH above is the only place you could notice.",
  "A command this PATH resolves can still fail at the moment it is run: a shim whose own interpreter is not on this PATH dies at exec, and no PATH can tell you that in advance.",
  "A version pin to something that is not installed starts the wrong interpreter cleanly, with nothing on either stream. This readout is at its quietest exactly where that danger is.",
];

/** The condition's own sentence, ended, so ours can follow it. */
function ended(said: string, fallback: string): string {
  const trimmed = said.trim();
  if (trimmed === "") return fallback;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
