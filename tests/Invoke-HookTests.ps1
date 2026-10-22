# Runs every windows-guard hook script against synthetic Copilot CLI hook payloads and checks
# the outcome. Works under PowerShell 7 and Windows PowerShell 5.1:
#   pwsh -NoProfile -File tests/Invoke-HookTests.ps1
#   pwsh -NoProfile -File tests/Invoke-HookTests.ps1 -Shell powershell     # run the hooks under 5.1
param([string]$Shell = '')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$Root = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $Root 'plugins\windows-guard'
$Scripts = Join-Path $PluginDir 'scripts'
if (-not $Shell) { $Shell = (Get-Process -Id $PID).Path } else { $Shell = (Get-Command $Shell).Source }
# Work under %TEMP%, not under the repo: a long checkout path plus a nested .git can exceed the
# Windows 260-character limit and make git fail with "Filename too long".
$Work = Join-Path ([IO.Path]::GetTempPath()) ('wg-tests\' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$MinPath = "$env:SystemRoot\System32;$env:SystemRoot;$(Split-Path -Parent $Shell)"
$HaveGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
$script:Pass = 0
$script:Fail = 0

# Isolate every git call (ours and the hooks') from this machine's global and system config,
# so a global core.autocrlf=true cannot change the outcome.
$env:GIT_CONFIG_GLOBAL = Join-Path $Work 'gitconfig'
$env:GIT_CONFIG_NOSYSTEM = '1'
[IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL, "[user]`n`temail = t@example.com`n`tname = tests`n[core]`n`tautocrlf = false`n`tlongpaths = true`n")

Write-Host "Hook host: $Shell"
Write-Host ("Hook host version: " + (& $Shell -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'))

function Invoke-Hook([string]$Script, $Payload, [hashtable]$EnvVars = @{}) {
    $json = $Payload | ConvertTo-Json -Compress -Depth 6
    $saved = @{}
    foreach ($k in $EnvVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $EnvVars[$k]) }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $out = $json | & $Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Scripts $Script) 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    return @{ Out = (@($out | ForEach-Object { "$_" }) -join "`n"); Code = $code }
}

function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { $script:Pass++; Write-Host "PASS  $Name" }
    else { $script:Fail++; Write-Host "FAIL  $Name`n      $Detail" -ForegroundColor Red }
}

function Get-EolInfo([string]$Path) {
    $b = [IO.File]::ReadAllBytes($Path); $s = [Text.Encoding]::UTF8.GetString($b)
    return @{ Bytes = $b.Length
              BOM = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
              CRLF = ([regex]::Matches($s, "`r`n")).Count
              LF = ([regex]::Matches($s, "(?<!`r)`n")).Count }
}

function New-Dir([string]$Name) { $d = Join-Path $Work $Name; New-Item -ItemType Directory -Force -Path $d | Out-Null; return $d }

function New-GitRepo([string]$Name) {
    $d = New-Dir $Name
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $o = & git -C $d init -q 2>&1
        if ($LASTEXITCODE) { Write-Host "      git init failed in $d : $o" -ForegroundColor Yellow }
        $o = & git -C $d config core.autocrlf false 2>&1
        if ($LASTEXITCODE) { Write-Host "      git config failed in $d : $o" -ForegroundColor Yellow }
    } finally { $ErrorActionPreference = $old }
    return $d
}

function EditPayload([string]$Dir, $ToolArgs, [string]$Tool = 'edit', [bool]$AsString = $true) {
    $ta = $ToolArgs
    if ($AsString) { $ta = ($ToolArgs | ConvertTo-Json -Compress) }
    return @{ sessionId = 's'; timestamp = 1; cwd = $Dir; toolName = $Tool; toolArgs = $ta; toolResult = @{ resultType = 'success'; textResultForLlm = 'ok' } }
}

# ---------------------------------------------------------------- normalize-eol
Write-Host "`n--- normalize-eol.ps1"
$enc = New-Object System.Text.UTF8Encoding($false)

$d = New-Dir 'plain'
[IO.File]::WriteAllBytes((Join-Path $d 'a.txt'), ([byte[]](0xEF, 0xBB, 0xBF) + $enc.GetBytes("one`r`ntwo`r`nthree`r`n")))
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ path = 'a.txt'; old_str = 'x'; new_str = 'y' })
$i = Get-EolInfo (Join-Path $d 'a.txt')
Assert ($r.Code -eq 0 -and -not $i.BOM -and $i.CRLF -eq 0 -and $i.LF -eq 3 -and $i.Bytes -eq 14) 'BOM+CRLF file -> LF, no BOM (toolArgs as JSON string, relative path)' "code=$($r.Code) $($i | ConvertTo-Json -Compress) out=$($r.Out)"

