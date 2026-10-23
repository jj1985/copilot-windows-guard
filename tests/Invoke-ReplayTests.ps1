# Replays tests/corpus through the PowerShell hook scripts and scores the decisions:
#   pwsh -NoProfile -File tests/Invoke-ReplayTests.ps1                      # hooks under PowerShell 7
#   pwsh -NoProfile -File tests/Invoke-ReplayTests.ps1 -Shell powershell    # hooks under Windows PowerShell 5.1
#   pwsh -NoProfile -File tests/Invoke-ReplayTests.ps1 -UpdateBaseline      # rewrite tests/corpus/baseline.json
# Writes tests/.work/replay-ps.json for tests/replay-parity.mjs. Each row costs one hook process, so
# rows run in parallel under PowerShell 7 (-ThrottleLimit) and one after another under 5.1.
param([string]$Shell = '', [string]$CorpusDir = '', [string]$OutFile = '', [switch]$UpdateBaseline, [int]$ThrottleLimit = 8)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$Root = Split-Path -Parent $PSScriptRoot
$Scripts = Join-Path $Root 'plugins\windows-guard\scripts'
if (-not $CorpusDir) { $CorpusDir = Join-Path $PSScriptRoot 'corpus' }
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot '.work\replay-ps.json' }
if (-not $Shell) { $Shell = (Get-Process -Id $PID).Path } else { $Shell = (Get-Command $Shell).Source }
$Work = Join-Path ([IO.Path]::GetTempPath()) ('wg-replay\' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
# Same minimal PATH as the unit tests: the hook host stays reachable, Git-for-Windows head/grep do not.
$MinPath = "$env:SystemRoot\System32;$env:SystemRoot;$(Split-Path -Parent $Shell)"

function Read-Jsonl([string]$Path) {
    $rows = @()
    $n = 0
    foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
        $n++
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        try { $rows += ($t | ConvertFrom-Json) } catch { throw "$(Split-Path -Leaf $Path):$n : $($_.Exception.Message)" }
    }
    return $rows
}

function Get-Prop($Obj, [string]$Name) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
    return $null
}

$commands = @(Read-Jsonl (Join-Path $CorpusDir 'commands.jsonl'))
$failures = @(Read-Jsonl (Join-Path $CorpusDir 'failures.jsonl'))
Write-Host "Hook host: $Shell"
Write-Host "Corpus: $($commands.Count) commands, $($failures.Count) failures"

# One job per row: the script to run and the hook payload on stdin.
$jobs = @()
foreach ($r in $commands) {
    $payload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = 'powershell'; toolArgs = @{ command = [string]$r.command } }
    $jobs += [pscustomobject]@{ id = $r.id; kind = 'command'; script = (Join-Path $Scripts 'shell-guard.ps1'); payload = ($payload | ConvertTo-Json -Compress -Depth 5) }
}
foreach ($r in $failures) {
    $ta = @{}
    $args = Get-Prop $r 'toolArgs'
    if ($null -ne $args) { foreach ($p in $args.PSObject.Properties) { $ta[$p.Name] = $p.Value } }
    if ($r.event -eq 'failure') {
        $payload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = [string]$r.tool; toolArgs = $ta; error = [string]$r.text }
    } else {
        $payload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = [string]$r.tool; toolArgs = $ta; toolResult = @{ resultType = 'success'; textResultForLlm = [string]$r.text } }
    }
    $jobs += [pscustomobject]@{ id = $r.id; kind = 'failure'; script = (Join-Path $Scripts 'recovery-coach.ps1'); payload = ($payload | ConvertTo-Json -Compress -Depth 5) }
}

$savedPath = $env:PATH
$env:PATH = $MinPath            # inherited by every hook process; restored below
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $results = @($jobs | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
            $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $out = ($_.payload | & $using:Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $_.script 2>&1 | ForEach-Object { "$_" }) -join "`n"
            [pscustomobject]@{ id = $_.id; kind = $_.kind; out = $out; code = $LASTEXITCODE }
        })
    } else {
        $results = @(foreach ($j in $jobs) {
            $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $out = ($j.payload | & $Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $j.script 2>&1 | ForEach-Object { "$_" }) -join "`n"
            [pscustomobject]@{ id = $j.id; kind = $j.kind; out = $out; code = $LASTEXITCODE }
        })
    }
} finally { $env:PATH = $savedPath }
Write-Host ("Replayed {0} rows in {1:n1} s" -f $results.Count, $sw.Elapsed.TotalSeconds)

$decisions = @{}
$outcomes = @{}
foreach ($res in $results) {
    if ($res.kind -eq 'command') {
        $deny = $false; $reason = ''
        if ($res.out) {
            try { $o = $res.out | ConvertFrom-Json; $deny = ($o.permissionDecision -eq 'deny'); $reason = [string]$o.permissionDecisionReason } catch { $reason = $res.out }
        }
        $decision = 'allow'; if ($deny) { $decision = 'deny' }
        $decisions[$res.id] = @{ decision = $decision; reason = $reason; code = $res.code }
    } else {
        $advice = $null
        if ($res.out) { try { $advice = [string](($res.out | ConvertFrom-Json).additionalContext) } catch { $advice = $null } }
        if (-not $advice) { $advice = $null }
        $outcomes[$res.id] = @{ advice = $advice; code = $res.code }
    }
}

