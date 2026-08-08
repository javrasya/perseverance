import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FOLDER_PANEL_ID,
  FolderReadout as FolderPanel,
} from "../src/environment/FolderReadout";
import {
  ASK_AGAIN_LABEL,
  ASK_AGAIN_NOTE,
  CLI_MISSING_COUNSEL,
  CLI_MISSING_HEADLINE,
  FOLDER_CANNOT_TELL_YOU,
  FOLDER_PATH_NOTE,
  NO_PROBE_DECLARED,
  OVERRIDE_APPLIES_TO_EVERY_ADAPTER,
  OVERRIDE_ARGV_NOTE,
  OVERRIDE_FIELD_LABEL,
  OVERRIDE_NOT_REMEMBERED_COUNSEL,
  OVERRIDE_NOT_REMEMBERED_FALLBACK,
  OVERRIDE_REFUSED_COUNSEL,
  OVERRIDE_REFUSED_FALLBACK,
  OVERRIDE_SCOPE_NOTE,
  OVERRIDE_SPLIT_NOTE,
  OVERRIDE_SUBMIT_LABEL,
  PROBE_DID_NOT_RUN_FALLBACK,
  PROBE_NOTE,
  RESOLUTION_NOTE,
  SPAWN_DIRECTORY_NOTE,
  argvFrom,
  fixtureFolder,
  folderFactsLine,
  folderFixtureKeys,
  missingCli,
  namesTried,
  overrideLine,
  pathEntries,
  probeLine,
  readoutFrom,
  resolutionLine,
  resolutionSource,
  resolutionSummary,
  scopeLabel,
  useOverride,
  type FolderReadout,
} from "../src/environment/folder";
import { FolderList } from "../src/launcher/FolderList";
import { describeNote, noteHeadline } from "../src/launcher/launcher";

const PINNED_PATH =
  "/Users/you/work/perseverance/node_modules/.bin:/Users/you/.local/share/fnm/node-versions/v22.11.0/installation/bin:/opt/homebrew/bin:/usr/bin:/bin";

/* --------------------------------------------------------------- shape --- */

describe("the folder readout is one seam, spelled twice", () => {
  /*
   * `src/environment/folder.ts` is a hand-written mirror of the app crate's
   * `FolderReadout`, and `crates/app/src/lib.rs` counts the same twelve keys.
   * A rename on either side is silent on the other, exactly as it is for the
   * app-global readout; two assertions is the whole of the defence.
   */
  it("twelve keys cross, and these twelve", () => {
    const keys = Object.keys(fixtureFolder("resolved")).sort();

    expect(keys).toEqual([
      "adapters",
      "degradation",
      "elapsedMs",
      "folder",
      "harvest",
      "override",
      "path",
      "pathSource",
      "shell",
      "spawnDirectory",
      "stderr",
      "variableCount",
    ]);
    expect(keys).toHaveLength(12);
  });

  it("carries no tally and no token, because neither is a fact about a folder", () => {
    const readout = fixtureFolder("resolved") as unknown as Record<string, unknown>;

    // The frame's counts belong to a harvest and the token to a launch; both
    // are already on the app-global readout, and a second copy per folder would
    // be a second account of the same thing.
    expect(readout.tally).toBeUndefined();
    expect(readout.token).toBeUndefined();
  });
});

/* ------------------------------------------------------------- fixture --- */

