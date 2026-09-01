// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { keyedRun, monitor, readUi, setKeyed } from "../src/stores/ui";
import {
  NOWHERE_TO_OFFER,
  NO_FOLDER_TO_JOIN,
  SPILL_READING,
  spillSentence,
} from "../src/terminal/Pane";
import type { RunReadout } from "../src/terminal/runs";
import {
  KEPT_CHARACTERS,
  forgetSpills,
  offeredTo,
  spillAtRun,
  spilledAtRun,
} from "../src/terminal/spill";

/**
 * The caret parks when the run it is on dies.
 *
 * The whole property in one file, because it is one property: the pane does not
 * move, the keystrokes do not reach a child that is gone, and the run keeps its
 * row. Asserted against the mounted app rather than against the pane alone —
 * *nothing rebinds the caret* is a claim about every automatic path in the
 * window at once, and a test that rendered only the pane could not see the poll
 * that lands the death.
 *
 * The emulator is stood in for the way `tests/dev-web.test.tsx` stands it in,
 * with one addition: this file keeps the `onData` handlers, because a keystroke
 * is what it is here to press.
 */

interface Fake {
  element: HTMLElement;
  handlers: ((text: string) => void)[];
  disposed: number;
}

const made = vi.hoisted(() => [] as Fake[]);

vi.mock("../src/terminal/xterm", () => ({
  xterm: () => {
    const fake: Fake = {
      element: document.createElement("div"),
      handlers: [],
      disposed: 0,
    };
    made.push(fake);
    return {
      element: fake.element,
      write: () => {},
      reset: () => {},
      resize: () => {},
      measure: () => null,
      onData: (handler: (text: string) => void) => {
        fake.handlers.push(handler);
        return () => {
          fake.handlers = fake.handlers.filter((held) => held !== handler);
        };
      },
      // Really focuses its node, the way `tests/keys-shell.test.tsx` does it: a
      // recorded call would pass with the pane's focusing deleted.
      focus: () => fake.element.focus(),
      dispose: () => {
        fake.disposed += 1;
      },
    };
  },
}));

const sent = vi.hoisted(() => [] as { run: number; text: string }[]);
const emitters = vi.hoisted(() => [] as ((next: RunReadout[]) => void)[]);
/* What the harness answers a keystroke with, when it answers with a refusal —
   the shape `typed_at_run` rejects in, which is a string and not an `Error`. */
const refuses = vi.hoisted(() => ({ with: null as string | null }));

vi.mock("../src/terminal/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/terminal/runs")>()),
  typedAtRun: vi.fn(async (run: number, text: string) => {
    if (refuses.with !== null) throw refuses.with;
    sent.push({ run, text });
  }),
  loadRunReadouts: vi.fn(async () => [] as RunReadout[]),
  watchRunReadouts: vi.fn(async (onNext: (next: RunReadout[]) => void) => {
    emitters.push(onNext);
    return () => {
      emitters.length = 0;
    };
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function a(run: number, over: boolean): RunReadout {
  return {
    run,
    held: 4096,
    dropped: 0,
    through: 4096,
    end: 4096,
    truncated: false,
    desynced: false,
    over,
    code: over ? 130 : null,
    monitored: false,
    silence: over ? { kind: "nothing" } : { kind: "quiet", silentForMs: 1_000 },
    signal: null,
    ticket: 50,
    folder: "/work/perseverance",
    kind: "work",
    ending: over ? "exited" : "live",
    // Stamps and not ages, so a row's words hold still between readouts.
    opened: 1_785_888_000,
    spoke: 1_785_888_000,
  };
}

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function boot(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<App />);
  });
}

function readouts(next: RunReadout[]): Promise<void> {
  return act(async () => {
    for (const emit of [...emitters]) emit(next);
  });
}

/** The terminal that is on the pane, found the way an operator finds it: by sight. */
function onThePane(): Fake {
  const pane = document.querySelector("section[aria-label='Terminal']");
  const found = made.find((fake) => pane?.contains(fake.element) === true);
  if (found === undefined) throw new Error("no terminal is on the pane");
  return found;
}

function types(text: string): Promise<void> {
  const fake = onThePane();
  return act(async () => {
    for (const handler of [...fake.handlers]) handler(text);
  });
}

function chrome(): string {
  return document.querySelector("section[aria-label='Terminal']")?.textContent ?? "";
}

