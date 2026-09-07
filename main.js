const { app, BrowserWindow, shell, session, Tray, Menu, nativeImage, ipcMain, globalShortcut, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

let tray = null;
let mainWindow = null;
let appState = {
  accountCount: 1,
  activeAccountName: 'Account 1',
  unreadCount: 0
};

// Map to track active screen share requests: requestId -> { callback, sources, request }
const pendingDisplayMediaRequests = new Map();

async function handleDisplayMediaRequest(request, callback) {
  try {
    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    log(`Handling display media request [${requestId}] from origin: ${request.securityOrigin || 'unknown'}`);

    // Fetch available screens and windows with preview thumbnails
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 360, height: 202 }
    });

    if (!sources || sources.length === 0) {
      log(`No display sources found for request [${requestId}]`);
      callback({});
      return;
    }

    // Cancel any previous pending requests cleanly
    for (const [oldId, oldReq] of pendingDisplayMediaRequests.entries()) {
      try {
        oldReq.callback({});
      } catch {}
      pendingDisplayMediaRequests.delete(oldId);
    }

    // Save pending request
    pendingDisplayMediaRequests.set(requestId, { callback, sources, request });

    // Filter out blank-titled windows and format sources for renderer
    const serializedSources = sources
      .filter((s) => {
        if (s.id.startsWith('screen:')) return true;
        if (!s.name || s.name.trim() === '') return false;
        return true;
      })
      .map((s) => {
        let thumb = '';
        let icon = '';
        try {
          if (s.thumbnail && !s.thumbnail.isEmpty()) {
            thumb = s.thumbnail.toDataURL();
          }
        } catch {}
        try {
          if (s.appIcon && !s.appIcon.isEmpty()) {
            icon = s.appIcon.toDataURL();
          }
        } catch {}
        return {
          id: s.id,
          name: s.name,
          thumbnail: thumb,
          appIcon: icon,
          display_id: s.display_id
        };
      });

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
      mainWindow.webContents.send('open-screen-picker', { requestId, sources: serializedSources });
    } else {
      callback({});
      pendingDisplayMediaRequests.delete(requestId);
    }
  } catch (err) {
    log(`Display media request handler error: ${err.stack || err}`);
    try {
      callback({});
    } catch {}
  }
}

// Log file is written to userData dir so it works in ASAR-packed production builds
let logFile;
try {
  logFile = path.join(app.getPath('userData'), 'app.log');
} catch {
  logFile = path.join(__dirname, 'app.log');
}
function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

log(`\n--- App Starting --- PID: ${process.pid}`);
log(`argv: ${JSON.stringify(process.argv)}`);
log(`cwd: ${process.cwd()}`);

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

// Derive a clean Chrome user agent from Electron's default, stripping the Electron/ token
function buildChromeUserAgent() {
  const base = app.userAgentFallback || '';
  return base.replace(/\s*Electron\/\S+/i, '').replace(/\s{2,}/g, ' ').trim();
}
const CHROME_USER_AGENT = buildChromeUserAgent();
app.userAgentFallback = CHROME_USER_AGENT;

// Chromium Audio, Hardware & WebRTC Optimization Switches
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * Configure permissions, screen sharing, and headers for a given session.
 * Ensures microphone/camera/screen sharing access works for Discord voice/video calls.
 */
