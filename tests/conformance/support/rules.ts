/**
 * What a machine settles about a rendering, one entry per render-bound rule.
 *
 * The registry (`src/contract/rules.ts`) says which rules need a rendering;
 * this table says what is asserted about one. Every render-bound rule has an
 * entry and the coverage gate in `rules.spec.ts` is what makes that true — a
 * rule quietly missing from here would be a suite that goes green over nine
 * rules while checking eight, which is the exact vacuous green the contract
 * exists to prevent. An entry that asserts nothing is legitimate; an entry
 * that is *absent* never is. So rule 11 is registered with `check: null` and
 * the reason written out, and the gate holds every such entry to being a rule
 * with no `assertedFloor` at all.
 *
 * A check runs against **one already-loaded rendering** and returns a verdict.
 * It never navigates: the fan-out is one page load per view × state, and every
 * applicable rule reads that one rendering. A check that loaded its own page
 * would turn ~70 tests into ~350 navigations and a suite nobody runs.
 *
 * A check that cannot apply **skips with a stated precondition** rather than
 * passing. `no-map-open` renders no node at all, `empty-map` renders no row,
 * most fixtures have no cut ticket: a check that just found nothing and said
 * nothing would be green for the same reason a broken one would be. Every
 * precondition is read off the fixture's own `Snapshot` — never off a list of
 * fixture names, which drifts the moment a fixture is added or edited.
 *
 * The precondition is **separate from the assertion**, and that separation is
 * what makes the skips countable. An entry that skipped from inside its own
 * check could skip at every point of the space and be indistinguishable from
 * one that held at every point: same green, and the reason only ever on a
 * report nobody opens on a passing run. `applies` answers *is there a subject
 * here* from the fixture's `Snapshot` and the point's own preferences alone —
 * no browser — so `tests/conformance-coverage.test.ts` can walk the whole
 * space under vitest and go red on a rule that has stopped covering anything.
 * `check` is then only the assertion, and reaching it means the subject is
 * there.
 *
 * Where a check is scoped to the **page** rather than to the view root, that is
 * rule 7's corollary at work: the progress figures and the ledger are chrome,
 * the contract still binds them, and scoping their checks to a view root would
 * pass vacuously in a view that never renders them.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import type { RuleId } from "../../../src/contract/rules";
import type { Cut, Node, Snapshot } from "../../../src/snapshot/model.generated";
import { describeModel } from "../../../src/snapshot/readout";
import { readMotion } from "../../support/checks";
import { collectStylesheets } from "../../support/sources";
import { VIEWS, type ViewName } from "../../../src/views/views";
import type { Prospect, Rendering } from "./drive";
import type { ViewSurface } from "./views";

/**
 * Whether an assertion has a subject at one point of the space, and the
 * precondition it wants when it does not.
 *
 * `null` means *this applies here*; a string is the sentence that lands on the
 * report as the skip reason. It reads a `Prospect` and never a `Rendering`,
 * which is the whole discipline: the answer has to be available before a
 * browser exists, or the coverage gate cannot count it.
 */
export type Precondition = (at: Prospect) => string | null;

export interface RuleEntry {
  /**
   * What this entry settles and over what surface, in prose — including, where
   * it settles nothing, why nothing is settleable. Read by the coverage gate
   * only for being non-empty; read by a person for everything else.
   */
  readonly why: string;
  /**
   * Where this entry has a subject. Every early return a check used to make —
   * *no map open here*, *no cut ticket in this fixture*, *motion is on at this
   * point* — lives here instead, so the suite can count the points where the
   * assertion actually runs rather than only annotate the ones where it did
   * not.
   */
  readonly applies: Precondition;
  /**
   * The assertion, and nothing else: reaching it means `applies` said the
   * subject is here. `null` where a machine settles nothing — a wholly judged
   * rule — and then `applies` is never consulted.
   */
  readonly check: ((rendering: Rendering) => Promise<void>) | null;
}

/* ------------------------------------------------------------- helpers --- */

const NO_MAP = "no map is open in this fixture, so the view is not on screen";

function isCut(node: Node): node is Node & { cut: Extract<Cut, { cut: "fromScope" }> } {
  return node.cut.cut === "fromScope";
}

/** A rule whose subject is the whole rendering, which every point of the space has. */
const EVERYWHERE: Precondition = () => null;

/**
 * The precondition every view-rooted entry starts from: this fixture has a map
 * and this view puts one on screen for it.
 *
 * Both halves are asked of the view's own declaration rather than assumed —
 * `mounts` is what `surfaceOf` says about the fixture, and it is what decides
 * whether `load` finds a root at all. A second view that mounted on something
 * other than an open map would be answered correctly here without this being
 * edited.
 */
const ON_SCREEN: Precondition = ({ surface, snapshot }) =>
  snapshot.model.map === null || !surface.mounts(snapshot) ? NO_MAP : null;

/** The map's nodes, or none — so a precondition can read them before the map is known to be there. */
function nodesOf(at: Prospect): readonly Node[] {
  return at.snapshot.model.map?.nodes ?? [];
}

function hasKind(snapshot: Snapshot, kind: string): boolean {
  return snapshot.model.map?.nodes.some((node) => node.kind.kind === kind) ?? false;
}

/**
 * The view root and the map, where the entry's precondition already settled
 * that both are there.
 *
 * A `null` here is not a skip: it is a precondition that disagrees with the
 * view it ran against, and the suite should say so loudly rather than quietly
 * check nothing.
 */