afterEach(() => {
  if (mounted !== null) {
    const held = mounted;
    act(() => held.root.unmount());
    held.host.remove();
    mounted = null;
  }
  monitor(null);
  refuses.with = null;
  forgetSpills();
  made.length = 0;
  sent.length = 0;
  emitters.length = 0;
  document.body.replaceChildren();
});

describe("the caret, parked", () => {
  /* The other way a keystroke reaches no child. A research run runs unattended
     and the harness refuses its keys with a sentence — the pane binds one like
     every other run, so it is a run somebody can type at, and a rejection nobody
     caught would be that sentence going into an unhandled promise instead of in
     front of the person who typed. */
  it("keeps what was typed at a run the harness refused, under the harness's own words", async () => {
    const refusal = "a research run runs unattended, so nothing can be typed at it";
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    refuses.with = refusal;

    await types("are you stuck");

    expect(sent).toEqual([]);
    expect(spilledAtRun(7)?.text).toBe("are you stuck");
    // The harness's reason, and not the ended-child reading, which is untrue of
    // a research run that is still going.
    expect(chrome()).toContain(refusal);
    expect(chrome()).not.toContain(SPILL_READING);
    expect(chrome()).toContain("are you stuck");
  });

  it("types at the child while the run is live", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));

    await types("ls");

    expect(sent).toEqual([{ run: 7, text: "ls" }]);
    expect(spilledAtRun(7)).toBe(null);
  });

  it("leaves the caret, the pane and the node exactly where they were", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    const before = onThePane();

    await readouts([a(7, true)]);

    // The caret has not moved, and no automatic path has emptied the pane.
    expect(readUi().monitored).toBe(7);
    // The same node, still in the pane, still holding every byte it was written:
    // `Terminals.forget` disposes, and nothing here has disposed anything.
    expect(onThePane()).toBe(before);
    expect(before.disposed).toBe(0);
    // The row is still there, and it reads as the ending Rust derived.
    expect(chrome()).toContain("this run has ended (130)");
  });

  it("does not hop to a live run that is sitting in the same readouts", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));

    await readouts([a(7, true), a(8, false)]);

    // Rebinding is theft: the next keystroke would land in run 8's conversation,
    // typed by somebody who never asked to be there.
    expect(readUi().monitored).toBe(7);
  });

  it("spills what is typed after the child stops, and sends none of it", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    await readouts([a(7, true)]);

    await types("rerun the tests");

    expect(sent).toEqual([]);
    expect(spilledAtRun(7)?.text).toBe("rerun the tests");
    expect(chrome()).toContain(SPILL_READING);
    expect(chrome()).toContain("rerun the tests");
  });

  it("reads the readouts at the keystroke rather than at the effect", async () => {
    /*
     * The handler is installed once per bound run and deliberately survives a
     * poll landing — re-registering `onData` several times a second would be the
     * keyboard's one seam being torn down and rebuilt under the operator. So the
     * death has to reach a handler that was made before it, and the only way it
     * can is by the handler reading the readouts when the key is pressed.
     */
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    const handlers = onThePane().handlers.length;

    await readouts([a(7, true)]);

    expect(onThePane().handlers.length).toBe(handlers);
    await types("hello");
    expect(sent).toEqual([]);
    expect(spilledAtRun(7)?.text).toBe("hello");
  });

  it("still offers the press, which stays the only way out of a dead run", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    await readouts([a(7, true)]);

    await types("never sent");
    const press = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "End this run",
    );

    expect(press).toBeDefined();
    expect(readUi().monitored).toBe(7);

    const terminal = onThePane();
    await act(async () => {
      press?.click();
    });

    // A person deciding they are finished reading, which is the one thing that
    // moves the caret off a run — and what the run held goes with it.
    expect(readUi().monitored).toBe(null);
    expect(terminal.disposed).toBe(1);
    expect(spilledAtRun(7)).toBe(null);
  });

  it("raises no modal and no toast over a run that has died under the caret", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    await readouts([a(7, true)]);
    await types("wait what");

    expect(document.querySelector("dialog")).toBe(null);
    expect(document.querySelector("[role='dialog']")).toBe(null);
    expect(document.querySelector("[role='alertdialog']")).toBe(null);
    expect(document.querySelector("[role='alert']")).toBe(null);
    expect(document.querySelector("[role='status']")).toBe(null);
  });
});

