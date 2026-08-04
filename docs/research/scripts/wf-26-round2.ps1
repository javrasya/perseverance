<#
  wf-26 round 2:
   (a) the two fixtures that can actually contaminate BETWEEN the sentinels --
       an in-process async writer, and a grandchild inheriting the stdout pipe;
   (b) the honest harvest cost with a real heavy profile (interleaved, median).

  Same sandbox-HOME autoload mechanism as wf-26-hostile-profiles.ps1.
#>

[CmdletBinding()]
param(
    [string]$SandboxHome = "$env:CLAUDE_JOB_DIR\tmp\fakehome",
    [int]$Rounds = 9
)

$ErrorActionPreference = 'Stop'

$PSExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$BEGIN = '---PERSEVERANCE-BEGIN---'
$END   = '---PERSEVERANCE-END---'

$ProfDir  = Join-Path $SandboxHome 'Documents\WindowsPowerShell'
$ProfCUCH = Join-Path $ProfDir 'Microsoft.PowerShell_profile.ps1'
New-Item -ItemType Directory -Path $ProfDir -Force | Out-Null

$PayloadSrc = @"
Write-Output '$BEGIN'
Get-ChildItem Env: | ForEach-Object { Write-Output ("{0}={1}" -f `$_.Name, `$_.Value) }
Write-Output '$END'
"@
$PayloadB64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($PayloadSrc))

function Clear-Fixtures { if (Test-Path -LiteralPath $ProfCUCH) { Remove-Item -LiteralPath $ProfCUCH -Force } }

function Invoke-Harvest {
    param([string[]]$ExtraArgs = @(), [int]$TimeoutMs = 15000, [int]$ReadWaitMs = 6000)

    $argv = @('-NoLogo') + $ExtraArgs + @('-EncodedCommand', $PayloadB64)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $PSExe; $psi.Arguments = ($argv -join ' ')
    $psi.WorkingDirectory = $PWD.Path
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
    $psi.EnvironmentVariables['USERPROFILE'] = $SandboxHome
    $psi.EnvironmentVariables['HOME']        = $SandboxHome
    $psi.EnvironmentVariables['HOMEDRIVE']   = $SandboxHome.Substring(0,2)
    $psi.EnvironmentVariables['HOMEPATH']    = $SandboxHome.Substring(2)

    $p = New-Object System.Diagnostics.Process; $p.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$p.Start()
    try { $p.StandardInput.Close() } catch { }

    $tOut = $p.StandardOutput.ReadToEndAsync()
    $tErr = $p.StandardError.ReadToEndAsync()
    $timedOut = -not $p.WaitForExit($TimeoutMs)
    $msExit = $sw.ElapsedMilliseconds
    if ($timedOut) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; try { [void]$p.WaitForExit(3000) } catch { } }

    # Guarded: if a grandchild still holds the pipe, .Result would block forever.
    $readTimedOut = $false
    $out = ''; $err = ''
    if ($tOut.Wait($ReadWaitMs)) { $out = $tOut.Result } else { $readTimedOut = $true }
    if ($tErr.Wait(2000))        { $err = $tErr.Result }
    $sw.Stop()

    $exit = $null; try { $exit = $p.ExitCode } catch { }
    $p.Dispose()

    $lines = @(); if ($out) { $lines = $out -split "`r?`n" }
    $iBeg = -1; for ($i=0; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $BEGIN) { $iBeg = $i } }
    $iEnd = -1; if ($iBeg -ge 0) { for ($i=$iBeg+1; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq $END) { $iEnd=$i; break } } }
    $between = @(); if ($iBeg -ge 0 -and $iEnd -gt $iBeg) { $between = $lines[($iBeg+1)..($iEnd-1)] }
    $after = @();   if ($iEnd -ge 0 -and $iEnd -lt ($lines.Count-1)) { $after = $lines[($iEnd+1)..($lines.Count-1)] }

    [pscustomobject]@{
        exit         = $exit
        timedOut     = $timedOut
        readTimedOut = $readTimedOut
        msExit       = [int]$msExit
        msTotal      = [int]$sw.ElapsedMilliseconds
        framed       = ($iBeg -ge 0 -and $iEnd -gt $iBeg)
        envCount     = @($between | Where-Object { $_ -match '^[^=]+=' }).Count
        junkInside   = @($between | Where-Object { $_ -notmatch '^[^=]+=' -and $_.Trim() -ne '' })
        junkAfter    = @($after  | Where-Object { $_.Trim() -ne '' })
        marker       = (@($between | Where-Object { $_ -like 'WF26_MARK=*' }) -join ',')
    }
}

# ------------------------------------------- (a) contamination fixtures ----

$asyncWriter = @'
$env:WF26_MARK = "async"
$sb = {
  for ($i = 1; $i -le 400; $i++) {
    [Console]::Out.WriteLine("ASYNC-JUNK $i")
    [System.Threading.Thread]::Sleep(3)
  }
}
$t = New-Object System.Threading.Thread ([System.Threading.ThreadStart]$sb)
$t.IsBackground = $true
$t.Start()
'@

