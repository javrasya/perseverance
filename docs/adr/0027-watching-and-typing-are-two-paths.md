# 27. Watching and typing are two paths, and warm is a flag on the binding

Status: accepted (2026-08-31)
Context: [#57 The patchbay](https://github.com/javrasya/perseverance/issues/57),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on [ADR 0025](0025-the-racks-tier-is-a-function-of-width-not-of-n.md),
whose rows become this ticket's selector, and on
[ADR 0026](0026-the-caret-parks-and-the-keystrokes-spill.md), which captured the
spill and left the offer here on purpose. It amends both, and it amends
[ADR 0025](0025-esc-is-a-readout-not-a-binding.md) in one place.

`0027` and not `0005`: `0005` was never written and is left where it is, and
`docs/adr/` holds two ADRs numbered `0010`, two `0020`, two `0022`, two `0023`,
two `0024` and five `0025`. The number is one above the highest on disk, which
has not been the file count for a long time.

## Context

The terminal region had one binding, and that one binding meant two things at
once: the run whose bytes are drawn here, and the run the keyboard is typing at.
While the two are the same run the conflation costs nothing, and that is why it
survived several tickets.

It stops being free the moment an operator wants to read a run they are not
typing at — which is the ordinary case this app exists for. A run wedges; the
operator wants to look at what it last printed while the run they are actually
driving keeps going. With one binding, looking is moving: the only way to put a
run on screen is to put the keyboard in it.

The repair is not to add a second run id beside the first. Two ids side by side
can be written down disagreeing — the keyboard on a run whose output is not on
screen — and that state has a name: typing blind. It is the one failure the
ticket exists to forbid, and forbidding it by convention means every future
writer of either field has to know the convention. The ticket asked for the
property to be unrepresentable rather than tested, and a test cannot deliver
that; it can only report the first time somebody breaks it.

There is a third thing the old reading got wrong, and it is a vocabulary
problem rather than a state problem. *Warm* was read as *the terminal is the
room I am in*. It is not: the dial is a room, and temperature is a destination.
A window can be turned all the way to the terminal with nothing warm, and it can
sit on the map with a run still holding the caret.

## Decision

**The terminal region is a monitor, the runs are sources, and the patchbay is
what joins them. Temperature is a boolean *inside* that join.**

**One run id in the store, and warm is a flag on it.** `Ui` carries
`monitored: number | null` and `keyed: boolean`, and `keyedRun(ui)` — which
answers `ui.keyed ? ui.monitored : null` — is the only reading of the
temperature there is. There is no second run id for a reader to disagree with,
so *the keyed run is on the monitor* is a property of the type: warm ⊆ monitored
is not asserted anywhere, because there is nowhere to write the counterexample
down. The degenerate `{ monitored: null, keyed: true }` is unreachable from
outside too — `setKeyed(true)` with nothing monitored is refused rather than
recorded, and `keyedRun` would answer `null` over it in any case. Cooling is
always legal, including when it changes nothing.

**Warm is single-valued; cold is the map's own colour.** At most one surface is
warm at a time, and *nothing warm* is not an absence of information — it means
the keys are on the map. That asymmetry is why this is one flag and not a
temperature per surface, and it is what gives `keysGo` a total answer in every
state: a surface in front holds the keys while it is up, a warm run has them
next, and with nothing warm they are on the map.

**A re-patch cools.** `monitor(run)` writes `keyed: false` in the same change
that moves `monitored`, so putting a different run on the monitor never carries
the keyboard along with it. Every row in the rack is a `<button>` whose press is
`monitorRun` then `monitor`, which makes the rack the selector and makes
watching a one-press gesture that moves nobody's keystrokes. What warms is a
person saying so: the crossing chord toward the terminal, and focus landing
inside the pane. Nothing automatic warms anything — a poll that moved the caret
would hand the next sentence an operator typed to an agent they never chose.

**The keyboard can therefore be aimed at a pane that is read-only, and the
keystrokes are held.** A run whose child has stopped keeps the caret under
[ADR 0026](0026-the-caret-parks-and-the-keystrokes-spill.md)'s parking rule, so
the spill register keeps filling with a stopped run warm. #57 adds the second
half 0026 deferred: the words are *offered* to the live work run, on a press,
with the destination named on the button.

**The offer's join is the folder, and never the run number alone.** This window
holds every folder's runs at once, so *some other run is still going* is only
the question anybody meant when it is asked inside one repository. `offeredTo`
matches on the parked run's `folder`, and additionally on `work`, still going,
and not the parked run itself — the same pair `liveRunOn` and Rust's
`live_run_on` match on. A parked run whose `folder` is `null` is joined to
nothing and offered nothing: falling back to *any live work run* would be
exactly the cross-repository hand-off the join exists to prevent.

**The offer moves text and nothing else.** `typedAtRun(work, text)` lands the
sentence in the work run's child; the register is dropped only after the send
comes back, and a send that fails leaves the words on screen to press again. The
caret does not move, the monitor does not re-patch, nothing warms and no run
ends. A hand-off of text is not a decision about where to type next.

Keeping the caret takes more than a handler that touches no state: a parked run
is warm, so its keys are in xterm's helper textarea, and a mouse press that
focused the offer button would take them out of the pane's host node — which the
pane's own `focusout` watcher would rightly read as the keyboard leaving, and
cool the run the offer was made for. The button refuses the focus on
`mousedown`, so the press has nothing to write back. Reaching the button by
`Tab` does move the keys, and that is the operator moving them, not the offer.

## Consequences

`Esc` gains a third destination, and it is a destination rather than a gap: with
a run cold on the monitor the key is claimed by nobody and reaches nothing at
all. `escDestination` reads `warm` and not `monitored` to know it, and says so in
words — naming the agent CLI over a cold run would promise an interrupt that
never arrives. That is recorded as an amendment in
[ADR 0025](0025-esc-is-a-readout-not-a-binding.md) rather than left to be
inferred from this file.

The rack stops being only a readout. Its rows carry an affordance now, and
[ADR 0025](0025-the-racks-tier-is-a-function-of-width-not-of-n.md)'s sentence
saying they do not is amended there. What a row press moves is `monitored`; what
it does not move is the keyboard.

The window has to say out loud where the keys go, because it can now be somewhere
the room does not imply. `keysGo` is that sentence, computed from the same
routing table `Esc`'s readout is computed from, and it names a run the way the
rack names one — `nameOf`, ticket else number, one vocabulary for one run. The
parked case is a fourth *sentence* and not a fourth state: the temperature is
unchanged and true, and what the operator is owed is the reason their typing is
not reaching anybody.

The pane's absent offer is two readings and not one, because `offeredTo` has two
absences. A known folder with no live work run in it is a count that came out
nought (`NOWHERE_TO_OFFER`); a run this window was never told the folder of is a
fact the harness never gave (`NO_FOLDER_TO_JOIN`). Collapsing them would name a
folder the window does not have, which is the distinction
[ADR 0016](0016-the-fog-is-a-named-region-with-two-absences.md) draws for the fog
and [ADR 0025](0025-the-node-panel-is-one-element-with-three-addresses.md) draws
for the panel's unlit fields.

The cost is a gesture the operator has to learn: patching the monitor and taking
the keys are two presses where there used to be one. That is accepted, and it is
the price of the property — a window where looking is free is a window where
looking cannot cost you a sentence typed into the wrong agent.

## What would falsify this

- A second run id for the warm surface anywhere in the UI store, or any reader
  assembling the temperature from `monitored` and `keyed` itself instead of
  through `keyedRun`.
- A run warm while a different run is on the monitor — which should be
  impossible to write down; if it becomes writable, this decision is gone.
- A row press, a poll, a readout tick or a death that warms a run.
  `tests/patchbay.test.tsx` and `tests/parked-caret.test.tsx` press and poll and
  assert the temperature after.
- `monitor(run)` leaving `keyed` as it found it, so a re-patch carries the
  keyboard onto the newly shown run.
- An offer that crosses folders, or one made for a parked run with no folder —
  `tests/parked-caret.test.tsx` holds both.
- An offer that moves the caret, re-patches the monitor or ends a run, or one
  that drops the register before the send has come back — the caret included
  when the press moves it by taking the focus, which no unit test can see:
  jsdom's `.click()` moves no focus, so this one is held by the button refusing
  the press's default and by nothing else.
