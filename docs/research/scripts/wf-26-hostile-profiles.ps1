<#
  wf-26: Hostile PowerShell profiles and harvest framing on Windows.

  Spawns powershell.exe the way the perseverance harness would -- REAL autoloaded
  $PROFILE, cwd set at spawn, stdin redirected and closed (EOF), sentinel-framed
  env dump -- against a matrix of hostile profile fixtures.

  Key mechanism: Windows PowerShell 5.1 derives $PROFILE from the ENVIRONMENT
  (USERPROFILE / HOME / HOMEDRIVE+HOMEPATH), not from the registry's Shell
  Folders. So the child is given a sandbox HOME and its profile autoloads from
  there. This is genuine autoload -- not the explicit dot-source #25 fell back
  to -- and the operator's real $PROFILE is never written.
#>

[CmdletBinding()]
param(
    [string]$SandboxHome = "$env:CLAUDE_JOB_DIR\tmp\fakehome",
    [string]$OutFile     = "$PSScriptRoot\wf-26-results.json",
    [string[]]$Only
)

$ErrorActionPreference = 'Stop'

$PSExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$BEGIN = '---PERSEVERANCE-BEGIN---'
$END   = '---PERSEVERANCE-END---'

$ProfDir  = Join-Path $SandboxHome 'Documents\WindowsPowerShell'
$ProfCUCH = Join-Path $ProfDir 'Microsoft.PowerShell_profile.ps1'  # CurrentUserCurrentHost
$ProfCUAH = Join-Path $ProfDir 'profile.ps1'                       # CurrentUserAllHosts

New-Item -ItemType Directory -Path $ProfDir -Force | Out-Null

# The payload the harness runs: sentinel-framed env dump.
$PayloadSrc = @"
Write-Output '$BEGIN'
Get-ChildItem Env: | ForEach-Object { Write-Output ("{0}={1}" -f `$_.Name, `$_.Value) }
Write-Output '$END'
"@
$PayloadB64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($PayloadSrc))

function Clear-Fixtures {
    foreach ($p in @($ProfCUCH, $ProfCUAH)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}

function Set-Fixture {
    param([string]$Path, [string]$Body)
    Set-Content -LiteralPath $Path -Value $Body -Encoding UTF8
}

function Invoke-Harvest {
    <#
      One harvest attempt. -NaiveRead reproduces the classic pipe-buffer deadlock
      (WaitForExit before draining the pipes) to test whether a chatty profile can
      wedge a harness that reads in the wrong order.
    #>
    param(
        [string]   $Cwd       = $PWD.Path,
        [string[]] $ExtraArgs = @(),
        [int]      $TimeoutMs = 15000,
        [switch]   $NaiveRead
    )

    $argv = @('-NoLogo') + $ExtraArgs + @('-EncodedCommand', $PayloadB64)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $PSExe
    $psi.Arguments              = ($argv -join ' ')
    $psi.WorkingDirectory       = $Cwd
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.RedirectStandardInput  = $true

    # Relocate the child's profile search into the sandbox.
    $psi.EnvironmentVariables['USERPROFILE'] = $SandboxHome
    $psi.EnvironmentVariables['HOME']        = $SandboxHome
    $psi.EnvironmentVariables['HOMEDRIVE']   = $SandboxHome.Substring(0, 2)
    $psi.EnvironmentVariables['HOMEPATH']    = $SandboxHome.Substring(2)

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$p.Start()

    # stdin: set, not inherited -- close immediately so any read sees EOF.
    try { $p.StandardInput.Close() } catch { }

    $timedOut = $false; $out = ''; $err = ''

    if ($NaiveRead) {
        $timedOut = -not $p.WaitForExit($TimeoutMs)
        if ($timedOut) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; try { [void]$p.WaitForExit(3000) } catch { } }
        try { $out = $p.StandardOutput.ReadToEnd() } catch { }
        try { $err = $p.StandardError.ReadToEnd() } catch { }
    }
    else {
        $tOut = $p.StandardOutput.ReadToEndAsync()
        $tErr = $p.StandardError.ReadToEndAsync()
        $timedOut = -not $p.WaitForExit($TimeoutMs)
        if ($timedOut) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; try { [void]$p.WaitForExit(3000) } catch { } }
        try { [void]$tOut.Wait(5000); $out = $tOut.Result } catch { }
        try { [void]$tErr.Wait(5000); $err = $tErr.Result } catch { }
    }
    $sw.Stop()

    $exit = $null
    try { $exit = $p.ExitCode } catch { }
    $p.Dispose()

    $lines = @()
    if ($out) { $lines = $out -split "`r?`n" }

    # Parser rule under test: LAST begin, then the FIRST end after it.
    $iBeg = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $BEGIN) { $iBeg = $i } }
    $iEnd = -1
    if ($iBeg -ge 0) { for ($i = $iBeg + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $END) { $iEnd = $i; break } } }

    # Naive rule, for contrast: FIRST begin, FIRST end after it.
    $jBeg = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $BEGIN) { $jBeg = $i; break } }
    $jEnd = -1
    if ($jBeg -ge 0) { for ($i = $jBeg + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $END) { $jEnd = $i; break } } }
    $naiveJunk = 0
    if ($jBeg -ge 0 -and $jEnd -gt $jBeg) {
        $naiveJunk = @($lines[($jBeg + 1)..($jEnd - 1)] | Where-Object { $_ -notmatch '^[^=]+=' -and $_.Trim() -ne '' }).Count
    }

    $between = @()
    if ($iBeg -ge 0 -and $iEnd -gt $iBeg) { $between = $lines[($iBeg + 1)..($iEnd - 1)] }
    $before = @(); if ($iBeg -gt 0) { $before = $lines[0..($iBeg - 1)] }
    $after  = @(); if ($iEnd -ge 0 -and $iEnd -lt ($lines.Count - 1)) { $after = $lines[($iEnd + 1)..($lines.Count - 1)] }

    [pscustomobject]@{
        exit        = $exit
        timedOut    = $timedOut
        ms          = [int]$sw.ElapsedMilliseconds
        beginCount  = @($lines | Where-Object { $_ -eq $BEGIN }).Count
        endCount    = @($lines | Where-Object { $_ -eq $END }).Count
        framed      = ($iBeg -ge 0 -and $iEnd -gt $iBeg)
        envCount    = @($between | Where-Object { $_ -match '^[^=]+=' }).Count
        junkInside  = @($between | Where-Object { $_ -notmatch '^[^=]+=' -and $_.Trim() -ne '' })
        naiveJunk   = $naiveJunk
        junkBefore  = @($before | Where-Object { $_.Trim() -ne '' })
        junkAfter   = @($after  | Where-Object { $_.Trim() -ne '' })
        stdoutBytes = $out.Length
        stderrBytes = $err.Length
        stderrHead  = if ($err) { (($err -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 2) -join ' | ') } else { '' }
        marker      = (@($between | Where-Object { $_ -like 'WF26_MARK=*' }) -join ',')
    }
}

