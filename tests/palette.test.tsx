// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
/* `Palette.jsx` and not `Palette`: the filesystem is case-insensitive, and the
   extension is what pins the import to the component. */
import { PICK_AGENT, Palette } from "../src/keys/Palette.jsx";
import { ENTRIES, currentState, labelFor, type ActionId, type Entry } from "../src/keys/router";
import { dismiss, monitor, raise } from "../src/stores/ui";

/**
 * The palette, and the one claim that makes it worth having: it is *generated*.
 *
 * The assertions here are the ones an operator would notice going wrong — every
 * chord this window binds is listed with the words the table itself uses, a row
 * added elsewhere shows up with this component untouched, pressing a row runs
 * the app's own handler rather than a second copy of the verb, and nothing it
 * has to say is hidden behind a hover.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

interface Painted {
  host: HTMLElement;
  ran: ActionId[];
  /** The one dismiss the palette makes itself: away, keyboard left where it is. */
  handedOff: number;
}

async function paint(
  options: { table?: readonly Entry[]; onPickAgent?: () => string | null } = {},
): Promise<Painted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  const painted: Painted = { host, ran: [], handedOff: 0 };
  await act(async () => {
    root.render(
      <Palette
        table={options.table}
        onPickAgent={options.onPickAgent ?? (() => null)}
        onRun={(id) => painted.ran.push(id)}
        onHandOff={() => {
          painted.handedOff += 1;
        }}
      />,
    );
  });
  return painted;
}

const rowFor = (host: HTMLElement, id: string) => host.querySelector(`[data-row="${id}"]`);

afterEach(async () => {
  if (mounted !== null) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  dismiss();
  monitor(null);
});

describe("the command palette", () => {
  it("lists every binding in the table with its label and its verb", async () => {
    const { host } = await paint();
    const state = currentState();
    // The dismiss rows are the `Esc` readout's, not the list's — see below.
    for (const entry of ENTRIES.filter((row) => row.dismisses === undefined)) {
      const row = rowFor(host, entry.id);
      expect(row, entry.id).not.toBeNull();
      expect(row?.textContent, entry.id).toContain(entry.verb);
      expect(row?.textContent, entry.id).toContain(labelFor(entry, state));
    }
  });

  it("prints a row this file has never heard of", async () => {
    /*
     * The whole point of generating: a ticket that adds a chord adds a row to
     * the table and nothing else, and the palette prints it. A hand-kept list
     * would need this file edited, which is the drift the shape rules out.
     */
    const invented: Entry = {
      id: "home",
      chords: () => [{ key: "j", meta: false, ctrl: true, alt: false, shift: false }],
      verb: "do the thing a later ticket invents",
      when: () => true,
    };
    const { host } = await paint({ table: [invented] });
    expect(host.textContent).toContain("do the thing a later ticket invents");
    expect(host.textContent).toContain(labelFor(invented, currentState()));
  });

  it("presses the row through the app's one handler", async () => {
    const painted = await paint();
    const button = rowFor(painted.host, "cross")?.querySelector("button");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(painted.ran).toEqual(["cross"]);
  });

  it("prints a row the table would not claim rather than running it", async () => {
    // The dial's keys belong to the dial while it has the keyboard; a palette
    // that ran them anyway would be disagreeing with the table it came from.
    const painted = await paint();
    const row = rowFor(painted.host, "dial-wider");
    const button = row?.querySelector("button");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(painted.ran).toEqual([]);
  });

  it("prints no Escape row: Esc is the readout line and never a binding", async () => {
    /*
     * ADR 0025's central claim, asserted on the surface that teaches it. The
     * dismiss rows are already represented by the `Esc` readout, which is
     * computed from them; offered as pressable rows too they would be two rival
     * static answers for the key whose whole point is that it has no static one.
     */
    await act(async () => {
      monitor(4);
      raise("palette");
    });
    const { host } = await paint();
    for (const entry of ENTRIES.filter((row) => row.dismisses !== undefined)) {
      expect(rowFor(host, entry.id), entry.id).toBeNull();
    }
    const keys = [...host.querySelectorAll("[data-row] kbd")].map((key) => key.textContent);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("Escape");
  });

  it("prints the hold as a hold, because a click cannot hold a key", async () => {
    const { host } = await paint();
    expect(rowFor(host, "peek")?.hasAttribute("data-hold")).toBe(true);
    expect(rowFor(host, "peek")?.querySelector("button")).toBeNull();
  });

  it("gives Esc a line of its own, as a readout and not a binding", async () => {
    await act(async () => {
      monitor(4);
      raise("palette");
    });
    const { host } = await paint();
    const line = host.querySelector("[data-esc-line]");
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("dismisses the command palette");
    expect(line?.textContent).toContain("readout, not a binding");
  });

  it("focuses the one picker rather than opening a menu of its own", async () => {
    const painted = await paint({ onPickAgent: () => null });
    // No second control for *which agent* anywhere in it: the row sends the
    // keyboard to the picker the crossing rail already draws.
    expect(painted.host.querySelector("select")).toBeNull();
    await act(async () => {
      rowFor(painted.host, "agent")
        ?.querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    /* Away by the hand-off and never by the shell's own dismiss: that one also
       *places* the keyboard, which for this row means off the picker it was
       just put on. `tests/keys-shell.test.tsx` asserts where the keyboard
       actually lands; this is the component's half of the same contract. */
    expect(painted.handedOff).toBe(1);
  });

  it("says why when there is no picker to focus, rather than nothing at all", async () => {
    const painted = await paint({ onPickAgent: () => "no picker is on screen" });
    await act(async () => {
      rowFor(painted.host, "agent")
        ?.querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(painted.host.querySelector("[data-refused]")?.textContent).toBe(
      "no picker is on screen",
    );
    // And it stays up: the palette is where the sentence is being read.
    expect(painted.handedOff).toBe(0);
  });

  it("filters by what a row says, and by the keys it is pressed with", async () => {
    const { host } = await paint();
    const field = host.querySelector("input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(field, "home");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rowFor(host, "home")).not.toBeNull();
    expect(rowFor(host, "cross")).toBeNull();
  });

  it("hides nothing behind a hover", async () => {
    // Everything it has to say is text on the surface: a `title` is a sentence a
    // screen reader and a keyboard cannot have.
    const { host } = await paint({ onPickAgent: () => "why not" });
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("binds no key of its own", async () => {
    /* The structural claim, from the outside: the router is the only listener,
       so a key pressed inside the palette is not intercepted here. The source
       check in `tests/no-loose-keys.test.ts` is the other half. */
    const { host } = await paint();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      host.querySelector("input")?.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(false);
  });

  it("puts the keyboard in the filter when it opens", async () => {
    const { host } = await paint();
    expect(document.activeElement).toBe(host.querySelector("input"));
  });

  it("lists the agent row with the picker's own sentence", async () => {
    const { host } = await paint();
    expect(rowFor(host, "agent")?.textContent).toContain(PICK_AGENT);
  });
});
