/**
 * The WebView's view of one folder's resolution.
 *
 * A hand-written mirror of `perseverance-app`'s `FolderReadout`, on exactly the
 * terms `environment.ts` mirrors the app-global one: both sides count the twelve
 * keys, because a rename on either is silent on the other. The four unions that
 * hang off it are mirrored the same way.
 *
 * What crosses is a readout, never an environment. Which shell ran in this
 * folder, what became of the answer, the folder's own verbatim `PATH`, which
 * absolute program each adapter resolved to, what its declared probes said, and
 * which override is in force. No variable, no value, no token.
 *
 * Resolution has two tiers here and no third one: the folder's harvested
 * environment, and an override the operator typed. Nothing in this file names a
 * directory, and nothing in Rust does either — a candidate list that knew the
 * usual install locations would diverge, silently, from what the operator's own
 * shell resolves.
 *
 * `folder.fixture.json` is what stands behind the panel in a plain browser. A
 * folder whose harvest was discarded, a policy that declined a profile, and a
 * CLI that is nowhere on a `PATH` are all states JavaScript cannot conjure, so
 * they are checked in and `?folder=<key>` picks one.
 */

import { hasRustBehindIt } from "../snapshot/snapshot";
import fixture from "./folder.fixture.json";
import {
  degradationFrom,
  type DegradationState,
  type HarvestState,
  type PathSource,
  type WireShell,
  type WireStderr,
} from "./environment";

/*
 * Re-exported rather than written twice. The split of a `PATH` for reading, the
 * sentence that says the split is a guess, and the one degradation this app can
 * name are all the same facts about the same kind of value — a second copy here
 * would be a second account of them, free to drift.
 */
export {
  degradationHeadline,
  degradationNote,
  pathEntries,
  PATH_SPLIT_NOTE,
  STDERR_NOTE,
  type DegradationState,
} from "./environment";

/** Which of the two tiers answered. */
export type ResolutionOrigin = "candidate" | "override";

/**
 * Which scope the operator chose, by what they typed. Named by Rust and never
 * predicted here: the rule is `Environment::resolve`'s and the reading is
 * `perseverance_agent::Scope`'s, and the two are pinned to each other by a test
 * in `crates/app` — the one crate allowed to name both.
 */
export type OverrideScope = "followsTheFolder" | "pinnedGlobally";

/**
 * The **absolute path** is the headline fact. It is the only visible form a
 * version pin has: a bare name that follows a pin resolves to a different
 * absolute path in two folders, and that difference is what says which
 * interpreter this folder is about to run under.
 */
export type Resolution =
  | { kind: "resolved"; name: string; program: string; from: ResolutionOrigin }
  /** Only the names tried. The shell, the harvest and the PATH are top-level. */
  | { kind: "notFound"; names: string[] };

export type ProbeOutcome =
  | { kind: "answered"; status: number | null; line: string }
  | { kind: "notOnThisPath" }
  | { kind: "didNotRun"; detail: string };

export interface ProbeReading {
  program: string;
  args: string[];
  outcome: ProbeOutcome;
}

export interface AdapterReading {
  id: string;
  resolution: Resolution;
  probes: ProbeReading[];
}

export type OverrideState =
  | { kind: "none" }
  | { kind: "inUse"; argv: string[]; scope: OverrideScope }
  /** Written nowhere, and still in force for this run. */
  | { kind: "notRemembered"; argv: string[]; detail: string }
  /** Decidable from the vector alone. Nothing changed. */
  | { kind: "refused"; detail: string };

/** Twelve keys, and the Rust side asserts the same twelve. */
export interface FolderReadout {
  /** The path as it was asked for, unchanged. */
  folder: string;
  /** The absolute directory the child was given, which is also the cache key. */
  spawnDirectory: string;
  harvest: HarvestState;
  shell: WireShell;
  /** Verbatim and unsplit. This folder's own PATH, which is the whole point. */
  path: string | null;
  pathSource: PathSource;
  variableCount: number;
  elapsedMs: number;
  stderr: WireStderr;
  degradation: DegradationState;
  adapters: AdapterReading[];
  override: OverrideState;
}

/* ------------------------------------------------------------- loading --- */

/** Every name is the Rust side's; none is a string this file invented. */
const READ = "folder_environment";
const AGAIN = "retry_folder_environment";
const SET_OVERRIDE = "use_override";
const CLEAR_OVERRIDE = "clear_override";

