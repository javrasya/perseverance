// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AWAITING_OPERATOR_READING,
  Pane,
  QUIET_READING,
  SIGNAL_READINGS,
  UNWATCHED_READING,
} from "../src/terminal/Pane";
import { forgetPrompts } from "../src/terminal/prompts";
import { forgetStow } from "../src/terminal/reparent";
import type {
  RunEnding,
  RunReadout,
  RunSignal,
  RunSilence,
} from "../src/terminal/runs";
import { Terminals, type Terminal } from "../src/terminal/terminals";
import { monitor, readUi } from "../src/stores/ui";

/**
 * The two endings on screen, and the press that ends a spent run.
 *
 * Every claim here is about the pane's *chrome*, so no xterm is instantiated —
 * the stand-in terminal is the one `tests/terminals.test.tsx` uses, with its
 * calls recorded so *a resolution touches no terminal* can be asserted as the
 * absence of every call rather than as the presence of the right one.
 *
 * `endRun` is stubbed rather than left to no-op through `hasRustBehindIt`,
 * because the thing worth pinning is the **order**: the harness closes the
 * session before this side disposes the node.
 */

const journal = vi.hoisted(() => [] as string[]);

vi.mock("../src/terminal/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/terminal/runs")>()),
  endRun: vi.fn(async (run: number) => {
    journal.push(`endRun(${run})`);
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function aTerminal(): Terminal {
  return {
    element: document.createElement("div"),
    write: () => journal.push("write"),
    reset: () => journal.push("reset"),
    resize: () => journal.push("resize"),
    measure: () => null,
    onData: () => () => {},
    focus: () => {},
    dispose: () => journal.push("dispose"),
  };
}

function readout(ending: RunEnding, code: number | null = null): RunReadout {
  return {
    run: 7,
    held: 4096,
    dropped: 0,
    through: 4096,
    end: 4096,
    truncated: false,
    desynced: false,
    over: ending === "exited" || ending === "exitedUnresolved",
    code,
    monitored: true,
    silence: { kind: "nothing" },
    signal: null,
    ticket: 49,
    folder: "/work/repo",
    ending,
    kind: "work",
    // Stamps rather than ages, which is what lets the words a row prints hold
    // still while readouts land three times a second.
    opened: 1_785_888_000,
    spoke: 1_785_888_240,
  };
}

function mount(readouts: readonly RunReadout[]): {
  host: HTMLElement;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Pane terminals={new Terminals(aTerminal)} readouts={readouts} />);
  });
  return { host, unmount: () => act(() => root.unmount()) };
}

function chrome(host: HTMLElement): string {
  return host.querySelector("section[aria-label='Terminal']")?.textContent ?? "";
}

function press(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector("button");
}

afterEach(() => {
  monitor(null);
  forgetPrompts();
  forgetStow();
  journal.length = 0;
  document.body.replaceChildren();
});

describe("the ending, printed", () => {
  it("says nothing at all, and offers no press, while a run is live", () => {
    monitor(7);
    const { host, unmount } = mount([readout("live")]);

    expect(chrome(host)).not.toContain("ended");
    expect(press(host)).toBe(null);

    unmount();
  });

  it("says the ticket closed, and that the output is the operator's to read", () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    expect(chrome(host)).toContain("the ticket closed");
    expect(chrome(host)).toContain("for as long as you want");

    unmount();
  });

  it("says a run stopped with its ticket still open and still claimed", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    expect(chrome(host)).toContain("still open and still claimed");

    unmount();
  });

  it("keeps the exit code on the ending that has one", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exited", 130)]);

    expect(chrome(host)).toContain("this run has ended (130)");

    unmount();
  });

  it("prints the ending as visible text and never behind a tooltip", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    for (const element of host.querySelectorAll("*")) {
      expect(element.getAttribute("title")).toBe(null);
    }

    unmount();
  });
});

describe("the press that ends a run", () => {
  it("leaves the bound terminal exactly where it was when a ticket merely closes", () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    const pane = host.querySelector("[class*='host']");
    expect(pane?.childElementCount).toBe(1);
    // Not one call to the emulator on a resolution: no session closed, no byte
    // moved, no geometry sent. A ticket closing is a fact about GitHub.
    expect(journal).toEqual([]);
    expect(readUi().monitored).toBe(7);

    unmount();
  });

  it("closes the session first, then lets go of the node, then empties the pane", async () => {
    monitor(7);
    const { host, unmount } = mount([readout("spent")]);

    const button = press(host);
    expect(button).not.toBe(null);
    await act(async () => {
      button?.click();
    });

    expect(journal).toEqual(["endRun(7)", "dispose"]);
    expect(readUi().monitored).toBe(null);
    expect(chrome(host)).toContain("Nothing is running here yet.");

    unmount();
  });

  it("is a keyboard-reachable control, and it sits outside the terminal's node", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exitedUnresolved")]);

    const button = press(host);

    expect(button?.tagName).toBe("BUTTON");
    expect(button?.type).toBe("button");
    expect(button?.closest("[class*='host']")).toBe(null);

    button?.focus();
    expect(document.activeElement).toBe(button);

    unmount();
  });

  it("is offered on every exited reading too, because ending is still a choice", () => {
    monitor(7);
    const { host, unmount } = mount([readout("exited", 0)]);

    expect(press(host)).not.toBe(null);

    unmount();
  });
});

