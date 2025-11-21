@echo off
setlocal ENABLEEXTENSIONS

rem Run from repo root
pushd "%~dp0.." >nul || exit /b 1

if not exist ".env" (
  echo [ERROR] Missing .env. Copy the tracked template before running checks.
  goto :error
)

if not exist ".env.secure" (
  echo [ERROR] Missing .env.secure. Create it and keep it with the repo before pushing.
  goto :error
)

call :section "Installing client deps (npm ci)"
pushd client >nul
if exist package-lock.json (
  call npm ci || goto :error_pop_client
) else (
  call npm install || goto :error_pop_client
)

call :section "Client build & server/public sync (npm run build:deploy)"
call :should_build_client
if /i "%NEED_CLIENT_BUILD%"=="0" (
  echo No client changes detected. Skipping npm run build:deploy.
) else (
  call npm run build:deploy || goto :error_pop_client
)
popd >nul

echo.
call :section "Installing server deps (npm ci)"
pushd server >nul
if exist package-lock.json (
  call npm ci || goto :error_pop_server
) else (
  call npm install || goto :error_pop_server
)

echo.
call :section "Server syntax check (node --check index.js)"
node --check index.js || goto :error_pop_server
popd >nul

echo.
call :section "docker compose config validation (dotenv)"
call npx dotenv -e .env -e .env.secure -- docker compose -f docker-compose.yml config >nul || goto :error

echo.
echo [OK] Pre-push checks completed.
goto :eof

:section
set "LABEL=%~1"
echo === %LABEL% ===
exit /b 0

:should_build_client
set "NEED_CLIENT_BUILD=0"
for /f "delims=" %%F in ('git status --short client scripts/sync-client-dist.cjs 2^>nul') do (
  set "NEED_CLIENT_BUILD=1"
  goto :should_build_client_done
)
:should_build_client_done
exit /b 0

:error_pop_client
popd >nul
:error
popd >nul
exit /b 1

:error_pop_server
popd >nul
popd >nul
exit /b 1
