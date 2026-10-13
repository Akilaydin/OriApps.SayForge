param(
    [Parameter(Mandatory)][string]$Executable
)
$ErrorActionPreference = 'Stop'
# Never start the installed/personal app or use a developer's desktop for this probe.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Startup smoke is restricted to a disposable Windows CI runner.'
}
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$workspacePath = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $executablePath.StartsWith($workspacePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Executable must be built inside the CI workspace.'
}
$process = $null
try {
    $process = Start-Process -FilePath $executablePath -WorkingDirectory (Split-Path $executablePath) -WindowStyle Hidden -PassThru
    if (-not $process.WaitForInputIdle(15000)) { throw 'The application GUI did not become idle.' }
    Start-Sleep -Seconds 3
    $process.Refresh()
    if ($process.HasExited) { throw "Application exited during startup: $($process.ExitCode)" }
    $result = @{
        executableBytes = (Get-Item -LiteralPath $executablePath).Length
        startup = 'passed'
        profile = $env:SAYFORGE_BENCH_PROFILE
    } | ConvertTo-Json
    New-Item -ItemType Directory -Path 'target/ci-metrics' -Force | Out-Null
    $result | Set-Content -LiteralPath 'target/ci-metrics/startup.json' -Encoding utf8
    Write-Output $result
} finally {
    # Stop only the process launched by this probe.
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
