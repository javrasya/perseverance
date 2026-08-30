# ADR 0013 — Lag-drop cannot mean dropping bytes

**Status:** accepted, #47

## Context

A run's PTY produces bytes faster than a WebView can render them. During a build
or a test suite, an agent CLI can produce megabytes in a few seconds, and every
one of those bytes has to reach an xterm.js instance across an IPC boundary.

The obvious answer is the one every naive terminal harness reaches for: when the
consumer falls behind, drop some of the backlog and send the newest. It is what
every sampling pipeline does — drop frames, drop log lines, drop metrics — and it
keeps the memory bounded and the screen current.

It is also wrong here, and wrong in a way that does not announce itself.

## Decision

**No path in this app ever hands over a non-contiguous byte range.**

A VT stream is not sampleable. It is not a sequence of independent records, it is
a single stateful parse: `ESC [ 3 8 ; 5 ; 2 0 1 m` is one instruction, and a
range discarded in the middle of it leaves the terminal parsing `201m` as text
and then reading the next escape from the wrong offset. The damage is not the
missing bytes — it is that the emulator's parser, its character set state, its
alternate-screen flag and its scroll region are now permanently wrong, for the
rest of the session, with no way for anything downstream to notice or recover.
An operator sees an agent that has apparently started printing garbage.

So the three mechanisms that could each have been a byte drop are each something
else instead:

- **The ring reduces only from the front.** `Ring` drops whole reads off the
  oldest end, never from the middle, so what it holds is always a contiguous
  *suffix* of the stream. Every byte has one permanent absolute offset, and the
  ring answers *do you still have offset N* with a yes or a no rather than with
  an approximation.
- **The channel stops rather than samples.** `Tap` has three answers and none of
  them is a shortened range: a contiguous continuation, a whole replay, or
  nothing at all. When the WebView falls behind — measured by what it has
  confirmed, not by a rate — the run is marked desynced and **nothing more is
  sent**. It comes back by resetting the terminal and replaying the ring whole.
- **Truncation is chrome, never a byte.** When the ring has dropped scrollback,
  that is reported as a count on the readout beside the terminal. Writing
  *scrollback lost* into the stream would make the terminal's contents no longer
  only what the agent said, and nothing afterwards could tell the two apart.

The throttling that does exist is on the channel and never on the wire. The drain
thread reads the PTY into the ring and consults nothing — no subscriber, no
channel, no WebView — so a window that has stopped taking bytes cannot slow a
child down. **A run nobody is watching is drained on identical terms**, which it
has to be: an unread PTY fills its pipe and blocks the agent.

## Consequences

**What it costs.** Memory is bounded by the ring rather than by the consumer, at
512 KiB per live run. A WebView that falls a long way behind gets a full replay
rather than a quick catch-up, which is a visible flicker and a reset scroll
position. And a run whose ring overran while it was unwatched loses its oldest
output permanently — the operator is told how much, but cannot get it back.

**What it buys.** The terminal's contents are always a contiguous window of what
the agent actually printed, and that is checkable rather than hoped for:
`a_non_contiguous_byte_range_is_never_handed_over_under_any_schedule` drives four
thousand adversarial steps of a producer far faster than the ring against a
consumer that confirms late and partially, and asserts after **every single step**
that what the far end holds is exactly `stream[through - length .. through]`. A
splice fails on the step that produced it.

**What it does not decide.** How a run ends, and how a quit ends every run, are
#49's and #51's. This ADR is only about what may cross while one is running.

## Alternatives turned down

**Drop the oldest backlog and send the newest.** The failure above, and it is
silent: nothing on either side of the seam can detect that a parse has gone
wrong, so the first report is an operator saying the agent printed nonsense.

**Re-encode to a safe boundary — parse the stream and only cut between complete
sequences.** This means writing a VT parser in the harness in order to avoid
handing bytes to a VT parser. It would have to be as correct as xterm.js about
every sequence xterm.js supports, and any disagreement is the same corruption
with more code behind it.

**Send everything, unbounded.** Then the ring is the WebView's memory and a
`cargo build --verbose` in a background worktree is an out-of-memory crash.

**One channel per run rather than per monitored run.** Bytes for runs nobody is
looking at, several megabytes at a time, to be written into terminals nobody is
reading. The runs are all drained regardless — that is the wire, and it is not
optional — so what this would add is IPC traffic and nothing else.
