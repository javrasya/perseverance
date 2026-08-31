import { describe, expect, it } from "vitest";
import {
  DETACHED_IS_A_NO,
  FOREIGN_IS_NOT_ASKED,
  FOREIGN_IS_NOT_OURS,
  LISTING_UNREADABLE,
  LOCKED_IS_A_NO,
  UNCOMMITTED_IS_A_NO,
  UNPUSHED_IS_A_NO,
  branchLine,
  fixtureWorktrees,
  inventoryFrom,
  inventorySummary,
  lockedLine,
  offersRemoval,
  prunableLine,
  publicationLine,
  uncommittedLines,
  whoseLabel,
  whyNoOffer,
  workingLine,
  worktreeFixtureKeys,
  type Inventory,
  type WorktreeEntry,
} from "../src/worktrees/worktrees";

function listed(inventory: Inventory): WorktreeEntry[] {
  expect(inventory.kind).toBe("listed");
  return inventory.kind === "listed" ? inventory.entries : [];
}

function only(key: string): WorktreeEntry {
  const entries = listed(fixtureWorktrees(key));
  expect(entries.length).toBeGreaterThan(0);
  return entries[0];
}

/* --------------------------------------------------------------- shape --- */

describe("the worktree listing is one seam, spelled twice", () => {
  /*
   * `src/worktrees/worktrees.ts` is a hand-written mirror of the app crate's
   * `WorktreeEntry`, exactly as `folder.ts` is of `FolderReadout`. A rename on
   * either side is silent on the other, so both sides count the keys.
   */
  it("seven keys cross, and these seven", () => {
    const keys = Object.keys(only("cleanAndPushed")).sort();

    expect(keys).toEqual([
      "branch",
      "locked",
      "path",
      "probed",
      "prunable",
      "removable",
      "whose",
    ]);
    expect(keys).toHaveLength(7);
  });

  it("carries a boolean where the crate keeps a slip", () => {
    const entry = only("cleanAndPushed") as unknown as Record<string, unknown>;

    // The `Removal` is minted by the classifier, has private fields and stays
    // in Rust. A permission that crossed would be one this side could keep,
    // replay or invent, and the press re-derives the whole listing instead.
    expect(typeof entry.removable).toBe("boolean");
    expect(entry.removal).toBeUndefined();
    expect(entry.slip).toBeUndefined();
  });
});

/* ------------------------------------------------------------- fixture --- */

describe("the fixture carries the states a browser cannot conjure", () => {
  it("has all nine, because you cannot dirty a worktree from JavaScript", () => {
    expect(worktreeFixtureKeys().sort()).toEqual([
      "cleanAndPushed",
      "everyState",
      "foreign",
      "gone",
      "locked",
      "nothingListed",
      "orphan",
      "uncommitted",
      "unpushed",
    ]);
  });

  it("every state narrows, so the fixture is the seam Rust fills", () => {
    for (const key of worktreeFixtureKeys()) {
      for (const entry of listed(fixtureWorktrees(key))) {
        expect(entry.path).not.toBe("");
        expect(["ours", "foreign"]).toContain(entry.whose.kind);
        if (entry.whose.kind === "foreign") {
          // Never probed, because a foreign worktree is none of our business.
          expect(entry.probed).toBeNull();
          expect(entry.removable).toBe(false);
        } else {
          expect(entry.probed).not.toBeNull();
          expect(["clean", "uncommitted", "gone", "unreadable"]).toContain(
            entry.probed?.working.kind,
          );
          expect(["pushed", "unpushed", "detached", "unknown"]).toContain(
            entry.probed?.publication.kind,
          );
        }
      }
    }
  });

  it("shows the every-state list the browser opens on, with the offer split both ways", () => {
    const entries = listed(fixtureWorktrees("everyState"));

    expect(entries.some((entry) => entry.whose.kind === "foreign")).toBe(true);
    expect(entries.some((entry) => offersRemoval(entry))).toBe(true);
    expect(entries.some((entry) => !offersRemoval(entry))).toBe(true);
    expect(entries.some((entry) => uncommittedLines(entry).length > 1)).toBe(true);
    expect(entries.some((entry) => entry.locked !== null)).toBe(true);
    expect(entries.some((entry) => entry.prunable !== null)).toBe(true);
    expect(entries.some((entry) => entry.whose.kind === "ours" && entry.whose.orphan)).toBe(true);
  });

  it("names the folder's own main worktree as foreign, which is the point of the rule", () => {
    const main = only("foreign");

    expect(main.whose.kind).toBe("foreign");
    expect(offersRemoval(main)).toBe(false);
  });
});

/* ----------------------------------------------------------- narrowing --- */

describe("nothing readable is claimed about anything", () => {
  it("reads a missing answer as a refusal rather than an empty list", () => {
    // An empty list would say *this repository has no worktrees*, which is a
    // claim; a refusal says only that nothing arrived.
    expect(inventoryFrom(undefined)).toEqual({ kind: "refused", detail: LISTING_UNREADABLE });
    expect(inventoryFrom({ entries: [] })).toEqual({
      kind: "refused",
      detail: LISTING_UNREADABLE,
    });
  });

  it("draws no button for anything it could not read", () => {
    const entry = listed(inventoryFrom([{ path: "/tmp/x", removable: "yes" }]))[0];

    expect(entry.removable).toBe(false);
    expect(entry.whose.kind).toBe("foreign");
    expect(entry.probed).toBeNull();
    expect(offersRemoval(entry)).toBe(false);
  });

  it("keeps a lock with no reason apart from no lock at all", () => {
    const [reasoned, silent] = listed(fixtureWorktrees("locked"));

    expect(lockedLine(reasoned)).toContain("keeping this one until the release goes out");
    expect(silent.locked).toBe("");
    expect(lockedLine(silent)).toBe("locked in git, with no reason given");
  });

  it("takes an empty listing as an empty listing", () => {
    expect(listed(fixtureWorktrees("nothingListed"))).toEqual([]);
    expect(inventorySummary(fixtureWorktrees("nothingListed"))).toBe("no worktrees listed");
  });
});