describe("the folder fixture carries the states a browser cannot conjure", () => {
  it("has all seven, because you cannot fail a resolution from JavaScript", () => {
    expect(folderFixtureKeys().sort()).toEqual([
      "harvestDiscarded",
      "notFound",
      "overridden",
      "overriddenGlobally",
      "partlyResolved",
      "policyDegraded",
      "resolved",
    ]);
  });

  it("every state is well formed, so the fixture is the seam Rust fills", () => {
    for (const key of folderFixtureKeys()) {
      const state = fixtureFolder(key);

      expect(["harvesting", "harvested", "inherited"]).toContain(state.harvest.kind);
      expect(["loginShell", "powerShell", "none"]).toContain(state.shell.kind);
      expect(["harvest", "inherited", "none"]).toContain(state.pathSource);
      expect(["empty", "text", "clixml"]).toContain(state.stderr.kind);
      expect(["notSeen", "profileRefused"]).toContain(state.degradation.kind);
      expect(["none", "inUse", "notRemembered", "refused"]).toContain(state.override.kind);
      expect(state.folder).not.toBe("");
      expect(state.spawnDirectory).not.toBe("");
      expect(state.adapters.length).toBeGreaterThan(0);
      for (const adapter of state.adapters) {
        expect(["resolved", "notFound"]).toContain(adapter.resolution.kind);
        if (adapter.resolution.kind === "resolved") {
          expect(adapter.resolution.program).not.toBe("");
          expect(["candidate", "override"]).toContain(adapter.resolution.from);
        } else {
          expect(adapter.resolution.names.length).toBeGreaterThan(0);
        }
      }
      // `bytes` is what was read and `text` is the lossy decode of those same
      // bytes, so the relation is `<=` rather than `===`.
      expect(state.stderr.bytes).toBeLessThanOrEqual(
        new TextEncoder().encode(state.stderr.text).length,
      );
    }
  });

  it("carries a folder that resolves under its own pin", () => {
    const resolved = fixtureFolder("resolved");
    const adapter = resolved.adapters[0];
    if (adapter === undefined) throw new Error("the fixture lists no adapter");
    if (adapter.resolution.kind !== "resolved") throw new Error("nothing resolved");

    // The absolute path sits under the pinned interpreter's own directory,
    // which is the only visible form a version pin has.
    expect(resolved.path).toBe(PINNED_PATH);
    expect(adapter.resolution.program).toContain("node-versions/v22.11.0");
    expect(adapter.resolution.from).toBe("candidate");
    expect(missingCli(resolved)).toBe(false);
  });

  it("carries a folder whose CLI is nowhere, and one whose harvest was discarded", () => {
    const missing = fixtureFolder("notFound");
    const discarded = fixtureFolder("harvestDiscarded");

    expect(missingCli(missing)).toBe(true);
    // Every registered adapter's own name, in the registry's order — and here
    // that is all of them, because the note only fires when every one of them
    // came back with nothing.
    expect(namesTried(missing)).toEqual(["claude", "codex", "pi"]);
    // Criterion 7's four facts are all on the one value: the names tried, the
    // shell that ran, what became of the harvest, and the verbatim PATH.
    expect(missing.shell.kind).toBe("loginShell");
    expect(missing.harvest.kind).toBe("harvested");
    expect(missing.path).not.toBeNull();

    expect(discarded.harvest.kind).toBe("inherited");
    expect(discarded.pathSource).toBe("inherited");
    expect(discarded.stderr.text).toContain("command not found: fnm");
  });

  it("carries the folder every real machine is on: one agent installed and two not", () => {
    const partly = fixtureFolder("partlyResolved");

    // **The state the note must stay quiet for.** `App.tsx`'s `settleFolder`
    // raises `cliMissing` from this predicate on every folder resolution, so a
    // predicate meaning *any of three* would put a permanent error beside every
    // folder on every machine with fewer than all three CLIs installed — which
    // is nearly every machine, and reads as the two new vendors nagging about
    // themselves rather than as a fact about this folder.
    expect(missingCli(partly)).toBe(false);
    expect(partly.adapters.filter((one) => one.resolution.kind === "notFound")).toHaveLength(2);
    expect(namesTried(partly)).toEqual(["codex", "pi"]);
    // What the operator gets instead is the count, which says the same thing
    // without calling it a failure.
    expect(resolutionSummary(partly)).toBe("1 of 3 adapters resolved here");
  });

  it("says nothing is missing when nothing was looked for", () => {
    // `readoutFrom` reaches an empty adapter list for anything it could not read
    // at all, and an `every` over nothing is vacuously true. Nothing was looked
    // for, so nothing was found to be absent.
    expect(missingCli(readoutFrom(undefined, "/Users/you/work/api"))).toBe(false);
  });

  it("carries a folder whose interpreter declined its start-up file", () => {
    const degraded = fixtureFolder("policyDegraded");

    // Exit 0, both marks, a plausible environment — and still degraded. So the
    // harvest reads as harvested, and the degradation is a field beside it.
    expect(degraded.harvest.kind).toBe("harvested");
    expect(degraded.degradation).toEqual({ kind: "profileRefused" });
    expect(degraded.stderr.text).toContain("cannot _x000D__x000A_be loaded");
  });

  it("carries both scopes an override can have", () => {
    const follows = fixtureFolder("overridden");
    const pinned = fixtureFolder("overriddenGlobally");

    if (follows.override.kind !== "inUse") throw new Error("no override in use");
    if (pinned.override.kind !== "inUse") throw new Error("no override in use");

    // A bare name follows the folder's pin; a path pins the machine. The
    // operator picks which by what they type, and nothing else picks it.
    expect(follows.override.argv[0]).toBe("node");
    expect(follows.override.scope).toBe("followsTheFolder");
    expect(pinned.override.argv[0]).toBe("/Users/you/bin/claude");
    expect(pinned.override.scope).toBe("pinnedGlobally");
    // An argv vector because a path string cannot say `node .../cli.js`.
    expect(follows.override.argv).toHaveLength(2);
  });

  it("hands out a copy, so the preview cannot scribble on the fixture", () => {
    const first = fixtureFolder("resolved");
    first.path = "scribbled on";
    first.adapters.length = 0;

    expect(fixtureFolder("resolved").path).toBe(PINNED_PATH);
    expect(fixtureFolder("resolved").adapters).toHaveLength(3);
  });

  it("carries every registered adapter in every state, because the readout does", () => {
    // `adapters_in` loops `AgentId::ALL` and never learned which adapter it is
    // looking at, so a folder produces one row per registered adapter whatever
    // is installed. The fixture is the seam that side fills, and a state
    // carrying one row would let the panel be built for a list of one.
    for (const key of folderFixtureKeys()) {
      expect([key, fixtureFolder(key).adapters.map((adapter) => adapter.id)]).toEqual([
        key,
        ["claude", "codex", "pi"],
      ]);
    }
  });

  it("carries the two adapters whose interpreter is asked about, and the one whose is not", () => {
    const resolved = fixtureFolder("resolved");
    const byId = (id: string) => resolved.adapters.find((adapter) => adapter.id === id);

    // Claude Code is a native image on a supported install and declares no
    // probe; the two npm-installed ones sit on a `node` and declare one. Nothing
    // reads a version out of either — the probe is here to be looked at.
    expect(byId("claude")?.probes).toEqual([]);
    expect(byId("codex")?.probes.map((probe) => probe.program)).toEqual(["node"]);
    expect(byId("pi")?.probes.map((probe) => probe.program)).toEqual(["node"]);

    // And pi's Windows reading has the extra one, because pi's own bash tool
    // fails at runtime without a bash — which is why it is a probe rather than
    // a refusal to plan.
    const windows = fixtureFolder("policyDegraded");
    expect(
      windows.adapters.find((adapter) => adapter.id === "pi")?.probes.map((p) => p.program),
    ).toEqual(["node", "bash"]);
  });

  it("a state nobody has heard of falls back to the one worth looking at", () => {
    expect(fixtureFolder("nonesuch")).toEqual(fixtureFolder("resolved"));
  });
});

