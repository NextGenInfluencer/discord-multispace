'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');

const ACCOUNT_ID_REGEX = /^[a-z0-9_-]{1,64}$/i;
const PARTITION_REGEX = /^persist:discord_account_([a-z0-9_-]{1,64})$/i;
const BARE_HOST_PORT_REGEX = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}$/i;

const DISCORD_APP_HOSTS = [
  'discord.com',
  'discordapp.com'
];

const DISCORD_OAUTH_PATH_PREFIXES = [
  '/oauth2',
  '/api/oauth2',
  '/api/v9/oauth2',
  '/api/v10/oauth2',
  '/connections'
];

function isValidAccountId(id) {
  return typeof id === 'string' && ACCOUNT_ID_REGEX.test(id);
}

function isValidPartition(partition) {
  return typeof partition === 'string' && PARTITION_REGEX.test(partition);
}

function accountIdFromPartition(partition) {
  if (typeof partition !== 'string') return null;
  const m = partition.match(PARTITION_REGEX);
  return m ? m[1] : null;
}

function partitionForAccountId(accountId) {
  if (!isValidAccountId(accountId)) {
    throw new Error(`Invalid account ID: ${String(accountId)}`);
  }
  return `persist:discord_account_${accountId}`;
}

function redactSensitiveUrl(input) {
  if (typeof input !== 'string' || !input) return '';
  return input.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***:***@');
}

/**
 * Parse and strictly validate a per-account proxy string.
 * Strips inline credentials out of Chromium proxyRules (since Chromium ignores or fails-open on user:pass@ in proxyRules)
 * and returns structured auth credentials for Electron's `login` event.
 */
function parseAndValidateProxy(rawInput) {
  if (rawInput === null || rawInput === undefined) {
    return { valid: true, mode: 'direct', proxyRules: '', auth: null, redacted: 'DIRECT' };
  }
  if (typeof rawInput !== 'string') {
    return { valid: false, error: 'Proxy configuration must be a string.' };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: true, mode: 'direct', proxyRules: '', auth: null, redacted: 'DIRECT' };
  }

  if (/[\s,;]/.test(trimmed)) {
    return { valid: false, error: 'Proxy URL must be a single server URL without spaces, commas, or semicolons.' };
  }

  const candidate = BARE_HOST_PORT_REGEX.test(trimmed) ? `http://${trimmed}` : trimmed;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, error: 'Invalid proxy URL. Expected format: http://host:port or socks5://host:port.' };
  }

  const allowedProtocols = new Set(['http:', 'https:', 'socks4:', 'socks5:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    return {
      valid: false,
      error: `Unsupported proxy scheme "${parsed.protocol.replace(':', '')}". Allowed: http, https, socks4, socks5.`
    };
  }

  if (!parsed.hostname) {
    return { valid: false, error: 'Proxy hostname is missing.' };
  }

  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return { valid: false, error: 'Proxy URL must not contain a path, query string, or hash fragment.' };
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const rawPortMatch = candidate.match(/:(\d+)$/);
  let portNum = parsed.port ? Number(parsed.port) : (rawPortMatch ? Number(rawPortMatch[1]) : NaN);

  if (Number.isNaN(portNum)) {
    if (scheme === 'http') portNum = 80;
    else if (scheme === 'https') portNum = 443;
    else {
      return { valid: false, error: `${scheme.toUpperCase()} proxy requires an explicit port (e.g. ${scheme}://${parsed.hostname}:1080).` };
    }
  }

  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { valid: false, error: 'Proxy port must be an integer between 1 and 65535.' };
  }

  const hasAuth = parsed.username !== '' || parsed.password !== '';
  if (hasAuth && (scheme === 'socks4' || scheme === 'socks5')) {
    return {
      valid: false,
      error: 'Chromium does not support username/password authentication on SOCKS proxies. Use an authenticated HTTP/HTTPS proxy or a local unauthenticated SOCKS5 tunnel.'
    };
  }

  const hostBracketed = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
    ? `[${parsed.hostname}]`
    : parsed.hostname;
  const hostPort = `${hostBracketed}:${portNum}`;
  const proxyRules = `${scheme}://${hostPort}`;

  let auth = null;
  let redacted = proxyRules;
  if (hasAuth) {
    try {
      auth = {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password)
      };
    } catch {
      auth = {
        username: parsed.username,
        password: parsed.password
      };
    }
    redacted = `${scheme}://***:***@${hostPort}`;
  }

  return {
    valid: true,
    mode: 'proxy',
    scheme,
    host: parsed.hostname,
    port: portNum,
    proxyRules,
    auth,
    redacted
  };
}

