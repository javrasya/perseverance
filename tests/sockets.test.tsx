// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
 * `Sockets.jsx` and not `Sockets`, and the extension is load-bearing for the
 * same reason `Route.jsx` is: macOS and Windows filesystems are
 * case-insensitive, so an extensionless `../src/chrome/Sockets` resolves to
 * `sockets.ts` — the derivation — and the component is never found.
 */
import { Sockets, focusPicker } from "../src/chrome/Sockets.jsx";
import {
  ASK_IS_OUT,
  ASK_LABEL,
  CHECKING_LABEL,
  COMPOSE_LABEL,
  NOTHING_TAKEABLE,
  NO_ADAPTER,
  NO_MAP_TO_ASK_ABOUT,
  NOTHING_SELECTED,
  NOT_A_TICKET,
  RESUME_IS_OUT,
  RESUME_LABEL,
  RUN_IS_UP,
  START_LABEL,
  TO_FRONTIER_LABEL,
  alreadyComposing,
} from "../src/chrome/sockets";
import type { Asked, Composed, Started } from "../src/chrome/started";
import {
  readoutFrom,
  type AdapterReading,
  type FolderReadout,
} from "../src/environment/folder";
import type { Frontier } from "../src/snapshot/model.generated";
import { monitor, readUi } from "../src/stores/ui";
import { forgetPrompts, promptFor } from "../src/terminal/prompts";
import type { RunKind, RunReadout } from "../src/terminal/runs";

/**
 * The rail, mounted.
 *
 * `tests/sockets.test.ts` pins the arithmetic; this pins the wiring — that the
 * four boxes are in the document in every state, that the condition is text on
 * screen rather than an attribute a hover reveals, that the word on the button
 * while the check is in flight is `checking…` and a second press in that window
 * buys nothing, and that a refusal naming a new frontier re-arms the button and
 * then waits for a press that is made again.
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CLAUDE: AdapterReading = {
  id: "claude",
  resolution: { kind: "resolved", name: "claude", program: "/usr/bin/claude", from: "candidate" },
  probes: [],
};

const readout = (adapters: readonly AdapterReading[]): FolderReadout =>
  readoutFrom({ adapters, harvest: { kind: "harvested" } }, "/work/repo");

const AT_75: Frontier = { frontier: "designated", number: 75 };

/** A run of this window's, cut down to the three fields the rail joins on. */
const staked = (
  run: number,
  ticket: number,
  over: boolean,
  folder = "/work/repo",
  kind: RunKind = "work",
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
  ending: over ? "exitedUnresolved" : "live",
  ticket,
  folder,
  kind,
});

/** #41 selected and read as a claim: the crossing Resume is offered at. */
const CLAIM = { selection: 41, selectionReads: "claimed", selectionIsTicket: true } as const;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;
let selected: number | null = null;

function paint(props: Partial<Parameters<typeof Sockets>[0]> = {}): HTMLElement {
  const host = mounted?.host ?? document.createElement("div");
  if (mounted === null) {
    document.body.append(host);
    mounted = { root: createRoot(host), host };
  }
  const root = mounted.root;
  act(() => {
    root.render(
      <Sockets
        frontier={AT_75}
        selection={null}
        environment={readout([CLAUDE])}
        folder="/work/repo"
        phase={null}
        map={null}
        liveRuns={[]}
        selectionReads={null}
        selectionIsTicket={false}
        selectionBoundElsewhere={false}
        runs={[]}
        onSelect={(node) => {
          selected = node;
        }}
        {...props}
      />,
    );
  });
  return host;
}

const socket = (host: HTMLElement, id: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`[data-socket="${id}"]`);
  if (found === null) throw new Error(`no ${id} socket in the document`);
  return found;
};

