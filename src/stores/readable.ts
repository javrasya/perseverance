/**
 * The one store primitive, and the whole of it.
 *
 * A value, a way to read it, and a way to be told it changed. No reducers, no
 * selectors, no middleware and no context — a store here exists to give two
 * kinds of state two different lifetimes, and everything past that would be
 * machinery in the way of the distinction.
 *
 * **The reader and the writer are separate values.** `readable` hands back a
 * pair, and only the pair's second half can write; a component that is given the
 * first half has no setter to call. That is what makes *read-only to components*
 * a fact about what they hold rather than a rule somebody keeps.
 */

/** What a component is given: a value it can read and subscribe to. */
export interface Readable<T> {
  read(): T;
  subscribe(listener: () => void): () => void;
}

/** What the wiring is given: the one way to replace the value. */
export type Replace<T> = (next: T) => void;

/**
 * A store, split into what may be read and what may write.
 *
 * The value is replaced **wholesale**. There is no field setter and no merge, so
 * a component can never see a value half-updated, and two writes cannot
 * interleave into a state neither of them meant.
 *
 * A replacement with the identical value notifies nobody, which is what keeps a
 * poll that landed with no change in it from re-rendering the window.
 */
export function readable<T>(initial: T): [Readable<T>, Replace<T>] {
  let value = initial;
  const listeners = new Set<() => void>();

  const store: Readable<T> = {
    read: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const replace: Replace<T> = (next) => {
    if (Object.is(next, value)) return;
    value = next;
    // A copy, because a listener that unsubscribes during the notification
    // would otherwise shorten the set being walked.
    for (const listener of [...listeners]) listener();
  };

  return [store, replace];
}
