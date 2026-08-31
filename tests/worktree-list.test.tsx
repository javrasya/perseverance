// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WORKTREE_PANEL_ID, WorktreeList } from "../src/worktrees/WorktreeList";
import {
  FOREIGN_IS_NOT_OURS,
  LOOK_AGAIN_LABEL,
  REMOVAL_KEEPS_THE_BRANCH,
  REMOVE_LABEL,
  fixtureWorktrees,
  offersRemoval,
  uncommittedLines,
  type Inventory,
  type WorktreeEntry,
} from "../src/worktrees/worktrees";

/**
 * The list on screen, and the two things it must never draw.
 *
 * There is no button on a foreign row and no button on a row with uncommitted
 * work in it — not a disabled one, not one behind a confirmation. Both are
 * asserted as *no control at all inside the row*, because a control that exists
 * and refuses is a thing an operator argues with, and every argument of that
 * kind ends with somebody adding a force flag.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(inventory: Inventory, onRemove: (path: string) => void = () => {}): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  const drawn = createRoot(host);
  root = drawn;
  act(() => {
    drawn.render(
      <WorktreeList
        inventory={inventory}
        shown={true}
        onToggle={() => {}}
        onRemove={onRemove}
        onLookAgain={() => {}}
      />,
    );
  });
  return host;
}

function rows(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>("li[data-whose]")];
}

function entriesOf(inventory: Inventory): WorktreeEntry[] {
  return inventory.kind === "listed" ? inventory.entries : [];
}

describe("every worktree of the folder is on the list", () => {
  it("draws a row per entry, foreign ones included", () => {
    const inventory = fixtureWorktrees("everyState");
    const drawn = draw(inventory);

    expect(rows(drawn)).toHaveLength(entriesOf(inventory).length);
    for (const entry of entriesOf(inventory)) {
      expect(drawn.textContent).toContain(entry.path);
    }
  });

  it("keeps orphans in the same list, marked, under the same rules", () => {
    const drawn = draw(fixtureWorktrees("everyState"));
    const orphans = rows(drawn).filter((row) =>
      row.querySelector('[data-orphan="true"]') !== null,
    );

    expect(orphans).toHaveLength(1);
    expect(orphans[0].textContent).toContain("orphan");
    // In the list, not beside it: one `ul`, and every row is in it.
    expect(drawn.querySelectorAll("ul li[data-whose]")).toHaveLength(rows(drawn).length);
  });

  it("draws a hand-deleted directory as an ordinary row and nothing else", () => {
    const drawn = draw(fixtureWorktrees("gone"));

    expect(rows(drawn)).toHaveLength(1);
    expect(drawn.textContent).toContain("the directory is not there");
    expect(drawn.textContent).toContain("gitdir file points to non-existent location");
  });
});

describe("the offer is drawn exactly where the wire said there was one", () => {
  it("puts a removal button on the rows that offer and on no others", () => {
    const inventory = fixtureWorktrees("everyState");
    const drawn = draw(inventory);
    const offered = entriesOf(inventory).filter(offersRemoval);

    const buttons = [...drawn.querySelectorAll("li[data-whose] button")];
    expect(buttons).toHaveLength(offered.length);
    for (const button of buttons) expect(button.textContent).toBe(REMOVE_LABEL);
  });

  it("gives a foreign entry no control of any kind", () => {
    const drawn = draw(fixtureWorktrees("foreign"));

    for (const row of rows(drawn)) {
      expect(row.dataset.whose).toBe("foreign");
      // Not a disabled button, not a menu, not a hidden one: nothing.
      expect(row.querySelectorAll("button, [role='button'], a, input, select")).toHaveLength(0);
      expect(row.textContent).toContain(FOREIGN_IS_NOT_OURS);
    }
  });

  it("prints every uncommitted line and draws no button at all beside them", () => {
    const inventory = fixtureWorktrees("uncommitted");
    const entry = entriesOf(inventory)[0];
    const drawn = draw(inventory);
    const [row] = rows(drawn);

    expect(row.querySelectorAll("button")).toHaveLength(0);
    for (const line of uncommittedLines(entry)) {
      expect(row.textContent).toContain(line);
    }
    // In the open: no disclosure to find, and nothing parked in a tooltip.
    expect(row.querySelectorAll("details, summary, [hidden], [title]")).toHaveLength(0);
    // The lines themselves, never a tally of them.
    expect(row.textContent).not.toMatch(/\b5 (changes|files|lines)\b/);
  });

  it("says how many commits are on no remote, and never that one was contacted", () => {
    const drawn = draw(fixtureWorktrees("unpushed"));

    expect(drawn.textContent).toContain("7 commits on no remote this clone knows about");
    expect(drawn.textContent).not.toMatch(/could not reach|failed to fetch|offline/i);
  });

  it("says removal leaves the branch alone, where it says anything at all", () => {
    const drawn = draw(fixtureWorktrees("cleanAndPushed"));

    expect(drawn.textContent).toContain(REMOVAL_KEEPS_THE_BRANCH);
    expect(REMOVAL_KEEPS_THE_BRANCH).toContain("nothing here deletes a branch");
  });
});

describe("a press names a directory, and this side changes nothing", () => {
  it("hands the entry's own path back and leaves the list exactly as it was", () => {
    const inventory = fixtureWorktrees("cleanAndPushed");
    const pressed: string[] = [];
    const drawn = draw(inventory, (path) => pressed.push(path));

    const button = drawn.querySelector<HTMLButtonElement>("li[data-whose] button");
    act(() => button?.click());

    expect(pressed).toEqual([entriesOf(inventory)[0].path]);
    // Nothing is spliced here. The row goes when the next listing says it is
    // gone, because the listing is derived from git and kept nowhere.
    expect(rows(drawn)).toHaveLength(1);
  });

  it("carries a refusal through as Rust's own sentence, and offers a way to ask again", () => {
    const detail = "fatal: not a git repository (or any of the parent directories): .git";
    const drawn = draw({ kind: "refused", detail });

    expect(drawn.textContent).toContain(detail);
    expect(rows(drawn)).toHaveLength(0);
    expect([...drawn.querySelectorAll("button")].map((button) => button.textContent)).toContain(
      LOOK_AGAIN_LABEL,
    );
  });

  it("names the panel it opens, so the disclosure points at something real", () => {
    const drawn = draw(fixtureWorktrees("everyState"));
    const disclose = drawn.querySelector("button[aria-controls]");

    expect(disclose?.getAttribute("aria-controls")).toBe(WORKTREE_PANEL_ID);
    expect(drawn.querySelector(`#${WORKTREE_PANEL_ID}`)).not.toBeNull();
  });
});