/* --------------------------------------------------------------- shape --- */

/*
 * The other half of a hand-written mirror. `RunReadout` is pinned from the Rust
 * side by `a_run_readout_crosses_in_the_shape_the_frontend_declares`, which
 * counts fifteen keys and asserts these spellings; this is the same count and
 * the same tags read from the type this file consumes. A rename on either side
 * is silent on the other, and two assertions is the whole of the defence.
 *
 * What is pinned here is the *crossing* and not the rendering of it: the chrome
 * that prints both values is asserted further down, and the two claims are kept
 * apart because a rename on the wire and a reworded sentence are different
 * failures with different fixes.
 */
describe("the silence reading crosses in the shape Rust writes", () => {
  it("eighteen keys cross, and these eighteen", () => {
    expect(Object.keys(readout("live")).sort()).toEqual([
      "code",
      "desynced",
      "dropped",
      "end",
      "ending",
      "folder",
      "held",
      "kind",
      "monitored",
      "opened",
      "over",
      "run",
      "signal",
      "silence",
      "spoke",
      "through",
      "ticket",
      "truncated",
    ]);
  });

  it("carries the elapsed inside the reading rather than a number to compare", () => {
    /*
     * The tagged value is the whole of what this side may read: what an elapsed
     * means is a joint predicate over who is waiting and what the ticket says,
     * and a threshold written here would be a second, worse copy of it.
     */
    const quiet: RunSilence = { kind: "quiet", silentForMs: 90_000 };
    const wedged: RunSilence = {
      kind: "wedged",
      why: "awaitingOperator",
      unopenedForMs: 11_000,
    };

    expect(quiet.silentForMs).toBe(90_000);
    expect(wedged.why).toBe("awaitingOperator");
    // Each wedge carries the quantity its own sentence claims, under the name
    // of that quantity: how long the session has failed to open for this one,
    // and the byte silence for the other.
    expect(wedged.unopenedForMs).toBe(11_000);
    const unwatched: RunSilence = { kind: "wedged", why: "silent", silentForMs: 5 * 60_000 };
    expect(unwatched.silentForMs).toBe(5 * 60_000);

    // And the readings with nothing to print carry no elapsed at all, because a
    // spent run is never quiet and an exited one is an ending.
    const spent: RunSilence = { kind: "spent" };
    const nothing: RunSilence = { kind: "nothing" };
    expect(Object.keys(spent)).toEqual(["kind"]);
    expect(Object.keys(nothing)).toEqual(["kind"]);
  });

  it("says nothing has classified a run by having no signal at all", () => {
    const observed: RunSignal[] = ["ready", "busy", "idle"];

    expect(observed).toHaveLength(3);
    expect(readout("live").signal).toBe(null);
  });
});

/* ------------------------------------------------------------- silence --- */

/** The same run, with one reading and one signal swapped in. */
function saying(silence: RunSilence, signal: RunSignal | null = null): RunReadout {
  return { ...readout("live"), silence, signal };
}

/**
 * Words this chrome may never contain, whatever the elapsed.
 *
 * Each one is a claim about a child this side has never seen. A run whose
 * operator went to make coffee is the most ordinary thing a terminal does, and
 * an app that calls it any of these is an app whose warnings get ignored.
 */
const VERDICTS = ["hung", "stuck", "dead", "frozen", "fault"];