/* ----------------------------------------------------------- narrowing --- */

describe("a folder readout read from untyped JSON is narrowed rather than trusted", () => {
  it("anything unrecognised claims nothing about the folder", () => {
    for (const garbage of [undefined, null, "resolved", 7, []]) {
      const narrowed = readoutFrom(garbage);

      expect(narrowed.harvest.kind).toBe("inherited");
      expect(narrowed.shell).toEqual({ kind: "none" });
      expect(narrowed.adapters).toEqual([]);
      expect(narrowed.override).toEqual({ kind: "none" });
      expect(narrowed.path).toBeNull();
    }
  });

  it("an unknown tag on any union reads as its quietest member", () => {
    const narrowed = readoutFrom({
      harvest: { kind: "somethingElse" },
      shell: { kind: "fish" },
      stderr: { kind: "xml" },
      degradation: { kind: "somethingWorse" },
      pathSource: "elsewhere",
      override: { kind: "borrowed" },
      adapters: [{ id: "claude", resolution: { kind: "guessed" }, probes: "many" }],
    });

    expect(narrowed.harvest.kind).toBe("inherited");
    expect(narrowed.shell).toEqual({ kind: "none" });
    expect(narrowed.stderr.kind).toBe("empty");
    expect(narrowed.degradation).toEqual({ kind: "notSeen" });
    expect(narrowed.pathSource).toBe("none");
    expect(narrowed.override).toEqual({ kind: "none" });
    expect(narrowed.adapters[0]?.resolution).toEqual({ kind: "notFound", names: [] });
    expect(narrowed.adapters[0]?.probes).toEqual([]);
  });

  it("the folder asked for stands in when nothing came back naming one", () => {
    // A readout that arrived shapeless still knows which folder was asked
    // about, because the caller knew before it asked.
    expect(readoutFrom(undefined, "/Users/you/work/notes").folder).toBe(
      "/Users/you/work/notes",
    );
    expect(readoutFrom({ folder: "/elsewhere" }, "/Users/you/work/notes").folder).toBe(
      "/elsewhere",
    );
  });

  it("a probe that answered with nothing is not the same as one that did not run", () => {
    const answered = readoutFrom({
      adapters: [
        {
          id: "claude",
          resolution: { kind: "notFound", names: ["claude"] },
          probes: [{ program: "node", args: ["--version"], outcome: { kind: "answered" } }],
        },
      ],
    });
    const outcome = answered.adapters[0]?.probes[0]?.outcome;

    expect(outcome).toEqual({ kind: "answered", status: null, line: "" });
    expect(
      readoutFrom({
        adapters: [
          {
            id: "claude",
            resolution: { kind: "notFound", names: [] },
            probes: [{ program: "node", args: [], outcome: { kind: "didNotRun" } }],
          },
        ],
      }).adapters[0]?.probes[0]?.outcome,
    ).toEqual({ kind: "didNotRun", detail: PROBE_DID_NOT_RUN_FALLBACK });
  });
});

