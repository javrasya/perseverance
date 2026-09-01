import { describe, expect, it } from "vitest";
import {
  ALREADY_THERE,
  ANOTHER_MACHINE,
  ASK_ARRIVES,
  CHECKING_LABEL,
  COMPOSE_LABEL,
  NOTHING_TAKEABLE,
  NO_ADAPTER,
  NO_FOLDER_OPEN,
  NO_MAP_OPEN,
  RESUME_ARRIVES,
  STILL_READING,
  START_LABEL,
  TO_FRONTIER_LABEL,
  adapterAtPress,
  alreadyComposing,
  offerable,
  pressable,
  railAt,
  sameFrontier,
  type Crossing,
  type Press,
  type Socket,
  type SocketId,
} from "../src/chrome/sockets";
import { NO_HARNESS, startWorking } from "../src/chrome/started";
import type { HarvestState } from "../src/environment/environment";
import {
  readoutFrom,
  type AdapterReading,
  type FolderReadout,
} from "../src/environment/folder";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Frontier } from "../src/snapshot/model.generated";
import { forgetPrompts, promptFor, recordPrompt } from "../src/terminal/prompts";

/**
 * The rail, as arithmetic.
 *
 * The claims under test are the ticket's: four sockets are always there, an
 * unavailable one is recessed **in the same box** with its condition as visible
 * text, a press that lost its target re-arms and demands a second press, and
 * the adapter is a fact about the press rather than a setting. Everything on
 * screen is a function of the crossing, so this file is where they bite.
 */

const resolved = (id: string): AdapterReading => ({
  id,
  resolution: { kind: "resolved", name: id, program: `/usr/bin/${id}`, from: "candidate" },
  probes: [],
});

const missing = (id: string): AdapterReading => ({
  id,
  resolution: { kind: "notFound", names: [id] },
  probes: [],
});

/**
 * A readout the way the Rust side hands one over, so the shape under test is
 * the decoder's own and not this file's idea of it.
 */
const readout = (
  adapters: readonly AdapterReading[],
  harvest: HarvestState = { kind: "harvested" },
): FolderReadout => readoutFrom({ adapters, harvest }, "/work/repo");

const DESIGNATED: Frontier = { frontier: "designated", number: 75 };

function crossing(over: Partial<Crossing> = {}): Crossing {
  return {
    frontier: DESIGNATED,
    selection: null,
    environment: readout([resolved("claude")]),
    folder: "/work/repo",
    phase: "wayfinding",
    map: 28,
    composing: null,
    press: { kind: "idle" },
    ...over,
  };
}

const socketOf = (id: SocketId, over: Partial<Crossing> = {}): Socket => {
  const found = railAt(crossing(over)).sockets.find((socket) => socket.id === id);
  if (found === undefined) throw new Error(`no ${id} socket on the rail`);
  return found;
};

describe("the rail", () => {
  it("is four sockets in one order, in every state the crossing can be in", () => {
    const everyState: Crossing[] = [
      crossing(),
      crossing({ frontier: null, environment: readout([]), folder: null }),
      crossing({ frontier: { frontier: "nothingToStart" } }),
      crossing({ frontier: { frontier: "notOnThisMachine" } }),
      crossing({ press: { kind: "checking" } }),
      crossing({ press: { kind: "refused", detail: "no", frontier: null } }),
      crossing({ selection: 75 }),
    ];

    for (const state of everyState) {
      const ids = railAt(state).sockets.map((socket) => socket.id);
      // The layout, and it is the same layout every time: a state change is a
      // change of ink, never a socket that came or went.
      expect(ids).toEqual(["start", "resume", "ask", "toFrontier"]);
    }
  });

  it("prints a condition on exactly the sockets that are recessed", () => {
    for (const socket of railAt(crossing({ frontier: null, environment: readout([]) })).sockets) {
      expect(socket.condition === null).toBe(socket.fill !== "recessed");
    }
  });

  it("keeps Resume and Ask recessed with their condition printed and no behaviour", () => {
    const resume = socketOf("resume");
    const ask = socketOf("ask");

    expect(resume.fill).toBe("recessed");
    expect(resume.condition).toBe(RESUME_ARRIVES);
    expect(ask.fill).toBe("recessed");
    expect(ask.condition).toBe(ASK_ARRIVES);
    expect(pressable(resume)).toBe(false);
    expect(pressable(ask)).toBe(false);
  });
});

