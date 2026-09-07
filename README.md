# Discord MultiSpace 🚀

A production-grade, ultra-lightweight, multi-account desktop client for Discord built with Electron. Run unlimited Discord accounts side-by-side with complete session isolation, zero account conflicts, community themes, dual split-view, and power-user utilities.

---

## ✨ Key Features

- **🛡️ 100% Isolated Partitions**: Each account operates in its own persistent sandbox (`persist:discord_account_<id>`). Cookies, tokens, voice sessions, local storage, and cache are completely isolated.
- **🔒 Hardened Security Architecture**:
  - Strict `contextIsolation: true` and `nodeIntegration: false`.
  - Minimalist `preload.js` context bridge exposing only strictly whitelisted IPC channels.
  - Content Security Policy (CSP) enforcement.
  - Safe external URL & OAuth handling opening exclusively in the default system browser.
- **🎨 Themes & Community Skins Manager**:
  - One-click presets: **Midnight Dark**, **Pitch Black AMOLED**, **Clean Minimalist**, and **Default Discord**.
  - Custom CSS & `@import url(...)` support with automatic URL normalization.
  - Built-in directory links to BetterDiscord, Equicord, and VSThemes.
  - Real-time injection across all active and newly opened accounts.
- **⚡ Dual Split View**: Work across two accounts side-by-side on a single display with independent pane selection.
- **🌿 Background Memory Saver**: Automatically mutes and throttles background accounts idle for >15 minutes (unless inside an active voice call). Wakes instantly on click.
- **🎙️ WebRTC Voice, Video & Screen Sharing**: Native system picker screen sharing support with system audio loopback capture.
- **📌 Windows System Tray & Taskbar Badges**: Live account status, unread mention counts on the Windows taskbar, tray minimize/restore, and quick session reload.
- **🚨 Emergency Boss Key (`Ctrl + Shift + H`)**: Instantly mutes all accounts and hides the application to the system tray. Pressing it again restores the window and audio.
- **🔍 Per-Pane Zoom Scaling**: Zoom in/out per account (`Ctrl + + / - / 0`) with persistent zoom settings stored in `localStorage`.
- **⌨️ Keyboard Shortcuts**:
  - `Ctrl + 1` .. `Ctrl + 9`: Switch directly to accounts 1–9.
  - `Ctrl + Tab` / `Ctrl + Shift + Tab`: Cycle accounts.
  - `Ctrl + Alt + M`: Global Mute All.
  - `Ctrl + Alt + D`: Global Deafen All.
  - `Ctrl + Shift + H`: Emergency Boss Key (Mute & Hide / Restore).
  - `F5` / `Ctrl + R`: Reload active Discord tab.
  - `Ctrl + Shift + R`: Force reload the entire MultiSpace application.
  - `Alt`: Show/hide native menu bar.

---

## 🛠️ Installation & Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [Git](https://git-scm.com/)

### Setup
```bash
# Clone the repository
git clone https://github.com/<your-username>/discord-multispace.git
cd discord-multispace

# Install dependencies
npm install

# Run the app
npm start
```

### Windows Desktop Shortcut (Silent Launcher)
To create a clean, terminal-free desktop shortcut on Windows:
```bash
npm run make-shortcut
```
This creates a `Discord MultiSpace.lnk` shortcut on your Desktop pointing to the silent VBS launcher.

---

## 📂 Project Structure

```
discord-multispace/
├── main.js             # Electron main process (lifecycle, single-instance lock, WebRTC, tray)
├── preload.js          # Secure contextBridge IPC whitelist
├── renderer.js         # UI engine (state management, webviews, themes, split view, audio)
├── index.html          # Application layout, sidebar, modals, and context menus
├── style.css           # Modern Discord dark theme styling
├── package.json        # Dependencies and scripts
├── create-shortcut.js  # Desktop shortcut creator script
├── launch-silent.vbs   # Windows silent background launcher
├── launch.bat          # Batch launcher
└── README.md           # Documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
