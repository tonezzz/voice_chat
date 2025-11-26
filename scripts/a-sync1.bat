@echo off
setlocal

rem Push local models directory to remote mirror.
rem Environment variables:
rem   SYNC_LOCAL_MODELS_ROOT  - defaults to C:\_dev\_models
rem   SYNC_REMOTE_MODELS_ROOT - UNC path or mapped drive for the target

set "REPO_ROOT=%~dp0.."
set "LOCAL_ROOT=%SYNC_LOCAL_MODELS_ROOT%"
if "%LOCAL_ROOT%"=="" set "LOCAL_ROOT=C:\_dev\_models"
set "REMOTE_ROOT=%SYNC_REMOTE_MODELS_ROOT%"
if "%REMOTE_ROOT%"=="" (
  echo [a-sync1] Please set SYNC_REMOTE_MODELS_ROOT to the remote mirror path (e.g., \\SECONDPC\dev_models)
  exit /b 1
)

if not exist "%LOCAL_ROOT%" (
  echo [a-sync1] Local models root not found: %LOCAL_ROOT%
  exit /b 1
)

set "LOG_FILE=%REPO_ROOT%\logs\a-sync1.log"
if not exist "%REPO_ROOT%\logs" mkdir "%REPO_ROOT%\logs" >nul 2>&1

echo [a-sync1] Mirroring "%LOCAL_ROOT%" -> "%REMOTE_ROOT%"
robocopy "%LOCAL_ROOT%" "%REMOTE_ROOT%" /MIR /FFT /Z /XA:SH /W:2 /R:1 /NFL /NDL /NP /LOG+:"%LOG_FILE%"
set "RC=%ERRORLEVEL%"
if %RC% LSS 8 (
  echo [a-sync1] Sync complete (robocopy code %RC%). Log: %LOG_FILE%
  exit /b 0
) else (
  echo [a-sync1] Sync failed (robocopy code %RC%). See %LOG_FILE%
  exit /b %RC%
)
