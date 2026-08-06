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
 *
 * `VIEWS` has exactly one entry today, and that is what makes this file easy to
 * write badly. The stored value and the default are the same string, so every
 * assertion made against what `readDefaultView` *returns* passes unchanged for
 * a body of `return DEFAULT_VIEW`. What tells a real read from that one is the
 * key: whether the read goes to the store at all, and to the one app-wide key
 * the write used. So the store is watched below rather than only seeded.
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

/**
 * A store that answers with whatever it is handed and remembers every key it
 * was asked for, read and write alike.
 *
 * The returned array is the record, in call order.
 */
function watchStorage(stored: string | null): string[] {
  const keys: string[] = [];

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        keys.push(key);
        return stored;
      },
      setItem(key: string) {
        keys.push(key);
      },
    },
  });

  return keys;
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

  it("answers from the store rather than from the default", () => {
    const asked = watchStorage("route");

    // The value is the one the default names, because there is only one view to
    // name — so the answer proves nothing and the trip does. A read that never
    // consulted the store asks for no key and fails this line.
    expect(readDefaultView()).toBe("route");
    expect(asked).toEqual([KEY]);
  });

  it("is one key for the whole app, and the key names no map", () => {
    const asked = watchStorage(null);

    readDefaultView();
    writeDefaultView("route");

    /*
     * Global is #11's decision and this is the shape of it: the read and the
     * write name one key between them, and that key carries no number — so
     * there is nothing in it for a map to vary, and opening a different one
     * cannot change which choice comes back.
     */
    expect(asked).toEqual([KEY, KEY]);
    for (const key of asked) expect(key).not.toMatch(/\d/);
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
