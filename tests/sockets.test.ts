import { describe, expect, it } from "vitest";
import {
  ALREADY_THERE,
  ANOTHER_MACHINE,
  ASK_IS_OUT,
  ASK_LABEL,
  CHECKING_LABEL,
  CLAIM_ELSEWHERE,
  COMPOSE_LABEL,
  NOTHING_TAKEABLE,
  NO_ADAPTER,
  NO_FOLDER_OPEN,
  NO_MAP_OPEN,
  NO_MAP_TO_ASK_ABOUT,
  NO_NODE_SELECTED,
  NOTHING_SELECTED,
  NOT_A_CLAIM,
  NOT_A_TICKET,
  notOnThisMap,
  ONLY_ADAPTER,
  RESUME_IS_OUT,
  RESUME_LABEL,
  RUN_IS_UP,
  STILL_READING,
  START_IS_OUT,
  START_LABEL,
  TO_FRONTIER_LABEL,
  adapterAtPress,
  alreadyComposing,
  liveRunOn,
  offerable,
  picking,
  pressable,
  railAt,
  runningIn,
  sameFrontier,
  type Crossing,
  type Press,
  type Socket,
  type SocketId,
} from "../src/chrome/sockets";
import { NO_HARNESS, resumeWorking, startWorking } from "../src/chrome/started";
import type { HarvestState } from "../src/environment/environment";
import {
  readoutFrom,
  type AdapterReading,
  type FolderReadout,
} from "../src/environment/folder";
import { FIXTURES } from "../src/snapshot/fixtures";
import type { Frontier } from "../src/snapshot/model.generated";
import { forgetPrompts, promptFor, recordPrompt } from "../src/terminal/prompts";
import type { RunReadout } from "../src/terminal/runs";

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

/** A claim under the hand: the selection, and what the one derivation calls it. */
const CLAIMED: Partial<Crossing> = {
  selection: 41,
  selectionReads: "claimed",
  selectionIsTicket: true,
  selectionBoundElsewhere: false,
};

/** A readout the way `runs.ts` mirrors one, cut down to what the rail reads. */
const staked = (
  run: number,
  ticket: number | null,
  over: boolean,
  folder: string | null = "/work/repo",
): RunReadout => ({
  run,
  held: 0,
  dropped: 0,
  through: 0,
  end: 0,
  truncated: false,
  desynced: false,
  over,
  code: null,
  monitored: false,
  silence: { kind: "nothing" },
  signal: null,
  ending: over ? "exitedUnresolved" : "live",
  ticket,
  folder,
  kind: "work",
  // The rail reads neither stamp; they are here because a readout carries them.
  opened: 1_785_888_000,
  spoke: 1_785_888_000,
});

function crossing(over: Partial<Crossing> = {}): Crossing {
  return {
    frontier: DESIGNATED,
    selection: null,
    selectionReads: null,
    selectionIsTicket: false,
    selectionBoundElsewhere: false,
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
      crossing({ press: { kind: "checking", socket: "start" } }),
      crossing({ press: { kind: "refused", socket: "start", detail: "no", frontier: null } }),
      crossing({ selection: 75 }),
      crossing(CLAIMED),
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

});

/**
 * Ask, as arithmetic.
 *
 * #55's own claim, and the whole of it: a question claims nothing, so nothing
 * about another run refuses it. The tests that matter here are the ones that
 * would catch a gate creeping in later — a node the other two spawning sockets
 * turn away is a node this one fills on, and a live run of any kind on the map
 * is nothing to it. What is left recessing it are the honest conditions:
 * something to ask about, somewhere to ask it, and something to ask it with.
 */
