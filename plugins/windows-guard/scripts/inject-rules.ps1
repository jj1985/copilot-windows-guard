# windows-guard: sessionStart hook.
# Copilot CLI 1.0.101 does not load a plugin's com.github.copilot/rules/*.md as an instruction
# source (`copilot instruction list` shows nothing and the model reports the rules as absent), so
# this hook injects the same rules text as session context, which the hooks reference documents
# for sessionStart. Output: {"additionalContext": "<rules>"} with exit 0. Any error exits 0 silently.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    try { [void](Read-HookPayload) } catch { }                 # consume stdin; payload content is not needed
    $rulesDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'com.github.copilot\rules'
    if (-not (Test-Path -LiteralPath $rulesDir)) { exit 0 }
    $parts = @()
    foreach ($f in (Get-ChildItem -LiteralPath $rulesDir -Filter '*.md' | Sort-Object Name)) {
        $t = [System.IO.File]::ReadAllText($f.FullName)
        if ($t.Trim()) { $parts += $t.Trim() }
    }
    if ($parts.Count -eq 0) { exit 0 }
    $text = ($parts -join "`n`n")
    if (Test-GuardDebug) { Write-GuardLog "INJECTED rules ($($text.Length) chars)" }
    @{ additionalContext = $text } | ConvertTo-Json -Compress
} catch {
    Write-GuardLog "ERROR inject-rules: $($_.Exception.Message)"
}
exit 0