const button = (host: HTMLElement, id: string): HTMLButtonElement => {
  const found = socket(host, id).querySelector("button");
  if (found === null) throw new Error(`no button in the ${id} socket`);
  return found;
};

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  forgetPrompts();
  monitor(null);
  selected = null;
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the rail on screen", () => {
  it("has all four sockets whether or not any of them can be pressed", () => {
    const host = paint({ frontier: { frontier: "nothingToStart" }, environment: readout([]) });
    const ids = [...host.querySelectorAll("[data-socket]")].map((el) =>
      el.getAttribute("data-socket"),
    );

    expect(ids).toEqual(["start", "resume", "ask", "toFrontier"]);
    // Recessed is ink: the box is still there, and so is the control in it.
    expect(button(host, "start").getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain(START_LABEL);
    expect(host.textContent).toContain(TO_FRONTIER_LABEL);
  });

  it("prints every condition as visible text and none of it as a tooltip", () => {
    const host = paint({ environment: readout([]) });

    expect(socket(host, "start").textContent).toContain(NO_ADAPTER);
    expect(socket(host, "resume").textContent).toContain(NOTHING_SELECTED);
    expect(socket(host, "ask").textContent).toContain(NO_MAP_TO_ASK_ABOUT);
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("recesses the whole rail's start on the frontier's own reading", () => {
    const host = paint({ frontier: { frontier: "nothingToStart" } });

    expect(socket(host, "start").textContent).toContain(NOTHING_TAKEABLE);
  });

  it("snaps the selection back to the frontier, and recesses once it is there", () => {
    const host = paint({ selection: 12 });

    act(() => button(host, "toFrontier").click());
    expect(selected).toBe(75);

    const settled = paint({ selection: 75 });
    expect(button(settled, "toFrontier").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Resume", () => {
  it("prints its own number, and never the one Start Working is armed on", () => {
    const host = paint(CLAIM);

    expect(socket(host, "resume").textContent).toContain(RESUME_LABEL);
    expect(socket(host, "resume").textContent).toContain("#41");
    expect(socket(host, "resume").textContent).not.toContain("#75");
    expect(socket(host, "start").textContent).toContain("#75");
    expect(button(host, "resume").getAttribute("aria-disabled")).toBe("false");
  });

  it("starts a cold run on a stale claim, and nothing in the payload names the verb", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 12,
      prompt: { text: "work #41", characters: 8, origin: "stock" },
    } satisfies Started);
    const host = paint(CLAIM);

    await act(async () => {
      button(host, "resume").click();
    });

    expect(invoke).toHaveBeenCalledWith("resume_working", {
      folder: "/work/repo",
      ticket: 41,
      adapter: "claude",
    });
    /* The whole of the acceptance criterion: three values and no fourth. A verb
       flag, a template name or an origin marker here would be a way for a
       resumed session's prompt to differ from a started one's. */
    expect(Object.keys(invoke.mock.calls[0]?.[1] as object)).toEqual([
      "folder",
      "ticket",
      "adapter",
    ]);
    // And the spawn owes the same two writes a start does.
    expect(readUi().monitored).toBe(12);
    expect(promptFor(12)).toEqual({ text: "work #41", characters: 8, origin: "stock" });
  });

  it("reaches a live claim by moving the pane onto it, on both sides", async () => {
    const host = paint({ ...CLAIM, runs: [staked(7, 41, false)] });

    await act(async () => {
      button(host, "resume").click();
    });

    /* The harness is told as well as the store. `Runs::frame` writes bytes for
       the one monitored run, so a store that moved alone would bind a terminal
       nothing is being written to — and the ring behind it would fill until
       `truncated` promised a replay that could never arrive. */
    expect(invoke).toHaveBeenCalledWith("monitor_run", { run: 7 });
    expect(readUi().monitored).toBe(7);
    // One crossing is one pane: a second agent on a ticket already running here
    // is not a resume of anything, so nothing is spawned.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("resume_working", expect.anything());
  });

  /* The destination is selectable in the Route and reads `claimed` the moment
     it is assigned, because the derivation reads state and never kind. Start
     Working can never be aimed at it; Resume is aimed at the selection, so the
     rail has to refuse it in front of the operator. */
  it("recesses over a claimed node that is not a ticket, and arms on nothing", () => {
    const host = paint({ selection: 28, selectionReads: "claimed", selectionIsTicket: false });

    expect(socket(host, "resume").textContent).toContain(NOT_A_TICKET);
    expect(socket(host, "resume").textContent).not.toContain("#28");
    expect(button(host, "resume").getAttribute("aria-disabled")).toBe("true");
  });

  /* The same number in another repository is another piece of work. Moving the
     pane there would show an agent in a folder nobody pointed at and send no
     command at all — the claim under the hand never picked up, and nothing on
     screen saying so. */
  it("spawns over a live run on the same number in another folder", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 14,
      prompt: { text: "work #41", characters: 8, origin: "stock" },
    } satisfies Started);
    const host = paint({ ...CLAIM, runs: [staked(7, 41, false, "/work/other")] });

    await act(async () => {
      button(host, "resume").click();
    });

    expect(invoke).toHaveBeenCalledWith("resume_working", {
      folder: "/work/repo",
      ticket: 41,
      adapter: "claude",
    });
    expect(readUi().monitored).toBe(14);
  });

  /* An Ask on the claim is the collision this rail could actually reach: the
     socket fills on a `claimed` node on purpose, and the question is staked on
     that node in that folder. Resuming over it must be a resume — the question
     holds nothing, so there is nothing here for one crossing, one pane to
     protect. Before the kind crossed, this press moved the pane onto the Ask
     session and sent no command, so the operator was reading a question they
     believed was their work. */
  it("spawns over a live Ask run staked on the same claim", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 15,
      prompt: { text: "work #41", characters: 8, origin: "stock" },
    } satisfies Started);
    const host = paint({ ...CLAIM, runs: [staked(9, 41, false, "/work/repo", "ask")] });

    await act(async () => {
      button(host, "resume").click();
    });

    expect(invoke).toHaveBeenCalledWith("resume_working", {
      folder: "/work/repo",
      ticket: 41,
      adapter: "claude",
    });
    expect(invoke).not.toHaveBeenCalledWith("monitor_run", { run: 9 });
    expect(readUi().monitored).toBe(15);
  });

  it("treats a run that is over as no run at all, and starts a cold one", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 13,
      prompt: { text: "work #41", characters: 8, origin: "stock" },
    } satisfies Started);
    const host = paint({ ...CLAIM, runs: [staked(7, 41, true)] });

    await act(async () => {
      button(host, "resume").click();
    });

    expect(invoke).toHaveBeenCalledWith("resume_working", {
      folder: "/work/repo",
      ticket: 41,
      adapter: "claude",
    });
  });

  it("prints its refusal under its own button, and leaves Start Working's alone", async () => {
    invoke.mockResolvedValue({
      kind: "refused",
      detail: "#41 already has a run in this window and it is still live",
      frontier: null,
    } satisfies Started);
    const host = paint(CLAIM);

    await act(async () => {
      button(host, "resume").click();
    });

    expect(socket(host, "resume").textContent).toContain("already has a run in this window");
    expect(socket(host, "start").textContent).not.toContain("already has a run in this window");
    expect(readUi().monitored).toBeNull();
  });

  it("says `checking…` on the socket under the hand and not on the one beside it", async () => {
    let answer: (started: Started) => void = () => {};
    invoke.mockReturnValue(
      new Promise<Started>((resolve) => {
        answer = resolve;
      }),
    );
    const host = paint(CLAIM);

    await act(async () => {
      button(host, "resume").click();
    });

    expect(button(host, "resume").textContent).toContain(CHECKING_LABEL);
    expect(button(host, "start").textContent).toContain(START_LABEL);

    /* And the spawning button beside it is not a second way to make the press
       that is out — recessed, with the press named on it, rather than filled
       and silently swallowing the click. To Frontier sends no command, so it is
       pressable throughout. */
    expect(socket(host, "start").getAttribute("data-fill")).toBe("recessed");
    expect(socket(host, "start").textContent).toContain(RESUME_IS_OUT);
    expect(button(host, "start").getAttribute("aria-disabled")).toBe("true");
    expect(button(host, "toFrontier").getAttribute("aria-disabled")).toBe("false");

    await act(async () => {
      button(host, "start").click();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => button(host, "toFrontier").click());
    expect(selected).toBe(75);

    await act(async () => {
      answer({
        kind: "spawned",
        run: 12,
        prompt: { text: "work #41", characters: 8, origin: "stock" },
      });
    });
  });
});

