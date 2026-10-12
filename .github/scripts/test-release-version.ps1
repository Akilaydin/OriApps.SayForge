Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/prepare-release.ps1" -FunctionsOnly
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "sayforge-version-test-$([guid]::NewGuid())"
$source = 'a' * 40
$fixtureCommit = 'b' * 40
$savedEnvironment = @{}
foreach ($name in @('GITHUB_REF', 'GITHUB_REPOSITORY')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$mock = @{ head = $source; remote = $source; prepared = @(); parents = $source;
    changed = $versionFiles; dirty = $false; tags = @('refs/tags/v0.2.5'); releases = @('v0.2.5');
    denyGitHub = $false; denyPush = $false; commits = 0; pushes = 0 }

# Synthetic remote operations only. Fixture files are copied from the actual manifests.
function git {
    $global:LASTEXITCODE = 0
    switch ($args[2]) {
        'status' { if ($mock.dirty) { return ' M unrelated.txt' }; return }
        'fetch' { return }
        'log' { return $mock.prepared }
        'show' { return $mock.parents }
        'diff' { return $mock.changed }
        'checkout' { $mock.head = $args[4]; return }
        'rev-parse' { if ($args[3] -eq 'HEAD') { return $mock.head }; return $mock.remote }
        'config' { return }
        'add' { return }
        'commit' {
            if ('--allow-empty' -cnotin $args -or "SayForge-Release-Source: $source" -cnotin $args) { throw 'Missing retry marker.' }
            $mock.commits++; $mock.head = $fixtureCommit; return
        }
        'push' {
            if ($args -contains '--force') { throw 'Force push is forbidden.' }
            if ($mock.denyPush) { $global:LASTEXITCODE = 1; return }
            $mock.pushes++; $mock.remote = $fixtureCommit; $mock.prepared = @($fixtureCommit); return
        }
        default { throw "Unexpected git call: $($args -join ' ')" }
    }
}
function gh {
    $global:LASTEXITCODE = 0
    if ($mock.denyGitHub) { $global:LASTEXITCODE = 1; return }
    if ($args[1] -like '*/git/matching-refs/tags/v') { return $mock.tags }
    if ($args[1] -like '*/releases') { return $mock.releases }
    throw 'Unexpected GitHub call.'
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected $Expected, got $Actual." }
}
function Assert-Fails([scriptblock] $Action, [string] $Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        return
    }
    throw "Expected failure: $Message"
}
function Reset-Fixture {
    foreach ($file in $versionFiles) {
        $target = Join-Path $fixture $file
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path "$PSScriptRoot/../.." $file) -Destination $target
    }
    Set-ManifestVersion $fixture '0.2.5'
    $mock.head = $source; $mock.remote = $source; $mock.prepared = @(); $mock.parents = $source
    $mock.changed = $versionFiles; $mock.dirty = $false; $mock.commits = 0; $mock.pushes = 0
    $mock.denyGitHub = $false; $mock.denyPush = $false
    $mock.tags = @('refs/tags/v0.2.5'); $mock.releases = @('v0.2.5')
}

try {
    $env:GITHUB_REF = 'refs/heads/release'; $env:GITHUB_REPOSITORY = 'synthetic/sayforge'
    $RepositoryRoot = $fixture; $SourceCommit = $source
    Reset-Fixture
    $original = @{}
    foreach ($file in $versionFiles) { $original[$file] = [System.IO.File]::ReadAllText((Join-Path $fixture $file)) }
    Set-ManifestVersion $fixture '0.2.6'
    Assert-Equal (Get-ManifestVersion $fixture) '0.2.6'
    # Returning to the original version must reproduce every byte, including EOF/newlines and dependencies.
    Set-ManifestVersion $fixture '0.2.5'
    foreach ($file in $versionFiles) { Assert-Equal ([System.IO.File]::ReadAllText((Join-Path $fixture $file))) $original[$file] }
    Assert-Equal (Get-NextReleaseVersion '0.2.5' @('v0.2.4', 'v0.2.5')) '0.2.6'
    Assert-Equal (Get-NextReleaseVersion '0.2.5' @('v0.3.9', 'v0.3.10', 'v0.3.11-beta')) '0.3.11'
    Assert-Equal (Get-NextReleaseVersion '1.0.0' @('v0.2.5')) '1.0.0'
    Assert-Equal (Get-NextReleaseVersion '0.2.5' @()) '0.2.5'

    Assert-Equal (Prepare-ReleaseCommit) $fixtureCommit
    Assert-Equal (Get-ManifestVersion $fixture) '0.2.6'
    Assert-Equal $mock.commits 1; Assert-Equal $mock.pushes 1
    # Re-running the original triggering merge reuses the prepared version even after new tags appear.
    $mock.head = $source; $mock.tags += 'refs/tags/v0.2.6'
    Assert-Equal (Prepare-ReleaseCommit) $fixtureCommit
    Assert-Equal $mock.commits 1; Assert-Equal $mock.pushes 1
    Assert-Equal (Get-ManifestVersion $fixture) '0.2.6'
    $mock.changed = @('unrelated.txt')
    Assert-Fails { Prepare-ReleaseCommit } 'changes beyond version files'
    $mock.changed = $versionFiles; $mock.parents = 'c' * 40
    Assert-Fails { Prepare-ReleaseCommit } 'unexpected parent'

    Reset-Fixture
    $mock.releases = @('v0.2.7')
    Assert-Equal (Prepare-ReleaseCommit) $fixtureCommit
    Assert-Equal (Get-ManifestVersion $fixture) '0.2.8'
    Reset-Fixture
    Set-ManifestVersion $fixture '1.0.0'
    Assert-Equal (Prepare-ReleaseCommit) $fixtureCommit
    Assert-Equal (Get-ManifestVersion $fixture) '1.0.0'
    Assert-Equal (Prepare-ReleaseCommit) $fixtureCommit
    Assert-Equal $mock.commits 1

    Reset-Fixture
    $mock.remote = 'c' * 40
    Assert-Fails { Prepare-ReleaseCommit } 'Release branch advanced'
    Assert-Equal $mock.commits 0
    Reset-Fixture
    $mock.dirty = $true
    Assert-Fails { Prepare-ReleaseCommit } 'clean checkout'
    Reset-Fixture
    $mock.denyGitHub = $true
    Assert-Fails { Prepare-ReleaseCommit } 'reserved release tags'
    Assert-Equal $mock.commits 0
    Assert-Equal (Get-ManifestVersion $fixture) '0.2.5'
    Reset-Fixture
    $mock.denyPush = $true
    Assert-Fails { Prepare-ReleaseCommit } 'git command failed: push'
    Assert-Equal $mock.pushes 0
    Reset-Fixture
    $manifest = Join-Path $fixture 'client/package.json'
    $bad = [System.IO.File]::ReadAllText($manifest).Replace('"version": "0.2.5"', '"version": "0.2.4"')
    [System.IO.File]::WriteAllText($manifest, $bad)
    Assert-Fails { Prepare-ReleaseCommit } 'Version mismatch'
    Assert-Equal $mock.commits 0
    Write-Host 'Release version tests passed: metadata preservation, automatic patch bump, explicit versions, reserved tags/releases, retry reuse, checkout/parent/path guards and remote failures.'
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixture)
    if (-not $resolvedFixture.StartsWith([System.IO.Path]::GetTempPath()) -or
        [System.IO.Path]::GetFileName($resolvedFixture) -notlike 'sayforge-version-test-*') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
