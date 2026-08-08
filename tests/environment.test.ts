import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_PANEL_ID,
  EnvironmentReadout as EnvironmentPanel,
  EnvironmentSummary,
} from "../src/environment/EnvironmentReadout";
import {
  CANNOT_TELL_YOU,
  HARVESTED_COPY,
  HARVESTING_COPY,
  HARVEST_DISCARDED_FALLBACK,
  INHERITED_COUNSEL,
  LOGIN_FLAGS_NOTE,
  NO_SHELL_NAMED,
  PATH_SPLIT_NOTE,
  POWERSHELL_PROFILE_NOTE,
  NOTHING_DECLINED_COPY,
  PROFILE_REFUSED_COPY,
  READOUT_UNREADABLE,
  SHELL_NOT_SETTLED_YET,
  STDERR_NOTE,
  TOKEN_NOTE,
  TOKEN_REFUSED_FALLBACK,
  degradationNote,
  describeContamination,
  describeHarvest,
  factsLine,
  fixtureKeys,
  fixtureState,
  footerSummary,
  harvestHeadline,
  pathEntries,
  readoutFrom,
  settledOver,
  shellLine,
  shellNote,
  stillHarvesting,
  tokenLabel,
  type EnvironmentReadout,
  type HarvestState,
  type StderrKind,
  type TokenState,
} from "../src/environment/environment";

const HARVESTED_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/you/.local/bin";

const STUB_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function readout(over: Partial<EnvironmentReadout> = {}): EnvironmentReadout {
  return { ...stillHarvesting(), ...over };
}

/* --------------------------------------------------------------- shape --- */

describe("the readout is one seam, spelled twice", () => {
  /*
   * `src/environment/environment.ts` is a hand-written mirror of the app
   * crate's `EnvironmentReadout`, and `crates/app/src/lib.rs` counts the same
   * ten keys. A rename on either side is silent on the other, which is the
   * cost this repo already accepts for the repo bindings; two assertions is
   * the whole of the defence.
   */
  it("ten keys cross, and these ten", () => {
    const keys = Object.keys(fixtureState("harvested")).sort();

    expect(keys).toEqual([
      "degradation",
      "elapsedMs",
      "harvest",
      "path",
      "pathSource",
      "shell",
      "stderr",
      "tally",
      "token",
      "variableCount",
    ]);
    expect(keys).toHaveLength(10);
  });

  it("the tally crosses as six counts", () => {
    expect(Object.keys(fixtureState("noisy").tally).sort()).toEqual([
      "bytesAfterFrame",
      "bytesBeforeFrame",
      "duplicatesDropped",
      "extraOpeningMarks",
      "recordsDropped",
      "recordsSeen",
    ]);
  });

  it("the first paint claims nothing it has not been told", () => {
    const first = stillHarvesting();

    expect(first.harvest.kind).toBe("harvesting");
    expect(first.shell.kind).toBe("none");
    expect(first.path).toBeNull();
    expect(first.pathSource).toBe("none");
    expect(first.token.kind).toBe("notAttempted");
  });
});

/* ------------------------------------------------------------- fixture --- */

