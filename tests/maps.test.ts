import { describe, expect, it } from "vitest";
import {
  COMPLETED_GROUP,
  LABELS_TRUNCATED_NOTE,
  MAPS_PREAMBLE,
  MAPS_TRUNCATED_NOTE,
  MAP_LABEL,
  NO_MAP_COPY,
  NO_MAP_HEADLINE,
  NOT_READ_COPY,
  REMEDY,
  STOPPED_COPY,
  TRUNCATED_NOTE,
  completedMaps,
  describeStamp,
  hasBeenRead,
  loadFixture,
  nothingReadYet,
  openMaps,
  stampAge,
  stampDetail,
  stoppedReading,
  watchMaps,
  watching,
  type MapEntry,
  type MapsView,
} from "../src/maps/maps";

function map(over: Partial<MapEntry> = {}): MapEntry {
  return {
    number: 28,
    title: "Spec: perseverance",
    closed: false,
    url: "https://github.com/o/r/issues/28",
    updatedAt: "2026-08-05T09:12:44Z",
    ...over,
  };
}

function view(over: Partial<MapsView> = {}): MapsView {
  return {
    ...nothingReadYet(1),
    maps: [map()],
    provenance: {
      source: "github",
      outcome: { kind: "ok" },
      fetchedAt: "2026-08-05T08:00:00Z",
    },
    ...over,
  };
}

/** 2026-08-05T08:00:00Z, so the fixture's own stamp is exactly now. */
const READ_AT = 1_785_916_800;
const MINUTE = 60;

describe("maps are discovered by label rather than registered", () => {
  it("names the label the two sides have to agree on", () => {
    // `perseverance_model::MAP_LABEL` is the other half of this pair, and a
    // rename on either side is a map list that silently finds nothing.
    expect(MAP_LABEL).toBe("wayfinder:map");
  });

  it("says where the list came from, because nobody added anything to it", () => {
    expect(MAPS_PREAMBLE).toContain(MAP_LABEL);
  });
});

describe("closed maps are grouped rather than hidden", () => {
  it("keeps a finished map in the answer and puts it in the other group", () => {
    const listed = view({
      maps: [map({ number: 28 }), map({ number: 1, closed: true })],
    });

    expect(openMaps(listed).map((one) => one.number)).toEqual([28]);
    expect(completedMaps(listed).map((one) => one.number)).toEqual([1]);
  });

  it("never re-sorts what GitHub answered", () => {
    // The order is the operator's, dragged in GitHub's own UI. A ranking
    // invented here is one the map cannot justify.
    const listed = view({
      maps: [map({ number: 9 }), map({ number: 40 }), map({ number: 12 })],
    });

    expect(openMaps(listed).map((one) => one.number)).toEqual([9, 40, 12]);
  });

  it("names the group the spec names", () => {
    expect(COMPLETED_GROUP).toBe("Completed");
  });
});

describe("no map at all is a normal state", () => {
  it("tells a repository with no maps apart from one nobody has read", () => {
    const read = view({ maps: [], provenance: view().provenance });
    const unread = nothingReadYet(1);

    expect(hasBeenRead(read)).toBe(true);
    expect(hasBeenRead(unread)).toBe(false);
  });

  it("pre-absolves a charting session that produced no map", () => {
    // The copy has to read as a normal state of a folder. If it reads as a
    // failure, a first session that correctly judged the work small enough to
    // just do looks like it went wrong.
    const lowered = `${NO_MAP_HEADLINE} ${NO_MAP_COPY}`.toLowerCase();

    for (const alarm of ["error", "failed", "problem", "wrong", "unable", "could not"]) {
      expect(lowered).not.toContain(alarm);
    }
    expect(lowered).toContain("normal");
  });

  it("counts nothing, because an absence is never a zero", () => {
    const empty = `${NO_MAP_HEADLINE} ${NO_MAP_COPY} ${NOT_READ_COPY}`;

    expect(empty).not.toMatch(/\b0\b/);
    expect(empty).not.toMatch(/\bno maps\b/i);
  });
});