describe("Ask", () => {
  /** A node on the open map, and nothing more than that: no kind, no claim. */
  const ASKABLE: Partial<Crossing> = { selection: 41, selectionReads: "takeable" };

  it("fills on the selected node, and is aimed at the selection", () => {
    const ask = socketOf("ask", ASKABLE);

    expect(ask.label).toBe(ASK_LABEL);
    expect(ask.fill).toBe("filled");
    expect(ask.condition).toBeNull();
    expect(pressable(ask)).toBe(true);
    /* The selection and never a ticket or the frontier: Ask acts on the node
       the operator pointed at, while Start Working is armed on #75 beside it. */
    expect(ask.aimedAt).toBe(41);
    expect(railAt(crossing(ASKABLE)).target).toBe(75);
  });

  it("fills on every node the other two spawning sockets turn away", () => {
    const turned: Partial<Crossing>[] = [
      // An unclassified child: no `wayfinder:` label and so no brief for a work
      // run — and the node an operator most needs to be able to ask about.
      { selection: 41, selectionReads: "takeable", selectionIsTicket: false },
      // The map's own spec node, assigned and reading `claimed` for it.
      { selection: 28, selectionReads: "claimed", selectionIsTicket: false },
      // A claim with an open blocker in its way.
      { selection: 41, selectionReads: "blocked", selectionIsTicket: true },
      // A ticket labelled for another machine. Nothing is being launched at it,
      // so the label that says who may launch has nothing to say to a question.
      {
        selection: 41,
        selectionReads: "claimed",
        selectionIsTicket: true,
        selectionBoundElsewhere: true,
      },
    ];

    for (const node of turned) {
      expect(socketOf("resume", node).fill).toBe("recessed");
      expect(socketOf("ask", node).fill).toBe("filled");
      expect(socketOf("ask", node).condition).toBeNull();
      expect(socketOf("ask", node).aimedAt).toBe(node.selection);
    }

    /* And a map with nothing takeable left on it, which is the one reading
       Start Working cannot be armed through. A finished map is exactly where a
       question is what is left to have. */
    const nothingTakeable: Partial<Crossing> = {
      ...ASKABLE,
      frontier: { frontier: "nothingToStart" },
    };
    expect(socketOf("start", nothingTakeable).fill).toBe("recessed");
    expect(socketOf("ask", nothingTakeable).fill).toBe("filled");
  });

  it("is untouched by the map's rung, by a compose that is going, and by the frontier", () => {
    for (const phase of ["done", "unstarted", "wayfinding", "specced", "specReady"] as const) {
      expect(socketOf("ask", { ...ASKABLE, phase }).fill).toBe("filled");
    }
    // A compose run open on this very map is a run this press collides with
    // nothing of: `wayfinder:spec` is a node, and a question attaches none.
    expect(socketOf("ask", { ...ASKABLE, composing: 28 }).fill).toBe("filled");
    // And the frontier is not read at all — the map's number is what says
    // whether there is anything to ask about.
    expect(socketOf("ask", { ...ASKABLE, frontier: null }).fill).toBe("filled");
  });

  it("recesses on the honest conditions, in the order they are met", () => {
    expect(socketOf("ask", { ...ASKABLE, map: null }).condition).toBe(NO_MAP_TO_ASK_ABOUT);
    expect(socketOf("ask").condition).toBe(NO_NODE_SELECTED);
    /* `selectionReads` is `null` for a node that is not a child of the open
       map, which is Rust's `#N is not on map #M` refused before the press. */
    expect(socketOf("ask", { selection: 41, selectionReads: null }).condition).toBe(
      notOnThisMap(41),
    );
    expect(socketOf("ask", { ...ASKABLE, folder: null }).condition).toBe(NO_FOLDER_OPEN);
    expect(socketOf("ask", { ...ASKABLE, environment: null }).condition).toBe(STILL_READING);
    expect(
      socketOf("ask", { ...ASKABLE, environment: readout([], { kind: "harvesting" }) }).condition,
    ).toBe(STILL_READING);
    expect(socketOf("ask", { ...ASKABLE, environment: readout([]) }).condition).toBe(NO_ADAPTER);
    expect(
      socketOf("ask", { ...ASKABLE, press: { kind: "checking", socket: "start" } }).condition,
    ).toBe(START_IS_OUT);
    expect(
      socketOf("ask", { ...ASKABLE, press: { kind: "checking", socket: "resume" } }).condition,
    ).toBe(RESUME_IS_OUT);

    // Recessed, and never anything but recessed while it has one to print.
    expect(socketOf("ask", { ...ASKABLE, folder: null }).fill).toBe("recessed");
    expect(pressable(socketOf("ask", { ...ASKABLE, folder: null }))).toBe(false);

    /* The more particular answer wins, in both directions: no map is said in
       front of no node and in front of no folder, and a selection that is not
       on this map is said in front of what the folder resolved. */
    expect(socketOf("ask", { map: null, folder: null }).condition).toBe(NO_MAP_TO_ASK_ABOUT);
    expect(socketOf("ask", { folder: null }).condition).toBe(NO_NODE_SELECTED);
    expect(
      socketOf("ask", { selection: 41, selectionReads: null, environment: readout([]) }).condition,
    ).toBe(notOnThisMap(41));
    // And the transient one is last: a socket with no folder under it says so
    // whether or not somebody else's press is out.
    expect(
      socketOf("ask", {
        ...ASKABLE,
        folder: null,
        press: { kind: "checking", socket: "start" },
      }).condition,
    ).toBe(NO_FOLDER_OPEN);
  });

  it("wears `checking…` on its own press and names it on the two beside it", () => {
    const asking: Press = { kind: "checking", socket: "ask" };
    const out = { ...CLAIMED, press: asking };
    const ask = socketOf("ask", out);

    expect(ask.label).toBe(CHECKING_LABEL);
    expect(ask.fill).toBe("checking");
    // The condition to press it is met, so there is none to print.
    expect(ask.condition).toBeNull();
    expect(ask.aimedAt).toBe(41);
    expect(pressable(ask)).toBe(false);

    /* One crossing sends one command at a time — a rule about presses and not
       about runs, which is why it can sit beside "nothing about another run
       refuses it" without contradicting it. */
    expect(socketOf("start", out).condition).toBe(ASK_IS_OUT);
    expect(socketOf("resume", out).condition).toBe(ASK_IS_OUT);
    // To Frontier sends no command, so a press in flight is nothing to it.
    expect(socketOf("toFrontier", out).fill).toBe("filled");
  });

  it("prints its refusal under its own socket, and re-arms on nothing", () => {
    const refused: Press = {
      kind: "refused",
      socket: "ask",
      detail: "#41 is not on map #28, so there is nothing here to ask about",
      frontier: null,
    };
    const rail = railAt(crossing({ ...ASKABLE, press: refused }));

    expect(rail.sockets[2]?.note).toBe(refused.detail);
    expect(rail.sockets[0]?.note).toBeNull();
    expect(rail.sockets[1]?.note).toBeNull();
    /* An Ask refusal names no frontier — the command never asked the map what
       was takeable — so the target the snapshot gave is the target still, and
       the sentence stays until the next press answers it. */
    expect(rail.target).toBe(75);
    expect(rail.sockets[2]?.fill).toBe("filled");
  });
});

