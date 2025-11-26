@echo off
setlocal

rem Resolve repo root (this script lives in scripts/)
set "REPO_ROOT=%~dp0.."
if not exist "%REPO_ROOT%\.git" (
  echo [auto-multi-pc] Could not locate repo root from %~f0.
  exit /b 1
)

pushd "%REPO_ROOT%" >nul

call :maybe_sync_models || goto :error

call :section "Pull latest changes (git pull)"
git pull || goto :error

call :install_dir client || goto :error
call :install_dir server || goto :error

if /i "%AUTO_MULTI_PC_SKIP_WSAI%"=="1" (
  call :section "Skip dev-wsai container (AUTO_MULTI_PC_SKIP_WSAI=1)"
) else (
  call :section "Start dev-wsai container"
  call npx dotenv-cli -e .env -- docker compose -f docker-compose.yml -f docker-compose.optional.yml up -d dev-wsai || goto :error
)

echo.
echo [auto-multi-pc] All done. Dev workspace should be available at https://localhost:%DEV_WSAI_PORT% (default 8443).
popd >nul
exit /b 0

:maybe_sync_models
setlocal
set "MODE=%AUTO_MULTI_PC_SYNC_MODE%"
if "%MODE%"=="" (
  endlocal & exit /b 0
)

if /i "%MODE%"=="push" (
  call :section "Sync models (push via a-sync1)"
  call scripts\a-sync1.bat && (endlocal & exit /b 0) || (endlocal & exit /b 1)
)

if /i "%MODE%"=="pull" (
  call :section "Sync models (pull via a-sync2)"
  call scripts\a-sync2.bat && (endlocal & exit /b 0) || (endlocal & exit /b 1)
)

echo [auto-multi-pc] Unknown AUTO_MULTI_PC_SYNC_MODE value: %MODE%
endlocal
exit /b 1

:install_dir
setlocal
set "TARGET=%~1"
call :section "Install %TARGET% deps (npm install)"
pushd "%REPO_ROOT%\%TARGET%" >nul || (echo [auto-multi-pc] Missing folder %TARGET% && exit /b 1)
call npx dotenv-cli -e ..\.env -- npm install || (popd >nul & exit /b 1)
popd >nul
exit /b 0

:section
setlocal
set "TITLE=%~1"
echo.
echo ==================================================
echo %TITLE%
echo ==================================================
endlocal
exit /b 0

:error
echo.
echo [auto-multi-pc] FAILED. See messages above.
popd >nul
exit /b 1