/**
 * This folder's resolution.
 *
 * The call cannot be rejected — the command's return type carries no `Result`,
 * which is how a missing CLI stays a reading rather than something the app is
 * having. A build with no such command at all is the one way this can throw,
 * and that reads as a folder nothing has been read for yet.
 */
export async function loadFolderEnvironment(path: string): Promise<FolderReadout> {
  if (!hasRustBehindIt()) return fixtureFolder(chosenFixtureKey(), path);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<FolderReadout>(READ, { path });
  } catch {
    return readoutFrom(undefined, path);
  }
}

/**
 * The operator's explicit ask, and the only thing that forgets.
 *
 * It harvests this folder again and then looks again. No clock and nothing
 * watching the folder: the dangerous case is a version pin that has not changed
 * while the set of installed things has, which no watcher over a folder can see
 * and a duration would only re-take at random.
 */
export async function retryFolderEnvironment(path: string): Promise<FolderReadout> {
  if (!hasRustBehindIt()) return fixtureFolder(chosenFixtureKey(), path);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<FolderReadout>(AGAIN, { path });
  } catch {
    return readoutFrom(undefined, path);
  }
}

/**
 * Sets the override and resolves again against the environment already in hand.
 *
 * Not a harvest: an override is a different answer to *which program*, not a
 * claim that this folder's environment has changed.
 */
export async function useOverride(path: string, argv: string[]): Promise<FolderReadout> {
  if (!hasRustBehindIt()) return previewOverride(path, argv);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<FolderReadout>(SET_OVERRIDE, { path, argv });
  } catch {
    return readoutFrom(undefined, path);
  }
}

export async function clearOverride(path: string): Promise<FolderReadout> {
  if (!hasRustBehindIt()) return fixtureFolder(chosenFixtureKey(), path);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<FolderReadout>(CLEAR_OVERRIDE, { path });
  } catch {
    return readoutFrom(undefined, path);
  }
}

/* ------------------------------------------------------------- fixture --- */

const DEFAULT_STATE = "resolved";

type FixtureStates = Record<string, unknown>;

function states(): FixtureStates {
  return fixture as FixtureStates;
}

/** Every state the fixture carries, so a test can walk them all. */
export function folderFixtureKeys(): string[] {
  return Object.keys(states());
}

/**
 * One named state, narrowed and therefore copied: everything below builds new
 * objects, so the preview cannot scribble on the imported JSON.
 */
export function fixtureFolder(key: string = DEFAULT_STATE, folder?: string): FolderReadout {
  const named = states();
  return readoutFrom(key in named ? named[key] : named[DEFAULT_STATE], folder);
}

function chosenFixtureKey(): string {
  if (typeof window === "undefined") return DEFAULT_STATE;
  return new URLSearchParams(window.location.search).get("folder") ?? DEFAULT_STATE;
}

/**
 * What a browser shows for an override it cannot actually set.
 *
 * The scope named here is the preview's own guess at a rule Rust owns, and it
 * is reachable only when there is no Rust behind the window. The shipped path
 * never predicts a scope: it shows the one that came back.
 */
function previewOverride(folder: string, argv: string[]): FolderReadout {
  const program = argv[0] ?? "";
  if (program.trim() === "") {
    /*
     * A refusal changes nothing, so nothing about the folder changes either:
     * the state that was on screen comes back, carrying the refusal. Swapping
     * in the overridden fixture here would have made a vector naming no program
     * look like a fix that worked, which is the one reading a refusal must
     * never produce — and it is what the shipped path does, where `use_override`
     * re-reads the folder against the override that was already in force.
     */
    const unchanged = fixtureFolder(chosenFixtureKey(), folder);
    return { ...unchanged, override: { kind: "refused", detail: OVERRIDE_REFUSED_FALLBACK } };
  }
  const base = fixtureFolder("overridden", folder);
  const pinned = program.includes("/") || program.includes("\\") || /^[A-Za-z]:/.test(program);
  return {
    ...base,
    override: { kind: "inUse", argv, scope: pinned ? "pinnedGlobally" : "followsTheFolder" },
    adapters: base.adapters.map((adapter) => ({
      ...adapter,
      resolution: { kind: "resolved", name: program, program, from: "override" },
    })),
  };
}

/* ----------------------------------------------------------- narrowing --- */

/**
 * The fixture is untyped JSON at a boundary, so it is narrowed rather than
 * trusted. Anything unrecognised reads as a folder whose harvest was discarded
 * and whose adapter was not found, which is the reading that claims the least.
 */