function isPrivateIPv4Parts(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 Loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local / Cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 Multicast + 240.0.0.0/4 Reserved/Broadcast
  return false;
}

function expandIPv6Groups(ipv6) {
  let addr = ipv6.toLowerCase();
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) to 2 hex groups
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    const octets = v4Part.split('.').map((x) => Number(x));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dblParts = addr.split('::');
  if (dblParts.length > 2) return null;

  let groups;
  if (dblParts.length === 2) {
    const left = dblParts[0] ? dblParts[0].split(':') : [];
    const right = dblParts[1] ? dblParts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = addr.split(':');
  }

  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

/**
 * Returns true if the given IPv4/IPv6 string is private, loopback, link-local,
 * multicast, documentation, NAT64/6to4/mapped private, or invalid.
 */
function isPrivateOrReservedIP(rawIp) {
  if (typeof rawIp !== 'string' || !rawIp.trim()) return true;
  const ip = rawIp.trim().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.length !== 4) return true;
    return isPrivateIPv4Parts(parts[0], parts[1], parts[2], parts[3]);
  }
  if (version === 6) {
    const g = expandIPv6Groups(ip);
    if (!g) return true;

    const allZeroTop6 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    // :: (unspecified) or ::1 (loopback)
    if (allZeroTop6 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;

    // ::ffff:0:0/96 (IPv4-mapped), ::ffff:0:0:0/96 (SIIT IPv4-translated), or ::/96 (IPv4-compatible)
    if (
      (allZeroTop6 && (g[6] !== 0 || g[7] !== 0)) ||
      (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) ||
      (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0)
    ) {
      const a = (g[6] >> 8) & 0xff;
      const b = g[6] & 0xff;
      const c = (g[7] >> 8) & 0xff;
      const d = g[7] & 0xff;
      return isPrivateIPv4Parts(a, b, c, d);
    }

    // NAT64: 64:ff9b::/96 (RFC 6052 well-known) & 64:ff9b:1::/48 (RFC 8215 local-use — ALWAYS private!)
    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      if (g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0) {
        return true;
      }
      const a = (g[6] >> 8) & 0xff;
      const b = g[6] & 0xff;
      const c = (g[7] >> 8) & 0xff;
      const d = g[7] & 0xff;
      return isPrivateIPv4Parts(a, b, c, d);
    }

    // Discard-Only Prefix 100::/64 (RFC 6666)
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // Special 2001::/16 sub-allocations
    if (g[0] === 0x2001) {
      // Teredo 2001:0000::/32 (RFC 4380): client IPv4 is bitwise-inverted in g[6..7]; server IPv4 in g[2..3]
      if (g[1] === 0x0000) {
        const ca = ((~g[6]) >> 8) & 0xff;
        const cb = (~g[6]) & 0xff;
        const cc = ((~g[7]) >> 8) & 0xff;
        const cd = (~g[7]) & 0xff;
        const sa = (g[2] >> 8) & 0xff;
        const sb = g[2] & 0xff;
        const sc = (g[3] >> 8) & 0xff;
        const sd = g[3] & 0xff;
        return isPrivateIPv4Parts(ca, cb, cc, cd) || isPrivateIPv4Parts(sa, sb, sc, sd);
      }
      // BMWG Benchmarking 2001:2::/48
      if (g[1] === 0x0002 && g[2] === 0x0000) return true;
      // ORCHID / ORCHIDv2 2001:10::/28 & 2001:20::/28
      if ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020) return true;
      // Documentation 2001:db8::/32
      if (g[1] === 0x0db8) return true;
    }

    // 6to4 2002::/16
    if (g[0] === 0x2002) {
      const a = (g[1] >> 8) & 0xff;
      const b = g[1] & 0xff;
      const c = (g[2] >> 8) & 0xff;
      const d = g[2] & 0xff;
      return isPrivateIPv4Parts(a, b, c, d);
    }

    // Unique local fc00::/7
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // Deprecated site-local fec0::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true;
    // Multicast ff00::/8
    if ((g[0] & 0xff00) === 0xff00) return true;

    return false;
  }
  return true;
}

