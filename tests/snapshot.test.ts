import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIXTURE,
  FIXTURES,
  FIXTURE_NAMES,
  fixtureNamed,
  requestedFixture,
  type FixtureName,
} from "../src/snapshot/fixtures";
import { CONDITIONS, REMEDY, describeStamp, stampDetail, stampReason } from "../src/chrome/stamp";
import { NO_FRONTIER, NO_MAP_OPEN, PHASE_NAMES, describeModel } from "../src/snapshot/readout";
import { noMapOpen } from "../src/snapshot/snapshot";
import { collect } from "./support/sources";

/** Two hours after the fixtures were stamped, so the age has something to say. */
const AGED_AT = Math.floor(Date.parse("2026-08-05T10:00:00Z") / 1000);

/**
 * The generated types are the only mirror of the Rust seam, so nothing here
 * re-states a field list. What these check is the other half: that the
 * checked-in fixtures really are what `dev:web` boots from, and that this side
 * of the seam cannot grow a second derivation.
 */

describe("dev:web boots from a checked-in snapshot with no Rust behind it", () => {
  it("carries every awkward state the frontier rules exist for", () => {
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    const kinds = map.nodes.map((node) => node.kind.kind);
    const states = map.nodes.map((node) => node.state);

    // A stray issue dragged onto the map, and two specs.
    expect(kinds).toContain("unclassified");
    expect(kinds.filter((kind) => kind === "spec")).toHaveLength(2);
    // All four node states are represented, which is what makes this fixture
    // worth opening rather than a graph that happens to parse.
    expect(new Set(states)).toEqual(
      new Set(["resolved", "blocked", "claimed", "takeable"]),
    );
  });

  it("names a frontier that is neither the spec nor the unclassified child", () => {
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    const frontier = map.nodes.find((node) => node.number === map.frontier);
    expect(frontier?.kind.kind).toBe("ticket");
    expect(frontier?.state).toBe("takeable");

    // The spec is takeable by every state predicate there is, and is still
    // not the frontier. That is the whole reason the third category exists.
    const spec = map.nodes.find((node) => node.kind.kind === "spec");
    expect(spec?.state).toBe("takeable");
    expect(spec?.number).not.toBe(map.frontier);
  });

  it("has a map with nothing on it that is unstarted rather than finished", () => {
    const map = FIXTURES["empty-map"].model.map;
    expect(map?.nodes).toHaveLength(0);
    expect(map?.phase).toBe("unstarted");
    expect(map?.frontier).toBeNull();
  });

  it("has a closed map that is done whatever its tickets say", () => {
    const map = FIXTURES["map-closed"].model.map;
    expect(map?.closed).toBe(true);
    expect(map?.phase).toBe("done");
    expect(map?.counts.open).toBeGreaterThan(0);
  });

  it("has a map whose tickets are all closed and whose spec exists", () => {
    const map = FIXTURES["spec-composed"].model.map;
    expect(map?.phase).toBe("specced");
    expect(map?.frontier).toBeNull();
  });

  it("tells no map open apart from a map with nothing on it", () => {
    // Two different facts, and they are two different values.
    expect(FIXTURES["no-map-open"].model.map).toBeNull();
    expect(FIXTURES["empty-map"].model.map).not.toBeNull();
  });

  it("keeps the graph and ages the stamp when a poll failed", () => {
    const failed = FIXTURES.unreachable;
    const held = FIXTURES["awkward-map"];

    // Never silence: the same graph is on screen, and only the outcome says
    // that the last look did not land.
    expect(failed.model).toEqual(held.model);
    expect(failed.provenance.outcome.kind).toBe("failed");
    expect(failed.provenance.fetchedAt).not.toBeNull();
  });

  it("says a fixture is a fixture rather than presenting one as a read", () => {
    for (const name of FIXTURE_NAMES) {
      const source = FIXTURES[name].provenance.source;
      expect(["fixture", "cache", "none"]).toContain(source);
      // Nothing checked into this repository may claim it came from GitHub.
      expect(source).not.toBe("github");
    }
  });

  it("hands out a copy, so opening one cannot edit it", () => {
    const first = fixtureNamed("awkward-map");
    const map = first.model.map;
    if (map === null) throw new Error("the awkward fixture has no map");
    map.nodes.pop();

    expect(fixtureNamed("awkward-map").model.map?.nodes.length).toBe(
      map.nodes.length + 1,
    );
  });
});

