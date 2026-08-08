import { OPENING, type Geometry } from "../stores/ui";
import { reparent, stow } from "./reparent";
import type { Delivery } from "./runs";

/**
 * One terminal, as everything but the factory sees it.
 *
 * xterm.js is behind exactly one implementation of this and nothing else names
 * it. That is not indirection for its own sake: the invariants this file exists
 * to hold — one instance per run, moved rather than remounted, reset only on a
 * replay — are about *identity and lifetime*, and asserting them against a real
 * xterm would mean a test that needs a canvas, a font and a layout engine to say
 * something that has nothing to do with any of the three.
 */
export interface Terminal {
  /** The node that gets moved. The terminal *is* what lives inside it. */
  readonly element: HTMLElement;
  write(bytes: Uint8Array): void;
  /** Everything on screen, and everything remembered, gone. */
  reset(): void;
  resize(geometry: Geometry): void;
  /**
   * How many characters fit in the box this terminal is currently in, or `null`
   * when it has no box yet.
   *
   * Asked of a terminal rather than computed from pixels because the answer
   * depends on the font the emulator actually resolved, which nothing outside it
   * knows. It is a *measurement*, not a resize: reading it changes nothing.
   */
  measure(): Geometry | null;
  /** Keystrokes out. Returns the way to stop listening. */
  onData(handler: (text: string) => void): () => void;
  dispose(): void;
}

export type Factory = (geometry: Geometry) => Terminal;

/**
 * Every run's terminal, one each, for as long as the run is on the list.
 *
 * **An instance is created once per run and then only ever moved.** Binding a
 * run to the pane reparents its node; unbinding puts it back in the stow, still
 * mounted, still holding every byte it was ever written. Nothing here remounts,
 * and nothing here resets except on the one delivery that says to.
 *
 * That matters because of what the harness can and cannot do. It holds a bounded
 * ring of bytes, not a screen; if a terminal were thrown away, the only way back
 * would be a replay, and a replay only reaches as far as the ring — so a run
 * watched for an hour would come back missing its first fifty-nine minutes. The
 * terminal is the memory, and this is what keeps it alive.
 */
export class Terminals {
  private readonly terminals = new Map<number, Terminal>();
  private readonly bindings = new Map<number, () => void>();

  constructor(
    private readonly make: Factory,
    private readonly geometry: () => Geometry = () => OPENING,
  ) {}

  /**
   * This run's terminal, made if it is the first time it has been asked for.
   *
   * A new terminal is opened **at the geometry every other live run is already
   * at** — read, never set. That is this side's half of *never resize on bind*:
   * arriving does not put a size to anything, because the size was already
   * decided by the last settled gesture.
   */
  for(run: number): Terminal {
    const held = this.terminals.get(run);
    if (held !== undefined) return held;

    const made = this.make(this.geometry());
    // Into the stow rather than nowhere, so it can measure itself from the
    // moment it exists — see `reparent.stow` for why that is not the same as
    // being in the document at all.
    stow().appendChild(made.element);
    this.terminals.set(run, made);
    return made;
  }

  /** Whether this run has a terminal yet, without making one. */
  has(run: number): boolean {
    return this.terminals.has(run);
  }

  get size(): number {
    return this.terminals.size;
  }

  /**
   * Put a run's terminal on the pane, and every other run's back in the stow.
   *
   * `null` empties the pane without ending anything: the terminals that come off
   * it keep every byte they hold, which is what makes coming back to a run a
   * continuation rather than a replay.
   *
   * Returns whether anything moved.
   */
  bind(run: number | null, pane: HTMLElement | null): boolean {
    let moved = false;

    for (const [held, terminal] of this.terminals) {
      const into = held === run ? pane : null;
      if (reparent(terminal.element, into)) moved = true;
    }

    // A run with no terminal yet is made on the spot, because binding is how a
    // run first reaches a screen.
    if (run !== null && !this.terminals.has(run)) {
      const made = this.for(run);
      if (reparent(made.element, pane)) moved = true;
    }

    return moved;
  }

  /**
   * One delivery, applied.
   *
   * The whole of the contract with the harness, and it is two lines: a replay
   * resets first, a continuation does not. There is no third case to get wrong,
   * because there is no third kind of delivery — which is what makes *the
   * terminal holds a contiguous window of the stream* a property of this method
   * rather than of a reassembly buffer somewhere.
   */
  apply(run: number, delivery: Delivery): void {
    const terminal = this.for(run);
    if (delivery.kind === "replay") terminal.reset();
    terminal.write(delivery.bytes);
  }

  /** Every live run resized, once. Called from the settled gesture and nowhere else. */
  resize(geometry: Geometry): void {
    for (const terminal of this.terminals.values()) terminal.resize(geometry);
  }

  /** Where a run's keystrokes go. Replaces whatever was listening before. */
  types(run: number, into: (text: string) => void): void {
    this.bindings.get(run)?.();
    this.bindings.set(run, this.for(run).onData(into));
  }

  /**
   * A run that is over and resolved. Its terminal is disposed here and nowhere
   * else — **a run that has merely finished is not forgotten**, because the last
   * thing the agent said is the thing the operator is about to read.
   */
  forget(run: number): void {
    this.bindings.get(run)?.();
    this.bindings.delete(run);
    const terminal = this.terminals.get(run);
    if (terminal === undefined) return;
    terminal.element.remove();
    terminal.dispose();
    this.terminals.delete(run);
  }

  forgetAll(): void {
    for (const run of [...this.terminals.keys()]) this.forget(run);
  }
}
