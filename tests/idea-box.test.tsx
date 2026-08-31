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
import { CHART_LABEL, IDEA_LABEL, NO_IDEA, boxAt } from "../src/chrome/idea";
import {
  CHECKING_LABEL,
  NO_ADAPTER,
  NO_FOLDER_OPEN,
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
import { monitor } from "../src/stores/ui";
import { CUSTOM_BADGE, charactersLabel } from "../src/terminal/PromptBlock";
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

const readout = (adapters: readonly AdapterReading[]): FolderReadout =>
  readoutFrom({ adapters, harvest: { kind: "harvested" } }, "/work/repo");

const harvesting = (): FolderReadout =>
  readoutFrom({ adapters: [CLAUDE], harvest: { kind: "harvesting" } }, "/work/repo");

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

function paint(props: Partial<Parameters<typeof IdeaBox>[0]> = {}): HTMLElement {
  return mount(<IdeaBox folder="/work/repo" environment={readout([CLAUDE])} {...props} />);
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
    expect(boxAt({ folder: null, environment: readout([CLAUDE]), idea, press: { kind: "idle" } }))
      .toMatchObject({ fill: "recessed", condition: NO_FOLDER_OPEN });
    expect(
      boxAt({ folder: "/work/repo", environment: null, idea, press: { kind: "idle" } }),
    ).toMatchObject({ fill: "recessed", condition: STILL_READING });
    expect(
      boxAt({ folder: "/work/repo", environment: harvesting(), idea, press: { kind: "idle" } }),
    ).toMatchObject({ fill: "recessed", condition: STILL_READING });
    expect(
      boxAt({ folder: "/work/repo", environment: readout([]), idea, press: { kind: "idle" } }),
    ).toMatchObject({ fill: "recessed", condition: NO_ADAPTER });
    // Whitespace is not an idea.
    expect(
      boxAt({
        folder: "/work/repo",
        environment: readout([CLAUDE]),
        idea: "  \n ",
        press: { kind: "idle" },
      }),
    ).toMatchObject({ fill: "recessed", condition: NO_IDEA });
    expect(
      boxAt({ folder: "/work/repo", environment: readout([CLAUDE]), idea, press: { kind: "idle" } }),
    ).toMatchObject({ fill: "filled", condition: null });
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

  it("keeps the prompt and binds the pane to the run it started", async () => {
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
    // Through the one collapsed block, badge and count and all.
    expect(host.textContent).toContain(CUSTOM_BADGE);
    expect(host.textContent).toContain(charactersLabel(8));
    expect(host.querySelector("details")).not.toBeNull();
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

describe("where the box lives", () => {
  it("is under the copy that pre-absolves a run leaving no map behind", () => {
    const host = mount(
      <MapList
        view={read()}
        selected={null}
        onOpen={() => {}}
        ideaBox={<IdeaBox folder="/work/repo" environment={readout([CLAUDE])} />}
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
        ideaBox={<IdeaBox folder="/work/repo" environment={readout([CLAUDE])} />}
      />,
    );

    expect(host.textContent).toContain(NOT_READ_HEADLINE);
    expect(host.textContent).not.toContain(CHART_LABEL);
    expect(host.querySelector("textarea")).toBeNull();
  });
});