describe("Resume", () => {
  it("arms on the selected claim, and never on the number Start Working is armed on", () => {
    const rail = railAt(crossing(CLAIMED));
    const resume = rail.sockets[1];

    expect(resume?.label).toBe(RESUME_LABEL);
    expect(resume?.fill).toBe("filled");
    expect(rail.claim).toBe(41);
    /* The frontier is the first *takeable* node by construction, so a claim is
       never what it designates: two armed numbers, and they cannot collide. */
    expect(rail.target).toBe(75);
  });

  it("recesses with the reason there is no claim under the hand", () => {
    expect(socketOf("resume", { frontier: null }).condition).toBe(NO_MAP_OPEN);
    expect(socketOf("resume").condition).toBe(NOTHING_SELECTED);
    // A ticket nobody has taken, and one this app is not the picker of.
    expect(
      socketOf("resume", {
        selection: 41,
        selectionReads: "takeable",
        selectionIsTicket: true,
      }).condition,
    ).toBe(NOT_A_CLAIM);
    /* A claim with an open blocker in its way reads `blocked` in the one
       derivation, and this rail does not get a softer second opinion. */
    expect(
      socketOf("resume", {
        selection: 41,
        selectionReads: "blocked",
        selectionIsTicket: true,
      }).condition,
    ).toBe(NOT_A_CLAIM);
    expect(
      socketOf("resume", {
        selection: 41,
        selectionReads: null,
        selectionIsTicket: true,
      }).condition,
    ).toBe(NOT_A_CLAIM);
  });

  /* The Route makes the destination and the unclassified children selectable,
     and `claimed` is a reading of state alone — so an assigned spec node reads
     exactly what an assigned ticket reads. Start Working can never meet either,
     because the frontier's resolver asks *is this a ticket* before it designates
     anything; Resume is aimed at the selection and has to ask here. */
  it("refuses a selection that is not a ticket, however plainly it is claimed", () => {
    const spec: Partial<Crossing> = {
      selection: 28,
      selectionReads: "claimed",
      selectionIsTicket: false,
    };

    expect(socketOf("resume", spec).condition).toBe(NOT_A_TICKET);
    expect(socketOf("resume", spec).fill).toBe("recessed");
    // And the button is armed on nothing, so a press has no number to send.
    expect(railAt(crossing(spec)).claim).toBeNull();
    // Kind before state: a node that is neither reads the sentence about kind.
    expect(
      socketOf("resume", { ...spec, selectionReads: "takeable" }).condition,
    ).toBe(NOT_A_TICKET);
  });

  /* `NodeState` is derived from state alone, so a ticket assigned to the
     operator and labelled for another platform reads `claimed` here as plainly
     as any other. Rust refuses that press with a sentence of its own — the rail
     saying nothing would buy a whole revalidation to hear it, over a button that
     printed the number and armed. */
  it("refuses a claim that is bound to another machine, before the press is made", () => {
    const elsewhere: Partial<Crossing> = {
      selection: 41,
      selectionReads: "claimed",
      selectionIsTicket: true,
      selectionBoundElsewhere: true,
    };

    expect(socketOf("resume", elsewhere).condition).toBe(CLAIM_ELSEWHERE);
    expect(socketOf("resume", elsewhere).fill).toBe("recessed");
    expect(railAt(crossing(elsewhere)).claim).toBeNull();
    // The order Rust asks them in: kind first, then the binding, then the state.
    expect(
      socketOf("resume", { ...elsewhere, selectionIsTicket: false }).condition,
    ).toBe(NOT_A_TICKET);
    expect(
      socketOf("resume", { ...elsewhere, selectionReads: "takeable" }).condition,
    ).toBe(CLAIM_ELSEWHERE);
  });

  it("says the same things Start Working says about the folder, in the same words", () => {
    expect(socketOf("resume", { ...CLAIMED, folder: null }).condition).toBe(NO_FOLDER_OPEN);
    expect(socketOf("resume", { ...CLAIMED, environment: null }).condition).toBe(STILL_READING);
    expect(socketOf("resume", { ...CLAIMED, environment: readout([]) }).condition).toBe(
      NO_ADAPTER,
    );
  });

  it("wears `checking…` and its refusal on its own socket, and never on Start Working's", () => {
    const checking: Press = { kind: "checking", socket: "resume" };
    const refused: Press = {
      kind: "refused",
      socket: "resume",
      detail: "#41 already has a run in this window and it is still live",
      frontier: null,
    };

    expect(socketOf("resume", { ...CLAIMED, press: checking }).label).toBe(CHECKING_LABEL);
    expect(socketOf("start", { ...CLAIMED, press: checking }).label).toBe(START_LABEL);
    expect(socketOf("resume", { ...CLAIMED, press: refused }).note).toBe(refused.detail);
    expect(socketOf("start", { ...CLAIMED, press: refused }).note).toBeNull();
  });

  /* One crossing sends one command at a time, and that is a fill rather than a
     guard in the handler: a socket left filled and armed beside the one under
     the hand would swallow the press for the whole of a revalidation and say
     nothing about why. To Frontier sends no command, so it is untouched. */
  it("recesses the other spawning socket while a press is out, and names whose it is", () => {
    const resuming = crossing({ ...CLAIMED, press: { kind: "checking", socket: "resume" } });
    const starting = crossing({ ...CLAIMED, press: { kind: "checking", socket: "start" } });

    expect(socketOf("start", { ...CLAIMED, press: resuming.press }).fill).toBe("recessed");
    expect(socketOf("start", { ...CLAIMED, press: resuming.press }).condition).toBe(RESUME_IS_OUT);
    expect(socketOf("resume", { ...CLAIMED, press: starting.press }).fill).toBe("recessed");
    expect(socketOf("resume", { ...CLAIMED, press: starting.press }).condition).toBe(START_IS_OUT);

    for (const state of [resuming, starting]) {
      const toFrontier = railAt(state).sockets[3];
      expect(toFrontier?.fill).toBe("filled");
      expect(pressable(toFrontier as Socket)).toBe(true);
    }

    // And never about its own press, which is `checking…` and not a condition.
    expect(socketOf("resume", { ...CLAIMED, press: resuming.press }).condition).toBeNull();
    expect(socketOf("start", { ...CLAIMED, press: starting.press }).condition).toBeNull();
  });

  it("finds the live run staked on a claim, and nothing for one that is over", () => {
    const runs = [staked(7, 41, false), staked(8, 42, true), staked(9, null, false)];

    expect(liveRunOn(runs, 41, "/work/repo")).toBe(7);
    // Over is over: there is no child left in that pane to be moved back to.
    expect(liveRunOn(runs, 42, "/work/repo")).toBeNull();
    // A run the harness was never told a ticket for joins to no claim at all.
    expect(liveRunOn(runs, 99, "/work/repo")).toBeNull();
  });

  /* An issue number is unique inside one repository and means nothing across
     two, and this window holds every folder's runs at once. Answering here on
     the number alone moved the pane onto another repository's agent and sent no
     command — so Rust's own folder-aware check was never even reached. */
  it("joins on the folder as well as the number, as Rust does", () => {
    const runs = [staked(7, 77, false, "/work/other"), staked(8, null, false)];

    expect(liveRunOn(runs, 77, "/work/repo")).toBeNull();
    expect(liveRunOn(runs, 77, "/work/other")).toBe(7);
    // A run with no folder is a run the harness was never told about, and it
    // joins to a claim no more than a run with no ticket does.
    expect(liveRunOn(runs, 77, null as unknown as string)).toBeNull();
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
    const start = socketOf("start", { press: { kind: "checking", socket: "start" } });

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
      socket: "start",
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
        press: {
          kind: "refused",
          socket: "start",
          detail: "moved",
          frontier: { frontier: "nothingToStart" },
        },
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
        press: {
          kind: "refused",
          socket: "start",
          detail: "the check did not land in time",
          frontier: null,
        },
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
  it("refuses in a sentence rather than faking a spawn, on either verb", async () => {
    const refusal = { kind: "refused", detail: NO_HARNESS, frontier: null };

    expect(await startWorking("/work/repo", 75, "claude")).toEqual(refusal);
    expect(await resumeWorking("/work/repo", 41, "claude")).toEqual(refusal);
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
    const pressed = primary({ press: { kind: "checking", socket: "start" } });

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

describe("which agent, and when it is no longer a choice", () => {
  const two = ["claude", "codex"];

  it("offers a control while nothing is going", () => {
    expect(picking(two, null, false)).toEqual({ mode: "choice", chosen: "claude", fixed: null });
    expect(picking(two, "codex", false).chosen).toBe("codex");
  });

  it("prints the one adapter a folder resolved, and says why it is not a choice", () => {
    const one = picking(["claude"], null, false);
    expect(one.mode).toBe("printed");
    expect(one.chosen).toBe("claude");
    expect(one.fixed).toBe(ONLY_ADAPTER);
  });

  it("prints it unchangeable during a run, with the reason", () => {
    /* The acceptance criterion, in the derivation: an agent cannot be swapped
       under a run that is already talking, and the screen says so rather than
       silently ignoring the change. */
    const running = picking(two, "codex", true);
    expect(running.mode).toBe("printed");
    expect(running.chosen).toBe("codex");
    expect(running.fixed).toBe(RUN_IS_UP);
  });

  it("is nothing at all when the folder resolved no agent", () => {
    // The recessed Start Working already prints `NO_ADAPTER`; a second copy of
    // that sentence under an empty control is the rail saying it twice.
    expect(picking([], null, false)).toEqual({ mode: "none", chosen: null, fixed: null });
    expect(picking([], null, true).fixed).toBeNull();
  });

  it("counts a run as going only in the folder it is going in", () => {
    const here = staked(3, 41, false);
    const elsewhere = staked(4, 41, false, "/work/other");
    expect(runningIn([here], [3], "/work/repo")).toBe(true);
    expect(runningIn([elsewhere], [4], "/work/repo")).toBe(false);
    // Over is over: the ids this window still shows as going are the reading.
    expect(runningIn([here], [], "/work/repo")).toBe(false);
    expect(runningIn([here], [3], null)).toBe(false);
  });
});
