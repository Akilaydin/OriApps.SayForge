$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'rust-cache-key.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("sayforge-cache-test-" + [Guid]::NewGuid())
$names = @('GITHUB_OUTPUT', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_OS', 'RUNNER_ARCH', 'RUSTFLAGS', 'CARGO_PROFILE_RELEASE_LTO')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }

function Read-Key {
    $env:GITHUB_OUTPUT = Join-Path $fixture 'outputs.txt'
    '' | Set-Content -LiteralPath $env:GITHUB_OUTPUT
    & $helper | Out-Null
    $result = @{}
    Get-Content -LiteralPath $env:GITHUB_OUTPUT | ForEach-Object {
        if ($_ -match '^([a-z-]+)=(.*)$') { $result[$matches[1]] = $matches[2] }
    }
    return $result
}

try {
    foreach ($workspace in @('client/src-tauri', '.github/tools/updater-verifier')) {
        $directory = Join-Path $fixture $workspace
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        @'
[package]
name = "fixture"
version = "1.0.0"
[profile.release]
lto = "thin"
codegen-units = 8
'@ | Set-Content "$directory/Cargo.toml"
        'version = 4' | Set-Content "$directory/Cargo.lock"
    }
    Push-Location $fixture
    $env:GITHUB_RUN_ID = '1'; $env:GITHUB_RUN_ATTEMPT = '1'
    $env:RUNNER_OS = 'Windows'; $env:RUNNER_ARCH = 'X64'
    $env:RUSTFLAGS = ''; $env:CARGO_PROFILE_RELEASE_LTO = ''
    $original = Read-Key
    $env:GITHUB_RUN_ID = '2'
    $nextRun = Read-Key
    if ($nextRun.key -ne $original.key -or $nextRun['partial-key'] -eq $original['partial-key']) {
        throw 'Complete caches must be reusable; partial snapshots must be replaceable.'
    }
    if ($original['partial-key'].StartsWith($original['restore-prefix'])) {
        throw 'An incomplete snapshot could shadow a complete cache.'
    }
    $manifest = 'client/src-tauri/Cargo.toml'
    (Get-Content $manifest -Raw).Replace('version = "1.0.0"', 'version = "1.0.1"') | Set-Content $manifest
    if ((Read-Key).key -ne $original.key) { throw 'Our package version must not invalidate dependency caches.' }
    'version = 4 # changed dependencies' | Set-Content 'client/src-tauri/Cargo.lock'
    $newLock = Read-Key
    if ($newLock.key -eq $original.key -or $newLock['restore-prefix'] -ne $original['restore-prefix']) {
        throw 'Lockfile changes need a fresh key with a compatible fallback.'
    }
    $env:RUSTFLAGS = '-C target-cpu=x86-64'
    $flags = Read-Key
    if ($flags['restore-prefix'] -eq $newLock['restore-prefix']) { throw 'Compiler flags must separate caches.' }
    $env:CARGO_PROFILE_RELEASE_LTO = 'fat'
    if ((Read-Key)['restore-prefix'] -eq $flags['restore-prefix']) { throw 'Profile overrides must separate caches.' }
    Add-Content $manifest "`n[dependencies.example]`nversion = `"1`""
    $dependency = Read-Key
    (Get-Content $manifest -Raw).Replace('version = "1"', 'version = "2"') | Set-Content $manifest
    if ((Read-Key)['restore-prefix'] -eq $dependency['restore-prefix']) { throw 'Dependency table versions must remain in the key.' }
    Write-Output 'Rust cache compatibility and partial-snapshot regression checks passed.'
} finally {
    if ((Get-Location).Path -eq $fixture) { Pop-Location }
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolved -Leaf) -notlike 'sayforge-cache-test-*') { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
