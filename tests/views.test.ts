// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  VIEWS,
  readDefaultView,
  writeDefaultView,
} from "../src/views/views";
import { collect } from "./support/sources";

/**
 * The view the app opens on, remembered globally.
 *
 * Every case here is about a launch: what a fresh install opens on, what the
 * second launch opens on, and what happens when the store cannot answer. A
 * preference that only works while the app is running is not a preference.
 *
 * `VIEWS` had exactly one entry when this file was written, and that is what
 * made it easy to write badly: the stored value and the default were the same
 * string, so every assertion made against what `readDefaultView` *returns*
 * passed unchanged for a body of `return DEFAULT_VIEW`. What told a real read
 * from that one was the key — whether the read went to the store at all, and to
 * the one app-wide key the write used — so the store is watched below rather
 * than only seeded.
 *
 * A second view makes the returned value falsifiable as well, and the cases
 * below take that rather than leaving the key to carry it alone: a stored
 * `bench` that reads back as `bench` is an assertion `return DEFAULT_VIEW`
 * fails. The watch stays, because the two claims are different — *it went to
 * the store* and *it came back with what was in it* — and the third view since
 * registered arrived with the first one still worth making.
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
    // With nothing stored, and with a second view registered that it is not.
    expect(VIEWS).toContain("bench");
    expect(readDefaultView()).toBe("route");
  });

  it("a choice survives a restart", () => {
    // The view that is not the default, so the read cannot pass by agreeing
    // with it: a body of `return DEFAULT_VIEW` answers `route` here and fails.
    writeDefaultView("bench");

    // A fresh boot reads the same store the last session wrote.
    expect(window.localStorage.getItem(KEY)).toBe("bench");
    expect(readDefaultView()).toBe("bench");
  });

  it("answers from the store rather than from the default", () => {
    const asked = watchStorage("bench");

    // Two claims, and the second one only became makeable with a second view:
    // the read goes to the store at all, and it comes back with what was in it
    // rather than with the string the default happens to name.
    expect(readDefaultView()).toBe("bench");
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

/**
 * What a view is handed, asserted as a type rather than as a convention.
 *
 * *No view renders the record of what changed* is the acceptance criterion, and
 * the way it is met is that there is nothing in `ViewProps` for a view to
 * render. A rule would need somebody to keep it at every view added after this
 * one; a prop type that names `model` and stops needs nobody.
 *
 * `views.ts` is the one file under `src/views/` these two cases treat
 * differently, and deliberately: it is not a view, it is the contract, and the
 * file that declares an exclusion is the file allowed to say what it excludes.
 * Every actual view is scanned.
 */
describe("the prop type is the whole of what a view can see", () => {
  const PROP_TYPE = "src/views/views.ts";

  function viewSources() {
    return collect([".ts", ".tsx"]).filter((file) => file.path.startsWith("src/views/"));
  }

  it("hands every view one type, declared once", () => {
    const declared = viewSources().filter((file) =>
      /\binterface\s+\w*Props\b/.test(file.text),
    );

    // One declaration, in the contract. A view free to declare its own props
    // could widen them to the whole snapshot with nothing here failing, which
    // would make every case below a statement about today only.
    expect(declared.map((file) => file.path)).toEqual([PROP_TYPE]);

    /* Every registered view's own component, named: the check above says one
       file declares a props type, and these say the components are the files
       that read it rather than files that happen to declare nothing. */
    for (const path of ["src/views/route/Route.tsx", "src/views/bench/Bench.tsx"]) {
      const view = viewSources().find((file) => file.path === path);
      expect(view, path).toBeDefined();
      expect(view?.text, path).toContain("import type { ViewProps }");
      expect(view?.text, path).toContain("}: ViewProps)");
    }
  });

  it("names the model and never the snapshot it arrived on", () => {
    const contract = viewSources().find((file) => file.path === PROP_TYPE);
    const body = /export interface ViewProps \{([^}]*)\}/.exec(contract?.text ?? "")?.[1];
    if (body === undefined) throw new Error(`${PROP_TYPE} declares no ViewProps`);

    /*
     * The declaration only, not the file. The file has to import the type it
     * names, and that import path spells `snapshot` — what matters is that no
     * *field* does. The record rides on the `Snapshot` beside `model`, so a
     * `snapshot: Snapshot` here is the whole of the distance between a
     * structural exclusion and a rule.
     */
    expect(body).toContain("model: Model");
    expect(body).not.toMatch(/snapshot/i);
    expect(body).not.toMatch(/\bledger\b/i);

    // And the three fields are the whole of it, so a fourth is a failure here
    // before it is a field a view can read.
    const fields = body
      .split(";")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(fields).toEqual([
      "model: Model",
      "selected: number | null",
      "onSelect: (number: number | null) => void",
    ]);
  });

  it("leaves no view with a word for the record it cannot reach", () => {
    const offenders = viewSources()
      .filter((file) => file.path !== PROP_TYPE)
      .filter((file) => /\bledger\b/i.test(file.text))
      .map((file) => file.path);

    /*
     * Not a style rule about comments. A view that has a name for the record is
     * a view somebody has already started reasoning about drawing it from, and
     * the first thing that would arrive after the name is a prop to carry it.
     */
    expect(offenders).toEqual([]);
  });
});