describe("the environment fixture carries the states a browser cannot conjure", () => {
  it("has all seven, because you cannot fail a harvest from JavaScript", () => {
    expect(fixtureKeys().sort()).toEqual([
      "harvested",
      "harvesting",
      "inherited",
      "noShell",
      "noisy",
      "stub",
      "windowsClean",
    ]);
  });

  it("carries a silent degradation that looks entirely green", () => {
    const stub = fixtureState("stub");

    // A harvest that worked, from a shell that ran, returning exactly the
    // launchd stub. Nothing in the readout is a complaint, and the PATH is the
    // only place an operator could ever notice.
    expect(stub.harvest.kind).toBe("harvested");
    expect(stub.path).toBe(STUB_PATH);
    expect(stub.pathSource).toBe("harvest");
    expect(stub.token.kind).toBe("refused");
  });

  it("carries the Windows stderr baseline that is not an error", () => {
    const windows = fixtureState("windowsClean");

    expect(windows.harvest.kind).toBe("harvested");
    expect(windows.stderr.kind).toBe("clixml");
    // No byte count is asserted here. 616 is the measured Windows baseline and
    // it stays where it was measured — `harvest.rs`'s
    // `the_windows_baseline_is_serialised_output_and_not_an_error` — rather
    // than being hung on this fixture's shorter, different text.
    // Hard-wrapped mid-word before it was serialised. Shown as it arrived, it
    // looks broken; the panel says so above it rather than repairing evidence.
    expect(windows.stderr.text).toContain("_x000D__x000A_");
    expect(windows.stderr.text).toContain("cannot _x000D__x000A_be loaded");
  });

  it("the transcript the Rust detector is pinned to is still the transcript in this fixture", () => {
    /*
     * The twin of `REFUSED_THE_PROFILE` in `crates/env/src/harvest.rs`, which
     * pins the same transcript as a Rust `const`. `degradation_in` matches two
     * token groups against a flattened copy of this text — PowerShell escapes
     * its hard wrap as `_x000D__x000A_` mid-word before serialising — so a
     * fixture edited to a tidier transcript would leave the detector matching
     * something no machine has ever written, and this fixture is the only
     * recorded example of one that has.
     */
    const windows = fixtureState("windowsClean");
    const flattened = windows.stderr.text
      .replaceAll("_x000D_", " ")
      .replaceAll("_x000A_", " ")
      .split(/\s+/)
      .join(" ")
      .toLowerCase();

    expect(flattened).toContain("cannot be loaded");
    expect(flattened).toContain("not digitally signed");
    // And the fixture says out loud what the Rust side read out of it.
    expect(windows.degradation).toEqual({ kind: "profileRefused" });
    // The classification is not the signal: the progress record is CLIXML too,
    // and it is a Windows baseline rather than anything having been declined.
    expect(fixtureState("noisy").stderr.kind).toBe("clixml");
    expect(fixtureState("noisy").degradation).toEqual({ kind: "notSeen" });
  });

  it("carries a harvest that was discarded, and one that named no shell", () => {
    const discarded = fixtureState("inherited");
    const nameless = fixtureState("noShell");

    expect(discarded.harvest.kind).toBe("inherited");
    expect(discarded.pathSource).toBe("inherited");
    // A discarded harvest still names the shell that ran and still carries
    // what it wrote: the Rust side's `HarvestAttempt` keeps both outside the
    // outcome, because this is the state where the stream is the only account
    // of itself there is.
    expect(discarded.shell.kind).toBe("loginShell");
    expect(discarded.stderr.kind).toBe("text");
    expect(discarded.stderr.text).toContain("command not found: fnm");
    // And no shell at all is the one state where nothing ran to write one.
    expect(nameless.shell.kind).toBe("none");
    expect(nameless.stderr.kind).toBe("empty");
  });

  it("carries contamination the parser has already dealt with", () => {
    const noisy = fixtureState("noisy");

    expect(noisy.harvest.kind).toBe("harvested");
    expect(noisy.tally.recordsDropped).toBe(5);
    expect(noisy.tally.bytesAfterFrame).toBe(61);
  });

  it("every state is well formed, so the fixture is the seam Rust fills", () => {
    for (const key of fixtureKeys()) {
      const state = fixtureState(key);

      expect(["harvesting", "harvested", "inherited"]).toContain(state.harvest.kind);
      expect(["loginShell", "powerShell", "none"]).toContain(state.shell.kind);
      expect(["harvest", "inherited", "none"]).toContain(state.pathSource);
      expect(["empty", "text", "clixml"]).toContain(state.stderr.kind);
      expect(["acquired", "notAttempted", "refused"]).toContain(state.token.kind);
      expect(["notSeen", "profileRefused"]).toContain(state.degradation.kind);
      expect(state.variableCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("the counts every state declares add up, so the preview is not nonsense", () => {
    // What survived is what was seen less what was dropped. A fixture whose
    // arithmetic is wrong teaches the panel to render a state Rust cannot
    // produce, which is the one thing a fixture must not do.
    for (const key of fixtureKeys()) {
      const state = fixtureState(key);

      // `bytes` is what was read and `text` is `from_utf8_lossy` of those same
      // bytes, so the relation is `<=` rather than `===`: lossy decoding
      // replaces each invalid subsequence with a 3-byte U+FFFD and can only
      // grow the count, never shrink it. A state on the other side of this is
      // one the harvest cannot emit — and the panel prints the pair directly
      // above the text, so it would read "616 bytes" over 273 bytes of it.
      expect(state.stderr.bytes).toBeLessThanOrEqual(
        new TextEncoder().encode(state.stderr.text).length,
      );

      if (state.pathSource !== "harvest") continue;

      expect(
        state.tally.recordsSeen -
          state.tally.recordsDropped -
          state.tally.duplicatesDropped,
      ).toBe(state.variableCount);
    }
  });

  it("hands out a copy, so the preview cannot scribble on the fixture", () => {
    const first = fixtureState("harvested");
    first.path = "scribbled on";
    first.tally.recordsDropped = 99;

    expect(fixtureState("harvested").path).toBe(HARVESTED_PATH);
    expect(fixtureState("harvested").tally.recordsDropped).toBe(0);
  });

  it("a state nobody has heard of falls back to the one worth looking at", () => {
    expect(fixtureState("nonesuch")).toEqual(fixtureState("harvested"));
  });
});

/* ----------------------------------------------------------- narrowing --- */

describe("a readout read from untyped JSON is narrowed rather than trusted", () => {
  it("anything unrecognised reads as the environment the app was started with", () => {
    for (const garbage of [undefined, null, "harvested", 7, []]) {
      expect(readoutFrom(garbage).harvest).toEqual({
        kind: "inherited",
        detail: READOUT_UNREADABLE,
      });
    }
  });

  it("an unknown tag on any of the five unions reads as its quietest member", () => {
    const narrowed = readoutFrom({
      harvest: { kind: "somethingElse" },
      shell: { kind: "fish" },
      stderr: { kind: "xml" },
      token: { kind: "stolen" },
      degradation: { kind: "somethingWorse" },
      pathSource: "elsewhere",
    });

    expect(narrowed.harvest.kind).toBe("inherited");
    expect(narrowed.shell).toEqual({ kind: "none" });
    expect(narrowed.stderr.kind).toBe("empty");
    expect(narrowed.token).toEqual({ kind: "notAttempted" });
    // `notSeen` claims the least: nothing nameable was said, which is weaker
    // than nothing having happened.
    expect(narrowed.degradation).toEqual({ kind: "notSeen" });
    expect(narrowed.pathSource).toBe("none");
  });

  it("a count that is not a count reads as none", () => {
    const narrowed = readoutFrom({
      variableCount: -4,
      elapsedMs: "187",
      tally: { recordsSeen: 1.9, recordsDropped: Number.POSITIVE_INFINITY },
    });

    expect(narrowed.variableCount).toBe(0);
    expect(narrowed.elapsedMs).toBe(0);
    expect(narrowed.tally.recordsSeen).toBe(1);
    expect(narrowed.tally.recordsDropped).toBe(0);
  });

  it("flags that are not text are dropped rather than rendered", () => {
    expect(
      readoutFrom({ shell: { kind: "loginShell", program: "/bin/zsh", flags: ["-lic", 7] } })
        .shell,
    ).toEqual({ kind: "loginShell", program: "/bin/zsh", flags: ["-lic"] });
  });

  it("the PATH is taken exactly as it arrived, spaces and all", () => {
    // Everything else here is trimmed and defaulted. A `PATH` is evidence: a
    // leading space is a `PATH` entry, and this crossing may not tidy it away.
    expect(readoutFrom({ path: " /usr/bin: " }).path).toBe(" /usr/bin: ");
    expect(readoutFrom({ path: "" }).path).toBe("");
    expect(readoutFrom({ path: 7 }).path).toBeNull();
  });
});

/* ---------------------------------------------------------------- PATH --- */

describe("the verbatim PATH crosses unchanged and is split only for reading", () => {
  it("the same string, the same length, nothing elided", () => {
    const harvested = fixtureState("harvested");

    expect(harvested.path).toBe(HARVESTED_PATH);
    expect(harvested.path).toHaveLength(HARVESTED_PATH.length);
    expect(harvested.path).not.toContain("…");
    expect(harvested.path).not.toContain("...");
  });

  it("splitting produces the entries and never replaces the string", () => {
    const harvested = fixtureState("harvested");

    expect(pathEntries(harvested)).toHaveLength(8);
    expect(pathEntries(harvested).join(":")).toBe(HARVESTED_PATH);
    expect(harvested.path).toBe(HARVESTED_PATH);
  });

  it("a Windows PATH is split on the semicolon, because it is full of colons", () => {
    const entries = pathEntries(readout({ path: "C:\\Windows;C:\\Program Files\\Git\\cmd" }));

    expect(entries).toEqual(["C:\\Windows", "C:\\Program Files\\Git\\cmd"]);
  });

  it("no PATH at all splits into nothing rather than into one empty entry", () => {
    expect(pathEntries(stillHarvesting())).toEqual([]);
    expect(pathEntries(readout({ path: "" }))).toEqual([]);
    expect(pathEntries(readout({ path: "/usr/bin::/bin" }))).toEqual(["/usr/bin", "/bin"]);
  });

  it("says out loud that the split is a guess and the line above is the evidence", () => {
    expect(PATH_SPLIT_NOTE).toContain("guess");
    expect(PATH_SPLIT_NOTE).toContain("reading only");
  });
});

/* ------------------------------------------------------------ arrivals --- */

describe("the readout is subscribed to before it is asked for", () => {
  /*
   * The command and the event race by design: on macOS the harvest can settle
   * before the WebView exists, and on Windows the command answers a second
   * before the shell does. Whichever arrives second must not undo the other.
   */
  it("a settled readout is never replaced by one still harvesting", () => {
    const settled = fixtureState("harvested");

    expect(settledOver(settled, stillHarvesting())).toBe(settled);
    expect(settledOver(stillHarvesting(), settled)).toBe(settled);
  });

  it("a second settled readout replaces the first, and an identical one changes nothing", () => {
    const first = fixtureState("harvested");
    const second = fixtureState("inherited");

    expect(settledOver(first, second)).toBe(second);
    expect(settledOver(first, first)).toEqual(first);
  });
});

/* ---------------------------------------------------------------- copy --- */

describe("a readout that has not arrived yet does not read as a failure", () => {
  const waiting = stillHarvesting();

  it("says harvesting, and puts an em dash where the facts will be", () => {
    expect(footerSummary(waiting).toLowerCase()).toContain("harvesting");
    expect(footerSummary(waiting)).toContain("—");
    expect(factsLine(waiting)).toContain("—");
    expect(harvestHeadline(waiting).toLowerCase()).toContain("harvesting");
  });

  it("never says failed, and never blames a shell that has not answered", () => {
    for (const said of [
      footerSummary(waiting),
      factsLine(waiting),
      harvestHeadline(waiting),
      describeHarvest(waiting),
      shellNote(waiting),
    ]) {
      expect(said.toLowerCase()).not.toContain("failed");
      expect(said.toLowerCase()).not.toContain("error");
    }
  });

  it("does not claim no shell was named before one has been picked", () => {
    // `shell` is `none` while harvesting and `none` when the environment truly
    // named no shell. The two are one tag and two different facts.
    expect(shellNote(waiting)).toBe(SHELL_NOT_SETTLED_YET);
    expect(shellNote(fixtureState("noShell"))).not.toBe(SHELL_NOT_SETTLED_YET);
  });
});

describe("a harvest that did not close blames neither side of it", () => {
  /*
   * #26 measured a drain in the wrong order deadlocking indistinguishably from
   * a profile that is genuinely still working. Saying "your shell is still
   * running something" would be asserting the likelier of two things when one
   * of them is our own bug, so the sentence names both. This is the mechanical
   * half of that claim.
   */
  const discarded = fixtureState("inherited");

  it("names both possibilities and picks neither", () => {
    const said = describeHarvest(discarded);

    expect(said).toContain("still working");
    expect(said).toContain("nothing here read");
  });

  it("calls nothing broken, misconfigured or invalid", () => {
    const said = describeHarvest(discarded).toLowerCase();

    expect(said).not.toContain("broken");
    expect(said).not.toContain("misconfigured");
    expect(said).not.toContain("invalid");
    expect(said).not.toContain("your fault");
  });

  it("says only what became of the environment, and that nothing was written down", () => {
    expect(describeHarvest(discarded)).toContain(INHERITED_COUNSEL);
    expect(INHERITED_COUNSEL).toContain("started with");
    expect(INHERITED_COUNSEL).toContain("written down");
  });

  it("says something true when the condition came back wordless", () => {
    const wordless = describeHarvest(
      readout({ harvest: { kind: "inherited", detail: "   " } }),
    );

    expect(wordless).toBe(`${HARVEST_DISCARDED_FALLBACK} ${INHERITED_COUNSEL}`);
  });
});

describe("a successful harvest is never described as a correct one", () => {
  /*
   * Resolvable is not spawnable and spawnable is not correct: a PATH that
   * resolves a shim says nothing about its interpreter, and a version pin to
   * something uninstalled starts cleanly under the wrong one. A readout says
   * what was read.
   */
  const harvested = fixtureState("harvested");

  for (const word of ["correct", "ready", "working", "healthy", "verified"]) {
    it(`never says "${word}"`, () => {
      expect(describeHarvest(harvested).toLowerCase()).not.toContain(word);
      expect(harvestHeadline(harvested).toLowerCase()).not.toContain(word);
    });
  }

  it("says what it did and how long it lasts, and nothing about being right", () => {
    expect(HARVESTED_COPY).toContain("asked again");
    expect(HARVESTED_COPY).toContain("as long as it is open");
  });

  it("the limits it cannot close are on the panel rather than in a document", () => {
    expect(CANNOT_TELL_YOU).toHaveLength(4);
    for (const limit of CANNOT_TELL_YOU) {
      expect(limit.length).toBeGreaterThan(40);
    }
    expect(CANNOT_TELL_YOU.join(" ")).toContain("half-way");
    expect(CANNOT_TELL_YOU.join(" ")).toContain("not installed");
  });

  it("the policy limit is sharpened rather than dropped now that one case is nameable", () => {
    /*
     * This sentence used to promise the case could not be detected at all. It
     * now can be — but only when the interpreter says so in its own words, and
     * only in a language this reads. Deleting the limit would trade an honest
     * *cannot* for a dishonest *does*.
     */
    const policy = CANNOT_TELL_YOU.find((limit) => limit.includes("policy"));

    expect(policy).toBeDefined();
    expect(policy).toContain("its own words");
    expect(policy).toContain("says nothing");
    expect(policy).toContain("exactly like not having a profile");
  });

  it("names the one degradation it can read, and says whose words it is reading", () => {
    expect(degradationNote({ kind: "profileRefused" })).toBe(PROFILE_REFUSED_COPY);
    expect(degradationNote({ kind: "notSeen" })).toBe(NOTHING_DECLINED_COPY);
    // The flag that would override the operator's own policy is not in the
    // command, and the copy says so rather than leaving it to be discovered.
    expect(PROFILE_REFUSED_COPY).toContain("not in the command above");
    // And *nothing said* is never dressed up as *nothing happened*.
    expect(NOTHING_DECLINED_COPY).toContain("not the same as");
  });
});

describe("non-empty stderr is never described as an error", () => {
  it("says it is shown as it arrived and holds no verdict", () => {
    expect(STDERR_NOTE).toContain("exactly as it arrived");
    expect(STDERR_NOTE).toContain("verdict");
    expect(STDERR_NOTE).toContain("never empty");
  });

  it("does not call the stream a failure, an error or a warning", () => {
    const said = STDERR_NOTE.toLowerCase();

    expect(said).not.toContain("error");
    expect(said).not.toContain("failed");
    expect(said).not.toContain("warning");
    expect(said).not.toContain("problem");
  });
});

describe("what the shell was asked, and why both flags are there", () => {
  it("shows the command line as it was run", () => {
    expect(shellLine(fixtureState("harvested"))).toBe("/bin/zsh -lic");
    expect(shellLine(fixtureState("windowsClean"))).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -EncodedCommand",
    );
    expect(shellLine(fixtureState("noShell"))).toBe("—");
  });

  it("the login sentence names what each flag alone loses", () => {
    expect(shellNote(fixtureState("harvested"))).toBe(LOGIN_FLAGS_NOTE);
    expect(LOGIN_FLAGS_NOTE).toContain("gh");
    expect(LOGIN_FLAGS_NOTE).toContain("node");
    expect(LOGIN_FLAGS_NOTE).toContain("looks right and is not");
  });

  it("the Windows sentence says the operator's own profile is the point", () => {
    expect(shellNote(fixtureState("windowsClean"))).toBe(POWERSHELL_PROFILE_NOTE);
    expect(POWERSHELL_PROFILE_NOTE).toContain("profile runs");
  });

  it("no shell named is the condition's own words, not a guess about a shell", () => {
    expect(shellNote(fixtureState("noShell"))).toContain("names no shell");
    expect(NO_SHELL_NAMED).toContain("guess");
  });
});

describe("a dropped record is counted and never named", () => {
  it("says how many, and that how many is all it can say", () => {
    const said = describeContamination(fixtureState("noisy"));

    expect(said).toContain("5 records");
    expect(said).toContain("indistinguishable from a variable you do not have");
  });

  it("one record is one record", () => {
    const said = describeContamination(
      readout({ tally: { ...stillHarvesting().tally, recordsDropped: 1 } }),
    );

    expect(said).toContain("1 record ");
    expect(said).toContain("was left out");
  });

  it("a clean harvest says nothing at all about contamination", () => {
    expect(describeContamination(fixtureState("harvested"))).toBeNull();
    expect(describeContamination(stillHarvesting())).toBeNull();
  });
});

describe("the token is an outcome and never a value", () => {
  it("one word for the two that need no explaining", () => {
    expect(tokenLabel(fixtureState("harvested"))).toBe("acquired");
    expect(tokenLabel(fixtureState("inherited"))).toBe("not asked");
  });

  it("a refusal arrives in gh's own words, ended so the panel can follow it", () => {
    expect(tokenLabel(fixtureState("stub"))).toContain("nothing named gh is on the PATH");
    expect(tokenLabel(fixtureState("stub")).endsWith(".")).toBe(true);
    expect(tokenLabel(readout({ token: { kind: "refused", detail: " " } }))).toBe(
      TOKEN_REFUSED_FALLBACK,
    );
  });

  it("nothing in the token copy could carry a token", () => {
    // The whole line exists so that "never stored" has something on screen to
    // make it checkable, which it cannot do by showing the thing.
    expect(TOKEN_NOTE).toContain("written down nowhere");
    expect(TOKEN_NOTE).not.toContain("ghp_");
    for (const key of fixtureKeys()) {
      expect(JSON.stringify(fixtureState(key))).not.toContain("ghp_");
    }
  });
});

/* ------------------------------------------------------------ coverage --- */

describe("every state the wire can carry has something to say", () => {
  const harvests: readonly HarvestState[] = [
    { kind: "harvesting" },
    { kind: "harvested" },
    { kind: "inherited", detail: "the harvest closed with no PATH in it" },
  ];
  const tokens: readonly TokenState[] = [
    { kind: "acquired" },
    { kind: "notAttempted" },
    { kind: "refused", detail: "gh answered with no token" },
  ];
  // Each stream is its own bytes, for the same reason the fixture is: `bytes`
  // is the count of what `text` was decoded from, so a hand-built readout that
  // declares one without the other is a state Rust could not have handed us.
  const wrote: Record<StderrKind, string> = {
    empty: "",
    text: "command not found: fnm\n",
    clixml: '#< CLIXML\r\n<Objs Version="1.1.0.1"></Objs>',
  };
  const streams = Object.keys(wrote) as StderrKind[];

  for (const harvest of harvests) {
    for (const token of tokens) {
      for (const kind of streams) {
        it(`${harvest.kind} × ${token.kind} × ${kind} reads as a sentence`, () => {
          const one = readout({
            harvest,
            token,
            stderr: {
              kind,
              bytes: new TextEncoder().encode(wrote[kind]).length,
              text: wrote[kind],
            },
          });

          for (const said of [
            harvestHeadline(one),
            describeHarvest(one),
            tokenLabel(one),
            shellNote(one),
            shellLine(one),
            factsLine(one),
            footerSummary(one),
          ]) {
            expect(said.trim()).not.toBe("");
          }
        });
      }
    }
  }
});

/* -------------------------------------------------------------- panel --- */

describe("the panel puts the evidence on screen rather than a summary of it", () => {
  const markupFor = (key: string, shown = true) =>
    renderToStaticMarkup(
      createElement(EnvironmentPanel, { readout: fixtureState(key), shown }),
    );

  it("renders the PATH in one piece, exactly as it arrived", () => {
    // Split entries are rendered underneath, so the assertion that matters is
    // that the unsplit string is there too: it is the evidence, and the split
    // below it is a guess about a separator.
    expect(markupFor("harvested")).toContain(HARVESTED_PATH);
  });

  it("renders a Windows PATH unsplit as well, semicolons and drive letters and all", () => {
    const windows = fixtureState("windowsClean");

    expect(markupFor("windowsClean")).toContain(
      windows.path?.replace(/&/g, "&amp;") ?? "",
    );
  });

  it("renders what the shell wrote without repairing it", () => {
    expect(markupFor("windowsClean")).toContain("cannot _x000D__x000A_be loaded");
    expect(markupFor("inherited")).toContain("command not found: fnm");
  });

  it("is in the DOM whether or not it is open, so aria-controls names something", () => {
    for (const shown of [true, false]) {
      const markup = markupFor("harvested", shown);

      expect(markup).toContain(`id="${ENVIRONMENT_PANEL_ID}"`);
      expect(markup).toContain(`data-shown="${shown}"`);
    }
  });

  it("carries no live region, because a PATH announced on every launch is hostile", () => {
    const markup = markupFor("harvested");

    expect(markup).not.toContain("aria-live");
    expect(markup).not.toContain('role="alert"');
  });

  it("holds the footer's width from the first paint, so nothing jumps when it settles", () => {
    /*
     * The summary is laid over a hidden ghost of a settled line, which is the
     * socket `FolderRow` gives *Locate…*. Both states render the same boxes,
     * so 1.9 s of Windows profile finishing moves nothing.
     */
    const waiting = renderToStaticMarkup(
      createElement(EnvironmentSummary, {
        readout: stillHarvesting(),
        shown: false,
        onToggle: () => {},
      }),
    );
    const settled = renderToStaticMarkup(
      createElement(EnvironmentSummary, {
        readout: fixtureState("harvested"),
        shown: false,
        onToggle: () => {},
      }),
    );

    // Same boxes, in the same order, in both states: the text and the
    // `data-harvest` that dims it are the only things that change.
    const boxes = (markup: string) =>
      markup.replace(/>[^<]*</g, "><").replace(/data-harvest="[a-z]+"/g, "data-harvest");

    expect(waiting).toContain('aria-hidden="true"');
    expect(boxes(waiting)).toBe(boxes(settled));
    expect(waiting).toContain('data-harvest="harvesting"');
    expect(settled).toContain('data-harvest="harvested"');
    expect(waiting).toContain('aria-expanded="false"');
    expect(waiting).toContain(`aria-controls="${ENVIRONMENT_PANEL_ID}"`);
  });
});

/* ------------------------------------------------------------- network --- */

describe("nothing this panel says reads as a failure to talk to GitHub", () => {
  /*
   * The launcher's seven words, for the launcher's reason: the fix for "this
   * harvest did not close" and the fix for "GitHub could not be read" are
   * different fixes, so the two may never sound alike. The conditions' own
   * sentences are the crates' words and are swept there; this sweeps ours.
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

  const wordless = (harvest: HarvestState): EnvironmentReadout =>
    readout({ harvest, shell: { kind: "loginShell", program: "/bin/zsh", flags: ["-lic"] } });

  const everythingSaid: readonly string[] = [
    HARVESTING_COPY,
    HARVESTED_COPY,
    INHERITED_COUNSEL,
    HARVEST_DISCARDED_FALLBACK,
    READOUT_UNREADABLE,
    LOGIN_FLAGS_NOTE,
    POWERSHELL_PROFILE_NOTE,
    NO_SHELL_NAMED,
    SHELL_NOT_SETTLED_YET,
    PATH_SPLIT_NOTE,
    STDERR_NOTE,
    TOKEN_NOTE,
    TOKEN_REFUSED_FALLBACK,
    PROFILE_REFUSED_COPY,
    NOTHING_DECLINED_COPY,
    ...CANNOT_TELL_YOU,
    harvestHeadline(wordless({ kind: "harvesting" })),
    harvestHeadline(wordless({ kind: "harvested" })),
    harvestHeadline(wordless({ kind: "inherited", detail: "" })),
    describeHarvest(wordless({ kind: "harvesting" })),
    describeHarvest(wordless({ kind: "harvested" })),
    describeHarvest(wordless({ kind: "inherited", detail: "" })),
    factsLine(wordless({ kind: "harvested" })),
    footerSummary(wordless({ kind: "harvested" })),
    tokenLabel(readout({ token: { kind: "notAttempted" } })),
    describeContamination(readout({ tally: { ...stillHarvesting().tally, recordsDropped: 5 } })) ??
      "",
  ];

  for (const word of NETWORK_WORDS) {
    it(`never says "${word}"`, () => {
      const guilty = everythingSaid.filter((said) => said.toLowerCase().includes(word));

      expect(guilty).toEqual([]);
    });
  }

  it("every sentence is about this machine: a shell, a PATH, a file on this disk", () => {
    expect(HARVESTED_COPY).toContain("login shell");
    expect(CANNOT_TELL_YOU.join(" ")).toContain("PATH");
  });
});
