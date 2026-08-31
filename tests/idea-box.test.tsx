// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/*
 * `IdeaBox.jsx` and not `IdeaBox`, for the reason `Sockets.jsx` carries its
 * extension: the derivation beside it is `idea.ts`, and an extensionless
 * specifier on a case-insensitive filesystem is a coin toss between the two.
 */
import { IdeaBox } from "../src/chrome/IdeaBox.jsx";
import {
  ALREADY_CHARTING,
  CHART_LABEL,
  IDEA_LABEL,
  NO_IDEA,
  boxAt,
} from "../src/chrome/idea";
import {
  CHECKING_LABEL,
  NO_ADAPTER,
  NO_FOLDER_OPEN,
  RUN_IS_UP,
  STILL_READING,
} from "../src/chrome/sockets";
import { NO_HARNESS, type Started } from "../src/chrome/started";
import {
  readoutFrom,
  type AdapterReading,
  type FolderReadout,
} from "../src/environment/folder";
import { MapList } from "../src/maps/MapList";
import {
  NOT_READ_HEADLINE,
  NO_MAP_COPY,
  NO_MAP_HEADLINE,
  nothingReadYet,
  type MapsView,
} from "../src/maps/maps";
import { readUi } from "../src/stores/ui";
import type { RunReadout } from "../src/terminal/runs";
import { monitor } from "../src/stores/ui";
import { forgetPrompts, promptFor } from "../src/terminal/prompts";

/**
 * The idea box, derived and mounted.
 *
 * What is pinned here: that the box lives in the *no map in this repository*
 * absence and nowhere else — never in the *nobody has looked yet* one, and
 * never as a fifth socket on the rail; that every condition it recesses for is
 * text on screen rather than an attribute a hover reveals; that a successful
 * press invokes `start_charting` and **nothing else**, because a map the run
 * creates arrives on an ordinary poll and there is no registration step; and
 * that a browser with no Rust behind it refuses rather than inventing a run.
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

const CODEX: AdapterReading = {
  id: "codex",
  resolution: { kind: "resolved", name: "codex", program: "/usr/bin/codex", from: "candidate" },
  probes: [],
};

const readout = (adapters: readonly AdapterReading[]): FolderReadout =>
  readoutFrom({ adapters, harvest: { kind: "harvested" } }, "/work/repo");

const harvesting = (): FolderReadout =>
  readoutFrom({ adapters: [CLAUDE], harvest: { kind: "harvesting" } }, "/work/repo");

/*
 * A run as a poll reports it. The box reads two fields out of a readout — which
 * run it is and whether it is over — and is handed the rest because the pane is
 * handed the rest.
 */
const reading = (run: number, finished: boolean): RunReadout => ({
  run,
  held: 0,
  dropped: 0,
  through: 0,
  end: 0,
  truncated: false,
  desynced: false,
  ending: finished ? "exited" : "live",
  ticket: null,
  folder: null,
  kind: null,
  over: finished,
  code: finished ? 0 : null,
  monitored: false,
  silence: { kind: "nothing" },
  signal: null,
  kind: null,
  // Stamps and not ages, so a row's words hold still between readouts. The box
  // reads neither; they are here because a readout carries them.
  opened: 1_785_888_000,
  spoke: 1_785_888_000,
});

const running = (run: number): RunReadout => reading(run, false);
const finished = (run: number): RunReadout => reading(run, true);

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

function mount(node: React.ReactNode): HTMLElement {
  const host = mounted?.host ?? document.createElement("div");
  if (mounted === null) {
    document.body.append(host);
    mounted = { root: createRoot(host), host };
  }
  const root = mounted.root;
  act(() => root.render(node));
  return host;
}

/*
 * Keyed to the folder, because `App.tsx` keys it to the folder: the press is a
 * fact about the folder it was made in, and re-rendering this element at a new
 * folder has to be a new box rather than the old one holding the old press.
 * Painting the same folder twice — a poll landing — keeps the instance.
 */
