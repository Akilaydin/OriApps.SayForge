param()
$ErrorActionPreference = 'Stop'
if (-not $env:GITHUB_OUTPUT) { throw 'This helper requires GitHub Actions.' }

function Get-Digest([string]$Text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant().Substring(0, 16)
}

$compiler = rustc -vV
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the Rust compiler.' }
$environment = @(($compiler -join "`n"), "image=$env:ImageVersion")
# Include Cargo/compiler flags without exposing their values in the logs.
Get-ChildItem Env: | Where-Object Name -Match '^(CARGO|CC|CFLAGS|CXX|CMAKE|RUST)' |
    Sort-Object Name | ForEach-Object { $environment += "$($_.Name)=$($_.Value)" }
$locks = @()
foreach ($configPath in @('.cargo/config.toml', 'client/src-tauri/.cargo/config.toml', '.github/tools/updater-verifier/.cargo/config.toml')) {
    if (Test-Path -LiteralPath $configPath) {
        $environment += (Get-Content -LiteralPath $configPath -Raw).Replace("`r`n", "`n").TrimEnd()
    }
}
foreach ($workspace in @('client/src-tauri', '.github/tools/updater-verifier')) {
    $manifest = (Get-Content "$workspace/Cargo.toml" -Raw).Replace("`r`n", "`n").TrimEnd()
    # A release version bump changes our binaries, not compiled dependencies.
    $manifest = [regex]::new('(?m)^version\s*=\s*"[^"]+"').Replace($manifest, 'version = "0.0.0"', 1)
    $environment += "$workspace`n$manifest"
    $locks += (Get-Content "$workspace/Cargo.lock" -Raw).Replace("`r`n", "`n").TrimEnd()
}
$prefix = "sayforge-rust-v3-$env:RUNNER_OS-$env:RUNNER_ARCH-$(Get-Digest ($environment -join "`n"))"
$dependencyHash = Get-Digest ($locks -join "`n")
$cargoRoot = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$paths = @(
    "$cargoRoot/registry",
    "$cargoRoot/git",
    'client/src-tauri/target',
    '.github/tools/updater-verifier/target',
    '!**/target/**/incremental/**',
    '!**/target/**/bundle/**',
    '!**/target/**/sayforge.exe',
    '!**/target/**/sayforge-*.exe',
    '!**/target/**/*.sig'
) -join "`n"
@(
    "key=$prefix-complete-$dependencyHash",
    "restore-prefix=$prefix-complete-",
    "partial-prefix=$prefix-partial-$dependencyHash-",
    "partial-key=$prefix-partial-$dependencyHash-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT",
    'paths<<CACHE_PATHS',
    $paths,
    'CACHE_PATHS'
) | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
Write-Output "Rust dependency cache: $prefix-complete-$dependencyHash"
