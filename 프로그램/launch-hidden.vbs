' Starts server.js without a console window. Status and errors go to server.log (written by server.js).
Option Explicit
Dim sh, fso, dir, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
rc = sh.Run("cmd /c where node >nul 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "Node.js was not found. Install Node.js first (https://nodejs.org).", 48, "Causal Editor"
  WScript.Quit 1
End If
sh.Run "cmd /c node server.js", 0, False
