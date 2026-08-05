/**
 * The WebView's view of the launcher registry.
 *
 * These types mirror `perseverance-store`'s `Folder` and the app crate's
 * launcher commands exactly, for the same reason `snapshot.ts` mirrors
 * `perseverance-model`: one seam rather than two. The registry is a SQLite file
 * on this machine and nothing in this module knows how to open a socket — every
 * message it can render is a fact about a folder, never about somewhere else.
 *
 * `folders.fixture.json` is what stands behind the launcher in `dev:web`. It
 * carries a missing folder and all three repo-binding refusals because those
 * are states a browser cannot conjure: you cannot unmount a drive from
 * JavaScript, and there is no `.git` to misconfigure.
 */

import { nowSeconds } from "../chrome/age";
import { hasRustBehindIt } from "../snapshot/snapshot";
import fixture from "./folders.fixture.json";

/** One row of the registry. `name` and `present` are computed Rust-side. */
export interface FolderEntry {
  id: number;
  path: string;
  /** Display basename. Falls back to the path when the shell sends nothing. */
  name: string;
  adapter: string | null;
  /** Epoch seconds. */
  lastOpened: number;
  /** False means the path is gone: greyed, badged, never auto-pruned. */
  present: boolean;
}

export interface LauncherView {
  folders: FolderEntry[];
}

/**
 * `owner/repo` as derived from the folder's git remote at read time. It is not
 * a field of any row, because a renamed or transferred repository must not be
 * able to rot the registry.
 */
export type RepoBinding =
  | { kind: "bound"; owner: string; name: string }
  | { kind: "notAGitRepo" }
  | { kind: "noGitHubRemote" }
  | { kind: "ambiguousRemotes"; candidates: string[] };

/**
 * The store refuses to open a registry whose schema version it does not know,
 * which arrives here as a rejected `launcher()` call. A refusal replaces the
 * list; it does not empty it.
 */
export type LauncherOutcome =
  | { kind: "listed"; view: LauncherView }
  | { kind: "refused"; detail: string };

/** A row of the launcher list. *Open a new folder* is one of them, not chrome. */
export type LauncherRow =
  | { kind: "folder"; entry: FolderEntry }
  | { kind: "openNew" };

/* ------------------------------------------------------------- loading --- */

export function noFoldersYet(): LauncherView {
  return { folders: [] };
}

/** The state the first paint renders, before the registry has answered. */
export function nothingListedYet(): LauncherOutcome {
  return { kind: "listed", view: noFoldersYet() };
}

const fixtureView: LauncherView = { folders: fixture.folders };

export function loadFixture(): LauncherView {
  return { folders: fixtureView.folders.map((folder) => ({ ...folder })) };
}

export async function loadLauncher(): Promise<LauncherOutcome> {
  if (!hasRustBehindIt()) {
    return { kind: "listed", view: loadFixture() };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return { kind: "listed", view: await invoke<LauncherView>("launcher") };
  } catch (refusal) {
    return { kind: "refused", detail: refusalDetail(refusal) };
  }
}

/** The store's own words, or ours if the shell sent something shapeless. */
export function refusalDetail(refusal: unknown): string {
  if (typeof refusal === "string" && refusal.trim() !== "") return refusal.trim();
  if (refusal instanceof Error && refusal.message.trim() !== "") {
    return refusal.message.trim();
  }
  return REGISTRY_REFUSED_FALLBACK;
}