function setupSession(targetSession) {
  if (!targetSession || targetSession._isConfiguredForDiscord) return;
  targetSession._isConfiguredForDiscord = true;

  targetSession.setUserAgent(CHROME_USER_AGENT);

  if (typeof targetSession.setSpellCheckerLanguages === 'function') {
    try {
      targetSession.setSpellCheckerLanguages(['en-US']);
    } catch (err) {
      log(`Failed to set spell checker languages: ${err}`);
    }
  }

  // Relax CSP headers on Discord pages to allow community themes & external fonts/stylesheets
  if (targetSession.webRequest && typeof targetSession.webRequest.onHeadersReceived === 'function') {
    try {
      targetSession.webRequest.onHeadersReceived(
        { urls: ['https://discord.com/*', 'https://*.discord.com/*', 'https://*.discordapp.com/*'] },
        (details, callback) => {
          const responseHeaders = Object.assign({}, details.responseHeaders);
          for (const headerKey of Object.keys(responseHeaders)) {
            const lower = headerKey.toLowerCase();
            if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
              responseHeaders[headerKey] = responseHeaders[headerKey].map((csp) => {
                return csp
                  .replace(/style-src\s+([^;]+)/gi, "style-src * 'unsafe-inline' blob: data:")
                  .replace(/font-src\s+([^;]+)/gi, "font-src * blob: data:")
                  .replace(/img-src\s+([^;]+)/gi, "img-src * blob: data:")
                  .replace(/connect-src\s+([^;]+)/gi, "connect-src * blob: data:");
              });
            }
          }
          callback({ responseHeaders });
        }
      );
    } catch (err) {
      log(`Failed to attach onHeadersReceived on session: ${err}`);
    }
  }

  // WebRTC Screen & Game Sharing Engine — captures screens/windows with system audio loopback
  if (typeof targetSession.setDisplayMediaRequestHandler === 'function') {
    targetSession.setDisplayMediaRequestHandler((request, callback) => {
      handleDisplayMediaRequest(request, callback);
    });
  }

  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = [
      'media',
      'mediaKeySystem',
      'audioCapture',
      'videoCapture',
      'notifications',
      'microphone',
      'camera',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture'
    ];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  targetSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = [
      'media',
      'mediaKeySystem',
      'audioCapture',
      'videoCapture',
      'notifications',
      'microphone',
      'camera',
      'display-capture'
    ];
    return allowedPermissions.includes(permission);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    center: true,
    backgroundColor: '#1e1f22',
    show: true,
    autoHideMenuBar: true,
    title: 'Discord MultiSpace',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      spellcheck: true
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    log(`[RENDERER] (${line}) ${message}`);
  });

  // Configure default session
  setupSession(session.defaultSession);

  // Configure newly created sessions (custom partitions)
  app.on('session-created', (newSession) => {
    setupSession(newSession);
  });

  // Handle all web-contents (including webviews)
  app.on('web-contents-created', (event, contents) => {
    if (contents.session) {
      setupSession(contents.session);
    }

    // Intercept window.open popups & OAuth flows to open safely in external browser
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Native spellcheck & text editing context menu
    contents.on('context-menu', (event, params) => {
      const hasSuggestions = params.dictionarySuggestions && params.dictionarySuggestions.length > 0;
      const isEditable = params.isEditable;
      const hasSelection = params.selectionText && params.selectionText.trim().length > 0;

      // Only show menu if there are spelling suggestions, editable input, or selected text
      if (!hasSuggestions && !isEditable && !hasSelection) {
        return;
      }

      const menuTemplate = [];

      // Spelling suggestions
      if (hasSuggestions) {
        params.dictionarySuggestions.forEach((suggestion) => {
          menuTemplate.push({
            label: suggestion,
            click: () => contents.replaceMisspelling(suggestion)
          });
        });
        if (params.misspelledWord) {
          menuTemplate.push({
            label: `Add "${params.misspelledWord}" to Dictionary`,
            click: () => {
              try {
                contents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
              } catch {}
            }
          });
        }
        menuTemplate.push({ type: 'separator' });
      }

      // Text editing actions
      if (isEditable) {
        menuTemplate.push(
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        );
      } else if (hasSelection) {
        menuTemplate.push(
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        );
      }

      if (menuTemplate.length > 0) {
        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup({ window: mainWindow });
      }
    });

    // Handle guest keyboard shortcuts (App reload, Zoom in/out/reset)
    contents.on('before-input-event', (inputEvent, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta)) {
        if (input.shift && input.key.toLowerCase() === 'r') {
          if (mainWindow) mainWindow.reload();
          return;
        }

        // Per-pane Zoom Controls
        if (input.key === '+' || input.key === '=' || input.key === 'Add') {
          if (mainWindow) {
            mainWindow.webContents.send('webview-zoom-action', { webContentsId: contents.id, action: 'in' });
          }
        } else if (input.key === '-' || input.key === 'Subtract') {
          if (mainWindow) {
            mainWindow.webContents.send('webview-zoom-action', { webContentsId: contents.id, action: 'out' });
          }
        } else if (input.key === '0' || input.key === 'NumPad0') {
          if (mainWindow) {
            mainWindow.webContents.send('webview-zoom-action', { webContentsId: contents.id, action: 'reset' });
          }
        }
      }
    });

    // If webview attempts to navigate to external websites or local dropped files, handle safely
    contents.on('will-navigate', (navEvent, navigationUrl) => {
      // Prevent local file drops from replacing the Discord page
      if (navigationUrl.startsWith('file://') && !navigationUrl.includes('index.html')) {
        navEvent.preventDefault();
        return;
      }

      try {
        const parsedUrl = new URL(navigationUrl);
        const allowedHosts = [
          'discord.com',
          'discordapp.com',
          'discord.gg',
          'cdn.discordapp.com',
          'gateway.discord.gg',
          'status.discord.com'
        ];
        const isDiscordHost = allowedHosts.some(
          (host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
        );

        if (!isDiscordHost && (navigationUrl.startsWith('http://') || navigationUrl.startsWith('https://'))) {
          navEvent.preventDefault();
          shell.openExternal(navigationUrl);
        }
      } catch (err) {
        // Invalid URL, ignore
      }
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html')).then(() => {
    log('mainWindow.loadFile completed');
  }).catch((err) => {
    log(`Failed to load index.html: ${err}`);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'r') {
      mainWindow.reload();
    }
  });

  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();
  log('mainWindow created, centered, and focused');

  // Minimize to tray on close unless quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('show', () => {
    updateTrayMenu();
  });

  mainWindow.on('hide', () => {
    updateTrayMenu();
  });
}

