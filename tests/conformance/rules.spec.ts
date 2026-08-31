/**
 * The fan-out: every render-bound rule, over every registered view, over every
 * point of the fixture space.
 *
 * Nothing here enumerates anything. The rules are `renderBoundRules()`, the
 * views are `VIEWS`, the fixtures are `FIXTURE_NAMES` and the crossing with the
 * two preference axes is `fixtureSpace` — so adding a fixture, or a view, adds
 * assertions across every rule with no test code written anywhere. That
 * inversion is the whole point: a suite that listed its own cases would go on
 * being green about the cases it happened to list.
 *
 * **One page load per view × state, and every applicable rule reads it.** Nine
 * render-bound rules against ~70 states is ~600 assertions and would be ~600
 * navigations if each rule loaded its own page. It is a browser: the load is
 * the cost, and a suite nobody runs settles nothing.
 *
 * A rule that cannot apply to a point of the space is annotated with the
 * precondition it skipped on, so the reason is on the report rather than
 * inferred from silence. Locally `list` (the default here) prints them; in CI
 * the `html` reporter writes them into `playwright-report/`, which the workflow
 * uploads on every run — see `playwright.config.ts`.
 */

import { expect, test } from "@playwright/test";
import { renderBoundRules } from "../../src/contract/rules";
import { FIXTURE_NAMES } from "../../src/snapshot/fixtures";
import { VIEWS } from "../../src/views/views";
import { fixtureSpace } from "../support/contract";
import { describeState, load } from "./support/drive";
import { RULE_CHECKS } from "./support/rules";

/**
 * The gate that makes the fan-out mean anything.
 *
 * A render-bound rule with no entry in the table is not an untested rule — it
 * is a rule the suite silently stops covering while the report goes on being
 * green, which is worse than no suite. Registering a rule and forgetting to
 * write its check has to be a red test, and this is it.
 */
test("every render-bound rule has an entry", () => {
  const missing = renderBoundRules()
    .filter((rule) => RULE_CHECKS[rule.id] === undefined)
    .map((rule) => `${rule.id} ${rule.name}`);
  expect(missing, "render-bound rules with nothing in the check table").toEqual([]);

  for (const rule of renderBoundRules()) {
    const entry = RULE_CHECKS[rule.id];
    expect(entry?.why.trim().length ?? 0, `rule ${rule.id} says nothing about itself`).toBeGreaterThan(0);
    /* An entry may assert nothing — but only where the registry already says a
       machine settles nothing. A rule with a floor and no check is the floor
       going unchecked, and no amount of prose makes that legitimate. */
    if (entry?.check === null) {
      expect(rule.assertedFloor, `rule ${rule.id} has a floor but asserts nothing`).toBeUndefined();
    }
  }

  const bound = new Set(renderBoundRules().map((rule) => String(rule.id)));
  const stray = Object.keys(RULE_CHECKS).filter((id) => !bound.has(id));
  expect(stray, "checks for rules the registry does not call render-bound").toEqual([]);
});

for (const view of VIEWS) {
  for (const state of fixtureSpace(FIXTURE_NAMES)) {
    test(`${view} · ${describeState(state)}`, async ({ page }) => {
      const rendering = await load(page, view, state);

      for (const rule of renderBoundRules()) {
        const entry = RULE_CHECKS[rule.id];
        /* Absent or declared-only: the gate above is what keeps the first of
           those two from ever happening quietly. */
        if (entry === undefined || entry.check === null) continue;

        const check = entry.check;
        const verdict = await test.step(`rule ${rule.id} · ${rule.name}`, () =>
          check(rendering));

        if ("skipped" in verdict) {
          test
            .info()
            .annotations.push({
              type: `rule ${rule.id} not applicable`,
              description: verdict.skipped,
            });
        }
      }
    });
  }
}
