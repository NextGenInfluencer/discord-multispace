const {
  app,
  BrowserWindow,
  WebContentsView,
  shell,
  session,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  globalShortcut,
  desktopCapturer
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const {
  isValidAccountId,
  isValidPartition,
  partitionForAccountId,
  redactSensitiveUrl,
  parseAndValidateProxy,
  safeFetchThemeCss,
  resolveThemeCssImports,
  transformDiscordCspHeader,
  isTrustedDiscordOrigin,
  classifyNavigationUrl,
  classifyPopupRequest,
  matchAudioInputDevice,
  computePaneBounds,
  parseDiscordTitleUnread
} = require('./lib/security');

app.setName('Discord MultiSpace');

const IS_TEST_MODE = process.env.MULTISPACE_TEST_MODE === '1' && !app.isPackaged;
if (IS_TEST_MODE && process.env.MULTISPACE_TEST_USER_DATA) {
  app.setPath('userData', process.env.MULTISPACE_TEST_USER_DATA);
}
const DISCORD_APP_URL = (IS_TEST_MODE && process.env.MULTISPACE_TEST_DISCORD_URL)
  ? process.env.MULTISPACE_TEST_DISCORD_URL
  : 'https://discord.com/app';
const START_HIDDEN = process.argv.includes('--hidden');

let tray = null;
let mainWindow = null;
let hudView = null;
let hudHideTimer = null;
let hudCurrentKind = null;

const appState = {
  accountCount: 1,
  activeAccountName: 'Account 1',
  unreadCount: 0
};

// Persistent main-process preferences (stored in userData/settings.json)
let mainSettings = {
  globalShortcutsEnabled: false,
  streamAudioDeviceLabel: 'loopback'
};

// Account WebContentsViews: accountId -> entry
const accountViews = new Map();

// Session -> { username, password, recentAttempts: Map<string, { count, lastTs }> } for HTTP 407 proxy auth
const proxyAuthStateBySession = new WeakMap();

// Layout & overlay state synced from renderer
const layoutState = {
  activeAccountId: null,
  isSplitView: false,
  splitPrimaryId: null,
  splitSecondaryId: null,
  containerRect: { x: 72, y: 0, width: 1208, height: 800 },
  overlayBlocked: false
};
let overlayBlockSeq = 0;

// Theme state
let isCustomThemeActive = false;
let currentResolvedThemeCss = '';

// Boss key & global audio state
let isBossKeyMuted = false;
const audioMuteStateBeforeBossKey = new Map();
const childAudioMuteStateBeforeBossKey = new WeakMap();
const childWindowsHiddenByBossKey = new Set();
let globalMutedState = false;
let globalDeafenedState = false;

// Screen share state
const pendingDisplayMediaRequests = new Map();
let lastConfirmedDisplayMedia = null;
let lastConfirmedTimestamp = 0;

// Updater state
let lastUpdateCheckManual = false;

// ============================================================================
// Non-Blocking Async Rotating Logger
// ============================================================================
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB
let logFile;
try {
  logFile = path.join(app.getPath('userData'), 'app.log');
} catch {
  logFile = path.join(__dirname, 'app.log');
}

let logQueue = Promise.resolve();
let logBytesApprox = 0;
try {
  if (fs.existsSync(logFile)) {
    logBytesApprox = fs.statSync(logFile).size;
  }
} catch {}

function log(msg) {
  const safeMsg = redactSensitiveUrl(String(msg));
  const line = `[${new Date().toISOString()}] ${safeMsg}\n`;
  logQueue = logQueue
    .then(async () => {
      try {
        if (logBytesApprox > MAX_LOG_BYTES) {
          try {
            await fs.promises.rename(logFile, `${logFile}.1`);
          } catch {}
          logBytesApprox = 0;
        }
        await fs.promises.appendFile(logFile, line, 'utf8');
        logBytesApprox += Buffer.byteLength(line, 'utf8');
      } catch {}
    })
    .catch(() => {});
}

log(`\n--- App Starting --- PID: ${process.pid}`);
log(`argv: ${JSON.stringify(process.argv.map((a) => redactSensitiveUrl(a)))}`);

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${(err && err.stack) || err}`);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

// ============================================================================
// Main Settings Persistence
// ============================================================================
function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadMainSettings() {
  try {
    const file = getSettingsFilePath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        mainSettings = {
          globalShortcutsEnabled: Boolean(parsed.globalShortcutsEnabled),
          streamAudioDeviceLabel: typeof parsed.streamAudioDeviceLabel === 'string' && parsed.streamAudioDeviceLabel
            ? parsed.streamAudioDeviceLabel
            : 'loopback'
        };
      }
    }
  } catch (err) {
    log(`Failed to read settings.json: ${err}`);
  }
}

async function saveMainSettings() {
  try {
    await fs.promises.writeFile(getSettingsFilePath(), JSON.stringify(mainSettings, null, 2), 'utf8');
  } catch (err) {
    log(`Failed to save settings.json: ${err}`);
  }
}

// ============================================================================
// User-Agent & Chromium Switches
// ============================================================================
function buildChromeUserAgent() {
  const base = app.userAgentFallback || '';
  return base.replace(/\s*Electron\/\S+/i, '').replace(/\s{2,}/g, ' ').trim();
}
const CHROME_USER_AGENT = buildChromeUserAgent();
app.userAgentFallback = CHROME_USER_AGENT;

// Safe Chromium switches (SharedArrayBuffer intentionally NOT enabled globally)
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ============================================================================
// IPC Sender Validation
// ============================================================================
function isTrustedSender(event) {
  return Boolean(
    event &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ============================================================================
// Screen-Share Display Media Request Handler
// ============================================================================
async function handleDisplayMediaRequest(request, callback) {
  try {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    log(`Handling display media request [${requestId}] from origin: ${request.securityOrigin || 'unknown'}`);

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 360, height: 202 }
    });

    if (!sources || sources.length === 0) {
      callback({});
      return;
    }

    // Deduplicate Discord's rapid secondary getDisplayMedia probe within 2s —
    // NEVER fall back to sources[0] (primary monitor) if the chosen window closed!
    const now = Date.now();
    if (lastConfirmedDisplayMedia && (now - lastConfirmedTimestamp) < 2000) {
      const matchingSource = sources.find((s) => s.id === lastConfirmedDisplayMedia.sourceId);
      if (matchingSource) {
        log(`Auto-fulfilling secondary display media request [${requestId}] with confirmed source [${matchingSource.id}]`);
        callback({
          video: matchingSource,
          audio: lastConfirmedDisplayMedia.withAudio ? 'loopback' : undefined
        });
        return;
      }
      // Selected window disappeared; invalidate cache and abort rather than leaking full screen
      lastConfirmedDisplayMedia = null;
      lastConfirmedTimestamp = 0;
      callback({});
      return;
    }

    for (const [oldId, oldReq] of pendingDisplayMediaRequests.entries()) {
      try {
        oldReq.callback({});
      } catch {}
      pendingDisplayMediaRequests.delete(oldId);
    }

    pendingDisplayMediaRequests.set(requestId, { callback, sources, request });

    const serializedSources = sources
      .filter((s) => s.id.startsWith('screen:') || (s.name && s.name.trim() !== ''))
      .map((s) => {
        let thumb = '';
        let icon = '';
        try {
          if (s.thumbnail && !s.thumbnail.isEmpty()) thumb = s.thumbnail.toDataURL();
        } catch {}
        try {
          if (s.appIcon && !s.appIcon.isEmpty()) icon = s.appIcon.toDataURL();
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
      sendToRenderer('open-screen-picker', { requestId, sources: serializedSources });
    } else {
      callback({});
      pendingDisplayMediaRequests.delete(requestId);
    }
  } catch (err) {
    log(`Display media request handler error: ${(err && err.stack) || err}`);
    try {
      callback({});
    } catch {}
  }
}

// ============================================================================
// Session Security, CSP & Permission Configuration
// ============================================================================
const DISCORD_ALLOWED_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'audioCapture',
  'videoCapture',
  'notifications',
  'microphone',
  'camera',
  'clipboard-sanitized-write',
  'display-capture',
  'speaker-selection',
  'fullscreen'
]);

const SHELL_ALLOWED_PERMISSIONS = new Set([
  'media',
  'audioCapture'
]);

function checkOriginPermission(wc, permission, requestingUrl) {
  // Never auto-grant clipboard-read to any frame
  if (permission === 'clipboard-read' || permission === 'deprecated-sync-clipboard-read') {
    return false;
  }

  // Allow shell index.html to enumerate audio input labels for Settings / Screen Picker
  if (mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) {
    const url = requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : '');
    if (url.startsWith('file://')) {
      return SHELL_ALLOWED_PERMISSIONS.has(permission);
    }
    return false;
  }

  const candidateUrl = requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : '');
  if (IS_TEST_MODE && candidateUrl && candidateUrl.startsWith(DISCORD_APP_URL.split('/app')[0])) {
    return DISCORD_ALLOWED_PERMISSIONS.has(permission);
  }

  if (!isTrustedDiscordOrigin(candidateUrl)) {
    return false;
  }

  return DISCORD_ALLOWED_PERMISSIONS.has(permission);
}

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

  // Conditional CSP relaxation: 100% untouched on Default/Minimalist, never modifies connect-src
  if (targetSession.webRequest && typeof targetSession.webRequest.onHeadersReceived === 'function') {
    try {
      targetSession.webRequest.onHeadersReceived(
        { urls: ['https://discord.com/*', 'https://*.discord.com/*', 'https://*.discordapp.com/*'] },
        (details, callback) => {
          if (!isCustomThemeActive || !details.responseHeaders) {
            callback({ responseHeaders: details.responseHeaders });
            return;
          }
          const responseHeaders = Object.assign({}, details.responseHeaders);
          for (const headerKey of Object.keys(responseHeaders)) {
            const lower = headerKey.toLowerCase();
            if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
              responseHeaders[headerKey] = responseHeaders[headerKey].map((csp) =>
                transformDiscordCspHeader(csp, true)
              );
            }
          }
          callback({ responseHeaders });
        }
      );
    } catch (err) {
      log(`Failed to attach onHeadersReceived on session: ${err}`);
    }

    // Clear per-session 407 failure counters whenever a proxied request succeeds (non-407)
    if (typeof targetSession.webRequest.onResponseStarted === 'function') {
      try {
        targetSession.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
          if (details && details.statusCode !== 407) {
            const authState = proxyAuthStateBySession.get(targetSession);
            if (authState && authState.recentAttempts.size > 0) {
              authState.recentAttempts.clear();
            }
          }
        });
      } catch {}
    }
  }

  if (typeof targetSession.setDisplayMediaRequestHandler === 'function') {
    targetSession.setDisplayMediaRequestHandler((request, callback) => {
      handleDisplayMediaRequest(request, callback);
    });
  }

  targetSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const reqUrl = (details && details.requestingUrl) || '';
    callback(checkOriginPermission(wc, permission, reqUrl));
  });

  targetSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const reqUrl = (details && details.requestingUrl) || requestingOrigin || '';
    return checkOriginPermission(wc, permission, reqUrl);
  });
}

// Register top-level app lifecycle listeners ONCE (never inside createWindow)
app.on('session-created', (newSession) => {
  setupSession(newSession);
});

// HTTP 407 Proxy Authentication Handler (Per-Session Scoped & Auto-Resetting on Success)
app.on('login', (event, wc, authenticationResponseDetails, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy || !wc || wc.isDestroyed() || !wc.session) {
    return;
  }

  const authState = proxyAuthStateBySession.get(wc.session);
  if (!authState) {
    return;
  }

  const now = Date.now();
  const key = `${authInfo.host}:${authInfo.port}:${(authenticationResponseDetails && authenticationResponseDetails.url) || ''}`;
  const prev = authState.recentAttempts.get(key);
  const attempts = (!prev || (now - prev.lastTs) > 4000) ? 1 : prev.count + 1;

  if (authState.recentAttempts.size > 250) {
    authState.recentAttempts.clear();
  }
  authState.recentAttempts.set(key, { count: attempts, lastTs: now });

  if (attempts > 2) {
    log(`Proxy authentication failed after ${attempts - 1} rapid attempts for ${authInfo.host}:${authInfo.port}`);
    authState.recentAttempts.delete(key);
    callback();
    return;
  }

  event.preventDefault();
  callback(authState.username, authState.password);
});

app.on('web-contents-created', (_event, contents) => {
  if (contents.session) {
    setupSession(contents.session);
  }

  // Block any legacy <webview> attachment completely
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

// ============================================================================
// Screen-Share Custom Audio Patch (Injected into Discord Account Views)
// ============================================================================
const DISCORD_MEDIA_AUDIO_PATCH = `
(() => {
  try {
    if (window.__discordMultiSpaceAudioPatched) return;
    window.__discordMultiSpaceAudioPatched = true;
    if (typeof window.__discordMultiSpaceShareAudio !== 'boolean') {
      window.__discordMultiSpaceShareAudio = true;
    }

    const matchAudioInputDevice = ${matchAudioInputDevice.toString()};

    if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
      const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async function(constraints) {
        const safe = (typeof constraints === 'object' && constraints !== null)
          ? Object.assign({}, constraints)
          : { video: true };

        if (!safe.audio || typeof safe.audio !== 'object') {
          safe.audio = {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
            systemAudio: 'include'
          };
        } else {
          safe.audio = Object.assign({}, safe.audio, {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
            systemAudio: 'include'
          });
        }

        const stream = await originalGetDisplayMedia(safe);

        // Respect unchecked "Share Audio" — never capture custom mic/cable if user unchecked audio!
        if (window.__discordMultiSpaceShareAudio === false) {
          stream.getAudioTracks().forEach((t) => {
            try {
              stream.removeTrack(t);
              t.stop();
            } catch {}
          });
          return stream;
        }

        const targetLabel = (window.__discordMultiSpaceAudioDeviceLabel || 'loopback').trim();
        if (targetLabel && targetLabel !== 'loopback' && navigator.mediaDevices.getUserMedia) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const matched = matchAudioInputDevice(devices, targetLabel);

            if (matched && matched.deviceId) {
              const customStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  deviceId: { exact: matched.deviceId },
                  autoGainControl: false,
                  echoCancellation: false,
                  noiseSuppression: false,
                  channelCount: 2
                }
              });
              const customTrack = customStream.getAudioTracks()[0];
              if (customTrack) {
                customTrack.enabled = true;
                if ('contentHint' in customTrack) {
                  try { customTrack.contentHint = 'music'; } catch {}
                }
                stream.getAudioTracks().forEach((t) => {
                  try {
                    stream.removeTrack(t);
                    t.stop();
                  } catch {}
                });
                stream.addTrack(customTrack);

                // Stop custom audio capture handle when video stream ends OR when Discord stops video track
                let cleanedUp = false;
                const stopCustomAudio = () => {
                  if (cleanedUp) return;
                  cleanedUp = true;
                  try { customTrack.stop(); } catch {}
                };
                const videoTrack = stream.getVideoTracks()[0];
                if (videoTrack) {
                  videoTrack.addEventListener('ended', stopCustomAudio, { once: true });
                  const origStop = videoTrack.stop.bind(videoTrack);
                  videoTrack.stop = function(...args) {
                    stopCustomAudio();
                    return origStop(...args);
                  };
                }
              }
            }
          } catch (err) {
            console.warn('[MultiSpace] Custom audio track injection failed, retaining default loopback:', err);
          }
        } else {
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true;
            if ('contentHint' in track) {
              try { track.contentHint = 'music'; } catch {}
            }
          });
        }

        return stream;
      };
    }
  } catch {}
})();
`;

function broadcastAudioDeviceLabelToViews(label) {
  mainSettings.streamAudioDeviceLabel = label || 'loopback';
  saveMainSettings();
  const payload = JSON.stringify(mainSettings.streamAudioDeviceLabel);
  for (const entry of accountViews.values()) {
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) {
      wc.executeJavaScript(`window.__discordMultiSpaceAudioDeviceLabel = ${payload};`).catch(() => {});
    }
    if (entry.childWindows) {
      for (const childWin of entry.childWindows) {
        if (childWin && !childWin.isDestroyed() && !childWin._isOAuthPopup && !childWin.webContents.isDestroyed()) {
          childWin.webContents.executeJavaScript(`window.__discordMultiSpaceAudioDeviceLabel = ${payload};`).catch(() => {});
        }
      }
    }
  }
}

// ============================================================================
// Proxy Session Configuration (Fail-Closed & Awaited Before Any Load)
// ============================================================================
async function configureAccountSessionProxy(accountId, rawProxy) {
  const partition = partitionForAccountId(accountId);
  const targetSession = session.fromPartition(partition);
  setupSession(targetSession);

  const parsed = parseAndValidateProxy(rawProxy);
  if (!parsed.valid) {
    // Fail-closed: bind invalid proxy to dead loopback port 1 so traffic NEVER leaks over DIRECT
    proxyAuthStateBySession.delete(targetSession);
    await targetSession.setProxy({
      proxyRules: 'http://127.0.0.1:1',
      proxyBypassRules: '<-loopback>'
    });
    await targetSession.closeAllConnections();
    log(`Blocked invalid proxy for [${partition}]: ${parsed.error}`);
    return { ok: false, hasProxy: true, error: parsed.error };
  }

  if (parsed.mode === 'direct') {
    proxyAuthStateBySession.delete(targetSession);
    await targetSession.setProxy({ proxyRules: '' });
    await targetSession.closeAllConnections();
    if (typeof targetSession.forceReloadProxyConfig === 'function') {
      await targetSession.forceReloadProxyConfig();
    }
    log(`Proxy cleared (DIRECT) for partition [${partition}]`);
    return { ok: true, hasProxy: false };
  }

  if (parsed.auth) {
    proxyAuthStateBySession.set(targetSession, {
      username: parsed.auth.username,
      password: parsed.auth.password,
      recentAttempts: new Map()
    });
  } else {
    proxyAuthStateBySession.delete(targetSession);
  }

  await targetSession.setProxy({
    proxyRules: parsed.proxyRules,
    proxyBypassRules: '<-loopback>'
  });
  await targetSession.closeAllConnections();
  if (typeof targetSession.forceReloadProxyConfig === 'function') {
    await targetSession.forceReloadProxyConfig();
  }
  log(`Proxy configured for partition [${partition}]: ${parsed.redacted}`);
  return { ok: true, hasProxy: true, redacted: parsed.redacted };
}

// ============================================================================
// Floating HUD View (Tooltips, Toasts, Zoom Pill Above Native WebContentsViews)
// ============================================================================
const HUD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
  }
  #root {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .hud-pill {
    display: inline-flex; align-items: center; gap: 8px;
    background: #111214;
    color: #f2f3f5;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px; font-weight: 600;
    box-shadow: 0 6px 18px rgba(0,0,0,0.55);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden; text-overflow: ellipsis;
  }
  .hud-shortcut {
    font-size: 11px; font-weight: 700;
    color: #949ba4;
    background: rgba(255,255,255,0.08);
    padding: 2px 6px; border-radius: 4px;
  }
  .dot-ok { width: 8px; height: 8px; border-radius: 50%; background: #23a55a; flex-shrink: 0; }
  .dot-err { width: 8px; height: 8px; border-radius: 50%; background: #f23f43; flex-shrink: 0; }
</style>
</head>
<body><div id="root"></div></body>
</html>`;

