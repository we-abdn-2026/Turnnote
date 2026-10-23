param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$UserDataRoot
)
$ErrorActionPreference = 'Stop'
$executable = Join-Path $InstallDir 'Turnnote.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Installed executable was not found at $executable."
}

# Both the negative control and the successful probe use this exact CI gate.
function Invoke-PackagingSmoke([string]$UserData) {
  $smoke = Start-Process -FilePath $executable `
    -ArgumentList @('--packaging-smoke', "--user-data-dir=`"$UserData`"") `
    -Wait -PassThru
  if ($smoke.ExitCode -ne 0) {
    throw "Packaging smoke test failed with exit code $($smoke.ExitCode)."
  }
  $reportPath = Join-Path $UserData 'packaging-validation.json'
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Packaging validation report was not found at $reportPath."
  }
  $reportJson = Get-Content -LiteralPath $reportPath -Raw
  if ($reportJson.Contains($InstallDir) -or $reportJson.Contains($UserData)) {
    throw 'Packaging validation report exposed a local installation or user data path.'
  }
  $report = $reportJson | ConvertFrom-Json
  if ($report.PSObject.Properties.Name -contains 'sidecarPath') {
    throw 'Packaging validation report exposed an absolute sidecar path.'
  }
  if ($report.platform -ne 'win32' -or $report.architecture -ne 'x64' -or
      $report.sqlite -ne 'ok' -or $report.sidecar -ne 'ok' -or
      $report.sidecarResource -ne 'asr-worker/asr-worker.exe' -or
      $report.electronVersion -eq 'unknown' -or $report.modulesAbi -notmatch '^\d+$') {
    throw 'Packaging validation report did not pass the Windows x64 checks.'
  }
  $report | ConvertTo-Json -Depth 5
}

# Break an actual installed dependency, then verify the same gate rejects it.
$sidecar = Join-Path $InstallDir 'resources/asr-worker/asr-worker.exe'
$backup = "$sidecar.validation-disabled"
$failureUserData = "$UserDataRoot-failure"
Move-Item -LiteralPath $sidecar -Destination $backup
try {
  $rejected = $false
  try {
    Invoke-PackagingSmoke $failureUserData
  } catch {
    if ($_.Exception.Message -ne 'Packaging smoke test failed with exit code 1.') { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw 'The CI gate accepted a missing installed sidecar.' }
  $failureReportJson = Get-Content -LiteralPath (Join-Path $failureUserData 'packaging-validation.json') -Raw
  $failureReport = $failureReportJson | ConvertFrom-Json
  if ($failureReport.PSObject.Properties.Name -contains 'sidecarPath') {
    throw 'Negative control report exposed an absolute sidecar path.'
  }
  if ($failureReport.platform -ne 'win32' -or $failureReport.architecture -ne 'x64' -or
      $failureReport.sqlite -ne 'ok' -or $failureReport.sidecar -ne 'failed' -or
      $failureReport.sidecarResource -ne 'asr-worker/asr-worker.exe' -or
      $failureReport.electronVersion -eq 'unknown' -or $failureReport.modulesAbi -notmatch '^\d+$') {
    throw 'Negative control did not reach the real sidecar failure path.'
  }
  Write-Output 'Negative control: the CI gate rejected the missing sidecar with exit code 1.'
  $failureReport | ConvertTo-Json -Depth 5
} finally {
  Move-Item -LiteralPath $backup -Destination $sidecar
}
Invoke-PackagingSmoke $UserDataRoot