export function readoutFrom(raw: unknown, folder?: string): FolderReadout {
  const record = objectOr(raw);
  return {
    folder: typeof record.folder === "string" ? record.folder : (folder ?? ""),
    spawnDirectory: typeof record.spawnDirectory === "string" ? record.spawnDirectory : "",
    harvest: harvestFrom(record.harvest),
    shell: shellFrom(record.shell),
    // Verbatim: not trimmed, not defaulted to the empty string. A `PATH` is
    // evidence, and the one thing that must survive this crossing untouched.
    path: typeof record.path === "string" ? record.path : null,
    pathSource: pathSourceFrom(record.pathSource),
    variableCount: countOf(record.variableCount),
    elapsedMs: countOf(record.elapsedMs),
    stderr: stderrFrom(record.stderr),
    degradation: degradationFrom(record.degradation),
    adapters: Array.isArray(record.adapters) ? record.adapters.map(adapterFrom) : [],
    override: overrideFrom(record.override),
  };
}

function harvestFrom(raw: unknown): HarvestState {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "harvesting":
      return { kind: "harvesting" };
    case "harvested":
      return { kind: "harvested" };
    default:
      return { kind: "inherited", detail: textOr(record.detail, FOLDER_UNREADABLE) };
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
    text: typeof record.text === "string" ? record.text : "",
  };
}

function adapterFrom(raw: unknown): AdapterReading {
  const record = objectOr(raw);
  return {
    id: textOr(record.id, "unknown"),
    resolution: resolutionFrom(record.resolution),
    probes: Array.isArray(record.probes) ? record.probes.map(probeFrom) : [],
  };
}

function resolutionFrom(raw: unknown): Resolution {
  const record = objectOr(raw);
  if (textOr(record.kind, "") === "resolved") {
    return {
      kind: "resolved",
      name: textOr(record.name, "unknown"),
      program: textOr(record.program, "unknown"),
      from: record.from === "override" ? "override" : "candidate",
    };
  }
  return { kind: "notFound", names: textsOf(record.names) };
}

function probeFrom(raw: unknown): ProbeReading {
  const record = objectOr(raw);
  return {
    program: textOr(record.program, "unknown"),
    args: textsOf(record.args),
    outcome: probeOutcomeFrom(record.outcome),
  };
}

function probeOutcomeFrom(raw: unknown): ProbeOutcome {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "answered":
      return {
        kind: "answered",
        status: typeof record.status === "number" ? Math.trunc(record.status) : null,
        // Not defaulted to a sentence: a probe that printed nothing printed
        // nothing, and that is a different fact from one that did not run.
        line: typeof record.line === "string" ? record.line : "",
      };
    case "didNotRun":
      return { kind: "didNotRun", detail: textOr(record.detail, PROBE_DID_NOT_RUN_FALLBACK) };
    default:
      return { kind: "notOnThisPath" };
  }
}

function overrideFrom(raw: unknown): OverrideState {
  const record = objectOr(raw);
  switch (textOr(record.kind, "")) {
    case "inUse":
      return {
        kind: "inUse",
        argv: textsOf(record.argv),
        scope: record.scope === "pinnedGlobally" ? "pinnedGlobally" : "followsTheFolder",
      };
    case "notRemembered":
      return {
        kind: "notRemembered",
        argv: textsOf(record.argv),
        detail: textOr(record.detail, OVERRIDE_NOT_REMEMBERED_FALLBACK),
      };
    case "refused":
      return { kind: "refused", detail: textOr(record.detail, OVERRIDE_REFUSED_FALLBACK) };
    default:
      return { kind: "none" };
  }
}

function pathSourceFrom(raw: unknown): PathSource {
  const named = textOr(raw, "");
  return named === "harvest" || named === "inherited" ? named : "none";
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

/* -------------------------------------------------------- what to type --- */

/**
 * The operator's typed override, as an argument vector.
 *
 * An argv vector rather than a path, because a path string cannot say
 * `node /opt/claude/cli.js` — and an operator whose install is a shim has no
 * single file to point at that is also a program this app will start.
 *
 * Split on whitespace, with double quotes grouping, and nothing else: no shell
 * expansion, no backslash escaping, no single quotes. A Windows path is full of
 * backslashes and treating them as escapes would eat them. What this produced is
 * shown back before it is used, which is the whole of the defence against a
 * split that surprised somebody.
 */
export function argvFrom(text: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) argv.push(current);

  return argv;
}

