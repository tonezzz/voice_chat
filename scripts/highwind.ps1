# Define the path to the Windsurf executable (used only if we need to launch it)
$windsurfPath = "C:\Program Files\Windsurf\Windsurf.exe"

# Define the process name (usually the executable name without the extension)
$processName = "Windsurf" # Modify if the process name is different

function Set-HighPriority($proc) {
    try {
        $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High
        Write-Output "Set '$($proc.ProcessName)' (PID $($proc.Id)) to High priority."
    } catch {
        Write-Error "Could not set priority for PID $($proc.Id). Try running PowerShell as administrator."
    }
}

# Try to detect an existing process
$existingProcesses = @()
try {
    $existingProcesses = Get-Process -Name $processName -ErrorAction Stop
} catch {
    $existingProcesses = @()
}

if ($existingProcesses.Count -gt 0) {
    Write-Output "Found $($existingProcesses.Count) running '$processName' instance(s). Elevating priority..."
    foreach ($proc in $existingProcesses) {
        Set-HighPriority -proc $proc
    }
    return
}

if (-not (Test-Path $windsurfPath)) {
    Write-Error "'$windsurfPath' not found and no running '$processName' detected. Update the path or start the app manually."
    exit 1
}

Write-Output "No running '$processName' detected. Launching $windsurfPath ..."
$process = Start-Process -FilePath $windsurfPath -PassThru
Start-Sleep -Milliseconds 500

if ($process) {
    Set-HighPriority -proc $process
} else {
    Write-Error "Failed to launch '$processName'. Check the executable path or permissions."
}