$inheritedChild = @'
$env:WF26_MARK = "grandchild"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$env:SystemRoot\System32\cmd.exe"
$psi.Arguments = '/c "ping -n 4 127.0.0.1 >nul & echo LATE-GRANDCHILD-LINE"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
[void][System.Diagnostics.Process]::Start($psi)
'@

$cases = [ordered]@{
    asyncWriter    = $asyncWriter
    inheritedChild = $inheritedChild
}

Write-Host "=== (a) contamination between/after sentinels ===" -ForegroundColor Cyan
foreach ($n in $cases.Keys) {
    Clear-Fixtures
    Set-Content -LiteralPath $ProfCUCH -Value $cases[$n] -Encoding UTF8
    $r = Invoke-Harvest -TimeoutMs 15000 -ReadWaitMs 8000
    '{0,-16} exit={1,-5} to={2,-5} readTO={3,-5} msExit={4,-6} msTotal={5,-6} framed={6,-5} env={7,-4} INSIDE={8} AFTER={9} mark={10}' -f `
        $n, "$($r.exit)", "$($r.timedOut)", "$($r.readTimedOut)", $r.msExit, $r.msTotal, "$($r.framed)", $r.envCount,
        $r.junkInside.Count, $r.junkAfter.Count, $r.marker | Write-Host
    if ($r.junkInside.Count) { Write-Host ("     INSIDE sample: " + (($r.junkInside | Select-Object -First 3) -join ' | ')) -ForegroundColor Red }
    if ($r.junkAfter.Count)  { Write-Host ("     AFTER  sample: " + (($r.junkAfter  | Select-Object -First 3) -join ' | ')) -ForegroundColor Yellow }
}

# ------------------------------------------------------ (b) cost ----------

Write-Host ""
Write-Host "=== (b) harvest cost, interleaved, $Rounds rounds ===" -ForegroundColor Cyan

$benign = '$env:WF26_MARK = "benign"'
$omp    = 'oh-my-posh init pwsh | Invoke-Expression; $env:WF26_MARK = "omp"'
$heavy  = @'
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

$bench = [ordered]@{
    'bare -NoProfile -Command exit' = @{ fixture = $null;    args = @('-NoProfile'); bare = $true }
    'env dump, -NoProfile'          = @{ fixture = $null;    args = @('-NoProfile') }
    'env dump, no profile file'     = @{ fixture = $null;    args = @() }
    'harvest, benign profile'       = @{ fixture = $benign;  args = @() }
    'harvest, oh-my-posh only'      = @{ fixture = $omp;     args = @() }
    'harvest, heavy profile'        = @{ fixture = $heavy;   args = @() }
}
$samples = @{}
foreach ($k in $bench.Keys) { $samples[$k] = New-Object System.Collections.Generic.List[int] }

$bareB64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('exit'))

function Invoke-Bare {
    param([string[]]$ExtraArgs)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $PSExe
    $psi.Arguments = (@('-NoLogo') + $ExtraArgs + @('-EncodedCommand', $bareB64)) -join ' '
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = [System.Diagnostics.Process]::Start($psi)
    $t1 = $p.StandardOutput.ReadToEndAsync(); $t2 = $p.StandardError.ReadToEndAsync()
    [void]$p.WaitForExit(15000); [void]$t1.Wait(2000); [void]$t2.Wait(2000)
    $sw.Stop(); $p.Dispose()
    [int]$sw.ElapsedMilliseconds
}

for ($round = 1; $round -le $Rounds; $round++) {
    foreach ($k in $bench.Keys) {
        $c = $bench[$k]
        Clear-Fixtures
        if ($c.fixture) { Set-Content -LiteralPath $ProfCUCH -Value $c.fixture -Encoding UTF8 }
        $ms = if ($c.bare) { Invoke-Bare -ExtraArgs $c.args } else { (Invoke-Harvest -ExtraArgs $c.args -TimeoutMs 20000).msTotal }
        $samples[$k].Add($ms)
    }
    Write-Host ("  round $round done") -ForegroundColor DarkGray
}

Write-Host ""
'{0,-32} {1,7} {2,7} {3,7}' -f 'case', 'median', 'min', 'max' | Write-Host
foreach ($k in $bench.Keys) {
    $s = $samples[$k] | Sort-Object
    $med = $s[[int]([math]::Floor($s.Count / 2))]
    '{0,-32} {1,7} {2,7} {3,7}' -f $k, $med, $s[0], $s[$s.Count-1] | Write-Host
}

Clear-Fixtures
Write-Host ""
Write-Host ("operator's real profile untouched: exists={0}" -f (Test-Path -LiteralPath $PROFILE.CurrentUserCurrentHost)) -ForegroundColor Green
