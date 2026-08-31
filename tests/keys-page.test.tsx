// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
/* `KeysPage.jsx` and not `KeysPage`: the filesystem is case-insensitive, and the
   extension is what pins the import to the component. */
import { KeysPage } from "../src/keys/KeysPage.jsx";
import { ENTRIES, currentState, labelFor, type Entry } from "../src/keys/router";
import { dismiss, monitor, raise } from "../src/stores/ui";

/**
 * The keys page, and the claims that make it worth having over a corner.
 *
 * It is *generated* — every row an operator reads came out of the routing table,
 * so a chord added elsewhere is on it with this component untouched — and it is
 * a *reading* surface: nothing on it presses anything, nothing on it is hidden
 * behind a hover, and it binds no key of its own.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function paint(table?: readonly Entry[]): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<KeysPage table={table} />);
  });
  return host;
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

describe("the keys page", () => {
  it("lists every binding in the table with its label and its verb", async () => {
    const host = await paint();
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
     * the table and nothing else, and both surfaces print it. A hand-kept list
     * here would be a second account of the keyboard, and the one an operator
     * came to this page to read would be the one that went stale.
     */
    const invented: Entry = {
      id: "home",
      chords: () => [{ key: "j", meta: false, ctrl: true, alt: false, shift: false }],
      verb: "do the thing a later ticket invents",
      when: () => true,
    };
    const host = await paint([invented]);
    expect(host.textContent).toContain("do the thing a later ticket invents");
    expect(host.textContent).toContain(labelFor(invented, currentState()));
  });

  it("gives Esc a line of its own, as a readout and not a binding", async () => {
    await act(async () => {
      monitor(4);
      raise("keys");
    });
    const host = await paint();
    const line = host.querySelector("[data-esc-line]");
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("dismisses the keys page");
    expect(line?.textContent).toContain("readout, not a binding");
  });

  it("prints no Escape row: Esc is the readout line and never a binding", async () => {
    /*
     * ADR 0025's central claim, asserted on the surface that teaches it. The
     * dismiss rows are already represented by the `Esc` readout, which is
     * computed from them; printed as rows too they would be two rival static
     * answers for the key whose whole point is that it has no static answer.
     */
    await act(async () => {
      monitor(4);
      raise("keys");
    });
    const host = await paint();
    for (const entry of ENTRIES.filter((row) => row.dismisses !== undefined)) {
      expect(rowFor(host, entry.id), entry.id).toBeNull();
    }
    const keys = [...host.querySelectorAll("[data-row] kbd")].map((key) => key.textContent);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("Escape");
  });

  it("prints the hold as a hold, because a page cannot be held", async () => {
    const host = await paint();
    const peek = rowFor(host, "peek");
    expect(peek?.hasAttribute("data-hold")).toBe(true);
    expect(peek?.textContent).toContain("hold it");
  });

  it("presses nothing: it is the keyboard read out, not a second way to run it", async () => {
    // The palette is where a row is activated. A page that also ran verbs would
    // be a third implementation of every one of them.
    const host = await paint();
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.querySelectorAll("input")).toHaveLength(0);
  });

  it("hides nothing behind a hover", async () => {
    // Everything it has to say is text on the surface: a `title` is a sentence a
    // screen reader and a keyboard cannot have — and this page is *only* words.
    const host = await paint();
    expect(host.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("binds no key of its own", async () => {
    /* The structural claim, from the outside: the router is the only listener,
       so a key pressed on the page is not intercepted here. The source check in
       `tests/no-loose-keys.test.ts` is the other half. */
    const host = await paint();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      host.querySelector("[data-keys]")?.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(false);
  });

  it("takes the keyboard when it opens", async () => {
    // Otherwise the keys would still be behind it, on whatever had them — and
    // the surface `Esc` dismisses would be one `Esc` could not reach.
    const host = await paint();
    expect(document.activeElement).toBe(host.querySelector("[data-keys]"));
  });
});
