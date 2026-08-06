import { describe, expect, it } from "vitest";
import {
  COMPLETED_GROUP,
  MAPS_PREAMBLE,
  MAP_LABEL,
  NO_MAP_COPY,
  NO_MAP_HEADLINE,
  NOT_READ_COPY,
  completedMaps,
  describeStamp,
  hasBeenRead,
  loadFixture,
  nothingReadYet,
  openMaps,
  stampAge,
  stampDetail,
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
        outcome: { kind: "failed", detail: "GitHub answered with status 401" },
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
     * land, and the stamp has no way to tell those apart — #40 is the ticket
     * that classifies. So neither clause may assert one.
     */
    const unstored = view({
      provenance: {
        source: "github",
        outcome: { kind: "failed", detail: "the launcher registry could not be written" },
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
        outcome: { kind: "failed" as const, detail: "this run acquired no GitHub token" },
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
      outcome: { kind: "failed" as const, detail: "GitHub answered with status 401" },
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