describe("the spill register", () => {
  it("keeps what was typed, verbatim and in order, and counts it", () => {
    spillAtRun(7, "git ");
    spillAtRun(7, "status");

    expect(spilledAtRun(7)).toEqual({
      text: "git status",
      characters: 10,
      elided: false,
      reason: null,
    });
  });

  it("keeps the most recent characters and no more, however long the typing runs", () => {
    for (let press = 0; press < KEPT_CHARACTERS; press += 1) spillAtRun(7, "old ");
    spillAtRun(7, "the recent end");

    const spill = spilledAtRun(7);
    expect(spill?.characters).toBe(KEPT_CHARACTERS);
    expect(spill?.text).toHaveLength(KEPT_CHARACTERS);
    expect(spill?.text.endsWith("the recent end")).toBe(true);
    expect(spill?.elided).toBe(true);
  });

  it("bounds a single long paste, which arrives whole because it has no newline in it", () => {
    const pasted = "x".repeat(KEPT_CHARACTERS * 4);
    spillAtRun(7, pasted);

    expect(spilledAtRun(7)?.characters).toBe(KEPT_CHARACTERS);
    expect(spilledAtRun(7)?.elided).toBe(true);
  });

  it("stays elided once it has been, even if nothing further is dropped", () => {
    spillAtRun(7, "y".repeat(KEPT_CHARACTERS + 1));
    spillAtRun(7, "z");

    expect(spilledAtRun(7)?.elided).toBe(true);
    expect(spilledAtRun(7)?.characters).toBe(KEPT_CHARACTERS);
  });

  it("prints a bounded sentence, and says the words are the most recent rather than all of them", () => {
    spillAtRun(7, "q".repeat(KEPT_CHARACTERS * 2));

    const sentence = spillSentence(spilledAtRun(7));
    expect(sentence).toContain(`${KEPT_CHARACTERS} characters kept, the most recent`);
    expect(sentence).toContain("…");
    expect(sentence?.length).toBeLessThan(SPILL_READING.length + KEPT_CHARACTERS + 64);
  });

  it("keeps a chunk with no control byte in it, and drops one with any", () => {
    // An arrow key is `ESC [ A`, and a register that kept its printable
    // remainder would put `[A` into a sentence nobody typed.
    spillAtRun(7, "[A");
    spillAtRun(7, "");
    spillAtRun(7, "one\nline\n");
    expect(spilledAtRun(7)).toBe(null);

    spillAtRun(7, "still here");
    expect(spilledAtRun(7)?.text).toBe("still here");
  });

  it("counts by code point, so a character outside the basic plane is one thing", () => {
    spillAtRun(7, "ship 🚀");

    expect(spilledAtRun(7)?.characters).toBe(6);
  });

  it("holds one register per aimed-at run, so no run is credited another's words", () => {
    spillAtRun(7, "for seven");
    spillAtRun(8, "for eight");

    expect(spilledAtRun(7)?.text).toBe("for seven");
    expect(spilledAtRun(8)?.text).toBe("for eight");
  });

  it("says what it holds as an observation, and carries no verdict about the child", () => {
    spillAtRun(7, "x");
    const one = spillSentence(spilledAtRun(7));
    spillAtRun(7, "yz");
    const three = spillSentence(spilledAtRun(7));

    expect(one).toContain("1 character —");
    expect(three).toContain("3 characters —");
    expect(three).toContain("xyz");
    for (const verdict of ["hung", "stuck", "dead", "frozen", "fault"]) {
      expect(three?.toLowerCase()).not.toContain(verdict);
    }
  });

  it("says nothing at all about a run that has caught nothing", () => {
    expect(spillSentence(spilledAtRun(7))).toBe(null);
  });
});

/** A press, found the way an operator finds one: by the words on it. */
function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (found) => found.textContent === label,
  );
}

describe("the run a register is offered to", () => {
  const work = (run: number, over: boolean, folder: string | null): RunReadout => ({
    ...a(run, over),
    folder,
  });

  it("is the live work run sharing the parked run's folder", () => {
    const readouts = [work(7, true, "/work/one"), work(8, false, "/work/one")];

    expect(offeredTo(readouts, 7)?.run).toBe(8);
  });

  it("is not a live work run in another folder, whatever its number", () => {
    // An issue number means nothing across two repositories, and a sentence
    // handed over this join would land in an agent the operator never opened.
    const readouts = [work(7, true, "/work/one"), work(8, false, "/work/two")];

    expect(offeredTo(readouts, 7)).toBe(null);
  });

  it("is not a run that has stopped, and not a run that is not work", () => {
    const stopped = work(8, true, "/work/one");
    const composing: RunReadout = { ...work(9, false, "/work/one"), kind: "compose" };

    expect(offeredTo([work(7, true, "/work/one"), stopped, composing], 7)).toBe(null);
  });

  it("is never the parked run itself, even while it is the only work run there", () => {
    expect(offeredTo([work(7, false, "/work/one")], 7)).toBe(null);
  });

  it("is nothing at all for a parked run the window knows no folder for", () => {
    const readouts = [work(7, true, null), work(8, false, "/work/one")];

    expect(offeredTo(readouts, 7)).toBe(null);
  });

  it("is nothing at all for a run that is in no readout", () => {
    expect(offeredTo([work(8, false, "/work/one")], 7)).toBe(null);
  });
});

