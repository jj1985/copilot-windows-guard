# windows-guard: preToolUse hook for edit/str_replace_editor/apply_patch.
# The edit tool re-encodes non-UTF-8 files to UTF-8 and replaces unmappable bytes with U+FFFD
# before the model ever sees a diff (github/copilot-cli#3604, #3732). That damage is
# irreversible, so the only protection is to refuse the edit and explain why.
# Internal errors ALLOW the call (exit 0, no output) because preToolUse is fail-closed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    $hook = Read-HookPayload
    if ($null -eq $hook) { exit 0 }
    $ta = Get-ToolArgs $hook
    if (Test-GuardDebug) { Write-GuardLog ("RAW " + ($hook | ConvertTo-Json -Compress -Depth 6)) }
    $files = @(Get-TargetPaths $hook $ta)
    foreach ($full in $files) {
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $b = [System.IO.File]::ReadAllBytes($full)
        if ($b.Length -eq 0) { continue }
        $enc = $null
        if ($b.Length -ge 2 -and (($b[0] -eq 0xFF -and $b[1] -eq 0xFE) -or ($b[0] -eq 0xFE -and $b[1] -eq 0xFF))) {
            $enc = 'UTF-16'
        } else {
            if ([Array]::IndexOf($b, [byte]0) -ge 0) { continue }        # binary: not our concern
            try {
                [void](New-Object System.Text.UTF8Encoding($false, $true)).GetString($b)
            } catch {
                $enc = 'a legacy code page such as Windows-1252'
            }
        }
        if ($enc) {
            Write-GuardLog "DENIED edit of non-UTF-8 file $full ($enc)"
            $reason = "$full is encoded as $enc, not UTF-8. The edit tool would re-encode it and silently replace non-ASCII bytes with U+FFFD. Stop and ask the user whether to convert the file to UTF-8 first (for example: " +
                      '$t = [IO.File]::ReadAllText($p, [Text.Encoding]::GetEncoding(1252)); [IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($false))' +
                      "), or make this change by hand."
            @{ permissionDecision = 'deny'; permissionDecisionReason = $reason } | ConvertTo-Json -Compress
            exit 0
        }
    }
} catch {
    Write-GuardLog "ERROR utf8-gate: $($_.Exception.Message)"
}
exit 0