describe("a press", () => {
  it("reads checking while the revalidation is in flight, and a second press buys nothing", async () => {
    let answer: (started: Started) => void = () => {};
    invoke.mockReturnValue(
      new Promise<Started>((resolve) => {
        answer = resolve;
      }),
    );
    const host = paint();

    await act(async () => {
      button(host, "start").click();
    });

    expect(button(host, "start").textContent).toContain(CHECKING_LABEL);
    expect(button(host, "start").getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      button(host, "start").click();
    });
    // One press, one command: the window between a press and its answer is not
    // a window in which the button is worth pressing again.
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({
        kind: "spawned",
        run: 9,
        prompt: { text: "work #75", characters: 8, origin: "stock" },
      });
    });
  });

  it("goes out with the folder, the frontier and the adapter picked at the crossing", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 9,
      prompt: { text: "work #75", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();

    await act(async () => {
      button(host, "start").click();
    });

    expect(invoke).toHaveBeenCalledWith("start_working", {
      folder: "/work/repo",
      ticket: 75,
      adapter: "claude",
    });
  });

  it("binds the pane to the run it started and keeps the prompt that came back", async () => {
    const prompt = { text: "work #75", characters: 8, origin: "custom" } as const;
    invoke.mockResolvedValue({ kind: "spawned", run: 9, prompt } satisfies Started);
    const host = paint();

    await act(async () => {
      button(host, "start").click();
    });

    expect(readUi().monitored).toBe(9);
    // The one answer that ever carries the text is this one.
    expect(promptFor(9)).toEqual(prompt);
  });

  it("shows the refusal, re-arms on the frontier it named, and waits to be pressed again", async () => {
    invoke.mockResolvedValueOnce({
      kind: "refused",
      detail: "#75 is not what this map offers to start any more",
      frontier: { frontier: "designated", number: 76 },
    } satisfies Started);
    const host = paint();

    await act(async () => {
      button(host, "start").click();
    });

    expect(socket(host, "start").textContent).toContain("not what this map offers");
    expect(socket(host, "start").textContent).toContain("#76");
    // Nothing was started off the back of the refusal: the second press is a
    // press, made by a hand, at the target the refusal named.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readUi().monitored).toBeNull();

    invoke.mockResolvedValueOnce({
      kind: "spawned",
      run: 11,
      prompt: { text: "work #76", characters: 8, origin: "stock" },
    } satisfies Started);

    await act(async () => {
      button(host, "start").click();
    });

    expect(invoke).toHaveBeenLastCalledWith("start_working", {
      folder: "/work/repo",
      ticket: 76,
      adapter: "claude",
    });
  });

  it("lets the next snapshot retire a refusal that the map has moved past", async () => {
    invoke.mockResolvedValueOnce({
      kind: "refused",
      detail: "#75 is not what this map offers to start any more",
      frontier: { frontier: "designated", number: 76 },
    } satisfies Started);
    const host = paint();

    await act(async () => {
      button(host, "start").click();
    });

    expect(socket(host, "start").textContent).toContain("#76");

    /* A tick that says the same thing changes nothing: the refusal is still
       what the map says, and its sentence is still the answer to the press. */
    paint({ frontier: { frontier: "designated", number: 76 } });
    expect(socket(host, "start").textContent).toContain("#76");
    expect(socket(host, "start").textContent).toContain("not what this map offers");

    /* A tick that disagrees is the newer read, and the rail follows it rather
       than staying armed on a number nobody can start any more. */
    paint({ frontier: { frontier: "nothingToStart" } });
    expect(socket(host, "start").textContent).not.toContain("#76");
    expect(socket(host, "start").textContent).toContain(NOTHING_TAKEABLE);
    // The sentence goes with the arm it explained.
    expect(socket(host, "start").textContent).not.toContain("not what this map offers");
    expect(button(host, "start").getAttribute("aria-disabled")).toBe("true");
  });
});