[IO.File]::WriteAllBytes((Join-Path $d 'b.txt'), $enc.GetBytes("one`r`ntwo"))
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ file_path = (Join-Path $d 'b.txt') } 'create' $false)
$i = Get-EolInfo (Join-Path $d 'b.txt')
Assert ($i.CRLF -eq 0 -and $i.LF -eq 1 -and $i.Bytes -eq 7) 'CRLF without trailing newline -> LF, still no trailing newline (toolArgs object, absolute file_path)' ($i | ConvertTo-Json -Compress)

[IO.File]::WriteAllBytes((Join-Path $d 'run.bat'), $enc.GetBytes("@echo off`necho hi`n"))
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ path = 'run.bat' })
$i = Get-EolInfo (Join-Path $d 'run.bat')
Assert ($i.CRLF -eq 2 -and $i.LF -eq 0) '.bat file -> CRLF by extension list' ($i | ConvertTo-Json -Compress)

[IO.File]::WriteAllBytes((Join-Path $d 'img.bin'), [byte[]](0x89, 0x50, 0x0D, 0x0A, 0x00, 0x0D, 0x0A))
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ path = 'img.bin' })
Assert ((Get-Item (Join-Path $d 'img.bin')).Length -eq 7) 'binary file (NUL byte) untouched'

[IO.File]::WriteAllBytes((Join-Path $d 'p.txt'), $enc.GetBytes("a`r`nb`r`n"))
$patch = "*** Begin Patch`n*** Update File: p.txt`n@@`n-a`n+b`n*** End Patch"
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ patch = $patch } 'apply_patch')
$i = Get-EolInfo (Join-Path $d 'p.txt')
Assert ($i.CRLF -eq 0 -and $i.LF -eq 2) 'apply_patch: file path parsed from patch text' ($i | ConvertTo-Json -Compress)

$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ something = 'else' })
Assert ($r.Code -eq 0 -and -not $r.Out) 'unknown toolArgs shape -> exit 0, no output'

[IO.File]::WriteAllBytes((Join-Path $d 'c.txt'), $enc.GetBytes("x`r`ny`r`n"))
$r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $d @{ path = 'c.txt' }) @{ WINDOWS_GUARD_DEFAULT_EOL = 'crlf' }
$i = Get-EolInfo (Join-Path $d 'c.txt')
Assert ($i.CRLF -eq 2 -and $i.LF -eq 0) 'WINDOWS_GUARD_DEFAULT_EOL=crlf keeps CRLF' ($i | ConvertTo-Json -Compress)

if ($HaveGit) {
    $g = New-GitRepo 'attr'
    [IO.File]::WriteAllText((Join-Path $g '.gitattributes'), "*.txt text eol=crlf`n*.lf text eol=lf`n*.bin -text`n", $enc)
    [IO.File]::WriteAllBytes((Join-Path $g 'x.txt'), $enc.GetBytes("a`nb`n"))
    $r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $g @{ path = 'x.txt' })
    $i = Get-EolInfo (Join-Path $g 'x.txt')
    Assert ($i.CRLF -eq 2 -and $i.LF -eq 0) '.gitattributes eol=crlf wins for an untracked file' ($i | ConvertTo-Json -Compress)

    [IO.File]::WriteAllBytes((Join-Path $g 'y.lf'), ([byte[]](0xEF, 0xBB, 0xBF) + $enc.GetBytes("a`r`nb`r`n")))
    $r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $g @{ path = 'y.lf' })
    $i = Get-EolInfo (Join-Path $g 'y.lf')
    Assert ($i.CRLF -eq 0 -and $i.LF -eq 2 -and -not $i.BOM) '.gitattributes eol=lf -> LF and BOM removed' ($i | ConvertTo-Json -Compress)

    [IO.File]::WriteAllBytes((Join-Path $g 'z.bin'), $enc.GetBytes("a`r`nb`r`n"))
    $r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $g @{ path = 'z.bin' })
    $i = Get-EolInfo (Join-Path $g 'z.bin')
    Assert ($i.CRLF -eq 2) '.gitattributes -text -> file left alone' ($i | ConvertTo-Json -Compress)

    $g2 = New-GitRepo 'index'
    [IO.File]::WriteAllBytes((Join-Path $g2 't.cs'), $enc.GetBytes("a`r`nb`r`n"))
    & git -C $g2 add t.cs 2>&1 | Out-Null; & git -C $g2 commit -q -m init 2>&1 | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $g2 't.cs'), $enc.GetBytes("a`nb-edited`n"))
    $r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $g2 @{ path = 't.cs' })
    $i = Get-EolInfo (Join-Path $g2 't.cs')
    Assert ($i.CRLF -eq 2 -and $i.LF -eq 0) 'tracked CRLF file (index i/crlf) edited to LF -> restored to CRLF' ($i | ConvertTo-Json -Compress)

    $g3 = New-GitRepo 'autocrlf'
    & git -C $g3 config core.autocrlf true
    [IO.File]::WriteAllBytes((Join-Path $g3 'n.txt'), $enc.GetBytes("a`nb`n"))
    $r = Invoke-Hook 'normalize-eol.ps1' (EditPayload $g3 @{ path = 'n.txt' })
    $i = Get-EolInfo (Join-Path $g3 'n.txt')
    Assert ($i.CRLF -eq 2 -and $i.LF -eq 0) 'core.autocrlf=true -> working tree CRLF' ($i | ConvertTo-Json -Compress)
} else { Write-Host 'SKIP  git not found; .gitattributes / index / autocrlf tests skipped' }