describe("the silence, printed as an observation", () => {
  it("reads an hour of somebody thinking as quiet, and as nothing worse", () => {
    monitor(7);
    const { host, unmount } = mount([saying({ kind: "quiet", silentForMs: 62 * 60_000 })]);

    expect(chrome(host)).toContain(`${QUIET_READING} · 62m`);

    unmount();
  });

  it("prints the elapsed rather than comparing it against a number of its own", () => {
    /*
     * Three seconds and thirty days read the same way, because what an elapsed
     * *means* is a joint predicate over who is waiting and what the ticket says
     * — `docs/adr/0025` — and this side sees two of the six values it takes. So
     * the duration is printed and the word beside it is Rust's.
     */
    monitor(7);
    for (const [ms, span] of [
      [3_000, "3s"],
      [30 * 24 * 60 * 60_000, "30d"],
    ] as const) {
      const { host, unmount } = mount([saying({ kind: "quiet", silentForMs: ms })]);
      expect(chrome(host)).toContain(`${QUIET_READING} · ${span}`);
      unmount();
    }
  });

  it("names the CLI's own trust prompt, and raises nothing of its own", () => {
    monitor(7);
    const { host, unmount } = mount([
      saying({ kind: "wedged", why: "awaitingOperator", unopenedForMs: 12_000 }),
    ]);

    expect(chrome(host)).toContain(`${AWAITING_OPERATOR_READING} · 12s`);
    expect(chrome(host)).toContain("trust");
    // And where to look, which is the terminal immediately below the sentence.
    expect(chrome(host)).toContain("in the terminal below");
    /*
     * The modal is the agent CLI's own, already on screen in that terminal. A
     * condition is a fact and a modal is a thing that interrupts you to be
     * dismissed, so the harness names one and opens none.
     */
    for (const interrupting of ['[role="dialog"]', '[role="alertdialog"]', "dialog"]) {
      expect(host.querySelectorAll(interrupting)).toHaveLength(0);
    }

    unmount();
  });

  it("says nobody is watching an unattended run that nothing has classified", () => {
    monitor(7);
    const { host, unmount } = mount([
      saying({ kind: "wedged", why: "silent", silentForMs: 5 * 60_000 }),
    ]);

    expect(chrome(host)).toContain(`${UNWATCHED_READING} · 5m`);
    expect(chrome(host)).toContain("nothing has ever classified it");

    unmount();
  });

  it("leaves the two readings with nothing to add silent, so the ending says it once", () => {
    /*
     * `spent` and `nothing` are already carried by the ending sentence beside
     * this. Printing either twice in two vocabularies is how the two come to
     * disagree — and a spent run is never quiet, however long it has said
     * nothing.
     */
    monitor(7);
    for (const silence of [{ kind: "spent" }, { kind: "nothing" }] as const) {
      const { host, unmount } = mount([{ ...readout("spent"), silence }]);
      expect(chrome(host)).not.toContain(QUIET_READING);
      expect(chrome(host)).not.toContain(UNWATCHED_READING);
      expect(chrome(host)).not.toContain(AWAITING_OPERATOR_READING);
      unmount();
    }
  });

  it("carries no verdict about the child, on any reading there is", () => {
    monitor(7);
    for (const silence of [
      { kind: "quiet", silentForMs: 4 * 60 * 60_000 },
      { kind: "wedged", why: "awaitingOperator", unopenedForMs: 30_000 },
      { kind: "wedged", why: "silent", silentForMs: 42 * 60_000 },
      { kind: "spent" },
      { kind: "nothing" },
    ] as const) {
      const { host, unmount } = mount([saying(silence)]);
      const printed = chrome(host).toLowerCase();
      for (const verdict of VERDICTS) {
        expect([silence.kind, verdict, printed.includes(verdict)]).toEqual([
          silence.kind,
          verdict,
          false,
        ]);
      }
      unmount();
    }
  });

  it("prints the reading as visible text and never behind a tooltip", () => {
    monitor(7);
    const { host, unmount } = mount([
      saying({ kind: "wedged", why: "awaitingOperator", unopenedForMs: 12_000 }),
    ]);

    for (const element of host.querySelectorAll("*")) {
      expect(element.getAttribute("title")).toBe(null);
    }

    unmount();
  });
});

describe("the signal, printed without ever asking about the adapter", () => {
  it("reads each of the three a watch can classify a run as", () => {
    monitor(7);
    for (const signal of ["ready", "busy", "idle"] as const) {
      const { host, unmount } = mount([saying({ kind: "nothing" }, signal)]);
      expect(chrome(host)).toContain(SIGNAL_READINGS[signal]);
      unmount();
    }
  });

  it("says nothing at all for a run nothing has ever classified", () => {
    /*
     * `null` is a fact about this run's history and never an answer about its
     * adapter. Nothing on screen may word it as *this adapter emits no
     * signals*, because that is a question no call site is allowed to ask.
     */
    monitor(7);
    const { host, unmount } = mount([saying({ kind: "nothing" }, null)]);

    const printed = chrome(host).toLowerCase();
    expect(printed).not.toContain("adapter");
    expect(printed).not.toContain("signal");
    for (const reading of Object.values(SIGNAL_READINGS)) {
      expect(printed).not.toContain(reading);
    }

    unmount();
  });
});
