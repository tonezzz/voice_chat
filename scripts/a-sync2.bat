@echo off
setlocal

rem Pull remote models directory down to local mirror.
rem Environment variables:
rem   SYNC_LOCAL_MODELS_ROOT  - defaults to C:\_dev\_models
rem   SYNC_REMOTE_MODELS_ROOT - UNC path or mapped drive for the source

set "REPO_ROOT=%~dp0.."
set "LOCAL_ROOT=%SYNC_LOCAL_MODELS_ROOT%"
if "%LOCAL_ROOT%"=="" set "LOCAL_ROOT=C:\_dev\_models"
set "REMOTE_ROOT=%SYNC_REMOTE_MODELS_ROOT%"
if "%REMOTE_ROOT%"=="" (
  echo [a-sync2] Please set SYNC_REMOTE_MODELS_ROOT to the remote source path (e.g., \\SECONDPC\dev_models)
  exit /b 1
)

if not exist "%REMOTE_ROOT%" (
  echo [a-sync2] Remote models root not reachable: %REMOTE_ROOT%
  exit /b 1
)

set "LOG_FILE=%REPO_ROOT%\logs\a-sync2.log"
if not exist "%REPO_ROOT%\logs" mkdir "%REPO_ROOT%\logs" >nul 2>&1

echo [a-sync2] Mirroring "%REMOTE_ROOT%" -> "%LOCAL_ROOT%"
robocopy "%REMOTE_ROOT%" "%LOCAL_ROOT%" /MIR /FFT /Z /XA:SH /W:2 /R:1 /NFL /NDL /NP /LOG+:"%LOG_FILE%"
set "RC=%ERRORLEVEL%"
if %RC% LSS 8 (
  echo [a-sync2] Sync complete (robocopy code %RC%). Log: %LOG_FILE%
  exit /b 0
) else (
  echo [a-sync2] Sync failed (robocopy code %RC%). See %LOG_FILE%
  exit /b %RC%
)
