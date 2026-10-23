# windows-guard: preToolUse hook for the shell tool (bash on Unix, powershell on Windows).
# Denies command strings that will corrupt files or cannot run in PowerShell, and hands the
# model the PowerShell idiom in the denial reason so the retry is correct the first time.
#
# The rules live in analyze-command.ps1, shared with the extension engine, and run on PowerShell's
# own AST; this script only reads the hook payload and relays the decision.
# Internal errors ALLOW the call (exit 0, no output): preToolUse is otherwise fail-closed and a
# bug here would block every shell command. Rules marked bypassable can be skipped by putting
# the comment  # wg:allow  anywhere in the command, for the rare intentional case.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot 'analyze-command.ps1')

try {
    $hook = Read-HookPayload
    if ($null -eq $hook) { exit 0 }
    $ta = Get-ToolArgs $hook
    if (Test-GuardDebug) { Write-GuardLog ("RAW " + ($hook | ConvertTo-Json -Compress -Depth 6)) }
    $cmd = ''
    if ($null -ne $ta -and $ta.PSObject -and $ta.PSObject.Properties['command']) { $cmd = [string]$ta.command }
    if (-not $cmd) { exit 0 }

    $d = Get-ShellGuardDecision $cmd
    if ($d.decision -eq 'deny') {
        $shown = $cmd -replace '\r?\n', ' \n '
        if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) }
        Write-GuardLog "DENIED ($($d.rule)) $shown"
        @{ permissionDecision = 'deny'; permissionDecisionReason = $d.reason } | ConvertTo-Json -Compress
    }
} catch {
    Write-GuardLog "ERROR shell-guard: $($_.Exception.Message)"
}
exit 0