function onScreen(rendering: Rendering): {
  readonly root: Locator;
  readonly map: NonNullable<Snapshot["model"]["map"]>;
} {
  const map = rendering.snapshot.model.map;
  if (rendering.root === null || map === null) {
    throw new Error(
      `${rendering.view} has no root or no map for ${rendering.state.fixture}, though this rule's precondition said it applies`,
    );
  }
  return { root: rendering.root, map };
}

/**
 * Reassigns every `--s-*` token at `:root` to one value, and hands back the undo.
 *
 * The token names are read out of the rendering's own stylesheets rather than
 * listed here: a semantic token added to `src/styles/tokens/semantic.css` has
 * to be reached by this or the retheme it stands for is not the retheme the
 * rule means. `!important` because the dark-scheme block reassigns the same
 * names at the same specificity.
 *
 * The undo matters. Every rule in the fan-out reads the same page load, so a
 * check that recoloured the world and left it that way would be deciding what
 * the checks after it see.
 */
async function collapseSemanticTokens(page: Page): Promise<() => Promise<void>> {
  const id = "conformance-collapsed-tokens";

  const collapsed = await page.evaluate((styleId: string) => {
    const names = new Set<string>();
    const walk = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const property of Array.from(rule.style)) {
            if (property.startsWith("--s-")) names.add(property);
          }
        }
        const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
        if (nested !== undefined) walk(nested);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A cross-origin sheet cannot be read, and this app loads none.
      }
    }

    if (names.size === 0) return 0;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `:root{${[...names]
      .map((name) => `${name}:#ff00ff !important;`)
      .join("")}}`;
    document.head.append(style);
    return names.size;
  }, id);

  expect(collapsed, "the rendering defines no --s-* tokens to collapse").toBeGreaterThan(0);

  return async () => {
    await page.evaluate((styleId: string) => {
      document.getElementById(styleId)?.remove();
    }, id);
  };
}

/** The still form of a mark: what is left of it with the motion taken away. */
async function stillFormOf(glyph: Locator): Promise<Record<string, string>> {
  return glyph.evaluate((element: Element) => {
    const halo = getComputedStyle(element, "::after");
    return {
      animationName: halo.animationName,
      content: halo.content,
      opacity: halo.opacity,
      borderStyle: halo.borderTopStyle,
      borderWidth: halo.borderTopWidth,
      background: halo.backgroundColor,
    };
  });
}

/**
 * The still form of the rack's lamp: what the region has left to say *something
 * here is running* with the movement taken away.
 *
 * Read off the lamp's own box rather than off a pseudo-element, because that is
 * where the rack authored its still form. The Route splits the two classes —
 * `.markClaimed::after` draws the halo's ring and `.markPing::after` only moves
 * it — while the rack draws its ring on `.lamp` itself and hangs the whole of
 * `.lampPing::after` on top, so the thing that has to survive the media query
 * here is the lamp and the count beside it. `[data-lamp]` is the address the
 * rack promises for exactly this: a lamp found by its ping could not be asked
 * what is left when there is no ping.
 *
 * `moving` is the region walked whole — every element in it and both pseudos on
 * each — rather than the lamp alone. The guard in `src/styles/global.css` is a
 * `*` rule, so *the query reached it* is a claim about the subtree and not about
 * one selector, and an animation authored where the guard cannot beat it would
 * be invisible to a reading of the lamp by itself.
 */
async function stillLampOf(page: Page): Promise<{
  readonly borderStyle: string;
  readonly borderWidth: string;
  readonly opacity: string;
  readonly drawn: boolean;
  readonly haloAnimation: string;
  readonly said: string;
  readonly moving: readonly string[];
}> {
  return page.locator("[data-lamp]").evaluate((lamp: Element) => {
    const ring = getComputedStyle(lamp);
    const halo = getComputedStyle(lamp, "::after");
    const region = lamp.closest("section");
    const moving: string[] = [];
    for (const box of region === null ? [] : [region, ...Array.from(region.querySelectorAll("*"))]) {
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(box, pseudo ?? undefined);
        if (style.animationName !== "none") {
          moving.push(`${box.tagName.toLowerCase()}${pseudo ?? ""} runs ${style.animationName}`);
        }
      }
    }
    const box = lamp.getBoundingClientRect();
    return {
      borderStyle: ring.borderTopStyle,
      borderWidth: ring.borderTopWidth,
      opacity: ring.opacity,
      drawn: box.width > 0 && box.height > 0,
      haloAnimation: halo.animationName,
      said: (lamp.parentElement as HTMLElement | null)?.innerText ?? "",
      moving,
    };
  });
}

/**
 * The properties a row can carry an ink on, and the inks it actually resolves.
 *
 * This is what makes the collapse above load-bearing rather than decorative.
 * Everything else rule 3 asserts is colour-blind — `toContainText` reads
 * `textContent` and `toHaveCount` counts elements — so with nothing colour-
 * sensitive asserted while the tokens are collapsed, the collapse could be
 * deleted and every state would come back with the same verdict. It cannot:
 * `--c-node-glyph` is `--s-ink-primary` on an unclassified row and
 * `--s-ink-faint` on a ticket's, so the two rows differ in ink until the
 * collapse lands and cannot differ afterwards. Asserting that first is what
 * proves colour is not the channel the assertions below are riding on.
 *
 * The properties come from the surface (`ViewSurface.inks`) rather than from a
 * list here, because a fixed list is a probe that reads one view's channel and
 * pronounces every other view clean. The Route paints its glyph in `color`, a
 * border and a background; the Plate paints its mark in SVG `fill` and
 * `stroke`, and a probe reading only the first three would find one ink on a
 * plate whose every kind distinction was pure hue.
 *
 * The glyph's descendants are read as well as the glyph itself: an SVG mark is
 * a group, and the paint is on the shapes inside it rather than on the group.
 * The containers themselves are not read — `fill` on a `<g>` is whatever it
 * inherited, initially black, which is a colour nobody chose and would be an
 * ink this view never draws.
 *
 * Values nobody painted are dropped — `transparent`, an alpha-zero colour and
 * SVG's `none` — because an unfilled shape is not an ink, and the two rows draw
 * deliberately different shapes.
 */
async function inksOf(row: Locator, surface: ViewSurface): Promise<string[]> {
  return row.evaluate(
    (element: Element, read: { glyph: string; properties: readonly string[] }) => {
      const inks = new Set<string>();
      /* An SVG container paints nothing; its `fill` is only what it inherited. */
      const containers = new Set(["g", "svg", "defs", "symbol", "clippath", "title", "desc"]);
      const gather = (target: Element, properties: readonly string[]): void => {
        if (containers.has(target.tagName.toLowerCase())) return;
        const style = getComputedStyle(target);
        for (const property of properties) {
          const value = style.getPropertyValue(property);
          if (value === "" || value === "none" || value === "transparent") continue;
          if (/,\s*0\)$/.test(value)) continue;
          inks.add(value);
        }
      };

      gather(element, ["color"]);
      const mark = element.querySelector(read.glyph);
      if (mark !== null) {
        gather(mark, read.properties);
        for (const inside of Array.from(mark.querySelectorAll("*"))) {
          gather(inside, read.properties);
        }
      }
      return [...inks];
    },
    { glyph: surface.glyph, properties: surface.inks },
  );
}

/**
 * Every selector the stylesheet walk finds an animation on.
 *
 * Rule 12's floor used to name `ping` and `.markClaimed::after` outright, so a
 * second animation appearing elsewhere would have been uncovered by a test
 * that stayed green. Rule 9's ration is enumerable over the stylesheets
 * (`tests/motion-ration.test.ts`), so the floor is derived from the same walk
 * instead: whatever moves owes a still form. Reading the selectors rather than
 * the rendering is deliberate — the CSS is where the motion surface is
 * complete, and a fixture that happens not to render the moving element would
 * otherwise be a hole in the coverage rather than a skip.
 *
 * The stylesheets are the whole motion surface, and that is a checked fact
 * rather than an assumption: `findStrayMotion` (`tests/motion-ration.test.ts`)
 * walks the wider net — every `.ts`, `.tsx`, `.svg` and `.html` under `src/`
 * plus the root `index.html` — and goes red on an `@keyframes` or an
 * `animation` written anywhere but a rationed stylesheet. So this walk needs no
 * widening: outside it the set is provably empty, and a second enumeration
 * here would be a second thing to keep true.
 */
function animatedSelectors(): string[] {
  const selectors = collectStylesheets().flatMap((file) =>
    readMotion(file.text).animations.map((animation) => animation.selector),
  );
  return [...new Set(selectors)].sort();
}

/**
 * The text a row actually puts on screen, in a view that may not be HTML.
 *
 * `innerText` is the reading the contract wants — it is what a person can read,
 * so a reason parked behind `display: none` does not count as rendered — but it
 * is an `HTMLElement` property, and the Plate's rows are SVG `<g>` elements:
 * WebKit throws `Node is not an HTMLElement` rather than answering. Reaching
 * for `textContent` instead would quietly change what the rule asserts, since
 * `textContent` reads hidden text too and the hiding is exactly what is being
 * refused.
 *
 * So the same reading is done by hand, for every view rather than only for the
 * one that needs it: one definition of *rendered text*, applied to a list and a
 * diagram alike, is what keeps the rule from meaning two things.
 */
async function renderedText(row: Locator): Promise<string> {
  return row.evaluate((element: Element) => {
    const read = (node: Element): string => {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
      let text = "";
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
        else if (child instanceof Element) text += ` ${read(child)}`;
      }
      return text;
    };
    return read(element);
  });
}

/**
 * Which view's sheet an animation was authored in, or `null` when the chrome
 * authored it.
 *
 * Rule 12's subject is *the thing that moves*, and a view that spends no motion
 * has nothing for it to read. Saying so has to be said without naming a view in
 * a check, and the stylesheet is where it is already said: a sheet under
 * `src/views/<name>/` is that view's own, and every other sheet is chrome and
 * therefore on screen at every point of the space. So the still form owed by
 * `.markClaimed::after` is owed where the Route is drawn, and at a Plate point
 * the entry skips on a stated precondition rather than asserting the Route's
 * halo against a diagram that never had one — which is a fact about which
 * sheet carries the `@keyframes`, not an exemption anybody wrote for a view.
 *
 * `VIEWS` is what the path is matched against, so a third view's motion is
 * placed by the same rule with nothing added here.
 */
function authoredIn(selector: string): ViewName | null {
  for (const file of collectStylesheets()) {
    const carries = readMotion(file.text).animations.some(
      (animation) => animation.selector === selector,
    );
    if (!carries) continue;
    const view = VIEWS.find((name) => file.path.includes(`src/views/${name}/`));
    if (view !== undefined) return view;
  }
  return null;
}

/** The precondition above, as a `Precondition`, decided with no browser. */
function movesHere(selector: string): Precondition {
  return (at) => {
    const home = authoredIn(selector);
    if (home === null || home === at.view) return null;
    return `${selector} is authored in the ${home} view's own sheet, so nothing this view draws moves for it`;
  };
}

