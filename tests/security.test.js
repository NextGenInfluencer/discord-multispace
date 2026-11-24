'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isValidAccountId,
  isValidPartition,
  accountIdFromPartition,
  partitionForAccountId,
  redactSensitiveUrl,
  parseAndValidateProxy,
  isPrivateOrReservedIP,
  validateHttpsPublicUrl,
  safeFetchThemeCss,
  resolveThemeCssImports,
  transformDiscordCspHeader,
  isTrustedDiscordOrigin,
  classifyNavigationUrl,
  classifyPopupRequest,
  matchAudioInputDevice,
  computePaneBounds,
  parseDiscordTitleUnread,
  sanitizeWindowState
} = require('../lib/security');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Account ID and Partition strict validation', () => {
  assert.equal(isValidAccountId('1'), true);
  assert.equal(isValidAccountId('acc_123-XYZ'), true);
  assert.equal(isValidAccountId('a'.repeat(64)), true);

  // Boundary & attack rejections
  assert.equal(isValidAccountId(''), false);
  assert.equal(isValidAccountId(null), false);
  assert.equal(isValidAccountId(undefined), false);
  assert.equal(isValidAccountId(123), false);
  assert.equal(isValidAccountId('a'.repeat(65)), false);
  assert.equal(isValidAccountId('../etc/passwd'), false);
  assert.equal(isValidAccountId('acc/../2'), false);
  assert.equal(isValidAccountId('acc 1'), false);
  assert.equal(isValidAccountId('acc:1'), false);

  assert.equal(isValidPartition('persist:discord_account_1'), true);
  assert.equal(isValidPartition('persist:discord_account_work_01'), true);
  assert.equal(isValidPartition('persist:discord_account_'), false);
  assert.equal(isValidPartition('persist:discord_account_../evil'), false);
  assert.equal(isValidPartition('discord_account_1'), false);
  assert.equal(accountIdFromPartition('persist:discord_account_abc123'), 'abc123');
  assert.equal(accountIdFromPartition('persist:discord_account_../bad'), null);
  assert.equal(partitionForAccountId('42'), 'persist:discord_account_42');
  assert.throws(() => partitionForAccountId('../bad'));
});

test('Proxy parsing, credential stripping, fail-closed validation, and log redaction', () => {
  // Direct / empty cases
  for (const empty of ['', '   ', null, undefined]) {
    const res = parseAndValidateProxy(empty);
    assert.equal(res.valid, true);
    assert.equal(res.mode, 'direct');
    assert.equal(res.proxyRules, '');
    assert.equal(res.auth, null);
  }

  // Standard HTTP / SOCKS5 / bare host:port
  const httpSimple = parseAndValidateProxy('http://198.51.100.5:8080');
  assert.equal(httpSimple.valid, true);
  assert.equal(httpSimple.proxyRules, 'http://198.51.100.5:8080');
  assert.equal(httpSimple.auth, null);

  const bareHost = parseAndValidateProxy('127.0.0.1:8888');
  assert.equal(bareHost.valid, true);
  assert.equal(bareHost.proxyRules, 'http://127.0.0.1:8888');

  const socks = parseAndValidateProxy('socks5://127.0.0.1:1080');
  assert.equal(socks.valid, true);
  assert.equal(socks.proxyRules, 'socks5://127.0.0.1:1080');

  // Default ports 80 / 443
  const http80 = parseAndValidateProxy('http://proxy.example.com:80');
  assert.equal(http80.valid, true);
  assert.equal(http80.proxyRules, 'http://proxy.example.com:80');

  // Authenticated HTTP proxy: strips credentials from proxyRules and extracts decoded auth
  const authed = parseAndValidateProxy('http://alice:s3cr%40t%3Apass@203.0.113.9:3128');
  assert.equal(authed.valid, true);
  assert.equal(authed.proxyRules, 'http://203.0.113.9:3128');
  assert.deepEqual(authed.auth, { username: 'alice', password: 's3cr@t:pass' });
  assert.equal(authed.redacted, 'http://***:***@203.0.113.9:3128');
  assert.equal(authed.redacted.includes('s3cr'), false);

  // Authenticated SOCKS5 must be explicitly rejected (Chromium networking limitation)
  const socksAuthed = parseAndValidateProxy('socks5://user:pass@127.0.0.1:1080');
  assert.equal(socksAuthed.valid, false);
  assert.match(socksAuthed.error, /SOCKS/i);

  // Proxy-list injection & malformed inputs must fail closed
  for (const bad of [
    'not a url',
    'http://1.2.3.4:8080,direct://',
    'http://1.2.3.4:8080;https://direct',
    'ftp://1.2.3.4:21',
    'socks5://127.0.0.1',
    'http://1.2.3.4:99999',
    'http://1.2.3.4:8080/pac.js',
    'http://1.2.3.4:8080?bypass=1'
  ]) {
    const r = parseAndValidateProxy(bad);
    assert.equal(r.valid, false, `Expected invalid proxy for: ${bad}`);
  }

  // Redaction utility
  assert.equal(
    redactSensitiveUrl('Proxy failed for https://bob:mySecret123@proxy.host:8443/test'),
    'Proxy failed for https://***:***@proxy.host:8443/test'
  );
});