describe("which fixture a dev:web url asked for", () => {
  it("takes the one named in the query string", () => {
    expect(requestedFixture("?map=empty-map")).toBe("empty-map");
  });

  it("opens on the awkward map by default, because that is where a broken rule shows", () => {
    expect(requestedFixture("")).toBe(DEFAULT_FIXTURE);
    expect(DEFAULT_FIXTURE).toBe("awkward-map");
  });

  it("falls back rather than leaving a blank window on a typo", () => {
    expect(requestedFixture("?map=awkard-map")).toBe(DEFAULT_FIXTURE);
  });
});

describe("the derived model on screen is spelled and never worked out", () => {
  it("says no map open as an absence rather than a row of zeroes", () => {
    expect(describeModel(noMapOpen().model)).toBe(NO_MAP_OPEN);
  });

  it("spells the phase, the counts and the frontier the model arrived with", () => {
    const said = describeModel(FIXTURES["awkward-map"].model);
    const map = FIXTURES["awkward-map"].model.map;
    if (map === null) throw new Error("the awkward fixture has no map");

    expect(said).toContain(PHASE_NAMES[map.phase]);
    expect(said).toContain(`${map.counts.open}/${map.counts.tickets} tickets open`);
    expect(said).toContain(`frontier #${map.frontier}`);
    // Eight children and five tickets are both on screen, because one is what
    // is on the map and the other is what the frontier can work through.
    expect(said).toContain(`${map.nodes.length} nodes`);
  });

  it("reads an absent frontier as nothing to start rather than as zero", () => {
    expect(describeModel(FIXTURES["spec-composed"].model)).toContain(NO_FRONTIER);
  });
});