function paint(props: Partial<Parameters<typeof IdeaBox>[0]> = {}): HTMLElement {
  const all = {
    folder: "/work/repo" as string | null,
    environment: readout([CLAUDE]),
    readouts: [] as readonly RunReadout[],
    ...props,
  };
  return mount(<IdeaBox key={all.folder ?? "none"} {...all} />);
}

const field = (host: HTMLElement): HTMLTextAreaElement => {
  const found = host.querySelector("textarea");
  if (found === null) throw new Error("no idea field in the document");
  return found;
};

const button = (host: HTMLElement): HTMLButtonElement => {
  const found = host.querySelector("button");
  if (found === null) throw new Error("no button in the document");
  return found;
};

/* React's own setter is what a controlled `<textarea>` listens to; assigning
   `.value` directly is swallowed by the value tracker. */
function type(host: HTMLElement, text: string): void {
  const area = field(host);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const read = (): MapsView => ({
  ...nothingReadYet(1),
  provenance: { source: "cache", outcome: { kind: "ok" }, fetchedAt: null },
});

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  forgetPrompts();
  monitor(null);
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

describe("what recesses the box", () => {
  it("names the condition and only the first that is true", () => {
    const idea = "chart the ingest path";
    const idle = { readouts: [], idea, press: { kind: "idle" } } as const;
    expect(
      boxAt({ folder: null, environment: readout([CLAUDE]), ...idle }),
    ).toMatchObject({ fill: "recessed", condition: NO_FOLDER_OPEN });
    expect(boxAt({ folder: "/work/repo", environment: null, ...idle })).toMatchObject({
      fill: "recessed",
      condition: STILL_READING,
    });
    expect(boxAt({ folder: "/work/repo", environment: harvesting(), ...idle })).toMatchObject({
      fill: "recessed",
      condition: STILL_READING,
    });
    expect(boxAt({ folder: "/work/repo", environment: readout([]), ...idle })).toMatchObject({
      fill: "recessed",
      condition: NO_ADAPTER,
    });
    // Whitespace is not an idea.
    expect(
      boxAt({ ...idle, folder: "/work/repo", environment: readout([CLAUDE]), idea: "  \n " }),
    ).toMatchObject({ fill: "recessed", condition: NO_IDEA });
    expect(boxAt({ folder: "/work/repo", environment: readout([CLAUDE]), ...idle })).toMatchObject({
      fill: "filled",
      condition: null,
    });
  });

  it("holds the spawned press while its run is live, and lets it go once it is over", () => {
    const started = {
      folder: "/work/repo",
      environment: readout([CLAUDE]),
      idea: "chart the ingest path",
      press: { kind: "spawned", run: 4 },
    } as const;

    /* Before the first poll that names it, a spawned run is live and not over:
       reading the gap as *over* would re-arm the box in the seconds right after
       the press, which is where a second session is likeliest. */
    expect(boxAt({ ...started, readouts: [] })).toMatchObject({
      fill: "recessed",
      condition: ALREADY_CHARTING,
    });
    expect(boxAt({ ...started, readouts: [running(4)] })).toMatchObject({
      fill: "recessed",
      condition: ALREADY_CHARTING,
    });
    // Some other run ending says nothing about this one.
    expect(boxAt({ ...started, readouts: [finished(9), running(4)] })).toMatchObject({
      fill: "recessed",
      condition: ALREADY_CHARTING,
    });
    /* And the run is over. Nothing else retires this press — a charting session
       that left no map behind is never unmounted by a poll — so the sentence
       would otherwise outlive the process it describes. */
    expect(boxAt({ ...started, readouts: [finished(4)] })).toMatchObject({
      fill: "filled",
      condition: null,
    });
  });

  it("stays in its box, printing the condition as text and never as a tooltip", () => {
    const host = paint({ environment: readout([]) });

    expect(host.textContent).toContain(CHART_LABEL);
    expect(host.textContent).toContain(IDEA_LABEL);
    expect(host.textContent).toContain(NO_ADAPTER);
    expect(button(host).getAttribute("aria-disabled")).toBe("true");
    // Recessed is ink: the control is still there and still reachable.
    expect(button(host).hasAttribute("disabled")).toBe(false);
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("takes no press while it is recessed", async () => {
    const host = paint();

    await act(async () => {
      button(host).click();
    });

    expect(host.textContent).toContain(NO_IDEA);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a press", () => {
  it("goes out with the folder, the idea and the adapter, and invokes nothing else", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 4,
      prompt: { text: "chart it", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();
    type(host, "  chart the ingest path  ");

    await act(async () => {
      button(host).click();
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("start_charting", {
      folder: "/work/repo",
      idea: "chart the ingest path",
      adapter: "claude",
    });
    /* No registration and no refresh. A map the run creates carries the map
       label and arrives on an ordinary poll; a second command here would be a
       second thing entitled to say what is in this folder. */
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_charting"]);
  });

  it("reads checking while it is in flight, and a second press buys nothing", async () => {
    let answer: (started: Started) => void = () => {};
    invoke.mockReturnValue(
      new Promise<Started>((resolve) => {
        answer = resolve;
      }),
    );
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    expect(button(host).textContent).toContain(CHECKING_LABEL);
    expect(button(host).getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      button(host).click();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({
        kind: "spawned",
        run: 4,
        prompt: { text: "chart it", characters: 8, origin: "custom" },
      });
    });
  });

  it("records the prompt for the pane and renders no second block of its own", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 4,
      prompt: { text: "chart it", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    expect(promptFor(4)).toEqual({ text: "chart it", characters: 8, origin: "custom" });
    expect(readUi().monitored).toBe(4);
    /* The recorded prompt and the monitored run are the whole of what puts the
       collapsed block on screen — the pane renders it. A block here would be a
       second account of the text and the count that diagnose a misbehaving
       run. */
    expect(host.querySelector("details")).toBeNull();
  });

  it("recesses once it has started a session, so the folder gets one", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 4,
      prompt: { text: "chart it", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    /* The box stays mounted until a poll returns the map the run is writing,
       which is minutes away. A repeatable press would be a second charting
       session in the same folder — a second run creating the labels and
       opening a second map issue. */
    expect(host.textContent).toContain(ALREADY_CHARTING);
    expect(button(host).getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      button(host).click();
    });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-arms once that session is over, so a run leaving no map is not a dead end", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 4,
      prompt: { text: "chart it", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    // A poll that reports the run still running changes nothing: one live
    // session in a folder is the whole reason the sentence exists.
    paint({ readouts: [running(4)] });
    expect(host.textContent).toContain(ALREADY_CHARTING);
    expect(button(host).getAttribute("aria-disabled")).toBe("true");

    /* The headline outcome: the session judged the work small enough to just do
       it and wrote no map, so no poll ever takes this box away. A box that
       stayed recessed would leave the only route to charting dead, under a
       sentence claiming a session is running after the process exited. */
    paint({ readouts: [finished(4)] });
    expect(host.textContent).not.toContain(ALREADY_CHARTING);
    expect(button(host).getAttribute("aria-disabled")).toBe("false");

    await act(async () => {
      button(host).click();
    });

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves the press behind with the folder, so the next folder gets its own", async () => {
    invoke.mockResolvedValue({
      kind: "spawned",
      run: 4,
      prompt: { text: "chart it", characters: 8, origin: "custom" },
    } satisfies Started);
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    expect(host.textContent).toContain(ALREADY_CHARTING);

    /* Another read-and-empty folder draws its box at the same position in the
       list, so an unkeyed element would hand it this press: a folder with
       nothing running, printing *already running* and refusing the only press
       that starts a session there. The idea and the pick go with it. */
    const host2 = paint({
      folder: "/work/other",
      environment: readoutFrom(
        { adapters: [CLAUDE], harvest: { kind: "harvested" } },
        "/work/other",
      ),
      readouts: [running(4)],
    });

    expect(host2.textContent).not.toContain(ALREADY_CHARTING);
    expect(field(host2).value).toBe("");
    expect(host2.textContent).toContain(NO_IDEA);

    type(host2, "chart this one");
    expect(button(host2).getAttribute("aria-disabled")).toBe("false");

    await act(async () => {
      button(host2).click();
    });

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("prints a refusal's detail verbatim beside the box", async () => {
    invoke.mockResolvedValue({
      kind: "refused",
      detail: "the folder has moved since it was opened",
      frontier: null,
    } satisfies Started);
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    expect(host.textContent).toContain("the folder has moved since it was opened");
    expect(host.querySelector("details")).toBeNull();
  });

  it("refuses in a browser with no harness rather than faking a spawn", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const host = paint();
    type(host, "chart it");

    await act(async () => {
      button(host).click();
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(host.textContent).toContain(NO_HARNESS);
    expect(readUi().monitored).toBeNull();
  });
});

describe("the box's picker", () => {
  /*
   * The rail's lock, on the box's own picker and read from the same fact.
   *
   * The box recesses for the charting press *it* made, which is a different
   * thing entirely: the run that press started is live on the pane beside a box
   * still drawing a picker, and the folder can be running for a press this box
   * never made. Swapping the adapter under a live run would name an agent that
   * is not the one on the pane — and a changeable select here also takes the
   * palette's agent row, which reaches for the first picker that can be
   * changed, so the keyboard would land on it with no reason printed anywhere.
   */
  it("prints the adapter with the reason while a run is live in the folder", () => {
    const live = { ...running(4), folder: "/work/repo" };
    const host = paint({ environment: readout([CLAUDE, CODEX]), readouts: [live] });

    expect(host.querySelector("select[data-picker]")).toBeNull();
    const printed = host.querySelector("[data-picker]");
    expect(printed?.getAttribute("data-picker-fixed")).toBe(RUN_IS_UP);
    // The reason as text on screen, which is the half a `title` would lose.
    expect(printed?.textContent).toContain(RUN_IS_UP);
  });

  /* And the lock is the run's, not the folder's: once it is over the choice is
     the operator's again. */
  it("offers the choice back once that run is over", () => {
    const done = { ...finished(4), folder: "/work/repo" };
    const host = paint({ environment: readout([CLAUDE, CODEX]), readouts: [done] });

    const select = host.querySelector("select[data-picker]");
    expect(select).not.toBeNull();
    expect(select?.hasAttribute("data-picker-fixed")).toBe(false);
  });
});

describe("where the box lives", () => {
  it("is under the copy that pre-absolves a run leaving no map behind", () => {
    const host = mount(
      <MapList
        view={read()}
        selected={null}
        onOpen={() => {}}
        ideaBox={<IdeaBox folder="/work/repo" environment={readout([CLAUDE])} readouts={[]} />}
      />,
    );
    const absence = host.querySelector<HTMLElement>('[data-state="none"]');
    if (absence === null) throw new Error("no absence block in the document");

    expect(absence.textContent).toContain(NO_MAP_HEADLINE);
    expect(absence.textContent).toContain(NO_MAP_COPY);
    // Before the press, not after a run comes back empty.
    expect(absence.textContent?.indexOf(NO_MAP_COPY)).toBeLessThan(
      absence.textContent?.indexOf(CHART_LABEL) ?? -1,
    );
  });

  it("is not in the absence that means nobody has looked yet", () => {
    const host = mount(
      <MapList
        view={nothingReadYet(1)}
        selected={null}
        onOpen={() => {}}
        ideaBox={<IdeaBox folder="/work/repo" environment={readout([CLAUDE])} readouts={[]} />}
      />,
    );

    expect(host.textContent).toContain(NOT_READ_HEADLINE);
    expect(host.textContent).not.toContain(CHART_LABEL);
    expect(host.querySelector("textarea")).toBeNull();
  });
});
