# PTY spawn of agent CLIs on Windows and macOS

Research for [issue #4 — PTY spawn of agent CLIs on Windows and macOS](https://github.com/javrasya/perseverance/issues/4).

## The question

How does a Tauri/Rust harness reliably start an interactive agent CLI in a pseudo-terminal on Windows and macOS, and then get the opening prompt into it as a single submitted message?

Sub-questions:

- On Windows, `claude` may be a `.cmd`/shim rather than a native binary. What does `portable-pty` do with that, and what is the correct spawn incantation?
- On macOS, what is the equivalent path, and what breaks around environment inheritance?
- How does the harness know the CLI is *ready* for input rather than still booting?
- How is a long, multi-line opening prompt injected so it arrives as one message?
- What does resize look like, and what happens to the child when the app quits?

## Method and provenance

**Date checked:** 2026-08-01. **Versions under test:** `portable-pty` 0.9.0 (crates.io, built and run here), Claude Code `2.1.220`, Windows 11 Pro 26200, rustc 1.92.0.

Claims are tagged:

- **(observed)** — I built a real `portable-pty` harness on this machine and ran it against the real `claude` binary. Byte captures below are real, not reconstructed.
- **(source)** — read from the `portable-pty` source at the commit on `wezterm/wezterm@main`, downloaded to `%TEMP%\ptyres\`.
- **(docs)** — official Microsoft / Apple / Anthropic / Tauri documentation, URL cited inline.
- **(unverified)** — I could not establish it from this machine. Everything macOS-runtime-specific is in this bucket and is flagged individually.

The experiment scaffolding lived in `C:\Users\ahmet\AppData\Local\Temp\ptyprobe\` (a throwaway cargo project with three binaries: `resolve`, `capture`, `teardown`). It is not part of the repo.

> **Scope caveat:** I am on Windows. Every Windows claim below is empirically verified. Every macOS claim is derived from the `portable-pty` Unix source (which I read) plus Apple and Anthropic documentation (which I cite) — but **no macOS code was executed**. The macOS section marks each claim accordingly.

> **Cross-reference:** [`claude-code-observability-surface.md`](./claude-code-observability-surface.md) notes that interactive PTY sessions could not be driven from this environment — "`winpty`-driven attempts never got Claude Code to start at all". §4 of this document explains exactly why, and how to fix it.

---

## 1. What `claude` actually is on this machine

This single fact drives the whole Windows spawn answer, so it is first.

### 1.1 The shims (observed)

```
PS> Get-Command claude | Format-List
Path       : C:\Users\ahmet\AppData\Roaming\npm\claude.ps1
CommandType: ExternalScript
```

`Get-Command` reports the PowerShell shim, but that is a PowerShell-only view. The directory holds **three** shims plus the real binary:

```
PS> Get-ChildItem C:\Users\ahmet\AppData\Roaming\npm -Filter claude*
Name          Length
----          ------
claude           308      <- POSIX sh script, starts with "#!"
claude.cmd       160      <- batch shim,     starts with "@E" (@ECHO off)
claude.ps1       520      <- PowerShell shim
...\node_modules\@anthropic-ai\claude-code\bin\claude.exe   265720480   <- starts with "MZ"
```

`where.exe claude` returns only the two that Windows' own resolver considers **(observed)**:

```
C:\Users\ahmet\AppData\Roaming\npm\claude
C:\Users\ahmet\AppData\Roaming\npm\claude.cmd
```

`claude.cmd` in full **(observed)**:

```bat
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
```

The extensionless `claude` shim (npm's POSIX one, which Windows will happily *match by name* but cannot execute) **(observed)**:

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
...
exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"
```

The key structural fact: **all three shims exec the same native `claude.exe`.** Node is not in the picture at runtime. This matches the docs: *"The npm package installs the same native binary as the standalone installer. npm pulls the binary in through a per-platform optional dependency such as `@anthropic-ai/claude-code-darwin-arm64`, and a postinstall step links it into place. The installed `claude` binary does not itself invoke Node."* **(docs — <https://code.claude.com/docs/en/setup>)**

`claude doctor` confirms the install form **(observed)**:

```
Running: npm-global (2.1.220)
Platform: win32-x64
Path: C:\Users\ahmet\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
Config install method: global
```

### 1.2 The install-form matrix a harness must expect

From <https://code.claude.com/docs/en/setup> **(docs)**:

| Install method | Platform | What ends up on PATH | Native binary? |
| --- | --- | --- | --- |
| Native installer (`install.sh`) | macOS/Linux | `~/.local/bin/claude` — a **symlink** into `~/.local/share/claude/versions/` | yes |
| Native installer (`install.ps1`/`.cmd`) | Windows | `%USERPROFILE%\.local\bin\claude.exe` | yes |
| npm `-g` | macOS/Linux | npm bin dir, a POSIX shim | shim → native |
| npm `-g` | **Windows** | **`claude`, `claude.cmd`, `claude.ps1` shims** | **shim → native** |
| Homebrew cask | macOS | Homebrew bin dir | yes (**unverified** — exact path not checked from here) |
| WinGet | Windows | WinGet links dir | yes (**unverified**) |
| apt / dnf / apk | Linux | distro bin dir | yes (**unverified**) |

Uninstall instructions confirm the native-install paths **(docs)**: `rm -f ~/.local/bin/claude` on macOS, `Remove-Item "$env:USERPROFILE\.local\bin\claude.exe"` on Windows.

**So the shim problem is npm-on-Windows only.** The recommended native install and every non-npm Windows install give you a real PE executable. But npm-on-Windows is common enough that the harness must handle it.

### 1.3 How to detect which form you are facing

Two robust, cheap checks:

1. **Read the first two bytes.** A native binary starts with `MZ`; a batch shim with `@`; a POSIX shim with `#!` **(observed — all three verified on this machine)**.
2. **Ask the CLI.** `claude doctor` prints `Running: npm-global (…)` / the resolved `Path:` without starting a session **(observed)**. It is human-formatted, not JSON, but the `Path:` line is a stable anchor.

Prefer (1): it is instant and does not require the CLI to be runnable.

---

## 2. `portable-pty`: version and API surface

**Current version: 0.9.0**, published 2026-06-16, `repository = "https://github.com/wezterm/wezterm"`, `license = "MIT"` **(source — `pty/Cargo.toml`; corroborated by <https://docs.rs/portable-pty/latest/portable_pty/>)**. It built and ran cleanly on rustc 1.92.0 here **(observed)**.

The whole API you need **(source — `pty/src/lib.rs`)**:

```rust
pub fn native_pty_system() -> Box<dyn PtySystem + Send>;

#[cfg(unix)]    pub type NativePtySystem = unix::UnixPtySystem;
#[cfg(windows)] pub type NativePtySystem = win::conpty::ConPtySystem;

pub struct PtySize { pub rows: u16, pub cols: u16, pub pixel_width: u16, pub pixel_height: u16 }

pub trait PtySystem { fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair>; }

pub struct PtyPair {
    // slave is listed first so that it is dropped first.
    pub slave:  Box<dyn SlavePty  + Send>,
    pub master: Box<dyn MasterPty + Send>,
}

pub trait MasterPty: Downcast + Send {
    fn resize(&self, size: PtySize) -> Result<(), Error>;
    fn get_size(&self) -> Result<PtySize, Error>;
    fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, Error>;
    /// Dropping the writer will send EOF to the slave end.
    /// It is invalid to take the writer more than once.
    fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, Error>;
    #[cfg(unix)] fn process_group_leader(&self) -> Option<libc::pid_t>;
    #[cfg(unix)] fn as_raw_fd(&self) -> Option<unix::RawFd>;
    #[cfg(unix)] fn tty_name(&self) -> Option<std::path::PathBuf>;
    #[cfg(unix)] fn get_termios(&self) -> Option<nix::sys::termios::Termios>;
}

pub trait SlavePty {
    fn spawn_command(&self, cmd: CommandBuilder) -> Result<Box<dyn Child + Send + Sync>, Error>;
}

pub trait ChildKiller: … { fn kill(&mut self) -> IoResult<()>; fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>; }
pub trait Child: … + ChildKiller { fn try_wait(&mut self) -> IoResult<Option<ExitStatus>>; fn wait(&mut self) -> IoResult<ExitStatus>; fn process_id(&self) -> Option<u32>; #[cfg(windows)] fn as_raw_handle(&self) -> Option<RawHandle>; }
```

Three API sharp edges worth knowing up front:

- **`take_writer` is single-use.** `MasterPty::take_writer` panics-by-`bail` on a second call (Unix: an explicit `took_writer` flag; Windows: `Option::take` on the pipe). Wrap it in an `Arc<Mutex<…>>` if more than one part of the harness writes to the pty **(source; observed — I had to do exactly this)**.
- **Dropping the writer sends EOF.** On Unix that is literal: `UnixMasterWriter::drop` writes `\n` followed by the termios `VEOF` byte (Ctrl-D) **(source — `pty/src/unix.rs`)**. Dropping the writer will therefore *quit the CLI*. The harness must hold it for the session lifetime.
- **`pixel_width`/`pixel_height` are ignored on Windows.** The ConPTY backend only forwards `COORD { X: cols, Y: rows }` **(source — `pty/src/win/conpty.rs`)**.

---

## 3. Windows: what breaks, and the correct incantation

### 3.1 `CommandBuilder::new("claude")` fails outright

`CommandBuilder`'s Windows resolver **(source — `pty/src/cmdbuilder.rs`)**:

```rust
#[cfg(windows)]
impl CommandBuilder {
    fn search_path(&self, exe: &OsStr) -> OsString {
        if let Some(path) = self.get_env("PATH") {
            let extensions = self.get_env("PATHEXT").unwrap_or(OsStr::new(".EXE"));
            for path in std::env::split_paths(&path) {
                // Check for exactly the user's string in this path dir
                let candidate = path.join(&exe);
                if candidate.exists() {
                    return candidate.into_os_string();
                }
                // otherwise try tacking on some extensions.
                for ext in std::env::split_paths(&extensions) {
                    let ext = ext.to_str().expect("PATHEXT entries must be utf8");
                    let path = path.join(&exe).with_extension(&ext[1..]);
                    if path.exists() { return path.into_os_string(); }
                }
            }
        }
        exe.to_owned()
    }
}
```

The bug for our case is the **first** check: `path.join("claude").exists()`. npm's extensionless POSIX shim satisfies that, so resolution stops there and never reaches PATHEXT. The resolved path is then handed to `CreateProcessW` as `lpApplicationName` **(source — `pty/src/win/psuedocon.rs`)**:

```rust
let (mut exe, mut cmdline) = cmd.cmdline()?;
…
CreateProcessW(
    exe.as_mut_slice().as_mut_ptr(),        // lpApplicationName
    cmdline.as_mut_slice().as_mut_ptr(),    // lpCommandLine
    ptr::null_mut(), ptr::null_mut(), 0,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
    cmd.environment_block().as_mut_slice().as_mut_ptr() as *mut _,
    cwd.as_ref().map(|c| c.as_slice().as_ptr()).unwrap_or(ptr::null()),
    &mut si.StartupInfo, &mut pi,
)
```

Microsoft on `lpApplicationName`: *"This parameter must include the file name extension; no default extension is assumed."* **(docs — <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw>)**

Empirically **(observed — `resolve.exe`, real `portable-pty` 0.9.0)**:

```
=== A: CommandBuilder::new("claude") ===
    argv: ["claude", "--version"]
    SPAWN ERROR: CreateProcessW `"C:\Users\ahmet\AppData\Roaming\npm\claude --version\0"`
      in cwd `Some("C:\Users\ahmet\AppData\Local\Temp\0")`
      failed: %1 is not a valid Win32 application. (os error 193)
```

Note *what* it resolved to: the extensionless sh script. Confirmed by case E, which names that file explicitly and produces the identical error, and case F, which prunes the npm dir from PATH and gets `os error 2` (not found) instead.

**`CommandBuilder::new("claude")` is broken on any Windows box with an npm-installed Claude Code.** It is not a subtle failure mode; it never starts.

### 3.2 The `.cmd` shim does spawn — but you do not want it

```
=== B: explicit claude.cmd path ===
    argv: ["…\npm\claude.cmd", "--version"]
    SPAWN OK
    output: "…\x1b]0;C:\WINDOWS\system32\cmd.exe\x07…"
```

**(observed)** So `CreateProcessW` *does* accept a `.cmd` as `lpApplicationName`, despite the docs saying *"To run a batch file, you must start the command interpreter; set lpApplicationName to cmd.exe and set lpCommandLine to the following arguments: /c plus the name of the batch file."* **(docs — same page)**. Windows silently interposes `%COMSPEC%` — you can see it in the title the console sets: `ESC]0;C:\WINDOWS\system32\cmd.exe BEL`.

That interposition is exactly the problem. Your direct child is `cmd.exe`, not the agent. Consequences, all measured:

- **The exit code you observe is cmd.exe's**, not the agent's.
- **`child.kill()` orphans the agent.** See §8.2 — measured, unambiguous.
- Ctrl-C / console control events are routed through the batch interpreter.

Using `cmd.exe /c <shim>` explicitly (case C) gives the same shape and the same problems.

### 3.3 The correct Windows spawn path

Resolve to the **PE image** yourself and hand that to `CommandBuilder`. Case D **(observed)**: naming `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe` directly spawns cleanly, exits 0, and prints `2.1.220 (Claude Code)`.

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::path::{Path, PathBuf};

/// Resolve an agent CLI to a real executable image on Windows.
/// Returns None if only non-executable shims were found.
#[cfg(windows)]
fn resolve_native_exe(program: &str) -> Option<PathBuf> {
    fn is_pe(p: &Path) -> bool {
        std::fs::File::open(p).ok().and_then(|mut f| {
            use std::io::Read;
            let mut m = [0u8; 2];
            f.read_exact(&mut m).ok().map(|_| &m == b"MZ")
        }).unwrap_or(false)
    }

    // 1. The native installer's well-known location wins.
    if let Ok(home) = std::env::var("USERPROFILE") {
        let p = Path::new(&home).join(".local").join("bin").join(format!("{program}.exe"));
        if p.is_file() && is_pe(&p) { return Some(p); }
    }

    // 2. Otherwise walk PATH x PATHEXT, but ONLY accept PE images --
    //    this is the fix for portable-pty's extensionless-match bug.
    let path = std::env::var_os("PATH")?;
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.COM".into());
    for dir in std::env::split_paths(&path) {
        for ext in pathext.split(';').filter(|e| !e.is_empty()) {
            let cand = dir.join(format!("{program}{}", ext.to_ascii_lowercase()));
            if cand.is_file() && is_pe(&cand) { return Some(cand); }
        }
    }

    // 3. Last resort: an npm .cmd shim points at the real exe. Parse it out
    //    rather than executing it, so the agent stays our direct child.
    for dir in std::env::split_paths(&path) {
        let shim = dir.join(format!("{program}.cmd"));
        if let Ok(text) = std::fs::read_to_string(&shim) {
            if let Some(rel) = text.lines().rev()
                .find_map(|l| l.trim().strip_prefix('"')?.split('"').next())
            {
                let target = dir.join(rel.replace("%dp0%\\", "").replace("%dp0%", ""));
                if target.is_file() && is_pe(&target) { return Some(target); }
            }
        }
    }
    None
}
```

Then the spawn itself is unremarkable:

```rust
let pty_system = native_pty_system();
let pair = pty_system.openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })?;

let exe = resolve_native_exe("claude").ok_or_else(|| anyhow!("claude not found"))?;
let mut cmd = CommandBuilder::new(exe);
cmd.arg(opening_prompt);        // see section 6 -- this is the whole injection story
cmd.cwd(&ticket_worktree);
cmd.env("TERM", "xterm-256color");
// Do NOT let the harness's own session markers leak in -- see 5.3.
cmd.env_remove("CLAUDE_CODE_CHILD_SESSION");

let mut child = pair.slave.spawn_command(cmd)?;
drop(pair.slave);               // release the slave handle promptly

let reader = pair.master.try_clone_reader()?;
let writer = std::sync::Arc::new(std::sync::Mutex::new(pair.master.take_writer()?));
```

**ConPTY vs legacy console:** there is no legacy path to worry about. `portable-pty` 0.9.0's Windows backend is ConPTY-only, and it hard-fails at load time if the kernel lacks the entry points **(source — `pty/src/win/psuedocon.rs`)**:

```rust
let kernel = ConPtyFuncs::open(Path::new("kernel32.dll")).expect(
    "this system does not support conpty.  Windows 10 October 2018 or newer is required",
);
// We prefer to use a sideloaded conpty.dll and openconsole.exe host deployed
// alongside the application.
if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) { sideloaded } else { kernel }
```

Claude Code's own floor is *Windows 10 1809+* **(docs — setup page)** — the same release that introduced ConPTY. The two constraints coincide, so a single code path suffices. The sideload hook is a bonus: shipping a newer `conpty.dll` + `OpenConsole.exe` next to the Tauri binary upgrades the ConPTY implementation without touching the OS.

---

## 4. The ConPTY startup handshake — the deadlock that eats naive harnesses

**This is the single most important operational finding in this document.**

`portable-pty` creates the pseudoconsole with three flags, unconditionally **(source — `pty/src/win/psuedocon.rs`)**:

```rust
pub const PSUEDOCONSOLE_INHERIT_CURSOR: DWORD = 0x1;
pub const PSEUDOCONSOLE_RESIZE_QUIRK:   DWORD = 0x2;
pub const PSEUDOCONSOLE_WIN32_INPUT_MODE: DWORD = 0x4;
…
(CONPTY.CreatePseudoConsole)(
    size, input.as_raw_handle() as _, output.as_raw_handle() as _,
    PSUEDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE,
    &mut con,
)
```

`PSUEDOCONSOLE_INHERIT_CURSOR` makes ConPTY emit a **DSR cursor-position request (`ESC[6n`) on the output pipe before the client runs, and wait for the reply on the input pipe.** Microsoft warns about it explicitly **(docs — <https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session>)**:

> Additionally, if `PSEUDOCONSOLE_INHERIT_CURSOR` was selected while creating the pseudoconsole, attempting to close the pseudoconsole without responding to the cursor inheritence query message (received on `hOutput` and replied to via `hInput`) may result in another deadlock condition.

In practice it is worse than "on close". Measured **(observed — `capture.exe`, `claude.exe --version`, identical runs except for whether the harness answers)**:

| | Reply to `ESC[6n` | Do not reply |
| --- | --- | --- |
| Bytes captured in 15 s | 161 | 0 |
| Child exit status | `Some(0)` | `None` (never ran) |
| Version printed | `2.1.220 (Claude Code)` | nothing |

The first four bytes off the wire are literally `ESC [ 6 n`, at 24–26 ms, before the client emits anything **(observed)**:

```
<ESC>[6n<ESC>[?9001h<ESC>[?1004h<ESC>[m<ESC>]0;…claude.exe<07><ESC>[?25h2.1.220 (Claude Code)<CR><LF>
```

**A headless harness must act as a terminal here.** Minimal responder:

```rust
// Answer ConPTY's cursor-inheritance query, or nothing ever starts.
// A full xterm.js front end does this for you; a Rust-side reader does not.
if chunk.windows(4).any(|w| w == b"\x1b[6n") {
    writer.lock().unwrap().write_all(b"\x1b[1;1R")?;   // CPR: row 1, col 1
    writer.lock().unwrap().flush()?;
}
```

For the actual product this is mostly free — an xterm.js-class renderer answers DSR itself, so wiring `master → frontend → master` satisfies ConPTY. But **any Rust-side path that reads the pty without piping input back will hang forever**, including tests, health checks, and "warm the CLI before showing the terminal" optimisations. Budget for it.

The other two flags are the ones you want. `PSEUDOCONSOLE_WIN32_INPUT_MODE` is why you see `ESC[?9001h` in the capture; `PSEUDOCONSOLE_RESIZE_QUIRK` fixes ConPTY's historical off-by-one on resize. Note that **plain UTF-8 text written to the input pipe still works** under win32-input-mode — every injection experiment in §6 used plain bytes **(observed)**.

---

## 5. macOS

### 5.1 The spawn path (source-derived; runtime **unverified**)

`portable-pty`'s Unix backend is a conventional `openpty` + `setsid` + `TIOCSCTTY` **(source — `pty/src/unix.rs`)**:

```rust
libc::openpty(&mut master, &mut slave, ptr::null_mut(), ptr::null_mut(), &mut size)
…
cmd.stdin(self.as_stdio()?).stdout(self.as_stdio()?).stderr(self.as_stdio()?)
   .pre_exec(move || {
        for signo in &[SIGCHLD, SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGALRM] {
            libc::signal(*signo, libc::SIG_DFL);
        }
        libc::sigprocmask(SIG_SETMASK, &empty_set, ptr::null_mut());
        if libc::setsid() == -1 { return Err(io::Error::last_os_error()); }
        if controlling_tty {
            // Failure to do this means that delivery of SIGWINCH won't happen
            // when we resize the terminal, among other undesirable effects.
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 { return Err(io::Error::last_os_error()); }
        }
        close_random_fds();
        Ok(())
   })
```

Three things follow, all of which are *better* than the Windows story:

- **No shim problem.** Unix `search_path` requires `access(X_OK)` and executes the resolved path via `std::process::Command`, so a `#!`-scripted shim runs correctly through the kernel's shebang handling. The macOS native install is a symlink to a real binary anyway (§1.2).
- **No cursor-inheritance handshake.** There is no DSR query. `CommandBuilder::new("claude")` genuinely works, given a correct PATH.
- **`close_random_fds()` is Tauri-relevant.** Its doc comment: *"On Big Sur, Cocoa leaks various file descriptors to child processes, so we need to make a pass through the open descriptors beyond just the stdio descriptors and close them all out."* **(source)** A Tauri app *is* a Cocoa app, so this is exactly the case it was written for. Good news — it is already handled.

### 5.2 The real macOS problem: PATH

`CommandBuilder`'s base environment on Unix is just the current process's environment **(source — `get_base_env()` uses `std::env::vars_os()`, plus a `SHELL` fallback from the passwd database)**. It does no login-shell harvesting. So the child inherits *the Tauri app's* environment verbatim.

A GUI-launched macOS app does not have the user's shell PATH. Apple's DTS engineer Quinn "The Eskimo!" on the developer forums **(docs — <https://developer.apple.com/forums/thread/74371>)**:

> If you're going to package a cross platform app for the Mac, you should consider the necessary environment variable support as part of the packaging process. For example:
> - You can include environment variables in the `LSEnvironment` property your `Info.plist`.
> - You can build a trampoline that loads up the required environment variables from a configuration file then execs the real executable.

and, on a later follow-up about GUI programs failing to run command-line tools:

> Have you tried wrapping the tool in a shell script that sets the path before invoking the real tool?

This bites hardest for node-version-manager installs (nvm/fnm/volta put their shims under `~/.nvm/versions/...` and add them to PATH purely from `.zshrc`/`.zprofile`). Options, with trade-offs:

| Remedy | Gets nvm-installed CLIs? | Cost |
| --- | --- | --- |
| Probe `~/.local/bin/claude` and Homebrew prefixes directly | No (only native/brew installs) | Free, zero latency, no shell execution. **Covers the documented recommended install.** |
| Run `$SHELL -l -i -c 'command -v claude'` once at startup and cache | Yes | Executes the user's full interactive rc; slow (100 ms–2 s), can hang on rc files that prompt, and is a code-execution surface |
| Run `$SHELL -l -c 'echo $PATH'` (login, non-interactive) | Usually — most managers write to `.zprofile`/`.zshenv` | Same class of risk, less of it. `.zshrc`-only setups miss |
| `/usr/libexec/path_helper -s` | No | Only reconstructs `/etc/paths` + `/etc/paths.d`. Does not read user dotfiles. Insufficient alone |
| `LSEnvironment` in `Info.plist` | No | Static at build time; cannot know the user's PATH |
| `launchctl setenv PATH …` | Yes, if the user sets it up | Requires user action; global side effect; Apple discourages it |
| Spawn the CLI *through* a login shell: `CommandBuilder::from_argv(vec!["/bin/zsh", "-l", "-c", "exec claude …"])` | Yes | Puts a shell between you and the agent — reintroduces the §8.2 kill/exit-code problem that Windows forces on you. Use `exec` to avoid it |

**Recommendation:** direct probe first (covers the documented recommended install with zero risk), fall back to a cached, timeout-bounded `$SHELL -l -c 'command -v claude'`, and offer a settings override for a manual path. Do *not* spawn the agent under a persistent shell — if you must use a shell to find it, use the shell only to *resolve* the path, then spawn the binary directly.

**All of §5.2 is (unverified) as behaviour** — I could not run a GUI-launched macOS app from here. The mechanism is well documented by Apple; the specific latencies and which dotfile a given version manager writes to are not something I measured.

### 5.3 Environment inheritance is *better* on Windows, oddly

Windows `get_base_env()` does something the Unix path does not **(source — `pty/src/cmdbuilder.rs`)**: after seeding from `std::env::vars_os()`, it reads the persisted environment out of the registry and merges it —

```rust
if let Ok(sys_env) = RegKey::predef(HKEY_LOCAL_MACHINE)
    .open_subkey("System\\CurrentControlSet\\Control\\Session Manager\\Environment") { … }

if let Ok(sys_env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
    // Merge the system and user paths together
    let value = if name.to_ascii_lowercase() == "path" { /* sys + ";" + user */ } …
}
```

with `REG_EXPAND_SZ` values expanded through `ExpandEnvironmentStringsW`. So on Windows the child gets the user's *persisted* PATH even if the Tauri process was launched with a stale one. There is no equivalent on macOS, which is precisely the asymmetry §5.2 describes.

One leak to guard against, seen live: spawning from inside an existing Claude Code session produced the statusline warning **(observed)** —

```
⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
  · restart with CLAUDE_CODE_FORCE_SESSION_PERS…
```

The harness inherits and forwards `CLAUDE_CODE_*` variables from whatever launched it. Scrub them, or a session spawned from a dev terminal will silently not persist its transcript — which would break the observability plumbing in issue #2.

---

## 6. Readiness and prompt injection — the good news

### 6.1 You (mostly) do not need injection at all

`claude --help` on this machine **(observed)**:

```
Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                Your prompt
```

The CLI reference agrees **(docs — <https://code.claude.com/docs/en/cli-reference>)**:

| Command | Description | Example |
| --- | --- | --- |
| `claude "query"` | Start interactive session with initial prompt | `claude "explain this project"` |
| `claude -p "query"` | Query via SDK, then exit | `claude -p "explain this function"` |

**And slash commands work as the argv prompt in interactive mode.** I ran `claude "/help"` under a real ConPTY with no keystrokes injected; the captured screen at the end of the run shows the Help panel fully rendered **(observed)**:

```
Help │ General │ Commands │ Custom commands
Claude understands your codebase, makes edits with your permission, and executes commands…
Shortcuts
! for shell mode          double tap esc to clear input        ctrl + shift + _ to undo
/ for commands            shift + tab to auto-accept edits     alt + v to paste images
@ for file paths          ctrl + o for verbose output          alt + p to switch model
```

Note the asymmetry: `claude -p "/help"` returns `/help isn't available in this environment.` **(observed)**. Slash commands as argv are an **interactive-mode** capability. That is exactly the mode the harness uses.

Multi-line and long prompts go in as a single argv element. On Windows the command line has room: *"The maximum length of this string is 32,767 characters"* **(docs — CreateProcessW)**. `CommandBuilder::append_quoted` handles the quoting, including embedded quotes and trailing backslashes, and explicitly rejects embedded NULs **(source)**. On macOS the ceiling is `ARG_MAX` (≥ 1 MB on modern macOS, **unverified** here).

**This collapses the whole "readiness detection + keystroke injection" problem into `cmd.arg(prompt)`.** It is the load-bearing recommendation of this document.

Two caveats:
- This is a Claude Code capability. Whether Codex / other adapters accept an argv prompt must be checked per-CLI (see [`agent-cli-adapter-parity.md`](./agent-cli-adapter-parity.md)); the injection machinery below is the fallback for those that do not.
- It gets you *one* opening message. Anything the harness wants to send later still needs §6.4.

### 6.2 The startup sequence, timed

Captured from a real ConPTY in a **trusted** directory, 120×40, `TERM=xterm-256color` **(observed)**:

```
 24 ms  <ESC>[6n                      <- ConPTY DSR (must answer -- section 4)
 24 ms  <ESC>[?9001h <ESC>[?1004h     <- ConPTY win32-input-mode, focus events
 24 ms  <ESC>]0;…claude.exe<BEL>      <- console sets title to the exe path
223 ms  <ESC>]0;claude<BEL>           <- the app takes over the title
223 ms  <ESC>[?2004h                  <- BRACKETED PASTE ON      (byte offset 139)
        <ESC>[?1004h <ESC>[?2031h     <- focus events, colour-scheme notifications
        <ESC>[>0q                     <- XTVERSION query (terminal name/version)
        <ESC>[?1049h <ESC>[2J         <- ALTERNATE SCREEN ON     (byte offset 168)
        <ESC>[?1000h ?1002h ?1003h ?1006h  <- mouse tracking
530 ms  first partial paint
953 ms  banner: "Claude Code v2.1.220 / Opus 5 … / ~\Workspace\gaze"
1013 ms full UI, composer showing placeholder: Try "fix lint errors"
```

DECSET references **(docs — <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>)**: *"Ps = 2 0 0 4 ⇒ Set bracketed paste mode, xterm"*; *"Ps = 1 0 4 9 ⇒ Save cursor as in DECSC, xterm. After saving the cursor, switch to the Alternate Screen Buffer, clearing it first."*

### 6.3 Readiness detection: what actually works

Ranked by robustness, based on the capture above:

1. **`ESC[?1049h` (alternate screen on) — best available signal.** It fires at ~223 ms, immediately before the TUI paints, and it is emitted by the app, not by ConPTY. Crucially it is a *semantic* signal: the app only takes over the screen when it is about to run its main loop.

   It has a second, unexpected virtue. In an **untrusted** directory the CLI renders the workspace-trust modal **inline, with no alt-screen switch at all** — the same capture run against `%TEMP%` shows `ESC[?2004h` present but `ESC[?1049h` *absent*, and the screen reads **(observed)**:

   ```
   Accessing workspace: C:\Users\ahmet\AppData\Local\Temp
   Quick safety check: Is this a project you created or one you trust? …
   ❯ 1. Yes, I trust this folder
     2. No, exit
   Enter to confirm · Esc to cancel
   ```

   So "saw `ESC[?1049h`" distinguishes *ready for a prompt* from *stuck on a modal that will eat your keystrokes as menu selections*. That is worth a lot. (Print mode skips the dialog — *"The workspace trust dialog is skipped when Claude is run in non-interactive mode"* **(docs — `claude --help`)** — but interactive mode does not.)

2. **`ESC[?2004h` (bracketed paste on)** — fires ~20 ms earlier and marks "the input layer is installed". Weaker, because it also fires for the trust modal.

3. **First PTY output** — useless here. The first bytes are ConPTY's own handshake at 24 ms, long before the app exists.

4. **Prompt-string matching** — brittle as expected, and worse than you'd think: the TUI paints with absolute cursor addressing (`ESC[3;2H`) and per-word `ESC[1C` cursor advances, so the literal string "❯" and the surrounding text are not contiguous in the byte stream. You would need a real terminal emulator model to match on it. If you are already running xterm.js you have that model, but querying it from Rust means a round trip through the frontend.

5. **Fixed delay** — the spread between 223 ms (ready) and 1013 ms (fully painted) on a fast machine means any safe constant is ≥ 3 s. Acceptable only as a *timeout*, never as the primary signal.

6. **A probe** (write something and watch for an echo) — do not. It mutates the composer.

**Recommendation:** wait for `ESC[?1049h` with a hard timeout; if the timeout fires, check whether the buffer contains the trust-dialog text and surface that to the operator rather than blindly typing.

### 6.4 Injection, when you must

`claude` enables bracketed paste (`ESC[?2004h` at 223 ms, **observed**) and honours it. Measured directly: with the harness writing

```
ESC[200~ AAA first line CR BBB second line CR CCC third line ESC[201~
```

into a live session, the composer ended up holding all three lines as **one unsubmitted message** **(observed — final screen)**:

```
❯ AAA first line
  BBB second line
  CCC third line
```

Nothing was sent. The `CR`s inside the brackets became soft newlines, not submits. That is the whole hazard, resolved.

Recommended byte sequence:

```rust
fn inject_prompt(w: &mut dyn Write, text: &str) -> std::io::Result<()> {
    // Normalise to CR: in a pty, Enter is CR (0x0D), not LF.
    let body = text.replace("\r\n", "\r").replace('\n', "\r");
    w.write_all(b"\x1b[200~")?;     // begin bracketed paste
    w.write_all(body.as_bytes())?;
    w.write_all(b"\x1b[201~")?;     // end bracketed paste
    w.flush()?;
    // Submit as a SEPARATE write, only after the paste is acknowledged.
    // Do not append it inside the brackets -- it would be treated as literal text.
    Ok(())
}

fn submit(w: &mut dyn Write) -> std::io::Result<()> { w.write_all(b"\r")?; w.flush() }
```

Notes on the failure modes:

- **Without brackets, using `\n`:** the readline is looking for `CR`. LF is not Enter. You get either nothing or literal control characters — silent corruption rather than early submission.
- **Without brackets, using `\r`:** the first `\r` submits line one and the rest arrive as follow-up messages. This is the classic failure the ticket worries about, and it is real.
- **Do not put the submitting `\r` inside the brackets.** Send it after `ESC[201~`.
- **Chunk large pastes.** ConPTY's input pipe is created by `filedescriptor::Pipe::new()` with the default buffer **(source — `pty/src/win/conpty.rs`)**; a very large single write can block the writing thread. Write in ≤ 4 KB chunks from a thread that is not also servicing output — Microsoft's own warning applies: *"Servicing all of the pseudoconsole activities on the same thread may result in a deadlock where one of the communications buffers is filled and waiting for your action while you attempt to dispatch a blocking request on another channel."* **(docs — creating-a-pseudoconsole-session)**
- For a manual/interactive fallback, the TUI's own multi-line key is **`\⏎`** (backslash then Enter), per its help panel **(observed)**.

---

## 7. Resize

Both platforms are one call, `MasterPty::resize(PtySize)`.

**Windows** **(source — `pty/src/win/conpty.rs` → `psuedocon.rs`)**:

```rust
self.con.resize(COORD { X: num_cols as i16, Y: num_rows as i16 })?;
// -> (CONPTY.ResizePseudoConsole)(self.con, size)
```

`pixel_width`/`pixel_height` are stored in the cached `PtySize` but never forwarded — ConPTY takes characters only. `PSEUDOCONSOLE_RESIZE_QUIRK` is set at creation (§4), which is what you want on Windows 10/11.

**Unix** **(source — `pty/src/unix.rs`)**: `ioctl(fd, TIOCSWINSZ, &winsize)`, which makes the kernel deliver `SIGWINCH` to the foreground process group. This only works because `pre_exec` did `TIOCSCTTY` — the code comments say so directly: *"Failure to do this means that delivery of SIGWINCH won't happen when we resize the terminal."*

Practical guidance: debounce resize from the frontend (a drag produces dozens of events, each a `ResizePseudoConsole` and a full repaint), and resize **before** injecting a prompt — a reflow mid-composer can rewrap what you just pasted.

---

## 8. Teardown: what dies, and what does not

### 8.1 Closing the pseudoconsole kills the whole tree (Windows)

Microsoft **(docs — creating-a-pseudoconsole-session)**:

> To end the session, call the `ClosePseudoConsole` function with the handle from the original pseudoconsole creation. Any attached client character-mode applications, such as the one from the `CreateProcess` call, will be terminated when the session is closed. **If the original child was a shell-type application that creates other processes, any related attached processes in the tree will also be terminated.**

`portable-pty` wires that to `Drop` **(source — `pty/src/win/psuedocon.rs`)**:

```rust
impl Drop for PsuedoCon {
    fn drop(&mut self) { unsafe { (CONPTY.ClosePseudoConsole)(self.con) }; }
}
```

Verified, and it is emphatic. I spawned `claude.exe` in a ConPTY, let it come up with a full MCP fleet attached, then dropped `PtyPair::master` without calling `kill()` **(observed — `teardown.exe 3`)**:

```
tree before:  112312 claude.exe, 108520 uvx.exe, 52640 cmd.exe, 100084 cmd.exe,
              110128 conhost.exe, 106392 uv.exe, 116752 conhost.exe, 118512 node.exe,
              116684 conhost.exe, 111360 node.exe, 38112 nanobanana-mcp-server.exe,
              110812 cmd.exe, 92264 cmd.exe, 116740 python.exe, 43416 node.exe,
              93012 node.exe, 106860 python.exe, 123836 node.exe

-> dropping PtyPair master (ClosePseudoConsole), NOT calling kill()

status after (by pid):  all 18 dead
```

Same result via `child.kill()` (`TerminateProcess`) on the native exe with the master still open — all 18 gone **(observed — `teardown.exe 1`)**.

### 8.2 …unless you spawned through the `.cmd` shim

This is the concrete cost of §3.2. Spawning `claude.cmd` and calling `child.kill()` **(observed — `teardown.exe 2`)**:

```
direct child pid 112728
tree before:
      112728 cmd.exe
      107040 claude.exe
-> calling child.kill() (TerminateProcess)
tree after:
      112728 <gone>
      107040 claude.exe        <- SURVIVED
```

`TerminateProcess` kills exactly one process. The interposed `cmd.exe` absorbs the kill and the agent is orphaned. **Resolve to the PE image (§3.3) and this class of bug disappears.**

### 8.3 Tauri does nothing for you here

`RunEvent` gives you the hook but no behaviour **(docs — <https://docs.rs/tauri/latest/tauri/> at 2.11.5; enum defined in `crates/tauri/src/app.rs`)**:

```rust
/// The app is about to exit
#[non_exhaustive]
ExitRequested {
    /// Exit code.
    /// [`Option::None`] when the exit is requested by user interaction,
    /// [`Option::Some`] when requested programmatically via AppHandle::exit and AppHandle::restart.
    code: Option<i32>,
    /// Event API
    api: ExitRequestApi,
},
/// Event loop is exiting.
Exit,
```

Neither the enum nor the sidecar guide (<https://v2.tauri.app/develop/sidecar/>) documents any child-process cleanup, and the `RunEvent` source carries no such note. Tauri's own tracker has long-standing issues about exactly this ([tauri#1896 "Sidecar process is still alive when the main process exits"](https://github.com/tauri-apps/tauri/issues/1896), [tauri#2464](https://github.com/tauri-apps/tauri/issues/2464), [tauri#11686](https://github.com/tauri-apps/tauri/issues/11686) — `child.kill()` leaving a two-process binary half-alive on Windows, which is structurally the same bug as §8.2).

So: **drop the `PtyPair` explicitly in `RunEvent::ExitRequested`.** Hold the pairs in `tauri::State`, take them, drop them, then let the exit proceed.

### 8.4 The hard-kill case

`ExitRequested` does not fire on a crash, a `SIGKILL`, or Task Manager's End Task. Two belt-and-braces options:

- **Windows: a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.** *"If the job has the `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` flag specified, closing the last job object handle terminates all associated processes and then destroys the job object itself."* **(docs — <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>)** Handles are closed by the kernel when a process dies, however it dies, so this covers the crash case. *"After a process is associated with a job, by default any child processes it creates using `CreateProcess` are also associated with the job."* — so assigning the direct child covers the whole MCP fleet, provided you set neither breakaway limit.

  Caveat: `portable-pty` gives you the raw handle (`Child::as_raw_handle`) but assignment happens *after* `CreateProcess` returns, so there is a small window where a fast-forking child could escape. In practice the CLI does not fork within that window. Also note Tauri/WebView2 may already run the app inside a job — nested jobs are supported on Windows 8+, so this is fine, but do not set `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.

- **Unix: signal the process group.** The child is a session leader (`setsid()` in `pre_exec`), so `kill(-pgid, SIGHUP)` reaches the whole group. Note that `portable-pty`'s own killer does **not** do this — it signals the single pid **(source — `pty/src/lib.rs`)**:

  ```rust
  impl ChildKiller for std::process::Child {
      fn kill(&mut self) -> IoResult<()> {
          #[cfg(unix)] {
              // On unix, we send the SIGHUP signal instead of trying to kill the process.
              let result = unsafe { libc::kill(self.id() as i32, libc::SIGHUP) };
              …
              // grace period: 5 attempts, 50ms apart, then fall through
          }
          std::process::Child::kill(self)   // SIGKILL
      }
  }
  ```

  Use `MasterPty::process_group_leader()` (Unix-only, returns `tcgetpgrp` of the master fd) and negate it if you want the group. **(unverified at runtime.)**

---

## 9. Implications for the harness

### Safe to build on

- **Skip prompt injection for Claude Code entirely.** `claude "<prompt>"` starts an interactive session with the prompt already submitted, and **slash commands work this way in interactive mode** (verified live). One `cmd.arg(prompt)` replaces the entire readiness-detect-then-type dance and removes the ticket's stated existential risk. Keep the injection code as the adapter fallback, not the primary path.
- **`portable-pty` 0.9.0 is the right dependency.** Current, small, ConPTY-based on Windows, `openpty`+`setsid`+`TIOCSCTTY` on Unix, no legacy-console branch to maintain. It builds and runs on today's stable Rust.
- **Bracketed paste works.** `claude` enables `ESC[?2004h`, and `ESC[200~ … ESC[201~` with CR-normalised newlines lands a multi-line prompt in the composer as one unsubmitted message. Verified byte-for-byte. Send the submitting `\r` as a separate write afterwards.
- **`ESC[?1049h` is a real readiness signal**, and it doubles as a "not stuck on the trust modal" check.
- **Teardown is solved on Windows** if you spawn the PE image: dropping `PtyPair` calls `ClosePseudoConsole`, which reaped an entire 18-process MCP tree in the measured case.
- **Resize is a one-liner** on both platforms, with the right ConPTY quirk flag already set.
- **Windows PATH is more reliable than you'd expect** — `CommandBuilder` merges the registry-persisted environment, so a stale Tauri process environment does not break discovery.

### Must be designed around

- **`CommandBuilder::new("claude")` does not work on npm-Windows.** It resolves npm's extensionless POSIX shim and dies with `os error 193`. Ship the PE-resolver from §3.3 and treat "found only shims" as a first-class error state with a real message.
- **Never let `cmd.exe` become the direct child.** Measured: `child.kill()` then orphans the agent. The `.cmd` route also lies about exit codes.
- **Answer ConPTY's `ESC[6n`.** Any Rust-side pty consumer that does not write CPR back gets a child that produces zero bytes and never exits. This is almost certainly what defeated the earlier `winpty` attempts logged in issue #2's research. Make the query-responder part of the pty plumbing itself, not something the frontend happens to provide.
- **Handle the workspace trust dialog.** A fresh worktree per ticket means a fresh, untrusted directory — the modal will be the default experience, not the exception, and blind keystrokes there select menu items. Detect it (no alt-screen + known text) and either surface it or pre-trust the directory deliberately.
- **Scrub `CLAUDE_CODE_*` from the inherited environment** before spawning, or dev-launched sessions silently lose transcript persistence.
- **Drop the `PtyPair` in `RunEvent::ExitRequested`.** Tauri does not clean up children for you and its issue tracker shows this biting people repeatedly.
- **One writer, one reader, separate threads.** `take_writer` is single-use; share it behind a mutex, and never service input and output on the same thread.

### Still risky / unresolved

- **Everything macOS is unverified at runtime.** The source and Apple's docs make the mechanism clear, but no macOS code was executed for this document. Before committing, run the §3.3-equivalent probe on a real Mac — specifically: a GUI-launched (not `cargo run`-launched) Tauri app, spawning a CLI installed via nvm, to confirm the PATH failure and the chosen remedy.
- **PATH discovery for version-manager installs on macOS has no clean answer.** Every remedy trades correctness against latency, hang-risk, or executing the user's dotfiles. Budget for a manual-path setting in the UI; some users will need it.
- **Homebrew and WinGet install paths are unverified.** Both appear in the official install matrix, so the resolver must be tested against them.
- **Job-object assignment has a small race window** between `CreateProcess` returning and `AssignProcessToJobObject`. Low probability, but it is the difference between "usually cleans up" and "always cleans up" after a hard kill.
- **Argv-prompt support is per-adapter.** Claude Code has it. Whether Codex and others do is the subject of [`agent-cli-adapter-parity.md`](./agent-cli-adapter-parity.md) — if they do not, those adapters carry the full readiness + bracketed-paste path, and the risk this ticket describes returns for them specifically.
- **Large-prompt chunking is untested.** I injected three short lines. A 20 KB brief through a default-sized ConPTY input pipe was not exercised; chunk it and test before trusting it.

---

## Appendix: reproducing the experiments

Throwaway cargo project at `%TEMP%\ptyprobe` with `portable-pty = "0.9"`:

| Binary | What it establishes |
| --- | --- |
| `resolve.exe` | Six spawn variants (bare name, `.cmd`, `cmd /c`, native exe, sh shim, pruned PATH) with a 45 s deadline each — §3.1–3.3 |
| `capture.exe <secs> <reply 0\|1> <none\|plain-lf\|plain-cr\|bracketed> <prog> [args…]` | Acts as a minimal terminal: answers DSR/DA, timestamps read events, scans for DECSET sequences, dumps head/tail escaped, optional `PROBE_DUMP` raw file — §4, §6 |
| `teardown.exe <1\|2\|3>` | Enumerates the child's full process tree via `Win32_Process`, tears down, then re-checks each pid individually — §8 |

`portable-pty` sources read at `%TEMP%\ptyres\` (`cmdbuilder.rs`, `conpty.rs`, `psuedocon.rs`, `win/mod.rs`, `lib.rs`, `unix.rs`, `Cargo.toml`) from `https://raw.githubusercontent.com/wezterm/wezterm/main/pty/src/…`.
