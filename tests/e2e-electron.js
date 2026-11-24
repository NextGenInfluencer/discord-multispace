'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, session } = require('electron');

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

    console.log('\n✅ ALL 8 ELECTRON 45 E2E INTEGRATION SUITES PASSED!');

    servers.discordServer.close();
    servers.proxyServer.close();
    app.isQuitting = true;
    win.destroy();
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