/**
 * The still form owed by one animated selector, read off a rendering under
 * `prefers-reduced-motion: reduce`. Keyed by the selector as authored: an
 * animation moving to another selector loses its entry and goes red.
 */
interface StillForm {
  /** Split from the assertion for the same reason a rule entry's is: so it can be counted. */
  readonly applies: Precondition;
  readonly check: (rendering: Rendering) => Promise<void>;
}

const NO_CLAIM_BESIDE =
  "this fixture renders no claimed node beside a node in another state, so no distinction here is carried by motion";

const STILL_FORMS: Record<string, StillForm> = {
  /* The animation's selector and not the ring's: `.markClaimed::after` draws the
     halo on every claimed row and `.markPing::after` moves one of them, because
     #56 rations motion by the screen. The still form is read off the row that
     moves, which is the first claimed row on the pane. */
  ".markPing::after": {
    applies: (at) =>
      ON_SCREEN(at) ??
      /* The moving selector and not the ring it moves. `movesHere` asks which
         view's sheet authored an *animation*, and `.markClaimed::after` carries
         none anywhere — it is the static halo, drawn by The Route and by the
         Bench alike. Asked about it, `authoredIn` finds no animation, answers
         *chrome*, and the still form is owed in every view — including two that
         draw no halo at all, whose glyph then reports `content: none` and fails
         the check with the ring's own sentence. `ping` is authored once, in
         `src/views/route/Route.module.css`, so that is the name that places it. */
      movesHere(".markPing::after")(at) ??
      (nodesOf(at).some((node) => node.state === "claimed") &&
      nodesOf(at).some((node) => node.state !== "claimed")
        ? null
        : NO_CLAIM_BESIDE),
    check: async (rendering) => {
      const { surface } = rendering;
      const { root, map } = onScreen(rendering);
      /* Both are there: the precondition above is what found them. */
      const claimed = map.nodes.find((node) => node.state === "claimed")!;
      const other = map.nodes.find((node) => node.state !== "claimed")!;

      const moving = await stillFormOf(
        root.locator(surface.row(claimed.number)).locator(surface.glyph),
      );
      const still = await stillFormOf(
        root.locator(surface.row(other.number)).locator(surface.glyph),
      );

      expect(moving.animationName, "motion survived the media query").toBe("none");
      expect(moving.content, "the halo is gone with the animation").not.toBe("none");
      expect(Number(moving.opacity)).toBeGreaterThan(0);
      expect(moving.borderStyle).not.toBe("none");
      expect(moving.borderWidth).not.toBe("0px");
      expect(moving, "the two states are the same thing with the motion off").not.toEqual(still);
    },
  },

  /* The rack's lamp, whose still form is the lamp itself. #56 bought a second
     licence — `rackPing` on `.lampPing::after`, for *a child process is still
     printing*, which is the running-vs-stale reading rule 9 asks for — and a
     second licence owes a second entry here or rule 12 goes red everywhere,
     which is the whole point of keying this table by the selector as authored.

     What the rack keeps when the movement goes is not a ring underneath a
     pseudo-element but the lamp's own: `.lamp` is drawn at every one of the
     three states, `.lampLive` fills it, and `N of M still running` says the
     same thing in words beside it. So this reads the lamp and the head band it
     sits in rather than a `::after`, and it reads the region whole for anything
     still moving — the guard in `src/styles/global.css` is a `*` rule, so *the
     query reached it* is a claim about the subtree.

     The lit pair — a lamp that pings against one that yielded the ration — is
     not read here and cannot be. This space is map snapshots × theme × motion
     and `load` asks for no run fixture, so the rack on screen at every point of
     it holds no run at all; the pair is settled in `tests/rack.test.tsx`, where
     the readouts are handed in directly. What is left for a browser to settle
     is the half that is about the media query, and it is the half a stylesheet
     can break: a ring that had migrated onto `.lampPing::after` would leave a
     rack with nothing drawn wherever the ping is suppressed, and an animation
     authored where the guard cannot beat it would still be running here. Both
     are red below. */
  ".lampPing::after": {
    /* The rack is chrome and is on screen at every point of the space — rule
       7's corollary, the same reason rules 4, 5 and 10 are scoped to the page.
       A rendering with no map open still draws it, dark, saying `no runs`. */
    applies: EVERYWHERE,
    check: async ({ page }) => {
      const lamp = await stillLampOf(page);

      expect(lamp.moving, "motion survived the media query").toEqual([]);
      expect(lamp.haloAnimation, "motion survived the media query").toBe("none");

      /* And what the media query left standing is still a lamp: a ring with a
         box, drawn by the rack rather than by the selector that moves it. */
      expect(lamp.drawn, "the lamp is not drawn at all").toBe(true);
      expect(lamp.borderStyle, "the lamp's ring went with the animation").not.toBe("none");
      expect(lamp.borderWidth, "the lamp's ring went with the animation").not.toBe("0px");
      expect(Number(lamp.opacity), "the lamp is faded out").toBeGreaterThan(0);

      /* The fact in words, beside it. A lamp is a reading somebody has to
         already know how to take; the count is the one that survives not
         knowing, and rationing motion may not cost it. */
      expect(lamp.said.trim(), "the head band says nothing beside the lamp").not.toBe("");
    },
  },
};