describe("Start Working", () => {
  it("fills on a designated frontier with an adapter resolved in this folder", () => {
    const start = socketOf("start");

    expect(start.label).toBe(START_LABEL);
    expect(start.fill).toBe("filled");
    expect(pressable(start)).toBe(true);
    expect(railAt(crossing()).target).toBe(75);
  });

  it("recesses with the reading the frontier gave, and never with a second opinion", () => {
    expect(socketOf("start", { frontier: null }).condition).toBe(NO_MAP_OPEN);
    expect(socketOf("start", { frontier: { frontier: "nothingToStart" } }).condition).toBe(
      NOTHING_TAKEABLE,
    );
    expect(socketOf("start", { frontier: { frontier: "notOnThisMachine" } }).condition).toBe(
      ANOTHER_MACHINE,
    );
    expect(socketOf("start", { folder: null }).condition).toBe(NO_FOLDER_OPEN);
    expect(socketOf("start", { environment: readout([missing("claude")]) }).condition).toBe(
      NO_ADAPTER,
    );
  });

  /*
   * *Found nothing* is an answer and *nobody has looked yet* is not one, and
   * the seconds between them are the seconds a login-shell harvest takes —
   * every *Ask again* and every second folder opened passes through them with a
   * folder selected and no readout beside it. Printing the negative there would
   * tell an operator their folder has no agent CLI while the search for one is
   * still running.
   */
  it("says the folder is still being read rather than that it found nothing", () => {
    expect(socketOf("start", { environment: null }).condition).toBe(STILL_READING);
    expect(
      socketOf("start", { environment: readout([], { kind: "harvesting" }) }).condition,
    ).toBe(STILL_READING);
    // And once the readout is actually back, the negative is the honest answer.
    expect(socketOf("start", { environment: readout([]) }).condition).toBe(NO_ADAPTER);
  });

  it("says checking while the revalidation is in flight, and takes no press", () => {
    const start = socketOf("start", { press: { kind: "checking" } });

    expect(start.label).toBe(CHECKING_LABEL);
    expect(start.fill).toBe("checking");
    // A second press while checking does nothing, and this is the whole of why.
    expect(pressable(start)).toBe(false);
    // Not a recessed socket: the condition to press it is met, so there is no
    // condition to print, and inventing one would be a lie about why it waits.
    expect(start.condition).toBeNull();
  });

  it("re-arms on the frontier a refusal named, and demands a second press", () => {
    const moved: Press = {
      kind: "refused",
      detail: "#75 is not what this map offers to start any more",
      frontier: { frontier: "designated", number: 76 },
    };
    const rail = railAt(crossing({ press: moved }));
    const start = rail.sockets[0];

    expect(rail.target).toBe(76);
    expect(start?.note).toBe(moved.detail);
    // Armed, and waiting: nothing here spawns off the back of a refusal.
    expect(start?.fill).toBe("filled");
  });

  it("prefers the refusal's frontier over the snapshot's, because it is the newer read", () => {
    const rail = railAt(
      crossing({
        frontier: { frontier: "designated", number: 75 },
        press: { kind: "refused", detail: "moved", frontier: { frontier: "nothingToStart" } },
      }),
    );

    expect(rail.target).toBeNull();
    expect(rail.sockets[0]?.condition).toBe(NOTHING_TAKEABLE);
    expect(rail.sockets[0]?.note).toBe("moved");
  });

  it("holds a refusal against a snapshot that still agrees, and not one that does not", () => {
    /* The retirement in `Sockets.tsx` is this comparison: same reading, same
       arm; different reading, and the refusal has been contradicted. */
    expect(sameFrontier({ frontier: "designated", number: 76 }, { frontier: "designated", number: 76 })).toBe(true);
    expect(sameFrontier({ frontier: "designated", number: 76 }, { frontier: "designated", number: 75 })).toBe(false);
    expect(sameFrontier({ frontier: "nothingToStart" }, { frontier: "nothingToStart" })).toBe(true);
    expect(sameFrontier({ frontier: "nothingToStart" }, { frontier: "notOnThisMachine" })).toBe(false);
    expect(sameFrontier(null, null)).toBe(true);
    expect(sameFrontier(null, { frontier: "nothingToStart" })).toBe(false);
  });

  it("re-arms on nothing when the refusal learned nothing, and only prints the sentence", () => {
    const rail = railAt(
      crossing({
        press: { kind: "refused", detail: "the check did not land in time", frontier: null },
      }),
    );

    // No fresh read landed is not the frontier moving: it names no new target,
    // so the socket keeps the one it had rather than being retargeted.
    expect(rail.target).toBe(75);
    expect(rail.sockets[0]?.note).toBe("the check did not land in time");
  });
});