# ---------------------------------------------------------------- shell-guard
Write-Host "`n--- shell-guard.ps1"
function Get-Decision([string]$Out) {
    # Hook stdout is JSON; 5.1 escapes characters such as > as >, so decode before inspecting.
    try { $o = $Out | ConvertFrom-Json; return @{ Deny = ($o.permissionDecision -eq 'deny'); Reason = [string]$o.permissionDecisionReason } }
    catch { return @{ Deny = $false; Reason = $Out } }
}

function Test-Guard([string]$Cmd, [bool]$ExpectDeny, [string]$Hint = '') {
    $payload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = 'powershell'; toolArgs = (@{ command = $Cmd } | ConvertTo-Json -Compress) }
    $r = Invoke-Hook 'shell-guard.ps1' $payload @{ PATH = $MinPath }
    $dec = Get-Decision $r.Out
    $denied = $dec.Deny
    $hintOk = (-not $Hint) -or ($dec.Reason.IndexOf($Hint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $label = 'allow'; if ($ExpectDeny) { $label = 'deny ' }
    $shown = $Cmd -replace "`r?`n", ' \n '
    Assert (($denied -eq $ExpectDeny) -and ($r.Code -eq 0) -and $hintOk) "guard $label : $shown" "code=$($r.Code) denied=$denied out=$($r.Out)"
}
Test-Guard "cat <<EOF > x.txt`nhello`nEOF" $true
Test-Guard 'head -5 file.txt' $true 'Select-Object'
Test-Guard 'dotnet build 2>&1 | grep error | head -20' $true 'Select-String'
Test-Guard 'ls 2>/dev/null' $true '2>$null'
Test-Guard 'echo "hello" > out.txt' $true 'edit/create tool'
Test-Guard 'echo "hello" > out.txt # wg:allow' $false
Test-Guard '"text" | Set-Content out.txt' $true 'utf8NoBOM'
Test-Guard 'Get-Content x.txt | Out-File -Encoding utf8NoBOM -FilePath y.txt' $false
Test-Guard '$home = ''C:\x''; Remove-Item -Recurse -Force $home' $true 'HOME'
Test-Guard 'echo "unterminated' $true 'cannot parse'
Test-Guard 'echo "{\"a\":1}"' $true
Test-Guard 'FOO=bar npm run build' $true '$env:'
Test-Guard 'export FOO=bar' $true '$env:'
Test-Guard 'dir /s *.cs' $true 'Get-ChildItem'
Test-Guard 'python -c "open(''x'',''w'').write(''hi'')"' $true 'create tool'
Test-Guard 'find . -name "*.cs"' $true 'Get-ChildItem'
Test-Guard 'for f in *.txt; do echo $f; done' $true 'cannot parse'
Test-Guard 'echo -e "a\nb"' $true 'Write-Output'
Test-Guard 'Get-Content x.txt | Select-Object -First 5' $false
Test-Guard 'dotnet build 2>$null' $false
Test-Guard 'dotnet build 2>&1 | Select-String error' $false
Test-Guard 'npm run build -- --flag' $false
Test-Guard 'git commit -m ''it''''s done''' $false
Test-Guard 'gh pr create --body-file body.md' $false
Test-Guard 'if ($x -gt 5) { ''big'' }' $false
Test-Guard 'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1000 }' $false
Test-Guard 'curl.exe -s https://example.com' $false
Test-Guard 'for ($i = 0; $i -lt 3; $i++) { $i }' $false
Test-Guard '$x = 5; Write-Output "x is $x"' $false
Test-Guard 'node -e "console.log(1)"' $false
Test-Guard 'npm run build -- ''{\"a\":1}''' $false
Test-Guard '[IO.File]::WriteAllText(''x.txt'', ''hi'', [Text.UTF8Encoding]::new($false))' $false
Test-Guard 'Get-Content x | Select-String -Pattern "a>b"' $true
Test-Guard 'Get-Content x | Select-String -Pattern "a>b" # wg:allow' $false

# ---------------------------------------------------------------- utf8-gate
Write-Host "`n--- utf8-gate.ps1"
$u = New-Dir 'enc'
[IO.File]::WriteAllBytes((Join-Path $u 'cp1252.txt'), $enc.GetBytes('copyright ') + [byte[]](0xA9) + $enc.GetBytes(" 2026`n"))
[IO.File]::WriteAllBytes((Join-Path $u 'utf16.txt'), [Text.Encoding]::Unicode.GetPreamble() + [Text.Encoding]::Unicode.GetBytes("hi`n"))
[IO.File]::WriteAllBytes((Join-Path $u 'utf8.txt'), $enc.GetBytes("caf" + [char]0xE9 + "`n"))
[IO.File]::WriteAllBytes((Join-Path $u 'ascii.txt'), $enc.GetBytes("plain`n"))
function Test-Gate([string]$File, [bool]$ExpectDeny, [string]$Hint = '') {
    $r = Invoke-Hook 'utf8-gate.ps1' (@{ sessionId = 's'; timestamp = 1; cwd = $u; toolName = 'edit'; toolArgs = (@{ path = $File; old_str = 'a'; new_str = 'b' } | ConvertTo-Json -Compress) })
    $dec = Get-Decision $r.Out
    $denied = $dec.Deny
    $hintOk = (-not $Hint) -or ($dec.Reason.IndexOf($Hint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $label = 'allow'; if ($ExpectDeny) { $label = 'deny ' }
    Assert (($denied -eq $ExpectDeny) -and ($r.Code -eq 0) -and $hintOk) "gate $label : $File" "code=$($r.Code) out=$($r.Out)"
}
Test-Gate 'cp1252.txt' $true 'Windows-1252'
Test-Gate 'utf16.txt' $true 'UTF-16'
Test-Gate 'utf8.txt' $false
Test-Gate 'ascii.txt' $false
Test-Gate 'does-not-exist.txt' $false

# ---------------------------------------------------------------- recovery-coach
Write-Host "`n--- recovery-coach.ps1"
function Test-Coach([string]$Tool, $ToolArgs, [string]$Err, [bool]$ExpectAdvice, [string]$Hint = '') {
    $r = Invoke-Hook 'recovery-coach.ps1' (@{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = $Tool; toolArgs = ($ToolArgs | ConvertTo-Json -Compress); error = $Err })
    $hintOk = (-not $Hint) -or ($r.Out.IndexOf($Hint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($ExpectAdvice) { $ok = ($r.Code -eq 2) -and $r.Out -and $hintOk } else { $ok = ($r.Code -eq 0) -and (-not $r.Out) }
    Assert $ok "coach $Tool : $Err" "code=$($r.Code) out=$($r.Out)"
}
Test-Coach 'powershell' @{ command = 'head -5 x' } "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program." $true 'Select-Object'
Test-Coach 'powershell' @{ command = 'echo "a' } "The string is missing the terminator: `"." $true 'quoting'
Test-Coach 'powershell' @{ command = 'a && b' } "The token '&&' is not a valid statement separator in this version." $true 'PowerShell 5.1'
Test-Coach 'powershell' @{ command = 'npm run x' } "npm ERR! missing script: x" $false
Test-Coach 'edit' @{ path = 'a.txt'; old_str = 'x'; new_str = 'y' } "No match found for old_str in a.txt" $true 'view'
Test-Coach 'edit' @{ path = 'a.txt' } "Something unrelated happened" $false
Test-Coach 'view' @{ path = 'a.txt' } "File not found" $false
Test-Coach 'powershell' @{ command = 'echo "a' } "Denied by preToolUse hook: PowerShell cannot parse this command: The string is missing the terminator. PowerShell quoting: ..." $false

# postToolUse mode: the CLI reports a failed shell command as a successful tool call with the exit
# code in the text, so the coach must read toolResult and answer with additionalContext JSON.
function Test-CoachResult([string]$Tool, $ToolArgs, [string]$ResultText, [bool]$ExpectAdvice, [string]$Hint = '') {
    $r = Invoke-Hook 'recovery-coach.ps1' (@{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = $Tool; toolArgs = $ToolArgs; toolResult = @{ resultType = 'success'; textResultForLlm = $ResultText } })
    $ctx = ''
    try { $ctx = [string](($r.Out | ConvertFrom-Json).additionalContext) } catch { }
    $hintOk = (-not $Hint) -or ($ctx.IndexOf($Hint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($ExpectAdvice) { $ok = ($r.Code -eq 0) -and $ctx -and $hintOk } else { $ok = ($r.Code -eq 0) -and (-not $r.Out) }
    $shown = $ResultText -replace "`r?`n", ' \n '
    Assert $ok "coach(result) $Tool : $shown" "code=$($r.Code) out=$($r.Out)"
}
Test-CoachResult 'powershell' @{ command = 'head -3 x.txt' } "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program.`n<shellId: 0 completed with exit code 1>" $true 'Select-Object'
Test-CoachResult 'powershell' @{ command = 'Get-Content x.txt' } "alpha`nbeta`n<shellId: 0 completed with exit code 0>" $false
Test-CoachResult 'powershell' @{ command = 'echo "a' } "ParserError: `nLine |`n   1 |  echo `"a`n     | The string is missing the terminator: `".`n<shellId: 0 completed with exit code 1>" $true 'quoting'
Test-CoachResult 'powershell' @{ command = 'Get-Item .\does-not-exist.txt' } "Get-Item: Cannot find path 'C:\x\does-not-exist.txt' because it does not exist.`n<shellId: 0 completed with exit code 1>" $false
Test-CoachResult 'edit' @{ path = 'a.txt' } "No match found" $false

# ---------------------------------------------------------------- inject-rules
Write-Host "`n--- inject-rules.ps1"
$r = Invoke-Hook 'inject-rules.ps1' (@{ sessionId = 's'; timestamp = 1; cwd = $Work; source = 'startup' })
$ctx = ''
try { $ctx = [string](($r.Out | ConvertFrom-Json).additionalContext) } catch { }
Assert (($r.Code -eq 0) -and ($ctx -like '*Windows environment rules*') -and ($ctx -like '*edit and create tools*')) 'sessionStart injects the rules file as additionalContext' "code=$($r.Code) out=$($r.Out.Substring(0, [Math]::Min(200, $r.Out.Length)))"

# ---------------------------------------------------------------- hooks.json launcher end-to-end
Write-Host "`n--- hooks.json inline launcher"
$hooks = Get-Content -Raw (Join-Path $PluginDir 'com.github.copilot\hooks\hooks.json') | ConvertFrom-Json
$launcher = $hooks.hooks.preToolUse[0].powershell
$payload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = 'powershell'; toolArgs = (@{ command = 'head -3 x' } | ConvertTo-Json -Compress) } | ConvertTo-Json -Compress
$savedRoot = $env:PLUGIN_ROOT; $savedPath = $env:PATH
try {
    $env:PLUGIN_ROOT = $PluginDir; $env:PATH = $MinPath
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $out = ($payload | & $Shell -NoProfile -NonInteractive -Command $launcher 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
    Assert (($out -match '"deny"') -and ($out -match 'Select-Object') -and $code -eq 0) 'launcher runs shell-guard via PLUGIN_ROOT and relays the deny' "code=$code out=$out"
    $env:PLUGIN_ROOT = $null
    $out = ($payload | & $Shell -NoProfile -NonInteractive -Command $launcher 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
    Assert ((-not $out) -and $code -eq 0) 'launcher without PLUGIN_ROOT exits 0 silently (fail-open)' "code=$code out=$out"
    $env:PLUGIN_ROOT = $PluginDir
    $coach = $hooks.hooks.postToolUseFailure[0].powershell
    $failPayload = @{ sessionId = 's'; timestamp = 1; cwd = $Work; toolName = 'edit'; toolArgs = '{"path":"a.txt"}'; error = 'No match found' } | ConvertTo-Json -Compress
    $out = ($failPayload | & $Shell -NoProfile -NonInteractive -Command $coach 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
    Assert (($out -match 'view') -and $code -eq 2) 'launcher relays recovery-coach exit code 2 and text' "code=$code out=$out"
} finally { $env:PLUGIN_ROOT = $savedRoot; $env:PATH = $savedPath }

# ---------------------------------------------------------------- summary
Write-Host "`n$($script:Pass) passed, $($script:Fail) failed"
try { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue } catch { }
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
