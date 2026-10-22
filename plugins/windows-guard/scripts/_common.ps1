# Shared helpers for windows-guard hook scripts. Dot-sourced by each script.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+ (no ternary, no ??).

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Read-HookPayload {
    # Read stdin as raw bytes so the host console code page can never mangle the JSON.
    $stdin = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $raw = $raw.Trim()
    if (-not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
}

function Get-ToolArgs($hook) {
    if ($null -eq $hook) { return $null }
    $ta = $hook.toolArgs
    if ($null -eq $ta) { $ta = $hook.tool_input }
    if ($ta -is [string]) {
        try { $ta = $ta | ConvertFrom-Json } catch { }
    }
    return $ta
}

function Get-ToolName($hook) {
    if ($null -eq $hook) { return '' }
    $n = $hook.toolName
    if (-not $n) { $n = $hook.tool_name }
    if (-not $n) { $n = '' }
    return [string]$n
}

function Get-TargetPaths($hook, $ta) {
    # The toolArgs key that carries the file path is not documented; try the likely names,
    # then fall back to parsing apply_patch text. Returns absolute paths.
    $paths = @()
    if ($null -ne $ta -and $ta.PSObject -and $ta.PSObject.Properties) {
        foreach ($k in 'path', 'file_path', 'filePath', 'filename', 'fileName', 'file', 'target_file') {
            $p = $ta.PSObject.Properties[$k]
            if ($p -and ($p.Value -is [string]) -and $p.Value) { $paths += [string]$p.Value; break }
        }
        if ($paths.Count -eq 0) {
            foreach ($k in 'patch', 'input') {
                $p = $ta.PSObject.Properties[$k]
                if ($p -and ($p.Value -is [string])) {
                    foreach ($m in [regex]::Matches($p.Value, '^\*\*\* (?:Update|Add) File: (.+)$', 'Multiline')) {
                        $paths += $m.Groups[1].Value.Trim()
                    }
                }
            }
        }
    }
    $cwd = $null
    if ($null -ne $hook) { $cwd = $hook.cwd }
    if (-not $cwd) { $cwd = (Get-Location).Path }
    $full = @()
    foreach ($p in $paths) {
        if ([System.IO.Path]::IsPathRooted($p)) { $full += $p } else { $full += (Join-Path $cwd $p) }
    }
    return $full
}

function Get-GuardLogDir {
    foreach ($v in 'COPILOT_PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA') {
        $d = [Environment]::GetEnvironmentVariable($v)
        if ($d) { return $d }
    }
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = $env:TEMP }
    return (Join-Path $base 'copilot-windows-guard')
}

function Write-GuardLog([string]$Message) {
    try {
        $dir = Get-GuardLogDir
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $line = "$(Get-Date -Format s) $Message`n"
        [System.IO.File]::AppendAllText((Join-Path $dir 'windows-guard.log'), $line, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Test-GuardDebug { return [bool]$env:WINDOWS_GUARD_DEBUG }

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
    # Runs git with stderr folded in and never throws. Returns @{ Code; Text }.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Dir @GitArgs 2>&1
        $code = $LASTEXITCODE
        $text = ($out | ForEach-Object { "$_" }) -join "`n"
        return @{ Code = $code; Text = $text }
    } catch {
        return @{ Code = 999; Text = '' }
    } finally {
        $ErrorActionPreference = $old
    }
}
