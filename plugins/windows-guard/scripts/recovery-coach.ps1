# windows-guard: recovery coach. Registered twice in hooks.json:
#   - postToolUse on the shell tool: Copilot CLI reports a shell command that exited non-zero as a
#     SUCCESSFUL tool call whose text ends in "<shellId: N completed with exit code M>", so this is
#     where ordinary command errors are visible. Output: {"additionalContext": "..."} with exit 0,
#     which the CLI appends to the tool output the model sees on the same turn.
#   - postToolUseFailure on all tools: edit-tool failures and other tool-level errors arrive here
#     with an `error` field. Output: plain text with exit 2, which the CLI appends to the failure.
# Recognizes quoting errors, bash-isms, 5.1 syntax, "No match found" and a few environment errors,
# and always tells the model NOT to fall back to rewriting whole files. Unrecognized -> exit 0, silent.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$Quoting = @'
PowerShell quoting rules:
- Single quotes are literal: 'C:\Program Files\x'. Embed a single quote by doubling it: 'it''s'.
- Double quotes expand $var and $(expr). A literal double quote inside them is written as two double quotes or as backtick-quote. Backslash is NOT an escape character.
- Paths with spaces: quote them, or use & 'C:\path with spaces\tool.exe' arg. Use -LiteralPath for paths containing [ or ].
- npm, npx, yarn, pnpm and gradlew are .cmd shims with legacy argument passing: arguments containing double quotes get mangled. Pass JSON through a file, run cmd /c "..." with the whole command line, or use the stop-parsing token --%.
- Chain with ; (&& and || need PowerShell 7). Discard errors with 2>$null, not 2>/dev/null.
- Anything multi-line or quote-heavy: create a .ps1 with the create tool, then run pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1.
Do NOT work around a failed command by writing or rewriting files with Set-Content, >, python -c or node -e. File content goes through the edit/create tool.
'@

$EditRecovery = @'
Edit recovery steps (do these instead of rewriting the file):
1. Re-read the exact region with the view tool using a narrow line range. The file may differ from what you remember, including after your own previous edit.
2. Copy old_str verbatim from that output, including indentation and trailing spaces. Keep it short: 2-4 lines that are unique in the file.
3. Check for lookalike characters: curly quotes (U+201C, U+201D, U+2018, U+2019) vs straight quotes, non-breaking spaces (U+00A0), tabs vs spaces, em dashes. The edit tool reports "No match found" when old_str spans curly quotes; choose a nearby span without them.
4. If old_str matches more than once, add one more surrounding line until it is unique.
5. Never replace the whole file with the create tool to work around a mismatch: that converts every line ending and destroys unrelated content.
'@

$ShellFailurePattern = 'completed with exit code [1-9]|is not recognized|ParserError|missing the terminator|Unexpected token|Missing closing|Access to the path|being used by another process|running scripts is disabled|not a valid statement separator'

try {
    $hook = Read-HookPayload
    if ($null -eq $hook) { exit 0 }
    $tool = Get-ToolName $hook
    $ta = Get-ToolArgs $hook
    if (Test-GuardDebug) { Write-GuardLog ("RAW " + ($hook | ConvertTo-Json -Compress -Depth 6)) }

    # Which event are we in? postToolUseFailure carries `error`; postToolUse carries `toolResult`.
    $mode = 'failure'
    $err = ''
    if ($hook.PSObject.Properties['error'] -and $hook.error) {
        $err = [string]$hook.error
    } elseif ($hook.PSObject.Properties['toolResult'] -and $hook.toolResult) {
        $mode = 'result'
        $err = [string]$hook.toolResult.textResultForLlm
        if (-not $err) { $err = [string]$hook.toolResult.text_result_for_llm }
        if ($tool -ne 'bash' -and $tool -ne 'powershell') { exit 0 }
        if ($err -notmatch $ShellFailurePattern) { exit 0 }
    } else { exit 0 }
    if ($err -match '^Denied by preToolUse hook') { exit 0 }    # the denial reason already carries the guidance

    $cmd = ''
    if ($null -ne $ta -and $ta.PSObject -and $ta.PSObject.Properties['command']) { $cmd = [string]$ta.command }
    $out = @()

    if ($tool -eq 'bash' -or $tool -eq 'powershell') {
        $unixMap = @{
            sed = 'the edit tool for in-place edits, or -replace'; awk = 'ForEach-Object / -split'; grep = 'Select-String'
            head = 'Select-Object -First N'; tail = 'Get-Content -Tail N'; touch = 'New-Item -ItemType File'
            which = 'Get-Command'; export = '$env:NAME = ''value'''; chmod = 'icacls (usually unnecessary)'
            ln = 'New-Item -ItemType SymbolicLink'; wc = 'Measure-Object'; xargs = 'ForEach-Object'; find = 'Get-ChildItem -Recurse'
            cut = '-split'; tr = '-replace'; uniq = 'Sort-Object -Unique'
        }
        if ($err -match "The term '([^']+)' is not recognized") {
            $term = $Matches[1]
            if ($unixMap.ContainsKey($term)) {
                $out += "'$term' is a Unix command; this shell is PowerShell on Windows. Use $($unixMap[$term])."
            } else {
                $out += "'$term' is not on PATH for the agent's shell (a fresh pwsh -NoProfile per command; your interactive profile does not apply). Check with Get-Command $term, or call the executable by full path."
            }
        }
        if ($err -match 'not a valid statement separator|The token .&&.|The token .\|\|.') {
            $out += "The agent's shell is Windows PowerShell 5.1, where && and || are parse errors. Chain with ; instead. Installing PowerShell 7 (winget install Microsoft.PowerShell) and restarting the CLI removes this class of error."
        }
        if ($err -match 'missing the terminator|Missing closing|Unexpected token|Unrecognized token|Missing expression|Missing argument|reserved for future use|Unexpected character|ParserError') {
            $out += 'This is a PowerShell parse error, almost always quoting.'
            $out += $Quoting
        }
        if ($err -match '/dev/null|Cannot find path .*/') {
            $out += 'Forward-slash arguments such as /dev/null or /s are treated as paths. Use 2>$null, and PowerShell cmdlet parameters (-Recurse, -Force) instead of cmd.exe switches.'
        }
        if ($err -match 'running scripts is disabled|UnauthorizedAccess.*\.ps1') {
            $out += 'Execution policy blocked the script. Run it as: pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1'
        }
        if ($err -match 'being used by another process') {
            $out += 'The file is locked by another process (often an editor or a build). Do not retry with a different write method; wait or ask the user.'
        }
        if ($out.Count -eq 0 -and $err -match 'unterminated|quote|unexpected.*string|syntax error') {
            $out += $Quoting
        }
    }
    elseif ($tool -in @('edit', 'str_replace_editor', 'apply_patch', 'create')) {
        if ($err -match 'No match|not found|did not match|could not find|does not exist in|Could not apply|failed to apply|does not appear|not unique|multiple|more than one|ambiguous|modified since|changed since') {
            $out += $EditRecovery
        }
    }

    if ($out.Count -gt 0) {
        $text = ($out -join "`n`n")
        if ($mode -eq 'result') {
            @{ additionalContext = $text } | ConvertTo-Json -Compress
            exit 0
        }
        [Console]::Out.Write($text)
        exit 2
    }
} catch {
    Write-GuardLog "ERROR recovery-coach: $($_.Exception.Message)"
}
exit 0
