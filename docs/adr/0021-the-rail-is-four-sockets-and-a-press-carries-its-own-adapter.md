# 21. The rail is four sockets that are always there, and a press carries its own adapter

Status: accepted (2026-08-31)
Context: [#48 Start Working and the run it
opens](https://github.com/javrasya/perseverance/issues/48), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28). ADR 0020 settled what
the command does behind the button; this settles what the button is. ADR 0011
settled how a folder resolves an agent, and this is the first surface that has
to *choose* between what it resolved.

## Context

Four verbs live at the crossing between what the map says and what a run is
doing about it: Start Working, Resume, Ask, To Frontier. Only the first and the
last are built — Resume is #49's and Ask is #55's — and at any moment most of
them are unavailable for reasons that differ: no map is open, nothing on this
map is takeable, the frontier belongs to another machine, no agent CLI resolved
in this folder, the selection is already on the frontier.

The obvious shape is a toolbar that shows the buttons that work. It is also the
one that cannot be read. A control that appears when its condition is met is a
control an operator has to *discover*, and a rail whose height changes as the
poller lands is a rail that moves under a hand already on the way to it. Worse,
it answers *why not* with silence: an absent button and a button for a thing
this build does not do yet look identical, and neither says which.

The second question was where the adapter comes from. This folder can resolve
`claude`, `codex` and `pi`, or any subset, and the resolution is per folder —
that is the whole of #45. A global *default agent* setting would be a fact about
the app deciding a fact about the folder, and it would be read at a moment
nobody is looking at it.

## Decision

**Four sockets, in a fixed order, in the document at all times.** A socket is
the layout; the button in it is the ink. A state change repaints a socket and
never adds or removes one, so nothing on the rail moves as the poller lands. An
unavailable button is **recessed in the same box** — same size, same position,
still focusable, still in the accessibility tree — and prints the condition that
would fill it as **visible text** underneath. Never a `title`: a reason only a
hover can reach is a reason a keyboard, a screen reader and a photograph of the
screen all lack. Resume and Ask ship as recessed sockets with their condition
printed, which is how the rail's shape stops depending on which ticket has
landed.

`checking…` is a **third reading and not a recessed one**. The word replaces the
verb, the box keeps its edge, and the button takes no press until the answer
lands — a second press inside that window is not a second command. It is ink
rather than motion, deliberately: this app rations movement to liveness, the
whole stack contains one `@keyframes`, and a button that pulses while it waits
is a button an operator has to finish watching before reading.

**The adapter is an argument of the press.** The picker sits in the Start
Working socket, offers exactly the adapters this folder resolved, and holds the
pick in the rail's own state for as long as the window is open. Nothing is
persisted and no default is read: the choice is a fact about this press against
this folder, and a pick that stops resolving falls back to one that does rather
than travelling as a name the folder cannot honour.

**A refusal re-arms and then waits.** `Started::Refused` carries a `detail` and
an optional `frontier`, and the two are used differently. The sentence is
printed in the socket. A frontier naming a new number re-arms the button on that
number — spelled on the button, so the change is visible — and stops there: the
run that starts is the one a hand presses for a second time. A refusal that
named no frontier learned no new target, so it re-arms on nothing and only
prints its sentence. Nothing on this side retries, retargets or spawns off the
back of an answer.

**The rail is chrome, not a view.** A view is handed `{ model, selected,
onSelect }` and `tests/views.test.ts` holds that declaration to one file that
mentions neither the snapshot nor the ledger. The rail needs the folder's
resolved adapters and a command to invoke, so rendering it from a view would
mean widening that contract for every view that will ever exist. It sits beside
the Ledger for the same reason and by the same precedent.

## Consequences

The rail is legible with nothing behind it. With no map open, no folder chosen
and no Rust behind the window, all four sockets are on screen saying what each
of them is waiting for — and a press in a browser answers with a refusal
sentence rather than a spawn, because there is no PTY to invent one over.

The frontier stays singular. The target is read from `model.map.frontier` and
from the frontier a refusal named, and from nowhere else; no row of the route
and no ranking of the WebView's own gets an opinion about what is takeable. The
one place the refusal's frontier wins over the snapshot's is the one place it is
newer — it came from the pass that press bought.

Everything on the rail is a pure function of the crossing — `railAt(crossing)`,
over `{ frontier, selection, environment, folder, phase, map, composing, press }`
— so the four states, the conditions and the re-arm are asserted as arithmetic
in `tests/sockets.test.ts`, and only the wiring needs a mounted test.
[Amended by
[ADR 0024](0024-a-compose-holds-no-claim-so-the-live-run-is-the-claim.md): #66
widened the crossing with `phase`, `map` and `composing`, and put a second verb
in the Start Working socket. `composing` is the first field here that reads
neither the model nor the folder — it reads this window's own live runs.] The prompt a
spawn answers with is kept per run in `src/terminal/prompts.ts`, because that
answer is the only time this side is ever told the text.