describe("the cache age is on screen in every state", () => {
  it("says how old a read is in the coarsest unit that is still true", () => {
    const listed = view();

    expect(stampAge(listed.provenance, READ_AT)).toBe("just now");
    expect(stampAge(listed.provenance, READ_AT + 5 * MINUTE)).toBe("5 minutes ago");
  });

  it("says so rather than going blank before anything has been read", () => {
    expect(stampAge(nothingReadYet(1).provenance, READ_AT)).toBe("not read yet");
    expect(describeStamp(nothingReadYet(1).provenance, READ_AT)).toBe("nothing read yet");
  });

  it("tells a live read apart from the copy of one", () => {
    expect(describeStamp(view().provenance, READ_AT)).toBe("read from GitHub just now");
    expect(describeStamp({ ...view().provenance, source: "cache" }, READ_AT)).toBe(
      "from the last read just now",
    );
  });

  it("keeps saying how old the copy is when nothing newer arrived", () => {
    // The one state where the age matters most is the one where a stamp that
    // replaced it with an error would have stopped reporting it.
    const stale = view({
      provenance: {
        source: "cache",
        outcome: {
          kind: "failed",
          reason: { reason: "authFailed" },
          detail: "GitHub answered with status 401",
        },
        fetchedAt: "2026-08-05T08:00:00Z",
      },
    });

    const said = describeStamp(stale.provenance, READ_AT + 2 * 60 * MINUTE);

    expect(said).toContain("2 hours ago");
    expect(said).toContain("nothing newer has arrived");
    expect(stampDetail(stale.provenance)).toBe("GitHub answered with status 401");
  });

  it("never claims which step failed, because it cannot tell", () => {
    /*
     * A read that landed and could not be stored is not a read that did not
     * land, and this clause still may not claim which of them it was. The
     * condition crosses now, but it answers a different question — *is waiting
     * going to help* — and all three of these are `unreachable`. The reason is
     * rendered beside the clause rather than folded into it.
     */
    const unstored = view({
      provenance: {
        source: "github",
        outcome: {
          kind: "failed",
          // A cache write that failed is retryable, and the stamp still may not
          // claim which step it was.
          reason: { reason: "unreachable" },
          detail: "the launcher registry could not be written",
        },
        fetchedAt: "2026-08-05T08:00:00Z",
      },
    });

    const said = describeStamp(unstored.provenance, READ_AT);

    expect(said).toBe("read from GitHub just now — not stored for next time");
    expect(said).not.toContain("did not land");
  });

  it("says nothing newer arrived rather than inventing an age it does not have", () => {
    const nothing = {
      ...nothingReadYet(1),
      provenance: {
        source: "none" as const,
        outcome: {
          kind: "failed" as const,
          reason: { reason: "authFailed" as const },
          detail: "this run acquired no GitHub token",
        },
        fetchedAt: null,
      },
    };

    expect(describeStamp(nothing.provenance, READ_AT)).toBe(
      "nothing read yet — nothing newer has arrived",
    );
  });

  it("carries no detail when nothing failed", () => {
    expect(stampDetail(view().provenance)).toBeNull();
  });

  it("says the harness is yielding only while the budget is what is holding it", () => {
    /*
     * The flag is Rust's answer to *is the budget the winning term of the max*,
     * and nothing on this side can work that out: there is no reserve here, no
     * seconds-to-reset arithmetic, and no notion of which floor won. So the
     * clause is on precisely when the boolean is, and the absence of the
     * boolean is the sentence that was there before this ticket.
     */
    expect(describeStamp(view().provenance, READ_AT, true)).toBe(
      "read from GitHub just now — paced against your rate limit",
    );
    expect(describeStamp(view().provenance, READ_AT, false)).toBe("read from GitHub just now");
    expect(describeStamp(view().provenance, READ_AT)).toBe("read from GitHub just now");
  });

  it("keeps the age when it is yielding, because that is when it matters most", () => {
    // A slowed poller is exactly when a screen goes quietly old. A clause that
    // replaced the age would have taken it away at the one moment it was worth
    // reading.
    const said = describeStamp(view().provenance, READ_AT + 20 * MINUTE, true);

    expect(said).toContain("20 minutes ago");
    expect(said).toContain("paced against your rate limit");
  });

  it("never stacks two reasons on one stamp", () => {
    /*
     * A failure and a yield can both be true — a failed read does not stop the
     * poller yielding — and a stamp says one thing about the screen. The
     * failure wins because it is about what is on screen; the budget is about
     * what comes next.
     */
    const failed = {
      source: "cache" as const,
      outcome: {
        kind: "failed" as const,
        reason: { reason: "authFailed" as const },
        detail: "GitHub answered with status 401",
      },
      fetchedAt: "2026-08-05T08:00:00Z",
    };

    const said = describeStamp(failed, READ_AT, true);

    expect(said).toBe("from the last read just now — nothing newer has arrived");
    expect(said).not.toContain("rate limit");
  });

  it("says nothing about yielding before anything has been read", () => {
    // Nothing is on screen to be stale, so there is nothing for the clause to
    // be true of yet.
    expect(describeStamp(nothingReadYet(1).provenance, READ_AT, true)).toBe("nothing read yet");
  });

  it("mirrors the flag the app crate emits, defaulted to not yielding", () => {
    // The other half of a hand-written mirror. `MapsView` is pinned from the
    // Rust side too, and a rename on either is silent on the other.
    expect(nothingReadYet(1).yieldingToRateLimit).toBe(false);
    expect(loadFixture(1).yieldingToRateLimit).toBe(false);
  });
});

