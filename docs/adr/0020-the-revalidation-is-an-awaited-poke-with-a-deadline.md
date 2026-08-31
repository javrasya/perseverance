# 20. The revalidation is an awaited poke, on the poller's own thread, with a deadline

Status: accepted (2026-08-31)
Context: [#48 Start Working and the run it
opens](https://github.com/javrasya/perseverance/issues/48), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). ADR 0003 settled that
GitHub is read on one blocking thread this app owns; ADR 0007 composed the three
floors that thread waits under, and this is the first thing that has to wait for
one of them on a person's behalf.

## Context

Start Working re-reads GitHub before it spawns, with the button showing
`checking…`. The read itself is the ordinary one — a poll — and the ticket is
explicit that it happens *on the same code path*, so that a race this press
loses lands on the graph and feeds the change ledger exactly as any other tick
does. What was missing was a way to **wait for one**.

Nothing could observe a tick from outside. `Poke` is fire-and-forget and carries
no reply; `Poker::poke` sends and drops the error. `start(timings, tick)` moves
the caller's closure onto the poller thread and folds every outcome into private
`Watch` state, so a tick's *effects* — the two emits — were the only way the app
learned anything at all.

Three shapes were available.

**Wait for the emitted `maps` or `snapshot` event, from the WebView.** The
weakest of the three: the WebView would be inferring *my* read from an event
that any other pass also produces, with no way to tell one from the other, and
the press would be gated on a listener rather than on a read.

**Call `poll_once` from the command thread.** It needs an `Ahead<'_>`, whose only
real implementation is `Watch::ahead` over the loop's private state, and it would
be a second reader running while the poller thread has one in flight. *No two
reads at once* is not a rule anywhere in this codebase — it is a consequence of
there being one thread, and this would be the change that made it a rule someone
has to remember.

**A poke carrying a one-shot reply**, which is what landed.

## Decision

`Poke::Revalidate(Reply)`, where `Reply` is a newtype over a shared
`Sender<Tick>`. The pass it buys is the ordinary pass: same closure, same
thread, both surfaces emitted, `claims.originated()` still excluding a
self-caused claim from the ledger's announcements. The reply carries only *what
the pass came to*; the caller reads what it learned where every other reader
does, from the snapshot that pass emitted.

The reply rides **inside** the enum rather than on a second channel, because a
second channel is a second thing to wake on and this loop has one
`recv_timeout` and no runtime to select with. `Poke` keeps its `PartialEq` and
`Eq` — every test in `poller.rs` compares pokes by value — by writing `Reply`'s
two impls by hand: two requests are the same request when they are the same
allocation, which is the only identity a sender has here.

`Poker::revalidate(within)` takes a **deadline**, and its answer has a variant
for running out. Floors apply to pokes: `ladder_floor` answers `POKE_FLOOR` for
a poked pass, and the budget and backoff floors answer far more, all through the
same `max`. So an awaited poke can be held a second, or an hour, and a wait with
no end is a button that hangs. What runs out is the *wait* and never the read —
the pass still happens, still emits, still lands.

`Poke::Revalidate` is a **human** poke, so it clears a backoff exactly as
opening a folder does. `Tick::NotAttempted` — a launch whose harvest has not
settled — is one of the answers, and it is not a read: a caller about to spawn
acts on `Tick::Read` and on nothing else.

## Consequences

The guard is a **UX guard and not a correctness guard**, and this ADR is the
place that says so. Two machines can revalidate in the same second and both
spawn; the correctness guard is the agent's conditional claim, because the agent
is the only writer. What this buys is that the common case — a frontier that
moved while a person was reading the screen — refuses before anything is
written, and names the new target so the press has to be made again.

A refusal from a deadline that ran out and a refusal from a frontier that moved
are different answers, and the command's return keeps them apart: only the
second one names a frontier, because only the second one learned of one.

The loop gains one list — everybody waiting on the next pass — and answers it
after folding the outcome in for real, so what a caller is told is what the loop
concluded rather than a prediction taken before it. Two presses inside one wait
are two callers owed the same answer, which is why it is a list.
