Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$releaseScript = Join-Path $PSScriptRoot 'release.ps1'
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "sayforge-release-test-$([guid]::NewGuid())"
$previousEnvironment = @{}
foreach ($name in @('GITHUB_OUTPUT', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_STEP_SUMMARY', 'TAURI_ARTIFACT_PATHS', 'TAURI_APP_VERSION')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$mock = [pscustomobject] @{
    remoteTags = @()
    remoteReleases = @()
    denyGitHub = $false
    denyPublication = $false
    failUpload = $false
    invalidMetadata = $false
    apiCalls = [System.Collections.Generic.List[string]]::new()
}

# All GitHub calls are synthetic. No credentials, remote writes or real installers.
function gh {
    $mock.apiCalls.Add(($args -join ' '))
    $global:LASTEXITCODE = 0
    if ($mock.denyGitHub) { $global:LASTEXITCODE = 1; return }
    if ($args[1] -like '*/git/matching-refs/tags/v') { return $mock.remoteTags }
    if ($args[1] -like '*/releases') { return $mock.remoteReleases }
    if ($args[0] -eq 'api' -and $args[1] -eq '--method') {
        if ($mock.denyPublication) { $global:LASTEXITCODE = 1; return }
        if ($args[2] -eq 'DELETE') { return }
        if ($args[3] -like '*/git/refs') {
            if ("sha=$env:GITHUB_SHA" -cnotin $args -or 'ref=refs/tags/v0.2.3' -cnotin $args) { throw 'Incorrect tag target.' }
            return '{}'
        }
        if ('draft=false' -cnotin $args -or 'prerelease=false' -cnotin $args) { throw 'Release is not explicitly public.' }
        return '{"id":42}'
    }
    if ($args[0] -eq 'release' -and $args[1] -eq 'upload') {
        if ($mock.failUpload) { $global:LASTEXITCODE = 1 }
        if ('--clobber' -in $args) { throw 'Assets must never be overwritten.' }
        return
    }
    if ($args[1] -like '*/releases/42') {
        $remoteAssets = @(Get-ChildItem "$fixture/release-assets" -File | ForEach-Object {
            @{ name = $_.Name; size = $_.Length; state = 'uploaded' }
        })
        return @{ id = 42; draft = $mock.invalidMetadata; prerelease = $false; tag_name = 'v0.2.3';
            assets = $remoteAssets; html_url = 'https://example.invalid/release' } | ConvertTo-Json -Depth 5
    }
    if ($args[1] -like '*/git/ref/tags/v0.2.3') {
        return @{ object = @{ sha = $env:GITHUB_SHA } } | ConvertTo-Json
    }
    throw "Unexpected GitHub call in test: $($args -join ' ')"
}

function git { $global:LASTEXITCODE = 0; return $env:GITHUB_SHA }

function Assert-Fails([scriptblock] $Action, [string] $Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        return
    }
    throw "Expected failure: $Message"
}

function Run-Stage([string] $Stage) {
    & $releaseScript -Stage $Stage -RepositoryRoot $fixture
}

