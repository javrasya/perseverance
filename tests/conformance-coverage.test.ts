/**
 * Every entry that asserts something still has somewhere to assert it.
 *
 * The coverage gate inside the conformance suite proves an *entry exists* for
 * every render-bound rule. It cannot prove the entry ever fires: a check that
 * skips at every point of the fixture space is green in exactly the way one
 * that holds at every point is green, and the difference lives only in an
 * annotation on a report nobody opens on a passing run. That is the vacuous
 * green #43's inversion exists to prevent, arriving through the back door —
 * deleting the one fixture that carries a cut ticket would leave rule 6
 * asserting nothing anywhere with the suite still all green.
 *
 * So the preconditions are separable from the assertions (`RuleEntry.applies`,
 * `tests/conformance/support/rules.ts`) and this walks the whole space with
 * them: every view in `VIEWS`, every point of `fixtureSpace(FIXTURE_NAMES)`,
 * and an entry with nowhere left to apply is red. Nothing is enumerated here
 * either — a fixture added widens this gate's space by the same import the
 * suite widens by, and a rule losing its last subject is a failure with the
 * rule's name in it.
 *
 * It runs under vitest rather than in the browser suite deliberately. The
 * question — *is there a point of the space where this has a subject* — is
 * answered from the fixtures' own `Snapshot`s and the view surfaces, so
 * needing a browser to ask it would put the answer behind the one command a
 * developer without browsers installed cannot run. `npm run verify` is what a
 * branch's greenness is judged by, and this belongs in it.
 */

import { describe, expect, it } from "vitest";
import { renderBoundRules } from "../src/contract/rules";
import { FIXTURE_NAMES } from "../src/snapshot/fixtures";
import { VIEWS } from "../src/views/views";
import { prospect } from "./conformance/support/drive";
import { RULE_CHECKS, type Precondition } from "./conformance/support/rules";
import { fixtureSpace } from "./support/contract";

/** Every point the fan-out will visit, before any of them is on screen. */
const SPACE = VIEWS.flatMap((view) =>
  fixtureSpace(FIXTURE_NAMES).map((state) => prospect(view, state)),
);

/** The gate's whole question, named so the known-bad proof below asks the same one. */
function appliesNowhere(applies: Precondition): boolean {
  return SPACE.every((at) => applies(at) !== null);
}

describe("the conformance suite covers what it claims to", () => {
  /*
   * The counting is only as good as its ability to say no, so it is proved
   * against known-bad input before it is run over the table — the same order
   * the pure checks in `tests/support/` are held to.
   */
  it("the counting tells an entry that applies nowhere from one that applies", () => {
    expect(SPACE.length, "a space with no points would make every entry look covered").toBeGreaterThan(0);
    expect(appliesNowhere(() => "there is no such point")).toBe(true);
    expect(appliesNowhere(() => null)).toBe(false);
  });

  it("every entry that asserts something applies somewhere in the space", () => {
    const uncovered = renderBoundRules()
      .map((rule) => ({ rule, entry: RULE_CHECKS[rule.id] }))
      .filter(
        (row): row is { rule: (typeof row)["rule"]; entry: NonNullable<(typeof row)["entry"]> } =>
          row.entry !== undefined && row.entry.check !== null,
      )
      .filter(({ entry }) => appliesNowhere(entry.applies))
      .map(({ rule }) => `${rule.id} ${rule.name}`);

    expect(
      uncovered,
      "rules whose check skips at every point of the fixture space, so the suite is green about nothing",
    ).toEqual([]);
  });
});