# ------------------------------------------------------------------- cases ----
# Each case: fixtures (path->body), extra argv, timeout.

$F = [ordered]@{
    benign       = '$env:WF26_MARK = "benign"'
    out          = 'Write-Output "BANNER-OUT"; $env:WF26_MARK = "out"'
    hostBanner   = 'Write-Host "BANNER-HOST" -ForegroundColor Green; $env:WF26_MARK = "host"'
    warn         = 'Write-Warning "BANNER-WARN"; $env:WF26_MARK = "warn"'
    errNonTerm   = '$env:WF26_MARK = "err"; Write-Error "BANNER-ERR"'
    verbose      = '$VerbosePreference = "Continue"; Write-Verbose "BANNER-VERB"; $env:WF26_MARK = "verbose"'
    information  = 'Write-Information "BANNER-INFO" -InformationAction Continue; $env:WF26_MARK = "info"'
    progress     = 'Write-Progress -Activity "Loading" -Status "50%" -PercentComplete 50; $env:WF26_MARK = "progress"'
    nativeStderr = '$env:WF26_MARK = "native"; & cmd.exe /c "echo NATIVE-STDERR 1>&2"'
    ompInit      = 'oh-my-posh init pwsh | Invoke-Expression; $env:WF26_MARK = "omp"'
    heavy        = @'
oh-my-posh init pwsh | Invoke-Expression
Import-Module PSReadLine -ErrorAction SilentlyContinue
Import-Module Microsoft.PowerShell.Archive -ErrorAction SilentlyContinue
Import-Module Microsoft.PowerShell.Diagnostics -ErrorAction SilentlyContinue
Import-Module PackageManagement -ErrorAction SilentlyContinue
Import-Module Pester -ErrorAction SilentlyContinue
Set-Alias ll Get-ChildItem
function prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
$env:WF26_MARK = "heavy"
'@
    readHost     = '$env:WF26_MARK = "pre"; $x = Read-Host "PASSWORD"; $env:WF26_MARK = "post:$x"'
    getCred      = '$env:WF26_MARK = "pre"; $c = Get-Credential; $env:WF26_MARK = "post"'
    throwMid     = '$env:WF26_MARK = "pre"; throw "BOOM"; $env:WF26_MARK = "post"'
    exitMid      = '$env:WF26_MARK = "pre"; exit 3; $env:WF26_MARK = "post"'
    sleepLong    = '$env:WF26_MARK = "pre"; Start-Sleep -Seconds 60; $env:WF26_MARK = "post"'
    exitingHook  = 'Register-EngineEvent PowerShell.Exiting -Action { Write-Output "AFTER-END-LINE" } | Out-Null; $env:WF26_MARK = "exiting"'
    fakeBegin    = 'Write-Output "---PERSEVERANCE-BEGIN---"; Write-Output "INJECTED=evil"; $env:WF26_MARK = "fakebegin"'
    fakeEnd      = 'Write-Output "---PERSEVERANCE-END---"; $env:WF26_MARK = "fakeend"'
    fakeBoth     = 'Write-Output "---PERSEVERANCE-BEGIN---"; Write-Output "INJECTED=evil"; Write-Output "---PERSEVERANCE-END---"; $env:WF26_MARK = "fakeboth"'
    chattyOut    = '$env:WF26_MARK = "chatty"; 1..2000 | ForEach-Object { Write-Output ("CHATTY {0} {1}" -f $_, ("x" * 60)) }'
    chattyErr    = '$env:WF26_MARK = "chattyerr"; 1..2000 | ForEach-Object { [Console]::Error.WriteLine("CHATTYERR {0} {1}" -f $_, ("x" * 60)) }'
}

