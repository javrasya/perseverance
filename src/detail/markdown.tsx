import { Fragment, type ReactNode } from "react";
import styles from "./markdown.module.css";

/**
 * The markdown subset the panel prints, parsed here and rendered as React
 * elements.
 *
 * **Sanitisation is structural rather than applied.** Nothing in this file ever
 * produces an HTML string: React's raw-markup escape hatch is not used, no
 * property is assigned a fragment of HTML, nothing parses text as a document,
 * and there is no other route from text to markup. Every leaf below is either
 * an element this file names or a JavaScript string handed to React, and React
 * escapes a string. So `<img src=x onerror=alert(1)>`
 * arriving from an issue body lands on screen as those twenty-nine characters —
 * not because a filter recognised it, but because there is no parser anywhere
 * in the path that could have made an element out of it. A blocklist is a list
 * of the attacks somebody thought of; this is the absence of the mechanism.
 *
 * `tests/no-raw-html.test.ts` holds the absence to the whole of `src/`, so the
 * property survives the next person who reaches for the fast way to draw a
 * table.
 *
 * ## What crosses the seam, and why it is markdown at all
 *
 * The string this renderer prints is lifted verbatim out of an issue body and
 * is therefore able to carry anything a GitHub author can type, raw HTML
 * included: the cut reason (`Cut::FromScope`). It is already on screen.
 * Rendering it is a display decision and stays on this side of the seam —
 * GitHub's render endpoint would spend a rationed request per paint, and asking
 * Rust to pre-render would put paint in a model whose whole claim is that it
 * carries text.
 *
 * The other operator prose on this side — the fog's region text over on The
 * Route — is **not** a customer of this renderer. It stays the one unmodified
 * text node `docs/adr/0016-the-fog-is-a-named-region-with-two-absences.md`
 * decided it is: this subset has no nested list, so a bullet the operator
 * indented would come out beside its parent, and the fog is bounded and counted
 * in Rust. Pointing it here is an amendment to ADR 0016 and not an import.
 *
 * ## The subset
 *
 * Paragraphs, line breaks, emphasis, strong, inline code, fenced code, bullet
 * lists, `#N` issue references, and links as *text plus their URL*.
 *
 * Deliberately outside it: headings, ordered and nested lists, block quotes,
 * tables, images, autolinks, reference links, footnotes, task lists, HTML.
 * Two different reasons, and both matter:
 *
 * - **Images and links are refused a way to navigate.** Nothing in this app
 *   renders a live external link (see the panel's *link out*), because the
 *   Tauri capability set grants no opener plugin and a bare anchor would
 *   navigate the WebView itself away from the app with no way back. A link's
 *   text and its URL are both printed, and neither is clickable.
 * - **Everything else is left out because the string that arrives here is a cut
 *   reason**, which is one sentence and perhaps some bullets. A subset that
 *   stopped where the input does is a subset that can be read in one sitting; a
 *   table parser nobody feeds is a table parser nobody tests.
 *
 * Unrecognised syntax is never dropped. A `> quote`, a `# heading` or a
 * `| table |` prints as its own literal characters, which is the honest
 * rendering of *this renderer does not know that one* — silently swallowing a
 * line would lose words an operator wrote. An underscore inside a word is held
 * to that same promise: a cut reason is prose *about code*, so `snake_case` and
 * `check:model_purity` leave with every character they came with, and only an
 * underscore at a word boundary is emphasis.
 */

/* --------------------------------------------------------------- inline --- */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "emphasis"; children: Inline[] }
  | { kind: "issue"; number: number }
  | { kind: "link"; children: Inline[]; url: string };

/* A number that names an issue, at a word boundary so `##1` and `a#1` are not
   references and print as themselves. */
const ISSUE = /^#(\d+)(?![\w#-])/;
const LINK = /^\[([^\]\n]*)\]\(([^()\s]*)\)/;

/* A character an identifier is made of. `_` beside one is part of a word. */
const WORD = /\w/;

/**
 * Whether `marker` at `at` is a marker at all.
 *
 * CommonMark's intra-word rule, and only for `_`: an underscore with a word
 * character to its left is inside an identifier — `snake_case`,
 * `check:model_purity`, a file name — and opens nothing. `*` keeps the naive
 * reading the subset documents, because `*` does not turn up inside words.
 */
function opens(source: string, at: number, marker: string): boolean {
  if (marker !== "_") return true;
  const before = source[at - 1];
  return before === undefined || !WORD.test(before);
}

/** Where a run of `marker` closes, or `-1` if it never does. */
function closes(source: string, from: number, marker: string): number {
  let at = source.indexOf(marker, from);
  // The same rule on the way out: an underscore followed by a word character
  // is the middle of an identifier and cannot be the closer, so keep looking.
  while (marker === "_" && at !== -1) {
    const after = source[at + marker.length];
    if (after === undefined || !WORD.test(after)) break;
    at = source.indexOf(marker, at + marker.length);
  }
  // An opener with nothing between it and its closer is two literal markers,
  // not empty emphasis.
  return at === from ? -1 : at;
}

