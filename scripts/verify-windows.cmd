@echo off
rem HandNote: Windows verification. Double-click or run from cmd/PowerShell.
rem Uses your existing Node.js/npm and your existing npm registry setting (it does not change it).
rem Output: test-output\windows-verify.log
setlocal
cd /d "%~dp0\.."
if not exist test-output mkdir test-output
set "LOG=test-output\windows-verify.log"
echo HandNote Windows verification > "%LOG%"
echo started %DATE% %TIME% >> "%LOG%"
ver >> "%LOG%"
echo --- node / npm / git --- >> "%LOG%"
where node >> "%LOG%" 2>&1
node -v >> "%LOG%" 2>&1
call npm -v >> "%LOG%" 2>&1
echo npm registry: >> "%LOG%"
call npm config get registry >> "%LOG%" 2>&1
git --version >> "%LOG%" 2>&1
git log -1 --oneline >> "%LOG%" 2>&1

echo === STEP npm install === >> "%LOG%"
call npm install --no-audit --no-fund >> "%LOG%" 2>&1
echo RESULT npm-install %ERRORLEVEL% >> "%LOG%"

echo === STEP typecheck === >> "%LOG%"
call npm run typecheck >> "%LOG%" 2>&1
echo RESULT typecheck %ERRORLEVEL% >> "%LOG%"

echo === STEP unit tests === >> "%LOG%"
call npm test >> "%LOG%" 2>&1
echo RESULT unit-tests %ERRORLEVEL% >> "%LOG%"

echo === STEP build === >> "%LOG%"
call npm run build >> "%LOG%" 2>&1
echo RESULT build %ERRORLEVEL% >> "%LOG%"

echo === STEP package === >> "%LOG%"
call npm run package >> "%LOG%" 2>&1
echo RESULT package %ERRORLEVEL% >> "%LOG%"

echo === STEP release check === >> "%LOG%"
call node scripts\check-release.mjs >> "%LOG%" 2>&1
echo RESULT release-check %ERRORLEVEL% >> "%LOG%"

echo === STEP browser integration tests (Edge, optional) === >> "%LOG%"
call npm install --no-save --no-audit --no-fund playwright-core >> "%LOG%" 2>&1
call npm run test:browser >> "%LOG%" 2>&1
echo RESULT browser-tests %ERRORLEVEL% >> "%LOG%"

echo === git status after build (tracked files must be unchanged) === >> "%LOG%"
git status --short >> "%LOG%" 2>&1
echo finished %DATE% %TIME% >> "%LOG%"
echo DONE >> "%LOG%"
echo.
echo HandNote verification finished. See %LOG%
endlocal
