# 3. GitHub is read over a blocking socket this app owns

Status: accepted (2026-08-05), amended by ADR 0009 (2026-08-06) in the one place
marked *landed* below. Still in force everywhere else.
Context: [#32 Maps on screen: one query shape, discovery by label, the read
cache](https://github.com/javrasya/perseverance/issues/32), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28), on the API coverage
research in [#3](https://github.com/javrasya/perseverance/issues/3)
(`docs/research/github-graph-api-coverage.md`).

## Context

#32 is the first slice that reads GitHub, so it is the slice that has to decide
*how*. Three questions arrive together and only look like one:

1. Does this app make its own HTTP request, or does it spawn the operator's
   `gh` and read what that prints?
2. If it makes its own request, with which client?
3. Blocking or async?

The workspace already has strong opinions bearing on all three. `perseverance-
github`'s charter is that it is **the only crate permitted to open a socket**.
`perseverance-env` exists so that a child process is a mechanism sited in one
place, and ADR 0002 accepted the `github → env` edge specifically so that this
crate "still constructs no child process of its own". #31 acquires a token from
`gh auth token` at launch and holds it in memory for the life of the process.

The alternative to a socket is real and was seriously weighed: `gh api graphql
-F query=@…`, run through the same `run_in` that already asks for the token. It
costs **zero** new dependencies, and it is the smallest possible diff.

## Decision

**This app makes the request itself, with `ureq`, blocking, on a thread.**

Three things settled it.

**The token would otherwise have no purpose.** #31 acquires a credential and
puts *token: acquired* on the diagnostics surface. `gh api` authenticates from
`gh`'s own credential store and would ignore it entirely. A token acquired for
a poll that never uses it is a launch step that has quietly become decorative,
and the readout beside it becomes a claim about nothing. The spec's own launch
order — **harvest → token → first poll** — reads as three steps because the
third consumes the second.

**ADR 0002 already assumed a compiled client.** Its argument for splitting
`perseverance-env` out of `perseverance-github` turns on the sentence that
`perseverance-pty` "has no business compiling an HTTP client to apply a
`PATH`". That reasoning only holds if `perseverance-github` compiles one. The
crate table in the README says the same thing from the other side:
`perseverance-github` owns *every network call*. Delegating the network call to
a subprocess would make both sentences false on the day the first read landed.

**Spawning per poll is a worse mechanism at this cadence.** The cadence ladder
(#38) polls every ten seconds with a run live. A process spawn per tick pays
`gh`'s start-up on every one of them, and it makes reading GitHub depend on a
CLI being installed — which is currently a requirement for *signing in*, a
once-per-launch fact an operator can be told about, rather than a requirement
for the app to keep working.

On the second and third questions:

- **`ureq` rather than `octocrab`.** The research (#3) already concluded that
  the harness "drops to raw" for everything it actually needs: octocrab has no
  issue-dependency support at all, its `Issue` model discards
  `sub_issues_summary` and `issue_dependencies_summary`, and the whole graph
  arrives from one raw `graphql()` call regardless. What is left of octocrab
  after that is a `POST` with one header — which is all `ureq` is being asked
  for, without an async runtime underneath it.
- **Blocking rather than async.** `crates/app` already argues this for the
  harvest: *"a runtime for one blocking read that happens once a launch would
  be a scheduler acquired to do what a thread already does"*. One request every
  ten seconds does not change that arithmetic. `#[tauri::command(async)]` keeps
  it off the main thread, which is the only thing that was ever at stake.
- **`platform-verifier`.** Certificates are checked against the operator's own
  trust store rather than a root list compiled into this binary, so an app
  behind a corporate proxy works for the same reason their browser does.

## Consequences

- The charter survives intact and gets narrower rather than broader:
  `perseverance-github` opens a socket, and exactly one function in it does.
- The token is spent in an `Authorization` header and nowhere else. It is never
  an argument, which matters because an argument vector is readable by every
  process on the machine. There is a test asserting it appears in nothing this
  crate composes.
- **A new C-compiler-dependent build step**, via `ring` under `rustls`. This is
  not a new requirement: `rusqlite`'s `bundled` feature already compiles the
  SQLite amalgamation with `cc` on both runners, so the floor was already
  there.
- **Linux, when it arrives, is untested here.** Both CI runners are Windows and
  macOS by design. `rustls-platform-verifier` supports Linux, but nothing in
  this repository has ever built it.
- **The failure taxonomy is deliberately not built.** `ReadFailure` here
  distinguishes three *observations* — nothing answered, something answered
  badly, the answer could not be read — and classifies none of them.
  `Unreachable` / `AuthFailed` / `MapGone` / `RateLimited`, and which of them
  retries, are #40's, and half a vocabulary invented here would be that ticket
  arriving to find its decisions already made. *(Landed: #40 built it as
  `ReadFailure::degraded()`, a method beside these variants rather than a
  reshaping of them — the observations are still observations, and the
  classifier reads a status, a `Retry-After` and GitHub's own error `type`,
  none of which anything outside this crate holds — ADR 0009.)*
- `map-graph.graphql` and `map-poll.graphql` stay at the repository root
  untouched. They are #3's reproduction artifacts and the research document
  quotes command lines against them by name; the query this app actually ships
  is `crates/github/src/map-read.graphql`, which is one document rather than
  two because #32 killed the poll/refetch split.