/* ---------------------------------------------------------------- PATH --- */

describe("the folder's verbatim PATH crosses unchanged and is split only for reading", () => {
  it("the same string, the same length, nothing elided", () => {
    const resolved = fixtureFolder("resolved");

    expect(resolved.path).toBe(PINNED_PATH);
    expect(resolved.path).toHaveLength(PINNED_PATH.length);
    expect(resolved.path).not.toContain("…");
    expect(resolved.path).not.toContain("...");
  });

  it("splitting produces the entries and never replaces the string", () => {
    const resolved = fixtureFolder("resolved");

    expect(pathEntries(resolved).join(":")).toBe(PINNED_PATH);
    expect(resolved.path).toBe(PINNED_PATH);
  });

  it("a Windows folder PATH is split on the semicolon, because it is full of colons", () => {
    const entries = pathEntries(fixtureFolder("policyDegraded"));

    expect(entries[0]).toBe("C:\\Windows\\system32");
    expect(entries).toHaveLength(4);
  });

  it("says out loud that this PATH is the folder's own and not the app's", () => {
    expect(FOLDER_PATH_NOTE).toContain("started in this folder");
    expect(FOLDER_PATH_NOTE).toContain("two different files");
  });
});

/* --------------------------------------------------------- what to type --- */

describe("what the operator typed becomes an argument vector, and is shown back first", () => {
  it("splits on whitespace", () => {
    expect(argvFrom("claude")).toEqual(["claude"]);
    expect(argvFrom("node /opt/claude/cli.js")).toEqual(["node", "/opt/claude/cli.js"]);
    expect(argvFrom("  node   /opt/cli.js  ")).toEqual(["node", "/opt/cli.js"]);
    expect(argvFrom("node\t/opt/cli.js\n--flag")).toEqual(["node", "/opt/cli.js", "--flag"]);
  });

  it("double quotes group, so a path with a space in it stays one word", () => {
    expect(argvFrom('node "C:\\Program Files\\claude\\cli.js"')).toEqual([
      "node",
      "C:\\Program Files\\claude\\cli.js",
    ]);
    // A backslash is a backslash. Treating it as an escape would eat every
    // Windows path an operator could type.
    expect(argvFrom("C:\\tools\\claude.exe")).toEqual(["C:\\tools\\claude.exe"]);
  });

  it("nothing typed is no vector at all, which is a refusal rather than a clearing", () => {
    expect(argvFrom("")).toEqual([]);
    expect(argvFrom("   ")).toEqual([]);
    expect(argvFrom("\t\n")).toEqual([]);
    // Quotes with nothing in them are a word the operator typed, and Rust
    // refuses it by name rather than reading it as *no override*.
    expect(argvFrom('""')).toEqual([""]);
  });

  it("says out loud how the split works and that the result is shown first", () => {
    expect(OVERRIDE_SPLIT_NOTE).toContain("double quotes");
    expect(OVERRIDE_SPLIT_NOTE).toContain("shown below it before anything uses it");
  });

  it("says which scope each shape of first word gets, and that it is app-wide", () => {
    expect(OVERRIDE_SCOPE_NOTE).toContain("bare name");
    expect(OVERRIDE_SCOPE_NOTE).toContain("follows whatever that folder pins");
    expect(OVERRIDE_SCOPE_NOTE).toContain("taken at its word everywhere");
    expect(OVERRIDE_SCOPE_NOTE).toContain("every folder rather than for this one");
    expect(scopeLabel("followsTheFolder")).toContain("follows each folder");
    expect(scopeLabel("pinnedGlobally")).toContain("pins this machine");
  });

  it("says why it is a list of words and not a file to point at", () => {
    expect(OVERRIDE_ARGV_NOTE).toContain("node /opt/claude/cli.js");
  });
});