/* ---------------------------------------------------------- derivation --- */

const NOTHING_YET = "—";

/** True when any adapter resolved to nothing on this folder's PATH. */
export function missingCli(readout: FolderReadout): boolean {
  return readout.adapters.some((adapter) => adapter.resolution.kind === "notFound");
}

/** Every name tried, across every adapter, in the order they were tried. */
export function namesTried(readout: FolderReadout): string[] {
  return readout.adapters.flatMap((adapter) =>
    adapter.resolution.kind === "notFound" ? adapter.resolution.names : [],
  );
}

/**
 * What an adapter resolved to. The absolute path and nothing else, because that
 * is the fact that says which interpreter this folder runs under.
 */
export function resolutionLine(adapter: AdapterReading): string {
  return adapter.resolution.kind === "resolved"
    ? adapter.resolution.program
    : `${adapter.resolution.names.join(", ") || NOTHING_YET} — no answer on this PATH`;
}

/** Where that answer came from, in two words. */
export function resolutionSource(adapter: AdapterReading): string {
  if (adapter.resolution.kind === "notFound") return "nothing resolved";
  return adapter.resolution.from === "override"
    ? "from the override you typed"
    : `from the name ${adapter.resolution.name}`;
}

/** What was asked, and what came back — never a verdict about either. */
export function probeLine(probe: ProbeReading): string {
  const asked = [probe.program, ...probe.args].join(" ");
  switch (probe.outcome.kind) {
    case "answered":
      return `${asked} · ${probe.outcome.line === "" ? NOTHING_YET : probe.outcome.line}`;
    case "notOnThisPath":
      return `${asked} · nothing of that name on this folder's PATH`;
    case "didNotRun":
      return `${asked} · ${probe.outcome.detail}`;
  }
}

/** The override in force, and the scope it got. */
export function overrideLine(readout: FolderReadout): string {
  switch (readout.override.kind) {
    case "none":
      return NOTHING_YET;
    case "inUse":
    case "notRemembered":
      return readout.override.argv.join(" ");
    case "refused":
      return NOTHING_YET;
  }
}

/**
 * What became of the override that was typed, or `null` when nothing became of
 * it — either none was typed or the one that was is simply in force.
 *
 * Two states have to say something, and both are quiet failures otherwise: a
 * vector naming no program changes nothing at all, and a vector that could not
 * be written down is in force now and gone at the next start. Written once
 * because both the panel and the error itself show it, and two copies of a
 * sentence about the same value are two accounts free to drift.
 */
export function overrideAftermath(readout: FolderReadout): string | null {
  switch (readout.override.kind) {
    case "notRemembered":
      return `${readout.override.detail} ${OVERRIDE_NOT_REMEMBERED_COUNSEL}`;
    case "refused":
      return `${readout.override.detail} ${OVERRIDE_REFUSED_COUNSEL}`;
    default:
      return null;
  }
}

export function scopeLabel(scope: OverrideScope): string {
  return scope === "pinnedGlobally"
    ? "a path, so it pins this machine"
    : "a bare name, so it follows each folder";
}

/** How the folder resolved, as one line for the panel's header. */
export function folderFactsLine(readout: FolderReadout): string {
  const source =
    readout.pathSource === "harvest"
      ? "PATH from this folder's harvest"
      : readout.pathSource === "inherited"
        ? "PATH as this app was started with"
        : "no PATH at all";
  return `${readout.variableCount} variables · ${readout.elapsedMs} ms · ${source}`;
}

/* --------------------------------------------------------------- copy --- */

/*
 * Every sentence below names something true of this folder on this machine:
 * which shell ran in it, what its PATH is, and which file a name resolved to.
 * None of them may read as a failure to talk to GitHub — enforced by
 * tests/folder-environment.test.ts, which greps this copy for the same seven
 * words the launcher's and the environment's are swept for. That list contains
 * *retry*, which is why the button below says "Ask again".
 *
 * Two further rules, and both have a test: nothing here calls a resolution
 * correct, working or ready — resolvable is not spawnable and spawnable is not
 * correct — and a harvest that did not close is never blamed on the operator's
 * start-up files.
 */

export const CLI_MISSING_HEADLINE = "Not on this folder's PATH";