describe("To Frontier", () => {
  it("fills on a designated frontier the selection is not already on", () => {
    const snap = socketOf("toFrontier", { selection: 12 });

    expect(snap.label).toBe(TO_FRONTIER_LABEL);
    expect(snap.fill).toBe("filled");
    expect(railAt(crossing({ selection: 12 })).target).toBe(75);
  });

  it("recesses once the selection is the frontier, and when there is none", () => {
    expect(socketOf("toFrontier", { selection: 75 }).condition).toBe(ALREADY_THERE);
    expect(socketOf("toFrontier", { frontier: { frontier: "nothingToStart" } }).fill).toBe(
      "recessed",
    );
  });
});

describe("the adapter", () => {
  it("offers the resolved readings and none of the unresolved ones", () => {
    const readings = [missing("claude"), resolved("codex"), resolved("pi")];

    expect(offerable(readings)).toEqual(["codex", "pi"]);
    expect(railAt(crossing({ environment: readout(readings) })).adapters).toEqual(["codex", "pi"]);
  });

  it("is a pick belonging to this press, falling back when the pick stops resolving", () => {
    expect(adapterAtPress(["claude", "codex"], "codex")).toBe("codex");
    expect(adapterAtPress(["claude", "codex"], null)).toBe("claude");
    // The folder re-resolved and lost it: a press carrying a name this folder
    // cannot resolve is a press nobody made.
    expect(adapterAtPress(["claude"], "codex")).toBe("claude");
    expect(adapterAtPress([], "codex")).toBeNull();
  });
});

describe("a window with no Rust behind it", () => {
  it("refuses in a sentence rather than faking a spawn", async () => {
    const answer = await startWorking("/work/repo", 75, "claude");

    expect(answer).toEqual({ kind: "refused", detail: NO_HARNESS, frontier: null });
  });
});

describe("the prompt a spawn answered with", () => {
  it("is kept per run, and a run this window did not start has none", () => {
    forgetPrompts();
    const rendered = { text: "work #75", characters: 8, origin: "stock" } as const;

    recordPrompt(4, rendered);

    expect(promptFor(4)).toEqual(rendered);
    expect(promptFor(5)).toBeNull();
  });
});


/**
 * The compose offer, as arithmetic.
 *
 * #66's own claims: the offer stands in the primary socket and nowhere else, it
 * is gated by the phase rather than by the frontier, it is aimed at the map
 * rather than at a ticket, and it is gone on every other rung — including the
 * two the ladder lands on afterwards.
 */