describe("a page that cannot exist and two that ordinarily can are three caveats", () => {
  it("carries the three truncation flags apart, all false until something says otherwise", () => {
    // Three fields because there are three sentences. The Rust side reads them
    // off one `Truncation`, so a rename on any of them is silent here and this
    // is the half that notices.
    expect(nothingReadYet(1).truncated).toBe(false);
    expect(nothingReadYet(1).mapsTruncated).toBe(false);
    expect(nothingReadYet(1).labelsTruncated).toBe(false);
    expect(loadFixture(1).mapsTruncated).toBe(false);
    expect(loadFixture(1).labelsTruncated).toBe(false);
  });

  it("says an impossible thing happened only about the pages that are capped", () => {
    /*
     * The whole reason the label flag is not folded into `truncated`. GitHub
     * caps sub-issues and linked issues, so a second page of either really is
     * something its own limits forbid — but nothing caps labels, so an issue
     * with more than a hundred of them is ordinary. One sentence over both
     * would tell an operator with a well-labelled issue that the impossible
     * had happened.
     */
    expect(TRUNCATED_NOTE).toContain("cannot happen");
    expect(LABELS_TRUNCATED_NOTE).not.toContain("cannot");
    // And the same again for the map list, which is the leg `capped()` used to
    // carry. `issues(first: 100, labels: [...])` is a page this query chose, so
    // a repository that has charted a hundred and one maps has watched GitHub
    // keep every promise it makes — and would have been told it broke one.
    expect(MAPS_TRUNCATED_NOTE).not.toContain("cannot");
  });

  it("tells an operator a map past the end of the page is not a map that is gone", () => {
    /*
     * The consequence worth naming, because it is the one a missing map looks
     * like from the outside: an operator who charted something and cannot find
     * it in the launcher would otherwise conclude it was deleted. The sentence
     * says where it actually is, and the act it points at — closing what is
     * finished — is what brings the list back inside one page.
     */
    expect(MAPS_TRUNCATED_NOTE).toContain("maps");
    expect(MAPS_TRUNCATED_NOTE).toContain("rather than gone");
    // Three sentences, and none of them is a reading of another.
    expect(MAPS_TRUNCATED_NOTE).not.toContain(TRUNCATED_NOTE);
    expect(MAPS_TRUNCATED_NOTE).not.toContain(LABELS_TRUNCATED_NOTE);
    expect(TRUNCATED_NOTE).not.toContain(MAPS_TRUNCATED_NOTE);
  });

  it("names what a cut-off label list costs rather than how much was cut", () => {
    // The one truncation that fails unsafe, so the one with an outcome worth
    // printing: a ticket may be offered on a machine it is bound away from, and
    // an operator who is told only *some of this is not on screen* has nothing
    // to do with that.
    expect(LABELS_TRUNCATED_NOTE).toContain("bound to another");
    expect(LABELS_TRUNCATED_NOTE).toContain("labels");
    // Two sentences, and neither is a reading of the other.
    expect(LABELS_TRUNCATED_NOTE).not.toContain(TRUNCATED_NOTE);
    expect(TRUNCATED_NOTE).not.toContain(LABELS_TRUNCATED_NOTE);
  });

  it("says a label list may have been cut off rather than that it was", () => {
    /*
     * The flag has two producers and one sentence. A live read raises it off a
     * `hasNextPage` GitHub really answered; a cached body read under a query
     * document this build no longer sends raises it off `MapsView::unvouched`,
     * where nothing is known either way because the `pageInfo` may never have
     * been asked for (ADR 0019). Asserting *some of them were not read* would
     * be false for almost every folder on the first launch after the version-3
     * upgrade, and this app prints an unknown as an absence everywhere else —
     * `nothingReadYet` is not an empty list, *first open* is not `0 changes`.
     * So the sentence hedges by one word, and the word is what this pins.
     */
    expect(LABELS_TRUNCATED_NOTE).toContain("may not have been read");
    expect(LABELS_TRUNCATED_NOTE).not.toContain("were not read");
    // The map list is raised by the same second producer — `MapsView::unvouched`
    // caveats both flags, so *nothing derived from a body whose identity is not
    // this build's may be believed* holds with no exception — so it hedges in
    // the same word.
    expect(MAPS_TRUNCATED_NOTE).toContain("may not have been read");
    expect(MAPS_TRUNCATED_NOTE).not.toContain("were not read");
    // What an operator does about it is unhedged, because the act is the same
    // under either producer: a second look at a designated ticket.
    expect(LABELS_TRUNCATED_NOTE).toContain("bound to another");
  });
});