try {
    New-Item -ItemType Directory -Path "$fixture/client/src-tauri" -Force | Out-Null
    '{"version":"0.2.3","productName":"SayForge"}' | Set-Content "$fixture/client/src-tauri/tauri.conf.json"
    '{"version":"0.2.3"}' | Set-Content "$fixture/client/package.json"
    '{"version":"0.2.3","packages":{"":{"version":"0.2.3"}}}' | Set-Content "$fixture/client/package-lock.json"
    "[package]`nname = `"sayforge`"`nversion = `"0.2.3`"`n[dependencies]" | Set-Content "$fixture/client/src-tauri/Cargo.toml"
    "[[package]]`nname = `"sayforge`"`nversion = `"0.2.3`"" | Set-Content "$fixture/client/src-tauri/Cargo.lock"
    'Synthetic license' | Set-Content "$fixture/LICENSE"
    'Synthetic notices' | Set-Content "$fixture/THIRD_PARTY_NOTICES.md"
    $env:GITHUB_OUTPUT = "$fixture/outputs.txt"
    $env:GITHUB_REPOSITORY = 'synthetic/sayforge'
    $env:GITHUB_SHA = 'a' * 40
    $env:GITHUB_STEP_SUMMARY = "$fixture/summary.txt"
    $env:TAURI_APP_VERSION = '0.2.3'

    Run-Stage Preflight
    if ('release_needed=true' -cnotin (Get-Content $env:GITHUB_OUTPUT)) { throw 'First release did not proceed.' }
    $mock.remoteTags = @('refs/tags/v0.2.2')
    Run-Stage Preflight
    $mock.remoteTags = @('refs/tags/v0.2.3')
    Run-Stage Preflight
    if ((Get-Content $env:GITHUB_OUTPUT)[-1] -cne 'release_needed=false') { throw 'Existing tag did not skip.' }
    $mock.remoteTags = @('refs/tags/v0.2.4')
    Assert-Fails { Run-Stage Preflight } 'must be greater'
    $mock.remoteTags = @()
    $mock.remoteReleases = @('v0.2.3')
    Assert-Fails { Run-Stage Preflight } 'already exists without its tag'
    $mock.remoteReleases = @()
    $mock.denyGitHub = $true
    Assert-Fails { Run-Stage Preflight } 'GitHub command failed'
    $mock.denyGitHub = $false
    '{"version":"0.2.2"}' | Set-Content "$fixture/client/package.json"
    Assert-Fails { Run-Stage Preflight } 'Version mismatch'
    '{"version":"0.2.3"}' | Set-Content "$fixture/client/package.json"

    $exe = "$fixture/SayForge_0.2.3_x64-setup.exe"
    $msi = "$fixture/SayForge_0.2.3_x64_en-US.msi"
    'Synthetic EXE' | Set-Content $exe
    'Synthetic MSI' | Set-Content $msi
    $env:TAURI_ARTIFACT_PATHS = ConvertTo-Json @($exe)
    Assert-Fails { Run-Stage Prepare } 'Exactly one'
    [System.IO.File]::WriteAllBytes($msi, [byte[]] @())
    $env:TAURI_ARTIFACT_PATHS = ConvertTo-Json @($exe, $msi)
    Assert-Fails { Run-Stage Prepare } 'Empty installer'
    'Synthetic MSI' | Set-Content $msi
    $wrongVersion = "$fixture/SayForge_0.2.2_x64-setup.exe"
    'Synthetic EXE' | Set-Content $wrongVersion
    $env:TAURI_ARTIFACT_PATHS = ConvertTo-Json @($wrongVersion, $msi)
    Assert-Fails { Run-Stage Prepare } 'Installer names'
    $env:TAURI_ARTIFACT_PATHS = ConvertTo-Json @($exe, $msi)
    $env:TAURI_APP_VERSION = '0.2.2'
    Assert-Fails { Run-Stage Prepare } 'Tauri build version'
    $env:TAURI_APP_VERSION = '0.2.3'
    Run-Stage Prepare
    if (@(Get-ChildItem "$fixture/release-assets" -File).Count -ne 5) { throw 'Missing prepared assets.' }
    'Tampered synthetic EXE' | Set-Content "$fixture/release-assets/SayForge_0.2.3_x64-setup.exe"
    Assert-Fails { Run-Stage Publish } 'checksum verification failed'
    if (@($mock.apiCalls | Where-Object { $_ -like '*POST*' }).Count -ne 0) { throw 'Guard tests wrote to GitHub.' }
    'Synthetic EXE' | Set-Content "$fixture/release-assets/SayForge_0.2.3_x64-setup.exe"
    $mock.denyPublication = $true
    Assert-Fails { Run-Stage Publish } 'GitHub command failed'
    if (@($mock.apiCalls | Where-Object { $_ -like '*POST*/releases *' }).Count -ne 0) { throw 'Permission denial created a release.' }
    $mock.denyPublication = $false
    $mock.failUpload = $true
    Assert-Fails { Run-Stage Publish } 'GitHub command failed'
    if (@($mock.apiCalls | Where-Object { $_ -like '*DELETE*/releases/42' }).Count -ne 1) { throw 'Failed upload did not clean up its release.' }
    $mock.failUpload = $false
    $mock.invalidMetadata = $true
    Assert-Fails { Run-Stage Publish } 'metadata is incorrect'
    $mock.invalidMetadata = $false
    Run-Stage Publish
    Write-Host 'Release tests passed: version/tag guards, API/permission denial, missing/empty/wrong installers, checksum tampering, upload cleanup, metadata and public publication at the tested SHA.'
} finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name]) }
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixture)
    if (-not $resolvedFixture.StartsWith([System.IO.Path]::GetTempPath()) -or
        [System.IO.Path]::GetFileName($resolvedFixture) -notlike 'sayforge-release-test-*') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