/**
 * The compose press, wired.
 *
 * The same two writes a work press owes — the prompt this run was started with,
 * and the pane bound to it — and one command's worth of arguments: a compose is
 * aimed at the map the ledger already has open, so no number goes out with it.
 */
describe("a compose press", () => {
  const composable = {
    frontier: { frontier: "nothingToStart" },
    phase: "specReady",
    map: 28,
  } as const;

  it("spawns the compose on the open map and keeps what it was started with", async () => {
    const prompt = { text: "compose #28", characters: 11, origin: "stock" } as const;
    invoke.mockResolvedValue({ kind: "spawned", run: 4, prompt } satisfies Composed);
    const host = paint(composable);

    expect(button(host, "start").textContent).toContain(COMPOSE_LABEL);
    expect(button(host, "start").textContent).toContain("#28");

    await act(async () => {
      button(host, "start").click();
    });

    // No ticket in the arguments: which map is open is the ledger's answer, and
    // the command re-reads it.
    expect(invoke).toHaveBeenCalledWith("compose_spec", {
      folder: "/work/repo",
      adapter: "claude",
    });
    expect(readUi().monitored).toBe(4);
    expect(promptFor(4)).toEqual(prompt);
  });

  it("stops offering a second compose while the run it spawned is still going", async () => {
    /*
     * #66's third rule, at the button. A compose takes no claim and its map
     * stays on `specReady` until the spec lands, so nothing in the snapshot
     * changes while the run works — and a box that stayed filled would spawn a
     * second session attaching a second `wayfinder:spec` child to one map. The
     * rail is the visible half of that guard; the harness refuses the press
     * whatever this box looks like.
     */
    const prompt = { text: "compose #28", characters: 11, origin: "stock" } as const;
    invoke.mockResolvedValue({ kind: "spawned", run: 4, prompt } satisfies Composed);
    const host = paint(composable);

    await act(async () => {
      button(host, "start").click();
    });

    // The readouts now count that run as going, which is the only way this side
    // learns a compose is under way.
    paint({ ...composable, liveRuns: [4] });

    expect(socket(host, "start").dataset.fill).toBe("recessed");
    expect(socket(host, "start").textContent).toContain(alreadyComposing(28));
    await act(async () => {
      button(host, "start").click();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    // And the offer is back the moment that run stops being one of the live
    // ones: a compose that ended without writing a spec must not cost its map
    // the offer for the rest of the session.
    paint({ ...composable, liveRuns: [] });
    expect(socket(host, "start").dataset.fill).toBe("filled");
  });

  it("prints a refusal beside the socket and starts nothing off the back of it", async () => {
    invoke.mockResolvedValue({
      kind: "refused",
      detail: "#28 already has a spec, so there is nothing left to compose",
    } satisfies Composed);
    const host = paint(composable);

    await act(async () => {
      button(host, "start").click();
    });

    expect(socket(host, "start").textContent).toContain("already has a spec");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readUi().monitored).toBeNull();
    // A compose refusal names no frontier, so nothing was re-armed and the box
    // is back to the offer it made.
    expect(button(host, "start").textContent).toContain(COMPOSE_LABEL);
  });
});

/**
 * The Ask press, wired.
 *
 * The same two writes every spawn owes — the prompt this run was started with,
 * and the pane bound to it, which is the keyboard invariant on this side — over
 * a node that no resolver has been through and no claim is held on. What the
 * press does *not* do is the point of #55: it asks nothing about the frontier,
 * takes nothing from the map, and re-arms on nothing when it is refused.
 */
describe("an Ask press", () => {
  /** #41 selected on the open map, and nothing else true of it. */
  const ASKING = { map: 28, selection: 41, selectionReads: "takeable" } as const;

  it("goes out with the folder, the node and the adapter, and nothing else", async () => {
    const prompt = { text: "ask about #41", characters: 13, origin: "stock" } as const;
    invoke.mockResolvedValue({ kind: "spawned", run: 21, prompt } satisfies Asked);
    const host = paint(ASKING);

    expect(button(host, "ask").textContent).toContain(ASK_LABEL);
    // Aimed at the selection, and Start Working beside it at the frontier: the
    // two numbers are different facts and the rail prints both.
    expect(socket(host, "ask").textContent).toContain("#41");
    expect(socket(host, "start").textContent).toContain("#75");

    await act(async () => {
      button(host, "ask").click();
    });

    expect(invoke).toHaveBeenCalledWith("ask", {
      folder: "/work/repo",
      node: 41,
      adapter: "claude",
    });
    // A node and not a ticket: the argument is the selection whatever it is.
    expect(Object.keys(invoke.mock.calls[0]?.[1] as object)).toEqual([
      "folder",
      "node",
      "adapter",
    ]);
    /* The two writes a spawn owes. The pane follows the question even while a
       claiming run is live — one operator, one pane, one keyed run. */
    expect(readUi().monitored).toBe(21);
    expect(promptFor(21)).toEqual(prompt);
  });

  it("is offered over a claim another run is holding, and takes nothing from it", async () => {
    const prompt = { text: "ask about #41", characters: 13, origin: "stock" } as const;
    invoke.mockResolvedValue({ kind: "spawned", run: 22, prompt } satisfies Asked);
    const host = paint({
      ...ASKING,
      selectionReads: "claimed",
      selectionIsTicket: true,
      runs: [staked(7, 41, false)],
      liveRuns: [7],
    });

    expect(button(host, "ask").getAttribute("aria-disabled")).toBe("false");

    await act(async () => {
      button(host, "ask").click();
    });

    expect(invoke).toHaveBeenCalledWith("ask", {
      folder: "/work/repo",
      node: 41,
      adapter: "claude",
    });
    // And the keys move to the question, which is the whole of what a live run
    // beside it has to give up.
    expect(readUi().monitored).toBe(22);
  });

  it("prints its refusal under its own socket and re-arms nothing", async () => {
    invoke.mockResolvedValue({
      kind: "refused",
      detail: "#41 is not on map #28, so there is nothing here to ask about",
      /* No `frontier` on the answer at all: an Ask was never aimed at what the
         map offers to start, so there is nothing for one to re-arm on. */
    } satisfies Asked);
    const host = paint(ASKING);

    await act(async () => {
      button(host, "ask").click();
    });

    expect(socket(host, "ask").textContent).toContain("nothing here to ask about");
    expect(socket(host, "start").textContent).not.toContain("nothing here to ask about");
    expect(socket(host, "resume").textContent).not.toContain("nothing here to ask about");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readUi().monitored).toBeNull();
    // Nothing was retargeted: Start Working is still armed on the frontier the
    // snapshot gave, and Ask is back to the offer it made.
    expect(socket(host, "start").textContent).toContain("#75");
    expect(button(host, "ask").textContent).toContain(ASK_LABEL);
  });

  it("retires that refusal when the selection moves off the node it was about", async () => {
    invoke.mockResolvedValue({
      kind: "refused",
      detail: "#41 is not on map #28, so there is nothing here to ask about",
    } satisfies Asked);
    const host = paint(ASKING);

    await act(async () => {
      button(host, "ask").click();
    });

    expect(socket(host, "ask").textContent).toContain("nothing here to ask about");

    /* A tick that hands back the same selection is not a move: the refusal is
       still the answer to the press the socket is wearing. */
    paint(ASKING);
    expect(socket(host, "ask").textContent).toContain("nothing here to ask about");

    /* A different node is, and the sentence goes with the press it answered:
       it was about #41, and nobody has asked anything about #42. */
    paint({ ...ASKING, selection: 42 });
    expect(socket(host, "ask").textContent).not.toContain("nothing here to ask about");
    expect(socket(host, "ask").textContent).toContain("#42");
    expect(button(host, "ask").textContent).toContain(ASK_LABEL);
  });

  it("says `checking…` while its press is out, and a second press buys nothing", async () => {
    let answer: (asked: Asked) => void = () => {};
    invoke.mockReturnValue(
      new Promise<Asked>((resolve) => {
        answer = resolve;
      }),
    );
    /* A claim under the hand, so both the sockets beside this one are armed on
       something and the only reason either recesses is the press in flight. */
    const host = paint({ ...ASKING, selectionReads: "claimed", selectionIsTicket: true });

    await act(async () => {
      button(host, "ask").click();
    });

    expect(button(host, "ask").textContent).toContain(CHECKING_LABEL);
    expect(button(host, "ask").getAttribute("aria-disabled")).toBe("true");

    /* One crossing sends one command at a time. That is a rule about presses
       and not about runs: the two spawning sockets beside this one recess with
       the press named on them rather than swallowing a click in silence. */
    expect(socket(host, "start").textContent).toContain(ASK_IS_OUT);
    expect(socket(host, "resume").textContent).toContain(ASK_IS_OUT);
    expect(button(host, "toFrontier").getAttribute("aria-disabled")).toBe("false");

    // The rail is still four boxes in one order, mid-press as everywhere else.
    const ids = [...host.querySelectorAll("[data-socket]")].map((el) =>
      el.getAttribute("data-socket"),
    );
    expect(ids).toEqual(["start", "resume", "ask", "toFrontier"]);

    await act(async () => {
      button(host, "ask").click();
    });
    await act(async () => {
      button(host, "start").click();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({
        kind: "spawned",
        run: 23,
        prompt: { text: "ask about #41", characters: 13, origin: "stock" },
      });
    });
    expect(button(host, "ask").textContent).toContain(ASK_LABEL);
  });
});