describe("a read that stopped disables the list in place rather than hiding it", () => {
  function failedWith(reason: MapsView["provenance"]["outcome"]): MapsView {
    return view({
      provenance: { source: "cache", outcome: reason, fetchedAt: "2026-08-05T08:00:00Z" },
    });
  }

  it("tells the conditions that stop reading from the ones that only delay it", () => {
    /*
     * The same partition `backoff_floor` makes on the Rust side, and the reason
     * it is spelled rather than inferred: the floor answering `Never` and this
     * answering non-null are one fact about the app, and two accounts of it
     * would come to disagree.
     *
     * A rate limit is deliberately not on this list. It is a wait with an end
     * on it, and rows disabled for one would come back by themselves while
     * somebody sat reading a reason to give up.
     */
    const stops = [
      ["authFailed", true],
      ["mapGone", true],
      ["unreachable", false],
      ["rateLimited", false],
    ] as const;

    for (const [reason, expected] of stops) {
      const outcome =
        reason === "rateLimited"
          ? ({ kind: "failed", reason: { reason, resetsAt: null }, detail: "d" } as const)
          : ({ kind: "failed", reason: { reason }, detail: "d" } as const);

      expect([reason, stoppedReading(failedWith(outcome)) !== null]).toEqual([
        reason,
        expected,
      ]);
    }
  });

  it("says nothing has stopped when the last read landed", () => {
    expect(stoppedReading(view())).toBeNull();
    // And *nobody has looked yet* is not a stop either — there is nothing to
    // give up on before anything has been tried.
    expect(stoppedReading(nothingReadYet(1))).toBeNull();
  });

  it("has a sentence for each condition that stops, and none of them reads as an error", () => {
    /*
     * The read stopped for a reason that is now true of the world. An operator
     * who reads *failed* goes looking for something to have gone wrong on their
     * own machine, which is the one place the fault is not.
     */
    for (const reason of ["authFailed", "mapGone"] as const) {
      const said = STOPPED_COPY[reason].toLowerCase();

      expect(said.length).toBeGreaterThan(0);
      for (const alarm of ["error", "failed", "crash", "unexpected"]) {
        expect([reason, said.includes(alarm)]).toEqual([reason, false]);
      }
      // It says what is on screen instead: a copy, and what would replace it.
      expect(said).toContain("copy");
    }
  });

  it("takes the fixing command from the one table the whole app spells it in", () => {
    // The command under a map list and the command on the stamp are the same
    // command, because there is only one place it is written down.
    expect(REMEDY.authFailed).toBe("run gh auth login");
    expect(STOPPED_COPY.authFailed).not.toContain("gh auth");
  });
});

describe("the live read belongs to the poller, and a browser has no poller", () => {
  it("declares what is being watched and answers nothing, because the answer arrives as an event", async () => {
    // Both the folder and the launcher-with-nothing-picked state. Neither may
    // reach for a command that is not there.
    await expect(watching(1, null)).resolves.toBeUndefined();
    await expect(watching(null, null)).resolves.toBeUndefined();
  });

  it("subscribes to nothing in a browser and still hands back a way to stop", async () => {
    // A caller that had to know whether there was anything to unsubscribe from
    // would be a caller with a leak on one of the two paths.
    const stop = await watchMaps(() => {});

    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});

describe("the browser preview stands in for what a browser cannot conjure", () => {
  it("carries an open map, a finished one, and a stamp that is already old", () => {
    const preview = loadFixture(7);

    expect(preview.folderId).toBe(7);
    expect(openMaps(preview).length).toBeGreaterThan(0);
    expect(completedMaps(preview).length).toBeGreaterThan(0);
    // A cache with age on it: a fresh browser has no way to produce one.
    expect(preview.provenance.source).toBe("cache");
    expect(preview.provenance.fetchedAt).not.toBeNull();
  });

  it("hands out a copy, so editing what you were given edits nothing else", () => {
    const first = loadFixture(1);
    first.maps[0]!.title = "edited";

    expect(loadFixture(1).maps[0]!.title).not.toBe("edited");
  });
});