# Mirrors tests/corpus/metrics.mjs: positive class "deny" for commands, "advice" for failures.
function Get-Score($Rows, $Results, [string]$Positive, [scriptblock]$DecisionOf, [scriptblock]$TextOf) {
    $m = @{ labeled = 0; unlabeled = 0; tp = 0; fp = 0; fn = 0; tn = 0; hintMisses = 0; gapsOpen = 0; gapsClosed = 0; positiveAlthoughSucceeded = 0; failures = @(); closed = @() }
    foreach ($r in $Rows) {
        $res = $Results[$r.id]
        if ($null -eq $res) { $m.failures += "$($r.id): no result recorded"; continue }
        $got = & $DecisionOf $res
        if ($got -eq $Positive -and (Get-Prop $r 'succeeded') -eq $true) { $m.positiveAlthoughSucceeded++ }
        $want = Get-Prop $r 'expect'
        if (-not $want) { $m.unlabeled++; continue }
        $m.labeled++
        if ($want -eq $Positive -and $got -eq $Positive) { $m.tp++ }
        elseif ($want -eq $Positive) { $m.fn++ }
        elseif ($got -eq $Positive) { $m.fp++ }
        else { $m.tn++ }
        $hint = [string](Get-Prop $r 'hint')
        $text = [string](& $TextOf $res)
        $hintOk = (-not $hint) -or ($got -ne $Positive) -or ($text.IndexOf($hint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if ($want -eq $got -and -not $hintOk) { $m.hintMisses++ }
        $ok = ($want -eq $got) -and $hintOk
        $gap = ((Get-Prop $r 'status') -eq 'known-gap')
        if ($gap) {
            if ($ok) { $m.gapsClosed++; $m.closed += $r.id } else { $m.gapsOpen++ }
        } elseif (-not $ok) {
            $snippet = $text; if ($snippet.Length -gt 140) { $snippet = $snippet.Substring(0, 140) }
            if ($want -eq $got) { $m.failures += "$($r.id): hint `"$hint`" missing in: $snippet" }
            else { $m.failures += "$($r.id): expected $want, got ${got}: $snippet" }
        }
    }
    $m.precision = 1.0; if (($m.tp + $m.fp) -gt 0) { $m.precision = $m.tp / ($m.tp + $m.fp) }
    $m.recall = 1.0; if (($m.tp + $m.fn) -gt 0) { $m.recall = $m.tp / ($m.tp + $m.fn) }
    return $m
}

function Round4([double]$X) { return [math]::Round($X, 4, [MidpointRounding]::AwayFromZero) }

function Show-Score([string]$Name, $m) {
    Write-Host ("{0}: {1} labeled rows ({2} unlabeled), tp={3} fp={4} fn={5} tn={6}" -f $Name, $m.labeled, $m.unlabeled, $m.tp, $m.fp, $m.fn, $m.tn)
    Write-Host ("  precision={0} recall={1} hint-misses={2} known-gaps open={3} closed={4} positive-although-succeeded={5}" -f (Round4 $m.precision), (Round4 $m.recall), $m.hintMisses, $m.gapsOpen, $m.gapsClosed, $m.positiveAlthoughSucceeded)
    if ($m.closed.Count) { Write-Host "  known gaps now passing (remove their status): $($m.closed -join ', ')" }
    foreach ($f in $m.failures) { Write-Host "  FAIL $f" -ForegroundColor Red }
}

function ConvertTo-Baseline($m) {
    return [ordered]@{ labeled = $m.labeled; tp = $m.tp; fp = $m.fp; fn = $m.fn; tn = $m.tn; precision = (Round4 $m.precision); recall = (Round4 $m.recall); gapsOpen = $m.gapsOpen }
}

$mc = Get-Score $commands $decisions 'deny' { param($r) $r.decision } { param($r) $r.reason }
$mf = Get-Score $failures $outcomes 'advice' { param($r) if ($r.advice) { 'advice' } else { 'silent' } } { param($r) $r.advice }
Show-Score 'commands' $mc
Show-Score 'failures' $mf

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
$payloadOut = @{ engine = 'powershell'; commands = $decisions; failures = $outcomes } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($OutFile, $payloadOut + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Decisions written to $OutFile"

$baselineFile = Join-Path $CorpusDir 'baseline.json'
$regressions = @()
if ($UpdateBaseline) {
    $b = [ordered]@{ updated = (Get-Date -Format 'yyyy-MM-dd'); commands = (ConvertTo-Baseline $mc); failures = (ConvertTo-Baseline $mf) }
    [IO.File]::WriteAllText($baselineFile, (($b | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Baseline written to $baselineFile"
} elseif (Test-Path -LiteralPath $baselineFile) {
    $b = Get-Content -Raw -LiteralPath $baselineFile | ConvertFrom-Json
    $tol = 0.0005
    if ((Round4 $mc.precision) + $tol -lt $b.commands.precision) { $regressions += "commands: precision $(Round4 $mc.precision) is below the baseline $($b.commands.precision)" }
    if ((Round4 $mc.recall) + $tol -lt $b.commands.recall) { $regressions += "commands: recall $(Round4 $mc.recall) is below the baseline $($b.commands.recall)" }
    if ((Round4 $mf.precision) + $tol -lt $b.failures.precision) { $regressions += "failures: precision $(Round4 $mf.precision) is below the baseline $($b.failures.precision)" }
    if ((Round4 $mf.recall) + $tol -lt $b.failures.recall) { $regressions += "failures: recall $(Round4 $mf.recall) is below the baseline $($b.failures.recall)" }
} else {
    Write-Host "No baseline.json; run once with -UpdateBaseline (or node --test tests/replay.test.mjs with WINDOWS_GUARD_UPDATE_BASELINE=1)" -ForegroundColor Yellow
}
foreach ($x in $regressions) { Write-Host "REGRESSION $x" -ForegroundColor Red }

try { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue } catch { }
$bad = $mc.failures.Count + $mf.failures.Count + $regressions.Count
if ($bad -gt 0) { Write-Host "`n$bad problem(s)" -ForegroundColor Red; exit 1 }
Write-Host "`nreplay ok"
exit 0
