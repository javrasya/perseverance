# Hostile PowerShell profiles and harvest framing on Windows

Measurements for [#26](https://github.com/javrasya/perseverance/issues/26). Verifies whether
[#21](https://github.com/javrasya/perseverance/issues/21)'s macOS harvest-framing rules survive contact with Windows,
which [#25](https://github.com/javrasya/perseverance/issues/25) could not test.

**Machine.** Windows 11 Pro 26200, Windows PowerShell **5.1.26100.6584**, `pwsh` **absent**, oh-my-posh 29.0.2,
system node v24.12.0, fnm/mise absent (uninstalled by #25), unelevated.
Execution policy: `LocalMachine=Unrestricted`, `CurrentUser=RemoteSigned`, `MachinePolicy/UserPolicy=Undefined`.
`HKLM\SOFTWARE\Microsoft\PowerShell\1\ShellIds\ConsolePrompting` is **not set**.

**Scripts.** `scripts/wf-26-hostile-profiles.ps1` (fixture matrix), `scripts/wf-26-round2.ps1`
(contamination fixtures + cost). Raw results in `scripts/wf-26-results.json`.

---

## Method: real autoload without touching the operator's profile

#25 recorded two blockers — the sandbox refused to write the operator's real `$PROFILE`, and this operator
**has no profile at all** — and fell back to an explicit dot-source. The refusal reproduces here.

It is avoidable. **Windows PowerShell 5.1 derives `$PROFILE` from the environment, not from the registry's
Shell Folders.** Giving a child `USERPROFILE` / `HOME` / `HOMEDRIVE` + `HOMEPATH` pointed at a sandbox directory
moves its whole profile search there:

```
$PROFILE.CurrentUserCurrentHost -> <sandbox>\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
[Environment]::GetFolderPath("MyDocuments") -> <sandbox>\Documents
```

So every measurement below is **genuine autoload** — the mechanism #26 asked for — with the operator's real
profile never written. Verified absent before, during and after every run.

This is itself a harness finding, not just a test rig: see *The `$PROFILE` path is environment-derived* below.

---

## 1. Stream mapping: which profile output reaches stdout

Fixture writes a banner, harness dumps a sentinel-framed env block. `pre` = non-empty stdout lines before `BEGIN`.

| profile writes | lands on | position | stdout-visible |
|---|---|---|---|
| `Write-Output` | stdout | before `BEGIN` | yes |
| **`Write-Host`** | **stdout** | before `BEGIN` | **yes** |
| `Write-Information -InformationAction Continue` | stdout | before `BEGIN` | yes |
| `Write-Warning` | stderr (CLIXML) | — | no |
| `Write-Error` (non-terminating) | stderr (CLIXML) | — | no |
| `Write-Verbose` | stderr (CLIXML) | — | no |
| `Write-Progress` | stderr (CLIXML) | — | no |
| native exe stderr (`cmd /c echo … 1>&2`) | stderr, **raw** | — | no |

**`Write-Host` does reach stdout** when stdout is redirected — the specific thing #26 flagged. It lands *before*
the sentinel like everything else, so ordering is not the problem. In all 25 non-timeout matrix cases,
**every byte the profile wrote to stdout landed before `BEGIN`**, and `junkInside` was 0.

### stderr is CLIXML, and it is a mixed stream

Windows PowerShell serialises the error/warning/verbose/progress streams as **CLIXML** when stdout is redirected:

```
#< CLIXML
<Objs Version="1.1.0.1" …><S S="Error">. : File …\Microsoft.PowerShell_profile.ps1 cannot _x000D__x000A_</S>…
```

Three consequences the harness has to absorb:

- **A baseline of 616 bytes of CLIXML arrives on stderr even with no profile at all** (`Preparing modules for
  first use.` progress records). *stderr is non-empty* is therefore **not** an error signal on Windows.
- Native-executable stderr passes through **raw and interleaved** with the CLIXML (`NATIVE-STDERR` then
  `#< CLIXML`). A parser must tolerate both in one stream.
- Error text is **hard-wrapped at console width before serialisation** (`cannot _x000D__x000A_be loaded`), so even
  after decoding you get mid-sentence line breaks. Any operator-facing readout of harvest stderr must either
  decode CLIXML and rejoin, or be presented as-is and expected to look broken.

---

## 2. Blocking profiles do not wedge the harvest — and `Get-Credential` raises no dialog

stdin redirected and **closed immediately** (EOF), per #21's *set rather than inherited*.

| fixture | exit | ms | wedged | profile continued past the blocking call |
|---|---|---|---|---|
| `Read-Host "PASSWORD"` | 0 | 1088 | **no** | yes (`WF26_MARK=post:`) |
| `Read-Host`, `-NonInteractive` | 0 | 1234 | **no** | yes |
| `Get-Credential` | 0 | 1873 | **no** | yes (`WF26_MARK=post`) |
| `Get-Credential`, `-NonInteractive` | 0 | 1778 | **no** | yes |

**No GUI dialog appeared** in any run, and none was needed to be dismissed — the feared macOS-analogue-free
failure mode does not occur under `UseShellExecute=false` + `CreateNoWindow` + redirected stdin, with
`ConsolePrompting` unset. #21's EOF rescue holds on Windows.

One asymmetry worth recording: **`Read-Host` at EOF is completely silent** — stderr stayed at the 616-byte
baseline and it returned a junk-but-harmless value. Under `-NonInteractive` it *does* error (1403 bytes).
`-NonInteractive` makes the blocking case louder; it does not change the outcome, and it does **not** change
which profiles load.

---

## 3. Truncation: the timeout rule holds, but two crashes defeat it

| fixture | exit | timed out | `BEGIN`/`END` | env vars | profile applied |
|---|---|---|---|---|---|
| `Start-Sleep 60` (5s timeout) | 1 (killed) | **yes** | **0 / 0** | 0 | — |
| `throw "BOOM"` mid-profile | **0** | no | **1 / 1** | 90 | **partial** (`pre`, never `post`) |
| `exit 3` mid-profile | **0** | no | **1 / 1** | 90 | **partial** (`pre`, never `post`) |

**#21's timeout rule holds exactly**: a killed harvest emits *no sentinel pair*, so *require both or discard*
is structurally sound for timeouts.

**It does not cover crashes, and this is a correction to the inherited framing.** A profile that throws, or
that calls `exit`, aborts **only the profile** — the payload still runs, both sentinels are present, the
process exits **0**, and the env block is complete-looking but reflects a **partially executed profile**.
This is #21's macOS `.zshrc:112` partial-harvest class, arriving on Windows through a path where *every
structural check passes*.

The two differ in what evidence they leave:

- `throw` → the error is on stderr (1209 bytes vs 616 baseline), inside CLIXML.
- **`exit` → stderr is at the 616-byte baseline. There is no evidence on either stream, and the exit code is 0.**

So an `exit` in a profile produces a well-framed, exit-0, silently-partial harvest that is **undetectable by
any check the harness currently has**. Same shape as #24's *spawnable ≠ correct*: this is
**complete-looking ≠ complete**.

---

## 4. Framing is mandatory but **not sufficient** — the rule #21 stated is disproved on Windows

#21 concluded *sentinel framing is mandatory and sufficient* because everything a profile emits precedes the
payload. That reasoning holds only for output written **while the profile is executing**. A profile can leave
something behind that writes **later**:

| fixture | contamination |
|---|---|
| raw `System.Threading.Thread` writing `[Console]::Out` | none (0 lines; process exit 5 — the scriptblock has no runspace) |
| **`System.Timers.Timer` + `Register-ObjectEvent` writing `[Console]::Out`** | **5 lines INSIDE the sentinels, 1 line after `END`** |

```
---PERSEVERANCE-BEGIN---
ASYNC-JUNK timer          <-- inside the frame
ASYNC-JUNK timer
…
---PERSEVERANCE-END---
ASYNC-JUNK timer          <-- after the frame
```

PowerShell services registered event actions on its own pipeline, so their output interleaves with the payload.
**Framing alone will hand the parser junk lines.** In these runs the junk was rejected anyway because it did
not match `NAME=VALUE`, which is the accidental reason the matrix reported `junkInside=0` everywhere else.

The minimum replacement the evidence supports, stated as requirements rather than a chosen wire format:

1. Framing stays **mandatory** — nothing here weakens *require both or discard*.
2. Every line inside the frame must **additionally** be validated by shape; a line that fails is dropped, not
   fatal. This is what already saved these runs.
3. Shape validation alone is still guessable — a contaminating line of the form `FOO=bar` would be accepted.
   Making contamination **structurally** rejectable needs a per-run secret in the payload: a random nonce
   prefixing each emitted line, or a NUL-delimited/base64 blob rather than line-oriented text. Choosing among
   those belongs to whoever writes the spec; the measurement only shows line-oriented framing is insufficient.

### Sentinel injection: the parser must take the **last** `BEGIN`

A profile that prints the sentinels itself:

| fixture | `BEGIN`/`END` seen | naive parser (first `BEGIN`) | last-`BEGIN` parser |
|---|---|---|---|
| prints `BEGIN` + `INJECTED=evil` | 2 / 1 | ingests `INJECTED=evil` | clean |
| prints `END` | 1 / 2 | clean | clean |
| prints `BEGIN` + `INJECTED=evil` + `END` | 2 / 2 | **returns exactly one var: `INJECTED=evil`** | clean |

A profile can **wholly substitute** the harvest result under a first-`BEGIN` parser. **Take the last `BEGIN`,
then the first `END` after it.** (Combined with a nonce this stops being an issue at all.)

---

## 5. Pipe handling: two hazards with no macOS analogue recorded

### Reading in the wrong order deadlocks on a chatty profile

`NaiveRead` = `WaitForExit()` before draining the pipes — the ordinary mistake.

| fixture (2000 lines ≈ 130 KB) | async drain | naive order |
|---|---|---|
| chatty on **stdout** | ok, 1297 ms, framed | **timeout at 12 s**, no sentinel pair |
| chatty on **stderr** | ok, 4234 ms, framed (1.64 MB stderr) | **timeout at 12 s**, no sentinel pair |

Both streams deadlock. *Require both or discard* keeps this **correct**, but note the failure is
indistinguishable from a genuinely hung profile — the harness would blame the operator's profile for its own
bug. **Drain both pipes concurrently with the wait.**

### EOF outlives process exit

A profile that starts a background process:

| | process exit | read-to-EOF completes |
|---|---|---|
| grandchild running `ping -n 4` | **1063 ms** | **4013 ms** (reproduced: 3997, 4102) |

The grandchild's own output never reached the pipe — but it **held the write handle**, so `ReadToEnd`
did not return until it died. `WaitForExit` returned at 1.06 s; the harvest did not.

**Process exit is not harvest completion.** A profile that launches a background updater makes every harvest as
slow as that updater; one that launches a **daemon** hangs the harvest forever behind a clean exit 0. The read
must terminate on the `END` sentinel (or be separately bounded), never on EOF alone.

---

## 6. Autoload specifics

**Ordering.** With both `profile.ps1` (CurrentUserAllHosts) and `Microsoft.PowerShell_profile.ps1`
(CurrentUserCurrentHost) present, the marker read `CUAH;CUCH` — **AllHosts runs before CurrentHost**, as
documented. Confirmed by autoload, not by reasoning.

**Execution policy.** Same benign fixture, launched with `-ExecutionPolicy AllSigned`:

- profile **did not run** (no marker; env count back to the 89-var baseline),
- **stdout was clean** — the banner fixture's `BANNER-OUT` never appeared,
- the refusal is reported **only** as CLIXML on stderr (`… cannot be loaded. The file … is not digitally signed`),
- **exit code 0, sentinels intact, harvest structurally perfect.**

So under `AllSigned` the harvest **silently degrades to plain inheritance** — precisely the silent-divergence
class #15 ruled to be *the* harm — and the only evidence is inside a CLIXML blob that #26's own baseline shows
is never empty. Any harness that ignores stderr will not notice. (This machine is `RemoteSigned`, where
locally-authored profiles load fine; `AllSigned` is an enterprise-policy reality, not a hypothetical.)

**`-NonInteractive`** does not change which profiles load.
**`-NoProfile`** suppresses as expected (baseline 89 vars, no marker) — used as the control throughout.

**The `$PROFILE` path is environment-derived.** `USERPROFILE` / `HOME` / `HOMEDRIVE` + `HOMEPATH` decide where
5.1 looks for profiles. The harness sets a child environment (#15's adapter-declared scrub set, #24's
per-folder env). **If any of those four are scrubbed, overridden or inherited from a stale harvest, the child
loads a different profile — or none.** #14's `CLAUDE_CODE_CHILD_SESSION` trap has a Windows sibling here, and
it is one the harness would author itself.

---

## 7. Cost with a real profile

Interleaved, 9 rounds, `System.Diagnostics.Process`, wall-clock spawn→harvest-complete.

| case | median | min | max |
|---|---|---|---|
| bare `-NoProfile -Command exit` | **591** | 568 | 687 |
| env dump, `-NoProfile` | 1017 | 992 | 1126 |
| env dump, no profile file present | 1002 | 954 | 1138 |
| harvest, benign one-line profile | **1020** | 970 | 1176 |
| harvest, `oh-my-posh init` only | **1481** | 1386 | 1691 |
| harvest, oh-my-posh + 5 module imports + alias + prompt | **1914** | 1823 | 2025 |

- **Profile autoload itself is free** — 1020 ms with a benign profile vs 1002 ms with none. #25's 1,206 ms
  stand-in number was measuring PowerShell startup, not profile evaluation.
- **The honest number for a real profile is 1.5–1.9 s**, and it is *profile content* that costs: oh-my-posh
  alone adds ~460 ms, the module imports another ~430 ms.
- Against #24's macOS ~130 ms this is **~15×**. #25's *cost can separate per-folder from per-spawn on Windows*
  holds and gets stronger: its cwd-keyed cache is load-bearing, and the harvest must stay off the launch path.

---

## Limitations

1. **`AllUsers*` profiles were not measured.** `$PROFILE.AllUsersAllHosts` derives from `$PSHOME`, which does
   **not** follow the environment, so the sandbox technique cannot reach it; writing to
   `System32\WindowsPowerShell\v1.0\` needs elevation. Their ordering relative to the CurrentUser pair is
   documented, not measured here.
2. **One host, one PowerShell.** All measurements are `powershell.exe` 5.1 ConsoleHost. `pwsh` is absent on
   this machine, and its profile path (`Documents\PowerShell\`) and CLIXML behaviour are untested.
3. **`ConsolePrompting` was unset.** With it set to `True`, `Get-Credential` prompts on the console instead of
   attempting a dialog; the no-dialog result above is for the default configuration only.
4. **No GUI-launched (Explorer/bundle) process was measured** — #25's limitation 1 is unchanged. Every spawn
   here descends from an agent session's console process.
5. The nonce/NUL-delimited wire format in §4 is a **recommendation from measured failure**, not a measured
   design — no such payload was built or timed.
