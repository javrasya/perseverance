# 22. The peek borrows the dial and springs back

Status: accepted (2026-08-31)
Context: [#52 The dial and the peek](https://github.com/javrasya/perseverance/issues/52),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on
[ADR 0021](0021-the-dial-is-four-detents-and-nothing-switches-by-itself.md),
which built the dial this glance borrows and left it exactly two things to
inherit: a position the store already holds, and one component that owns the
gesture.

`0022` and not the file count: `docs/adr/` holds two ADRs numbered `0010` and
`0005` was never written, so the number of files in the directory is no guide.
`0021` is the highest number in use.

## Context

The dial answers *how much window does the map get, for the next while*. It does
not answer *what does the map say right now, without me giving up the run I am
watching*. Moving the dial to `map` and back to read one line is three gestures
and a rearranged room, and the run's terminal is reflowed twice on the way.

Four decisions were not obvious.

**A peek borrows the real view rather than drawing a glance plate of its own.**
The map side that snaps down is the same DOM, the same view instance and the
same model as the one the dial divides — promoted out of flow, over the terminal,
at the width the `map` detent would give. A purpose-built plate — a compact
summary of the frontier, drawn only for glances — was the tempting alternative
and was rejected: at map width **no view stands down**, so the borrowed view is
the *biggest* map the window can give, and a resolved ticket recedes in salience
rather than in visibility. The conceded cost is real and accepted: a plate would
win the first 700 ms, because it could be tuned to say one thing. It would lose
every second after, because it would be a second rendering of the map — a thing
that can disagree with the first, maintained by nobody, and glanced at precisely
when there is no time to notice it is wrong.

**It occludes and never displaces.** Not one pixel of the terminal side moves: the
promoted layer is absolutely positioned against the body, so the flex line
underneath — map side, dial, terminal — is untouched, the pane's `ResizeObserver`
has nothing to report, and no PTY is resized. `Occasion` already had `peek` and
`resizes("peek")` was already `false`; this slice is what makes that arithmetic
true of the screen. The layer also stops short of the bottom of the body by a
named clearance — two terminal rows, plus the prompt block's own height when one
is drawn — because xterm's cursor sits at the bottom of its box, and an operator
who cannot see the row they are typing into is typing blind. The clearance is
computed in `src/panes/peek.ts` rather than guessed in CSS, so the reason is
written down next to the number.

**It borrows the position without moving it.** Peek state is a field of its own
beside `position`, `moveDial` is never called, and `src/panes/position.ts` — the
per-map memory — is never written. The dial control reads as `map` while the
spring is held, because that is what is on screen; the remembered position is
exactly what it was when the operator lets go. A glance may not rearrange the
room. At map width there is nothing to borrow, and the hold **says so** rather
than doing nothing: silence would be indistinguishable from a chord that never
arrived.

**Every way a hold can end is a release.** Hold-to-peek is keydown/keyup, and the
keyup is the event most likely never to arrive: a window that loses focus
mid-hold is never sent one, and a peek stuck open over a terminal that is still
taking keystrokes is a screen the operator is typing underneath. So a `blur`
releases it, a document that becomes hidden releases it, and **a gap in the
auto-repeat beyond 2500 ms releases it** — past the slowest OS repeat delay in
real use, and far short of a glance anyone means to hold. The same family of bug
owns the stud: `pointercancel` and the pointer leaving it are releases too, which
is also why the stud does not take pointer capture. All of it is policy over an
event sequence in `src/panes/peek.ts`, so `tests/peek.test.ts` asserts the
releases without a window to steal focus from.

## Decision

The peek is a spring-loaded promotion of the map side, held by a per-platform
chord or by a stud on the terminal's edge, releasing on every way a hold can end.

The chord is not portable and is not pretended to be. `⌘G` is macOS's; `Ctrl+G`
is `BEL` in every shell and may not be claimed, so everywhere else it is `Alt+G`.
The table is a pure function of a platform string, and the platform is read from
`navigator` behind one function — no Tauri OS plugin, no Rust command, because
both are round trips for a string the WebView already holds, and *which chord
summons the peek* may not be a question this side cannot answer while a command
is in flight. When the app claims the chord it **marks the swallow** on the stud,
because a key that vanishes without a mark is a key the operator will assume
their agent received. The chord is rebindable from a short offered list —
offered rather than captured, since capturing a keystroke means a second key
listener, and #53 owns key listening — and the binding persists behind the same
two-function seam `src/views/views.ts` keeps around the default view, so moving
it into the Rust `app` table changes one file.

The stud is not decoration. Discoverability of a spring-loaded gesture is this
feature's weak joint, exactly two places teach it — the stud and the keys page
#53 builds — and cutting either is cutting the gesture.

## Consequences

The peek costs one absolutely positioned wrapper inside the map side and one
window-level key binding. That binding is temporary by construction: it lives in
`src/panes/usePeek.ts`, at the window and in the capture phase, and #53's single
chord→action table absorbs it by deleting one effect. `Esc` is never claimed,
here or anywhere — it is the interrupt key of every agent CLI.

A machine with key repeat switched off sends one keydown and no more, so a peek
held past the repeat gap springs back on its own. That is the safe direction to
be wrong in: a peek that returns is a glance, and a peek that sticks is a screen
with keystrokes going somewhere invisible.

Nothing about whether a peek is up is carried by motion. The overlay appears at
once, under `prefers-reduced-motion` and without it, and what says a spring is
held is what is on screen plus the readout beside the stud — motion is rationed
to liveness, and a state only an animation announced would be a state a
reduced-motion window could not read.
