# Discord MultiSpace 🚀

[![Latest Release](https://img.shields.io/github/v/release/NextGenInfluencer/discord-multispace?color=5865F2)](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/NextGenInfluencer/discord-multispace/total?color=blue&logo=windows)](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightweight, security-hardened, multi-account desktop workspace for Discord Web built on **Electron 45** (`WebContentsView`). Run multiple Discord accounts side-by-side with strict per-partition session isolation, end-to-end per-account proxy & WebRTC leak protection, bundled offline themes, dual split-view, and power-user audio utilities.

---

## 📥 Installation & Download

### Option 1: 1-Click Windows Installer (Recommended)
1. Head over to the **[Latest Release](https://github.com/NextGenInfluencer/discord-multispace/releases/latest)** page.
2. Download **`Discord-MultiSpace-Setup-2.0.0.exe`** (or the latest release).
3. Double-click the downloaded `.exe` file. The installer will:
   - Install Discord MultiSpace to your user applications folder.
   - Create a **Desktop shortcut** (`Discord MultiSpace.lnk`) and **Start Menu** entry.
   - Launch the application automatically.
   - **Controlled In-App Updates:** Future GitHub releases are detected automatically with an explicit **Download Update** & **Install & Restart** prompt — updates are never installed silently without your confirmation.

> **Note on Windows SmartScreen:** As an independent open-source application without a commercial EV code-signing certificate, Windows SmartScreen may display an *"Unrecognized app"* prompt. Click **More info** &rarr; **Run anyway** to proceed if you downloaded the installer from the official GitHub Releases page.

---

### Option 2: 1-Click Source Setup (`setup.bat`)
If you cloned the repository or downloaded a source archive:
1. Double-click **`setup.bat`** in the project root.
2. It verifies `npm install`, creates your Desktop shortcut, and launches Discord MultiSpace.

---

### Option 3: Manual Developer Setup
```bash
# Clone the repository
git clone https://github.com/NextGenInfluencer/discord-multispace.git
cd discord-multispace

# Install dependencies (Electron 45.4.1)
npm install

# Run unit & Electron E2E test suites
npm test
npm run test:e2e

# Launch in development
npm start

# Build the Windows NSIS installer (.exe + .blockmap + latest.yml)
npm run build
```

---

## ✨ Key Features

- **🛡️ Modern `WebContentsView` Sandboxing:** Every account runs inside a dedicated, sandboxed `WebContentsView` (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) backed by an isolated `persist:discord_account_<id>` partition. Removing an account wipes stored cookies, tokens, and cache by default.
- **🔒 Leak-Free Per-Account Proxy Support:** Supports HTTP/HTTPS (including `user:pass@host:port` `407` proxy authentication) and local SOCKS4/SOCKS5 proxies. Proxy rules and `disable_non_proxied_udp` WebRTC IP protection are enforced *before* any connection opens, and live proxy edits immediately sever prior WebSockets.
- **⚡ Dual Split-View Workspace:** Work across two Discord accounts side-by-side in a single window with independent zoom and error recovery per pane.
- **🎨 Bundled Offline Presets & SSRF-Safe Theme Engine:** Includes locally bundled **Midnight Dark** (by refact0r), **Pitch Black AMOLED** (by dimden), **Clean Minimalist**, and **Default Discord** (with 100% unmodified Discord CSP), plus HTTPS community theme loading with private-IP SSRF protection.
- **🌿 True Background Memory & CPU Saver:** Enables Chromium background throttling and suspends GIF/CSS animations on idle background accounts (>15 min, when not in a voice call) **without** muting incoming DM notifications or voice call ringtones.
- **🎙️ WebRTC Voice, Video & Custom Audio Screen Sharing:** Built-in screen/application picker with live thumbnails, Windows system audio loopback, and exact-match virtual cable routing (e.g. `Voicemeeter Out B2`) that respects the **Share Audio** toggle and releases capture handles cleanly on stream stop.
- **📌 System Tray, Startup-to-Tray & Taskbar Mention Badges:** Minimizes to the Windows System Tray, supports starting minimized on Windows login (`--hidden`), and displays live unread mention counts on the taskbar icon.

---

## ⌨️ Keyboard Shortcuts

### In-App Shortcuts (Always Active When Focused)
| Shortcut | Action |
|---|---|
| `Ctrl + 1` .. `Ctrl + 9` | Switch directly to accounts 1–9 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Cycle forward / backward between open accounts |
| `Ctrl + +` / `Ctrl + -` / `Ctrl + 0` | Zoom in / Zoom out / Reset zoom on active pane |
| `F5` / `Ctrl + R` | Reload active Discord account session |
| `Ctrl + Shift + R` / `Shift + F5` | Reload the MultiSpace UI shell |

### Opt-In Global OS Shortcuts (Disabled by Default — Enable in Settings)
> Disabled by default so international `AltGr` characters (`AltGr+M`, `AltGr+D`) and IDE shortcuts (`Ctrl+Shift+H`) are never intercepted unless you opt in under **Settings &rarr; Enable Global OS Shortcuts**.

| Shortcut | Action |
|---|---|
| `Ctrl + Alt + M` | Global Mute All accounts |
| `Ctrl + Alt + D` | Global Deafen All accounts |
| `Ctrl + Shift + H` | Emergency Boss Key (Hide to tray & mute / Restore audio on show) |

---

## 📂 Project Structure

```
discord-multispace/
├── main.js             # Electron 45 main process (WebContentsView manager, proxy, security, tray, updater)
├── preload.js          # Context-isolated IPC whitelist bridge
├── renderer.js         # Shell UI controller (accounts, split view, modals, snapshots, themes)
├── lib/
│   └── security.js     # Proxy validation, SSRF IPv4/IPv6 guard, CSP filter, bounds & device matching
├── assets/
│   ├── fonts/          # Locally bundled Inter WOFF2 typography
│   ├── themes/         # Locally bundled Midnight Dark & Pitch Black AMOLED stylesheets
│   └── icon.ico        # Multi-resolution Windows application icon
├── index.html          # Hardened shell layout, modals, and context menus
├── style.css           # Application theme and responsive layout styles
├── tests/              # Automated unit tests & Electron 45 E2E integration suite
└── package.json        # Build & dependency configuration
```

---

## ⚠️ Disclaimer (Trademarks & Discord Terms of Service)

- **Not Affiliated with Discord:** **Discord MultiSpace** is an independent, community-developed open-source web wrapper and is **not** affiliated with, endorsed by, sponsored by, or supported by **Discord Inc.** "Discord" is a registered trademark of Discord Inc.
- **Terms of Service Notice:** Discord MultiSpace loads the official Discord web client (`https://discord.com/app`) inside isolated Chromium sessions without modifying Discord's network protocol or automating user actions. However, injecting custom third-party CSS themes or client-side modifications may technically conflict with Discord's Terms of Service. Use custom themes and multi-account features responsibly and at your own discretion.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
