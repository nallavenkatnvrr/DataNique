@echo off
rem Builds the portable Windows app on this PC:
rem   desktop_py\dist\Datanique\Datanique.exe              (the app folder)
rem   desktop_py\dist\Datanique-<version>-windows-portable.zip
rem
rem Needs Python 3.10 to 3.14 ("python" on PATH, or py -3.14) and, unless
rem frontend\dist is already built, Node.js 20 or newer. Everything else
rem comes from PyPI. Uses backend\.venv, the same environment start-app.bat uses.
setlocal EnableExtensions
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PY=%ROOT%\backend\.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo Creating backend\.venv
    python -m venv "%ROOT%\backend\.venv" || goto :fail
)
"%PY%" -c "import sys; print('Python', sys.version.split()[0]); sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 14) else 1)" || (echo Datanique needs Python 3.10 to 3.14. & goto :fail)

echo.
echo === Python packages
"%PY%" -m pip install --disable-pip-version-check -q --upgrade pip || goto :fail
"%PY%" -m pip install --disable-pip-version-check -q -r "%ROOT%\backend\requirements.txt" -r "%ROOT%\desktop_py\requirements-desktop.txt" pyinstaller==6.16.0 || goto :fail

echo.
echo === User interface
if exist "%ROOT%\frontend\dist\index.html" (
    echo Using the existing frontend\dist build.
) else (
    where npm >nul 2>nul || (echo frontend\dist is missing and Node.js is not installed. & goto :fail)
    pushd "%ROOT%\frontend"
    call npm ci || (popd & goto :fail)
    call npm run build || (popd & goto :fail)
    popd
)

echo.
echo === Freezing (takes a few minutes)
"%PY%" -m PyInstaller "%ROOT%\desktop_py\datanique.spec" --noconfirm --clean ^
    --distpath "%ROOT%\desktop_py\dist" --workpath "%ROOT%\desktop_py\build" || goto :fail

echo.
echo === Self-test
rem Runs the new exe against a throw-away data folder, at most 5 minutes.
set "TESTDIR=%TEMP%\datanique-selftest-%RANDOM%"
set "DNQ_EXE=%ROOT%\desktop_py\dist\Datanique\Datanique.exe"
set "DNQ_TEST=%TESTDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath $env:DNQ_EXE -ArgumentList ('--self-test --data-dir ' + [char]34 + $env:DNQ_TEST + [char]34) -PassThru; $null = $p.Handle; if (-not $p.WaitForExit(300000)) { $p.Kill(); exit 99 }; exit $p.ExitCode"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo Self-test failed with code %RC%. Its log:
    type "%TESTDIR%\logs\datanique.log" 2>nul
    type "%TESTDIR%\self-test.json" 2>nul
    echo.
    echo The log is also in %TESTDIR%
    goto :fail
)
echo Passed.
rmdir /s /q "%TESTDIR%" 2>nul

echo.
echo === Zip
set /p VER=<"%ROOT%\desktop_py\dist\Datanique-version.txt"
set "ZIP=%ROOT%\desktop_py\dist\Datanique-%VER%-windows-portable.zip"
if exist "%ZIP%" del "%ZIP%"
tar -a -c -f "%ZIP%" -C "%ROOT%\desktop_py\dist" Datanique || goto :fail

echo.
echo Done.
echo   App folder: %ROOT%\desktop_py\dist\Datanique\Datanique.exe
echo   Zip:        %ZIP%
endlocal
exit /b 0

:fail
echo.
echo Build failed.
endlocal
exit /b 1
