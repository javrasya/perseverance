//! Acquiring the operator's environment.
//!
//! Boundary: this crate runs the operator's login shell as an *environment
//! source* and never as a parent. It harvests once, in memory, hands back a
//! plain map, and every spawn after that is direct — which collapses the
//! quoting hazards and the orphaned-tree risk rather than accepting them as
//! costs.
//!
//! A harvest is not a session. It is sub-second, pipe-backed, framed, read
//! until the frame closes and then abandoned; it has no terminal, no user and
//! no resumption. Sessions — ConPTY, `openpty`, a ring per run, an ending to
//! resolve — are [`perseverance_pty`], and nothing here grows towards them. A
//! PTY would in fact be worse than useless: a prompt that writes nothing to a
//! pipe paints escape sequences into a terminal, and into the frame.
//!
//! It never opens a socket, never knows Tauri exists, and never writes a file.
//! Its one dependency is `thiserror`; in particular there is no `serde`, so
//! [`Environment`] cannot be spelled as JSON and therefore cannot reach the
//! registry, the wire or a log by accident. The ground for that is staleness
//! first — an environment written down in March is a promise about a machine
//! that has installed three node versions since — and the operator's secrets
//! second.
//!
//! Three things this crate cannot tell you, recorded rather than defended:
//!
//! - **Resolvable is not spawnable.** A `PATH` that resolves `codex` says
//!   nothing about whether its `#!/usr/bin/env node` shebang resolves at exec
//!   time; #21 measured that exact 127.
//! - **Spawnable is not correct.** A version pin to something uninstalled falls
//!   back to the default and starts successfully under the wrong interpreter,
//!   with nothing on either stream (#24).
//! - **Complete-looking is not complete.** A profile that calls `exit` half-way
//!   yields exit 0, both marks, ninety variables and a stderr at the exact
//!   no-profile baseline (#26). No check here catches it, and under `AllSigned`
//!   a profile that never ran looks the same as an operator who has none.
//!
//! `docs/adr/0002` records why this is the seventh crate rather than a corner
//! of [`perseverance_github`] or of [`perseverance_pty`], and what it costs.
//!
//! Filled in by:
//! - #31 the app-global harvest at launch, and running one program inside it
//! - #45 the per-folder harvest and the cwd-keyed cache
//!   (#45's declared probes, its readout and the override's resolution rule
//!   stay with `perseverance-agent`, which needs no dependency here: every
//!   accessor below hands back a `std` type.)
//!
//! [`perseverance_pty`]: https://github.com/javrasya/perseverance
//! [`perseverance_github`]: https://github.com/javrasya/perseverance

mod environment;
mod harvest;
mod nonce;
mod parse;
mod payload;
mod pump;
mod run;
mod shell;

pub use environment::Environment;
pub use harvest::{
    classify_stderr, harvest, harvest_with, Bounds, Harvest, HarvestAttempt, HarvestCondition,
    Stderr, StderrKind,
};
pub use nonce::Nonce;
pub use parse::{is_well_shaped, read_frame, Reading, RecordTag, Tally};
pub use payload::{closing_mark, encode_command, opening_mark, powershell_payload, unix_payload};
pub use run::{run_in, Capture, RunFailure};
pub use shell::{harvest_command, harvest_cwd, HarvestCommand, Shell};
