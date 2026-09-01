// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DROP_REGION_HINT, DropRegion } from "../src/chrome/DropRegion";

/**
 * The body is a drop region, and it is one before anything is dragged.
 *
 * First launch is not a mode: the region establishes the chrome while it holds
 * nothing, so it is in the document unarmed rather than appearing once a drag
 * is already in flight. What arms it in the app is the shell — a webview
 * swallows a file drop before any DOM event reaches an element — and the
 * handlers pinned here are what is left for `dev:web`, where a `drop` nobody
 * cancelled navigates the window away to whatever was dropped on it.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

function paint(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(<DropRegion onFoldersDropped={() => {}}>nothing yet</DropRegion>));
  const region = host.querySelector<HTMLElement>("[data-armed]");
  if (region === null) throw new Error("no drop region in the document");
  return region;
}

function drag(region: HTMLElement, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  act(() => {
    region.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  /* No harness: this is the `dev:web` window, where the DOM handlers are the
     only thing standing between a dropped folder and a navigation. */
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
});

describe("the body as a drop region", () => {
  it("is there, unarmed, before anything is dragged", () => {
    const region = paint();

    expect(region.getAttribute("data-armed")).toBe("false");
    expect(region.textContent).toContain("nothing yet");
  });

  it("says what it is in words, with nothing dragged and nothing held", () => {
    const region = paint();

    expect(region.textContent).toContain(DROP_REGION_HINT);
    expect(region.textContent).toContain("nothing yet");
    expect(region.getAttribute("data-armed")).toBe("false");
  });

  it("arms on a drag and disarms when it leaves", () => {
    const region = paint();

    drag(region, "dragover");
    expect(region.getAttribute("data-armed")).toBe("true");

    drag(region, "dragleave");
    expect(region.getAttribute("data-armed")).toBe("false");
  });

  it("cancels the drag and the drop, so the browser never navigates away", () => {
    const region = paint();

    expect(drag(region, "dragover").defaultPrevented).toBe(true);
    expect(drag(region, "drop").defaultPrevented).toBe(true);
    expect(region.getAttribute("data-armed")).toBe("false");
  });
});
