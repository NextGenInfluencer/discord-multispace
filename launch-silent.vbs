Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\lefte\Documents\antigravity\discord-multispace"
WshShell.Run """node_modules\electron\dist\electron.exe"" .", 0, False
