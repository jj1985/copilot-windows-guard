# windows-guard: preToolUse hook for the shell tool (bash on Unix, powershell on Windows).
# Denies command strings that will corrupt files or cannot run in PowerShell, and hands the
# model the PowerShell idiom in the denial reason so the retry is correct the first time.
#
# Internal errors ALLOW the call (exit 0, no output): preToolUse is otherwise fail-closed and a
# bug here would block every shell command. Rules marked bypassable can be skipped by putting
# the comment  # wg:allow  anywhere in the command, for the rare intentional case.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$CheatSheet = 'PowerShell quoting: single quotes are literal (double a single quote to embed it: ''it''''s''); inside double quotes $x expands and a literal double quote is written as two double quotes or backtick-quote; backslash is NOT an escape character. Multi-line or heavily quoted content: create a .ps1 (or a data file) with the create tool and run pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1. File content always goes through the edit/create tool, never through the shell.'

function Deny([string]$Why) {
    @{ permissionDecision = 'deny'; permissionDecisionReason = $Why } | ConvertTo-Json -Compress
    exit 0
}

try {
    $hook = Read-HookPayload
    if ($null -eq $hook) { exit 0 }
    $ta = Get-ToolArgs $hook
    if (Test-GuardDebug) { Write-GuardLog ("RAW " + ($hook | ConvertTo-Json -Compress -Depth 6)) }
    $cmd = ''
    if ($null -ne $ta -and $ta.PSObject -and $ta.PSObject.Properties['command']) { $cmd = [string]$ta.command }
    if (-not $cmd) { exit 0 }
    $bypass = ($cmd -match '#\s*wg:allow')

    # 1. Idioms that fail or corrupt files, most specific first. Cheap rules run before the parser so
    #    that both engines deny with the same, more specific reason (the extension runs the parser
    #    last because it costs a process there).
    $rules = @(
        @{ re = '<<-?\s*[''"]?[A-Za-z_]\w*'; bypass = $false
           why = 'Bash heredocs do not exist in PowerShell. Put file content through the edit/create tool, or create a .ps1 with the create tool and run: pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1' }
        @{ re = '2>\s*/dev/null'; bypass = $false
           why = 'Use 2>$null to discard errors; PowerShell treats /dev/null as a file path.' }
        @{ re = '(?i)^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^=\s]\S*\s+[A-Za-z$.&]'; bypass = $false
           why = 'Bash-style environment assignment (VAR=value cmd, export VAR=value) does not work in PowerShell. Use: $env:VAR = ''value''; <command>' }
        @{ re = '(?i)^\s*echo\s+-[en]\b'; bypass = $true
           why = 'echo is Write-Output in PowerShell and has no -e/-n flags. Use Write-Output ''text'' or Write-Host -NoNewline.' }
        @{ re = '(?i)^\s*(dir|del|erase|rd|rmdir|md|copy|move|type|ren)\s+(\S+\s+)?/[a-z]'; bypass = $false
           why = 'cmd.exe switches (/s, /q, /f) do not work in PowerShell. Use Get-ChildItem -Recurse, Remove-Item -Recurse -Force, Copy-Item, Move-Item, Get-Content, Rename-Item.' }
        @{ re = '(?i)\b(python3?|py|node)\s+-[ce]\s+.*(open\s*\(|\.write|writeFileSync|writeFile|write_text|write_bytes)'; bypass = $true
           why = 'Do not write files through an inline python -c / node -e one-liner: quoting fails and the file gets CRLF or the wrong encoding. Use the edit/create tool for the content, or create a script file with the create tool and run it.' }
        @{ re = '\b(Set-Content|Add-Content|Out-File|Tee-Object)\b(?![^|;]*-Encoding\s+(utf8NoBOM|utf8|ascii)\b)'; bypass = $true
           why = 'Shell writes must pass -Encoding utf8NoBOM (and they still write CRLF). File content belongs in the edit/create tool; to capture command output use: <command> | Out-File -Encoding utf8NoBOM -FilePath <path>' }
        @{ re = '(?<![-<])(?:\b[1-6*])?>{1,2}\s*(?!\$null\b)(?!&\d)[^\s|;&>]+'; bypass = $true
           why = 'Redirecting to a file writes CRLF (and UTF-16LE under Windows PowerShell 5.1). Use the edit/create tool for file content, or <command> | Out-File -Encoding utf8NoBOM -FilePath <path> to capture output. Add  # wg:allow  if this redirect is intentional.' }
        @{ re = '(?i)\$home\s*='; bypass = $false
           why = '$home is PowerShell''s HOME variable; assigning it can point destructive commands at the real profile. Use another variable name.' }
    )
    foreach ($r in $rules) {
        if ($cmd -match $r.re) {
            if ($r.bypass -and $bypass) { continue }
            Deny $r.why
        }
    }

    # 2. Unix commands in command position, unless the executable is actually installed.
    $unixMap = @{
        sed = 'the edit tool (for in-place edits) or -replace'; awk = 'ForEach-Object / -split'; grep = 'Select-String'
        head = 'Select-Object -First N'; tail = 'Get-Content -Tail N'; touch = 'New-Item -ItemType File'
        which = 'Get-Command'; export = '$env:NAME = ''value'''; chmod = 'icacls (usually unnecessary on Windows)'
        ln = 'New-Item -ItemType SymbolicLink'; wc = 'Measure-Object -Line/-Word/-Character'
        xargs = 'ForEach-Object'; find = 'Get-ChildItem -Recurse -Filter'; cut = '-split / Select-Object'
        tr = '-replace'; uniq = 'Sort-Object -Unique'
    }
    foreach ($m in [regex]::Matches($cmd, '(?m)(?:^|[|;&(]\s*)(sed|awk|grep|head|tail|touch|which|export|chmod|ln|wc|xargs|find|cut|tr|uniq)(?=\s|$)')) {
        $name = $m.Groups[1].Value
        $app = $null
        try { $app = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
        # Windows ships its own find.exe in System32; it is not GNU find.
        if ($app -and -not ($name -eq 'find' -and $app.Source -match '\\System32\\')) { continue }
        if ($bypass) { continue }
        Deny "'$name' is a Unix command and is not installed in this PowerShell session. Use $($unixMap[$name]). For in-place file edits use the edit tool, not sed. Add  # wg:allow  if you have confirmed the tool exists."
    }

    # 3. Bash-style escaped quotes outside single-quoted literals.
    if ($cmd -match '\\"' -and $cmd -notmatch "'" -and -not $bypass) {
        Deny ('\" is not an escape sequence in PowerShell. ' + $CheatSheet + ' For JSON or other quote-heavy arguments to native tools, write the payload to a file with the create tool and pass the file name (for example --body-file or --input).')
    }

    # 4. Let PowerShell's own parser judge whatever passed the rules above. Unterminated strings,
    #    bash-only syntax (`for f in`, `[ -f x ]`), stray \" escapes and mismatched braces all surface
    #    here with the exact error, before the agent spends a round trip discovering it.
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $msgs = @($errors | Select-Object -First 3 | ForEach-Object { $_.Message.Trim() }) -join ' | '
        Deny "PowerShell cannot parse this command: $msgs. $CheatSheet"
    }
} catch {
    Write-GuardLog "ERROR shell-guard: $($_.Exception.Message)"
}
exit 0