describe("Compose Spec", () => {
  /*
   * The one rung that offers a compose, taken off the fixture the Rust
   * derivation produced rather than assembled here. `spec-ready` is
   * `spec-composed` with the `wayfinder:spec` child not written yet — every
   * ticket closed, no spec, map still open — so the phase, the frontier and
   * the map's number below are the model's own reading of a real recorded
   * answer, and this file no longer asserts against a crossing it invented.
   */
  const SPEC_READY = FIXTURES["spec-ready"].model.map;
  const SPEC_READY_MAP = SPEC_READY?.number ?? null;

  it("is a fixture on the one rung, and not a crossing this file made up", () => {
    expect(SPEC_READY?.phase).toBe("specReady");
    expect(SPEC_READY?.frontier).toEqual({ frontier: "nothingToStart" });
    expect(SPEC_READY_MAP).not.toBeNull();
  });

  const composable = (over: Partial<Crossing> = {}): Crossing =>
    crossing({
      frontier: SPEC_READY?.frontier ?? null,
      phase: SPEC_READY?.phase ?? null,
      map: SPEC_READY_MAP,
      ...over,
    });

  const primary = (over: Partial<Crossing> = {}): Socket => {
    const first = railAt(composable(over)).sockets[0];
    if (first === undefined) throw new Error("no primary socket on the rail");
    return first;
  };

  it("offers the compose in the box Start Working already owns, aimed at the map", () => {
    const rail = railAt(composable());

    // The rail is still four sockets in one order: the offer is ink, not a
    // fifth box that arrives when a map finishes.
    expect(rail.sockets.map((socket) => socket.id)).toEqual([
      "start",
      "resume",
      "ask",
      "toFrontier",
    ]);
    expect(rail.sockets[0]?.label).toBe(COMPOSE_LABEL);
    expect(rail.sockets[0]?.fill).toBe("filled");
    expect(rail.sockets[0]?.aimedAt).toBe(SPEC_READY_MAP);
    expect(rail.start).toEqual({ kind: "compose", map: SPEC_READY_MAP });
    // And To Frontier is still the frontier's, which on a finished map has
    // nothing to snap to. The two aimed sockets are not aimed at one number.
    expect(rail.target).toBeNull();
    expect(rail.sockets[3]?.aimedAt).toBeNull();
    expect(rail.sockets[3]?.condition).toBe(NOTHING_TAKEABLE);
  });

  it("leaves every other rung of the ladder starting a ticket", () => {
    for (const phase of ["done", "unstarted", "wayfinding", "specced"] as const) {
      const rail = railAt(crossing({ phase }));

      expect(rail.sockets[0]?.label).toBe(START_LABEL);
      expect(rail.start).toEqual({ kind: "ticket", ticket: 75 });
    }
  });

  it("recesses on the same three conditions, in the same words, as a ticket press", () => {
    expect(primary({ folder: null }).condition).toBe(NO_FOLDER_OPEN);
    expect(primary({ environment: readout([], { kind: "harvesting" }) }).condition).toBe(
      STILL_READING,
    );
    expect(primary({ environment: readout([missing("claude")]) }).condition).toBe(NO_ADAPTER);
    // Recessed and still aimed: the box says what it would compose and why it
    // cannot, and both are text on the socket rather than an attribute.
    expect(primary({ folder: null }).fill).toBe("recessed");
    expect(primary({ folder: null }).aimedAt).toBe(SPEC_READY_MAP);
  });

  it("recesses while this map's compose is still going, and only this map's", () => {
    /*
     * The rung cannot say this and never will: a compose assigns nobody and its
     * map reads `specReady` for the whole of the run, so the phase during a
     * compose is the phase that offered it. What a second press would collide
     * with is the run, and `wayfinder:spec` is a node rather than a set
     * precisely so that two of them can never exist — hence the box goes dark
     * while one is open, in the words the harness refuses with.
     */
    const going = primary({ composing: SPEC_READY_MAP });

    expect(going.fill).toBe("recessed");
    expect(going.condition).toBe(alreadyComposing(SPEC_READY_MAP ?? 0));
    expect(pressable(going)).toBe(false);
    // Still aimed at the map it would compose: the box says what it is about
    // and why it cannot, and neither is an attribute.
    expect(going.label).toBe(COMPOSE_LABEL);
    expect(going.aimedAt).toBe(SPEC_READY_MAP);

    // A compose going on some other map is somebody else's run, and a ticket
    // press is not a compose at all — neither costs this socket its fill.
    expect(primary({ composing: (SPEC_READY_MAP ?? 0) + 1 }).fill).toBe("filled");
    expect(socketOf("start", { composing: 28 }).label).toBe(START_LABEL);
    expect(socketOf("start", { composing: 28 }).fill).toBe("filled");
  });

  it("reads checking while a compose press is in flight, and takes no press", () => {
    const pressed = primary({ press: { kind: "checking" } });

    expect(pressed.label).toBe(CHECKING_LABEL);
    expect(pressable(pressed)).toBe(false);
    expect(pressed.aimedAt).toBe(SPEC_READY_MAP);
  });

  it("is gone once the spec is composed, and gone on a map that is closed", () => {
    /*
     * The two readings #66 closes on, taken off the fixtures the Rust
     * derivation produced rather than worked out here: a composed spec puts the
     * map on `specced`, and a closed map reads `done` — the terminal signal for
     * a destination that produces no issue. Neither rung offers a compose,
     * because only `specReady` does.
     */
    expect(FIXTURES["spec-composed"].model.map?.phase).toBe("specced");
    expect(FIXTURES["map-closed"].model.map?.phase).toBe("done");

    for (const name of ["spec-composed", "map-closed"] as const) {
      const map = FIXTURES[name].model.map;
      const rail = railAt(
        crossing({
          frontier: map?.frontier ?? null,
          phase: map?.phase ?? null,
          map: map?.number ?? null,
        }),
      );

      expect(rail.sockets[0]?.label).not.toBe(COMPOSE_LABEL);
      expect(rail.start?.kind).not.toBe("compose");
    }
  });
});
