@echo off
rem Builds the portable Windows app:
rem   desktop_py\dist\Datanique\Datanique.exe              (the app folder)
rem   desktop_py\dist\Datanique-<version>-windows-portable.zip
rem
rem Needs Python 3.12 (python on PATH) and, unless frontend\dist is already
rem built, Node.js 20 or newer. Everything else comes from PyPI.
setlocal EnableExtensions
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PY=%ROOT%\backend\.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo Creating backend\.venv
    python -m venv "%ROOT%\backend\.venv" || goto :fail
)

echo.
echo === Python packages
"%PY%" -m pip install --disable-pip-version-check -q --upgrade pip || goto :fail
"%PY%" -m pip install --disable-pip-version-check -q -r "%ROOT%\backend\requirements.txt" pywebview==5.4 python-dotenv==1.0.1 pyinstaller==6.16.0 || goto :fail

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
set "TESTDIR=%TEMP%\datanique-selftest-%RANDOM%"
start "" /wait "%ROOT%\desktop_py\dist\Datanique\Datanique.exe" --self-test --data-dir "%TESTDIR%"
set "RC=%ERRORLEVEL%"
type "%TESTDIR%\self-test.json" 2>nul
rmdir /s /q "%TESTDIR%" 2>nul
if not "%RC%"=="0" (echo Self-test failed with code %RC%. & goto :fail)

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