export async function rememberFolder(path: string): Promise<FolderEntry> {
  if (!hasRustBehindIt()) {
    return previewRow(path);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<FolderEntry>("remember_folder", { path });
}

export async function forgetFolder(id: number): Promise<void> {
  if (!hasRustBehindIt()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("forget_folder", { id });
}

/** Re-points a folder. The id survives, so its layout and cache survive too. */
export async function relocateFolder(id: number, path: string): Promise<FolderEntry> {
  if (!hasRustBehindIt()) {
    return previewRelocation(id, path);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<FolderEntry>("relocate_folder", { id, path });
}

export async function bindRepo(path: string): Promise<RepoBinding> {
  if (!hasRustBehindIt()) {
    return bindingFrom(fixtureBindings()[path]);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<RepoBinding>("bind_repo", { path });
}

/**
 * Where a new path comes from.
 *
 * The shell owns the native picker; the browser has none, so `dev:web` asks
 * for the path instead and the rest of the flow is identical. Either way a
 * refusal to choose is `null` and nothing is changed — declining to pick a
 * folder is not an error.
 */
export async function chooseFolder(purpose: string): Promise<string | null> {
  if (!hasRustBehindIt()) {
    if (typeof window === "undefined") return null;
    const typed = window.prompt(purpose);
    return typed !== null && typed.trim() !== "" ? typed.trim() : null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<string | null>("choose_folder");
  } catch {
    // A shell without a picker command leaves the list exactly as it was,
    // which is the same outcome as changing your mind about the folder.
    return null;
  }
}

/**
 * Folders dropped on the window.
 *
 * The shell reports the drop, not the DOM: the webview swallows a file drop
 * before any `drop` event reaches an element, and the path of a dropped folder
 * is something only the Rust side is ever told. A browser is never told it at
 * all, so `dev:web` subscribes to nothing and the region stays inert there —
 * a dropped path is the second state the preview cannot conjure.
 *
 * Returns the way to stop listening, because a subscription that outlives the
 * component it belongs to is a leak.
 */
export async function watchDroppedFolders(watcher: {
  onArmed: (armed: boolean) => void;
  onDropped: (paths: readonly string[]) => void;
}): Promise<() => void> {
  if (!hasRustBehindIt()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "enter" || payload.type === "over") {
      watcher.onArmed(true);
      return;
    }
    watcher.onArmed(false);
    if (payload.type === "drop") watcher.onDropped(payload.paths);
  });
}

/* -------------------------------------------------------- dev:web rows --- */

/*
 * `dev:web` has no registry behind it, so the preview keeps one. Without it,
 * opening the same folder twice in the browser would grow a second row while
 * the shell touches the row it already has — and the fixture path is only worth
 * having while it models the same rules the store does.
 */
const previewRows = new Map<string, FolderEntry>();
let previewSeeded = false;
let previewId = -1;

function preview(): Map<string, FolderEntry> {
  if (!previewSeeded) {
    for (const folder of fixtureView.folders) previewRows.set(folder.path, folder);
    previewSeeded = true;
  }
  return previewRows;
}

/** Insert or touch, by path, exactly as `Store::remember_folder` does. */
function previewRow(path: string): FolderEntry {
  const rows = preview();
  const known = rows.get(path);
  const row: FolderEntry = known
    ? { ...known, lastOpened: nowSeconds() }
    : {
        id: nextPreviewId(),
        path,
        name: basename(path),
        adapter: null,
        lastOpened: nowSeconds(),
        present: true,
      };
  rows.set(path, row);
  return row;
}

/** Re-points by id, keeping the id — the whole point of the operation. */
function previewRelocation(id: number, path: string): FolderEntry {
  const rows = preview();
  const before = [...rows.values()].find((row) => row.id === id);
  if (before !== undefined) rows.delete(before.path);
  const row: FolderEntry = {
    id,
    path,
    name: basename(path),
    adapter: before?.adapter ?? null,
    lastOpened: nowSeconds(),
    present: true,
  };
  rows.set(path, row);
  return row;
}

function nextPreviewId(): number {
  previewId -= 1;
  return previewId;
}

/* -------------------------------------------------------------- fixture --- */

interface FixtureBindings {
  [path: string]: unknown;
}

function fixtureBindings(): FixtureBindings {
  return fixture.bindings as FixtureBindings;
}

/**
 * The fixture is untyped JSON at a boundary, so its bindings are narrowed
 * rather than trusted. Anything unrecognised reads as the folder having no
 * `.git`, which is the refusal that asks the least of the reader.
 */
export function bindingFrom(raw: unknown): RepoBinding {
  if (typeof raw !== "object" || raw === null) return { kind: "notAGitRepo" };
  const record = raw as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";

  switch (kind) {
    case "bound":
      return {
        kind: "bound",
        owner: textOr(record.owner, "unknown"),
        name: textOr(record.name, "unknown"),
      };
    case "noGitHubRemote":
      return { kind: "noGitHubRemote" };
    case "ambiguousRemotes":
      return {
        kind: "ambiguousRemotes",
        candidates: Array.isArray(record.candidates)
          ? record.candidates.filter((one): one is string => typeof one === "string")
          : [],
      };
    default:
      return { kind: "notAGitRepo" };
  }
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/* ---------------------------------------------------------------- list --- */

/** Most recent first. Ties break on name so two folders never swap places. */
export function mostRecentFirst(folders: readonly FolderEntry[]): FolderEntry[] {
  return [...folders].sort((left, right) => {
    if (left.lastOpened !== right.lastOpened) return right.lastOpened - left.lastOpened;
    return displayName(left).localeCompare(displayName(right));
  });
}

/**
 * The whole list, in the order it is rendered.
 *
 * *Open a new folder* is the last row rather than a button in separate chrome:
 * starting somewhere new is the same kind of act as returning somewhere old,
 * so it is the same kind of row. An empty registry still has this row, which
 * is why the empty state needs no special affordance.
 */
export function rowsFor(view: LauncherView): LauncherRow[] {
  const rows: LauncherRow[] = mostRecentFirst(view.folders).map((entry) => ({
    kind: "folder" as const,
    entry,
  }));
  rows.push({ kind: "openNew" });
  return rows;
}

/** Removal is explicit. Nothing else in this module drops a row. */
export function withoutFolder(view: LauncherView, id: number): LauncherView {
  return { folders: view.folders.filter((folder) => folder.id !== id) };
}

/** Insert or replace by id, so a relocated folder keeps its place in history. */
export function withFolder(view: LauncherView, entry: FolderEntry): LauncherView {
  const replaced = view.folders.some((folder) => folder.id === entry.id);
  return {
    folders: replaced
      ? view.folders.map((folder) => (folder.id === entry.id ? entry : folder))
      : [...view.folders, entry],
  };
}

export function isMissing(entry: FolderEntry): boolean {
  return !entry.present;
}

export function displayName(entry: FolderEntry): string {
  const given = entry.name.trim();
  return given !== "" ? given : basename(entry.path);
}

/**
 * Last segment of a path, on either separator. A root has no last segment, so
 * it names itself: `C:\` is `C:` and `/` is `/`, never the empty string.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const tail = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return tail !== "" ? tail : path;
}

/* ----------------------------------------------------------------- age --- */

/*
 * How long ago you were last here is the same question the cache stamp asks
 * about a read, so the phrasing is shared rather than written twice. It is
 * re-exported here because a launcher row is where a caller expects to find it.
 */
export { nowSeconds, relativeAge } from "../chrome/age";

/* ------------------------------------------------------------ refusals --- */

/*
 * Every sentence below names something true of a folder on this machine, and
 * says what to do about it. None of them may read as a failure to talk to
 * GitHub, because the fix for that is a different fix — enforced by
 * tests/launcher.test.ts, which greps this copy for network vocabulary.
 */

export function bindingHeadline(binding: RepoBinding): string {
  switch (binding.kind) {
    case "bound":
      return "Repository";
    case "notAGitRepo":
      return "Not a git repository";
    case "noGitHubRemote":
      return "No GitHub remote";
    case "ambiguousRemotes":
      return "More than one GitHub remote";
  }
}

export function describeBinding(binding: RepoBinding): string {
  switch (binding.kind) {
    case "bound":
      return `${binding.owner}/${binding.name}, read from this folder's git remote just now and written down nowhere.`;
    case "notAGitRepo":
      return "This folder holds no usable .git — either there is none here, or the .git here points at a git directory that is not there — so there is no remote in it to name a repository. Pick the folder that holds the repository; if there has never been one, `git init` here first.";
    case "noGitHubRemote":
      return "This folder is a git repository, but no remote in its .git/config names github.com. Add one — `git remote add origin git@github.com:owner/repo.git` — and pick the folder again.";
    case "ambiguousRemotes":
      return `The remotes in this folder name more than one GitHub repository (${listOut(
        binding.candidates,
      )}). One folder is one repository, and choosing between them is yours to do: drop or re-point the remote you did not mean.`;
  }
}

/**
 * What the launcher says about the folder you just picked. Every variant is a
 * fact about this machine: what the folder's git remote says, that the folder
 * is not where it was, or that the registry declined the edit you asked for.
 */
export type LauncherNote =
  | { kind: "binding"; binding: RepoBinding }
  | { kind: "pathGone"; path: string }
  | { kind: "refused"; detail: string };

export function noteHeadline(note: LauncherNote): string {
  switch (note.kind) {
    case "binding":
      return bindingHeadline(note.binding);
    case "pathGone":
      return "Path missing";
    case "refused":
      return "Nothing changed";
  }
}

export function describeNote(note: LauncherNote): string {
  switch (note.kind) {
    case "binding":
      return describeBinding(note.binding);
    case "pathGone":
      return `Nothing answers to ${note.path} on this machine just now — an unmounted drive, or a folder that moved. The row keeps its place, its layout and its cache: point it somewhere new with Locate…, or take it off the list yourself. It will not be dropped for you.`;
    case "refused":
      // The registry wrote the reason; this only adds what became of the list.
      return `${ended(note.detail)} The list is exactly as it was.`;
  }
}

/** The store's sentence, ended, so ours can follow it. */
function ended(detail: string): string {
  const said = detail.trim();
  if (said === "") return "That did not happen.";
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

export const REGISTRY_REFUSED_HEADLINE = "This build will not open the folder list";

/**
 * True of every refusal, whatever its reason — an unrecognised schema version,
 * a file that could not be read, a directory that could not be made. The reason
 * itself is the store's to give and arrives as the detail beside this; saying
 * it twice, in words chosen before the refusal arrived, would mean asserting a
 * reason that may not be the one that happened.
 */
export const REGISTRY_REFUSED_COUNSEL =
  "The list is one file on this machine, and it has been left exactly as it was found: not upgraded, not emptied, not rewritten. A build that can read it will open it as it stands.";

export const REGISTRY_REFUSED_FALLBACK =
  "The folder list was refused, and no reason came back with the refusal.";

/** Serial comma, because remote names are the whole point of the sentence. */
export function listOut(names: readonly string[]): string {
  if (names.length === 0) return "none named";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}