/* ------------------------------------------------------------ the table --- */

export const RULE_CHECKS: Partial<Record<RuleId, RuleEntry>> = {
  2: {
    why: "Asserted, over the view root: the count of the designated encoding is the count the model designates — one where `map.frontier` names a node, none where it names none — and the row carrying it is that node's row. The negative half is the load-bearing one: a view that drew the offer on two rows, or on a row Rust never designated, is the failure this rule is about.",
    applies: ON_SCREEN,
    check: async (rendering) => {
      const { surface } = rendering;
      const { root, map } = onScreen(rendering);

      const designated = root.locator(surface.designated);
      const expected = map.frontier.frontier === "designated" ? 1 : 0;
      await expect(designated).toHaveCount(expected);

      if (map.frontier.frontier === "designated") {
        const itsRow = root.locator(surface.row(map.frontier.number));
        await expect(designated.and(itsRow)).toHaveCount(1);
      }
    },
  },

  3: {
    why: "Asserted, over the view root, after every `--s-*` token at `:root` has been collapsed to one value — the retheme the rule names, taken to its limit. That the collapse landed is itself asserted first, and colour-sensitively: the unclassified row and the ticket row resolve one ink between them, so the channel this view normally tells kinds apart on is demonstrably gone before anything else is read. What is asserted afterwards is that unclassified is still *told apart* and still carries *no action*: the word is still on the row and is still not on a ticket's, and the row holds no control and no offer. The channel asserted is text, deliberately: with every ink and every surface the same colour, text and structure are the only channels left, and the shape a view draws is view identity the contract may not standardise.",
    applies: (at) =>
      ON_SCREEN(at) ??
      (hasKind(at.snapshot, "unclassified") && hasKind(at.snapshot, "ticket")
        ? null
        : "this fixture has no unclassified child beside a ticket, so there is nothing to tell apart"),
    check: async (rendering) => {
      const { page, surface } = rendering;
      const { root } = onScreen(rendering);

      const unclassified = root.locator(surface.rowsOfKind("unclassified")).first();
      const ticket = root.locator(surface.rowsOfKind("ticket")).first();

      const restore = await collapseSemanticTokens(page);
      try {
        /* First, that the collapse landed: with every `--s-*` token reassigned
           to one value, the two rows resolve one ink between them — the row's
           own text colour and its glyph's fill and edge, which is where this
           view puts the difference between a kind and another kind. Colour is
           gone as a channel before a word of the distinction below is read,
           which is the whole experiment rule 3 names. */
        const inks = new Set([
          ...(await inksOf(unclassified, surface)),
          ...(await inksOf(ticket, surface)),
        ]);
        expect(
          [...inks].sort(),
          "colour survived the collapse, so the distinction below could still be riding on it",
        ).toHaveLength(1);

        await expect(unclassified).toContainText(surface.unclassifiedWord);
        await expect(ticket).not.toContainText(surface.unclassifiedWord);

        /* No action: not a control, and not the offer either. Selecting a row
           is not starting one — every row in this view is selectable — so what
           may not be on it is a control that acts and the designation that
           says *start here*. */
        await expect(
          unclassified.locator('button, a[href], input, select, textarea, [role="button"]'),
        ).toHaveCount(0);
        await expect(unclassified.and(root.locator(surface.designated))).toHaveCount(0);
      } finally {
        await restore();
      }
    },
  },

  4: {
    why: "The floor of a judged rule, over the page rather than the view root: a fog region that moved to the chrome is still the region the rule binds (rule 7's corollary). Over a fixture nobody surveyed: the region renders no numeral at all — not the count slot, and not a digit anywhere in it — and stands its absence in a slot of its own. That is *form level* made checkable: a differently-styled numeral would still be a numeral, and this fails it. Whether the region also *names* what is missing is the judged residue and is not asserted here.",
    applies: ({ surface, snapshot }) => {
      const map = snapshot.model.map;
      if (map === null) return "no map is open in this fixture, so no fog is rendered";
      if (surface.fog === null) {
        return "this view renders no fog region, so the fog is chrome's and the rule is delivered there";
      }
      if (map.fog.fog !== "unsurveyed") {
        return "this fixture's fog was surveyed, so there is no absence to render";
      }
      return null;
    },
    check: async ({ page, surface }) => {
      /* The precondition is what established this view has a fog region. */
      const fog = surface.fog!;

      const region = page.locator(fog.region);
      await expect(region).toBeVisible();
      await expect(region.locator(fog.count)).toHaveCount(0);
      await expect(region.locator(fog.unsurveyed)).toBeVisible();
      expect(await region.innerText()).not.toMatch(/\d/);
    },
  },

  5: {
    why: "Asserted in the positive form the registry restates, over the page: the figures reach the screen as the model's own numerals, spelled — `describeModel` is what the rendering has to agree with — and nothing continuous stands between or behind them. Three ways a proportion could be drawn are refused: a widget (`progress`, `meter`, a progressbar or meter role, or an `aria-valuenow` on anything that is a reading rather than a control) anywhere in the rendering; a painted image on the figures, on anything inside them or on anything behind them up to the body; and an inline style, which is the only route this app has from a number in the model to an extent on screen — every other length here is authored in a stylesheet and cannot vary with a count. An SVG view puts its geometry in *attributes* (`x`, `y`, `d`, `viewBox`), and those are not what this rule is about: they place a mark that already stands for a ticket, whereas the offence is a length that stands for a proportion. The probe reads inline `style` and a painted background, and finds neither on the Plate — nothing between the model's numerals and the screen there is drawn by an attribute at all.",
    applies: ({ snapshot }) =>
      snapshot.model.map === null
        ? "no map is open in this fixture, so no progress figures are rendered"
        : null,
    check: async ({ page, snapshot }) => {
      const figures = page.getByText(describeModel(snapshot.model), { exact: true });
      await expect(figures).toHaveCount(1);

      /*
       * A widget that *reads out* a proportion, and not every widget that has a
       * value.
       *
       * `aria-valuenow` alone is too coarse a net, and the dial is why: it is a
       * focusable `separator` with a value from 0 to 100, and that value is the
       * window split the operator dragged — a number the model does not contain
       * and could not vary. Failing it would be the suite refusing an operator
       * control because a proportion of *something* is on screen, which is not
       * what the rule says. So the range roles a person sets — slider,
       * spinbutton, scrollbar, and a focusable separator, which is what a
       * splitter is — are not readouts and are excused by role.
       *
       * Nothing about the actual offence gets easier: `progress`, `meter`,
       * `role="progressbar"` and `role="meter"` are refused outright however
       * they are dressed, a plain `<div aria-valuenow>` bar is still refused
       * because it claims no input role, and no exemption is spelled per view
       * or per element.
       */
      await expect(
        page.locator(
          [
            "progress",
            "meter",
            "[role=progressbar]",
            "[role=meter]",
            "[aria-valuenow]:not([role=slider]):not([role=spinbutton])" +
              ":not([role=scrollbar]):not([role=separator][tabindex])",
          ].join(", "),
        ),
      ).toHaveCount(0);

      const continuous = await figures.evaluate((element: Element) => {
        const found: string[] = [];
        const behind: Element[] = [];
        for (let up: Element | null = element; up !== null; up = up.parentElement) {
          behind.push(up);
        }
        const boxes = [...behind, ...Array.from(element.querySelectorAll("*"))];

        for (const box of boxes) {
          const where = box.tagName.toLowerCase();
          if (box.getAttribute("style") !== null) found.push(`${where} carries an inline style`);
          for (const pseudo of [null, "::before", "::after"]) {
            const style = getComputedStyle(box, pseudo ?? undefined);
            if (pseudo !== null && style.content === "none") continue;
            if (style.backgroundImage !== "none") {
              found.push(`${where}${pseudo ?? ""} paints ${style.backgroundImage}`);
            }
          }
        }
        return found;
      });
      expect(continuous).toEqual([]);
    },
  },

  6: {
    why: "The asserted half, over the view root: for every node the map cut, the reason is *rendered* text on its row — `innerText`, so a reason parked in a hidden element fails — and the row carries no `title` and no disclosure control anywhere in it. The other half of the rule is structural and is settled off the model, not here: the cut is already out of both counts before a view sees it.",
    applies: (at) =>
      ON_SCREEN(at) ??
      (nodesOf(at).some(isCut) ? null : "this fixture has no node the map cut from scope"),
    check: async (rendering) => {
      const { surface } = rendering;
      const { root, map } = onScreen(rendering);

      for (const node of map.nodes.filter(isCut)) {
        const row = root.locator(surface.row(node.number));
        await expect(row).toBeVisible();
        expect(await renderedText(row)).toContain(node.cut.reason);
        await expect(row.locator("[title]")).toHaveCount(0);
        expect(await row.evaluate((element: Element) => element.hasAttribute("title"))).toBe(
          false,
        );
        await expect(row.locator("details, summary, [aria-expanded]")).toHaveCount(0);
      }
    },
  },

  10: {
    why: "The floor of a judged rule, over the page. Two halves, and neither needs a pointer to be driven. Every `title` in the rendering must be recovering text that is already in the rendering — the carve-out, held to what it says. And no rule in the rendering's own stylesheets may reveal anything on `:hover`: the CSSOM is walked for hover selectors that touch a disclosure property, and the property decides how it is judged. `clip-path`, `overflow` and any `transform` that is not a plain scale or rotate are refused outright, because a subject that is clipped, held inside an `overflow: hidden` parent or parked off-screen rests as a full-opacity, non-zero box — nothing about the resting state could tell an un-clip or a slide-in from emphasis. The properties whose hiding the resting state *does* show — `display`, `visibility`, `opacity`, a height, a width, a pseudo element's `content` — are judged against the resting state of what they restyle: a rule that paints something already on screen is emphasis, a rule whose subject rests invisible, unpainted, zero-area or without content is disclosure. That catches a gradient-fade reveal, a `max-height` accordion and a `::after` tooltip as readily as `display: none`, and it does not accuse a view of drawing a mark it has drawn the whole time louder. What is not asserted is *load-bearing*: whether a fact the operator needs is reachable without a pointer is a claim about the task, and two views may answer it differently.",
    applies: EVERYWHERE,
    check: async ({ page }) => {
      const rendered = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const titles = await page
        .locator("[title]")
        .evaluateAll((elements: Element[]) =>
          elements.map((element) => element.getAttribute("title") ?? ""),
        );
      for (const title of titles) {
        expect(rendered, `a title discloses text the rendering does not carry: ${title}`).toContain(
          title.replace(/\s+/g, " "),
        );
      }

      const disclosing = await page.evaluate(() => {
        /*
         * Disclosure is *something arriving that was not there*. Emphasis is
         * something already on screen being drawn louder. Both are written with
         * the same properties, so the property alone cannot tell them apart:
         * `transform: scale(1.35)` on a station's glyph is the transit
         * convention enlarging a mark the operator is already looking at, and
         * `max-height: 40rem` on a panel is an accordion opening. What tells
         * them apart is the *resting* state of what the rule paints — so the
         * walk asks the page, at rest, with no pointer anywhere near it.
         *
         * But the resting state only answers for the properties whose hiding it
         * can see. A subject sitting under `clip-path: inset(100%)`, inside an
         * `overflow: hidden` parent, or parked at `translateY(-200%)` rests as
         * a full-opacity, non-zero box that no probe here can distinguish from
         * one honestly on screen, so those are refused outright rather than
         * judged: hover may not un-clip, un-hide overflow, or move a subject.
         * `transform` is admitted only in the scale/rotate form the transit
         * convention needs, which is emphasis wherever it is written.
         *
         * The remainder — display, visibility, opacity, a height, a width, a
         * pseudo element's `content` — is judged against how its subject rests,
         * and refused when the thing it restyles is not already painted:
         * display `none`, `visibility: hidden`, an opacity at or below the
         * point where nothing is legible, a zero-area box, or a pseudo element
         * with no content. That still catches the gradient fade (rests at
         * opacity 0), the accordion (rests at height 0) and the tooltip
         * `::after` (rests at `content: none`), and it stops accusing a view of
         * hiding a thing it is drawing the whole time.
         *
         * A rule whose subject is not in this rendering at all is *not judged
         * here*, and deliberately: the Plate's sheet is loaded while the Route
         * is open, so its station rules match nothing at that point of the
         * space. The fan-out visits every view, and the rule is judged where its
         * elements exist — which is a stronger reading than judging a selector
         * against a page that never had the elements.
         */
        const JUDGED_AT_REST = [
          "display",
          "visibility",
          "opacity",
          "content",
          "height",
          "max-height",
          "width",
          "max-width",
        ];
        /* Hiding the resting probe cannot see: a clipped element, one inside a
           clipping parent and one carried off-screen all report a painted,
           non-zero box, so hover is refused these outright. */
        const REFUSED_OUTRIGHT = [
          "clip",
          "clip-path",
          "overflow",
          "overflow-x",
          "overflow-y",
          "overflow-block",
          "overflow-inline",
          /* The individual property, which is `transform: translate(...)` under
             another spelling and hides just as invisibly. */
          "translate",
        ];
        /* `transform` is both kinds at once. Scale and rotate draw a mark
           louder where it already is; anything else — `translate` above all —
           can carry a subject in from somewhere the probe never looked. */
        const EMPHASIS_ONLY = /^(none|(\s*(scale|scalex|scaley|rotate|rotatez)\([^()]*\))+\s*)$/i;
        /* Below this an element is not dimmed, it is gone. A view that recedes
           a thread to a third of its ink is still drawing it. */
        const LEGIBLE = 0.1;

        /* `null` when the selector matches nothing in this rendering; otherwise
           `hidden` is why its subject is not painted yet, or `null` if it is. */
        const resting = (selector: string): { hidden: string | null } | null => {
          const pseudo = /::?(before|after)\b/.exec(selector);
          const host = selector.replace(/::?(before|after)\b/g, "").trim();
          let elements: Element[];
          try {
            elements = Array.from(document.querySelectorAll(host === "" ? ":root" : host));
          } catch {
            return { hidden: "unreadable selector" };
          }
          if (elements.length === 0) return null;
          for (const element of elements) {
            const style = getComputedStyle(element, pseudo === null ? undefined : `::${pseudo[1]}`);
            if (pseudo !== null && (style.content === "none" || style.content === "")) {
              return { hidden: "its ::" + pseudo[1] + " has no content until hovered" };
            }
            if (style.display === "none") return { hidden: "it is display:none until hovered" };
            if (style.visibility === "hidden") {
              return { hidden: "it is visibility:hidden until hovered" };
            }
            if (Number(style.opacity) <= LEGIBLE) {
              return { hidden: "it is invisible until hovered" };
            }
            const box = element.getBoundingClientRect();
            if (pseudo === null && (box.width === 0 || box.height === 0)) {
              return { hidden: "it has no area until hovered" };
            }
          }
          return { hidden: null };
        };

        const found: string[] = [];
        const walk = (rules: CSSRuleList): void => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule && rule.selectorText.includes(":hover")) {
              const properties = Array.from(rule.style);
              const refused = properties.filter(
                (property) =>
                  REFUSED_OUTRIGHT.includes(property) ||
                  (property === "transform" &&
                    !EMPHASIS_ONLY.test(rule.style.getPropertyValue("transform").trim())),
              );
              const judged = properties.filter((property) => JUDGED_AT_REST.includes(property));
              for (const selector of rule.selectorText.split(",")) {
                if (refused.length === 0 && judged.length === 0) break;
                if (!selector.includes(":hover")) continue;
                const subject = resting(selector.replaceAll(":hover", ""));
                if (subject === null) continue;
                if (refused.length > 0) {
                  found.push(
                    `${selector.trim()} { ${refused.join(", ")} }: hover un-clips or moves it, and a subject hidden that way rests fully painted`,
                  );
                }
                if (judged.length > 0 && subject.hidden !== null) {
                  found.push(`${selector.trim()} { ${judged.join(", ")} }: ${subject.hidden}`);
                }
              }
            }
            const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
            if (nested !== undefined) walk(nested);
          }
        };
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            walk(sheet.cssRules);
          } catch {
            // Unreadable sheet; this app loads none.
          }
        }
        return found;
      });
      expect(disclosing).toEqual([]);
    },
  },

  11: {
    why: "Declared only, and asserted nowhere. The claim is about misreading — a label read as a node, a boundary read as an edge — and misreading has no DOM signature to look for. The only checkable form would be a clearance figure, and the figure belongs to one view's layout: asserting it would cargo-cult that view's fix into the contract, which the meta-rule prohibits. The rule is judged in `docs/contract/declarations/<view>.md`, where a reader can weigh what the view says it did. This entry exists so that *nothing is asserted* is a sentence somebody wrote rather than a gap in a table.",
    /* Never consulted — `check` is `null` — and stated anyway, so the table has
       one shape and the gate below needs no exception written into it. */
    applies: EVERYWHERE,
    check: null,
  },

  12: {
    why: "The floor of a judged rule, over the view root, and only at the reduced-motion half of the space — the still form is what the media query leaves standing, so the other half has nothing to read. What owes a still form is not named here: it is whatever rule 9's walk over the stylesheets finds an animation on, so an animation added anywhere under `src/` arrives with no still form registered and turns this rule red rather than passing unread. For each animated selector the entry asserts what its still form describes. Today that is two: the Route's claimed mark, where with reduce on the animation is gone, the ring authored underneath it is still drawn, and a row in another state still does not wear it; and the rack's lamp, where the ring is the lamp's own rather than a pseudo-element's, and what survives beside it is `N of M still running` in words. The lamp's lit-against-yielded pair is the one thing this suite cannot reach — the run readouts are not an axis of this space — and is settled in `tests/rack.test.tsx`. Whether what survives is the *same* distinction the motion carried is the judged residue: a machine can prove the two renderings still differ, not that the surviving difference is the one that was being made.",
    applies: (at) => {
      if (at.state.motion !== "reduced") {
        return "the still form is what `prefers-reduced-motion: reduce` leaves standing, and motion is on at this point of the space";
      }
      const blocked = ON_SCREEN(at);
      if (blocked !== null) return blocked;

      const animated = animatedSelectors();
      if (animated.length === 0) {
        return "no stylesheet under `src/` spends motion, so no distinction here is carried by it";
      }

      /* A selector with no still form registered is *not* a skip: it is the
         red this entry exists to produce, so it has to reach the check. */
      const unmet: string[] = [];
      for (const selector of animated) {
        const reason = STILL_FORMS[selector]?.applies(at) ?? null;
        if (reason === null) return null;
        unmet.push(reason);
      }
      return unmet[0] ?? null;
    },
    check: async (rendering) => {
      const animated = animatedSelectors();
      expect(
        animated.filter((selector) => !(selector in STILL_FORMS)),
        "spends motion with no still form registered to check",
      ).toEqual([]);
      expect(
        Object.keys(STILL_FORMS).filter((selector) => !animated.includes(selector)),
        "a still form is registered for an animation no stylesheet runs",
      ).toEqual([]);

      for (const selector of animated) {
        const still = STILL_FORMS[selector]!;
        if (still.applies(rendering) !== null) continue;
        await still.check(rendering);
      }
    },
  },

  13: {
    why: "The floor of a judged rule, over the view root: for every resolved node the model carries, its row is rendered, nothing in the chain above it has faded it to nothing, the point at its centre belongs to it rather than to something on top of it, and it takes focus from the keyboard. Salience is the residue — a row can clear all four and still be gone to a reader — and is not asserted.",
    applies: (at) =>
      ON_SCREEN(at) ??
      (nodesOf(at).some((node) => node.state === "resolved")
        ? null
        : "this fixture renders no resolved node"),
    check: async (rendering) => {
      const { surface } = rendering;
      const { root, map } = onScreen(rendering);

      for (const node of map.nodes.filter((node) => node.state === "resolved")) {
        const row = root.locator(surface.row(node.number));
        await expect(row).toBeVisible();
        await row.scrollIntoViewIfNeeded();

        const facts = await row.evaluate((element: HTMLElement) => {
          let opacity = 1;
          for (let up: HTMLElement | null = element; up !== null; up = up.parentElement) {
            opacity *= Number(getComputedStyle(up).opacity);
          }
          const box = element.getBoundingClientRect();
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          element.focus();
          return {
            opacity,
            hittable: at !== null && element.contains(at),
            focusable: document.activeElement === element,
          };
        });

        expect(facts.opacity, `#${node.number} is faded out`).toBeGreaterThan(0);
        expect(facts.hittable, `#${node.number} is not hit-testable`).toBe(true);
        expect(facts.focusable, `#${node.number} does not take focus`).toBe(true);
      }
    },
  },
};