test('SSRF IPv4 and IPv6 private, loopback, metadata, and NAT64/mapped blocking', () => {
  const blockedIps = [
    '',
    'not-an-ip',
    '0.0.0.0',
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:192.168.1.1',
    '::ffff:0:127.0.0.1',
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::1',
    '64:ff9b:1:7f00:1::0808:0808',
    '100::1',
    'fec0::1',
    '2001:2::1',
    '2001:10::1',
    '2001:0000:4136:e378:8000:63bf:80ff:fffe',
    '2002:7f00:0001::1'
  ];

  for (const ip of blockedIps) {
    assert.equal(isPrivateOrReservedIP(ip), true, `Expected ${ip} to be blocked`);
  }

  const publicIps = [
    '1.1.1.1',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '::ffff:8.8.8.8',
    '2001:0000:4136:e378:8000:63bf:f7f7:f7f7',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888'
  ];

  for (const ip of publicIps) {
    assert.equal(isPrivateOrReservedIP(ip), false, `Expected ${ip} to be allowed as public`);
  }
});

test('safeFetchThemeCss & resolveThemeCssImports enforce HTTPS, DNS-pinning, multi-@import SSRF blocking, and 1MB cap', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];

  // 1. Cleartext HTTP rejected
  const httpRes = await safeFetchThemeCss('http://example.com/theme.css', { lookupFn: publicLookup });
  assert.equal(httpRes.success, false);
  assert.match(httpRes.error, /HTTPS/i);

  // 2. Localhost & private DNS rejected
  const localRes = await safeFetchThemeCss('https://localhost/theme.css', { lookupFn: publicLookup });
  assert.equal(localRes.success, false);

  const dnsRebindRes = await safeFetchThemeCss('https://theme.example.com/a.css', { lookupFn: privateLookup });
  assert.equal(dnsRebindRes.success, false);
  assert.match(dnsRebindRes.error, /private|loopback/i);

  // 2b. DNS Rebinding TOCTOU Defense: real fetchHttpsPinned path calls lookupFn ONLY ONCE per hop (pins validated IP!)
  let rebindLookupCalls = 0;
  const rebindAttemptLookup = async () => {
    rebindLookupCalls += 1;
    // First call returns unreachable TEST-NET/public IP (or fast-refused); second call would return 127.0.0.1 if unpinned!
    if (rebindLookupCalls === 1) return [{ address: '127.0.0.1', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const pinnedCheck = await safeFetchThemeCss('https://rebind.example.com/evil.css', {
    lookupFn: rebindAttemptLookup,
    timeoutMs: 250
  });
  assert.equal(pinnedCheck.success, false);
  assert.equal(rebindLookupCalls, 1, 'lookupFn must be invoked once and blocked before socket connect');

  // Also test when 1st lookup returns a public IP while no fetchFn is supplied: lookupFn is STILL called only once (never re-queried!)
  let singleLookupCount = 0;
  await safeFetchThemeCss('https://rebind2.example.com:65534/evil.css', {
    lookupFn: async () => {
      singleLookupCount += 1;
      return singleLookupCount === 1
        ? [{ address: '1.1.1.1', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
    timeoutMs: 150
  });
  assert.equal(singleLookupCount, 1, 'Production HTTPS fetcher must pin the first validated DNS result without a 2nd lookup');

  // 3. 302 Redirect to loopback IP blocked!
  const redirectRes = await safeFetchThemeCss('https://theme.example.com/start.css', {
    lookupFn: publicLookup,
    fetchFn: async () => ({
      status: 302,
      ok: false,
      headers: new Map([['location', 'https://127.0.0.1/internal.css']])
    })
  });
  assert.equal(redirectRes.success, false);
  assert.match(redirectRes.error, /private|loopback/i);

  // 4. Oversized (> 1 MB) stylesheet blocked!
  const hugeCss = 'body { color: red; }\n'.repeat(60000); // > 1.2 MB
  const sizeRes = await safeFetchThemeCss('https://theme.example.com/huge.css', {
    lookupFn: publicLookup,
    maxBytes: 1024 * 1024,
    fetchFn: async () => ({
      status: 200,
      ok: true,
      headers: new Map(),
      text: async () => hugeCss
    })
  });
  assert.equal(sizeRes.success, false);
  assert.match(sizeRes.error, /maximum size limit/i);

  // 5. Valid HTTPS theme with relative @import resolved cleanly
  const validRes = await safeFetchThemeCss('https://theme.example.com/dir/main.css', {
    lookupFn: publicLookup,
    fetchFn: async (url) => {
      if (url === 'https://theme.example.com/dir/main.css') {
        return {
          status: 200,
          ok: true,
          headers: new Map(),
          text: async () => '@import url("./sub.css");\n.main { background: #000; }'
        };
      }
      if (url === 'https://theme.example.com/dir/sub.css') {
        return {
          status: 200,
          ok: true,
          headers: new Map(),
          text: async () => '.sub { color: #fff; }'
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  assert.equal(validRes.success, true);
  assert.match(validRes.css, /\.sub \{ color: #fff; \}/);
  assert.match(validRes.css, /\.main \{ background: #000; \}/);

  // 6. resolveThemeCssImports blocks quoted @import "http://..." & unquoted url(...) SSRF, and resolves multiple safe @imports!
  const quotedHttpImport = await resolveThemeCssImports('@import "http://127.0.0.1:9999/ssrf.css"; body { color: #fff; }', {
    lookupFn: publicLookup
  });
  assert.equal(quotedHttpImport.success, false);
  assert.match(quotedHttpImport.error, /HTTPS/i);

  const secondImportSsrf = await resolveThemeCssImports(
    '@import url("https://theme.example.com/one.css");\n@import "https://127.0.0.1/two.css";',
    {
      lookupFn: publicLookup,
      fetchFn: async () => ({
        status: 200,
        ok: true,
        headers: new Map(),
        text: async () => '.one { color: #111; }'
      })
    }
  );
  assert.equal(secondImportSsrf.success, false);
  assert.match(secondImportSsrf.error, /private|loopback/i);

  const multiValid = await resolveThemeCssImports(
    '@import "https://theme.example.com/a.css";\n@import url("https://theme.example.com/b.css");\n:root { --ok: 1; }',
    {
      lookupFn: publicLookup,
      fetchFn: async (url) => ({
        status: 200,
        ok: true,
        headers: new Map(),
        text: async () => (url.endsWith('/a.css') ? '.a{color:red}' : '.b{color:blue}')
      })
    }
  );
  assert.equal(multiValid.success, true);
  assert.match(multiValid.css, /\.a\{color:red\}/);
  assert.match(multiValid.css, /\.b\{color:blue\}/);
  assert.match(multiValid.css, /--ok: 1/);
  assert.equal(/@import/i.test(multiValid.css), false);
});

test('Discord CSP header preservation — connect-src and script-src are NEVER weakened', () => {
  const sampleDiscordCsp =
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'nonce-abc123'; img-src 'self' https://cdn.discordapp.com; font-src 'self'; connect-src 'self' https://discord.com wss://gateway.discord.gg";

  // Default / Minimalist: 100% untouched byte-for-byte
  assert.equal(transformDiscordCspHeader(sampleDiscordCsp, false), sampleDiscordCsp);

  // Active custom theme: connect-src and script-src remain untouched, no wildcard '*', nonce directive not broken by 'unsafe-inline'
  const relaxed = transformDiscordCspHeader(sampleDiscordCsp, true);
  assert.match(relaxed, /connect-src 'self' https:\/\/discord\.com wss:\/\/gateway\.discord\.gg/);
  assert.match(relaxed, /script-src 'self' 'unsafe-inline'/);
  assert.equal(relaxed.includes('connect-src *'), false);
  assert.equal(relaxed.includes('style-src *'), false);
  assert.match(relaxed, /style-src 'self' 'unsafe-inline' https: data: blob:/);
  assert.match(relaxed, /style-src-elem 'self' 'nonce-abc123' https: data: blob:/);
  assert.equal(/style-src-elem[^;]*'unsafe-inline'/.test(relaxed), false);
});

test('Origin, navigation, redirect, and popup classification guards', () => {
  assert.equal(isTrustedDiscordOrigin('https://discord.com/app'), true);
  assert.equal(isTrustedDiscordOrigin('https://ptb.discord.com/channels/@me'), true);
  assert.equal(isTrustedDiscordOrigin('http://discord.com/app'), false);
  assert.equal(isTrustedDiscordOrigin('https://discord.com.evil.org/app'), false);
  assert.equal(isTrustedDiscordOrigin('https://youtube.com/embed/xyz'), false);
  assert.equal(isTrustedDiscordOrigin('https://12345.discordsays.com/'), false);

  assert.deepEqual(classifyNavigationUrl('https://discord.com/login'), { allow: true, openExternal: false });
  assert.deepEqual(classifyNavigationUrl('http://discord.com/login'), { allow: false, openExternal: true });
  assert.deepEqual(classifyNavigationUrl('https://cdn.discordapp.com/attachments/1/2/a.html'), { allow: false, openExternal: true });
  assert.deepEqual(classifyNavigationUrl('https://github.com/NextGenInfluencer'), { allow: false, openExternal: true });
  assert.deepEqual(classifyNavigationUrl('file:///C:/Windows/win.ini'), { allow: false, openExternal: false });
  assert.deepEqual(classifyNavigationUrl('javascript:alert(1)'), { allow: false, openExternal: false });
  assert.deepEqual(classifyNavigationUrl('data:text/html,<h1>x</h1>'), { allow: false, openExternal: false });

  assert.deepEqual(classifyPopupRequest({ url: 'about:blank', disposition: 'new-window' }), { action: 'allow-popout' });
  assert.deepEqual(classifyPopupRequest({ url: 'https://discord.com/oauth2/authorize?client_id=123', disposition: 'foreground-tab' }), { action: 'allow-oauth' });
  assert.deepEqual(classifyPopupRequest({ url: 'https://example.com', disposition: 'foreground-tab' }), { action: 'external', url: 'https://example.com/' });
  assert.deepEqual(classifyPopupRequest({ url: 'javascript:void(0)' }), { action: 'deny' });
});

test('Audio input device matcher prioritizes exact hardware devices over Default alias', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Desktop Microphone (Realtek Audio)' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Desktop Microphone (Realtek Audio)' },
    { kind: 'audioinput', deviceId: 'hw-mic-1', label: 'Desktop Microphone (Realtek Audio)' },
    { kind: 'audioinput', deviceId: 'hw-b2', label: 'Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)' }
  ];

  const matchedMic = matchAudioInputDevice(devices, 'Desktop Microphone (Realtek Audio)');
  assert.equal(matchedMic.deviceId, 'hw-mic-1');

  const matchedB2 = matchAudioInputDevice(devices, 'Voicemeeter Out B2');
  assert.equal(matchedB2.deviceId, 'hw-b2');

  assert.equal(matchAudioInputDevice(devices, 'loopback'), null);
  assert.equal(matchAudioInputDevice(devices, ''), null);
});

test('WebContentsView bounds calculation and Discord unread title parser', () => {
  const single = computePaneBounds({ x: 72, y: 0, width: 1208, height: 800 }, { isSplitView: false });
  assert.deepEqual(single, {
    primary: { x: 72, y: 0, width: 1208, height: 800 },
    secondary: null
  });

  const split = computePaneBounds({ x: 72, y: 38, width: 1208, height: 762 }, { isSplitView: true, dividerPx: 2 });
  assert.deepEqual(split, {
    primary: { x: 72, y: 38, width: 603, height: 762 },
    secondary: { x: 677, y: 38, width: 603, height: 762 }
  });

  const minimized = computePaneBounds({ x: -10, y: -10, width: -100, height: -50 }, { isSplitView: true });
  assert.equal(minimized.primary.width, 0);
  assert.equal(minimized.secondary.width, 0);

  assert.equal(parseDiscordTitleUnread('(4) Discord | #general'), '4');
  assert.equal(parseDiscordTitleUnread('(142) Discord | Friends'), '99+');
  assert.equal(parseDiscordTitleUnread('• Discord | #dev'), '•');
  assert.equal(parseDiscordTitleUnread('(*) Discord'), '•');
  assert.equal(parseDiscordTitleUnread('Discord | Friends'), null);
  assert.equal(parseDiscordTitleUnread(''), null);
});

test('Repository PII, bundled offline assets, CSP, and packaging hygiene checks', () => {
  const vbs = fs.readFileSync(path.join(ROOT_DIR, 'launch-silent.vbs'), 'utf8');
  assert.equal(/Users\\lefte/i.test(vbs), false, 'launch-silent.vbs must not contain developer path PII');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  for (const excluded of ['launch-silent.vbs', 'launch.bat', 'setup.bat', 'create-shortcut.js']) {
    assert.equal(pkg.build.files.includes(excluded), false, `${excluded} must not be bundled in app.asar`);
  }
  assert.equal(pkg.build.artifactName, 'Discord-MultiSpace-Setup-${version}.${ext}');
  assert.equal(pkg.build.win.icon, 'assets/icon.ico');

  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.equal(html.includes('fonts.googleapis.com'), false, 'index.html must not ping Google Fonts');
  assert.equal(html.includes('<webview'), false, 'index.html must not use legacy <webview>');
  assert.equal(html.includes('20.317 4.37'), false, 'index.html must not embed trademarked Clyde logo path');

  const midnight = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'themes', 'midnight.css'), 'utf8');
  const amoled = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'themes', 'amoled.css'), 'utf8');
  assert.ok(midnight.length > 50000);
  assert.ok(amoled.length > 10000);
  assert.equal(/@import\s+url\(/i.test(midnight), false, 'midnight.css must have external @imports stripped');
  assert.equal(/@import\s+url\(/i.test(amoled), false, 'amoled.css must have code.css inlined');

  assert.ok(fs.statSync(path.join(ROOT_DIR, 'assets', 'icon.ico')).size > 20000);
  assert.ok(fs.statSync(path.join(ROOT_DIR, 'tray-icon.png')).size > 1000);
  assert.ok(fs.statSync(path.join(ROOT_DIR, 'assets', 'fonts', 'Inter-Variable.woff2')).size > 40000);
  assert.equal(fs.existsSync(path.join(ROOT_DIR, 'assets', 'fonts', 'Inter-Regular.woff2')), false);
});

test('Window bounds & maximized state persistence clamping across multi-monitor and off-screen layouts', () => {
  const dualDisplays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: -1920, y: -200, width: 1920, height: 1040 } }
  ];
  const singleDisplay = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const smallLaptopDisplay = [{ workArea: { x: 0, y: 0, width: 1024, height: 680 } }];
  const defaults = { width: 1280, height: 800, minWidth: 940, minHeight: 560 };

  // 1. Null / malformed inputs fall back to defaults without coordinates
  for (const invalid of [null, undefined, 'corrupt', { width: NaN, height: -50, x: Infinity, y: 'bad' }]) {
    const res = sanitizeWindowState(invalid, singleDisplay, defaults);
    assert.deepEqual(res, { width: 1280, height: 800, isMaximized: false });
  }

  // 2. Below-minimum saved dimensions clamp up to minWidth / minHeight
  assert.deepEqual(
    sanitizeWindowState({ width: 320, height: 240, isMaximized: false }, singleDisplay, defaults),
    { width: 940, height: 560, isMaximized: false }
  );

  // 3. Valid negative coordinates on secondary left/top monitor are preserved verbatim
  assert.deepEqual(
    sanitizeWindowState({ x: -1600, y: -120, width: 1280, height: 800, isMaximized: false }, dualDisplays, defaults),
    { x: -1600, y: -120, width: 1280, height: 800, isMaximized: false }
  );

  // 4. Partially off-screen window pulls titlebar and overflowing right edge back inside display workArea
  assert.deepEqual(
    sanitizeWindowState({ x: 1500, y: -45, width: 1280, height: 800, isMaximized: false }, singleDisplay, defaults),
    { x: 640, y: 0, width: 1280, height: 800, isMaximized: false }
  );

  // 5. Unplugged secondary monitor (0 overlap with remaining display) re-centers on primary display & preserves isMaximized
  assert.deepEqual(
    sanitizeWindowState({ x: 2600, y: 120, width: 1400, height: 900, isMaximized: true }, singleDisplay, defaults),
    { x: 260, y: 70, width: 1400, height: 900, isMaximized: true }
  );

  // 6. Oversized 4K window restored onto a smaller laptop screen clamps to workArea
  assert.deepEqual(
    sanitizeWindowState({ x: 200, y: 200, width: 3840, height: 2160, isMaximized: false }, smallLaptopDisplay, defaults),
    { x: 0, y: 0, width: 1024, height: 680, isMaximized: false }
  );

  // 7. Exact zero (0, 0) coordinates are preserved (never treated as falsy)
  assert.deepEqual(
    sanitizeWindowState({ x: 0, y: 0, width: 1280, height: 800, isMaximized: false }, singleDisplay, defaults),
    { x: 0, y: 0, width: 1280, height: 800, isMaximized: false }
  );

  // 8. When displays[0] is a secondary monitor and displays[1] is primary, off-screen windows re-center onto primary
  const reorderedDisplays = [
    { id: 2, isPrimary: false, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
    { id: 1, isPrimary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  ];
  assert.deepEqual(
    sanitizeWindowState({ x: 4200, y: 100, width: 1280, height: 800, isMaximized: true }, reorderedDisplays, defaults),
    { x: 320, y: 120, width: 1280, height: 800, isMaximized: true }
  );
});