describe("the picker at the crossing", () => {
  const CODEX: AdapterReading = {
    id: "codex",
    resolution: { kind: "resolved", name: "codex", program: "/usr/bin/codex", from: "candidate" },
    probes: [],
  };

  it("is a control the palette can reach while nothing is going", () => {
    const host = paint({ environment: readout([CLAUDE, CODEX]) });
    const picker = host.querySelector("[data-picker]");
    expect(picker?.tagName).toBe("SELECT");
    expect(picker?.hasAttribute("data-picker-fixed")).toBe(false);
  });

  it("is printed and unchangeable during a run, with the reason on screen", () => {
    const host = paint({
      environment: readout([CLAUDE, CODEX]),
      runs: [staked(3, 41, false)],
      liveRuns: [3],
    });
    const picker = host.querySelector("[data-picker]");
    expect(picker?.querySelector("select")).toBeNull();
    expect(picker?.textContent).toContain("claude");
    /* Visible text and never a `title`: the reason has to be readable by the
       screen reader and the keyboard the palette sends here. */
    expect(picker?.textContent).toContain(RUN_IS_UP);
    expect(picker?.getAttribute("data-picker-fixed")).toBe(RUN_IS_UP);
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("hands the palette the sentence when it cannot be focused", () => {
    paint({ environment: readout([CLAUDE, CODEX]), runs: [staked(3, 41, false)], liveRuns: [3] });
    expect(focusPicker()).toBe(RUN_IS_UP);
  });

  it("takes the keyboard when it is a choice, and the palette sends it there", () => {
    const host = paint({ environment: readout([CLAUDE, CODEX]) });
    expect(focusPicker()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-picker]"));
  });
});