describe("a browser can be shown an override it cannot actually set", () => {
  it("echoes the vector back and names a scope for it", async () => {
    const typed = await useOverride("/Users/you/work/notes", argvFrom("/Users/you/bin/claude"));

    expect(typed.override).toEqual({
      kind: "inUse",
      argv: ["/Users/you/bin/claude"],
      scope: "pinnedGlobally",
    });
    expect(typed.adapters[0]?.resolution.kind).toBe("resolved");
  });

  it("refuses a vector that names no program", async () => {
    const nothing = await useOverride("/Users/you/work/notes", argvFrom('""'));

    expect(nothing.override).toEqual({
      kind: "refused",
      detail: OVERRIDE_REFUSED_FALLBACK,
    });
  });
});

/* ---------------------------------------------------------- derivation --- */

describe("what an adapter resolved to is the absolute path and nothing else", () => {
  it("shows the file, because that is the only visible form a pin has", () => {
    const adapter = fixtureFolder("resolved").adapters[0];
    if (adapter === undefined) throw new Error("the fixture lists no adapter");

    expect(resolutionLine(adapter)).toBe(
      "/Users/you/.local/share/fnm/node-versions/v22.11.0/installation/bin/claude",
    );
    expect(resolutionSource(adapter)).toContain("claude");
  });

  it("names the names it tried when nothing answered", () => {
    const adapter = fixtureFolder("notFound").adapters[0];
    if (adapter === undefined) throw new Error("the fixture lists no adapter");

    expect(resolutionLine(adapter)).toContain("claude");
    expect(resolutionLine(adapter)).toContain("no answer on this PATH");
    expect(resolutionSource(adapter)).toBe("nothing resolved");
  });

  it("says an override answered when one did", () => {
    const adapter = fixtureFolder("overridden").adapters[0];
    if (adapter === undefined) throw new Error("the fixture lists no adapter");

    expect(resolutionSource(adapter)).toContain("override you typed");
  });

  it("shows what a probe was asked as well as what it said", () => {
    const probe = fixtureFolder("overridden").adapters[0]?.probes[0];
    if (probe === undefined) throw new Error("the fixture declares no probe");

    expect(probeLine(probe)).toBe("node --version · v22.11.0");
    expect(probeLine({ program: "node", args: [], outcome: { kind: "notOnThisPath" } })).toContain(
      "nothing of that name",
    );
    expect(
      probeLine({
        program: "node",
        args: [],
        outcome: { kind: "didNotRun", detail: "it stopped after 8000 ms" },
      }),
    ).toContain("it stopped after 8000 ms");
  });

  it("the closed state counts the adapters rather than showing the first one", () => {
    // Three ship, so a summary that was one adapter's own line would hide two
    // thirds of the panel behind the chevron and read as the whole answer.
    expect(resolutionSummary(fixtureFolder("resolved"))).toBe("3 of 3 adapters resolved here");
    expect(resolutionSummary(fixtureFolder("notFound"))).toBe("0 of 3 adapters resolved here");
  });

  it("says nothing at all where nothing is overridden", () => {
    expect(overrideLine(fixtureFolder("resolved"))).toBe("—");
    expect(overrideLine(fixtureFolder("overridden"))).toBe(
      "node /Users/you/.claude/local/cli.js",
    );
  });

  it("spells where the PATH came from without claiming anything about it", () => {
    expect(folderFactsLine(fixtureFolder("resolved"))).toContain("this folder's harvest");
    expect(folderFactsLine(fixtureFolder("harvestDiscarded"))).toContain("started with");
  });
});

