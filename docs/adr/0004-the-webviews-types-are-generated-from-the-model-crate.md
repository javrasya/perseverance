# 4. The WebView's types are generated from the model crate

Status: accepted (2026-08-05)
Context: [#33 The derived model, the Snapshot, and
dev:web](https://github.com/javrasya/perseverance/issues/33), under the spec
[#28](https://github.com/javrasya/perseverance/issues/28).

## Context

Every seam this app has crosses the same way: a Rust type serialises, a
hand-written TypeScript interface in `src/` mirrors it, and a pair of tests — one
on each side — pins the shape so a rename in Rust is a red build rather than a
silent `undefined` in the WebView. `FolderEntry` / `launcher.ts`, `MapsView` /
`maps.ts` and `EnvironmentReadout` / `environment.ts` all work exactly this way,
and each of them says so in a doc comment.

It works. It also costs a test per field, forever, and its correctness rests on
somebody having remembered to write that test — the mirror is only pinned where
an assertion happens to point.

#33 is where that trade stops being acceptable. The snapshot is not a view of
one screen: it is **the** seam, the whole derived model, and it is the input to
`dev:web`, to the conformance suite (#43) and to every rendering ticket after
this one. It is also the type most likely to grow — the ledger (#41), fog (#35),
platform filtering (#61) and out-of-scope exclusion (#36) all add to it. A
hand-written mirror of a type that six later tickets will each extend is a
mirror that will be wrong at some point, and wrong quietly.

The ticket asks for exactly that guarantee: *a model change that is not
propagated fails the build*.

## Decision

**`src/snapshot/model.generated.ts` is generated from `perseverance-model`'s own
types by [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs), checked in, and
compared byte for byte by a test in `crates/model/src/bindings.rs`.**

The same module generates `src/snapshot/fixtures/*.json` — whole `Snapshot`s
derived from the recorded GraphQL answers in `crates/model/fixtures/` — and
compares those too. `UPDATE_GENERATED=1 cargo test -p perseverance-model` is
what rewrites both.

So the failure an implementer meets is:

1. They add a field to a model type in Rust.
2. `cargo test` fails, naming the file that no longer matches and the command
   that fixes it.
3. They run it, and the generated TypeScript and the fixtures move together.
4. `npm run typecheck` then fails wherever the frontend has not caught up.

Step 4 is the point. A model change the WebView has not absorbed is a compile
error rather than a surprise at runtime.

Four things make this cheap enough to accept in the crate whose `Cargo.toml`
says *keep it boring*:

- **It is a dev-dependency**, and the derives sit behind `#[cfg_attr(test, …)]`,
  so nothing of `ts-rs` reaches a shipped binary.
- **It is still checked.** `scripts/check-model-purity.mjs` walks
  `--edges normal,build,dev`, so this dependency is vetted exactly as a real one
  is: 19 transitive packages, none of them Tauri, network, browser, process or
  database.
- **It is pinned exactly** (`=12.0.1`). The generated file is compared byte for
  byte, so a patch release that reflowed its output would turn every open pull
  request red for a reason that is nobody's change.
- **It rides `cargo test --workspace`**, which CI already runs. No new CI step,
  and nothing added to `npm run verify` — deliberately, because `verify` must
  keep working on a machine whose `cargo` cannot link this workspace, and
  `check:model-purity` only ever resolves a dependency graph.

Two configuration choices are load-bearing rather than incidental:

- `Config::with_large_int("number")`. `u64` and `usize` become `bigint` by
  default, and `bigint` is a type no JSON fixture and no Tauri `invoke` result
  can ever inhabit — `serde_json` writes plain numbers. Left alone, the
  generated types would have been unusable and wrong in the same stroke.
- The generator is a **unit test inside `src/`**, not an integration test under
  `tests/`. The `TS` implementations exist only in this crate's own test
  harness, and an integration test links the library compiled without
  `cfg(test)`.

## Consequences

**The hand-written mirrors stay.** This decision is scoped to the snapshot seam
and does not migrate `launcher.ts`, `maps.ts` or `environment.ts`. Those mirror
types that live in `perseverance-app` — the crate whose charter is wiring — and
generating from there would put a code generator in the Tauri tree to save three
files that have stopped changing. If a fourth of them starts churning, revisit.

**Doc comments are now API.** `ts-rs` carries them across as JSDoc, so the
reasoning written above a Rust field is what a frontend author reads on hover.
That is a gain, and it also means a doc comment is no longer free to be sloppy.

**Nobody edits the generated file**, and its first line says so. The reason it
cannot drift is precisely that no human maintains it.

**The first of the six later tickets landed as predicted.** #41 added the change
ledger as a fourth field on `Snapshot`, and the failure was steps 1–4 above in
order, ending with `SCHEMA_VERSION` at 2 — see
[ADR 0010](0010-the-change-ledger-is-a-notification-surface-not-an-archive.md).
One hand-maintained file did not move with it: `crates/model/fixtures/no-map-open.json`
is `include_str!`d by the crate's own tests rather than generated, so a further
version bump has to edit it by hand.

**A serde attribute and its `ts` counterpart could in principle disagree.** The
`serde-compat` feature reads the serde attributes directly, and the two hardest
cases here — adjacent tagging over a mixed unit/newtype variant set with a
nested enum in the content position — were checked against real `serde_json`
output before this was accepted. It is not a proof, and the fixtures are the
backstop rather than the type system: TypeScript widens every string in an
imported JSON module, so `fixtures.ts` casts and cannot check. What does check
is `tests/snapshot.test.ts`, which reads `kind.kind`, `state`, `phase` and
`frontier` off `serde_json`'s own output through the generated types and asserts
their values — so a generator that disagreed with serde about any of them is a
failing test over real data rather than a quiet mismatch.
