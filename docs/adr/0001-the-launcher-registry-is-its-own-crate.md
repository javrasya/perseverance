# 1. The launcher registry is its own crate

Status: accepted (2026-08-05)
Context: [#30 Launcher: the folder list](https://github.com/javrasya/perseverance/issues/30),
under the spec [#28](https://github.com/javrasya/perseverance/issues/28) and the
store ticket [#6](https://github.com/javrasya/perseverance/issues/6).

## Context

The launcher needs somewhere to keep the folders you have opened: one global
SQLite file in the OS application-data directory, WAL on, forward-only schema
versioning.

That sounds like storage, and storage sounds like plumbing. It is not. The
registry decides:

- that a file stamped with a schema version this build does not speak is
  **refused rather than guessed at** — not upgraded, not wiped, left byte-intact;
- that a folder whose path has gone missing **stays on the list**, and that
  re-pointing it **keeps its id**, so its layout and cache survive a move;
- that `owner/repo` is **derived from the folder's git remote on every read and
  stored nowhere**, so a rename on GitHub cannot rot a row;
- that a folder can fail to be a repository in **three distinct ways**, each of
  which must read as a fact about a folder and never as a failed network call.

Those are policy. The walking skeleton has five crates and each one's charter
forbids taking them:

- `perseverance-model` is derivation only, and `scripts/check-model-purity.mjs`
  walks its dependency tree — normal, build *and* dev edges — to keep it that
  way. A database engine there would have compiled, because `rusqlite` was not
  on the forbidden list; it is now, so the arrow this decision keeps absent is
  the script's business rather than review's.
- `perseverance-github` is the network boundary; the registry never opens a
  socket.
- `perseverance-agent` plans and `perseverance-pty` owns child processes;
  neither has anything to do with a file on this disk.
- `perseverance-app` is the Tauri shell, and its own module doc says *"Wiring
  only… if logic starts accumulating in this crate it belongs somewhere else."*
  Putting SQLite there breaks the one invariant that keeps the shell thin.

## Decision

A sixth crate, `perseverance-store` at `crates/store`.

It **owns** the SQLite file, the schema and its forward-only migration, the
`folders` and `app` tables, the presence check, and the binding of a folder to
a GitHub repository.

It **never** opens a socket, speaks to GitHub, knows Tauri exists, or spawns a
child process. `perseverance-model` does not depend on it, in either direction.

Repo binding reads `.git/config` as text rather than shelling out to `git`.
That keeps the crate free of child processes — those belong to
`perseverance-pty` — and makes the three refusals testable against a directory
with a hand-written config file on a machine with no git installed.

`crates/app` gains the five launcher commands, and they are wiring: they take
the store out of Tauri state, call it, rename its types into the camelCase
shapes the WebView expects, and carry its refusals across as strings.

## Alternatives

**SQLite inside `crates/app`.** One fewer crate, and the app already depends on
everything. Rejected: the shell's charter is the reason the shell is reviewable,
and the first exception to *wiring only* is the one that makes the second one
easy.

**A `store` module inside `perseverance-model`.** Rejected twice over — the
purity check exists to keep a JSON fixture sufficient to drive the model, and a
model that opens a file is no longer a pure derivation. The check would not
catch it, which makes it worse rather than safer.

**`tauri-plugin-sql`.** Rejected: it drags in `sqlx` and an async runtime, and
it cannot be unit-tested without Tauri in the tree, so the registry's policy
would only be exercisable through the shell.

## Consequences

- The README's crate table has six rows. The "five crates" line described the
  skeleton, not a ceiling; it now says six and means it.
- `cargo build` on a bare runner compiles the SQLite amalgamation via
  `rusqlite`'s `bundled` feature. That is a `cc` invocation and a slower cold
  build, in exchange for needing no system SQLite and no libclang on either CI
  runner.
- `scripts/check-model-purity.mjs` gains `rusqlite` and `libsqlite3-sys`, so a
  `model → store` arrow is now a failing check rather than a convention held by
  review. The reverse arrow — the store's own "never a socket, never Tauri,
  never a child process" — is still only its `Cargo.toml` and this document; the
  crate's dependency list is three entries long and a fourth is visible in a
  diff, which is the whole of the enforcement.
- A refusal to open the registry has one author: the store writes the sentence,
  the shell forwards it as a string, the launcher renders it beside fixed copy
  that says only what was done about the file — never why, because the why is
  not always the same why.
- **The three repo-binding refusals are the exception, and they are written
  twice.** They cross as a tagged union with no message, because a folder that
  is not a repository is not an error the shell is having; the prose the user
  reads is composed in `src/launcher/launcher.ts`, while
  `RepoBindingError`'s `#[error]` strings serve Rust callers and the store's own
  tests. The cost is real: two copies to keep true, guarded by two
  network-vocabulary tests, one on each side. The alternative — carrying a
  string across the wire — would put the launcher's copy in the store, where it
  cannot be seen next to the layout it appears in.
- `app_data_dir()/perseverance.db` is chosen in `crates/app`, not in the store:
  the store takes a path so it needs no notion of an application-data directory
  and a test can point it at a temporary file. That leaves one settled decision
  from #6 living in the shell, recorded here rather than asserted by a test,
  because the directory it names cannot be resolved without a Tauri app handle.