/* ------------------------------------------------------------- the note --- */

describe("a missing CLI is a note beside an opened folder, never a refusal that replaced one", () => {
  const note = { kind: "cliMissing", readout: fixtureFolder("notFound") } as const;

  /** The launcher, rendered around one note, as markup. */
  function launcherWith(shown: FolderReadout): string {
    return renderToStaticMarkup(
      createElement(FolderList, {
        outcome: { kind: "listed", view: { folders: [] } },
        now: 0,
        selectedId: null,
        note: { kind: "cliMissing", readout: shown },
        onOpen: () => {},
        onLocate: () => {},
        onForget: () => {},
        onOpenNew: () => {},
        onOverride: () => {},
        onAskAgain: () => {},
      }),
    );
  }


  it("names what was looked for, from the readout rather than from an assumption", () => {
    expect(noteHeadline(note)).toBe(CLI_MISSING_HEADLINE);
    expect(describeNote(note)).toContain("claude");
    expect(describeNote(note)).toContain(CLI_MISSING_COUNSEL);
  });

  it("says the folder is open and that the difference is between two shells", () => {
    expect(CLI_MISSING_COUNSEL).toContain("The folder is open");
    expect(CLI_MISSING_COUNSEL).toContain("your own terminal");
    expect(CLI_MISSING_COUNSEL).toContain("answering differently");
  });

  it("puts the evidence and both ways out inside the note itself", () => {
    const markup = launcherWith(note.readout);

    // The verbatim PATH, scrollable and keyboard-reachable, because a region a
    // keyboard cannot reach is a region a keyboard user cannot read.
    expect(markup).toContain('aria-label="PATH, exactly as it arrived"');
    expect(markup).toContain("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(markup).toContain("/bin/zsh -lic");
    // And the inline field, with no navigation between the error and the fix.
    expect(markup).toContain(OVERRIDE_FIELD_LABEL);
    expect(markup).toContain(OVERRIDE_SUBMIT_LABEL);
    expect(markup).toContain(ASK_AGAIN_LABEL);
    expect(markup).not.toContain('role="dialog"');
  });

  /** The same folder, with a refusal of the vector last typed into the field. */
  const refused = {
    ...fixtureFolder("notFound"),
    override: { kind: "refused", detail: OVERRIDE_REFUSED_FALLBACK },
  } satisfies FolderReadout;

  it("says beside the field what became of the vector submitted from it", () => {
    // An override naming no program changes nothing, and the panel that also
    // says so opens closed — so a refusal that only landed there would be a
    // click with no visible answer at the place it was clicked.
    const markup = launcherWith(refused);

    expect(markup).toContain(OVERRIDE_REFUSED_FALLBACK);
    expect(markup).toContain(OVERRIDE_REFUSED_COUNSEL);
    expect(markup).toContain('data-override="refused"');

    // The same for a vector that took but could not be written down: it is in
    // force now and gone at the next start, which is a different sentence.
    const unwritten = {
      ...fixtureFolder("notFound"),
      override: {
        kind: "notRemembered",
        argv: ["claude"],
        detail: OVERRIDE_NOT_REMEMBERED_FALLBACK,
      },
    } satisfies FolderReadout;

    expect(launcherWith(unwritten)).toContain(OVERRIDE_NOT_REMEMBERED_COUNSEL);

    // And nothing at all where there is nothing to say.
    expect(launcherWith(fixtureFolder("notFound"))).not.toContain("data-override");
  });
});

/* -------------------------------------------------------------- panel --- */

describe("the folder panel puts the evidence on screen rather than a summary of it", () => {
  const markupFor = (key: string, shown = true) =>
    renderToStaticMarkup(
      createElement(FolderPanel, {
        readout: fixtureFolder(key),
        shown,
        onToggle: () => {},
        onAskAgain: () => {},
      }),
    );

  it("renders this folder's PATH in one piece, exactly as it arrived", () => {
    expect(markupFor("resolved")).toContain(PINNED_PATH);
  });

  it("renders the absolute file each adapter resolved to", () => {
    expect(markupFor("resolved")).toContain(
      "/Users/you/.local/share/fnm/node-versions/v22.11.0/installation/bin/claude",
    );
  });

  it("says why an adapter with no probe declared has none, rather than showing a blank", () => {
    expect(markupFor("resolved")).toContain(NO_PROBE_DECLARED.slice(0, 40));
    expect(markupFor("overridden")).toContain("v22.11.0");
  });

  it("renders a row for every registered adapter, not only the one that resolved", () => {
    const markup = markupFor("notFound");

    for (const id of ["claude", "codex", "pi"]) {
      expect([id, markup.includes(`What ${id} resolved to`)]).toEqual([id, true]);
    }
  });

  it("says the one override applies to all of them, so three identical rows read right", () => {
    expect(markupFor("overridden")).toContain(OVERRIDE_APPLIES_TO_EVERY_ADAPTER.slice(0, 40));
  });

  it("names the declined start-up file when the interpreter said so", () => {
    expect(markupFor("policyDegraded")).toContain("Start-up file declined");
    expect(markupFor("resolved")).toContain("Nothing said");
  });

  it("renders what the shell wrote in this folder without repairing it", () => {
    expect(markupFor("policyDegraded")).toContain("cannot _x000D__x000A_be loaded");
  });

  it("is in the DOM whether or not it is open, so aria-controls names something", () => {
    for (const shown of [true, false]) {
      const markup = markupFor("resolved", shown);

      expect(markup).toContain(`id="${FOLDER_PANEL_ID}"`);
      expect(markup).toContain(`data-shown="${shown}"`);
      expect(markup).toContain(`aria-controls="${FOLDER_PANEL_ID}"`);
    }
  });

  it("carries no live region and nothing to dismiss", () => {
    for (const key of folderFixtureKeys()) {
      const markup = markupFor(key);

      expect([key, markup.includes("aria-live")]).toEqual([key, false]);
      expect([key, markup.includes('role="alert"')]).toEqual([key, false]);
      expect([key, markup.includes('role="dialog"')]).toEqual([key, false]);
    }
  });

  it("reaches every state without throwing on the way", () => {
    for (const key of folderFixtureKeys()) {
      expect([key, markupFor(key).length > 0]).toEqual([key, true]);
    }
  });
});

/* ---------------------------------------------------------------- copy --- */

const everythingSaid: readonly string[] = [
  CLI_MISSING_HEADLINE,
  CLI_MISSING_COUNSEL,
  FOLDER_PATH_NOTE,
  SPAWN_DIRECTORY_NOTE,
  OVERRIDE_FIELD_LABEL,
  OVERRIDE_SUBMIT_LABEL,
  OVERRIDE_SPLIT_NOTE,
  OVERRIDE_SCOPE_NOTE,
  OVERRIDE_ARGV_NOTE,
  OVERRIDE_APPLIES_TO_EVERY_ADAPTER,
  OVERRIDE_NOT_REMEMBERED_COUNSEL,
  OVERRIDE_NOT_REMEMBERED_FALLBACK,
  OVERRIDE_REFUSED_FALLBACK,
  OVERRIDE_REFUSED_COUNSEL,
  ASK_AGAIN_LABEL,
  ASK_AGAIN_NOTE,
  NO_PROBE_DECLARED,
  PROBE_NOTE,
  PROBE_DID_NOT_RUN_FALLBACK,
  RESOLUTION_NOTE,
  ...FOLDER_CANNOT_TELL_YOU,
  scopeLabel("followsTheFolder"),
  scopeLabel("pinnedGlobally"),
  resolutionLine(fixtureFolder("notFound").adapters[0] as never),
  folderFactsLine(fixtureFolder("harvestDiscarded")),
  describeNote({ kind: "cliMissing", readout: fixtureFolder("notFound") }),
];

describe("nothing this panel says reads as a failure to talk to GitHub", () => {
  /*
   * The launcher's seven words, for the launcher's reason: the fix for "this
   * folder resolves nothing" and the fix for "GitHub could not be read" are
   * different fixes, so the two may never sound alike. *retry* is on that list,
   * which is why the button says "Ask again".
   */
  const NETWORK_WORDS = ["reach", "connect", "network", "timeout", "offline", "retry", "server"];

  for (const word of NETWORK_WORDS) {
    it(`never says "${word}"`, () => {
      expect(everythingSaid.filter((said) => said.toLowerCase().includes(word))).toEqual([]);
    });
  }

  it("the button that forgets says ask again, in as many words", () => {
    expect(ASK_AGAIN_LABEL).toBe("Ask again");
    expect(ASK_AGAIN_NOTE).toContain("Asks this folder's login shell again");
  });
});

describe("a resolution is never described as a correct one", () => {
  /*
   * Resolvable is not spawnable and spawnable is not correct. This says which
   * file a name resolved to, and stops.
   */
  for (const word of ["correct", "ready", "working", "healthy", "verified", "valid"]) {
    it(`never says "${word}"`, () => {
      expect(everythingSaid.filter((said) => said.toLowerCase().includes(word))).toEqual([]);
    });
  }

  it("never blames the operator's start-up files for what it could not read", () => {
    for (const said of everythingSaid) {
      const lowered = said.toLowerCase();
      expect([said, lowered.includes("your fault")]).toEqual([said, false]);
      expect([said, lowered.includes("misconfigured")]).toEqual([said, false]);
      expect([said, lowered.includes("broken")]).toEqual([said, false]);
    }
  });

  it("keeps the limits on the panel rather than in a document nobody opens", () => {
    expect(FOLDER_CANNOT_TELL_YOU).toHaveLength(4);
    for (const limit of FOLDER_CANNOT_TELL_YOU) {
      expect(limit.length).toBeGreaterThan(40);
    }
    // The two that are this ticket's own: nothing expires, and nothing looks
    // anywhere the PATH did not name.
    expect(FOLDER_CANNOT_TELL_YOU.join(" ")).toContain("until you ask again");
    expect(FOLDER_CANNOT_TELL_YOU.join(" ")).toContain("PATH did not name");
  });

  it("says the directory was set on the child rather than navigated to", () => {
    expect(SPAWN_DIRECTORY_NOTE).toContain("Nothing navigated there");
    expect(SPAWN_DIRECTORY_NOTE).toContain("two spellings of one directory are one answer");
  });

  it("says the probe is there to be looked at rather than to decide anything", () => {
    expect(PROBE_NOTE).toContain("Nothing here reads a version out of it");
    expect(RESOLUTION_NOTE).toContain("only visible form a version pin has");
  });
});

/* -------------------------------------------------------------- typing --- */

describe("every readout the wire can carry has something to say", () => {
  const overrides: FolderReadout["override"][] = [
    { kind: "none" },
    { kind: "inUse", argv: ["claude"], scope: "followsTheFolder" },
    { kind: "notRemembered", argv: ["claude"], detail: "the registry declined" },
    { kind: "refused", detail: "that names no program" },
  ];

  for (const override of overrides) {
    it(`${override.kind} renders and says something`, () => {
      const markup = renderToStaticMarkup(
        createElement(FolderPanel, {
          readout: { ...fixtureFolder("resolved"), override },
          shown: true,
          onToggle: () => {},
          onAskAgain: () => {},
        }),
      );

      expect(markup.length).toBeGreaterThan(0);
      expect(markup).toContain("Override");
    });
  }
});
