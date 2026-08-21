' Starts the dubbing server with no console window.
'
' Double-click this, or let the logon task run it. A .vbs wrapper is used
' because it is the only way on Windows to launch a console program with no
' window at all -- pythonw.exe would also work but swallows startup errors,
' and a minimised window still flashes on the taskbar at every logon.

Option Explicit

Dim shell, fso, here, python, script, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
python = here & "\.venv\Scripts\pythonw.exe"
script = here & "\server.py"

If Not fso.FileExists(python) Then
    python = here & "\.venv\Scripts\python.exe"
End If

If Not fso.FileExists(python) Then
    MsgBox "The virtual environment is missing." & vbCrLf & vbCrLf & _
           "Run run.ps1 once to set it up.", vbExclamation, "YouTube Persian Dubber"
    WScript.Quit 1
End If

command = """" & python & """ """ & script & """ --port 8760"

' 0 = hidden window, False = do not wait for it to finish
shell.Run command, 0, False
