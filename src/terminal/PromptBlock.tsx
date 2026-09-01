import type { Rendered } from "../chrome/started";
import styles from "./PromptBlock.module.css";

/** What the badge says, and the two words the whole diagnosis turns on. */
export const STOCK_BADGE = "stock prompt";
export const CUSTOM_BADGE = "custom prompt";

export function charactersLabel(characters: number): string {
  return `${characters.toLocaleString()} characters`;
}

/**
 * What the run was told, collapsed.
 *
 * Reading the opening prompt is how a misbehaving run gets diagnosed, and a run
 * spawned from an operator's wholesale override is a different bug report from
 * one spawned from our own prose — which is the single fact the badge carries.
 * Both the badge and the count sit on the summary line rather than behind the
 * disclosure: they are the part that is read without unfolding, and neither may
 * hide in a `title`, which no keyboard and no reader reliably reaches.
 *
 * `<details>` and not a piece of state, because the browser already owns
 * open/closed here — including the keyboard and the accessibility tree — and
 * the unfold grows downward inside a capped box, so nothing beside it moves.
 *
 * The count is printed exactly as Rust gave it. It is **characters and not
 * bytes**, over prose full of em dashes, and recomputing it from a JavaScript
 * string length would quietly answer a different question.
 */
export function PromptBlock({ prompt }: { prompt: Rendered }) {
  const custom = prompt.origin === "custom";

  return (
    <details className={styles.block}>
      <summary className={styles.summary}>
        <span className={styles.badge} data-custom={custom ? "" : undefined}>
          {custom ? CUSTOM_BADGE : STOCK_BADGE}
        </span>
        <span className={styles.count}>{charactersLabel(prompt.characters)}</span>
      </summary>
      <pre className={styles.text}>{prompt.text}</pre>
    </details>
  );
}