function focusActiveDiscordViewOrShell() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const focusId = layoutState.isSplitView ? layoutState.splitPrimaryId : layoutState.activeAccountId;
  const entry = focusId ? accountViews.get(focusId) : null;
  if (!layoutState.overlayBlocked && entry && !entry.hasError && entry.view.getVisible() && !entry.view.webContents.isDestroyed()) {
    try {
      entry.view.webContents.focus();
      return;
    } catch {}
  }
  if (!mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.focus();
    } catch {}
  }
}

function createHudView() {
  if (!mainWindow || mainWindow.isDestroyed() || hudView) return;
  hudView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  hudView.setBackgroundColor('#00000000');
  hudView.setVisible(false);
  hudView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  mainWindow.contentView.addChildView(hudView);
  hudView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HUD_HTML)}`).catch(() => {});

  // Never allow clicking a transient HUD pill to steal keyboard focus from Discord
  hudView.webContents.on('focus', () => {
    hideHudView();
    focusActiveDiscordViewOrShell();
  });
}

function hideHudView() {
  clearTimeout(hudHideTimer);
  hudHideTimer = null;
  hudCurrentKind = null;
  if (hudView && !hudView.webContents.isDestroyed()) {
    hudView.setVisible(false);
    hudView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

function showHudCard({ kind = 'pill', x, y, width, height, htmlPayload, autoHideMs = 0 }) {
  if (!hudView || hudView.webContents.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  if (layoutState.overlayBlocked) return;

  clearTimeout(hudHideTimer);
  hudCurrentKind = kind;
  // Ensure hudView is topmost child
  mainWindow.contentView.addChildView(hudView);
  hudView.setBounds({
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height))
  });
  hudView.setVisible(true);
  hudView.webContents.executeJavaScript(`
    (() => {
      const r = document.getElementById('root');
      if (r) r.innerHTML = ${JSON.stringify(htmlPayload)};
    })();
  `).catch(() => {});

  if (autoHideMs > 0) {
    hudHideTimer = setTimeout(() => {
      hideHudView();
    }, autoHideMs);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// WebContentsView Management, Theme Injection & Bounds Layout
// ============================================================================
async function applyThemeToEntry(entry) {
  if (!entry || !entry.view || entry.view.webContents.isDestroyed()) return;
  const wc = entry.view.webContents;
  try {
    if (entry.insertedCssKey) {
      await wc.removeInsertedCSS(entry.insertedCssKey).catch(() => {});
      entry.insertedCssKey = null;
    }
    if (currentResolvedThemeCss && currentResolvedThemeCss.trim()) {
      entry.insertedCssKey = await wc.insertCSS(currentResolvedThemeCss);
    }
  } catch {}
}

function attachContextMenu(wc) {
  wc.on('context-menu', (_event, params) => {
    const hasSuggestions = params.dictionarySuggestions && params.dictionarySuggestions.length > 0;
    const isEditable = params.isEditable;
    const hasSelection = params.selectionText && params.selectionText.trim().length > 0;

    if (!hasSuggestions && !isEditable && !hasSelection) return;

    const menuTemplate = [];
    if (hasSuggestions) {
      params.dictionarySuggestions.forEach((suggestion) => {
        menuTemplate.push({
          label: suggestion,
          click: () => wc.replaceMisspelling(suggestion)
        });
      });
      if (params.misspelledWord) {
        menuTemplate.push({
          label: `Add "${params.misspelledWord}" to Dictionary`,
          click: () => {
            try {
              wc.session.addWordToSpellCheckerDictionary(params.misspelledWord);
            } catch {}
          }
        });
      }
      menuTemplate.push({ type: 'separator' });
    }

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

    if (menuTemplate.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({ window: mainWindow });
    }
  });
}

function adjustEntryZoom(entry, delta, reset = false) {
  if (!entry || entry.view.webContents.isDestroyed()) return;
  const next = reset
    ? 1.0
    : Math.min(2.0, Math.max(0.5, Math.round((entry.zoomFactor + delta) * 10) / 10));
  entry.zoomFactor = next;
  try {
    entry.view.webContents.setZoomFactor(next);
  } catch {}
  sendToRenderer('view:zoom-changed', { accountId: entry.id, zoomFactor: next });
}

function attachNavigationAndShortcutHandlers(entry) {
  const wc = entry.view.webContents;

  // Keyboard shortcuts work seamlessly even when Discord WebContentsView has focus
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrlOrMeta = input.control || input.meta;

    // Reload App Shell: Ctrl+Shift+R or Shift+F5
    if (input.shift && (input.key === 'F5' || (ctrlOrMeta && input.key.toLowerCase() === 'r'))) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      return;
    }

    // Reload Active Discord View: F5 or Ctrl+R
    if (input.key === 'F5' || (ctrlOrMeta && !input.shift && !input.alt && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      reloadAccountView(entry.id, false);
      return;
    }

    // Switch Accounts: Ctrl+1..9
    if (ctrlOrMeta && !input.alt && !input.shift && input.key >= '1' && input.key <= '9') {
      event.preventDefault();
      sendToRenderer('shortcut:switch-account-index', parseInt(input.key, 10) - 1);
      return;
    }

    // Cycle Accounts: Ctrl+Tab / Ctrl+Shift+Tab
    if (ctrlOrMeta && !input.alt && input.key === 'Tab') {
      event.preventDefault();
      sendToRenderer('shortcut:cycle-account', { reverse: Boolean(input.shift) });
      return;
    }

    // Per-pane Zoom: Ctrl + / - / 0
    if (ctrlOrMeta && !input.alt) {
      if (input.key === '+' || input.key === '=' || input.key === 'Add') {
        event.preventDefault();
        adjustEntryZoom(entry, 0.1, false);
      } else if (input.key === '-' || input.key === '_' || input.key === 'Subtract') {
        event.preventDefault();
        adjustEntryZoom(entry, -0.1, false);
      } else if (input.key === '0' || input.key === 'NumPad0') {
        event.preventDefault();
        adjustEntryZoom(entry, 0, true);
      }
    }
  });

  const handleNavGuard = (details) => {
    if (details.isMainFrame === false) return;
    const targetUrl = details.url || '';
    if (IS_TEST_MODE && targetUrl.startsWith(DISCORD_APP_URL.split('/app')[0])) {
      return;
    }
    const decision = classifyNavigationUrl(targetUrl);
    if (!decision.allow) {
      details.preventDefault();
      if (decision.openExternal) {
        shell.openExternal(targetUrl).catch(() => {});
      }
    }
  };

  wc.on('will-navigate', handleNavGuard);
  wc.on('will-redirect', handleNavGuard);

  // Support Discord Voice/Stream Pop-Out windows (about:blank) and isolated OAuth2 popups
  wc.setWindowOpenHandler((details) => {
    const decision = classifyPopupRequest(details);
    if (decision.action === 'allow-popout') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 640,
          autoHideMenuBar: true,
          backgroundColor: '#1e1f22',
          webPreferences: {
            partition: entry.partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false
          }
        }
      };
    }
    if (decision.action === 'allow-oauth') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 540,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#1e1f22',
          webPreferences: {
            partition: entry.partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false
          }
        }
      };
    }
    if (decision.action === 'external' && decision.url) {
      shell.openExternal(decision.url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // Ensure any child window (popout / OAuth) inherits WebRTC IP protection, Boss Key / Deafen mute, and navigation/redirect guards
  wc.on('did-create-window', (childWin, createDetails) => {
    const isOAuth = classifyPopupRequest(createDetails).action === 'allow-oauth';
    childWin._isOAuthPopup = isOAuth;
    if (entry.childWindows) {
      entry.childWindows.add(childWin);
      childWin.on('closed', () => {
        entry.childWindows.delete(childWin);
        childWindowsHiddenByBossKey.delete(childWin);
      });
    }

    const childWc = childWin.webContents;
    childWc.setWebRTCIPHandlingPolicy(entry.hasProxy ? 'disable_non_proxied_udp' : 'default');
    if (isBossKeyMuted || globalDeafenedState) {
      childWc.setAudioMuted(true);
    }
    if (isBossKeyMuted && childWin.isVisible()) {
      childWindowsHiddenByBossKey.add(childWin);
      childWin.hide();
    }

    childWc.setWindowOpenHandler(({ url }) => {
      if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    const enforceChildNavGuard = (navDetails) => {
      if (navDetails.isMainFrame === false) return;
      const u = navDetails.url || '';
      if (isOAuth) {
        // OAuth flows redirect across HTTPS identity providers (Spotify, GitHub, etc.) back to discord.com
        if (IS_TEST_MODE && u.startsWith(DISCORD_APP_URL.split('/app')[0])) return;
        if (!u.startsWith('https://')) {
          navDetails.preventDefault();
        }
        return;
      }
      if (IS_TEST_MODE && u.startsWith(DISCORD_APP_URL.split('/app')[0])) return;
      const dec = classifyNavigationUrl(u);
      if (!dec.allow && u !== 'about:blank') {
        navDetails.preventDefault();
        if (dec.openExternal) shell.openExternal(u).catch(() => {});
      }
    };

    childWc.on('will-navigate', enforceChildNavGuard);
    childWc.on('will-redirect', enforceChildNavGuard);

    if (!isOAuth) {
      attachContextMenu(childWc);
      childWc.on('dom-ready', () => {
        if (childWc.isDestroyed()) return;
        childWc.executeJavaScript(DISCORD_MEDIA_AUDIO_PATCH).catch(() => {});
        childWc.executeJavaScript(
          `window.__discordMultiSpaceAudioDeviceLabel = ${JSON.stringify(mainSettings.streamAudioDeviceLabel)};`
        ).catch(() => {});
      });
    }
  });

  attachContextMenu(wc);
}

async function pollViewNotifications(entry) {
  if (!entry || entry.isHibernated || entry.view.webContents.isDestroyed()) return;
  const wc = entry.view.webContents;
  try {
    const title = wc.getTitle();
    const fromTitle = parseDiscordTitleUnread(title);
    if (fromTitle !== null) {
      entry.lastBadge = fromTitle;
      sendToRenderer('view:notification-updated', { accountId: entry.id, badge: fromTitle });
      return;
    }

    // Reachable DOM badge fallback when document.title does not encode unread counts
    const domRes = await wc.executeJavaScript(`
      (() => {
        try {
          const title = document.title || '';
          const m = title.match(/^\\(([^)]+)\\)/);
          if (m && m[1]) return m[1];
          if (title.includes('•') || title.startsWith('(*)')) return '•';

          const badges = document.querySelectorAll('[class*="numberBadge"], [class*="unreadMentionsIndicator"]');
          let total = 0;
          badges.forEach((b) => {
            const n = parseInt(b.textContent, 10);
            if (!Number.isNaN(n) && n > 0) total += n;
          });
          if (total > 0) return total > 99 ? '99+' : String(total);
          if (document.querySelector('[class*="unread_"]')) return '•';
          return 0;
        } catch {
          return 0;
        }
      })()
    `);

    if (typeof domRes === 'string' || typeof domRes === 'number') {
      const nextBadge = domRes || null;
      entry.lastBadge = nextBadge;
      sendToRenderer('view:notification-updated', { accountId: entry.id, badge: nextBadge });
    }
  } catch {}
}

setInterval(() => {
  for (const entry of accountViews.values()) {
    pollViewNotifications(entry);
  }
}, 10000);

async function ensureAccountView(account) {
  const accountId = account.id;
  if (!isValidAccountId(accountId)) {
    return { ok: false, error: 'Invalid account ID.' };
  }

  const normalizedProxyRaw = typeof account.proxy === 'string' ? account.proxy.trim() : '';
  let entry = accountViews.get(accountId);

  if (!entry || entry.view.webContents.isDestroyed()) {
    const proxyResult = await configureAccountSessionProxy(accountId, normalizedProxyRaw);
    const partition = partitionForAccountId(accountId);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        spellcheck: true,
        backgroundThrottling: true
      }
    });
    view.setBackgroundColor('#313338');
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy(proxyResult.hasProxy ? 'disable_non_proxied_udp' : 'default');

    const initialZoom = typeof account.zoom === 'number'
      ? Math.min(2.0, Math.max(0.5, account.zoom))
      : 1.0;

    entry = {
      id: accountId,
      partition,
      view,
      zoomFactor: initialZoom,
      hasError: false,
      lastErrorCode: null,
      lastErrorDescription: null,
      pendingMainLoadFailed: false,
      isLoading: false,
      lastBadge: null,
      insertedCssKey: null,
      hibernationCssKey: null,
      isHibernated: false,
      hasProxy: proxyResult.hasProxy,
      appliedProxyRaw: normalizedProxyRaw,
      childWindows: new Set()
    };
    accountViews.set(accountId, entry);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.addChildView(view);
    }

    const injectBridges = () => {
      if (wc.isDestroyed()) return;
      wc.executeJavaScript(DISCORD_MEDIA_AUDIO_PATCH).catch(() => {});
      wc.executeJavaScript(
        `window.__discordMultiSpaceAudioDeviceLabel = ${JSON.stringify(mainSettings.streamAudioDeviceLabel)};`
      ).catch(() => {});
    };

    wc.on('did-start-loading', () => {
      entry.isLoading = true;
      sendToRenderer('view:loading-state', { accountId, isLoading: true });
    });

    wc.on('did-stop-loading', () => {
      entry.isLoading = false;
      sendToRenderer('view:loading-state', { accountId, isLoading: false });
    });

    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && details.url && !details.url.startsWith('chrome-error:')) {
        entry.pendingMainLoadFailed = false;
      }
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      entry.isLoading = false;
      sendToRenderer('view:loading-state', { accountId, isLoading: false });
      if (errorCode !== -3 && isMainFrame !== false) {
        entry.pendingMainLoadFailed = true;
        entry.hasError = true;
        entry.lastErrorCode = errorCode;
        entry.lastErrorDescription = errorDescription || 'ERR_CONNECTION_FAILED';
        layoutViews();
        sendToRenderer('view:did-fail-load', { accountId, errorCode, errorDescription });
      }
    });

    wc.on('dom-ready', () => {
      const loadedUrl = wc.getURL() || '';
      if (entry.pendingMainLoadFailed || loadedUrl.startsWith('chrome-error:')) {
        return;
      }
      if (entry.hasError) {
        entry.hasError = false;
        entry.lastErrorCode = null;
        entry.lastErrorDescription = null;
        layoutViews();
        sendToRenderer('view:did-recover-load', { accountId });
      }
      try {
        wc.setZoomFactor(entry.zoomFactor);
      } catch {}
      applyThemeToEntry(entry);
      injectBridges();
      pollViewNotifications(entry);

      wc.executeJavaScript(`
        (() => {
          window.addEventListener('dragover', (e) => {
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
              e.dataTransfer.dropEffect = 'copy';
            }
          });
        })()
      `).catch(() => {});
    });

    wc.on('did-navigate', injectBridges);
    wc.on('did-navigate-in-page', injectBridges);

    wc.on('page-title-updated', (_event, title) => {
      const badge = parseDiscordTitleUnread(title);
      if (badge !== null) {
        entry.lastBadge = badge;
        sendToRenderer('view:notification-updated', { accountId, badge });
      } else {
        pollViewNotifications(entry);
      }
    });

    attachNavigationAndShortcutHandlers(entry);

    if (isBossKeyMuted || globalDeafenedState) {
      wc.setAudioMuted(true);
    }

    if (!proxyResult.ok) {
      entry.hasError = true;
      entry.lastErrorCode = 'ERR_INVALID_PROXY_CONFIG';
      entry.lastErrorDescription = proxyResult.error;
      layoutViews();
      sendToRenderer('view:did-fail-load', {
        accountId,
        errorCode: 'ERR_INVALID_PROXY_CONFIG',
        errorDescription: proxyResult.error
      });
      return proxyResult;
    }

    wc.loadURL(DISCORD_APP_URL).catch(() => {});
    return proxyResult;
  }

  // Existing live view: only reconfigure proxy / sever sockets if the proxy string actually changed!
  if (entry.appliedProxyRaw !== normalizedProxyRaw) {
    const proxyResult = await configureAccountSessionProxy(accountId, normalizedProxyRaw);
    entry.appliedProxyRaw = normalizedProxyRaw;
    entry.hasProxy = proxyResult.hasProxy;
    const policy = proxyResult.hasProxy ? 'disable_non_proxied_udp' : 'default';
    entry.view.webContents.setWebRTCIPHandlingPolicy(policy);
    if (entry.childWindows) {
      for (const childWin of entry.childWindows) {
        if (childWin && !childWin.isDestroyed() && !childWin.webContents.isDestroyed()) {
          childWin.webContents.setWebRTCIPHandlingPolicy(policy);
        }
      }
    }
    return proxyResult;
  }

  return {
    ok: entry.lastErrorCode !== 'ERR_INVALID_PROXY_CONFIG',
    hasProxy: entry.hasProxy,
    error: entry.lastErrorCode === 'ERR_INVALID_PROXY_CONFIG' ? entry.lastErrorDescription : undefined
  };
}

function wakeEntryIfHibernated(entry) {
  if (!entry || !entry.isHibernated || entry.view.webContents.isDestroyed()) return;
  entry.isHibernated = false;
  const wc = entry.view.webContents;
  try {
    if (typeof wc.setImageAnimationPolicy === 'function') {
      wc.setImageAnimationPolicy('animate');
    }
    if (entry.hibernationCssKey) {
      const key = entry.hibernationCssKey;
      entry.hibernationCssKey = null;
      wc.removeInsertedCSS(key).catch(() => {});
    }
  } catch {}
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const rect = layoutState.containerRect;
  const hasArea = rect && rect.width > 0 && rect.height > 0;
  const panes = computePaneBounds(rect, {
    isSplitView: layoutState.isSplitView,
    dividerPx: 2
  });

  const primaryId = layoutState.isSplitView ? layoutState.splitPrimaryId : layoutState.activeAccountId;
  const secondaryId = layoutState.isSplitView ? layoutState.splitSecondaryId : null;

  for (const [id, entry] of accountViews.entries()) {
    if (entry.view.webContents.isDestroyed()) continue;

    if (layoutState.overlayBlocked || !hasArea || entry.hasError) {
      entry.view.setVisible(false);
      continue;
    }

    if (id === primaryId && panes.primary) {
      wakeEntryIfHibernated(entry);
      entry.view.setBounds(panes.primary);
      entry.view.setVisible(true);
    } else if (layoutState.isSplitView && id === secondaryId && panes.secondary) {
      wakeEntryIfHibernated(entry);
      entry.view.setBounds(panes.secondary);
      entry.view.setVisible(true);
    } else {
      entry.view.setVisible(false);
    }
  }

  if (layoutState.overlayBlocked) {
    hideHudView();
  } else if (hudView && hudView.getVisible()) {
    mainWindow.contentView.addChildView(hudView);
  }
}

function reloadAccountView(accountId, ignoreCache = false) {
  const entry = accountViews.get(accountId);
  if (!entry || entry.view.webContents.isDestroyed()) return;
  entry.pendingMainLoadFailed = false;
  entry.hasError = false;
  entry.lastErrorCode = null;
  entry.lastErrorDescription = null;
  layoutViews();
  sendToRenderer('view:did-recover-load', { accountId });
  const wc = entry.view.webContents;
  const currentUrl = wc.getURL();
  if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome-error:')) {
    wc.loadURL(DISCORD_APP_URL).catch(() => {});
  } else if (ignoreCache) {
    wc.reloadIgnoringCache();
  } else {
    wc.reload();
  }
}

async function destroyAccountView(accountId, wipeSessionData = true) {
  const entry = accountViews.get(accountId);
  if (entry) {
    if (entry.childWindows) {
      for (const childWin of Array.from(entry.childWindows)) {
        try {
          childWindowsHiddenByBossKey.delete(childWin);
          if (childWin && !childWin.isDestroyed()) {
            childWin.destroy();
          }
        } catch {}
      }
      entry.childWindows.clear();
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(entry.view);
      }
    } catch {}
    try {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close();
      }
    } catch {}
    accountViews.delete(accountId);
  }
  audioMuteStateBeforeBossKey.delete(accountId);

  const partition = partitionForAccountId(accountId);
  const ses = session.fromPartition(partition);
  proxyAuthStateBySession.delete(ses);

  if (wipeSessionData) {
    try {
      await ses.closeAllConnections();
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      log(`Wiped session storage, cookies, and cache for removed account [${partition}]`);
    } catch (err) {
      log(`Failed to wipe session data for [${partition}]: ${err}`);
    }
  }
}

// ============================================================================
// Boss Key & Audio State Restoration (Includes Pop-Out Windows & Deafen Independence)
// ============================================================================
function restoreFromBossKeyIfNeeded() {
  if (!isBossKeyMuted) return;
  isBossKeyMuted = false;
  for (const [id, entry] of accountViews.entries()) {
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) {
      const prevIndependentMute = audioMuteStateBeforeBossKey.get(id);
      wc.setAudioMuted(Boolean(prevIndependentMute) || globalDeafenedState);
    }
    if (entry.childWindows) {
      for (const childWin of entry.childWindows) {
        if (childWin && !childWin.isDestroyed() && !childWin.webContents.isDestroyed()) {
          const prevChildMute = childAudioMuteStateBeforeBossKey.get(childWin);
          childWin.webContents.setAudioMuted(Boolean(prevChildMute) || globalDeafenedState);
        }
      }
    }
  }
  for (const childWin of Array.from(childWindowsHiddenByBossKey)) {
    if (childWin && !childWin.isDestroyed()) {
      try {
        childWin.showInactive();
      } catch {}
    }
  }
  childWindowsHiddenByBossKey.clear();
  audioMuteStateBeforeBossKey.clear();
  log('Boss Key audio & pop-out window state restored');
}

function handleBossKey() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    if (!isBossKeyMuted) {
      audioMuteStateBeforeBossKey.clear();
      childWindowsHiddenByBossKey.clear();
      for (const [id, entry] of accountViews.entries()) {
        const wc = entry.view.webContents;
        if (!wc.isDestroyed()) {
          audioMuteStateBeforeBossKey.set(id, wc.isAudioMuted() && !globalDeafenedState);
          wc.setAudioMuted(true);
        }
        if (entry.childWindows) {
          for (const childWin of entry.childWindows) {
            if (childWin && !childWin.isDestroyed()) {
              if (!childWin.webContents.isDestroyed()) {
                childAudioMuteStateBeforeBossKey.set(childWin, childWin.webContents.isAudioMuted() && !globalDeafenedState);
                childWin.webContents.setAudioMuted(true);
              }
              if (childWin.isVisible()) {
                childWindowsHiddenByBossKey.add(childWin);
                childWin.hide();
              }
            }
          }
        }
      }
      isBossKeyMuted = true;
    }
    mainWindow.hide();
    updateTrayMenu();
    log('Emergency Boss Key triggered: windows hidden to tray & audio muted');
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    restoreFromBossKeyIfNeeded();
    updateTrayMenu();
    log('Emergency Boss Key triggered: windows restored & audio unmuted');
  }
}

// ============================================================================
// Global OS Shortcuts (Disabled by Default — Opt-in via Settings)
// ============================================================================
function applyGlobalShortcutsSetting() {
  try {
    globalShortcut.unregisterAll();
  } catch {}

  if (!mainSettings.globalShortcutsEnabled) {
    log('Global OS shortcuts are disabled (opt-in setting is off)');
    return { enabled: false, registeredCount: 0 };
  }

  let registeredCount = 0;
  try {
    if (globalShortcut.register('CommandOrControl+Alt+M', () => sendToRenderer('trigger-global-mute-all'))) {
      registeredCount += 1;
    }
    if (globalShortcut.register('CommandOrControl+Alt+D', () => sendToRenderer('trigger-global-deafen-all'))) {
      registeredCount += 1;
    }
    if (globalShortcut.register('CommandOrControl+Shift+H', () => handleBossKey())) {
      registeredCount += 1;
    }
    log(`Global OS shortcuts enabled (${registeredCount}/3 registered)`);
  } catch (err) {
    log(`Failed to register global shortcuts: ${err}`);
  }
  return { enabled: true, registeredCount };
}

// ============================================================================
// Main BrowserWindow & System Tray
// ============================================================================
function resolveAppIconPath() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(icoPath)) return icoPath;
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(pngPath)) return pngPath;
  return path.join(__dirname, 'tray-icon.png');
}

function createWindow() {
  setupSession(session.defaultSession);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    center: true,
    backgroundColor: '#1e1f22',
    show: !START_HIDDEN && !IS_TEST_MODE,
    autoHideMenuBar: true,
    title: 'Discord MultiSpace',
    icon: resolveAppIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: false,
      spellcheck: false
    }
  });

  // Electron 45 console-message details object signature
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber }) => {
    log(`[RENDERER:${level || 'info'}] (${lineNumber || 0}) ${message}`);
  });

  // Shell index.html must never navigate or redirect to any external or local file URL
  mainWindow.webContents.on('will-navigate', (details) => {
    details.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (details) => {
    details.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.reload();
    }
  });

  createHudView();

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try {
      mainWindow.webContents.setZoomFactor(1.0);
      mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    } catch {}
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html')).then(() => {
    log('mainWindow.loadFile completed');
  }).catch((err) => {
    log(`Failed to load index.html: ${err}`);
  });

  if (!START_HIDDEN && !IS_TEST_MODE) {
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
  } else {
    log(`Window started hidden (START_HIDDEN=${START_HIDDEN}, IS_TEST_MODE=${IS_TEST_MODE})`);
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('show', () => {
    restoreFromBossKeyIfNeeded();
    updateTrayMenu();
    layoutViews();
  });

  mainWindow.on('hide', () => {
    hideHudView();
    updateTrayMenu();
  });

  mainWindow.on('blur', () => {
    if (hudCurrentKind === 'tooltip') {
      hideHudView();
    }
  });
}

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

    tray.on('click', () => toggleWindow());
    tray.on('double-click', () => toggleWindow());
    log('System tray initialized successfully');
  } catch (err) {
    log(`Failed to create system tray: ${(err && err.stack) || err}`);
  }
}

function updateTrayMenu() {
  if (!tray) return;

  const isWinVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Discord MultiSpace', enabled: false },
    { type: 'separator' },
    { label: `● Active Account: ${appState.activeAccountName}`, enabled: false },
    { label: `📋 Accounts Configured: ${appState.accountCount}`, enabled: false },
    ...(appState.unreadCount > 0
      ? [{ label: `🔔 Unread Mentions / Messages: ${appState.unreadCount}`, enabled: false }]
      : []),
    { type: 'separator' },
    {
      label: isWinVisible ? 'Hide Window' : 'Open Discord MultiSpace',
      click: () => toggleWindow()
    },
    {
      label: 'Reload Active Session',
      click: () => sendToRenderer('tray-reload-session')
    },
    {
      label: '🔄 Check for Updates...',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (!mainWindow.isVisible()) mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
        triggerUpdateCheck(true);
      }
    },
    { type: 'separator' },
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    restoreFromBossKeyIfNeeded();
  }
  updateTrayMenu();
}

// ============================================================================
// IPC Handlers (All Sender-Verified & Input-Validated)
// ============================================================================
ipcMain.handle('views:validate-proxy', (event, rawProxy) => {
  if (!isTrustedSender(event)) return { valid: false, error: 'Unauthorized sender' };
  return parseAndValidateProxy(typeof rawProxy === 'string' ? rawProxy : '');
});

ipcMain.handle('views:sync-accounts', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false };
  }

  const incomingAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const validIds = new Set();
  const proxyErrors = {};

  if (typeof payload.overlayBlocked === 'boolean') {
    layoutState.overlayBlocked = payload.overlayBlocked;
  }
  if (payload.containerRect && typeof payload.containerRect === 'object') {
    layoutState.containerRect = payload.containerRect;
  }
  layoutState.activeAccountId = isValidAccountId(payload.activeAccountId) ? payload.activeAccountId : null;
  layoutState.isSplitView = Boolean(payload.isSplitView);
  layoutState.splitPrimaryId = isValidAccountId(payload.splitPrimaryId) ? payload.splitPrimaryId : null;
  layoutState.splitSecondaryId = isValidAccountId(payload.splitSecondaryId) ? payload.splitSecondaryId : null;

  for (const acc of incomingAccounts) {
    if (!acc || typeof acc !== 'object' || !isValidAccountId(acc.id)) continue;
    validIds.add(acc.id);
    const res = await ensureAccountView(acc);
    if (!res.ok && res.error) {
      proxyErrors[acc.id] = res.error;
    }
  }

  // Destroy views that are no longer in the accounts list (without wiping storage unless remove-account requested it)
  for (const existingId of Array.from(accountViews.keys())) {
    if (!validIds.has(existingId)) {
      await destroyAccountView(existingId, false);
    }
  }

  layoutViews();

  const viewStates = {};
  for (const [id, entry] of accountViews.entries()) {
    viewStates[id] = {
      hasError: Boolean(entry.hasError),
      errorCode: entry.lastErrorCode,
      errorDescription: entry.lastErrorDescription,
      isLoading: Boolean(entry.isLoading),
      badge: entry.lastBadge || null,
      isHibernated: Boolean(entry.isHibernated)
    };
  }

  return {
    ok: true,
    proxyErrors,
    viewStates,
    audioState: {
      isMutedAll: Boolean(globalMutedState),
      isDeafenedAll: Boolean(globalDeafenedState)
    }
  };
});

ipcMain.handle('views:update-account-proxy', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false, error: 'Invalid request' };
  }
  const { accountId, proxy } = payload;
  if (!isValidAccountId(accountId)) {
    return { ok: false, error: 'Invalid account ID' };
  }

  const normalizedProxy = typeof proxy === 'string' ? proxy.trim() : '';
  const validation = parseAndValidateProxy(normalizedProxy);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const res = await configureAccountSessionProxy(accountId, normalizedProxy);
  const entry = accountViews.get(accountId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    entry.appliedProxyRaw = normalizedProxy;
    entry.hasProxy = res.hasProxy;
    entry.pendingMainLoadFailed = false;
    entry.hasError = false;
    entry.lastErrorCode = null;
    entry.lastErrorDescription = null;
    const policy = res.hasProxy ? 'disable_non_proxied_udp' : 'default';
    entry.view.webContents.setWebRTCIPHandlingPolicy(policy);
    if (entry.childWindows) {
      for (const childWin of entry.childWindows) {
        if (childWin && !childWin.isDestroyed() && !childWin.webContents.isDestroyed()) {
          childWin.webContents.setWebRTCIPHandlingPolicy(policy);
        }
      }
    }
    layoutViews();
    sendToRenderer('view:did-recover-load', { accountId });
    entry.view.webContents.loadURL(DISCORD_APP_URL).catch(() => {});
  }
  return { ok: true };
});

ipcMain.handle('views:remove-account', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false };
  }
  const { accountId, wipeSessionData } = payload;
  if (!isValidAccountId(accountId)) {
    return { ok: false, error: 'Invalid account ID' };
  }
  const shouldWipe = wipeSessionData !== false;
  await destroyAccountView(accountId, shouldWipe);
  layoutViews();
  return { ok: true, wiped: shouldWipe };
});

ipcMain.handle('views:set-layout', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false };
  }
  if (isValidAccountId(payload.activeAccountId)) {
    layoutState.activeAccountId = payload.activeAccountId;
  }
  layoutState.isSplitView = Boolean(payload.isSplitView);
  layoutState.splitPrimaryId = isValidAccountId(payload.splitPrimaryId) ? payload.splitPrimaryId : null;
  layoutState.splitSecondaryId = isValidAccountId(payload.splitSecondaryId) ? payload.splitSecondaryId : null;
  if (payload.containerRect && typeof payload.containerRect === 'object') {
    layoutState.containerRect = payload.containerRect;
  }

  layoutViews();

  if (!layoutState.overlayBlocked && payload.focusActive) {
    const focusId = layoutState.isSplitView ? layoutState.splitPrimaryId : layoutState.activeAccountId;
    const entry = focusId ? accountViews.get(focusId) : null;
    if (entry && !entry.hasError && !entry.view.webContents.isDestroyed()) {
      try {
        entry.view.webContents.focus();
      } catch {}
    }
  }
  return { ok: true };
});

ipcMain.handle('views:set-overlay-blocked', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false, snapshots: {} };
  }

  const nextBlocked = Boolean(payload.blocked);
  const mySeq = ++overlayBlockSeq;

  if (!nextBlocked) {
    layoutState.overlayBlocked = false;
    layoutViews();
    return { ok: true, snapshots: {} };
  }

  const snapshots = {};
  const shouldCapture = payload.capture !== false && !layoutState.overlayBlocked;

  if (shouldCapture) {
    const visibleIds = layoutState.isSplitView
      ? [layoutState.splitPrimaryId, layoutState.splitSecondaryId].filter(Boolean)
      : [layoutState.activeAccountId].filter(Boolean);

    for (const id of visibleIds) {
      if (mySeq !== overlayBlockSeq) {
        return { ok: true, stale: true, snapshots: {} };
      }
      const entry = accountViews.get(id);
      if (entry && entry.view.getVisible() && !entry.hasError && !entry.view.webContents.isDestroyed()) {
        try {
          const img = await entry.view.webContents.capturePage();
          if (img && !img.isEmpty()) {
            snapshots[id] = img.toDataURL();
          }
        } catch {}
      }
    }
  }

  // Abort if a newer overlay state change arrived while capturePage() was awaiting!
  if (mySeq !== overlayBlockSeq) {
    return { ok: true, stale: true, snapshots: {} };
  }

  layoutState.overlayBlocked = true;
  layoutViews();
  return { ok: true, snapshots };
});

const MINIMALIST_CSS = `/* Clean Minimalist Theme */
button[aria-label="Send a gift"],
button[aria-label="Open GIF picker"],
button[aria-label="Open sticker picker"],
div[aria-label="Open GIF picker"],
div[aria-label="Open sticker picker"],
a[href="/shop"],
a[href="/nitro"],
li:has(a[href="/shop"]),
li:has(a[href="/nitro"]) {
  display: none !important;
}
::-webkit-scrollbar { width: 5px !important; height: 5px !important; }
::-webkit-scrollbar-track { background: transparent !important; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2) !important; border-radius: 6px !important; }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.35) !important; }`;

ipcMain.handle('views:apply-theme', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { ok: false, error: 'Unauthorized' };
  }

  const presetId = typeof payload.presetId === 'string' ? payload.presetId : 'default';
  const customCss = typeof payload.customCss === 'string' ? payload.customCss.trim() : '';

  try {
    if (presetId === 'default' || (!customCss && presetId === 'custom')) {
      isCustomThemeActive = false;
      currentResolvedThemeCss = '';
    } else if (presetId === 'minimalist') {
      // Minimalist uses pure local selectors with zero external font/image assets -> keep strict Discord CSP!
      isCustomThemeActive = false;
      currentResolvedThemeCss = MINIMALIST_CSS;
    } else if (presetId === 'midnight') {
      isCustomThemeActive = true;
      currentResolvedThemeCss = await fs.promises.readFile(
        path.join(__dirname, 'assets', 'themes', 'midnight.css'),
        'utf8'
      );
    } else if (presetId === 'amoled') {
      isCustomThemeActive = true;
      currentResolvedThemeCss = await fs.promises.readFile(
        path.join(__dirname, 'assets', 'themes', 'amoled.css'),
        'utf8'
      );
    } else {
      const resolvedImports = await resolveThemeCssImports(customCss, {
        userAgent: CHROME_USER_AGENT
      });
      if (!resolvedImports.success) {
        return { ok: false, error: resolvedImports.error || 'Failed to load remote theme CSS.' };
      }
      isCustomThemeActive = true;
      currentResolvedThemeCss = resolvedImports.css;
    }

    await Promise.all(Array.from(accountViews.values()).map((entry) => applyThemeToEntry(entry)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Scoped Discord Voice Status Bar Mute / Deafen (Excludes Channel/Server/User Mute & supports non-English locales!)
ipcMain.handle('views:set-mute-all', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return { ok: false };
  const targetMuted = Boolean(payload.muted);
  globalMutedState = targetMuted;

  const script = `
    (() => {
      try {
        const targetMuted = ${targetMuted};
        const candidates = Array.from(document.querySelectorAll('section[aria-label] button[aria-label], [class*="panels_"] button[aria-label]'));
        let muteBtn = candidates.find((b) => {
          const l = (b.getAttribute('aria-label') || '').trim().toLowerCase();
          if (l.includes('channel') || l.includes('server') || l.includes('deafen')) return false;
          return l === 'mute' || l === 'unmute' || l.startsWith('mute ') || l.startsWith('unmute ');
        });
        if (!muteBtn) {
          const switches = Array.from(document.querySelectorAll('[class*="panels_"] button[role="switch"][aria-checked]'));
          if (switches.length >= 2) muteBtn = switches[0];
        }
        if (muteBtn) {
          const label = (muteBtn.getAttribute('aria-label') || '').toLowerCase();
          const ariaChecked = muteBtn.getAttribute('aria-checked');
          const isCurrentlyMuted = ariaChecked !== null ? ariaChecked === 'true' : label.startsWith('unmute');
          if (targetMuted !== isCurrentlyMuted) {
            muteBtn.click();
          }
          return { clicked: true };
        }
        return { clicked: false };
      } catch {
        return { clicked: false };
      }
    })()
  `;

  for (const entry of accountViews.values()) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) continue;
    try {
      const res = await wc.executeJavaScript(script);
      if (!res || !res.clicked) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'shift'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'shift'] });
      }
    } catch {}
  }
  return { ok: true };
});

ipcMain.handle('views:set-deafen-all', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return { ok: false };
  const targetDeafened = Boolean(payload.deafened);
  globalDeafenedState = targetDeafened;

  const script = `
    (() => {
      try {
        const targetDeafened = ${targetDeafened};
        const candidates = Array.from(document.querySelectorAll('section[aria-label] button[aria-label], [class*="panels_"] button[aria-label]'));
        let deafenBtn = candidates.find((b) => {
          const l = (b.getAttribute('aria-label') || '').trim().toLowerCase();
          return l === 'deafen' || l === 'undeafen' || l.startsWith('deafen ') || l.startsWith('undeafen ');
        });
        if (!deafenBtn) {
          const switches = Array.from(document.querySelectorAll('[class*="panels_"] button[role="switch"][aria-checked]'));
          if (switches.length >= 2) deafenBtn = switches[1];
        }
        if (deafenBtn) {
          const label = (deafenBtn.getAttribute('aria-label') || '').toLowerCase();
          const ariaChecked = deafenBtn.getAttribute('aria-checked');
          const isCurrentlyDeafened = ariaChecked !== null ? ariaChecked === 'true' : label.startsWith('undeafen');
          if (targetDeafened !== isCurrentlyDeafened) {
            deafenBtn.click();
          }
          return { clicked: true };
        }
        return { clicked: false };
      } catch {
        return { clicked: false };
      }
    })()
  `;

  for (const entry of accountViews.values()) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) continue;
    try {
      if (!isBossKeyMuted) {
        wc.setAudioMuted(targetDeafened);
        if (entry.childWindows) {
          for (const childWin of entry.childWindows) {
            if (childWin && !childWin.isDestroyed() && !childWin.webContents.isDestroyed()) {
              childWin.webContents.setAudioMuted(targetDeafened);
            }
          }
        }
      }
      const res = await wc.executeJavaScript(script);
      if (!res || !res.clicked) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['control', 'shift'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['control', 'shift'] });
      }
    } catch {}
  }
  return { ok: true };
});

// Real Background Memory/CPU Saver: Enables Chromium background throttling, freezes GIF/CSS animations, and NEVER mutes incoming DM/Call audio!
const HIBERNATION_PAUSE_CSS = '* , *::before, *::after { animation-play-state: paused !important; transition: none !important; }';

ipcMain.handle('views:check-hibernation', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') {
    return { hibernatedIds: [] };
  }

  if (!payload.memorySaverEnabled) {
    for (const entry of accountViews.values()) {
      wakeEntryIfHibernated(entry);
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.setBackgroundThrottling(false);
      }
    }
    return { hibernatedIds: [] };
  }

  for (const entry of accountViews.values()) {
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.setBackgroundThrottling(true);
    }
  }

  const candidateIds = Array.isArray(payload.idleAccountIds) ? payload.idleAccountIds : [];
  const hibernatedIds = [];

  for (const id of candidateIds) {
    if (!isValidAccountId(id)) continue;
    const entry = accountViews.get(id);
    if (!entry || entry.view.getVisible() || entry.view.webContents.isDestroyed()) continue;

    try {
      const wc = entry.view.webContents;
      const inVoice = await wc.executeJavaScript(`
        (() => !!document.querySelector('[class*="rtcConnectionStatusConnected"], [class*="voiceChannelEffect"], [class*="connected_"]'))()
      `);
      if (!inVoice) {
        entry.isHibernated = true;
        wc.setBackgroundThrottling(true);
        if (typeof wc.setImageAnimationPolicy === 'function') {
          wc.setImageAnimationPolicy('noAnimation');
        }
        if (!entry.hibernationCssKey) {
          entry.hibernationCssKey = await wc.insertCSS(HIBERNATION_PAUSE_CSS).catch(() => null);
        }
        hibernatedIds.push(id);
      }
    } catch {}
  }

  return { hibernatedIds };
});

ipcMain.on('views:reload-account', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!isValidAccountId(payload.accountId)) return;
  reloadAccountView(payload.accountId, Boolean(payload.ignoreCache));
});

ipcMain.on('views:retry-account', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!isValidAccountId(payload.accountId)) return;
  reloadAccountView(payload.accountId, false);
});

ipcMain.on('views:set-zoom', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!isValidAccountId(payload.accountId) || typeof payload.zoomFactor !== 'number') return;
  const entry = accountViews.get(payload.accountId);
  if (!entry || entry.view.webContents.isDestroyed()) return;
  const clamped = Math.min(2.0, Math.max(0.5, Math.round(payload.zoomFactor * 10) / 10));
  entry.zoomFactor = clamped;
  try {
    entry.view.webContents.setZoomFactor(clamped);
  } catch {}
});

// HUD IPC Handlers
ipcMain.on('hud:show-tooltip', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!payload.visible) {
    if (hudCurrentKind === 'tooltip') {
      hideHudView();
    }
    return;
  }
  const text = escapeHtml(payload.text || '');
  const shortcut = payload.shortcut ? `<span class="hud-shortcut">${escapeHtml(payload.shortcut)}</span>` : '';
  const estimatedWidth = Math.min(340, Math.max(120, (String(payload.text || '').length * 8) + (payload.shortcut ? 72 : 36)));
  const y = Math.max(8, Math.round(Number(payload.y) || 12));
  showHudCard({
    kind: 'tooltip',
    x: 78,
    y,
    width: estimatedWidth,
    height: 40,
    htmlPayload: `<div class="hud-pill"><span>${text}</span>${shortcut}</div>`,
    autoHideMs: 0
  });
});

ipcMain.on('hud:show-toast', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!mainWindow || mainWindow.isDestroyed() || layoutState.overlayBlocked) return;
  const [winWidth, winHeight] = mainWindow.getContentSize();
  const msg = escapeHtml(payload.message || '');
  const dotClass = payload.isError ? 'dot-err' : 'dot-ok';
  const width = Math.min(380, Math.max(200, (String(payload.message || '').length * 7.5) + 56));
  const duration = typeof payload.duration === 'number' ? Math.max(800, payload.duration) : 2800;
  showHudCard({
    kind: 'toast',
    x: Math.max(80, winWidth - width - 24),
    y: Math.max(20, winHeight - 68),
    width,
    height: 46,
    htmlPayload: `<div class="hud-pill"><span class="${dotClass}"></span><span>${msg}</span></div>`,
    autoHideMs: duration
  });
});

ipcMain.on('hud:show-zoom', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  if (!mainWindow || mainWindow.isDestroyed() || layoutState.overlayBlocked) return;
  const [winWidth] = mainWindow.getContentSize();
  const label = escapeHtml(payload.text || 'Zoom: 100%');
  showHudCard({
    kind: 'zoom',
    x: Math.max(80, winWidth - 156),
    y: Math.max(12, (layoutState.containerRect && layoutState.containerRect.y ? layoutState.containerRect.y : 0) + 14),
    width: 138,
    height: 38,
    htmlPayload: `<div class="hud-pill"><span>${label}</span></div>`,
    autoHideMs: 1400
  });
});

// Status, Title & Taskbar IPC
ipcMain.on('update-tray-status', (event, state) => {
  if (!isTrustedSender(event) || !state || typeof state !== 'object') return;
  if (typeof state.accountCount === 'number') appState.accountCount = state.accountCount;
  if (typeof state.activeAccountName === 'string') appState.activeAccountName = state.activeAccountName;
  if (typeof state.unreadCount === 'number') {
    appState.unreadCount = state.unreadCount;
    if (typeof app.setBadgeCount === 'function') {
      try {
        app.setBadgeCount(state.unreadCount);
      } catch {}
    }
  }
  updateTrayMenu();
});

ipcMain.on('app-reload-window', (event) => {
  if (!isTrustedSender(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.reload();
  }
});

ipcMain.on('update-title', (event, title) => {
  if (!isTrustedSender(event) || typeof title !== 'string' || !title) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title.slice(0, 200));
  }
});

ipcMain.on('update-taskbar-overlay', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const count = Number(payload.count) || 0;
    if (count > 0 && typeof payload.dataUrl === 'string' && payload.dataUrl.startsWith('data:image/png;base64,')) {
      const img = nativeImage.createFromDataURL(payload.dataUrl);
      mainWindow.setOverlayIcon(img, `${count} unread mention${count > 1 ? 's' : ''}`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } catch (err) {
    log(`Failed to update taskbar overlay icon: ${err}`);
  }
});

// Windows Startup & Global Shortcuts Settings
function getStartupTarget() {
  const installedExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'discord-multispace', 'Discord MultiSpace.exe');
  if (app.isPackaged) {
    return { path: process.execPath, args: ['--hidden'] };
  }
  if (fs.existsSync(installedExe)) {
    return { path: installedExe, args: ['--hidden'] };
  }
  return { path: process.execPath, args: [path.resolve(app.getAppPath()), '--hidden'] };
}

ipcMain.handle('get-startup-setting', (event) => {
  if (!isTrustedSender(event)) return { openAtLogin: false, globalShortcutsEnabled: false };
  let openAtLogin = false;
  try {
    const target = getStartupTarget();
    openAtLogin = Boolean(
      app.getLoginItemSettings({
        path: target.path,
        args: target.args,
        name: 'Discord MultiSpace'
      }).openAtLogin
    );
  } catch {}
  return {
    openAtLogin,
    globalShortcutsEnabled: Boolean(mainSettings.globalShortcutsEnabled)
  };
});

ipcMain.on('set-startup-setting', (event, openAtLogin) => {
  if (!isTrustedSender(event)) return;
  try {
    const target = getStartupTarget();
    app.setLoginItemSettings({
      openAtLogin: Boolean(openAtLogin),
      path: target.path,
      args: target.args,
      name: 'Discord MultiSpace'
    });
    log(`Launch on startup updated: ${Boolean(openAtLogin)}`);
  } catch (err) {
    log(`Failed to set startup setting: ${err}`);
  }
});

ipcMain.handle('set-global-shortcuts-enabled', async (event, enabled) => {
  if (!isTrustedSender(event)) return { ok: false };
  mainSettings.globalShortcutsEnabled = Boolean(enabled);
  await saveMainSettings();
  const res = applyGlobalShortcutsSetting();
  return { ok: true, ...res };
});

ipcMain.handle('fetch-theme-css', async (event, url) => {
  if (!isTrustedSender(event)) {
    return { success: false, error: 'Unauthorized sender' };
  }
  return safeFetchThemeCss(url, { userAgent: CHROME_USER_AGENT });
});

ipcMain.on('clear-account-cache', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  const { partition, accountName } = payload;
  if (!isValidPartition(partition)) return;
  try {
    const targetSession = session.fromPartition(partition);
    await targetSession.clearCache();
    log(`Cache cleared successfully for partition [${partition}] (${accountName || 'Account'})`);
  } catch (err) {
    log(`Failed to clear cache for partition [${partition}]: ${(err && err.message) || err}`);
  }
});

ipcMain.on('open-external-url', (event, url) => {
  if (!isTrustedSender(event)) return;
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url).catch(() => {});
  }
});

// Screen Share Audio & Picker IPC
ipcMain.on('set-stream-audio-device', (event, data) => {
  if (!isTrustedSender(event)) return;
  const label = typeof data === 'string'
    ? data
    : (data && typeof data === 'object' && (data.label || data.deviceId)) || 'loopback';
  log(`Screen share audio device set to: "${label}"`);
  broadcastAudioDeviceLabelToViews(label);
});

ipcMain.handle('get-stream-audio-device', (event) => {
  if (!isTrustedSender(event)) return 'loopback';
  return mainSettings.streamAudioDeviceLabel;
});

ipcMain.on('screen-picker-select', async (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  const { requestId, sourceId, withAudio, audioSourceDeviceId } = payload;
  const allowAudio = Boolean(withAudio);

  if (typeof audioSourceDeviceId === 'string' && audioSourceDeviceId) {
    broadcastAudioDeviceLabelToViews(audioSourceDeviceId);
  }

  const pending = pendingDisplayMediaRequests.get(requestId);
  if (!pending) return;
  pendingDisplayMediaRequests.delete(requestId);

  // Synchronize __discordMultiSpaceShareAudio to all views BEFORE resolving getDisplayMedia
  await Promise.all(
    Array.from(accountViews.values()).map((entry) => {
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) return Promise.resolve();
      return wc
        .executeJavaScript(
          `window.__discordMultiSpaceShareAudio = ${allowAudio}; window.__discordMultiSpaceAudioDeviceLabel = ${JSON.stringify(mainSettings.streamAudioDeviceLabel)};`
        )
        .catch(() => {});
    })
  );

  const selectedSource = pending.sources.find((s) => s.id === sourceId);
  if (selectedSource) {
    lastConfirmedDisplayMedia = { sourceId: selectedSource.id, withAudio: allowAudio };
    lastConfirmedTimestamp = Date.now();
    log(`Screen share confirmed: source [${selectedSource.id}] "${selectedSource.name}", withAudio: ${allowAudio}`);
    try {
      pending.callback({
        video: selectedSource,
        audio: allowAudio ? 'loopback' : undefined
      });
    } catch {
      try { pending.callback({}); } catch {}
    }
  } else {
    try { pending.callback({}); } catch {}
  }
});

ipcMain.on('screen-picker-cancel', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') return;
  const pending = pendingDisplayMediaRequests.get(payload.requestId);
  if (pending) {
    pendingDisplayMediaRequests.delete(payload.requestId);
    try { pending.callback({}); } catch {}
  }
});

// ============================================================================
// Auto-Updater (Explicit Download & Install Prompt — Never Silent Install)
// ============================================================================
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    log('AutoUpdater: Checking for updates...');
    sendToRenderer('update-checking', { manual: lastUpdateCheckManual });
  });

  autoUpdater.on('update-available', (info) => {
    log(`AutoUpdater: Update available [v${info && info.version}]`);
    sendToRenderer('update-available', { ...info, manual: lastUpdateCheckManual });
  });

  autoUpdater.on('update-not-available', (info) => {
    log('AutoUpdater: Update not available.');
    sendToRenderer('update-not-available', { ...info, manual: lastUpdateCheckManual });
    lastUpdateCheckManual = false;
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendToRenderer('update-download-progress', {
      percent: progressObj.percent,
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log(`AutoUpdater: Update downloaded [v${info && info.version}] — awaiting user install confirmation`);
    sendToRenderer('update-downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    log(`AutoUpdater error: ${(err && err.message) || err}`);
    sendToRenderer('update-error', {
      message: (err && err.message) || String(err),
      manual: lastUpdateCheckManual
    });
    lastUpdateCheckManual = false;
  });
}

function triggerUpdateCheck(manual = false) {
  lastUpdateCheckManual = Boolean(manual);
  log(`triggerUpdateCheck called (manual: ${lastUpdateCheckManual}, isPackaged: ${app.isPackaged})`);

  if (IS_TEST_MODE) return;

  if (!app.isPackaged) {
    sendToRenderer('update-checking', { manual: lastUpdateCheckManual });
    const options = {
      hostname: 'api.github.com',
      path: '/repos/NextGenInfluencer/discord-multispace/releases/latest',
      headers: { 'User-Agent': 'Discord-MultiSpace-Updater' },
      timeout: 6000
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        if (data.length < 256 * 1024) data += chunk;
      });
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestTag = (release.tag_name || '').replace(/^v/, '');
          const currentVersion = app.getVersion();
          if (latestTag && latestTag !== currentVersion && latestTag.localeCompare(currentVersion, undefined, { numeric: true }) > 0) {
            sendToRenderer('update-available', {
              version: latestTag,
              releaseNotes: release.body,
              isDev: true,
              manual: lastUpdateCheckManual
            });
          } else {
            sendToRenderer('update-not-available', {
              version: currentVersion,
              isDev: true,
              manual: lastUpdateCheckManual
            });
          }
        } catch {
          sendToRenderer('update-not-available', { isDev: true, manual: lastUpdateCheckManual });
        }
        lastUpdateCheckManual = false;
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => {
      sendToRenderer('update-error', { message: err.message, manual: lastUpdateCheckManual });
      lastUpdateCheckManual = false;
    });
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    log(`checkForUpdates failed: ${err.message}`);
    sendToRenderer('update-error', { message: err.message, manual: lastUpdateCheckManual });
    lastUpdateCheckManual = false;
  });
}

ipcMain.on('check-for-updates', (event) => {
  if (!isTrustedSender(event)) return;
  triggerUpdateCheck(true);
});

ipcMain.handle('updater:download', async (event) => {
  if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized' };
  if (!app.isPackaged) {
    shell.openExternal('https://github.com/NextGenInfluencer/discord-multispace/releases/latest').catch(() => {});
    return { ok: true, isDev: true };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    sendToRenderer('update-error', { message: (err && err.message) || String(err), manual: true });
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.on('install-update-now', (event) => {
  if (!isTrustedSender(event)) return;
  log('install-update-now confirmed by user: restarting and installing update');
  app.isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', (event) => {
  if (!isTrustedSender(event)) return '';
  return app.getVersion();
});

// ============================================================================
// Single Instance Lock & Application Boot
// ============================================================================
const gotTheLock = IS_TEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (Array.isArray(commandLine) && commandLine.includes('--hidden')) {
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      restoreFromBossKeyIfNeeded();
    }
  });

  app.whenReady().then(() => {
    loadMainSettings();
    createWindow();
    if (!IS_TEST_MODE) {
      createTray();
    }
    setupAutoUpdater();
    applyGlobalShortcutsSetting();

    if (!IS_TEST_MODE) {
      setTimeout(() => triggerUpdateCheck(false), 6000);
      setInterval(() => triggerUpdateCheck(false), 4 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        restoreFromBossKeyIfNeeded();
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
  } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit();
  }
});

// Expose internal inspection hooks strictly in unpackaged test mode for E2E verification
if (IS_TEST_MODE) {
  global.__multispaceTestHooks = {
    getMainWindow: () => mainWindow,
    getAccountViews: () => accountViews,
    getHudView: () => hudView,
    getLayoutState: () => ({ ...layoutState }),
    getMainSettings: () => ({ ...mainSettings }),
    getAutoUpdaterConfig: () => ({
      autoDownload: autoUpdater.autoDownload,
      autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit
    }),
    handleBossKey,
    toggleWindow,
    restoreFromBossKeyIfNeeded,
    isBossKeyMuted: () => isBossKeyMuted,
    isCustomThemeActive: () => isCustomThemeActive,
    checkOriginPermission,
    getLogFilePath: () => logFile
  };
}
