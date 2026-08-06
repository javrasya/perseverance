# 9. The failure taxonomy is one enum twice, and a condition on the graph

Status: accepted (2026-08-06)
Context: [#40 failure taxonomy, backoff, and the graph
condition](https://github.com/javrasya/perseverance/issues/40), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28), answering
[#19](https://github.com/javrasya/perseverance/issues/19) §5's table row for
row. It fills the last of the three floors ADR 0007 composed, produces the
`Never` that ADR 0007 predicted and ADR 0008 narrowed to this ticket alone, and
spends the `Authority` #38 carried through unused. ADR 0003 settled that
`perseverance-github` is the only crate that opens a socket, which decides where
the classifying happens; ADR 0004 settled that derivation is Rust's and the
WebView is paint, which decides what crosses.

## Context

Three decisions here had real alternatives, and one of them looked settled until
the types were written down.

**A condition has to be two things at once.** The WebView renders it, so it
needs a name and a moment as text. The poller times a wait from it, so it needs
seconds — and `cadence.rs` is enforced clock-free by a test in `poller.rs` that
reads its bytes. One type cannot be both without either putting RFC 3339 parsing
into the pure module or putting a clock beside it.

**Nothing carried a classification anywhere.** `ReadFailure` was descriptive by
design and said so in a doc comment; `Tick::Failed` was a unit variant; and
`ReadOutcome::Failed` was a newtype over a string, where the string was whatever
sentence the refusing crate happened to write. So *stop rather than back off*
had nothing to branch on, and the only thing on the wire that could have been
branched on was prose.

**`Ahead` could not tell two silences apart.** #39 gave the tick a way to ask
which floor would hold the next wait, and it asked with `Option<Budget>`. `None`
meant *this poll established nothing about the budget*, which covered a read
that reported no `rateLimit`, a poll nobody attempted, and a read that failed,
all three. That cost nothing while every failure held the same floor.

## Decision

**One taxonomy, expressed as two enums, converted in one exhaustive match.**
`perseverance_model::Degraded` crosses the seam: four variants, camelCase on the
wire, and `RateLimited { resets_at }` carrying RFC 3339 because that is what a
browser renders and what a JSON fixture can hold.
`perseverance_github::cadence::Fault` is the same four conditions with that one
field already reduced to seconds by `Fault::of(&Degraded, now)`, called from
`crates/app`, which is the layer that has a clock. It is exactly the move
`Budget { seconds_to_reset }` made against GitHub's `resetAt` in ADR 0008, for
the reason stated there.

Two types for one taxonomy is a duplication, and both alternatives are worse. A
single type carrying seconds cannot be rendered: an age needs the moment, and
the WebView has no anchor to add seconds to. A single type carrying text drags
`epoch_from_rfc3339` and a clock reading into the module whose whole claim is
that it has neither. What keeps the pair honest is that the conversion is one
`match` with no wildcard in it, so a fifth `Degraded` variant is a compile error
rather than a condition that quietly retries forever.

`Fault` and not `Failed`, because `Tick::Failed` already exists in the same
crate and two `Failed`s is a name nobody can read.

**Classification happens once, in the crate that held the socket.**
`ReadFailure::degraded()` is the only classifier, and it reads a status code, a
`Retry-After` header and GitHub's own error `type` — none of which crosses the
seam and none of which anything else has. The paragraph in `read.rs` calling
that enum *deliberately not a taxonomy* was rewritten rather than left standing:
the variants are still observations, and the judgement is a method beside them.

Three rows of #19 §5's table needed a decision it does not make.

**`403` splits on the headers, not on the number.** GitHub spends one status on
*you may not* and on *not so fast*, and documents **two** shapes for the second:
a `Retry-After`, and otherwise `x-ratelimit-remaining: 0` beside
`x-ratelimit-reset`. Both are read, resolved to one moment by `when_it_resets`,
and either makes it `RateLimited`. Reading only the first — which is where this
ticket's first draft stopped — meant a secondary rate limit that sent no
`Retry-After` was classified as a revoked token: the poller answers `Never`,
stops for the life of the process, and the screen tells an operator with a
working token to run `gh auth login`, with refocusing the window the only way
back and re-tripping the same limit the only thing it achieves. That is this
ticket inverted, so the second form is not optional.

The `remaining == 0` guard is what keeps the fix from eating the other 403:
every answer carries `x-ratelimit-reset`, including a permission failure with
the budget untouched, and reading it unconditionally would leave a revoked token
retrying quietly forever. A 403 that named a reset in neither form is
`AuthFailed`, which stops. That is the safe direction of what is left: a stopped
poller says so on screen and prints a command, while a permission failure read
as a rate limit ages a stamp forever.

**A query refused on the budget carries its reset across the parse.** A primary
rate limit on GraphQL is a `200` with `type: RATE_LIMITED` in the body, and the
reset is on the headers — which `ReadError` is parsed without ever seeing. So
`interpret_read` lifts that one refusal out into `ReadFailure::RateLimitedQuery`
while both halves are still in hand. Without it the condition could only ever
answer *no idea when*, and a rate limit with no moment falls back on the
doubling: a poll every five minutes against a limit that lasts an hour, for the
whole hour.

**A refused query is classified by `type` and never by `message`.**
`wire::GraphQlError` grew `#[serde(rename = "type")] kind`, and
`ReadError::Answered` became `{ kind, message }`. `NOT_FOUND`, `RATE_LIMITED`
and `FORBIDDEN`/`UNAUTHORIZED` map across; anything else is `Unreachable`, which
keeps the last good model and tries again — #19 §5's schema-drift row. Grepping
prose for a classification is the thing this repository keeps refusing to do,
because a sentence GitHub rewords is a classification that silently changes.

**`ReadError::NoRepository` is `MapGone`.** The answer arrived and denied the
repository exists; that is not transient, and the remedy is picking another
folder rather than waiting for a network. It is a judgement and README says so,
because `data.repository` is also null for a token that cannot see the
repository.

**`Never` gets its second producer, and a human poke is the way out of it.**
`backoff_floor(consecutive_failures, poke, last)` is four clauses read top-down.
A human authority answers zero — first, so it outranks the stop below it. Then
`AuthFailed | MapGone` answer `Never`. Then a `RateLimited` answers the header
`max`'d against the doubling, because a header shorter than the backoff a run of
failures already earned is not permission to go faster, and that `max` is this
module's one composition rule applied once more rather than a second guess.
Otherwise the doubling: zero at zero failures, else `BACKOFF_BASE << (n - 1)`
clamped to `BACKOFF_CAP`, saturating throughout because `n` is a `u32` an outage
can run away with.

ADR 0008 argued that `Never` is absorbing, and that a floor answering it stops
the read that would have told it otherwise. That argument holds, and it is why
the budget still does not answer it. It does not apply here, and the difference
is what a recovery needs. A rate limit resets by itself with no operator
involved, so a poller that stopped for one would need the app restarted. A
revoked token needs a person either way, and the person is already there — so
the clause that lets them out sits in the same function, one line above the
stop.

**An agent poke does nothing in this floor, which is *agent pokes respect
backoff*.** It falls out of not branching on `Authority::Agent` rather than out
of a guard, which is the difference between a rule and something somebody
remembered.

**`Watch::apply` clears the count and the condition on a human poke, as well as
the floor answering zero.** Both, and they are not the same thing. The floor is
what makes *this* wait zero; the clearing is what stops the tick that poke
bought from falling straight back to `Never` the moment the poke is spent.
Without the floor a stopped poller could not be started at all; without the
clearing it could be started exactly once per click, forever.

**`Ahead` widens from `Option<Budget>` to the whole `Tick`.** A failure now
changes which floor holds the next wait, so the query has to know what the tick
is about to be — and the honest widening is to pass the value the tick is
literally about to return. The fold that turns a tick into
`(consecutive_failures, last_fault)` is extracted as `folded` and called by both
`Watch::ahead` and `pump`, so the prospective answer and the actual one cannot
disagree.

**The condition renders as a condition on the graph: no modal, no toast, and
none may be introduced.** The cache stamp goes dashed and hatched, the age goes
on ageing beside it, and the condition, the sentence behind it and — for the
auth case only — the one command that fixes it all print as **text** rather than
only in `title=` (#28 story 24).

*Both* halves of the reason are text, and that is a decision rather than a
detail. The condition is short because it is a class: `unreachable` covers a
dead network and five refusals that never reach a socket, among them a folder
with no `.git` and a folder whose remotes name nothing on GitHub. An earlier
draft printed only that short name and called it *could not reach GitHub*,
which put a false diagnosis on permanent chrome for a folder that is simply not
a GitHub repository — and #28 story 7 asks precisely for an unusable repo to say
what is wrong so it can be told apart from *cannot reach GitHub*. So the name
was reduced to the claim it can actually carry, and the refusing crate's own
sentence prints beside it, unedited. Controls needing fresh data are disabled in place:
every map row stays on screen, gains `aria-disabled`, and loses its ink, which
is the change-of-ink-never-of-layout idiom `FolderRow` already uses for a folder
whose drive is unplugged. Only `AuthFailed` and `MapGone` disable anything — a
rate limit is a wait with an end on it, and rows disabled for one would come
back by themselves while somebody sat reading a reason to give up. The rule that
none of this may become an interruption is a test: booting every degraded
fixture and asserting no `role="alert"`, no dialog and no `aria-live="assertive"`
anywhere in the document.

**The age is ticked by the WebView, because the poller can stop.** `AuthFailed`
and `MapGone` answer `Floor::Never`, `next_wake` answers `Wake::WhenPoked`, and
the loop blocks on its channel — so on exactly the two screens this ticket is
about, no further `maps` event is ever emitted and nothing external re-renders
the window again. Until now *the stamp visibly ages* was structural by accident:
a failing poller kept emitting, and every emit re-read the clock. It is now a
`useNow` hook in `App`, one interval for the window feeding both stamps and the
folder list, at half the width of the smallest unit `relativeAge` names so no
bucket can be skipped. A stamp frozen on *just now* under a sentence saying
nothing newer has turned up is the one lie the stamp exists to prevent, and it
is asserted with fake timers rather than left to the poller's good behaviour.

**Nothing printed inside a PTY is a condition on the graph.** The rule is
written in `crates/pty`'s module doc and asserted by a test in `crates/app` that
reads that file as bytes and asserts it names none of `Degraded`, `ReadOutcome`,
`MapsView`, `Provenance` or `emit`. The test lives in the other crate for the
reason #38 gave for `the_interval_function_reads_no_clock`: the needle does not
go in the haystack it is searching.

## Consequences

The taxonomy exists twice, and the conversion is the only thing keeping the two
copies equal. It is one function with one exhaustive match and a test that walks
every variant, which is as cheap as this can be made; it is still two places a
fifth condition has to be added.

No rate-limit header has ever been seen from a real GitHub. Every test that
exercises one builds an `Answer` by hand. The parse takes whole numbers and
refuses an HTTP-date `Retry-After` as *nothing said when*, so a GitHub that
changed form degrades to the doubling — but a 403 that named a reset in neither
documented form falls back to `AuthFailed` and stops, which is the wrong answer
in the safe direction. README carries this.

The five refusals that never reach a socket go through one function,
`local_refusal`, rather than naming a condition at each of the five returns.
That is the same move `folded` makes in `poller.rs` and for the same reason: a
decision spelled at every site it is taken is a decision a test can only
restate. `poll_once` itself is driven for real over a `tauri::test::mock_app` —
six of its seven returns, every one that does not need a socket — which cost one
linker flag in `build.rs`, because a `cargo test` binary gets no application
manifest and dies at process load without one.

`crates/pty` is thirty-odd lines of doc comment, so the strongest available
assertion of the PTY rule is a byte scan of a file with no code in it. It has to
be re-asserted at #47, and README says so rather than leaving it to be
discovered.

The fixture set grew from one failed-read case to four, and `dev:web` now shows
whichever condition the `?map=` parameter names on the stamp and the map list at
once — one parameter, because two would let a browser paint a stopped stamp over
a healthy list, which is a screen the app itself cannot produce. The map list
takes its condition from the generated snapshot fixtures rather than keeping a
second hand-written account of one, so no prose in `maps.fixture.json` can drift
from what Rust would actually have sent.

`crates/app` reads a clock now — one function, `epoch_seconds`, for
`Fault::of`. That is the wiring layer doing wiring, but it is the first clock in
that crate and the charter says *no decisions*, so it is worth naming: the
decision is `Fault::of`'s and lives in `cadence.rs`; what this crate supplies is
the number.

The backoff is invisible on its own. A poller waiting eighty seconds after four
failures paints the same screen as one on the sixty-second rung, because what
crosses is the condition and not the wait it earned. That is deliberate — a
clause naming a duration would narrate every adjustment of it, which is the
argument #39 already made for the budget clause — and it is in README's honest
limits rather than left to be noticed.
