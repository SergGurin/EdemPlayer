@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo === Сборка EdemPlayer для Android TV ===

rem --- JDK 17+: JAVA_HOME или встроенный в Android Studio ---
if defined JAVA_HOME goto havejava
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if defined JAVA_HOME goto havejava
if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
if defined JAVA_HOME goto havejava
if exist "%ProgramFiles%\Android\Android Studio\jre\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jre"
:havejava
if defined JAVA_HOME echo Java: %JAVA_HOME%

rem --- Android SDK: local.properties ---
if exist local.properties goto havesdk
set "SDK=%ANDROID_HOME%"
if "%SDK%"=="" set "SDK=%ANDROID_SDK_ROOT%"
if "%SDK%"=="" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not exist "%SDK%" (
  echo ОШИБКА: не найден Android SDK. Укажите путь в android\local.properties: sdk.dir=C:/путь/к/Sdk
  pause & exit /b 1
)
set "SDKF=%SDK:\=/%"
> local.properties echo sdk.dir=%SDKF%
:havesdk
type local.properties

rem --- сборка ---
call gradlew.bat assembleRelease --no-daemon
if errorlevel 1 (
  echo.
  echo ОШИБКА СБОРКИ — пришлите текст выше.
  pause & exit /b 1
)

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content ..\package.json -Raw | ConvertFrom-Json).version"`) do set "VER=%%v"
copy /y "app\build\outputs\apk\release\app-release.apk" "..\EdemPlayer-TV-%VER%.apk" >nul
echo.
echo Готово: %~dp0..\EdemPlayer-TV-%VER%.apk

rem --- если проектор подключён по adb (сеть/USB) — сразу установить ---
set "ADB=%SDK%\platform-tools\adb.exe"
if not exist "%ADB%" for /f "usebackq tokens=2 delims==" %%s in (`findstr /b "sdk.dir" local.properties`) do set "ADB=%%s/platform-tools/adb.exe"
if exist "%ADB%" (
  "%ADB%" devices | findstr /r /c:"device$" >nul && (
    echo Найдено устройство adb — устанавливаю...
    "%ADB%" install -r "..\EdemPlayer-TV-%VER%.apk"
  )
)
pause