describe("there is one frontier resolver and it is in Rust", () => {
  /**
   * The structural half of *Rust owns the derivation*. `blockedBy` and
   * `assignees` are the inputs the four states are decided from, and they do
   * not cross the seam at all — so a second resolver here is not forbidden by
   * a convention, it is unwritable for want of anything to write it from.
   */
  it("never lets the inputs to a node's state reach this side", () => {
    const offenders = collect([".ts", ".tsx"])
      .filter((file) => /\bblockedBy\b|\bassignees\b/.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("keeps the generated types generated", () => {
    const generated = collect([".ts"]).find(
      (file) => file.path === "src/snapshot/model.generated.ts",
    );

    expect(generated).toBeDefined();
    // The banner is what tells the next person not to edit it, and the reason
    // the mirror cannot drift is that nobody maintains it.
    expect(generated?.text.startsWith("// This file was generated")).toBe(true);
  });

  it("declares every fixture the model crate generates and no others", () => {
    // The Rust side asserts the same equality from the other direction, so a
    // fixture added there and not imported here fails on both sides.
    const onDisk = collect([".json"])
      .filter((file) => file.path.startsWith("src/snapshot/fixtures/"))
      .map((file) => file.path.replace("src/snapshot/fixtures/", "").replace(".json", ""))
      .sort();

    expect(onDisk).toEqual([...FIXTURE_NAMES].sort());
  });
});

describe("staleness is spelled once, for everything that was read", () => {
  /**
   * The map list and the derived model are read by different commands, go
   * stale independently, and are stamped from the same generated `Provenance`.
   * One vocabulary is what stops *from the last read* meaning two things on one
   * screen — so the words live in exactly one file, and this is what says so.
   */
  it("keeps the stamp's words out of every file but the one that owns them", () => {
    const phrases =
      /from the last read|nothing newer has arrived|not stored for next time|paced against your rate limit|the read did not land|GitHub would not accept this token|GitHub says this is not there|GitHub asked for a pause|run gh auth login/;
    const offenders = collect([".ts", ".tsx"])
      .filter((file) => phrases.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual(["src/chrome/stamp.ts"]);
  });

  it("stamps a failed poll as the copy it is rather than as a live read", () => {
    const failed = FIXTURES.unreachable.provenance;
    const read = FIXTURES["awkward-map"].provenance;

    // Same model on both, so the stamp is the only thing that can tell them
    // apart — which is the whole reason it is on screen.
    expect(describeStamp(failed, AGED_AT)).toContain("nothing newer has arrived");
    expect(describeStamp(read, AGED_AT)).not.toContain("nothing newer has arrived");
    // The refusing crate's own sentence, taken from the fixture rather than
    // written down here: this side may never keep a second account of what
    // Rust would have said. It is emphatically *not* the condition's short
    // name — `unreachable` classifies a folder with no GitHub remote as well
    // as a dead network, and only this sentence tells them apart.
    expect(stampDetail(failed)).toBe(
      failed.outcome.kind === "failed" ? failed.outcome.detail : null,
    );
    expect(stampDetail(failed)).not.toBe(CONDITIONS.unreachable);
    expect(stampDetail(read)).toBeNull();
  });

  it("never drops the age when the reason arrives", () => {
    // The moment staleness starts mattering is the moment a stamp that swapped
    // the age for an error would have stopped reporting it.
    expect(describeStamp(FIXTURES.unreachable.provenance, AGED_AT)).toContain("2 hours ago");
  });
});

describe("a read that did not land says which condition it is, and never guesses", () => {
  /**
   * `(the fixture, the condition Rust concluded, whether a command fixes it)`.
   * One table over the four fixtures the model crate generates, because four
   * separate assertions are four chances to check three of them — and these
   * are the states a browser has no way to conjure.
   */
  const CONDITIONS_ON_DISK = [
    ["unreachable", "unreachable", false],
    ["auth-failed", "authFailed", true],
    ["map-gone", "mapGone", false],
    ["rate-limited", "rateLimited", false],
  ] as const;

  it("carries the condition as a structure rather than as a sentence to parse", () => {
    for (const [name, reason] of CONDITIONS_ON_DISK) {
      const provenance = FIXTURES[name].provenance;

      expect([name, stampReason(provenance)?.reason]).toEqual([name, reason]);
      // The detail is still there and still in the words of whoever refused.
      // The structure is what the app concluded; the sentence is what it was
      // told, and both are on screen.
      expect(stampDetail(provenance)).not.toBeNull();
    }

    // And a read that landed has no condition at all — an absence, never an
    // `unreachable` standing in for one.
    expect(stampReason(FIXTURES["awkward-map"].provenance)).toBeNull();
  });

  it("names the moment GitHub asked us to wait for, when GitHub named one", () => {
    // The header is honoured exactly and never guessed at, which starts here:
    // the stamp crosses the seam carrying what GitHub sent rather than a
    // duration this side worked out.
    const limited = stampReason(FIXTURES["rate-limited"].provenance);

    expect(limited?.reason).toBe("rateLimited");
    expect(limited?.reason === "rateLimited" ? limited.resetsAt : null).toBe(
      "2026-08-05T09:00:00Z",
    );
  });

  it("prints the one command that fixes it, and invents one for nothing else", () => {
    for (const [name, reason, fixable] of CONDITIONS_ON_DISK) {
      expect([name, REMEDY[reason] !== null]).toEqual([name, fixable]);
      // Every condition has a name on screen, because a stamp that went dashed
      // without saying why is a stamp nobody can act on.
      expect(CONDITIONS[reason].length).toBeGreaterThan(0);
    }

    // The one command, spelled once for the whole app.
    expect(REMEDY.authFailed).toBe("run gh auth login");
  });

  it("ages every condition rather than replacing the age with it", () => {
    for (const [name] of CONDITIONS_ON_DISK) {
      // Two hours after the fixtures were stamped. A screen that swapped the
      // age for a reason would stop reporting staleness at the exact moment
      // staleness started mattering, and it would do it on all four.
      expect([name, describeStamp(FIXTURES[name].provenance, AGED_AT)]).toEqual([
        name,
        expect.stringContaining("2 hours ago"),
      ]);
    }
  });

  it("keeps the graph on screen whichever way the read failed", () => {
    const held = FIXTURES["awkward-map"];

    for (const [name] of CONDITIONS_ON_DISK) {
      // Never silence, and never an empty graph: emptying it would assert that
      // the operator's tickets are gone on the strength of not having been able
      // to look.
      expect([name, FIXTURES[name].model]).toEqual([name, held.model]);
    }
  });
});

describe("the fixture catalogue", () => {
  it("names each fixture exactly once", () => {
    const names: FixtureName[] = [...FIXTURE_NAMES];
    expect(new Set(names).size).toBe(names.length);
  });
});
