// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  VIEWS,
  readDefaultView,
  writeDefaultView,
} from "../src/views/views";

/**
 * The view the app opens on, remembered globally.
 *
 * Every case here is about a launch: what a fresh install opens on, what the
 * second launch opens on, and what happens when the store cannot answer. A
 * preference that only works while the app is running is not a preference.
 */

const KEY = "perseverance.view";

/*
 * Denying storage is the point of one of these, and jsdom hands `localStorage`
 * over as an own accessor on `window`. Redefining it is how a WebView with
 * storage denied is reached from a test; the descriptor is put back afterwards
 * so no other case inherits a window that throws.
 */
const original = Object.getOwnPropertyDescriptor(window, "localStorage");

function denyStorage() {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage is denied in this context");
    },
  });
}

function restoreStorage() {
  if (original === undefined) {
    delete (window as unknown as { localStorage?: unknown }).localStorage;
    return;
  }
  Object.defineProperty(window, "localStorage", original);
}

describe("the default view is remembered globally", () => {
  beforeEach(() => {
    restoreStorage();
    window.localStorage.clear();
  });

  afterEach(restoreStorage);

  it("opens on the Route", () => {
    expect(DEFAULT_VIEW).toBe("route");
    expect(VIEWS).toContain("route");
    expect(readDefaultView()).toBe("route");
  });

  it("a choice survives a restart", () => {
    writeDefaultView("route");

    // A fresh boot reads the same store the last session wrote.
    expect(window.localStorage.getItem(KEY)).toBe("route");
    expect(readDefaultView()).toBe("route");
  });

  it("a stored value that is not a view is ignored rather than opened", () => {
    // The shape a removed view leaves behind: a real string, in the real key,
    // naming something this build no longer has.
    window.localStorage.setItem(KEY, "constellation");

    expect(readDefaultView()).toBe(DEFAULT_VIEW);
  });

  it("storage that throws leaves the app on the default rather than blank", () => {
    denyStorage();

    // Both directions: reading cannot fail the launch, and writing cannot fail
    // the click that would have been remembered.
    expect(readDefaultView()).toBe(DEFAULT_VIEW);
    expect(() => writeDefaultView("route")).not.toThrow();
  });
});
