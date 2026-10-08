@echo off
rem "handide" on the command line, for installs made with the Windows installer.
"%~dp0node\node.exe" "%~dp0app\proxy\server.mjs" %*
