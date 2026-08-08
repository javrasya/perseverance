use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use perseverance_agent::Launch;

/// A launch that has been checked, and the only thing #47's spawn will take.
///
/// Its fields are private and [`accept`] is the only constructor, so the check
/// is not something a call site can forget to run — it is the only way to hold
/// the argument. That is why the gate is a *type* rather than a boolean an
/// adapter or a caller could be trusted to consult.
///
/// No adapter can build one. `perseverance-agent` has no dependencies at all,
/// so it cannot name this crate, and the invariant therefore lives at the
/// harness boundary rather than being re-remembered once per adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    launch: Launch,
    program: PathBuf,
}

impl Accepted {
    pub fn launch(&self) -> &Launch {
        &self.launch
    }

    /// `argv[0]`, known to be a file whose first bytes are a native image for
    /// this target.
    pub fn program(&self) -> &Path {
        &self.program
    }
}

/// Every way the harness declines to spawn a planned launch.
///
/// None of these is the agent failing. They all say the same thing in
/// different words — what `argv[0]` names is not a program this harness can own
/// the process tree of — and the operator's fix is always an install path
/// rather than anything about their repository.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpawnRefusal {
    #[error("the plan has no argv at all, and an empty argv is not a program to run")]
    NoProgram,

    #[error(
        "{} is a bare name rather than a path, and resolving a name against a PATH is \
         perseverance-env's work and not this crate's",
        program.display()
    )]
    NotAbsolute { program: PathBuf },

    #[error("{} is not a file, so there is nothing there to spawn", program.display())]
    NotAFile { program: PathBuf },

    #[error("{} could not be read to find out what it is: {detail}", program.display())]
    Unreadable { program: PathBuf, detail: String },

    /// The one that matters most on Windows. npm installs `claude.cmd`, and
    /// spawning through it interposes `cmd.exe`: killing the child kills the
    /// interpreter and orphans the agent, and the exit code that comes back is
    /// `cmd.exe`'s rather than the agent's
    /// (`docs/research/pty-spawn-agent-clis.md` §3.2, §8.2).
    #[error(
        "{} is a batch shim, and spawning through one puts cmd.exe between this harness and the \
         agent, so killing it would orphan the agent and its exit code would be the shim's",
        program.display()
    )]
    BatchShim { program: PathBuf },

    /// npm also drops an extensionless POSIX shim beside the `.cmd`. Windows
    /// matches it by name and then cannot run it — `os error 193`. Refusing it
    /// here turns that into a sentence instead of an error number.
    #[error(
        "{} starts with a shebang, so it is a script for an interpreter rather than an image this \
         harness can own the process tree of",
        program.display()
    )]
    ScriptShim { program: PathBuf },

    #[cfg(unix)]
    #[error("{} is not marked executable", program.display())]
    NotExecutable { program: PathBuf },

    /// Includes the zero-length case, which is what a WindowsApps App Execution
    /// Alias looks like to anything that opens it — a reparse point with no
    /// bytes. Zero length is the part `std` can see without naming a Win32 API,
    /// which a crate that forbids `unsafe` could not call anyway.
    #[error(
        "{} does not begin with a native executable magic for this platform (it begins {first:02x?}), \
         so it is a shim or a stub of some kind and not an image",
        program.display()
    )]
    NotAnImage { program: PathBuf, first: Vec<u8> },
}

/// What the first few bytes of a file say it is.
///
/// A **positive allowlist of native-image magics**, never a blacklist of shim
/// filenames. A blacklist can miss — every package manager is free to invent
/// another wrapper — and an allowlist cannot: anything that is not a native
/// image for this target is refused, whatever it is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    Pe,
    Elf,
    MachO,
    Batch,
    Script,
    Unknown,
}