export const CLI_MISSING_COUNSEL =
  "The folder is open and its maps are being read; only the program is missing. Below is the PATH this folder's own login shell handed back, exactly as it arrived. If you can run the program in your own terminal and it is not in that list, the two shells are answering differently — and that difference, rather than the program, is the thing to look at.";

export const FOLDER_PATH_NOTE =
  "This is the PATH of a shell started in this folder, which is not the same PATH the app itself started with. A version manager answers a folder's pin inside its own process while it reads your start-up files, so two folders on one machine can resolve the same name to two different files.";

export const SPAWN_DIRECTORY_NOTE =
  "The shell was given this directory to start in. Nothing navigated there: the directory is set on the child, because a version manager resolves a pin while your start-up files run, and on Windows only the aliased form of a change of directory would fire the hook at all. This is also the key this answer is kept under, so two spellings of one directory are one answer rather than two that could disagree.";

export const OVERRIDE_FIELD_LABEL = "Run this instead";

export const OVERRIDE_SUBMIT_LABEL = "Use this";

export const OVERRIDE_SPLIT_NOTE =
  "Split on spaces, with double quotes grouping. Nothing else is interpreted — a backslash is a backslash. What the split produced is shown below it before anything uses it.";

export const OVERRIDE_SCOPE_NOTE =
  "The first word is resolved against each folder's own environment. Type a bare name and it follows whatever that folder pins; type a path and it is taken at its word everywhere. You pick which by what you type, and it is remembered for every folder rather than for this one.";

export const OVERRIDE_ARGV_NOTE =
  "The rest of the words are passed through ahead of whatever the adapter itself asks for, which is why this is a list of words and not a file to point at: node /opt/claude/cli.js is sayable and a single path is not.";

export const OVERRIDE_NOT_REMEMBERED_COUNSEL =
  "It is in force for this run. It was not written down, so it will be gone the next time this app starts.";

export const OVERRIDE_NOT_REMEMBERED_FALLBACK =
  "The override could not be written down, and no reason came back with it.";

export const OVERRIDE_REFUSED_FALLBACK =
  "That override names no program to run, so nothing was changed.";

export const OVERRIDE_REFUSED_COUNSEL =
  "Nothing was changed. Whatever was in force before still is.";

export const ASK_AGAIN_LABEL = "Ask again";

export const ASK_AGAIN_NOTE =
  "Asks this folder's login shell again from the start, then looks again. Nothing else forgets: no clock runs and nothing watches the folder, because the case that bites is a pin that has not changed while the thing it pins to has been installed or removed — which a watcher over the folder cannot see.";

export const NO_PROBE_DECLARED =
  "This adapter declares no interpreter probe, and that is a decision rather than a gap: the supported installs of it ship a program this machine can start directly, and one that turns out to be a script instead is refused at the moment of starting rather than guessed at from a version string.";

export const PROBE_NOTE =
  "What each probe was asked and what it said, kept to one line. Nothing here reads a version out of it or compares one — this is here to be looked at, because a pin to something uninstalled starts cleanly under the wrong interpreter and says nothing on either stream.";

export const PROBE_DID_NOT_RUN_FALLBACK = "The probe did not run, and no reason came back with it.";

export const FOLDER_UNREADABLE =
  "Nothing arrived here that could be read as a folder readout, so nothing is claimed about this folder.";

export const RESOLUTION_NOTE =
  "The absolute file each name resolved to, in this folder's environment. It is shown in full because it is the only visible form a version pin has: the same bare name in two folders can be two different files, and this line is where you would see that.";

/**
 * The honest limits, per folder, in the panel rather than in a document nobody
 * opens. Shorter than the app-global list because two of those four are about
 * the harvest itself and are already said there.
 */
export const FOLDER_CANNOT_TELL_YOU: readonly string[] = [
  "This says a file is there and that this machine would start it. It does not say the file will get as far as doing anything: a shim whose own interpreter is not on this PATH dies at the moment it is started, and no PATH can say so in advance.",
  "A version pin to something that is not installed falls back to the default and starts under it, cleanly, with nothing on either stream. The absolute path above is where you would notice; nothing here will point at it.",
  "This answer stands until you ask again. Installing something new does not change it, and neither does an hour passing — which is deliberate, because a pin that has not changed while the installed set has is exactly what no watcher over this folder could see.",
  "Nothing here looks anywhere this PATH did not name. A list of the usual install directories would find things your own shell does not, and it would be wrong in the direction that is hardest to notice.",
];
