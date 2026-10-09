$ErrorActionPreference = 'Stop'
$taskRoot = (Get-Location).Path
$taskArtifacts = & cargo test --manifest-path client/src-tauri/Cargo.toml --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Could not compile benchmark tests' }
$taskExePath = $taskArtifacts | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'sayforge' -and $_.profile.test -and $_.executable } | Select-Object -Last 1 -ExpandProperty executable
if (!$taskExePath) { throw 'Compiled benchmark test binary not found' }
$taskExe = Get-Item -LiteralPath $taskExePath
foreach ($taskMode in @('base64','chunked','binary')) {
  $env:SAYFORGE_IPC_BENCH_MODE = $taskMode
  $taskProcess = Start-Process -FilePath $taskExe.FullName -ArgumentList 'benchmark_windows_audio_ipc','--ignored','--nocapture','--test-threads=1' -WorkingDirectory "$taskRoot/client/src-tauri" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskRoot/.git/ipc-$taskMode.stdout" -RedirectStandardError "$taskRoot/.git/ipc-$taskMode.stderr"
  $taskCpu = @{}; $taskHandles = @{}; $taskParents = @($taskProcess.Id); $taskPeak = 0L
  while (!$taskProcess.HasExited) {
    $taskTree = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
    do {
      $taskNext = @($taskTree | Where-Object { $taskParents -contains $_.ParentProcessId -and $taskParents -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId)
      $taskParents += $taskNext
    } while ($taskNext.Count)
    $taskMemory = 0L
    foreach ($taskId in $taskParents) {
      try {
        if (!$taskHandles.ContainsKey($taskId)) { $taskHandles[$taskId] = [System.Diagnostics.Process]::GetProcessById($taskId) }
        $taskHandle = $taskHandles[$taskId]; $taskHandle.Refresh()
        $taskCpu[$taskId] = $taskHandle.TotalProcessorTime.TotalMilliseconds
        $taskMemory += $taskHandle.WorkingSet64
      } catch { }
    }
    $taskPeak = [Math]::Max($taskPeak, $taskMemory)
    Start-Sleep -Milliseconds 50
  }
  $taskProcess.WaitForExit()
  if ($taskProcess.ExitCode -ne 0) { Get-Content "$taskRoot/.git/ipc-$taskMode.stderr"; throw "Benchmark failed: $taskMode" }
  Copy-Item -LiteralPath "$taskRoot/.git/ipc-benchmark.json" -Destination "$taskRoot/.git/ipc-$taskMode.json"
  [pscustomobject]@{mode=$taskMode;cpu_ms=($taskCpu.Values | Measure-Object -Sum).Sum;sampled_peak_working_set_bytes=$taskPeak;process_count=$taskHandles.Count} | ConvertTo-Json | Set-Content "$taskRoot/.git/ipc-$taskMode.metrics.json"
  Get-Content "$taskRoot/.git/ipc-$taskMode.metrics.json"
}
Remove-Item Env:SAYFORGE_IPC_BENCH_MODE
