// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One folder's answer may never land under another folder's name.
 *
 * A per-folder harvest is a real login shell with the operator's start-up files
 * in it — bounded in seconds, not milliseconds — so opening one folder and then
 * another before the first has answered is the ordinary sequence rather than a
 * race anyone has to try to hit. What arrives late is a whole readout: a folder
 * name, a verbatim `PATH`, an adapter's resolution and, when nothing resolved,
 * the error carrying all three. Applied to the wrong row it is not a stale
 * screen — it is a confident answer about a folder nobody is looking at.
 *
 * `dev:web` resolves from a checked-in fixture in a microtask, so the wait is
 * put back by hand here: `loadFolderEnvironment` is held open per path, and the
 * readout is stamped with the path it was asked for so the two folders are
 * telling apart at all.
 */

const held = vi.hoisted(() => ({
  /** Paths whose answer is not allowed out yet, and how to let it out. */
  waiting: new Map<string, Array<() => void>>(),
  /** Every path *Ask again* was asked about, in order. */
  reharvested: [] as string[],
}));

vi.mock("../src/environment/folder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/environment/folder")>();

  /** The fixture's readout, stamped with the folder it was asked about. */
  const forPath = async (path: string) => ({
    ...(await actual.loadFolderEnvironment(path)),
    folder: path,
    spawnDirectory: path,
  });

  return {
    ...actual,
    loadFolderEnvironment: (path: string) => {
      const queue = held.waiting.get(path);
      if (queue === undefined) return forPath(path);
      return new Promise((resolve) => {
        queue.push(() => resolve(forPath(path)));
      });
    },
    retryFolderEnvironment: (path: string) => {
      held.reharvested.push(path);
      return forPath(path);
    },
  };
});

/* Imported after the mock is declared, which `vi.mock` hoists above it. */
// eslint-disable-next-line import/first
import { App } from "../src/App";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIRST = "C:\\Users\\you\\Workspace\\perseverance";
const SECOND = "C:\\Users\\you\\Workspace\\scratch-notes";

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

beforeEach(() => {
  held.waiting.clear();
  held.reharvested.length = 0;
});

afterEach(() => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => {
    root.unmount();
  });
  host.remove();
});

async function boot(search: string): Promise<void> {
  window.history.replaceState({}, "", search);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };

  await act(async () => {
    root.render(<App />);
  });
  await settle();
}

/** Enough turns of the loop for the registry, the resolution and the binding. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

/** The row for one folder, opened. */
async function open(path: string): Promise<void> {
  const row = [...document.querySelectorAll('[aria-label="Folders"] li button')].find((button) =>
    button.textContent?.includes(path),
  );
  if (!(row instanceof HTMLButtonElement)) throw new Error(`no row for ${path}`);
  await act(async () => {
    row.click();
  });
  await settle();
}

/** Lets one folder's harvest answer at last. */
async function release(path: string): Promise<void> {
  for (const let_out of held.waiting.get(path) ?? []) let_out();
  await settle();
}

function thePanel(): string {
  return document.querySelector("#folder-environment-panel")?.textContent ?? "";
}

describe("a slow folder's readout lands on the folder that asked for it, or nowhere", () => {
  it("does not replace the open folder's readout with the one you left", async () => {
    held.waiting.set(FIRST, []);
    await boot("/?map=awkward-map&folder=notFound");

    await open(FIRST);
    // Nothing has answered for it yet, so there is nothing on screen claiming
    // to be its environment.
    expect(document.querySelector("#folder-environment-panel")).toBeNull();

    await open(SECOND);
    expect(thePanel()).toContain(SECOND);

    // And now the first folder answers, into a window that has moved on. The
    // readout it carries is complete and entirely about somewhere else.
    await release(FIRST);

    expect(thePanel()).toContain(SECOND);
    expect(thePanel()).not.toContain(FIRST);
  });

  it("re-harvests the folder that is selected rather than the one on the slot", async () => {
    held.waiting.set(FIRST, []);
    await boot("/?map=awkward-map&folder=notFound");

    await open(FIRST);
    await open(SECOND);
    await release(FIRST);

    const again = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "Ask again",
    );
    if (!(again instanceof HTMLButtonElement)) throw new Error("nothing to ask again with");
    await act(async () => {
      again.click();
    });
    await settle();

    // *Ask again* is the operator's only invalidation, so asking it about the
    // folder they are not looking at would leave the one they are looking at
    // permanently un-re-harvestable.
    expect(held.reharvested).toEqual([SECOND]);
    expect(thePanel()).toContain(SECOND);
  });
});