async function validateHttpsPublicUrl(rawUrl, lookupFn = dns.promises.lookup) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'Theme URL is empty.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Invalid URL syntax.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS theme URLs are permitted.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Credentials are not permitted in theme URLs.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, error: 'Local or internal hostnames are blocked.' };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion) {
    if (isPrivateOrReservedIP(host)) {
      return { ok: false, error: 'Private or loopback IP addresses are blocked.' };
    }
    return {
      ok: true,
      url: parsed.toString(),
      pinnedAddress: host,
      pinnedFamily: ipVersion
    };
  }

  let addresses;
  try {
    addresses = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: `Could not resolve hostname "${host}".` };
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, error: `No DNS records found for "${host}".` };
  }

  for (const record of addresses) {
    if (!record || !record.address || isPrivateOrReservedIP(record.address)) {
      return { ok: false, error: 'Theme URL resolved to a blocked private or loopback IP address.' };
    }
  }

  const primary = addresses[0];
  return {
    ok: true,
    url: parsed.toString(),
    pinnedAddress: primary.address,
    pinnedFamily: primary.family || net.isIP(primary.address) || 4
  };
}

/**
 * Perform an HTTPS GET pinned to a pre-validated public IP address so DNS rebinding
 * (TOCTOU between DNS validation and socket connect) is impossible.
 */
