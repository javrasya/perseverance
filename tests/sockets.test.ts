import { describe, expect, it } from "vitest";
import {
  ALREADY_THERE,
  ANOTHER_MACHINE,
  ASK_ARRIVES,
  CHECKING_LABEL,
  NOTHING_TAKEABLE,
  NO_ADAPTER,
  NO_FOLDER_OPEN,
  NO_MAP_OPEN,
  RESUME_ARRIVES,
  START_LABEL,
  TO_FRONTIER_LABEL,
  adapterAtPress,
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
import type { AdapterReading } from "../src/environment/folder";
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

const DESIGNATED: Frontier = { frontier: "designated", number: 75 };

function crossing(over: Partial<Crossing> = {}): Crossing {
  return {
    frontier: DESIGNATED,
    selection: null,
    adapters: [resolved("claude")],
    folder: "/work/repo",
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
      crossing({ frontier: null, adapters: [], folder: null }),
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
    for (const socket of railAt(crossing({ frontier: null, adapters: [] })).sockets) {
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
    expect(socketOf("start", { adapters: [missing("claude")] }).condition).toBe(NO_ADAPTER);
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
    expect(railAt(crossing({ adapters: readings })).adapters).toEqual(["codex", "pi"]);
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