/**
 * System Tray Management
 */
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.svg'));
    }
    icon = icon.resize({ width: 20, height: 20 });

    tray = new Tray(icon);
    updateTrayMenu();

    tray.on('click', () => {
      toggleWindow();
    });

    tray.on('double-click', () => {
      toggleWindow();
    });

    log('System tray initialized successfully');
  } catch (err) {
    log(`Failed to create system tray: ${err.stack || err}`);
  }
}

function updateTrayMenu() {
  if (!tray) return;

  const isWinVisible = mainWindow && mainWindow.isVisible();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Discord MultiSpace',
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: `● Active Account: ${appState.activeAccountName}`,
      enabled: false
    },
    {
      label: `📋 Accounts Configured: ${appState.accountCount}`,
      enabled: false
    },
    ...(appState.unreadCount > 0 ? [
      {
        label: `🔔 Unread Mentions / Messages: ${appState.unreadCount}`,
        enabled: false
      }
    ] : []),
    {
      type: 'separator'
    },
    {
      label: isWinVisible ? 'Hide Window' : 'Open Discord MultiSpace',
      click: () => {
        toggleWindow();
      }
    },
    {
      label: 'Reload Active Session',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-reload-session');
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit Discord MultiSpace',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  const unreadHint = appState.unreadCount > 0 ? `\nUnread: ${appState.unreadCount}` : '';
  tray.setToolTip(`Discord MultiSpace\nActive: ${appState.activeAccountName}\nAccounts: ${appState.accountCount}${unreadHint}`);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  updateTrayMenu();
}

// IPC listener for renderer status updates
ipcMain.on('update-tray-status', (event, state) => {
  if (state.accountCount !== undefined) appState.accountCount = state.accountCount;
  if (state.activeAccountName !== undefined) appState.activeAccountName = state.activeAccountName;
  if (state.unreadCount !== undefined) {
    appState.unreadCount = state.unreadCount;
    if (app.setBadgeCount) {
      try {
        app.setBadgeCount(state.unreadCount);
      } catch {}
    }
  }
  updateTrayMenu();
});

// IPC listener to reload the application window
ipcMain.on('app-reload-window', () => {
  if (mainWindow) {
    mainWindow.reload();
  }
});

// IPC listener to update the window title
ipcMain.on('update-title', (event, title) => {
  if (mainWindow && title) {
    mainWindow.setTitle(title);
  }
});

// IPC listener to dynamically configure proxy for an account partition
ipcMain.on('set-account-proxy', async (event, { partition, proxyRules }) => {
  try {
    if (!partition || typeof partition !== 'string' || !partition.startsWith('persist:discord_account_')) return;
    const targetSession = session.fromPartition(partition);
    const rules = (proxyRules || '').trim();
    await targetSession.setProxy({ proxyRules: rules });
    log(`Proxy configured for partition [${partition}]: ${rules || 'DIRECT'}`);
  } catch (err) {
    log(`Failed to set proxy for [${partition}]: ${err}`);
  }
});

// IPC listener to update taskbar overlay icon with unread badge
ipcMain.on('update-taskbar-overlay', (event, { count, dataUrl }) => {
  if (!mainWindow) return;
  try {
    if (count > 0 && dataUrl) {
      const img = nativeImage.createFromDataURL(dataUrl);
      mainWindow.setOverlayIcon(img, `${count} unread mention${count > 1 ? 's' : ''}`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } catch (err) {
    log(`Failed to update taskbar overlay icon: ${err}`);
  }
});

// IPC handlers for Windows Startup item
ipcMain.handle('get-startup-setting', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

// IPC handler for fetching remote theme CSS (bypasses CORS/CSP safely for community themes)
ipcMain.handle('fetch-theme-css', async (event, url) => {
  if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
    return { success: false, error: 'Invalid URL' };
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': CHROME_USER_AGENT
      }
    });
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    const css = await res.text();
    return { success: true, css };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.on('set-startup-setting', (event, openAtLogin) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(openAtLogin),
      openAsHidden: true
    });
    log(`Launch on startup updated: ${openAtLogin}`);
  } catch (err) {
    log(`Failed to set startup setting: ${err}`);
  }
});