/// Pure, table-tested, and host-independent, so every arm is exercised on both
/// runners even though only one of them can accept each.
fn shape(first: &[u8]) -> Shape {
    const MACH_O: [&[u8]; 5] = [
        &[0xfe, 0xed, 0xfa, 0xce],
        &[0xfe, 0xed, 0xfa, 0xcf],
        &[0xce, 0xfa, 0xed, 0xfe],
        &[0xcf, 0xfa, 0xed, 0xfe],
        &[0xca, 0xfe, 0xba, 0xbe],
    ];

    if first.starts_with(b"MZ") {
        Shape::Pe
    } else if first.starts_with(b"\x7fELF") {
        Shape::Elf
    } else if MACH_O.iter().any(|magic| first.starts_with(magic)) {
        Shape::MachO
    } else if first.starts_with(b"#!") {
        Shape::Script
    } else if first.starts_with(b"@") {
        Shape::Batch
    } else {
        Shape::Unknown
    }
}

/// The one place the host is consulted. An image is native or it is a shim, and
/// which magics count is the only thing that differs between the two runners.
fn is_native(shape: Shape) -> bool {
    if cfg!(windows) {
        matches!(shape, Shape::Pe)
    } else {
        matches!(shape, Shape::Elf | Shape::MachO)
    }
}

/// The first bytes of a file, however few there are. A zero-length file reads
/// as an empty slice rather than as an error, because a zero-length file is a
/// thing this check has an opinion about.
fn opening_bytes(program: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(program)?;
    let mut buffer = [0u8; 8];
    let mut filled = 0;

    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }

    Ok(buffer[..filled].to_vec())
}