function fetchHttpsPinned(urlStr, { pinnedAddress, pinnedFamily, timeoutMs, maxBytes, budgetState, userAgent }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const sniHost = parsed.hostname.replace(/^\[|\]$/g, '');
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: sniHost,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        servername: net.isIP(sniHost) ? undefined : sniHost,
        headers: {
          Host: parsed.host,
          'User-Agent': userAgent,
          Accept: 'text/css,*/*;q=0.1',
          'Accept-Encoding': 'identity'
        },
        lookup: (_hostname, opts, cb) => {
          if (!pinnedAddress || isPrivateOrReservedIP(pinnedAddress)) {
            const err = new Error('Theme URL resolved to a blocked private or loopback IP address.');
            if (opts && opts.all) return cb(err, []);
            return cb(err);
          }
          const fam = pinnedFamily || net.isIP(pinnedAddress) || 4;
          if (opts && opts.all) {
            return cb(null, [{ address: pinnedAddress, family: fam }]);
          }
          return cb(null, pinnedAddress, fam);
        }
      },
      (res) => {
        const status = res.statusCode || 0;
        const locationHeader = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;

        if (status >= 300 && status < 400) {
          res.resume();
          settled = true;
          resolve({ status, ok: false, location: locationHeader || null, text: '' });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          settled = true;
          resolve({ status, ok: false, location: null, text: '' });
          return;
        }

        const contentLength = Number(res.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes - budgetState.usedBytes) {
          res.destroy();
          fail(new Error(`Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          budgetState.usedBytes += buf.byteLength;
          if (budgetState.usedBytes > maxBytes) {
            res.destroy();
            fail(new Error(`Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`));
            return;
          }
          chunks.push(buf);
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status,
            ok: true,
            location: null,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          fail(err);
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      fail(new Error('Theme request timed out after 5 seconds.'));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });

    req.end();
  });
}

async function readResponseTextBounded(response, maxBytes, budgetState) {
  const contentLength = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes - budgetState.usedBytes) {
    throw new Error(`Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const byteLen = Buffer.byteLength(text, 'utf8');
    budgetState.usedBytes += byteLen;
    if (budgetState.usedBytes > maxBytes) {
      throw new Error(`Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        budgetState.usedBytes += value.byteLength;
        if (budgetState.usedBytes > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error(`Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return Buffer.concat(chunks).toString('utf8');
}

const CSS_IMPORT_RULE_REGEX = /@import\s+(?:url\(\s*(?:(['"])([^'"]+)\1|([^'")\s]+))\s*\)|(['"])([^'"]+)\4)[^;]*;?/gi;

function extractCssImportTarget(match) {
  return (match[2] || match[3] || match[5] || '').trim();
}

/**
 * Safely fetch a remote HTTPS CSS file with DNS-pinned SSRF validation, manual redirect validation,
 * strict timeout, 1 MB total byte cap, and safe bounded relative/@import resolution.
 */
async function safeFetchThemeCss(rawUrl, options = {}) {
  const {
    fetchFn = null,
    lookupFn = dns.promises.lookup,
    timeoutMs = 5000,
    maxBytes = 1024 * 1024,
    maxRedirects = 3,
    maxImports = 3,
    userAgent = 'Mozilla/5.0',
    budgetState = { usedBytes: 0, importsFetched: 0 },
    visitedUrls = new Set()
  } = options;

  async function fetchSingleCss(targetUrl, depth) {
    let currentUrl = targetUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = await validateHttpsPublicUrl(currentUrl, lookupFn);
      if (!check.ok) {
        throw new Error(check.error);
      }
      currentUrl = check.url;

      let cssText = '';

      if (typeof fetchFn === 'function') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Theme request timed out.')), timeoutMs);
        let res;
        try {
          res = await fetchFn(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'User-Agent': userAgent,
              Accept: 'text/css,*/*;q=0.1'
            }
          });
        } catch (err) {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            throw new Error('Theme request timed out after 5 seconds.');
          }
          throw err;
        }

        try {
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers && res.headers.get ? res.headers.get('location') : null;
            if (!location) {
              throw new Error(`Redirect (${res.status}) missing Location header.`);
            }
            if (hop === maxRedirects) {
              throw new Error('Too many redirects while fetching theme CSS.');
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }

          cssText = await readResponseTextBounded(res, maxBytes, budgetState);
        } finally {
          clearTimeout(timer);
        }
      } else {
        const pinnedRes = await fetchHttpsPinned(currentUrl, {
          pinnedAddress: check.pinnedAddress,
          pinnedFamily: check.pinnedFamily,
          timeoutMs,
          maxBytes,
          budgetState,
          userAgent
        });

        if (pinnedRes.status >= 300 && pinnedRes.status < 400) {
          if (!pinnedRes.location) {
            throw new Error(`Redirect (${pinnedRes.status}) missing Location header.`);
          }
          if (hop === maxRedirects) {
            throw new Error('Too many redirects while fetching theme CSS.');
          }
          currentUrl = new URL(pinnedRes.location, currentUrl).toString();
          continue;
        }

        if (!pinnedRes.ok) {
          throw new Error(`HTTP ${pinnedRes.status}`);
        }

        cssText = pinnedRes.text;
      }

      visitedUrls.add(currentUrl);

      // Resolve nested @import statements (both url(...) and "..." forms, bounded depth & count)
      const matches = Array.from(cssText.matchAll(CSS_IMPORT_RULE_REGEX));
      for (const m of matches) {
        const rawImportTarget = extractCssImportTarget(m);
        if (!rawImportTarget) {
          cssText = cssText.replace(m[0], '');
          continue;
        }

        let resolvedImport;
        try {
          resolvedImport = new URL(rawImportTarget, currentUrl).toString();
        } catch {
          cssText = cssText.replace(m[0], '');
          continue;
        }

        // Strip Google Fonts tracker imports cleanly so they never ping fonts.googleapis.com
        try {
          const importHost = new URL(resolvedImport).hostname.toLowerCase();
          if (importHost === 'fonts.googleapis.com' || importHost === 'fonts.gstatic.com') {
            cssText = cssText.replace(m[0], '');
            continue;
          }
        } catch {}

        if (depth >= 2 || budgetState.importsFetched >= maxImports || visitedUrls.has(resolvedImport)) {
          cssText = cssText.replace(m[0], '');
          continue;
        }

        budgetState.importsFetched += 1;
        try {
          const importedCss = await fetchSingleCss(resolvedImport, depth + 1);
          cssText = cssText.replace(m[0], () => importedCss);
        } catch {
          // Strip failed nested sub-imports so raw unvalidated @imports never reach the browser
          cssText = cssText.replace(m[0], '');
        }
      }

      return cssText;
    }

    throw new Error('Too many redirects while fetching theme CSS.');
  }

  try {
    const css = await fetchSingleCss(rawUrl, 0);
    return { success: true, css };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Validate and inline ALL @import rules inside user-supplied custom CSS.
 * Rejects cleartext HTTP, private/loopback SSRF targets, excessive imports, or obfuscated @import rules.
 */
async function resolveThemeCssImports(rawCss, options = {}) {
  if (typeof rawCss !== 'string' || !rawCss.trim()) {
    return { success: true, css: '' };
  }

  const maxTopImports = typeof options.maxImports === 'number' ? options.maxImports : 5;
  const budgetState = { usedBytes: Buffer.byteLength(rawCss, 'utf8'), importsFetched: 0 };
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : 1024 * 1024;
  if (budgetState.usedBytes > maxBytes) {
    return {
      success: false,
      error: `Theme stylesheet exceeds maximum size limit (${Math.round(maxBytes / 1024)} KB).`
    };
  }

  const visitedUrls = new Set();
  let workingCss = rawCss;
  const matches = Array.from(workingCss.matchAll(CSS_IMPORT_RULE_REGEX));

  if (matches.length > maxTopImports) {
    return {
      success: false,
      error: `Too many @import rules in custom CSS (maximum ${maxTopImports}).`
    };
  }

  for (const m of matches) {
    const targetUrl = extractCssImportTarget(m);
    if (!targetUrl) {
      return { success: false, error: 'Invalid @import rule in custom CSS.' };
    }
    const fetched = await safeFetchThemeCss(targetUrl, {
      ...options,
      maxBytes,
      budgetState,
      visitedUrls
    });
    if (!fetched.success) {
      return { success: false, error: fetched.error || 'Failed to load remote theme CSS.' };
    }
    workingCss = workingCss.replace(m[0], () => fetched.css);
  }

  // Block any remaining malformed or CSS-escaped @import directive so nothing bypasses safeFetchThemeCss
  if (/@import\b/i.test(workingCss)) {
    return { success: false, error: 'Unsupported or malformed @import rule in custom CSS.' };
  }

  return { success: true, css: workingCss.trim() };
}

/**
 * Safely relax ONLY style-src, style-src-elem, font-src, and img-src when a custom theme is active.
 * NEVER modifies connect-src, script-src, default-src, frame-src, or object-src.
 */
function transformDiscordCspHeader(csp, customThemeActive) {
  if (typeof csp !== 'string' || !customThemeActive) {
    return csp;
  }

  const appendMissingTokens = (directiveValue, extraTokens) => {
    const existing = directiveValue.trim();
    const lowerTokens = new Set(existing.split(/\s+/).map((t) => t.toLowerCase()));
    const hasNonceOrHash = Array.from(lowerTokens).some(
      (t) => t.startsWith("'nonce-") || t.startsWith("'sha256-") || t.startsWith("'sha384-") || t.startsWith("'sha512-")
    );
    const toAdd = extraTokens.filter((token) => {
      const l = token.toLowerCase();
      if (l === "'unsafe-inline'" && hasNonceOrHash) return false;
      return !lowerTokens.has(l);
    });
    return toAdd.length > 0 ? `${existing} ${toAdd.join(' ')}` : existing;
  };

  return csp
    .replace(/\b(style-src(?:-elem)?)\s+([^;]+)/gi, (_m, dir, val) =>
      `${dir} ${appendMissingTokens(val, ['https:', 'data:', 'blob:', "'unsafe-inline'"])}`
    )
    .replace(/\b(font-src)\s+([^;]+)/gi, (_m, dir, val) =>
      `${dir} ${appendMissingTokens(val, ['https:', 'data:', 'blob:'])}`
    )
    .replace(/\b(img-src)\s+([^;]+)/gi, (_m, dir, val) =>
      `${dir} ${appendMissingTokens(val, ['https:', 'data:', 'blob:'])}`
    );
}

function isTrustedDiscordOrigin(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'discord.com' || host.endsWith('.discord.com');
  } catch {
    return false;
  }
}

function classifyNavigationUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) {
    return { allow: false, openExternal: false };
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { allow: false, openExternal: false };
  }

  if (parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    // Attachment CDN hosts should open externally rather than replacing the Discord SPA main frame
    if (host === 'cdn.discordapp.com' || host === 'media.discordapp.net') {
      return { allow: false, openExternal: true };
    }
    const isAllowedAppHost = DISCORD_APP_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`)
    );
    if (isAllowedAppHost) {
      return { allow: true, openExternal: false };
    }
    return { allow: false, openExternal: true };
  }

  if (parsed.protocol === 'http:') {
    // Never load cleartext http:// inside the client; open external http links in OS browser
    return { allow: false, openExternal: true };
  }

  // Block file:, javascript:, data:, smb:, custom schemes
  return { allow: false, openExternal: false };
}

function classifyPopupRequest({ url, disposition, frameName } = {}) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (raw === '' || raw === 'about:blank') {
    // Discord Voice / Stream Pop-Out window
    return { action: 'allow-popout' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { action: 'deny' };
  }

  if (parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    const isDiscord = host === 'discord.com' || host.endsWith('.discord.com');
    const isOAuthPath = DISCORD_OAUTH_PATH_PREFIXES.some((p) => parsed.pathname.startsWith(p));
    if ((isDiscord && isOAuthPath) || (disposition === 'new-window' && isDiscord)) {
      return { action: 'allow-oauth' };
    }
    return { action: 'external', url: parsed.toString() };
  }

  if (parsed.protocol === 'http:') {
    return { action: 'external', url: parsed.toString() };
  }

  return { action: 'deny' };
}

/**
 * Match an audioinput device from enumerateDevices() against a saved label.
 * Strictly prioritizes exact non-default matches over Default/Communications aliases and substrings.
 */
function matchAudioInputDevice(devices, targetLabel) {
  if (!Array.isArray(devices) || typeof targetLabel !== 'string') return null;
  const trimmed = targetLabel.trim();
  if (!trimmed || trimmed === 'loopback') return null;
  const lower = trimmed.toLowerCase();

  const inputs = devices.filter((d) => d && d.kind === 'audioinput' && typeof d.label === 'string' && d.label.length > 0);
  const nonAliasInputs = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');

  // 1. Exact case-sensitive match on concrete device (not 'default'/'communications' alias)
  let found = nonAliasInputs.find((d) => d.label === trimmed);
  if (found) return found;

  // 2. Exact case-sensitive match on any device (in case user explicitly selected 'Default - ...')
  found = inputs.find((d) => d.label === trimmed);
  if (found) return found;

  // 3. Exact case-insensitive match on concrete device
  found = nonAliasInputs.find((d) => d.label.toLowerCase() === lower);
  if (found) return found;

  // 4. Substring fallback on concrete devices only (avoids 'Desktop Mic' matching 'Default - Desktop Mic')
  found = nonAliasInputs.find(
    (d) => d.label.toLowerCase().includes(lower) || lower.includes(d.label.toLowerCase())
  );
  if (found) return found;

  // 5. Last-resort substring match on any input
  return inputs.find((d) => d.label.toLowerCase().includes(lower) || lower.includes(d.label.toLowerCase())) || null;
}

/**
 * Compute integer logical bounds for Single or Dual Split-View WebContentsViews.
 */
function computePaneBounds(containerRect, { isSplitView = false, dividerPx = 2 } = {}) {
  const x = Math.max(0, Math.round(Number(containerRect && containerRect.x) || 0));
  const y = Math.max(0, Math.round(Number(containerRect && containerRect.y) || 0));
  const width = Math.max(0, Math.round(Number(containerRect && containerRect.width) || 0));
  const height = Math.max(0, Math.round(Number(containerRect && containerRect.height) || 0));

  if (!isSplitView) {
    return {
      primary: { x, y, width, height },
      secondary: null
    };
  }

  const gap = Math.min(width, Math.max(0, Math.round(dividerPx)));
  const primaryWidth = Math.max(0, Math.floor((width - gap) / 2));
  const secondaryWidth = Math.max(0, width - gap - primaryWidth);

  return {
    primary: { x, y, width: primaryWidth, height },
    secondary: { x: x + primaryWidth + gap, y, width: secondaryWidth, height }
  };
}

function parseDiscordTitleUnread(title) {
  if (typeof title !== 'string' || !title) return null;

  const mentionMatch = title.match(/^\(([^)]+)\)/);
  if (mentionMatch && mentionMatch[1]) {
    const raw = mentionMatch[1].trim();
    if (raw === '*' || raw === '•') return '•';
    const num = parseInt(raw, 10);
    if (!Number.isNaN(num) && String(num) === raw) {
      if (num <= 0) return null;
      return num > 99 ? '99+' : String(num);
    }
    if (raw === '99+') return '99+';
    return raw || null;
  }

  if (title.includes('•') || title.startsWith('(*)')) {
    return '•';
  }

  return null;
}

module.exports = {
  ACCOUNT_ID_REGEX,
  PARTITION_REGEX,
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
  parseDiscordTitleUnread
};
