/**
 * Discord MultiSpace - Windows Desktop Shortcut Creator
 * Uses Windows Script Host (WScript.Shell) via PowerShell to create a clean,
 * silent desktop shortcut without leaving a terminal window open.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectDir = path.resolve(__dirname);

// Resolve electron executable path directly
let electronExePath;
try {
  electronExePath = require('electron');
} catch {
  electronExePath = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
}

// Fallback check
if (!fs.existsSync(electronExePath)) {
  electronExePath = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
}

console.log('Project Directory:', projectDir);
console.log('Electron Executable:', electronExePath);

// PowerShell script to invoke WScript.Shell and create the .lnk shortcut
const psCommand = `
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = $WshShell.SpecialFolders("Desktop")
$ShortcutPath = Join-Path $DesktopPath "Discord MultiSpace.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = '${electronExePath}'
$Shortcut.Arguments = '"${projectDir}"'
$Shortcut.WorkingDirectory = '${projectDir}'
$Shortcut.IconLocation = '${electronExePath},0'
$Shortcut.Description = 'Discord MultiSpace - Multi-Account Desktop Client'
$Shortcut.Save()
Write-Output "SUCCESS: Shortcut created at $ShortcutPath"
`.trim();

// Base64 encode the PowerShell script to avoid escaping issues
const psEncoded = Buffer.from(psCommand, 'utf16le').toString('base64');
const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded}`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error('Failed to create shortcut:', error);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
  console.log(stdout.trim());
});
