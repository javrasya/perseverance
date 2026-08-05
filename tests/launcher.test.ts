import { describe, expect, it } from "vitest";
import {
  REGISTRY_REFUSED_COUNSEL,
  REGISTRY_REFUSED_FALLBACK,
  REGISTRY_REFUSED_HEADLINE,
  basename,
  bindingFrom,
  bindingHeadline,
  describeBinding,
  describeNote,
  displayName,
  isMissing,
  listOut,
  loadFixture,
  mostRecentFirst,
  noFoldersYet,
  noteHeadline,
  refusalDetail,
  relativeAge,
  rememberFolder,
  rowsFor,
  withFolder,
  withoutFolder,
  type FolderEntry,
  type RepoBinding,
} from "../src/launcher/launcher";

function folder(over: Partial<FolderEntry> = {}): FolderEntry {
  return {
    id: 1,
    path: "C:\\work\\thing",
    name: "thing",
    adapter: null,
    lastOpened: 1_700_000_000,
    present: true,
    ...over,
  };
}

const DAY = 86_400;

describe("the list is what you opened, most recently first", () => {
  it("orders by when you were last there", () => {
    const view = {
      folders: [
        folder({ id: 1, name: "older", lastOpened: 100 }),
        folder({ id: 2, name: "newest", lastOpened: 300 }),
        folder({ id: 3, name: "middle", lastOpened: 200 }),
      ],
    };

    expect(mostRecentFirst(view.folders).map((one) => one.name)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  it("two folders opened in the same second never swap places between paints", () => {
    const same = [
      folder({ id: 1, name: "zebra", lastOpened: 500 }),
      folder({ id: 2, name: "aardvark", lastOpened: 500 }),
    ];

    expect(mostRecentFirst(same).map((one) => one.name)).toEqual(
      mostRecentFirst([...same].reverse()).map((one) => one.name),
    );
    expect(mostRecentFirst(same).map((one) => one.name)).toEqual(["aardvark", "zebra"]);
  });

  it("ordering the list does not reorder the list it was given", () => {
    const original = [
      folder({ id: 1, lastOpened: 100 }),
      folder({ id: 2, lastOpened: 300 }),
    ];

    mostRecentFirst(original);

    expect(original.map((one) => one.id)).toEqual([1, 2]);
  });
});

describe("open a new folder is a row of the same list", () => {
  it("sits on the list beneath the folders you already have", () => {
    const rows = rowsFor({
      folders: [folder({ id: 1, lastOpened: 100 }), folder({ id: 2, lastOpened: 200 })],
    });

    expect(rows.map((row) => row.kind)).toEqual(["folder", "folder", "openNew"]);
  });

  it("is still a row when nothing has ever been opened", () => {
    const rows = rowsFor(noFoldersYet());

    // No folders is a normal first run, not an error state that needs its own
    // screen: the one thing you can do is on the list where it always is.
    expect(rows).toEqual([{ kind: "openNew" }]);
  });
});

describe("a folder whose path has gone stays on the list", () => {
  it("is classified as missing rather than dropped", () => {
    expect(isMissing(folder({ present: false }))).toBe(true);
    expect(isMissing(folder({ present: true }))).toBe(false);
  });

  it("a missing folder is still a row you can pick", () => {
    const rows = rowsFor({ folders: [folder({ id: 7, present: false })] });

    expect(rows[0]).toEqual({ kind: "folder", entry: folder({ id: 7, present: false }) });
  });

  it("re-pointing keeps the id, which is what the layout and cache hang from", () => {
    const before = { folders: [folder({ id: 7, path: "D:\\gone", present: false })] };

    const after = withFolder(before, {
      ...folder({ id: 7, path: "E:\\found", present: true }),
    });

    expect(after.folders).toHaveLength(1);
    expect(after.folders[0]?.id).toBe(7);
    expect(after.folders[0]?.path).toBe("E:\\found");
    expect(after.folders[0]?.present).toBe(true);
  });

  it("nothing leaves the list except by being removed on purpose", () => {
    const before = {
      folders: [folder({ id: 1, present: false }), folder({ id: 2, present: true })],
    };

    expect(withoutFolder(before, 1).folders.map((one) => one.id)).toEqual([2]);
    expect(withoutFolder(before, 99).folders.map((one) => one.id)).toEqual([1, 2]);
  });

  it("a folder you have not seen before joins the list rather than replacing one", () => {
    const before = { folders: [folder({ id: 1 })] };

    expect(withFolder(before, folder({ id: 2 })).folders.map((one) => one.id)).toEqual([
      1, 2,
    ]);
  });
});

describe("a row says how long ago you were there, in the coarsest unit still true", () => {
  const cases: ReadonlyArray<[number, string]> = [
    [0, "just now"],
    [59, "just now"],
    [60, "1 minute ago"],
    [3_599, "59 minutes ago"],
    [3_600, "1 hour ago"],
    [DAY - 1, "23 hours ago"],
    [DAY, "1 day ago"],
    [6 * DAY, "6 days ago"],
    [7 * DAY, "1 week ago"],
    [34 * DAY, "4 weeks ago"],
    [35 * DAY, "1 month ago"],
    [200 * DAY, "6 months ago"],
    [400 * DAY, "1 year ago"],
    [900 * DAY, "2 years ago"],
  ];

  for (const [ago, reads] of cases) {
    it(`${ago} seconds ago reads as "${reads}"`, () => {
      expect(relativeAge(1_000_000 - ago, 1_000_000)).toBe(reads);
    });
  }

  it("a clock that has gone backwards reads as just now rather than as the future", () => {
    expect(relativeAge(2_000_000, 1_000_000)).toBe("just now");
  });
});

describe("a row is named after its folder", () => {
  it("uses the name the shell computed", () => {
    expect(displayName(folder({ name: "perseverance" }))).toBe("perseverance");
  });

  it("falls back to the last segment of the path, either separator", () => {
    expect(displayName(folder({ name: "", path: "C:\\work\\atlas" }))).toBe("atlas");
    expect(displayName(folder({ name: "  ", path: "/home/you/atlas" }))).toBe("atlas");
    expect(displayName(folder({ name: "", path: "/home/you/atlas/" }))).toBe("atlas");
  });

  it("a root has no last segment, so it names itself rather than nothing", () => {
    expect(basename("C:\\")).toBe("C:");
    expect(basename("/")).toBe("/");
    expect(displayName(folder({ name: "", path: "C:\\" }))).toBe("C:");
  });
});

describe("a folder that is not a usable repository says exactly what is wrong", () => {
  const refusals: readonly RepoBinding[] = [
    { kind: "notAGitRepo" },
    { kind: "noGitHubRemote" },
    { kind: "ambiguousRemotes", candidates: ["origin", "upstream"] },
  ];

  it("three refusals are three different sentences", () => {
    const said = refusals.map(describeBinding);

    expect(new Set(said).size).toBe(3);
    expect(new Set(refusals.map(bindingHeadline)).size).toBe(3);
  });

  it("no .git names the missing .git", () => {
    expect(describeBinding({ kind: "notAGitRepo" })).toContain(".git");
    expect(describeBinding({ kind: "notAGitRepo" })).toContain("git init");
  });

  it("no GitHub remote names github.com, and says how to add one", () => {
    const said = describeBinding({ kind: "noGitHubRemote" });

    expect(said).toContain("github.com");
    expect(said).toContain("git remote add");
  });

  it("ambiguous remotes name the remotes, because that is the whole complaint", () => {
    const said = describeBinding({
      kind: "ambiguousRemotes",
      candidates: ["origin", "upstream"],
    });

    expect(said).toContain("origin");
    expect(said).toContain("upstream");
  });

  it("a bound folder derives owner/repo and says it is written down nowhere", () => {
    const said = describeBinding({ kind: "bound", owner: "javrasya", name: "perseverance" });

    expect(said).toContain("javrasya/perseverance");
    expect(said).toContain("nowhere");
  });

  it("names the remotes in prose rather than as a bare array", () => {
    expect(listOut(["origin"])).toBe("origin");
    expect(listOut(["origin", "upstream"])).toBe("origin and upstream");
    expect(listOut(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("nothing the launcher refuses reads as a failure to talk to GitHub", () => {
  /*
   * The fix for "this folder has no GitHub remote" and the fix for "GitHub
   * could not be read" are different fixes, so the two must never sound alike.
   * This is the mechanical half of that claim.
   */
  const NETWORK_WORDS = [
    "reach",
    "connect",
    "network",
    "timeout",
    "offline",
    "retry",
    "server",
  ];

  const everythingSaid: readonly string[] = [
    describeBinding({ kind: "notAGitRepo" }),
    describeBinding({ kind: "noGitHubRemote" }),
    describeBinding({ kind: "ambiguousRemotes", candidates: ["origin", "upstream"] }),
    describeBinding({ kind: "bound", owner: "javrasya", name: "perseverance" }),
    bindingHeadline({ kind: "notAGitRepo" }),
    bindingHeadline({ kind: "noGitHubRemote" }),
    bindingHeadline({ kind: "ambiguousRemotes", candidates: [] }),
    describeNote({ kind: "pathGone", path: "D:\\Archive\\atlas" }),
    noteHeadline({ kind: "pathGone", path: "D:\\Archive\\atlas" }),
    describeNote({ kind: "refused", detail: "" }),
    noteHeadline({ kind: "refused", detail: "" }),
    REGISTRY_REFUSED_HEADLINE,
    REGISTRY_REFUSED_COUNSEL,
    REGISTRY_REFUSED_FALLBACK,
  ];

  for (const word of NETWORK_WORDS) {
    it(`never says "${word}"`, () => {
      const guilty = everythingSaid.filter((said) => said.toLowerCase().includes(word));

      expect(guilty).toEqual([]);
    });
  }

  it("the store's refusal is about a file on this machine, not about somewhere else", () => {
    expect(REGISTRY_REFUSED_COUNSEL).toContain("this machine");
    expect(REGISTRY_REFUSED_COUNSEL).toContain("left exactly as it was found");
  });

  it("the counsel says what was done, and leaves why to the store's own words", () => {
    // A registry can be refused for a schema version this build does not know,
    // and it can be refused because the file could not be read at all. Only the
    // first of those is about a schema version, so fixed copy may not claim it:
    // the reason arrives beside this, written by whoever refused.
    expect(REGISTRY_REFUSED_COUNSEL).not.toContain("schema version");
    expect(REGISTRY_REFUSED_FALLBACK).not.toContain("schema version");
    expect(
      refusalDetail("this launcher registry records schema version 99"),
    ).toContain("schema version 99");
  });
});

describe("an edit the registry declines is answered rather than swallowed", () => {
  it("says the registry's own sentence, and what became of the list", () => {
    const said = describeNote({
      kind: "refused",
      detail: "D:\\work\\beta is already on the list",
    });

    expect(said).toContain("D:\\work\\beta is already on the list");
    expect(said).toContain("The list is exactly as it was.");
    expect(noteHeadline({ kind: "refused", detail: "anything" })).toBe("Nothing changed");
  });

  it("says something true even when the refusal came back wordless", () => {
    expect(describeNote({ kind: "refused", detail: "   " })).toBe(
      "That did not happen. The list is exactly as it was.",
    );
  });
});

describe("a missing path is explained as a fact about this machine", () => {
  it("names the path, offers both ways out, and promises the row stays", () => {
    const said = describeNote({ kind: "pathGone", path: "D:\\Archive\\atlas" });

    expect(said).toContain("D:\\Archive\\atlas");
    expect(said).toContain("Locate…");
    expect(noteHeadline({ kind: "pathGone", path: "D:\\Archive\\atlas" })).toBe(
      "Path missing",
    );
  });
});

describe("the store's refusal arrives as its own words, however the shell wrapped it", () => {
  it("passes a string refusal through", () => {
    expect(refusalDetail("schema version 4, and this build speaks 1")).toBe(
      "schema version 4, and this build speaks 1",
    );
  });

  it("unwraps an Error", () => {
    expect(refusalDetail(new Error("schema version 4"))).toBe("schema version 4");
  });

  it("says something true when the shell says nothing at all", () => {
    expect(refusalDetail(undefined)).toBe(REGISTRY_REFUSED_FALLBACK);
    expect(refusalDetail("   ")).toBe(REGISTRY_REFUSED_FALLBACK);
  });
});

describe("the dev:web fixture carries the states a browser cannot conjure", () => {
  const view = loadFixture();

  it("has a folder that is there and a folder that is not", () => {
    expect(view.folders.some((one) => one.present)).toBe(true);
    expect(view.folders.some((one) => !one.present)).toBe(true);
  });

  it("every row is well formed, so the fixture is the same seam Rust fills", () => {
    for (const one of view.folders) {
      expect(typeof one.id).toBe("number");
      expect(one.path.length).toBeGreaterThan(0);
      expect(one.name.length).toBeGreaterThan(0);
      expect(typeof one.lastOpened).toBe("number");
    }
  });

  it("opening a folder it already lists touches that row rather than adding a second", async () => {
    // `Store::remember_folder` inserts or touches by path, and the preview has
    // to model the same rule or `dev:web` teaches the opposite of the shell.
    const listed = view.folders[0];
    expect(listed).toBeDefined();

    const first = await rememberFolder(listed!.path);
    const again = await rememberFolder(listed!.path);

    expect(first.id).toBe(listed!.id);
    expect(again.id).toBe(listed!.id);
  });

  it("a folder it has never listed joins with an id of its own", async () => {
    const one = await rememberFolder("C:\\work\\somewhere-new");
    const other = await rememberFolder("C:\\work\\somewhere-else");

    expect(one.id).not.toBe(other.id);
    expect(one.name).toBe("somewhere-new");
  });

  it("hands out a copy, so the browser preview cannot edit the fixture", () => {
    const first = loadFixture().folders[0];
    expect(first).toBeDefined();
    first!.name = "scribbled on";

    expect(loadFixture().folders[0]?.name).not.toBe("scribbled on");
  });
});

describe("a binding read from untyped JSON is narrowed rather than trusted", () => {
  it("recognises each of the four shapes", () => {
    expect(bindingFrom({ kind: "bound", owner: "o", name: "r" })).toEqual({
      kind: "bound",
      owner: "o",
      name: "r",
    });
    expect(bindingFrom({ kind: "noGitHubRemote" })).toEqual({ kind: "noGitHubRemote" });
    expect(bindingFrom({ kind: "ambiguousRemotes", candidates: ["origin", 7] })).toEqual({
      kind: "ambiguousRemotes",
      candidates: ["origin"],
    });
    expect(bindingFrom({ kind: "notAGitRepo" })).toEqual({ kind: "notAGitRepo" });
  });

  it("anything unrecognised reads as the folder having no .git", () => {
    expect(bindingFrom(undefined)).toEqual({ kind: "notAGitRepo" });
    expect(bindingFrom("bound")).toEqual({ kind: "notAGitRepo" });
    expect(bindingFrom({ kind: "somethingElse" })).toEqual({ kind: "notAGitRepo" });
  });
});
