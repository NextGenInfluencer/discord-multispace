# Discord MultiSpace 🚀

[![Latest Release](https://img.shields.io/github/v/release/NextGenInfluencer/discord-multispace?color=5865F2&logo=discord&logoColor=white)](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/NextGenInfluencer/discord-multispace/total?color=blue&logo=windows)](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-grade, ultra-lightweight, multi-account desktop client for Discord built with Electron. Run unlimited Discord accounts side-by-side with complete session isolation, zero account conflicts, community themes, dual split-view, and power-user utilities.

---

## 📥 Installation & Download

### Option 1: 1-Click Windows Installer (Recommended)
1. Head over to the **[Latest Release](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)** page.
2. Download **`Discord.MultiSpace.Setup.1.1.1.exe`**.
3. Double-click the downloaded `.exe` file. The installer will automatically:
   - Install Discord MultiSpace to your user applications folder.
   - Create a clean **Desktop shortcut** (`Discord MultiSpace.lnk`).
   - Add Discord MultiSpace to your Windows **Start Menu**.
   - Launch the application automatically!

> **Note on Windows SmartScreen:** As an independent, open-source application without an expensive commercial code-signing certificate, Windows SmartScreen may show an *"Unrecognized app"* warning. Simply click **More info** &rarr; **Run anyway** to proceed with installation.

---

### Option 2: 1-Click Source Setup (`setup.bat`)
If you downloaded the repository as a ZIP archive or cloned it via Git:
1. Double-click **`setup.bat`** in the root folder.
2. It will automatically verify dependencies, generate your Desktop shortcut, and launch the application directly on your screen.

---

### Option 3: Manual Developer Setup
```bash
# Clone the repository
git clone https://github.com/NextGenInfluencer/discord-multispace.git
cd discord-multispace

# Install dependencies
npm install

# Run the app in development
npm start

# Build the 1-click installer (.exe)
npm run build
```

---

## ✨ Key Features

- **🛡️ Session Sandboxing:** Multi-account persistence with hardened `contextIsolation: true` and dedicated persistent partitions (`persist:discord_account_<id>`). Cookies, tokens, voice sessions, local storage, and cache are completely isolated with zero crosstalk.
- **⚡ Split-View Workspace:** Dual-pane concurrent Discord workspaces. Work across two accounts side-by-side on a single display with independent pane selection.
- **🎨 Theme Engine:** Real-time CSS injection supporting built-in presets (**Midnight Dark**, **Pitch Black AMOLED**, **Clean Minimalist**, and **Default Discord**) as well as custom `@import url(...)` stylesheets from BetterDiscord, Equicord, and VSThemes.
- **🌿 Background Memory Saver:** Automatically mutes and throttles background accounts idle for >15 minutes (unless inside an active voice call). Wakes instantly on click.
- **🎙️ WebRTC Voice, Video & Screen Sharing:** Built-in screen and application window picker with live preview thumbnails, single/double-click selection, and WASAPI Windows system audio loopback capture.
- **📌 Windows System Tray & Taskbar Badges:** Live account status, unread mention counts on the Windows taskbar, tray minimize/restore, and quick session reload.
- **🚨 Emergency Boss Key (`Ctrl + Shift + H`):** Instantly mutes all accounts and hides the application to the system tray. Pressing it again restores the window and audio.
- **🔍 Per-Pane Zoom Scaling:** Zoom in/out per account (`Ctrl + + / - / 0`) with persistent zoom settings stored in `localStorage`.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Alt + M` | Global Mute All accounts |
| `Ctrl + Alt + D` | Global Deafen All accounts |
| `Ctrl + Shift + H` | Emergency Boss Key (Instant hide to tray & mute / Restore) |
| `Ctrl + 1` .. `Ctrl + 9` | Switch directly to accounts 1–9 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Cycle between open accounts |
| `F5` / `Ctrl + R` | Reload active Discord tab |
| `Ctrl + Shift + R` | Force reload the entire MultiSpace application |
| `Alt` | Toggle native top menu bar |

---

## 📂 Project Structure

```
discord-multispace/
├── main.js             # Electron main process (lifecycle, single-instance lock, WebRTC, tray)
├── preload.js          # Secure contextBridge IPC whitelist
├── renderer.js         # UI engine (state management, webviews, themes, split view, audio)
├── index.html          # Application layout, sidebar, modals, and context menus
├── style.css           # Modern Discord dark theme styling
├── setup.bat           # 1-click Windows setup & launcher
├── package.json        # Dependencies and build configuration
├── create-shortcut.js  # Desktop shortcut creator script
├── launch-silent.vbs   # Windows silent background launcher
├── launch.bat          # Batch launcher
└── README.md           # Documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
