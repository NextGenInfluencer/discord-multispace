'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, globalShortcut, screen, session } = require('electron');
const { sanitizeWindowState } = require('../lib/security');

app.disableHardwareAcceleration();

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'multispace-e2e-'));

const serverStats = {
  directRequests: 0,
  proxiedRequests: 0,
  proxy407Challenges: 0,
  proxyAuthSuccesses: 0
};

function startServers() {
  return new Promise((resolve, reject) => {
    const discordServer = http.createServer((req, res) => {
      const viaProxy = req.headers['x-via-multispace-proxy'] === '1';
      if (viaProxy) serverStats.proxiedRequests += 1;
      else serverStats.directRequests += 1;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>(3) Discord | #general</title></head>
<body>
  <div id="mock-discord">Mock Discord Loaded (viaProxy=${viaProxy})</div>
  <section aria-label="User area">
    <button id="voice-mute-btn" aria-label="Mute" aria-checked="false" onclick="
      const m = this.getAttribute('aria-checked') === 'true';
      this.setAttribute('aria-checked', String(!m));
      this.setAttribute('aria-label', !m ? 'Unmute' : 'Mute');
    ">Mute</button>
    <button id="voice-deafen-btn" aria-label="Deafen" aria-checked="false" onclick="
      const d = this.getAttribute('aria-checked') === 'true';
      this.setAttribute('aria-checked', String(!d));
      this.setAttribute('aria-label', !d ? 'Undeafen' : 'Deafen');
    ">Deafen</button>
  </section>
  <button id="channel-mute-trap" aria-label="Mute channel" onclick="window.__channelMuteClicked = true;">Mute Channel</button>
</body>
</html>`);
    });

    const proxyServer = http.createServer((req, res) => {
      const expectedAuth = 'Basic ' + Buffer.from('proxyuser:supersecretpass').toString('base64');
      const gotAuth = req.headers['proxy-authorization'];
      if (gotAuth !== expectedAuth) {
        serverStats.proxy407Challenges += 1;
        res.writeHead(407, {
          'Proxy-Authenticate': 'Basic realm="MultiSpaceProxyTest"',
          'Content-Type': 'text/plain'
        });
        res.end('Proxy Auth Required');
        return;
      }

      serverStats.proxyAuthSuccesses += 1;
      const targetUrl = new URL(req.url);
      const proxyReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: {
            ...req.headers,
            'x-via-multispace-proxy': '1'
          }
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on('error', (err) => {
        res.writeHead(502);
        res.end(err.message);
      });
      req.pipe(proxyReq);
    });

    discordServer.listen(0, '127.0.0.1', () => {
      const discordPort = discordServer.address().port;
      proxyServer.listen(0, '127.0.0.1', () => {
        const proxyPort = proxyServer.address().port;
        resolve({ discordServer, proxyServer, discordPort, proxyPort });
      });
    });
    discordServer.on('error', reject);
    proxyServer.on('error', reject);
  });
}

function waitFor(predicate, label = 'condition', timeoutMs = 8000, intervalMs = 50) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const val = await predicate();
        if (val) {
          resolve(val);
          return;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

(async () => {
  let servers;
  try {
    servers = await startServers();
    process.env.MULTISPACE_TEST_MODE = '1';
    process.env.MULTISPACE_TEST_USER_DATA = tempUserData;
    process.env.MULTISPACE_TEST_DISCORD_URL = `http://127.0.0.1:${servers.discordPort}/app`;

    require('../main.js');
    await app.whenReady();

    const hooks = global.__multispaceTestHooks;
    assert.ok(hooks, 'Expected __multispaceTestHooks to be initialized');

    // 1. Verify Electron 45 runtime & Account 1 WebContentsView creation
    console.log('[E2E 1/8] Checking Electron 45 runtime & initial WebContentsView...');
    assert.equal(process.versions.electron, '45.4.1', 'Must run on Electron 45.4.1');

    const win = await waitFor(() => hooks.getMainWindow());
    await waitFor(() => hooks.getAccountViews().size === 1);
    const acc1Entry = hooks.getAccountViews().get('1');
    assert.ok(acc1Entry, 'Account 1 WebContentsView should exist');

    await waitFor(async () => {
      const text = await acc1Entry.view.webContents.executeJavaScript(
        'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
      );
      return text.includes('Mock Discord Loaded');
    });

    const hasLegacyWebviewTag = await win.webContents.executeJavaScript(
      'document.querySelectorAll("webview").length'
    );
    assert.equal(hasLegacyWebviewTag, 0, 'DOM must contain zero <webview> tags');

    // Verify notification badge parsed "(3) Discord | #general" -> "3"
    await waitFor(async () => {
      const badgeText = await win.webContents.executeJavaScript(
        'document.getElementById("notif-badge-1") ? document.getElementById("notif-badge-1").textContent : ""'
      );
      return badgeText === '3';
    });

    // 2. Verify Global OS Shortcuts are DISABLED by default + Opt-in toggle works
    console.log('[E2E 2/8] Checking Global OS Shortcuts disabled by default & opt-in toggle...');
    assert.equal(globalShortcut.isRegistered('CommandOrControl+Alt+M'), false);
    assert.equal(globalShortcut.isRegistered('CommandOrControl+Alt+D'), false);
    assert.equal(globalShortcut.isRegistered('CommandOrControl+Shift+H'), false);

    await win.webContents.executeJavaScript(`
      (async () => {
        const t = document.getElementById('toggle-global-shortcuts');
        t.checked = true;
        t.dispatchEvent(new Event('change'));
      })()
    `);
    await waitFor(() => hooks.getMainSettings().globalShortcutsEnabled === true);
    await win.webContents.executeJavaScript(`
      (async () => {
        const t = document.getElementById('toggle-global-shortcuts');
        t.checked = false;
        t.dispatchEvent(new Event('change'));
      })()
    `);
    await waitFor(() => hooks.getMainSettings().globalShortcutsEnabled === false);
    assert.equal(globalShortcut.isRegistered('CommandOrControl+Shift+H'), false);

    // 3. Verify Explicit Auto-Updater configuration & Non-Occluded Top Update Banner
    console.log('[E2E 3/8] Checking Auto-Updater explicit prompt config & layout banner bounds...');
    const updaterCfg = hooks.getAutoUpdaterConfig();
    assert.equal(updaterCfg.autoDownload, false, 'autoDownload must be false');
    assert.equal(updaterCfg.autoInstallOnAppQuit, false, 'autoInstallOnAppQuit must be false');

    const boundsBeforeBanner = acc1Entry.view.getBounds();
    assert.equal(boundsBeforeBanner.x, 72);
    assert.ok(boundsBeforeBanner.width > 500);

    win.webContents.send('update-available', { version: '2.1.0', manual: false });
    await waitFor(() => acc1Entry.view.getBounds().y > boundsBeforeBanner.y);
    const boundsWithBanner = acc1Entry.view.getBounds();
    assert.ok(
      boundsWithBanner.y >= boundsBeforeBanner.y + 35,
      `Update banner must push WebContentsView y down (${boundsBeforeBanner.y} -> ${boundsWithBanner.y})`
    );
    const bannerBtnText = await win.webContents.executeJavaScript(
      'document.getElementById("btn-banner-action").textContent'
    );
    assert.equal(bannerBtnText, 'Download Update');
    await win.webContents.executeJavaScript('document.getElementById("btn-banner-dismiss").click()');
    await waitFor(() => acc1Entry.view.getBounds().y === boundsBeforeBanner.y);

    // 4. Verify Modal & Context Menu Z-Order Overlay Blocking (hides native WebContentsView)
    console.log('[E2E 4/8] Checking Modal & Context Menu native WebContentsView visibility coordination...');
    assert.equal(acc1Entry.view.getVisible(), true);

    await win.webContents.executeJavaScript('document.getElementById("btn-open-settings").click()');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === true && acc1Entry.view.getVisible() === false);

    await win.webContents.executeJavaScript('document.getElementById("btn-settings-close").click()');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === false && acc1Entry.view.getVisible() === true);

    await win.webContents.executeJavaScript('openContextMenu(90, 120, "1")');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === true && acc1Entry.view.getVisible() === false);
    await win.webContents.executeJavaScript('closeContextMenu()');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === false && acc1Entry.view.getVisible() === true);

    // Rapid open -> immediate 1ms close race test (while capturePage() is in flight)
    win.show();
    await win.webContents.executeJavaScript(`
      openContextMenu(90, 120, '1');
      setTimeout(() => closeContextMenu(), 1);
    `);
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(hooks.getLayoutState().overlayBlocked, false, 'Rapid overlay close during capturePage must NOT leave overlayBlocked=true');
    assert.equal(acc1Entry.view.getVisible(), true, 'Rapid overlay close must leave active Discord WebContentsView visible');

    // HUD tooltip must clear cleanly if sidebar re-renders while an account badge is hovered
    await win.webContents.executeJavaScript(`
      const item = document.querySelector('.account-item[data-account-id="1"]');
      item.dispatchEvent(new MouseEvent('mouseenter'));
      renderAccountStack();
    `);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(hooks.getHudView().getVisible(), false, 'Re-rendering account stack must dismiss hovered HUD tooltip');

    // 5. Verify Scoped Global Mute does NOT click "Mute channel"
    console.log('[E2E 5/8] Checking Scoped Global Mute & Theme Engine...');
    await win.webContents.executeJavaScript('document.getElementById("btn-mute-all").click()');
    await waitFor(async () => {
      const state = await acc1Entry.view.webContents.executeJavaScript(`({
        voiceMuted: document.getElementById('voice-mute-btn').getAttribute('aria-checked'),
        channelTrapClicked: Boolean(window.__channelMuteClicked)
      })`);
      return state.voiceMuted === 'true' && state.channelTrapClicked === false;
    });

    // Default theme keeps strict CSP flag false; bundled Midnight sets customThemeActive true & injects CSS
    assert.equal(hooks.isCustomThemeActive(), false);
    await win.webContents.executeJavaScript('applyTheme("midnight")');
    await waitFor(() => hooks.isCustomThemeActive() === true && Boolean(acc1Entry.insertedCssKey));
    const quotedSsrfTheme = await win.webContents.executeJavaScript(
      'window.electronAPI.invoke("views:apply-theme", { presetId: "custom", customCss: \'@import "http://127.0.0.1:9999/ssrf.css"; body { color: red; }\' })'
    );
    assert.equal(quotedSsrfTheme.ok, false, 'Quoted cleartext/loopback @import must be rejected in views:apply-theme');
    await win.webContents.executeJavaScript('applyTheme("default")');
    await waitFor(() => hooks.isCustomThemeActive() === false && acc1Entry.insertedCssKey === null);

    // 6. Verify Zero-Leak Per-Account Authenticated HTTP Proxy, WebRTC Policy & Log Redaction
    console.log('[E2E 6/8] Checking Per-Account Authenticated Proxy (407), WebRTC UDP guard & log redaction...');
    const directCountBefore = serverStats.directRequests;

    // First verify invalid SOCKS5+auth proxy is rejected in modal
    await win.webContents.executeJavaScript('document.getElementById("btn-add-account").click()');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === true);
    await win.webContents.executeJavaScript(`
      document.getElementById('input-account-name').value = 'Proxied Account';
      document.getElementById('input-account-proxy').value = 'socks5://bad:creds@127.0.0.1:1080';
      document.getElementById('btn-modal-submit').click();
    `);
    await waitFor(async () => {
      const errVisible = await win.webContents.executeJavaScript(
        '!document.getElementById("modal-proxy-error").classList.contains("hidden")'
      );
      return errVisible;
    });
    assert.equal(hooks.getAccountViews().size, 1, 'Invalid proxy must not create an account view');

    // Now submit valid HTTP proxy with 407 authentication
    const proxyUrl = `http://proxyuser:supersecretpass@127.0.0.1:${servers.proxyPort}`;
    await win.webContents.executeJavaScript(`
      document.getElementById('input-account-proxy').value = ${JSON.stringify(proxyUrl)};
      document.getElementById('btn-modal-submit').click();
    `);

    await waitFor(() => hooks.getAccountViews().size === 2, 'Account 2 view created');
    const acc2Id = Array.from(hooks.getAccountViews().keys()).find((id) => id !== '1');
    const acc2Entry = hooks.getAccountViews().get(acc2Id);
    assert.ok(acc2Entry, 'Proxied Account 2 WebContentsView should exist');

    await waitFor(async () => {
      const txt = await acc2Entry.view.webContents.executeJavaScript(
        'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
      );
      return txt.includes('viaProxy=true');
    }, 'Account 2 loaded via proxy');

    assert.equal(
      serverStats.directRequests,
      directCountBefore,
      'Account 2 must NOT make any direct unproxied requests during creation or boot!'
    );
    assert.ok(serverStats.proxy407Challenges >= 1, 'Proxy must issue 407 challenge');
    assert.ok(serverStats.proxyAuthSuccesses >= 1, 'app.on("login") must fulfill 407 proxy auth');
    assert.equal(
      acc2Entry.view.webContents.getWebRTCIPHandlingPolicy(),
      'disable_non_proxied_udp',
      'Proxied account must enforce disable_non_proxied_udp'
    );

    // Verify 4+ consecutive fresh 407 proxy auth challenges (clearAuthCache + reload) all succeed without tripping retry cap
    const acc2SessionEarly = session.fromPartition(`persist:discord_account_${acc2Id}`);
    for (let cycle = 1; cycle <= 4; cycle++) {
      await acc2SessionEarly.clearAuthCache();
      await acc2SessionEarly.closeAllConnections();
      acc2Entry.view.webContents.reload();
      await waitFor(async () => {
        const bodyTxt = await acc2Entry.view.webContents.executeJavaScript(
          'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
        );
        return bodyTxt.includes('viaProxy=true');
      }, `Proxy 407 auth reload cycle #${cycle}`);
    }

    // Verify Pop-Out child window (about:blank) on proxied account inherits disable_non_proxied_udp & obeys Boss Key!
    const winsBeforePopout = BrowserWindow.getAllWindows().length;
    await acc2Entry.view.webContents.executeJavaScript(
      'window.__pop = window.open("about:blank", "discord_call_popout", "width=420,height=320"); true;'
    );
    await waitFor(() => BrowserWindow.getAllWindows().length > winsBeforePopout, 'Pop-out child window opened');
    const popoutWin = BrowserWindow.getAllWindows().find((w) => w !== win);
    assert.ok(popoutWin, 'Expected Pop-Out BrowserWindow');
    assert.equal(
      popoutWin.webContents.getWebRTCIPHandlingPolicy(),
      'disable_non_proxied_udp',
      'Pop-Out call window on proxied account MUST enforce disable_non_proxied_udp'
    );
    win.show();
    hooks.handleBossKey();
    assert.equal(popoutWin.isVisible(), false, 'Boss Key must also hide open Pop-Out call windows');
    assert.equal(popoutWin.webContents.isAudioMuted(), true, 'Boss Key must also mute open Pop-Out call windows');
    hooks.toggleWindow();
    assert.equal(popoutWin.isVisible(), true, 'Restoring from Tray must restore Pop-Out call windows');
    assert.equal(popoutWin.webContents.isAudioMuted(), false, 'Restoring from Tray must unmute Pop-Out call windows');
    popoutWin.destroy();

    // Wait briefly for async logger flush and verify plaintext password was redacted
    await new Promise((r) => setTimeout(r, 150));
    const logContents = fs.existsSync(hooks.getLogFilePath())
      ? fs.readFileSync(hooks.getLogFilePath(), 'utf8')
      : '';
    assert.equal(logContents.includes('supersecretpass'), false, 'app.log must NEVER contain plaintext proxy password');

    // Verify background hibernation throttles Account 1 (currently hidden behind Account 2) WITHOUT muting audio!
    acc1Entry.view.webContents.setAudioMuted(false);
    await win.webContents.executeJavaScript('window.electronAPI.invoke("views:check-hibernation", { idleAccountIds: ["1"], memorySaverEnabled: true })');
    assert.equal(acc1Entry.isHibernated, true, 'Idle background Account 1 should hibernate');
    assert.equal(acc1Entry.view.webContents.getBackgroundThrottling(), true, 'Hibernated view must enable Chromium background throttling');
    assert.ok(acc1Entry.hibernationCssKey, 'Hibernated view must pause background CSS animations');
    assert.equal(acc1Entry.view.webContents.isAudioMuted(), false, 'Hibernated view must NOT mute incoming notification audio');

    // Verify permission handler blocks clipboard-read & third-party iframes while permitting discord.com media
    assert.equal(hooks.checkOriginPermission(acc1Entry.view.webContents, 'clipboard-read', 'https://discord.com/app'), false);
    assert.equal(hooks.checkOriginPermission(acc1Entry.view.webContents, 'microphone', 'https://www.youtube.com/embed/abc'), false);
    assert.equal(hooks.checkOriginPermission(acc1Entry.view.webContents, 'camera', 'https://12345.discordsays.com/'), false);
    assert.equal(hooks.checkOriginPermission(acc1Entry.view.webContents, 'microphone', 'https://discord.com/channels/@me'), true);
    assert.equal(hooks.checkOriginPermission(acc1Entry.view.webContents, 'display-capture', 'https://discord.com/channels/@me'), true);

    // Verify live proxy edit to unreachable port triggers non-occluded HTML error overlay (native view hidden)
    await win.webContents.executeJavaScript(
      `window.electronAPI.invoke("views:update-account-proxy", { accountId: ${JSON.stringify(acc2Id)}, proxy: "http://127.0.0.1:9" })`
    );
    await waitFor(async () => {
      const hasErrDom = await win.webContents.executeJavaScript(
        `Boolean(document.getElementById("error-overlay-" + ${JSON.stringify(acc2Id)}))`
      );
      return hasErrDom && acc2Entry.hasError === true && acc2Entry.view.getVisible() === false;
    }, 'Unreachable proxy triggers visible HTML error overlay with native view hidden');

    // Verify App Shell Reload (Ctrl+Shift+R / win.reload()) re-renders error card instead of a dead blank screen!
    win.reload();
    await waitFor(async () => {
      const hasErrAfterReload = await win.webContents.executeJavaScript(
        `typeof erroredAccounts !== "undefined" && Boolean(document.getElementById("error-overlay-" + ${JSON.stringify(acc2Id)}))`
      );
      return hasErrAfterReload && acc2Entry.view.getVisible() === false;
    }, 'App shell reload must preserve error overlay on errored account');

    // Restore valid proxy before Split View test
    await win.webContents.executeJavaScript(
      `window.electronAPI.invoke("views:update-account-proxy", { accountId: ${JSON.stringify(acc2Id)}, proxy: ${JSON.stringify(proxyUrl)} })`
    );
    await waitFor(() => acc2Entry.hasError === false && acc2Entry.view.getVisible() === true, 'Account 2 recovers when valid proxy restored');

    // 7. Verify Dual Split View + Account Removal with Pre-Checked Session Wipe
    console.log('[E2E 7/8] Checking Dual Split View & Account Removal with clearStorageData() wipe...');
    await win.webContents.executeJavaScript('document.getElementById("btn-split-view").click()');
    await waitFor(() => hooks.getLayoutState().isSplitView === true);
    assert.equal(acc1Entry.view.getVisible(), true);
    assert.equal(acc2Entry.view.getVisible(), true);
    const b1 = acc1Entry.view.getBounds();
    const b2 = acc2Entry.view.getBounds();
    assert.ok(b1.width > 200 && b2.width > 200);
    assert.ok(Math.max(b1.x, b2.x) >= Math.min(b1.x, b2.x) + Math.min(b1.width, b2.width) + 2);

    // Plant an auth cookie in Account 2's persistent session to verify removal wipes it
    const acc2Session = session.fromPartition(`persist:discord_account_${acc2Id}`);
    await acc2Session.cookies.set({
      url: `http://127.0.0.1:${servers.discordPort}`,
      name: 'discord_test_token',
      value: 'sensitive_token_value',
      expirationDate: Math.floor(Date.now() / 1000) + 86400
    });
    const cookiesBefore = await acc2Session.cookies.get({ name: 'discord_test_token' });
    assert.equal(cookiesBefore.length, 1);

    await win.webContents.executeJavaScript(`openRemoveAccountModal(${JSON.stringify(acc2Id)})`);
    await waitFor(() => hooks.getLayoutState().overlayBlocked === true);
    const wipeCheckedByDefault = await win.webContents.executeJavaScript(
      'document.getElementById("checkbox-wipe-account-data").checked'
    );
    assert.equal(wipeCheckedByDefault, true, 'Wipe session data checkbox must be checked by default');

    await win.webContents.executeJavaScript('document.getElementById("btn-remove-account-confirm").click()');
    await waitFor(() => hooks.getAccountViews().size === 1 && hooks.getLayoutState().overlayBlocked === false);

    const cookiesAfter = await acc2Session.cookies.get({ name: 'discord_test_token' });
    assert.equal(cookiesAfter.length, 0, 'Account removal must wipe session cookies & storage by default');
    assert.equal(hooks.getLayoutState().isSplitView, false, 'Removing 2nd account must exit Split View cleanly');
    assert.equal(acc1Entry.view.getVisible(), true, 'Remaining Account 1 must be visible in Single View');

    // 8. Verify Boss Key + System Tray Restore Audio Unlock & Screen-Share Audio Patch
    console.log('[E2E 8/8] Checking Boss Key + Tray Restore audio recovery & Screen-Share Audio Patch...');
    win.show();
    acc1Entry.view.webContents.setAudioMuted(false);
    assert.equal(acc1Entry.view.webContents.isAudioMuted(), false);

    hooks.handleBossKey(); // Hides window & mutes
    assert.equal(win.isVisible(), false);
    assert.equal(hooks.isBossKeyMuted(), true);
    assert.equal(acc1Entry.view.webContents.isAudioMuted(), true);

    hooks.toggleWindow(); // Simulates clicking System Tray icon (NOT pressing Boss Key!)
    assert.equal(win.isVisible(), true);
    assert.equal(hooks.isBossKeyMuted(), false, 'System Tray restore must clear Boss Key mute state');
    assert.equal(acc1Entry.view.webContents.isAudioMuted(), false, 'Account audio must be restored after Tray show');

    // Second cycle + Deafen All -> Boss Key -> Undeafen while hidden -> Tray restore independence check!
    await win.webContents.executeJavaScript('window.electronAPI.invoke("views:set-deafen-all", { deafened: true })');
    assert.equal(acc1Entry.view.webContents.isAudioMuted(), true);
    hooks.handleBossKey();
    await win.webContents.executeJavaScript('window.electronAPI.invoke("views:set-deafen-all", { deafened: false })');
    hooks.toggleWindow();
    assert.equal(
      acc1Entry.view.webContents.isAudioMuted(),
      false,
      'Undeafening while hidden under Boss Key must NOT leave accounts muted after restore'
    );

    // Verify Screen-Share Custom Audio Patch inside Account 1's WebContentsView:
    // (a) withAudio = false -> does NOT call getUserMedia even when custom device is selected
    // (b) withAudio = true -> matches concrete device over 'default' and stops customTrack when videoTrack.stop() runs
    const patchVerification = await acc1Entry.view.webContents.executeJavaScript(`
      (async () => {
        window.__testGumState = { gumCalls: 0, customStopped: false, lastGumDeviceId: null };

        // Install controlled mocks underneath our patched getDisplayMedia
        const fakeVideoTrack = () => {
          let stopped = false;
          const listeners = {};
          return {
            kind: 'video',
            get readyState() { return stopped ? 'ended' : 'live'; },
            addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
            stop() { stopped = true; }
          };
        };

        // Re-patch against fresh mock mediaDevices to test the exact injected wrapper logic
        delete window.__discordMultiSpaceAudioPatched;
        navigator.mediaDevices.enumerateDevices = async () => [
          { kind: 'audioinput', deviceId: 'default', label: 'Default - Voicemeeter Out B2' },
          { kind: 'audioinput', deviceId: 'real-b2', label: 'Voicemeeter Out B2' }
        ];
        navigator.mediaDevices.getUserMedia = async (c) => {
          window.__testGumState.gumCalls += 1;
          window.__testGumState.lastGumDeviceId = c && c.audio && c.audio.deviceId && c.audio.deviceId.exact;
          const t = {
            kind: 'audio',
            enabled: true,
            stop() { window.__testGumState.customStopped = true; }
          };
          return { getAudioTracks: () => [t], getTracks: () => [t] };
        };
        navigator.mediaDevices.getDisplayMedia = async () => {
          const vt = fakeVideoTrack();
          const tracks = [vt];
          return {
            getVideoTracks: () => tracks.filter((x) => x.kind === 'video'),
            getAudioTracks: () => tracks.filter((x) => x.kind === 'audio'),
            addTrack: (t) => tracks.push(t),
            removeTrack: (t) => { const i = tracks.indexOf(t); if (i >= 0) tracks.splice(i, 1); }
          };
        };
        return { ready: true };
      })()
    `);
    assert.equal(patchVerification.ready, true);

    // Re-trigger dom-ready bridge injection on mock mediaDevices by navigating in-page
    await acc1Entry.view.webContents.executeJavaScript('history.pushState({}, "", "/app#stream-test")');
    await new Promise((r) => setTimeout(r, 80));

    const audioTestResult = await acc1Entry.view.webContents.executeJavaScript(`
      (async () => {
        window.__discordMultiSpaceAudioDeviceLabel = 'Voicemeeter Out B2';

        // Case A: User unchecked "Share Audio" -> must NOT call getUserMedia!
        window.__discordMultiSpaceShareAudio = false;
        const streamNoAudio = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const audioTracksWhenUnchecked = streamNoAudio.getAudioTracks().length;

        // Case B: User checked "Share Audio" -> must inject custom track & stop it when video stops!
        window.__discordMultiSpaceShareAudio = true;
        const streamWithAudio = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const audioTracksWhenChecked = streamWithAudio.getAudioTracks().length;
        streamWithAudio.getVideoTracks()[0].stop();

        return {
          audioTracksWhenUnchecked,
          audioTracksWhenChecked,
          gumCalls: window.__testGumState.gumCalls,
          lastGumDeviceId: window.__testGumState.lastGumDeviceId,
          customStopped: window.__testGumState.customStopped
        };
      })()
    `);
    assert.equal(audioTestResult.audioTracksWhenUnchecked, 0, 'Unchecked Share Audio must stream 0 audio tracks');
    assert.equal(audioTestResult.audioTracksWhenChecked, 1, 'Checked Share Audio must attach custom audio track');
    assert.equal(audioTestResult.gumCalls, 1, 'getUserMedia must only be called when Share Audio is checked');
    assert.equal(audioTestResult.lastGumDeviceId, 'real-b2', 'Must match concrete device over Default alias');
    assert.equal(audioTestResult.customStopped, true, 'Stopping video track must release custom audio capture handle');

    // 9. Verify Updater Error Recovery, Pop-Out Share Audio Sync, Orphaned Screen Picker Cleanup, IME/Quota/WebP & Window Persistence
    console.log('[E2E 9/9] Checking Updater Error Recovery, Pop-Out Audio Sync, Orphaned Screen Picker, IME/Quota/WebP & Window State...');

    // 9a. Real electron-updater HTTP check & mid-stream download failure deduplication + UI recovery
    await win.webContents.executeJavaScript(`
      window.__e2eUpdateErrorCount = 0;
      window.electronAPI.on('update-error', () => { window.__e2eUpdateErrorCount += 1; });
      true;
    `);

    const fakeExePayload = Buffer.alloc(128 * 1024, 0x4d);
    const fakeExeSha512 = crypto.createHash('sha512').update(fakeExePayload).digest('base64');
    let failLatestYml = true;
    let abortExeDownloadMidStream = true;
    const updateServer = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/latest.yml')) {
        if (failLatestYml) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
        const yml = [
          'version: 99.0.0',
          'files:',
          '  - url: Discord-MultiSpace-Setup-99.0.0.exe',
          `    sha512: ${fakeExeSha512}`,
          `    size: ${fakeExePayload.length}`,
          'path: Discord-MultiSpace-Setup-99.0.0.exe',
          `sha512: ${fakeExeSha512}`,
          "releaseDate: '2026-11-24T00:00:00.000Z'"
        ].join('\n');
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        res.end(yml);
        return;
      }
      if (req.url && req.url.includes('Discord-MultiSpace-Setup-99.0.0.exe') && !req.url.includes('.blockmap')) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fakeExePayload.length)
        });
        if (abortExeDownloadMidStream) {
          res.write(fakeExePayload.subarray(0, 48 * 1024));
          setTimeout(() => res.destroy(new Error('Simulated mid-stream reset')), 40);
          return;
        }
        res.end(fakeExePayload);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    await new Promise((resolve) => updateServer.listen(0, '127.0.0.1', resolve));
    const updateFeedUrl = `http://127.0.0.1:${updateServer.address().port}`;

    const realAutoUpdater = hooks.getAutoUpdater();
    const updaterCacheDirName = `multispace-e2e-updater-cache-${Date.now()}-${process.pid}`;
    const devUpdateCfgPath = path.join(tempUserData, 'dev-app-update.yml');
    fs.writeFileSync(
      devUpdateCfgPath,
      `provider: generic\nurl: ${updateFeedUrl}\nupdaterCacheDirName: ${updaterCacheDirName}\n`,
      'utf8'
    );
    realAutoUpdater.forceDevUpdateConfig = true;
    realAutoUpdater.updateConfigPath = devUpdateCfgPath;
    realAutoUpdater.setFeedURL({ provider: 'generic', url: updateFeedUrl });

    try {
      // 9a-i. Failing checkForUpdates() must emit update-error ONCE (no emit+catch duplication)
      hooks.triggerUpdateCheck(true);
      await waitFor(async () => {
        const c = await win.webContents.executeJavaScript('window.__e2eUpdateErrorCount');
        return c >= 1;
      }, 'Expected update-error on HTTP 500 latest.yml');
      await new Promise((r) => setTimeout(r, 120));
      const checkErrCount = await win.webContents.executeJavaScript('window.__e2eUpdateErrorCount');
      assert.equal(checkErrCount, 1, 'Failed autoUpdater.checkForUpdates() must emit update-error exactly once');

      // 9a-ii. Successful checkForUpdates() -> explicit downloadUpdate() -> mid-stream TCP reset -> single update-error + full UI recovery
      failLatestYml = false;
      hooks.triggerUpdateCheck(true);
      await waitFor(async () => {
        const disp = await win.webContents.executeJavaScript('document.getElementById("update-notification-banner").style.display');
        return disp === 'block';
      }, 'Expected real update-available banner from local feed');

      await win.webContents.executeJavaScript('window.__e2eUpdateErrorCount = 0; document.getElementById("btn-banner-action").click();');
      await waitFor(async () => {
        const c = await win.webContents.executeJavaScript('window.__e2eUpdateErrorCount');
        return c >= 1;
      }, 'Expected real downloadUpdate() mid-stream TCP reset to emit update-error');
      await new Promise((r) => setTimeout(r, 150));

      const downloadErrCount = await win.webContents.executeJavaScript('window.__e2eUpdateErrorCount');
      assert.equal(downloadErrCount, 1, 'Failed autoUpdater.downloadUpdate() must emit update-error exactly once');

      const recoveredUpdaterState = await waitFor(async () => {
        const s = await win.webContents.executeJavaScript(`({
          progressDisplay: document.getElementById('updater-progress-container').style.display,
          progressWidth: document.getElementById('updater-progress-bar').style.width,
          bannerDisabled: document.getElementById('btn-banner-action').disabled,
          bannerText: document.getElementById('btn-banner-action').textContent,
          bannerDesc: document.getElementById('update-banner-desc').textContent,
          settingsBtnDisabled: document.getElementById('btn-download-update').disabled,
          settingsBtnText: document.getElementById('btn-download-update').textContent,
          checkBtnDisabled: document.getElementById('btn-check-updates').disabled,
          statusText: document.getElementById('updater-status-text').textContent
        })`);
        return s.progressDisplay === 'none' && s.bannerDisabled === false ? s : null;
      });
      assert.equal(recoveredUpdaterState.progressWidth, '0%', 'Progress bar width must reset on update-error');
      assert.equal(recoveredUpdaterState.bannerText, 'Download Update', 'Banner action button must recover on update-error');
      assert.equal(recoveredUpdaterState.settingsBtnDisabled, false, 'Settings download button must re-enable on update-error');
      assert.equal(recoveredUpdaterState.checkBtnDisabled, false, 'Check for Updates button must re-enable on update-error');
      assert.equal(recoveredUpdaterState.settingsBtnText, 'Download Update');
      assert.equal(recoveredUpdaterState.bannerDesc.includes('Downloading'), false, 'Banner desc must not stay stuck in Downloading...');
      assert.equal(recoveredUpdaterState.statusText, 'Update download failed');

      // 9a-iii. Retry download after failure succeeds cleanly via real electron-updater!
      abortExeDownloadMidStream = false;
      await win.webContents.executeJavaScript('document.getElementById("btn-banner-action").click()');
      await waitFor(async () => {
        const text = await win.webContents.executeJavaScript('document.getElementById("btn-banner-action").textContent');
        return text === 'Install & Restart';
      }, 'Retry after failed download must complete and reach Install & Restart state');

      // Verify manual update-error after update is already downloaded does NOT clobber Install & Restart state
      win.webContents.send('update-error', { message: 'Offline check', manual: true });
      await new Promise((r) => setTimeout(r, 80));
      const postDownloadState = await win.webContents.executeJavaScript(`({
        bannerText: document.getElementById('btn-banner-action').textContent,
        installVisible: document.getElementById('btn-install-update').style.display
      })`);
      assert.equal(postDownloadState.bannerText, 'Install & Restart', 'Ready-to-install banner must not be clobbered by later check error');
      assert.equal(postDownloadState.installVisible, 'inline-block');
      await win.webContents.executeJavaScript('document.getElementById("btn-banner-dismiss").click()');
    } finally {
      realAutoUpdater.forceDevUpdateConfig = false;
      updateServer.close();
      try {
        if (process.env.LOCALAPPDATA) {
          fs.rmSync(path.join(process.env.LOCALAPPDATA, updaterCacheDirName), { recursive: true, force: true });
        }
      } catch {}
    }

    // 9b. Pop-Out Call Window Share Audio sync (real getDisplayMedia track test + Split-View account isolation) & Orphaned Screen Picker races
    const origGetSources = desktopCapturer.getSources.bind(desktopCapturer);
    let getSourcesDelayMs = 0;
    desktopCapturer.getSources = async () => {
      const delay = getSourcesDelayMs;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return [
        {
          id: 'screen:0:0',
          name: 'Entire Screen',
          display_id: '0',
          thumbnail: { isEmpty: () => true, toDataURL: () => '' },
          appIcon: null
        },
        {
          id: 'window:42:0',
          name: 'Test Game Window',
          display_id: '',
          thumbnail: { isEmpty: () => true, toDataURL: () => '' },
          appIcon: null
        }
      ];
    };

    try {
      // Configure custom audio device ('Voicemeeter Out B2') to verify Pop-Out respects unchecked & checked Share Audio
      await win.webContents.executeJavaScript('window.electronAPI.send("set-stream-audio-device", "Voicemeeter Out B2")');
      await new Promise((r) => setTimeout(r, 80));

      const winsBeforeAudioPopout = BrowserWindow.getAllWindows().length;
      await acc1Entry.view.webContents.executeJavaScript(
        'window.__audioPop = window.open("about:blank", "discord_call_popout_audio", "width=420,height=320"); true;'
      );
      await waitFor(() => BrowserWindow.getAllWindows().length > winsBeforeAudioPopout, 'Pop-out call window created');
      const audioPopoutWin = BrowserWindow.getAllWindows().find((w) => w !== win);
      assert.ok(audioPopoutWin, 'Expected Pop-Out call BrowserWindow');

      await waitFor(async () => {
        return await audioPopoutWin.webContents.executeJavaScript(
          'Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && navigator.mediaDevices.getDisplayMedia.__discordMultiSpacePatched)'
        );
      }, 'DISCORD_MEDIA_AUDIO_PATCH must wrap navigator.mediaDevices.getDisplayMedia inside about:blank Pop-Out window');

      // Trigger displayMedia request from Pop-Out window and select source with Share Audio UNCHECKED (false)
      let resolvedMedia1 = null;
      await hooks.handleDisplayMediaRequest(
        { frame: audioPopoutWin.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => {
          resolvedMedia1 = selection;
        },
        audioPopoutWin.webContents.session
      );
      await waitFor(async () => {
        return await win.webContents.executeJavaScript(
          'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
        );
      }, 'Screen Picker modal opened');

      await win.webContents.executeJavaScript(`
        selectScreenPickerSource('window:42:0');
        document.getElementById('screen-picker-audio-toggle').checked = false;
        submitScreenPicker();
      `);
      await waitFor(() => resolvedMedia1 !== null, 'screen-picker-select resolved displayMedia callback');
      assert.equal(resolvedMedia1.video.id, 'window:42:0');
      assert.equal(resolvedMedia1.audio, undefined);

      const popoutShareAudioFalse = await audioPopoutWin.webContents.executeJavaScript('window.__discordMultiSpaceShareAudio');
      assert.equal(
        popoutShareAudioFalse,
        false,
        'screen-picker-select must sync window.__discordMultiSpaceShareAudio = false to Pop-Out call windows'
      );

      // Re-select on Account 1 Pop-Out with Share Audio = true
      await new Promise((r) => setTimeout(r, 2050));
      let resolvedMedia2 = null;
      await hooks.handleDisplayMediaRequest(
        { frame: audioPopoutWin.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => {
          resolvedMedia2 = selection;
        },
        audioPopoutWin.webContents.session
      );
      await waitFor(async () => {
        return await win.webContents.executeJavaScript(
          'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
        );
      });
      await win.webContents.executeJavaScript(`
        selectScreenPickerSource('screen:0:0');
        document.getElementById('screen-picker-audio-toggle').checked = true;
        submitScreenPicker();
      `);
      await waitFor(() => resolvedMedia2 !== null);
      assert.equal(resolvedMedia2.audio, 'loopback');
      assert.equal(await audioPopoutWin.webContents.executeJavaScript('window.__discordMultiSpaceShareAudio'), true);

      // Verify Split-View cross-account isolation: Account 2 selecting Share Audio = false must NOT overwrite Account 1's Pop-Out Share Audio = true!
      await win.webContents.executeJavaScript(`
        (async () => {
          accounts.push({ id: 'temp_picker', name: 'Temp Picker Acc', color: '#23A55A', proxy: '' });
          saveAccounts();
          renderAccountStack();
          await syncAccountsWithMain();
        })()
      `);
      await waitFor(() => hooks.getAccountViews().has('temp_picker'));
      const tempEntry = hooks.getAccountViews().get('temp_picker');
      await waitFor(async () => {
        const text = await tempEntry.view.webContents.executeJavaScript(
          'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
        );
        return text.includes('Mock Discord Loaded');
      });

      let tempResolved = null;
      await hooks.handleDisplayMediaRequest(
        { frame: tempEntry.view.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => { tempResolved = selection; },
        tempEntry.view.webContents.session
      );
      await waitFor(async () => {
        return await win.webContents.executeJavaScript(
          'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
        );
      });
      await win.webContents.executeJavaScript(`
        selectScreenPickerSource('window:42:0');
        document.getElementById('screen-picker-audio-toggle').checked = false;
        submitScreenPicker();
      `);
      await waitFor(() => tempResolved !== null);
      assert.equal(await tempEntry.view.webContents.executeJavaScript('window.__discordMultiSpaceShareAudio'), false);
      assert.equal(
        await audioPopoutWin.webContents.executeJavaScript('window.__discordMultiSpaceShareAudio'),
        true,
        'Account 2 video-only stream must NOT mute Account 1 Pop-Out Share Audio state'
      );
      audioPopoutWin.destroy();
      await win.webContents.executeJavaScript('window.electronAPI.send("set-stream-audio-device", "loopback")');

      // 9c. Orphaned Screen Picker modal cleanup + Concurrent Split-View superseding & slow getSources() races
      await new Promise((r) => setTimeout(r, 2050));

      // 9c-i. Account 1 opens Screen Picker, Account 2 immediately supersedes it, then Account 1 reloads -> Account 2's picker MUST stay open!
      let supersededAcc1Res = null;
      let activeAcc2Res = null;
      await hooks.handleDisplayMediaRequest(
        { frame: acc1Entry.view.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => { supersededAcc1Res = selection; },
        acc1Entry.view.webContents.session
      );
      await waitFor(() => hooks.getPendingDisplayMediaRequests().size === 1);

      await hooks.handleDisplayMediaRequest(
        { frame: tempEntry.view.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => { activeAcc2Res = selection; },
        tempEntry.view.webContents.session
      );
      assert.deepEqual(supersededAcc1Res, {}, 'Superseded Account 1 request must resolve empty');
      await waitFor(() => hooks.getPendingDisplayMediaRequests().size === 1 && hooks.getLayoutState().overlayBlocked === true);

      // Reload Account 1 while Account 2's Screen Picker is active -> Account 2's picker MUST NOT close!
      await win.webContents.executeJavaScript('window.electronAPI.send("views:reload-account", { accountId: "1", ignoreCache: false })');
      await new Promise((r) => setTimeout(r, 150));
      const acc2PickerStillOpen = await win.webContents.executeJavaScript(
        'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
      );
      assert.equal(acc2PickerStillOpen, true, 'Reloading Account 1 must NOT dismiss Account 2 active Screen Picker');
      assert.equal(activeAcc2Res, null);

      // Now remove Account 2 (temp_picker) while its Screen Picker is open -> MUST close modal & unblock overlay!
      await win.webContents.executeJavaScript(`
        (async () => {
          await window.electronAPI.invoke('views:remove-account', { accountId: 'temp_picker', wipeSessionData: true });
          accounts = accounts.filter((a) => a.id !== 'temp_picker');
          saveAccounts();
          renderAccountStack();
        })()
      `);
      await waitFor(async () => {
        const pickerOpen = await win.webContents.executeJavaScript(
          'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
        );
        return !pickerOpen && hooks.getLayoutState().overlayBlocked === false && hooks.getPendingDisplayMediaRequests().size === 0;
      }, 'Removing account while Screen Picker is open must close modal and unblock overlay');
      assert.deepEqual(activeAcc2Res, {});

      // Wait for Account 1 reload to settle, then verify reloading Account 1 while its own picker is open closes modal!
      await waitFor(async () => {
        const text = await acc1Entry.view.webContents.executeJavaScript(
          'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
        );
        return text.includes('Mock Discord Loaded');
      });

      let reloadCancelledResult = null;
      await hooks.handleDisplayMediaRequest(
        { frame: acc1Entry.view.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => { reloadCancelledResult = selection; },
        acc1Entry.view.webContents.session
      );
      await waitFor(() => hooks.getPendingDisplayMediaRequests().size === 1 && hooks.getLayoutState().overlayBlocked === true);
      await win.webContents.executeJavaScript('window.electronAPI.send("views:reload-account", { accountId: "1", ignoreCache: false })');
      await waitFor(async () => {
        const pickerOpen = await win.webContents.executeJavaScript(
          'document.getElementById("screen-picker-modal-overlay").classList.contains("active")'
        );
        return !pickerOpen && hooks.getLayoutState().overlayBlocked === false && hooks.getPendingDisplayMediaRequests().size === 0;
      }, 'Reloading account while its Screen Picker is open must close modal and unblock overlay');
      assert.deepEqual(reloadCancelledResult, {});

      // Also verify reload DURING slow getSources() aborts cleanly without opening Screen Picker
      await waitFor(async () => {
        const text = await acc1Entry.view.webContents.executeJavaScript(
          'document.getElementById("mock-discord") ? document.getElementById("mock-discord").textContent : ""'
        );
        return text.includes('Mock Discord Loaded');
      });
      getSourcesDelayMs = 160;
      let midEnumCancelled = null;
      const midEnumPromise = hooks.handleDisplayMediaRequest(
        { frame: acc1Entry.view.webContents.mainFrame, securityOrigin: 'https://discord.com' },
        (selection) => { midEnumCancelled = selection; },
        acc1Entry.view.webContents.session
      );
      await new Promise((r) => setTimeout(r, 30));
      hooks.cancelPendingDisplayMediaForAccount('1', 'test-mid-enum-reload');
      await midEnumPromise;
      getSourcesDelayMs = 0;
      assert.deepEqual(midEnumCancelled, {}, 'Cancelling account mid-getSources() must abort without opening picker');
      assert.equal(hooks.getPendingDisplayMediaRequests().size, 0);
    } finally {
      desktopCapturer.getSources = origGetSources;
    }

    // 9d. Modal Enter IME composition guard, double/repeat Enter re-entrancy guard, topmost Escape order, WebP crop & quota resilience
    await win.webContents.executeJavaScript('document.getElementById("btn-add-account").click()');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === true);

    const imeAndWebpResult = await win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('input-account-name').value = 'あいり';
        document.getElementById('input-account-name').focus();
        const accountsBeforeIme = accounts.length;

        // Dispatch Enter AND Escape while isComposing = true -> neither should submit nor close modal!
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 60));

        const modalStillOpenAfterIme = document.getElementById('modal-overlay').classList.contains('active');
        const accountsAfterIme = accounts.length;

        // Open Settings modal on top of Add Account modal and press Escape -> ONLY Settings modal should close!
        await openSettingsModal();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const settingsClosedFirst = !document.getElementById('settings-modal-overlay').classList.contains('active');
        const addModalremainedOpen = document.getElementById('modal-overlay').classList.contains('active');

        // Generate a synthetic 96x64 PNG File and run handleAvatarFile(file) -> must encode data:image/webp
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = 96;
        srcCanvas.height = 64;
        const sctx = srcCanvas.getContext('2d');
        sctx.fillStyle = '#5865F2';
        sctx.fillRect(0, 0, 96, 64);
        const pngBlob = await new Promise((resolve) => srcCanvas.toBlob(resolve, 'image/png'));
        const avatarFile = new File([pngBlob], 'avatar.png', { type: 'image/png' });
        handleAvatarFile(avatarFile);

        const start = Date.now();
        while (!currentAvatarDataUrl && Date.now() - start < 3000) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const encodedAvatarPrefix = currentAvatarDataUrl ? currentAvatarDataUrl.slice(0, 23) : '';

        // Dispatch rapid triple Enter (including e.repeat = true) -> must create AT MOST ONE account (no re-entrant duplicates)!
        document.getElementById('input-account-name').value = 'SingleSubmitAcc';
        document.getElementById('input-account-name').focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        const waitSubmitStart = Date.now();
        while (document.getElementById('modal-overlay').classList.contains('active') && Date.now() - waitSubmitStart < 4000) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const createdMatches = accounts.filter((a) => a.name === 'SingleSubmitAcc');
        const singleAccountCreated = createdMatches.length === 1;

        // Clean up the test account
        if (createdMatches[0]) {
          await window.electronAPI.invoke('views:remove-account', { accountId: createdMatches[0].id, wipeSessionData: true });
          accounts = accounts.filter((a) => a.id !== createdMatches[0].id);
          saveAccounts();
          renderAccountStack();
        }

        // Simulate localStorage QuotaExceededError inside saveAccounts() -> must return false without throwing!
        const origSetItem = Storage.prototype.setItem;
        let quotaCaughtCleanly = false;
        try {
          Storage.prototype.setItem = function() {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          };
          const saveRes = saveAccounts();
          quotaCaughtCleanly = (saveRes === false);
        } finally {
          Storage.prototype.setItem = origSetItem;
        }

        return {
          modalStillOpenAfterIme,
          accountsUnchanged: accountsBeforeIme === accountsAfterIme,
          settingsClosedFirst,
          addModalremainedOpen,
          singleAccountCreated,
          encodedAvatarPrefix,
          quotaCaughtCleanly
        };
      })()
    `);
    assert.equal(imeAndWebpResult.modalStillOpenAfterIme, true, 'IME composition Enter/Escape must not submit or dismiss modal');
    assert.equal(imeAndWebpResult.accountsUnchanged, true, 'IME Enter must not create an account prematurely');
    assert.equal(imeAndWebpResult.settingsClosedFirst, true, 'Escape must close topmost Settings modal');
    assert.equal(imeAndWebpResult.addModalremainedOpen, true, 'Escape must not close underlying modal simultaneously');
    assert.equal(imeAndWebpResult.singleAccountCreated, true, 'Rapid double/repeat Enter must create exactly 1 account');
    assert.equal(imeAndWebpResult.encodedAvatarPrefix, 'data:image/webp;base64,', 'Avatar crops must encode compact image/webp');
    assert.equal(imeAndWebpResult.quotaCaughtCleanly, true, 'saveAccounts() must catch QuotaExceededError gracefully');
    await waitFor(() => hooks.getLayoutState().overlayBlocked === false);

    // 9e. Window bounds & maximized state persistence in settings.json + Minimize-from-Maximized Windows regression check
    win.setBounds({ x: 140, y: 110, width: 1120, height: 720 });
    hooks.captureCurrentWindowState();
    hooks.saveMainSettingsSync();
    const persistedDiskSettings = JSON.parse(fs.readFileSync(hooks.getSettingsFilePath(), 'utf8'));
    assert.equal(persistedDiskSettings.windowState.width, 1120);
    assert.equal(persistedDiskSettings.windowState.height, 720);
    assert.equal(persistedDiskSettings.windowState.isMaximized, false);
    assert.equal(Number.isFinite(persistedDiskSettings.windowState.x), true);
    assert.equal(Number.isFinite(persistedDiskSettings.windowState.y), true);

    // Write an off-screen unplugged-monitor state with isMaximized=true and verify real createWindow() clamps & restores!
    fs.writeFileSync(
      hooks.getSettingsFilePath(),
      JSON.stringify({
        ...persistedDiskSettings,
        windowState: { x: 88000, y: 88000, width: 1180, height: 740, isMaximized: true }
      }, null, 2),
      'utf8'
    );
    app.isQuitting = false;
    win.destroy();
    hooks.loadMainSettings();
    hooks.createWindow();
    const recreatedWin = hooks.getMainWindow();
    assert.ok(recreatedWin && !recreatedWin.isDestroyed(), 'Expected recreated BrowserWindow');
    const recreatedBounds = recreatedWin.getBounds();
    const liveDisplays = screen.getAllDisplays();
    const primaryDisp = screen.getPrimaryDisplay();
    const taggedDisplays = liveDisplays.map((d) => (primaryDisp && d.id === primaryDisp.id ? { ...d, isPrimary: true } : d));
    const expectedClamped = sanitizeWindowState(hooks.getMainSettings().windowState, taggedDisplays, {
      width: 1280,
      height: 800,
      minWidth: 940,
      minHeight: 560
    });
    assert.equal(recreatedBounds.width, expectedClamped.width, 'Recreated BrowserWindow must restore saved width');
    assert.equal(recreatedBounds.height, expectedClamped.height, 'Recreated BrowserWindow must restore saved height');
    if (primaryDisp && primaryDisp.workArea) {
      const wa = primaryDisp.workArea;
      assert.ok(recreatedBounds.x >= wa.x && recreatedBounds.x + recreatedBounds.width <= wa.x + wa.width, 'Recreated BrowserWindow x must be clamped onto primary display');
      assert.ok(recreatedBounds.y >= wa.y && recreatedBounds.y + recreatedBounds.height <= wa.y + wa.height, 'Recreated BrowserWindow y must be clamped onto primary display');
    }
    // Even while started hidden before first show, capturing window state must preserve pending isMaximized=true!
    hooks.captureCurrentWindowState();
    assert.equal(hooks.getMainSettings().windowState.isMaximized, true, 'Deferred maximize state must not be clobbered while hidden');

    // Show recreatedWin -> deferred maximize triggers -> then minimize() -> wait >300ms -> isMaximized MUST remain true on Windows!
    recreatedWin.showInactive();
    recreatedWin.maximize();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(recreatedWin.isMaximized(), true);
    recreatedWin.minimize();
    await new Promise((r) => setTimeout(r, 320));
    hooks.captureCurrentWindowState();
    const afterMinimizeFromMax = hooks.getMainSettings().windowState;
    assert.equal(
      afterMinimizeFromMax.isMaximized,
      true,
      'Minimizing a maximized BrowserWindow on Windows must NOT clobber windowState.isMaximized to false'
    );
    assert.equal(afterMinimizeFromMax.width, expectedClamped.width, 'Pre-maximize normal width must be preserved via getNormalBounds()');
    assert.equal(afterMinimizeFromMax.height, expectedClamped.height, 'Pre-maximize normal height must be preserved via getNormalBounds()');

    console.log('\n✅ ALL 9 ELECTRON 45 E2E INTEGRATION SUITES PASSED!');

    servers.discordServer.close();
    servers.proxyServer.close();
    app.isQuitting = true;
    recreatedWin.destroy();
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {}
    process.exit(0);
  } catch (err) {
    console.error('\n❌ E2E TEST FAILED:', err);
    if (servers) {
      try { servers.discordServer.close(); } catch {}
      try { servers.proxyServer.close(); } catch {}
    }
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {}
    process.exit(1);
  }
})();
