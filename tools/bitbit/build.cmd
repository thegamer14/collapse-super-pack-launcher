@echo off
rem Rebuilds BitBit.exe with the C# compiler that ships with Windows, so the
rem upscaler needs no SDK and no NuGet packages.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Could not find the .NET Framework compiler at "%CSC%".
  exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ ^
  /out:"%~dp0BitBit.exe" "%~dp0BitBit.cs" ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll
if errorlevel 1 exit /b 1
echo Built %~dp0BitBit.exe
