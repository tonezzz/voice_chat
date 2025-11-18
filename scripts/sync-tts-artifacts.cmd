@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Copies exported FastSpeech2/HiFi-GAN artifacts into the client public directory
REM Usage: sync-tts-artifacts.cmd [source_dir] [destination_dir]
REM        source_dir defaults to C:\_dev\_models\tts_web
REM        destination_dir defaults to <repo>\client\public\models\tts

set "DEFAULT_SRC=C:\_dev\_models\tts_web"
set "DEFAULT_DEST=%~dp0..\client\public\models\tts"

if "%~1"=="" (
  set "SRC=%DEFAULT_SRC%"
) else (
  set "SRC=%~1"
)

if "%~2"=="" (
  set "DEST=%DEFAULT_DEST%"
) else (
  set "DEST=%~2"
)

if not exist "%SRC%" (
  echo [sync-tts] Source directory not found: "%SRC%"
  echo            Pass a different path as the first argument if needed.
  exit /b 1
)

if not exist "%DEST%" (
  echo [sync-tts] Creating destination directory "%DEST%"
  mkdir "%DEST%" >nul 2>&1
)

robocopy "%SRC%" "%DEST%" *.* /E /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo [sync-tts] Robocopy failed with exit code %RC%
  exit /b %RC%
)

echo [sync-tts] Synced "%SRC%" -> "%DEST%"
exit /b 0