/**
 * One line of markdown, as inline nodes.
 *
 * Left-to-right and single-pass, and unmatched openers fall through to text —
 * a lone `*` in prose is a lone `*` on screen. Nesting is by recursion into the
 * span an opener closed, which is why `**a `b` c**` keeps its code span.
 */
export function inlinesOf(source: string): Inline[] {
  const out: Inline[] = [];
  let literal = "";
  let at = 0;

  const flush = () => {
    if (literal.length > 0) out.push({ kind: "text", text: literal });
    literal = "";
  };

  while (at < source.length) {
    const rest = source.slice(at);
    const here = source[at] as string;

    if (here === "`") {
      const end = closes(source, at + 1, "`");
      if (end !== -1) {
        flush();
        out.push({ kind: "code", text: source.slice(at + 1, end) });
        at = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = closes(source, at + 2, "**");
      if (end !== -1) {
        flush();
        out.push({ kind: "strong", children: inlinesOf(source.slice(at + 2, end)) });
        at = end + 2;
        continue;
      }
    }

    if ((here === "*" || here === "_") && opens(source, at, here)) {
      const end = closes(source, at + 1, here);
      if (end !== -1) {
        flush();
        out.push({ kind: "emphasis", children: inlinesOf(source.slice(at + 1, end)) });
        at = end + 1;
        continue;
      }
    }

    if (here === "[") {
      const link = LINK.exec(rest);
      if (link !== null) {
        flush();
        out.push({
          kind: "link",
          children: inlinesOf(link[1] ?? ""),
          url: link[2] ?? "",
        });
        at += link[0].length;
        continue;
      }
    }

    if (here === "#") {
      const issue = ISSUE.exec(rest);
      if (issue !== null) {
        flush();
        out.push({ kind: "issue", number: Number(issue[1]) });
        at += issue[0].length;
        continue;
      }
    }

    literal += here;
    at += 1;
  }

  flush();
  return out;
}

/* --------------------------------------------------------------- blocks --- */

export type Block =
  /** Lines of one paragraph; the breaks between them are kept. */
  | { kind: "paragraph"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  /** Verbatim, and never scanned for inline syntax. */
  | { kind: "code"; text: string };

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * Source text as blocks.
 *
 * A fence that is never closed runs to the end of the input rather than
 * reverting to prose: an unterminated fence is a typo in a map document, and
 * printing the rest as code is the reading that loses nothing.
 */
export function blocksOf(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] ?? "";

    if (line.trim().length === 0) {
      at += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !FENCE.test(lines[at] ?? "")) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      at += 1;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (at < lines.length) {
        const item = BULLET.exec(lines[at] ?? "");
        if (item === null) break;
        items.push(item[1] ?? "");
        at += 1;
      }
      out.push({ kind: "bullets", items });
      continue;
    }

    const paragraph: string[] = [];
    while (at < lines.length) {
      const next = lines[at] ?? "";
      if (next.trim().length === 0 || FENCE.test(next) || BULLET.test(next)) break;
      paragraph.push(next);
      at += 1;
    }
    out.push({ kind: "paragraph", lines: paragraph });
  }

  return out;
}

/* ------------------------------------------------------------ rendering --- */

function inline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return (
          <code key={index} className={styles.code}>
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "emphasis":
        return <em key={index}>{inline(node.children)}</em>;
      case "issue":
        /* A reference and not a link: this app has no way to open one, and a
           number an operator can read off the screen is what they type at `gh`
           anyway. */
        return (
          <span key={index} className={styles.issue}>
            #{node.number}
          </span>
        );
      case "link":
        /* Both halves, and neither navigable. A link whose text says one thing
           and whose href goes somewhere else is the oldest trick there is, and
           printing the URL beside the words is what makes the two comparable. */
        return (
          <span key={index} className={styles.link}>
            {inline(node.children)} <span className={styles.url}>{node.url}</span>
          </span>
        );
    }
  });
}

function lines(text: readonly string[]): ReactNode {
  return text.map((line, index) => (
    <Fragment key={index}>
      {index > 0 ? <br /> : null}
      {inline(inlinesOf(line))}
    </Fragment>
  ));
}

/**
 * Markdown from an issue body, on screen.
 *
 * Source that is nothing but whitespace renders nothing at all — the caller
 * decides what an absence says, because only the caller knows which field is
 * absent and why.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className={styles.markdown}>
      {blocksOf(source).map((block, index) => {
        switch (block.kind) {
          case "paragraph":
            return <p key={index}>{lines(block.lines)}</p>;
          case "bullets":
            return (
              <ul key={index}>
                {block.items.map((item, item_index) => (
                  <li key={item_index}>{inline(inlinesOf(item))}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre key={index} className={styles.fence}>
                <code>{block.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
