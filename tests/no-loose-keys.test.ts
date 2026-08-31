import { describe, expect, it } from "vitest";
import { KEY_BINDING_EXCEPTIONS, findKeyBindings, format } from "./support/checks";
import { collect } from "./support/sources";

/**
 * *Nothing else in the app binds a key*, enforced rather than documented.
 *
 * The acceptance criterion is structural, so this is a check over the sources
 * rather than a sentence in a doc comment: one router, one seam into xterm, and
 * no third place a keystroke is claimed. A binding outside the table is a chord
 * the palette and the keys page cannot know about — and, when it sits over a
 * warm terminal, a key taken from an agent CLI with nothing on screen saying it
 * was taken.
 *
 * The allow-list is two files and both are named in the check itself, which is
 * the same shape `scripts/check-agent-solitude.mjs` uses: the exception is part
 * of the rule and visible from it, not a suppression comment somewhere else.
 *
 * This stays in vitest rather than becoming a `scripts/check-*.mjs` gate. Those
 * exist for facts that cross a language or a dependency graph; this one is
 * TypeScript reading TypeScript, and `npm run verify` runs vitest anyway.
 */
describe("one key router, enforced by a check", () => {
  it("the check catches every way this stack can bind a key", () => {
    expect(findKeyBindings(`<li tabIndex={0} onKeyDown={choose}>`)).toHaveLength(1);
    expect(findKeyBindings(`<div onKeyUp={up} onKeyPress={press} />`)).toHaveLength(2);
    // The capture props are ordinary React props and they fire before the
    // target sees the key, which makes them the one form of loose binding that
    // could take a chord out from under the router's own capture listener.
    expect(findKeyBindings(`<div onKeyDownCapture={down} />`)).toHaveLength(1);
    expect(findKeyBindings(`<div onKeyUpCapture={up} onKeyPressCapture={press} />`)).toHaveLength(
      2,
    );
    expect(findKeyBindings(`node.onkeydown = down;`)).toHaveLength(1);
    expect(findKeyBindings(`node.onkeyup = up;\nnode.onkeypress = press;`)).toHaveLength(2);
    expect(findKeyBindings(`window.addEventListener("keydown", onDown, true);`)).toHaveLength(
      1,
    );
    expect(findKeyBindings(`element.addEventListener('keyup', up);`)).toHaveLength(1);
    expect(findKeyBindings(`terminal.attachCustomKeyEventHandler(handler);`)).toHaveLength(1);
    expect(findKeyBindings(`const listening = terminal.onKey((e) => send(e));`)).toHaveLength(1);
  });

  it("the check does not fire on the listeners that are not key bindings", () => {
    expect(findKeyBindings(`window.addEventListener("blur", onBlur);`)).toEqual([]);
    expect(findKeyBindings(`document.addEventListener("visibilitychange", onHidden);`)).toEqual(
      [],
    );
    expect(findKeyBindings(`const listening = terminal.onData(handler);`)).toEqual([]);
    expect(findKeyBindings(`export interface KeyboardLike { key: string }`)).toEqual([]);
    expect(findKeyBindings(`const monkeyDownstream = 1;`)).toEqual([]);
    expect(findKeyBindings(`<Row onKeyDownstream={feed} />`)).toEqual([]);
    expect(findKeyBindings(`el.onkeydownish = 1;`)).toEqual([]);
    expect(findKeyBindings(`route(event, currentState(event.target));`)).toEqual([]);
  });

  it("the allow-list is the router and the xterm seam, and it is spent", () => {
    const named = Object.keys(KEY_BINDING_EXCEPTIONS).sort();
    expect(named).toEqual(["src/keys/router.ts", "src/terminal/xterm.ts"]);

    // An exception that no longer covers anything is an exception that should
    // be deleted, so both are asserted to still be earning their place.
    const sources = collect([".ts", ".tsx"]);
    for (const path of named) {
      const file = sources.find((source) => source.path === path);
      expect(file, `${path} is named in the allow-list but does not exist`).toBeDefined();
      expect(findKeyBindings(file?.text ?? "").length).toBeGreaterThan(0);
    }
  });

  it("nothing outside those two files binds a key", () => {
    const offences = collect([".ts", ".tsx"])
      .filter((file) => !(file.path in KEY_BINDING_EXCEPTIONS))
      .map((file) => format(file.path, findKeyBindings(file.text)))
      .filter((report) => report.length > 0);

    expect(offences.join("\n")).toBe("");
  });
});
