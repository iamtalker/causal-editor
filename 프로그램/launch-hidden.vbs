' Starts server.js without a console window. Status and errors go to server.log (written by server.js).
' Uses the Node.js that the .bat downloaded into <root>\node when present, otherwise the Node.js on PATH.
Option Explicit
Dim sh, fso, dir, root, node, q, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
dir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(dir)
sh.CurrentDirectory = dir
node = root & "\node\node.exe"
If Not fso.FileExists(node) Then
  rc = sh.Run("cmd /c where node >nul 2>&1", 0, True)
  If rc <> 0 Then
    MsgBox "Node.js was not found. Run the .bat file again with an internet connection, or install Node.js (https://nodejs.org).", 48, "Causal Editor"
    WScript.Quit 1
  End If
  node = "node"
End If
sh.Run "cmd /c " & q & q & node & q & " server.js" & q, 0, False
