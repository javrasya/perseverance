# 24. A compose holds no claim, so the live run is the claim

Status: accepted (2026-08-31)
Context: [#66 Composing the spec](https://github.com/javrasya/perseverance/issues/66),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28). It
rests on
[ADR 0020](0020-the-revalidation-is-an-awaited-poke-with-a-deadline.md) for what
a press does before it spawns anything, and on
[ADR 0021](0021-the-rail-is-four-sockets-and-a-press-carries-its-own-adapter.md)
for what the button is — and it **amends** that ADR's crossing sentence, which
enumerated `railAt`'s arguments as they stood before this ticket. The amendment
is spelled out under Consequences and noted in 0021 itself.

`0024` and not `0022`: [#49](https://github.com/javrasya/perseverance/issues/49)
holds `0022` and `0023` on its own branch. A number is claimed when it is
written, not when it merges.

## Context

The fifth prompt template, `compose-spec`, is a run unlike the four before it.
It is aimed at the **map** rather than at a ticket, it is offered only once
every ticket on that map is closed, and what it produces is a single
`wayfinder:spec` child hung off the map. The template copies the `/to-spec`
skill's document shape and leaves the skill untouched — the destination pins the
document's shape — and the four rules that are the harness's rather than the
skill's ride as prose steps in the template: attach the spec as a sub-issue and
create-and-apply `wayfinder:spec`; read the map body first and zoom selectively;
spill past GitHub's 65,536-character body limit into comments rather than
truncating or splitting; enumerate the sources you did not read.

Every other run this app starts is aimed at a ticket, and the assignment it
takes is the record that the ticket is taken. A compose has no ticket to assign,
and a map is not assignable either, so the one mechanism that keeps the same
work from being done twice is missing exactly where its failure is most
expensive. Two compose runs on one map do not collide and do not overwrite: they
each attach their own `wayfinder:spec` child, and the sub-issue that rule three
exists to keep as a **node** quietly becomes a **set**. Nothing downstream that
resolves a map's spec by that label would be wrong about which of the two it
found — it would just be arbitrary.

Two smaller questions came with it. Where on the rail the verb goes, given that
ADR 0021 fixed the rail at four sockets in one order. And what gates the offer,
given that the reading the rail already had — the frontier — answers a different
question than the one being asked.

## Decision

**The offer is ink in the Start Working socket, not a fifth socket.** ADR 0021's
rule is that a socket is the layout and the button in it is the ink, and a
socket that materialises when a map finishes is precisely the rail that changes
shape under a hand already on the way to it. It costs nothing to obey here: a
spec-ready map has no takeable ticket left, so the primary box is idle at
exactly the moment the compose wants it. Same box, different word
(`COMPOSE_LABEL` rather than `START_LABEL`), different aimed number — the map's
rather than a ticket's. The discrimination is made in `startTarget` in
`src/chrome/sockets.ts`, which returns a `StartTarget` that is either
`{ kind: "ticket" }` or `{ kind: "compose" }`, so the rendering goes on choosing
nothing: it presses what the derivation handed it.

**The phase gates the offer, and the frontier cannot.** `Phase::SpecReady` is
exactly *every ticket on this map is closed and no spec exists yet*, derived
once in `crates/model/src/derive.rs`, and it is the only rung a compose is
offered from. The frontier cannot stand in for it, and not because it is
inconvenient to read: it answers a different question. The frontier says which
ticket is takeable next, and a map with nothing takeable left reads the same
whether its tickets are all closed or this machine can start none of them. Only
the rung tells *finished* from *stuck*, and a compose offered on *stuck* would
brief a session to write a spec about work nobody did. A compose has no ticket
at all, so there is nothing for a frontier to designate in the first place. The
harness asks the same question over the same ladder, exhaustively and with no
wildcard, in `why_the_spec_is_not_composable`: a sixth rung has to be a compile
error rather than a map silently offered a compose it has no business being
offered.

**The duplicate press is refused on run liveness — not on the phase and not on
GitHub.** `compose_spec` deliberately never asks for a `Claims` handle; there is
nothing here to claim. What it stakes is the map's number. So the guard is a
join of the two tables `Terminals` owns — the registry says which runs have not
ended, the stakes say what each of them is for — and `Terminals::composing(map)`
is where that join is made. The phase cannot be the guard because the spec is
the run's very last act: the map reads `SpecReady` for the whole of the compose,
so every rung check above the guard answers a second press exactly as it
answered the first. GitHub cannot be the guard for the same reason, one round
trip more expensively — during a compose the child does not exist yet, so the
truthful remote answer and the answer that would wave a second session through
are the same answer.

**Liveness is the registry's reading and never the stake's.** A stake outlives
its run on purpose, so that a run which has exited can still be named in the
quit confirmation. A guard written as *a compose is staked to this map* would
therefore refuse every press for the rest of the launch, and a compose that died
before writing anything would leave its map with no way to get a spec at all.

**The guard is said twice, once per side, and the harness is the enforcing
half.** `crossing.composing` carries the map this window's own compose is still
writing for, and the primary socket recesses on it with `alreadyComposing(map)`
— the same sentence `a_compose_is_already_open` refuses with, named on both
sides so the operator reads the same reason whether the rail worked it out or
the harness did. The rail is never the whole of the guard: a press that gets
past a stale socket is still refused in Rust. Leaving it to Rust *alone* was the
tempting version, and it fails on ADR 0021's own terms — that rail exists so an
unavailable verb prints the condition that would fill it, and *a compose is
already going* is such a condition. A filled button that answers a press with a
refusal sentence is the same undiscoverable control 0021 rejected, arriving one
press later.

**One run, in the foreground.** No reduce, no staged outline, no per-area pass.
The child goes down the ordinary PTY path and is monitored like any work run,
and the four harness rules are prose the session follows rather than stages this
side drives.

## Consequences

**The crossing now reads run liveness, so ADR 0021's enumeration widens.** That
ADR recorded the rail as a pure function of the crossing and spelled the
crossing out as `railAt(frontier, selection, adapters, folder, press)`. On this
branch `railAt` takes the `Crossing` whole, and the crossing carries `phase`,
`map` and `composing` as well. The property 0021 asserted is untouched — the
rail is still arithmetic over one value, still asserted in
`tests/sockets.test.ts`, and still leaves only the wiring to a mounted test.
What is new is the *kind* of reading one of those fields is: `composing` comes
from neither the model nor the folder but from this window's own runs, plumbed
in `src/App.tsx` as the runs it started that are not over. It has to. A compose
assigns nobody and its map stays on `specReady` throughout, so the snapshot says
the same thing during a compose as it says before one, and the window's own
spawn is the only trace of it this side has. 0021's sentence is amended in this
ticket to name the arguments the function actually takes.

**The primary socket now carries two verbs.** 0021 framed the rail as four
verbs in four sockets; it is four sockets still, but *Start Working* and
*Compose Spec* share one, and the two are mutually exclusive by the rung rather
than by a preference. Anything reading the rail by label has to read the aimed
number with it, because a compose aims at a map and a work press aims at a
ticket.

**A compose that dies latches nothing.** That is the point of reading the
registry rather than the stakes, and the cost is real: a compose killed halfway
leaves whatever it already wrote on GitHub, and nothing in this app remembers
that it happened. There is no half-composed state to inspect — the map's
children are the record — and the next press is offered again, immediately.

**The guard is per launch on both sides.** A compose started by a previous run
of the app is invisible to `Terminals::composing` and to `crossing.composing`
alike, because neither table survives the process. A finished compose is still
caught by the rung, since the map reads `specced` once its child lands; an
*unfinished* one from a previous launch is not caught at all. Catching that
would mean a durable record of in-flight runs, which is a larger decision than
this ticket, about a window that closes when the app does.

**The one-run rule is dated, not permanent.**
[#28](https://github.com/javrasya/perseverance/issues/28) says to revisit it at
roughly 55 closed tickets. Below that size, the map body plus selective zoom is
one session's reading, and one foreground run is the simplest thing that keeps
`wayfinder:spec` a node. Above it, the reading stops fitting, and the choice
becomes a reduce, a staged outline, or per-area passes — each of which puts
several runs on one map and so reopens exactly the question this ADR answered
with a single live one. The trigger is written here so the revisit is a decision
someone takes rather than a limit someone runs into.