/// The harness boundary: a planned launch in, a spawnable one out.
///
/// **The rule, stated once:** a spawnable program is a file whose first bytes
/// are a native-executable magic for this target, and which is marked
/// executable where the platform has such a mark. Everything else is a shim.
///
/// It reads a file and never runs one, so the whole of it is exercisable from
/// hand-written bytes in a temporary directory and nothing in CI ever spawns an
/// agent CLI to check it.
///
/// A symlink is followed, and must be: `~/.local/bin/claude` from the native
/// installer is one, and it is the recommended install.
pub fn accept(launch: Launch) -> Result<Accepted, SpawnRefusal> {
    let Some(first) = launch.argv().first() else {
        return Err(SpawnRefusal::NoProgram);
    };
    let program = PathBuf::from(first);

    if !program.is_absolute() {
        return Err(SpawnRefusal::NotAbsolute { program });
    }

    let metadata = match std::fs::metadata(&program) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(SpawnRefusal::Unreadable {
                program,
                detail: error.to_string(),
            })
        }
    };
    if !metadata.is_file() {
        return Err(SpawnRefusal::NotAFile { program });
    }

    let first = match opening_bytes(&program) {
        Ok(first) => first,
        Err(error) => {
            return Err(SpawnRefusal::Unreadable {
                program,
                detail: error.to_string(),
            })
        }
    };

    match shape(&first) {
        Shape::Batch => return Err(SpawnRefusal::BatchShim { program }),
        Shape::Script => return Err(SpawnRefusal::ScriptShim { program }),
        found if !is_native(found) => return Err(SpawnRefusal::NotAnImage { program, first }),
        _ => {}
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(SpawnRefusal::NotExecutable { program });
        }
    }

    Ok(Accepted { launch, program })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsString;
    use std::time::Duration;

    use perseverance_agent::Ready;
    use tempfile::TempDir;

    const PE: &[u8] = b"MZ\x90\x00\x03\x00\x00\x00";
    const ELF: &[u8] = b"\x7fELF\x02\x01\x01\x00";
    const MACH_O: &[u8] = b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01";
    const BATCH: &[u8] = b"@ECHO off\r\nGOTO start";
    const SCRIPT: &[u8] = b"#!/bin/sh\nexec node \"$@\"\n";

    /// What a native installer leaves behind on the runner this test is on.
    #[cfg(windows)]
    const NATIVE_IMAGE: &[u8] = PE;
    #[cfg(unix)]
    const NATIVE_IMAGE: &[u8] = ELF;

    const SCRUB: &[&str] = &["A_MARKER_THIS_HARNESS_MUST_NOT_PASS_ON"];

    fn a_launch_of(program: &Path) -> Launch {
        Launch::new(
            vec![program.as_os_str().to_os_string(), OsString::from("go")],
            SCRUB,
            vec![("TERM".to_string(), "xterm-256color".to_string())],
            Ready::AltScreen {
                timeout: Duration::from_secs(10),
            },
        )
    }

    /// A file with the executable bit set where the platform has one, so a
    /// refusal below is always about the *shape* of what is inside it.
    fn a_program_holding(directory: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = directory.path().join(name);
        std::fs::write(&path, bytes).expect("writes");
        mark_executable(&path);
        path
    }

    #[cfg(unix)]
    fn mark_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    #[cfg(windows)]
    fn mark_executable(_path: &Path) {}

    #[test]
    fn a_native_image_is_the_only_shape_that_may_be_spawned() {
        // Every shape, classified on both runners, so neither one is reviewing
        // half a table. Only the acceptance line below is host-dependent.
        for (bytes, expected) in [
            (PE, Shape::Pe),
            (ELF, Shape::Elf),
            (MACH_O, Shape::MachO),
            (&[0xca, 0xfe, 0xba, 0xbe][..], Shape::MachO),
            (BATCH, Shape::Batch),
            (SCRIPT, Shape::Script),
            (b"#!/usr/bin/env pwsh\n", Shape::Script),
            (b"\xef\xbb\xbf#!/usr/bin/env pwsh", Shape::Unknown),
            (b"", Shape::Unknown),
            (b"claude", Shape::Unknown),
        ] {
            assert_eq!(shape(bytes), expected, "{bytes:02x?} classified wrongly");
        }

        // A shim is anything that is not a native image, so the allowlist is
        // the whole of the rule and no filename appears anywhere in it.
        for refused in [Shape::Batch, Shape::Script, Shape::Unknown] {
            assert!(!is_native(refused));
        }
        assert_eq!(is_native(Shape::Pe), cfg!(windows));
        assert_eq!(is_native(Shape::Elf), cfg!(unix));
        assert_eq!(is_native(Shape::MachO), cfg!(unix));
    }

    #[test]
    fn the_batch_shim_npm_installs_on_windows_is_refused_because_killing_it_orphans_the_agent() {
        let directory = TempDir::new().expect("temp dir");
        let program = a_program_holding(&directory, "claude.cmd", BATCH);

        // Caught by its first byte and not by its extension. The same bytes
        // under any other name are refused identically.
        assert_eq!(
            accept(a_launch_of(&program)),
            Err(SpawnRefusal::BatchShim {
                program: program.clone()
            })
        );

        let disguised = a_program_holding(&directory, "claude", BATCH);
        assert_eq!(
            accept(a_launch_of(&disguised)),
            Err(SpawnRefusal::BatchShim { program: disguised })
        );
    }

    #[test]
    fn the_posix_shim_windows_matches_by_name_is_refused_before_it_can_fail_with_error_193() {
        let directory = TempDir::new().expect("temp dir");
        let program = a_program_holding(&directory, "claude", SCRIPT);

        assert_eq!(
            accept(a_launch_of(&program)),
            Err(SpawnRefusal::ScriptShim {
                program: program.clone()
            })
        );

        // Refused on unix too, and for the better reason: a shell wrapper is a
        // process tree this harness would not own the far end of.
        assert!(accept(a_launch_of(&program)).is_err());
    }

    #[test]
    fn a_zero_length_file_is_not_an_image_however_the_shell_lists_it() {
        let directory = TempDir::new().expect("temp dir");
        let program = a_program_holding(&directory, "claude", b"");

        // This is the shape a WindowsApps App Execution Alias presents: a
        // reparse point with no bytes in it, which every directory listing
        // shows as a program.
        assert_eq!(
            accept(a_launch_of(&program)),
            Err(SpawnRefusal::NotAnImage {
                program,
                first: Vec::new()
            })
        );
    }

    #[test]
    fn a_program_that_is_only_a_name_is_refused_because_resolving_it_is_not_this_crates_work() {
        let refusal = accept(a_launch_of(Path::new("claude")));

        assert_eq!(
            refusal,
            Err(SpawnRefusal::NotAbsolute {
                program: PathBuf::from("claude")
            })
        );
    }

    #[test]
    fn a_launch_with_no_argv_at_all_is_refused_rather_than_spawning_a_shell() {
        let empty = Launch::new(
            Vec::new(),
            SCRUB,
            Vec::new(),
            Ready::Quiet {
                quiet: Duration::from_millis(400),
                max: Duration::from_secs(10),
            },
        );

        assert_eq!(accept(empty), Err(SpawnRefusal::NoProgram));
    }

    #[test]
    fn the_check_is_the_only_way_to_hold_the_type_a_spawn_will_take() {
        let directory = TempDir::new().expect("temp dir");
        let program = a_program_holding(&directory, "claude", NATIVE_IMAGE);
        let planned = a_launch_of(&program);

        let accepted = accept(planned.clone()).expect("a native image is spawnable");

        // The plan crosses the boundary unchanged — the gate refuses launches,
        // it does not rewrite them — and `argv[0]` is now known to be an image.
        assert_eq!(accepted.launch(), &planned);
        assert_eq!(accepted.program(), program.as_path());
        assert_eq!(accepted.launch().env_remove(), SCRUB);
    }

    #[test]
    fn every_way_a_launch_can_be_refused_says_so_in_a_sentence() {
        let program = PathBuf::from("/opt/homebrew/bin/claude");

        // The executable bit is a unix fact, so the variant that reports it
        // does not exist on the other runner and this is the one entry that
        // cannot simply be listed.
        #[cfg(unix)]
        let platform_only = vec![SpawnRefusal::NotExecutable {
            program: program.clone(),
        }];
        #[cfg(windows)]
        let platform_only: Vec<SpawnRefusal> = Vec::new();

        let refusals = [
            SpawnRefusal::NoProgram,
            SpawnRefusal::NotAbsolute {
                program: program.clone(),
            },
            SpawnRefusal::NotAFile {
                program: program.clone(),
            },
            SpawnRefusal::Unreadable {
                program: program.clone(),
                detail: "permission denied".to_string(),
            },
            SpawnRefusal::BatchShim {
                program: program.clone(),
            },
            SpawnRefusal::ScriptShim {
                program: program.clone(),
            },
            SpawnRefusal::NotAnImage {
                program: program.clone(),
                first: Vec::new(),
            },
        ]
        .into_iter()
        .chain(platform_only);

        for refusal in refusals {
            let sentence = refusal.to_string();

            assert!(
                sentence.len() > 40,
                "{sentence:?} is a label rather than a sentence"
            );
            assert!(
                !sentence.ends_with('.'),
                "{sentence:?} ends in a full stop; house style does not"
            );
            assert!(
                sentence
                    .chars()
                    .next()
                    .is_some_and(|opening| !opening.is_uppercase()),
                "{sentence:?} opens upper case; house style does not"
            );
            let _: &dyn std::error::Error = &refusal;
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_real_image_is_spawnable_because_the_native_installer_ships_one() {
        let directory = TempDir::new().expect("temp dir");
        let real = a_program_holding(&directory, "claude-1.2.3", NATIVE_IMAGE);
        let link = directory.path().join("claude");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        // `~/.local/bin/claude` from the native installer is exactly this, and
        // it is the recommended install — so a check that refused it would
        // refuse the happy path.
        let accepted = accept(a_launch_of(&link)).expect("a link to an image is spawnable");
        assert_eq!(accepted.program(), link.as_path());
    }

    #[cfg(unix)]
    #[test]
    fn a_program_without_the_executable_bit_is_refused() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new().expect("temp dir");
        let program = directory.path().join("claude");
        std::fs::write(&program, NATIVE_IMAGE).expect("writes");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        assert_eq!(
            accept(a_launch_of(&program)),
            Err(SpawnRefusal::NotExecutable { program })
        );
    }
}