// IPC listener to clear cache for an account partition
ipcMain.on('clear-account-cache', async (event, { partition, accountName }) => {
  try {
    if (!partition || typeof partition !== 'string' || !partition.startsWith('persist:discord_account_')) return;
    const targetSession = session.fromPartition(partition);
    await targetSession.clearCache();
    log(`Cache cleared successfully for partition [${partition}] (${accountName || 'Account'})`);
  } catch (err) {
    log(`Failed to clear cache for partition [${partition}]: ${err.message || err}`);
  }
});

// IPC handler for opening external URLs (protocol-validated in preload, double-checked here)
ipcMain.on('open-external-url', (event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

// IPC listener for screen picker source selection
ipcMain.on('screen-picker-select', (event, { requestId, sourceId, withAudio }) => {
  const pending = pendingDisplayMediaRequests.get(requestId);
  if (!pending) {
    log(`screen-picker-select: no pending request found for [${requestId}]`);
    return;
  }
  pendingDisplayMediaRequests.delete(requestId);

  const selectedSource = pending.sources.find((s) => s.id === sourceId);
  if (selectedSource) {
    log(`Screen share confirmed: source [${selectedSource.id}] "${selectedSource.name}", withAudio: ${Boolean(withAudio)}`);
    try {
      pending.callback({
        video: selectedSource,
        audio: withAudio ? 'loopback' : undefined
      });
    } catch (err) {
      log(`Error calling display media callback: ${err.stack || err}`);
      try {
        pending.callback({});
      } catch {}
    }
  } else {
    log(`Selected source [${sourceId}] not found in available sources`);
    try {
      pending.callback({});
    } catch {}
  }
});

// IPC listener for screen picker cancellation
ipcMain.on('screen-picker-cancel', (event, { requestId }) => {
  const pending = pendingDisplayMediaRequests.get(requestId);
  if (pending) {
    pendingDisplayMediaRequests.delete(requestId);
    log(`Screen share cancelled by user for request [${requestId}]`);
    try {
      pending.callback({});
    } catch (err) {
      log(`Error cancelling display media callback: ${err}`);
    }
  }
});

/**
 * Emergency Privacy "Boss Key" Handler
 * If visible: mutes all webview audio and immediately hides window to system tray.
 * If hidden: restores window, brings it to foreground, focuses, and restores audio.
 */
function handleBossKey() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.webContents.send('boss-key-mute-all');
    mainWindow.hide();
    updateTrayMenu();
    log('Emergency Boss Key triggered: window hidden to tray & audio muted');
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('boss-key-unmute-all');
    updateTrayMenu();
    log('Emergency Boss Key triggered: window restored & audio unmuted');
  }
}

// Single application instance lock
const gotTheLock = app.requestSingleInstanceLock();
log(`gotTheLock: ${gotTheLock}`);
if (!gotTheLock) {
  log('Could not obtain single instance lock. Quitting immediately.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance event received: restoring and focusing primary window');
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const win = windows[0];
        if (!win.isVisible()) win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
  });

  app.whenReady().then(() => {
    log('app.whenReady fired');
    createWindow();
    createTray();

    // Register Global Shortcuts:
    // Ctrl+Alt+M (Mute), Ctrl+Alt+D (Deafen), Ctrl+Shift+H (Emergency Boss Key)
    try {
      globalShortcut.register('CommandOrControl+Alt+M', () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-global-mute-all');
        }
      });
      globalShortcut.register('CommandOrControl+Alt+D', () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-global-deafen-all');
        }
      });
      globalShortcut.register('CommandOrControl+Shift+H', () => {
        handleBossKey();
      });
      log('Global shortcuts registered: Ctrl+Alt+M (Mute), Ctrl+Alt+D (Deafen), Ctrl+Shift+H (Boss Key)');
    } catch (err) {
      log(`Failed to register global shortcuts: ${err}`);
    }

    app.on('activate', () => {
      log('app activate fired');
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow) {
        mainWindow.show();
      }
    });
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
    log('Global shortcuts unregistered cleanly on will-quit');
  } catch (err) {
    log(`Error unregistering shortcuts on will-quit: ${err}`);
  }
});

app.on('window-all-closed', () => {
  log('window-all-closed fired');
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit();
  }
});