describe("the register, offered", () => {
  const both = (over: boolean): RunReadout[] => [
    a(7, over),
    { ...a(8, false), ticket: 123 },
  ];

  it("sends what was caught to the work run, and moves nothing else", async () => {
    await boot();
    await readouts(both(false));
    /* Warm and not merely monitored, which is the only state the claim is about:
       `monitor` puts the keys down on its way, so a press asserted from there
       would be comparing cold to cold. The caret is on #7 when its child dies,
       parks there, and has to still be there when the offer has been made. */
    act(() => {
      monitor(7);
      setKeyed(true);
    });
    await readouts(both(true));
    expect(keyedRun(readUi())).toBe(7);
    await types("rerun the tests");

    const press = button("Send to #123 work");
    expect(press).toBeDefined();
    await act(async () => {
      press?.click();
    });

    expect(sent).toEqual([{ run: 8, text: "rerun the tests" }]);
    // The words are recovered, so the register has nothing left to hold.
    expect(spilledAtRun(7)).toBe(null);
    // And the caret is exactly where the operator left it: a hand-off of text
    // is not a decision about where the next keystroke goes.
    expect(readUi().monitored).toBe(7);
    expect(keyedRun(readUi())).toBe(7);
    expect(onThePane().disposed).toBe(0);
  });

  it("offers nothing while no work run is going in the folder, and still shows the words", async () => {
    await boot();
    await readouts([a(7, false)]);
    act(() => monitor(7));
    await readouts([a(7, true)]);

    await types("nowhere to go");

    expect(button("Send to #50 work")).toBeUndefined();
    expect(chrome()).toContain(NOWHERE_TO_OFFER);
    // Verbatim, counted and held — the absent press changes none of that.
    expect(chrome()).toContain("nowhere to go");
    expect(chrome()).toContain(SPILL_READING);
    expect(spilledAtRun(7)?.characters).toBe(13);
  });

  it("says the folder was never told, and never that the folder came out empty", async () => {
    // The two absences of `offeredTo` are two facts about the world, and the
    // node panel's rule holds here: a fact the harness was never told is
    // form-level distinct from a count that is genuinely nought. There is a live
    // work run one line away — what is missing is the join, not the run.
    const nameless = (over: boolean): RunReadout[] => [
      { ...a(7, over), folder: null, ticket: null },
      { ...a(8, false), ticket: 123 },
    ];

    await boot();
    await readouts(nameless(false));
    act(() => monitor(7));
    await readouts(nameless(true));

    await types("staked nowhere");

    expect(button("Send to #123 work")).toBeUndefined();
    expect(chrome()).toContain(NO_FOLDER_TO_JOIN);
    expect(chrome()).not.toContain(NOWHERE_TO_OFFER);
    // Verbatim, counted and held — which absence it is changes none of that.
    expect(chrome()).toContain("staked nowhere");
    expect(spilledAtRun(7)?.characters).toBe(14);
  });

  it("offers nothing at all until something has been caught", async () => {
    await boot();
    await readouts(both(false));
    act(() => monitor(7));

    await readouts(both(true));

    expect(button("Send to #123 work")).toBeUndefined();
    expect(chrome()).not.toContain(NOWHERE_TO_OFFER);
  });

  it("keeps the words when the send fails, because a promise of recovery is one", async () => {
    const typed = vi.mocked((await import("../src/terminal/runs")).typedAtRun);
    typed.mockRejectedValueOnce(new Error("the far side is gone"));

    await boot();
    await readouts(both(false));
    act(() => monitor(7));
    await readouts(both(true));
    await types("still recoverable");

    await act(async () => {
      button("Send to #123 work")?.click();
    });

    expect(spilledAtRun(7)?.text).toBe("still recoverable");
    expect(chrome()).toContain("still recoverable");
  });
});
