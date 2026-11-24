/**
 * Discord MultiSpace - Windows Desktop Shortcut Creator
 * Uses Windows Script Host (WScript.Shell) via PowerShell to create a clean,
 * silent desktop shortcut without leaving a terminal window open.
 */

const { execFile } = require('child_process');
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

if (!electronExePath || !fs.existsSync(electronExePath)) {
  electronExePath = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
}

const iconFilePath = path.join(projectDir, 'assets', 'icon.ico');
const iconLocation = fs.existsSync(iconFilePath) ? `${iconFilePath},0` : `${electronExePath},0`;

function escapePsSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

// Escape embedded double quotes for Windows command-line argument string
const quotedArg = `"${projectDir.replace(/"/g, '\\"')}"`;

console.log('Project Directory:', projectDir);
console.log('Electron Executable:', electronExePath);

const psCommand = `
$ErrorActionPreference = 'Stop'
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = $WshShell.SpecialFolders('Desktop')
$ShortcutPath = Join-Path $DesktopPath 'Discord MultiSpace.lnk'
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = '${escapePsSingleQuoted(electronExePath)}'
$Shortcut.Arguments = '${escapePsSingleQuoted(quotedArg)}'
$Shortcut.WorkingDirectory = '${escapePsSingleQuoted(projectDir)}'
$Shortcut.IconLocation = '${escapePsSingleQuoted(iconLocation)}'
$Shortcut.Description = 'Discord MultiSpace - Multi-Account Desktop Client'
$Shortcut.Save()
Write-Output "SUCCESS: Shortcut created at $ShortcutPath"
`.trim();

const psEncoded = Buffer.from(psCommand, 'utf16le').toString('base64');

execFile(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded],
  (error, stdout, stderr) => {
    if (error) {
      console.error('Failed to create shortcut:', error);
      if (stderr) console.error(stderr);
      process.exit(1);
    }
    console.log(stdout.trim());
  }
);