$Cases = [ordered]@{}
foreach ($k in $F.Keys) { $Cases[$k] = @{ cuch = $F[$k] } }

$Cases['none']            = @{ }
$Cases['readHost_NI']     = @{ cuch = $F['readHost']; args = @('-NonInteractive'); timeout = 8000 }
$Cases['getCred_NI']      = @{ cuch = $F['getCred'];  args = @('-NonInteractive'); timeout = 8000 }
$Cases['benign_AllSigned']= @{ cuch = $F['benign'];   args = @('-ExecutionPolicy', 'AllSigned') }
$Cases['out_AllSigned']   = @{ cuch = $F['out'];      args = @('-ExecutionPolicy', 'AllSigned') }
$Cases['order_bothProf']  = @{ cuch = '$env:WF26_MARK = "$($env:WF26_MARK);CUCH"'
                               cuah = '$env:WF26_MARK = "CUAH"' }
$Cases['noProfileFlag']   = @{ cuch = $F['out'];      args = @('-NoProfile') }
$Cases['chattyErr_naive'] = @{ cuch = $F['chattyErr']; naive = $true; timeout = 12000 }
$Cases['chattyOut_naive'] = @{ cuch = $F['chattyOut']; naive = $true; timeout = 12000 }

$Cases['readHost']['timeout']  = 8000
$Cases['getCred']['timeout']   = 8000
$Cases['sleepLong']['timeout'] = 5000

$results = [ordered]@{}

try {
    $names = @($Cases.Keys)
    if ($Only) { $names = $names | Where-Object { $Only -contains $_ } }

    foreach ($name in $names) {
        $c = $Cases[$name]
        Clear-Fixtures
        if ($c.cuch) { Set-Fixture -Path $ProfCUCH -Body $c.cuch }
        if ($c.cuah) { Set-Fixture -Path $ProfCUAH -Body $c.cuah }

        $to = 15000; if ($c.timeout) { $to = $c.timeout }
        $ea = @();   if ($c.args)    { $ea = $c.args }

        Write-Host ("[run] {0}" -f $name) -ForegroundColor Cyan
        $r = if ($c.naive) { Invoke-Harvest -ExtraArgs $ea -TimeoutMs $to -NaiveRead }
             else          { Invoke-Harvest -ExtraArgs $ea -TimeoutMs $to }
        $results[$name] = $r

        '{0,-18} exit={1,-6} to={2,-5} ms={3,-6} framed={4,-5} env={5,-4} B/E={6}/{7} in={8} pre={9} post={10} naiveJunk={11} errB={12} mark={13}' -f `
            $name, "$($r.exit)", "$($r.timedOut)", $r.ms, "$($r.framed)", $r.envCount, $r.beginCount, $r.endCount,
            $r.junkInside.Count, $r.junkBefore.Count, $r.junkAfter.Count, $r.naiveJunk, $r.stderrBytes, $r.marker | Write-Host
        if ($r.stderrHead)          { Write-Host ("                   stderr: " + $r.stderrHead) -ForegroundColor DarkGray }
        if ($r.junkBefore.Count)    { Write-Host ("                   before BEGIN: " + (($r.junkBefore | Select-Object -First 2) -join ' | ')) -ForegroundColor DarkYellow }
        if ($r.junkAfter.Count)     { Write-Host ("                   after END:    " + (($r.junkAfter  | Select-Object -First 2) -join ' | ')) -ForegroundColor Yellow }
        if ($r.junkInside.Count)    { Write-Host ("                   INSIDE:       " + (($r.junkInside | Select-Object -First 2) -join ' | ')) -ForegroundColor Red }
    }
}
finally {
    Clear-Fixtures
    $left = @($ProfCUCH, $ProfCUAH) | Where-Object { Test-Path -LiteralPath $_ }
    if ($left) { Write-Host "!! LEFTOVER FIXTURES: $($left -join ', ')" -ForegroundColor Red }
    else       { Write-Host "sandbox fixtures cleared" -ForegroundColor Green }
    $real = $PROFILE.CurrentUserCurrentHost
    Write-Host ("operator's real profile untouched: exists={0} ({1})" -f (Test-Path -LiteralPath $real), $real) -ForegroundColor Green
}

$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host "wrote $OutFile"