/* ---------------------------------------------------------- the offer --- */

describe("a removal is offered exactly where every rule cleared it", () => {
  it("offers one on a clean, pushed worktree of ours", () => {
    const entry = only("cleanAndPushed");

    expect(offersRemoval(entry)).toBe(true);
    expect(whyNoOffer(entry)).toBeNull();
  });

  it("offers none on a foreign entry, whatever the wire said", () => {
    const foreign = only("foreign");
    const lying = { ...foreign, removable: true };

    // The same rule the crate makes a compiler fact, spelled again where the
    // button is drawn.
    expect(offersRemoval(lying)).toBe(false);
    expect(whyNoOffer(lying)).toBe(FOREIGN_IS_NOT_OURS);
  });

  it("says uncommitted work is the reason, and prints every line of it", () => {
    const entry = only("uncommitted");

    expect(offersRemoval(entry)).toBe(false);
    expect(whyNoOffer(entry)).toBe(UNCOMMITTED_IS_A_NO);
    expect(uncommittedLines(entry)).toEqual([
      " M src/environment/folder.ts",
      " M src/environment/FolderReadout.module.css",
      "A  src/worktrees/worktrees.ts",
      "?? notes/what-the-shell-answered.md",
      "?? src/environment/folder.fixture.json.orig",
    ]);
  });

  it("counts the unpushed commits and claims no more than this clone knows", () => {
    const entry = only("unpushed");

    expect(publicationLine(entry)).toBe("7 commits on no remote this clone knows about");
    expect(whyNoOffer(entry)).toBe(UNPUSHED_IS_A_NO);
    // Nothing here fetched, so nothing here may sound like it did.
    expect(publicationLine(entry)).not.toMatch(/fetch|remote has|checked/i);
  });

  it("says one commit in the singular, because a count that reads wrong is read wrong", () => {
    const entry = only("unpushed");
    const one: WorktreeEntry = {
      ...entry,
      probed: { working: { kind: "clean" }, publication: { kind: "unpushed", commits: 1 } },
    };

    expect(publicationLine(one)).toBe("1 commit on no remote this clone knows about");
  });

  it("refuses a locked one in the operator's own words", () => {
    const entry = only("locked");

    expect(offersRemoval(entry)).toBe(false);
    expect(whyNoOffer(entry)).toBe(LOCKED_IS_A_NO);
    expect(lockedLine(entry)).toContain("keeping this one");
  });

  it("says a detached worktree has nothing that could have been pushed", () => {
    const detached = listed(fixtureWorktrees("everyState")).find(
      (entry) => entry.branch === null,
    )!;

    expect(branchLine(detached)).toBe("no branch — this worktree is detached");
    expect(whyNoOffer(detached)).toBe(DETACHED_IS_A_NO);
  });

  it("carries git's own sentence through an unreadable probe", () => {
    const unreadable = listed(fixtureWorktrees("everyState")).find(
      (entry) => entry.probed?.working.kind === "unreadable",
    )!;

    expect(workingLine(unreadable)).toContain("Permission denied");
    expect(whyNoOffer(unreadable)).toContain("Permission denied");
    expect(offersRemoval(unreadable)).toBe(false);
  });

  /*
   * The one row where a directory that is not there is a yes: there is nothing
   * in it to lose, and the leftover registration is the litter the operator
   * opened this list to clear.
   */
  it("lists a hand-deleted directory as an ordinary row that still offers", () => {
    const entry = only("gone");

    expect(workingLine(entry)).toBe(
      "the directory is not there — only git's registration of it is",
    );
    expect(prunableLine(entry)).toBe("git calls this prunable: gitdir file points to non-existent location");
    expect(offersRemoval(entry)).toBe(true);
  });
});

/* ------------------------------------------------------------ reading --- */

describe("what the list says about itself", () => {
  it("marks an orphan in the list rather than moving it out of one", () => {
    const orphan = only("orphan");

    expect(whoseLabel(orphan)).toBe("#12 · orphan");
    // Same rules, same list: being forgotten by a map is not evidence about
    // what is in the directory, so it neither adds nor removes an offer.
    expect(offersRemoval(orphan)).toBe(true);
  });

  it("names a worktree of ours by its ticket and a foreign one by neither", () => {
    expect(whoseLabel(only("cleanAndPushed"))).toBe("#60");
    expect(whoseLabel(only("foreign"))).toBe("not this app's");
  });

  it("says a foreign worktree was not asked, rather than that it failed", () => {
    const foreign = only("foreign");

    expect(workingLine(foreign)).toBe(FOREIGN_IS_NOT_ASKED);
    expect(publicationLine(foreign)).toBe(FOREIGN_IS_NOT_ASKED);
  });

  /*
   * The collapsed bar counts directories and how many this app made, and never
   * how many could go. A count of offers on a closed panel is an invitation to
   * clear them together, and there is no bulk anything here.
   */
  it("summarises without ever counting the offers", () => {
    expect(inventorySummary(fixtureWorktrees("everyState"))).toBe("9 worktrees · 8 this app's");
    expect(inventorySummary(fixtureWorktrees("cleanAndPushed"))).toBe("1 worktree · 1 this app's");
    expect(inventorySummary({ kind: "refused", detail: "no git" })).toBe("nothing could be listed");
  });
});
