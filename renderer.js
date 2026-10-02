/**
 * Discord MultiSpace - Renderer Process
 * Manages multi-account lifecycle, session isolation partitions,
 * DOM webview instantiation, badges, context menus, and keyboard navigation.
 */

// Secure context bridge — no direct require('electron') access
const eAPI = window.electronAPI;

// Preset vibrant Discord accent colors
const PRESET_COLORS = [
  '#5865F2', // Blurple
  '#23A55A', // Emerald
  '#FEE75C', // Gold
  '#ED4245', // Coral
  '#EB459E', // Fuchsia
  '#00A8FC', // Cyan
  '#9B84EC', // Lavender
  '#4E5058'  // Slate
];

const STORAGE_ACCOUNTS_KEY = 'discord_multispace_accounts';
const STORAGE_ACTIVE_ID_KEY = 'discord_multispace_active_id';

// Application State
let accounts = [];
let activeAccountId = null;
let contextTargetAccountId = null;
let editingAccountId = null;
let modalMode = 'create'; // 'create' | 'edit'
let selectedColor = PRESET_COLORS[0];
let currentAvatarDataUrl = null;

// Map of accountId -> notification value (e.g. '4', '•', null)
const accountNotifications = {};

// Power-User Features State
let isSplitView = false;
let splitPrimaryId = null;
let splitSecondaryId = null;
let isMutedAll = false;
let isDeafenedAll = false;
let memorySaverEnabled = true;
const accountLastActive = {};
const accountHibernating = {};

// Reload Button Visibility Toggle State
const STORAGE_SHOW_RELOAD_BTN_KEY = 'multispace_show_reload_btn';
let showReloadBtn = localStorage.getItem(STORAGE_SHOW_RELOAD_BTN_KEY) !== 'false';

function updateReloadButtonVisibility() {
  if (btnReloadActive) {
    btnReloadActive.style.display = showReloadBtn ? '' : 'none';
  }
  const toggle = document.getElementById('toggle-show-reload-btn');
  if (toggle) {
    toggle.checked = showReloadBtn;
  }
}

// ==========================================================================
// Zoom Controls & Persistence
// ==========================================================================
const STORAGE_ZOOM_KEY = 'discord_multispace_zoom';
let accountZooms = {};
try {
  accountZooms = JSON.parse(localStorage.getItem(STORAGE_ZOOM_KEY) || '{}');
} catch {
  accountZooms = {};
}

function getAccountZoom(accountId) {
  if (!accountId) return 1.0;
  return accountZooms[accountId] !== undefined ? accountZooms[accountId] : 1.0;
}

function setAccountZoom(accountId, factor) {
  if (!accountId) return 1.0;
  const clamped = Math.min(2.0, Math.max(0.5, Math.round(factor * 10) / 10));
  accountZooms[accountId] = clamped;
  try {
    localStorage.setItem(STORAGE_ZOOM_KEY, JSON.stringify(accountZooms));
  } catch {}

  const wv = document.getElementById(`wv-${accountId}`);
  if (wv && typeof wv.setZoomFactor === 'function') {
    try {
      wv.setZoomFactor(clamped);
    } catch {}
  }
  showZoomIndicator(clamped);
  return clamped;
}

function applyAccountZoom(accountId) {
  if (!accountId) return;
  const factor = getAccountZoom(accountId);
  const wv = document.getElementById(`wv-${accountId}`);
  if (wv && typeof wv.setZoomFactor === 'function') {
    try {
      wv.setZoomFactor(factor);
    } catch {}
  }
}

let zoomToastTimer = null;
function showZoomIndicator(factor) {
  const zoomIndicator = document.getElementById('zoom-indicator');
  if (!zoomIndicator) return;
  zoomIndicator.textContent = `Zoom: ${Math.round(factor * 100)}%`;
  zoomIndicator.classList.add('visible');
  clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    zoomIndicator.classList.remove('visible');
  }, 1400);
}

// IPC listener from main process for zoom key combinations inside webviews
eAPI.on('webview-zoom-action', ({ webContentsId, action }) => {
  let targetAccountId = activeAccountId;
  const allWebviews = webviewContainer ? webviewContainer.querySelectorAll('.discord-webview') : [];
  for (const wv of allWebviews) {
    if (typeof wv.getWebContentsId === 'function') {
      try {
        if (wv.getWebContentsId() === webContentsId) {
          targetAccountId = wv.id.replace('wv-', '');
          break;
        }
      } catch {}
    }
  }

  const current = getAccountZoom(targetAccountId);
  if (action === 'in') {
    setAccountZoom(targetAccountId, current + 0.1);
  } else if (action === 'out') {
    setAccountZoom(targetAccountId, current - 0.1);
  } else if (action === 'reset') {
    setAccountZoom(targetAccountId, 1.0);
  }
});

// Host window keyboard shortcuts for zoom (when host window has focus)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
      e.preventDefault();
      const current = getAccountZoom(activeAccountId);
      setAccountZoom(activeAccountId, current + 0.1);
    } else if (e.key === '-' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      const current = getAccountZoom(activeAccountId);
      setAccountZoom(activeAccountId, current - 0.1);
    } else if (e.key === '0' || e.code === 'Numpad0') {
      e.preventDefault();
      setAccountZoom(activeAccountId, 1.0);
    }
  }
});

/**
 * Generate a dynamic 32x32 badge overlay icon for the Windows Taskbar.
 */
function generateTaskbarBadgeDataUrl(count) {
  if (count <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    // Red circle background matching Discord's badge color (#f23f43)
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#f23f43';
    ctx.fill();

    // Dark border for contrast on light or dark taskbars
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e1f22';
    ctx.stroke();

    // Mention count text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (count > 99) {
      ctx.font = 'bold 11px Inter, "Segoe UI", Arial, sans-serif';
      ctx.fillText('99+', 16, 17);
    } else if (count > 9) {
      ctx.font = 'bold 13px Inter, "Segoe UI", Arial, sans-serif';
      ctx.fillText(`${count}`, 16, 17);
    } else {
      ctx.font = 'bold 16px Inter, "Segoe UI", Arial, sans-serif';
      ctx.fillText(`${count}`, 16, 17);
    }

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Notify Electron main process of current account state for system tray & taskbar
 */
function sendTrayStatus() {
  try {
    const activeAcc = accounts.find((a) => a.id === activeAccountId);
    const activeName = activeAcc ? activeAcc.name : 'None';
    const activeNotif = activeAcc ? accountNotifications[activeAcc.id] : null;
    const notifPrefix = activeNotif ? (activeNotif === '•' ? '(•) ' : `(${activeNotif}) `) : '';
    const winTitle = activeAcc ? `${notifPrefix}${activeAcc.name} — Discord MultiSpace` : 'Discord MultiSpace';
    document.title = winTitle;

    let totalUnreads = 0;
    Object.values(accountNotifications).forEach((val) => {
      const n = parseInt(val, 10);
      if (!isNaN(n)) totalUnreads += n;
      else if (val === '•') totalUnreads += 1;
    });

    eAPI.send('update-tray-status', {
      accountCount: accounts.length,
      activeAccountName: activeName,
      unreadCount: totalUnreads
    });

    // Update Windows taskbar badge overlay
    const taskbarDataUrl = generateTaskbarBadgeDataUrl(totalUnreads);
    eAPI.send('update-taskbar-overlay', {
      count: totalUnreads,
      dataUrl: taskbarDataUrl
    });

    eAPI.send('update-title', winTitle);
  } catch {}
}

// ==========================================================================
// Themes & Community Skins Manager Engine
// ==========================================================================
const STORAGE_THEME_CSS_KEY = 'discord_multispace_theme_css';
const STORAGE_THEME_ID_KEY = 'discord_multispace_theme_id';

const THEME_PRESETS = {
  default: {
    name: 'Default Discord',
    id: 'default',
    css: ''
  },
  midnight: {
    name: 'Midnight Dark',
    id: 'midnight',
    url: 'https://refact0r.github.io/midnight-discord/build/midnight.css',
    css: '@import url("https://refact0r.github.io/midnight-discord/build/midnight.css");'
  },
  amoled: {
    name: 'Pitch Black AMOLED',
    id: 'amoled',
    url: 'https://dimdengd.github.io/discord-oled-theme/oled.theme.css',
    css: `@import url("https://dimdengd.github.io/discord-oled-theme/oled.theme.css");

:root, .theme-dark, .theme-midnight, html, body {
  --background-primary: #000000 !important;
  --background-secondary: #000000 !important;
  --background-secondary-alt: #050505 !important;
  --background-tertiary: #000000 !important;
  --background-accent: #111111 !important;
  --background-floating: #0a0a0a !important;
  --background-mobile-primary: #000000 !important;
  --background-mobile-secondary: #050505 !important;
  --channeltextarea-background: #0d0d0d !important;
  --input-background: #0d0d0d !important;
  --bg-base-primary: #000000 !important;
  --bg-base-secondary: #000000 !important;
  --bg-base-tertiary: #050505 !important;
  --modal-background: #050505 !important;
  --modal-footer-background: #000000 !important;
  --activity-card-background: #000000 !important;
  --home-background: #000000 !important;
}

nav[aria-label="Servers sidebar"],
div[class*="sidebar_"],
div[class*="chat_"],
div[class*="chatContent_"],
div[class*="container_"],
main[class*="chatContent_"],
section[class*="panels_"],
form[class*="form_"] {
  background-color: #000000 !important;
}`
  },
  minimalist: {
    name: 'Clean Minimalist',
    id: 'minimalist',
    css: `/* Clean Minimalist Theme */
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
::-webkit-scrollbar {
  width: 5px !important;
  height: 5px !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2) !important;
  border-radius: 6px !important;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.35) !important;
}`
  }
};

let currentThemeCss = localStorage.getItem(STORAGE_THEME_CSS_KEY) || '';
let currentThemeId = localStorage.getItem(STORAGE_THEME_ID_KEY) || 'default';

/**
 * Display a temporary floating toast notification
 */
function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'app-toast';

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  if (isError) {
    icon.style.color = 'var(--accent-red)';
    icon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else {
    icon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  }

  const text = document.createElement('span');
  text.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(text);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => {
      toast.remove();
    }, 250);
  }, 3000);
}

/**
 * Inject or update the active theme stylesheet inside a guest webview.
 */
function injectThemeIntoWebview(wv) {
  if (!wv) return;
  const css = (currentThemeCss || '').trim();

  // Extract direct link if it's an @import url("...")
  let importUrl = null;
  const match = css.match(/@import\s+url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)\s*;?/i);
  if (match) {
    importUrl = match[1];
  }

  const script = `
    (() => {
      try {
        let linkEl = document.getElementById('multispace-theme-link');
        let styleEl = document.getElementById('multispace-theme-style');
        const cssContent = ${JSON.stringify(css)};
        const directUrl = ${JSON.stringify(importUrl)};

        // Manage external theme link element
        if (directUrl) {
          if (!linkEl) {
            linkEl = document.createElement('link');
            linkEl.id = 'multispace-theme-link';
            linkEl.rel = 'stylesheet';
            (document.head || document.documentElement).appendChild(linkEl);
          }
          if (linkEl.href !== directUrl) {
            linkEl.href = directUrl;
          }
        } else if (linkEl) {
          linkEl.remove();
        }

        // Manage inline theme style element
        if (cssContent) {
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'multispace-theme-style';
            (document.head || document.documentElement).appendChild(styleEl);
          }
          styleEl.textContent = cssContent;
          // Re-append to the end of document.head so theme styles override default Discord styles
          if (styleEl.parentNode) {
            styleEl.parentNode.appendChild(styleEl);
          }
        } else if (styleEl) {
          styleEl.remove();
        }
      } catch (err) {
        console.error('Error applying theme inside webview:', err);
      }
    })()
  `;

  try {
    wv.executeJavaScript(script).catch((err) => {
      console.warn('Failed to inject theme into webview:', err);
    });
  } catch (err) {
    console.warn('Failed to inject theme into webview:', err);
  }
}

/**
 * Apply a theme preset or custom CSS across all loaded webview panes immediately.
 */
async function applyTheme(presetId, customCss) {
  currentThemeId = presetId || 'custom';

  if (presetId && THEME_PRESETS[presetId]) {
    currentThemeCss = THEME_PRESETS[presetId].css;
  } else {
    let raw = (customCss !== undefined ? customCss : '').trim();
    // Auto-wrap bare URLs into @import url("...")
    if (raw && (raw.startsWith('http://') || raw.startsWith('https://')) && !raw.includes('{') && !raw.startsWith('@import')) {
      raw = `@import url("${raw}");`;
    }
    currentThemeCss = raw;
  }

  try {
    localStorage.setItem(STORAGE_THEME_ID_KEY, currentThemeId);
    localStorage.setItem(STORAGE_THEME_CSS_KEY, currentThemeCss);
  } catch {}

  const allWebviews = webviewContainer ? webviewContainer.querySelectorAll('.discord-webview') : [];
  allWebviews.forEach((wv) => {
    injectThemeIntoWebview(wv);
  });

  updateThemeUI();

  // Show visual confirmation toast
  const preset = THEME_PRESETS[currentThemeId];
  if (currentThemeId === 'default' || !currentThemeCss) {
    showToast('Theme reset to Default Discord');
  } else if (preset) {
    showToast(`Applied ${preset.name} to all accounts`);
  } else {
    showToast('Custom theme applied to all accounts');
  }

  // Pre-fetch remote CSS via main process for instant, CSP-immune injection
  const match = (currentThemeCss || '').match(/@import\s+url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)\s*;?/i);
  if (match && match[1]) {
    try {
      const fetchRes = await eAPI.invoke('fetch-theme-css', match[1]);
      if (fetchRes && fetchRes.success && fetchRes.css) {
        const inlineOverrides = currentThemeCss.replace(match[0], '').trim();
        const fullCss = `${fetchRes.css}\n\n${inlineOverrides}`.trim();

        allWebviews.forEach((wv) => {
          try {
            wv.executeJavaScript(`
              (() => {
                let styleEl = document.getElementById('multispace-theme-style');
                if (!styleEl) {
                  styleEl = document.createElement('style');
                  styleEl.id = 'multispace-theme-style';
                  (document.head || document.documentElement).appendChild(styleEl);
                }
                styleEl.textContent = ${JSON.stringify(fullCss)};
                if (styleEl.parentNode) {
                  styleEl.parentNode.appendChild(styleEl);
                }
              })()
            `).catch(() => {});
          } catch {}
        });
      }
    } catch (err) {
      console.warn('Could not pre-fetch remote theme CSS, relying on <link> tag:', err);
    }
  }
}

/**
 * Synchronize Theme settings UI with current state.
 */
function updateThemeUI() {
  const statusEl = document.getElementById('theme-active-status');
  const inputCss = document.getElementById('input-theme-css');
  const presetCards = document.querySelectorAll('.theme-preset-card');

  if (statusEl) {
    const preset = THEME_PRESETS[currentThemeId];
    statusEl.textContent = preset ? preset.name : 'Custom CSS';
  }

  if (inputCss && document.activeElement !== inputCss) {
    inputCss.value = currentThemeCss;
  }

  presetCards.forEach((card) => {
    const p = card.dataset.preset;
    card.classList.toggle('active', p === currentThemeId);
  });
}

eAPI.on('tray-reload-session', () => {
  reloadActiveAccount();
});

// DOM Elements
const accountStack = document.getElementById('account-stack');
const webviewContainer = document.getElementById('webview-container');
const loadingBar = document.getElementById('webview-loading-bar');
const btnAddAccount = document.getElementById('btn-add-account');
const btnReloadActive = document.getElementById('btn-reload-active');

// Power-User Controls DOM Elements
const btnSplitView = document.getElementById('btn-split-view');
const btnMuteAll = document.getElementById('btn-mute-all');
const btnDeafenAll = document.getElementById('btn-deafen-all');
const btnOpenSettings = document.getElementById('btn-open-settings');

const splitHeader = document.getElementById('split-header');
const splitSelectPrimary = document.getElementById('split-select-primary');
const splitSelectSecondary = document.getElementById('split-select-secondary');
const btnCloseSplit = document.getElementById('btn-close-split');

// Modal Elements
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const inputAccountName = document.getElementById('input-account-name');
const colorPalette = document.getElementById('color-palette');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSubmit = document.getElementById('btn-modal-submit');
const inputAccountProxy = document.getElementById('input-account-proxy');

const modalAvatarPreview = document.getElementById('modal-avatar-preview');
const avatarPreviewBox = document.getElementById('avatar-preview-box');
const inputAccountAvatar = document.getElementById('input-account-avatar');
const btnUploadAvatar = document.getElementById('btn-upload-avatar');
const btnRemoveAvatar = document.getElementById('btn-remove-avatar');

// Settings Modal Elements
const settingsModalOverlay = document.getElementById('settings-modal-overlay');
const toggleMemorySaver = document.getElementById('toggle-memory-saver');
const toggleStartup = document.getElementById('toggle-startup');
const btnSettingsClose = document.getElementById('btn-settings-close');

// Context Menu Elements
const contextMenu = document.getElementById('context-menu');
const ctxAccountTitle = document.getElementById('ctx-account-title');
const ctxActionEdit = document.getElementById('ctx-action-edit');
const ctxActionReload = document.getElementById('ctx-action-reload');
const ctxActionClearCache = document.getElementById('ctx-action-clear-cache');
const ctxActionDelete = document.getElementById('ctx-action-delete');

// Reload Context Menu Elements
const reloadContextMenu = document.getElementById('reload-context-menu');
const ctxReloadTab = document.getElementById('ctx-reload-tab');
const ctxReloadTabHard = document.getElementById('ctx-reload-tab-hard');
const ctxReloadApp = document.getElementById('ctx-reload-app');

/**
 * Initialize state from localStorage or generate defaults.
 */
function initAccounts() {
  try {
    const raw = localStorage.getItem(STORAGE_ACCOUNTS_KEY);
    if (raw) {
      accounts = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed to parse accounts from localStorage:', err);
    accounts = [];
  }

  // If no accounts exist on first launch, create Account 1
  if (!accounts || accounts.length === 0) {
    accounts = [
      {
        id: '1',
        name: 'Account 1',
        color: PRESET_COLORS[0]
      }
    ];
    saveAccounts();
  }

  // Restore active account or fallback to first
  const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_ID_KEY);
  if (savedActiveId && accounts.some((acc) => acc.id === savedActiveId)) {
    activeAccountId = savedActiveId;
  } else {
    activeAccountId = accounts[0].id;
    localStorage.setItem(STORAGE_ACTIVE_ID_KEY, activeAccountId);
  }

  // Initialize proxy, idle tracking, and memory saver
  const savedMemSaver = localStorage.getItem('multispace_memory_saver');
  memorySaverEnabled = savedMemSaver !== null ? savedMemSaver === 'true' : true;
  if (toggleMemorySaver) {
    toggleMemorySaver.checked = memorySaverEnabled;
  }

  accounts.forEach((acc) => {
    accountLastActive[acc.id] = Date.now();
    if (acc.proxy) {
      applyAccountProxy(acc.id, acc.proxy);
    }
  });

  renderAccountStack();
  syncWebviews();
  sendTrayStatus();
}

/**
 * Configure Chromium proxy dynamically for an account partition.
 */
function applyAccountProxy(accountId, proxyRules) {
  try {
    eAPI.send('set-account-proxy', {
      partition: `persist:discord_account_${accountId}`,
      proxyRules: proxyRules || ''
    });
  } catch (err) {
    console.warn(`Failed to set proxy for account ${accountId}:`, err);
  }
}

/**
 * Save accounts array to localStorage.
 */
function saveAccounts() {
  localStorage.setItem(STORAGE_ACCOUNTS_KEY, JSON.stringify(accounts));
}

/**
 * Save active account ID to localStorage.
 */
function saveActiveAccountId(id) {
  activeAccountId = id;
  localStorage.setItem(STORAGE_ACTIVE_ID_KEY, id);
}

/**
 * Compute 1-2 character initials for the account badge.
 */
function getInitials(name) {
  if (!name) return 'A';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  if (name.length <= 3) {
    return name.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Render the account badges in the left sidebar.
 */
function renderAccountStack() {
  accountStack.innerHTML = '';

  accounts.forEach((acc, index) => {
    const item = document.createElement('div');
    item.className = `account-item ${acc.id === activeAccountId ? 'active' : ''}`;
    item.dataset.accountId = acc.id;

    // Left indicator pill
    const pill = document.createElement('div');
    pill.className = 'indicator-pill';

    // Account Badge Wrapper for Badge + Notification Counter
    const badgeWrapper = document.createElement('div');
    badgeWrapper.className = 'account-badge-wrapper';

    // Badge circle (avatar or initials)
    const badge = document.createElement('button');
    badge.className = 'account-badge';
    badge.setAttribute('aria-label', acc.name);
    if (acc.avatar) {
      badge.style.backgroundColor = 'transparent';
      badge.textContent = '';
      const img = document.createElement('img');
      img.className = 'badge-avatar-img';
      img.src = acc.avatar;
      img.alt = acc.name;
      badge.appendChild(img);
    } else {
      badge.style.backgroundColor = acc.color || PRESET_COLORS[index % PRESET_COLORS.length];
      badge.textContent = getInitials(acc.name);
    }
    badgeWrapper.appendChild(badge);

    // Notification Badge (Red pill or unread dot in bottom-right corner)
    const notifBadge = document.createElement('div');
    notifBadge.id = `notif-badge-${acc.id}`;
    const savedNotif = accountNotifications[acc.id];
    if (savedNotif) {
      if (savedNotif === '•') {
        notifBadge.className = 'notification-badge unread-dot';
        notifBadge.textContent = '';
      } else {
        notifBadge.className = 'notification-badge';
        notifBadge.textContent = savedNotif;
      }
    } else {
      notifBadge.className = 'notification-badge hidden';
    }
    badgeWrapper.appendChild(notifBadge);

    // Tooltip with account name & shortcut hint
    const tooltip = document.createElement('div');
    tooltip.className = 'badge-tooltip';
    const unreadTooltipText = savedNotif ? (savedNotif === '•' ? ' (Unread)' : ` (${savedNotif} unread)`) : '';
    const tooltipNameSpan = document.createElement('span');
    tooltipNameSpan.className = 'tooltip-name';
    tooltipNameSpan.textContent = `${acc.name}${unreadTooltipText}`;
    const tooltipShortcutSpan = document.createElement('span');
    tooltipShortcutSpan.className = 'tooltip-shortcut';
    tooltipShortcutSpan.textContent = `Ctrl+${index + 1}`;
    tooltip.appendChild(tooltipNameSpan);
    tooltip.appendChild(tooltipShortcutSpan);

    // Account Name Tag visible under the badge
    const nameLabel = document.createElement('span');
    nameLabel.className = 'account-name-tag';
    nameLabel.textContent = acc.name;
    nameLabel.title = acc.name;

    item.appendChild(pill);
    item.appendChild(badgeWrapper);
    item.appendChild(nameLabel);
    item.appendChild(tooltip);

    // Left click switches tab
    item.addEventListener('click', () => {
      switchAccount(acc.id);
    });

    // Right click opens context menu
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, acc.id);
    });

    accountStack.appendChild(item);
  });
}

/**
 * Ensure each account has an active or hidden <webview> tag.
 */
function syncWebviews() {
  // Create webview for each account if it doesn't already exist
  accounts.forEach((acc) => {
    getOrCreateWebview(acc);
  });

  // Remove any obsolete webviews
  const allWebviews = webviewContainer.querySelectorAll('.discord-webview');
  allWebviews.forEach((wv) => {
    const wvId = wv.id.replace('wv-', '');
    if (!accounts.some((acc) => acc.id === wvId)) {
      wv.remove();
    }
  });

  // Update visibility
  activateWebview(activeAccountId);
}

// ==========================================================================
// Network Disconnect & Error Resilience
// ==========================================================================

function showWebviewError(accountId, errorDescription, errorCode) {
  const account = accounts.find((a) => a.id === accountId);
  const accountName = account ? account.name : 'Account';

  // M5: Remove existing overlay completely to prevent event listener accumulation
  clearWebviewError(accountId);

  const overlay = document.createElement('div');
  overlay.id = `error-overlay-${accountId}`;
  overlay.className = 'webview-error-overlay';
  webviewContainer.appendChild(overlay);

  // Build error card using safe DOM APIs (H3: no innerHTML with user data)
  const card = document.createElement('div');
  card.className = 'error-card';

  const iconWrapper = document.createElement('div');
  iconWrapper.className = 'error-icon-wrapper';
  iconWrapper.innerHTML = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>`;
  card.appendChild(iconWrapper);

  const title = document.createElement('h2');
  title.className = 'error-title';
  title.textContent = 'Connection Lost';
  card.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'error-desc';
  desc.textContent = `Unable to connect to Discord for `;
  const strong = document.createElement('strong');
  strong.textContent = accountName;
  desc.appendChild(strong);
  desc.appendChild(document.createTextNode('. Check your internet connection or proxy settings.'));
  card.appendChild(desc);

  const codePill = document.createElement('div');
  codePill.className = 'error-code-pill';
  codePill.textContent = `${errorDescription || 'ERR_CONNECTION_FAILED'} (${errorCode || 'Unknown'})`;
  card.appendChild(codePill);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'error-actions-row';

  const btnRetry = document.createElement('button');
  btnRetry.className = 'btn-primary btn-retry-connection';
  btnRetry.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg><span>Retry Connection</span>`;
  btnRetry.addEventListener('click', () => {
    clearWebviewError(accountId);
    const wv = document.getElementById(`wv-${accountId}`);
    if (wv) {
      showLoading(true);
      try {
        if (typeof wv.reload === 'function') {
          wv.reload();
        } else {
          wv.src = 'https://discord.com/app';
        }
      } catch {
        wv.src = 'https://discord.com/app';
      }
    }
  });
  actionsRow.appendChild(btnRetry);

  const btnSettings = document.createElement('button');
  btnSettings.className = 'btn-secondary btn-proxy-settings';
  btnSettings.innerHTML = '<span>Edit Account</span>';
  btnSettings.addEventListener('click', () => {
    openEditAccountModal(accountId);
  });
  actionsRow.appendChild(btnSettings);

  card.appendChild(actionsRow);
  overlay.appendChild(card);

  updateErrorOverlayPositions();
}

function clearWebviewError(accountId) {
  const overlay = document.getElementById(`error-overlay-${accountId}`);
  if (overlay) {
    overlay.remove();
  }
}

function updateErrorOverlayPositions() {
  accounts.forEach((acc) => {
    const overlay = document.getElementById(`error-overlay-${acc.id}`);
    if (!overlay) return;

    if (isSplitView) {
      if (acc.id === splitPrimaryId) {
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.bottom = '0';
        overlay.style.left = '0';
        overlay.style.right = 'auto';
        overlay.style.width = '50%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '25';
      } else if (acc.id === splitSecondaryId) {
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.bottom = '0';
        overlay.style.left = '50%';
        overlay.style.right = '0';
        overlay.style.width = '50%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '25';
      } else {
        overlay.style.display = 'none';
      }
    } else {
      if (acc.id === activeAccountId) {
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.bottom = '0';
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '25';
      } else {
        overlay.style.display = 'none';
      }
    }
  });
}

/**
 * Create or retrieve the <webview> for a given account.
 */
function getOrCreateWebview(account) {
  let wv = document.getElementById(`wv-${account.id}`);
  if (!wv) {
    wv = document.createElement('webview');
    wv.id = `wv-${account.id}`;
    wv.className = 'discord-webview hidden-view';
    // Persistent partition isolation
    wv.setAttribute('partition', `persist:discord_account_${account.id}`);
    wv.setAttribute('src', 'https://discord.com/app');
    wv.setAttribute('allowpopups', 'true');

    // Webview loading event listeners
    wv.addEventListener('did-start-loading', () => {
      if (activeAccountId === account.id) {
        showLoading(true);
      }
    });

    wv.addEventListener('did-stop-loading', () => {
      if (activeAccountId === account.id) {
        showLoading(false);
      }
    });

    wv.addEventListener('did-fail-load', (e) => {
      console.warn(`Webview failed to load for account ${account.id}:`, e);
      if (activeAccountId === account.id) {
        showLoading(false);
      }
      // Display retry button overlay on network or proxy disconnect
      if (e.errorCode !== -3 && e.isMainFrame !== false) {
        showWebviewError(account.id, e.errorDescription, e.errorCode);
      }
    });

    // Notification & Title updated events from Discord
    wv.addEventListener('page-title-updated', (event) => {
      handleTitleNotifications(account.id, event.title);
    });

    const injectWebviewAudioBridge = () => {
      try {
        wv.executeJavaScript(`
          (() => {
            try {
              if (window.__discordMultiSpaceAudioPatched) return;
              window.__discordMultiSpaceAudioPatched = true;

              if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
                const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                  const safe = (typeof constraints === 'object' && constraints !== null)
                    ? Object.assign({}, constraints)
                    : { video: true };

                  // Ensure system audio loopback is always requested in constraints
                  if (!safe.audio || typeof safe.audio !== 'object') {
                    safe.audio = {
                      autoGainControl: false,
                      echoCancellation: false,
                      noiseSuppression: false,
                      systemAudio: 'include'
                    };
                  } else {
                    safe.audio.autoGainControl = false;
                    safe.audio.echoCancellation = false;
                    safe.audio.noiseSuppression = false;
                    safe.audio.systemAudio = 'include';
                  }

                  const stream = await originalGetDisplayMedia(safe);
                  const audioTracks = stream.getAudioTracks();
                  if (audioTracks && audioTracks.length > 0) {
                    audioTracks.forEach((track) => {
                      track.enabled = true;
                      if ('contentHint' in track) {
                        try { track.contentHint = 'music'; } catch (e) {}
                      }
                    });
                  }
                  return stream;
                };
              }
            } catch (e) {}
          })();
        `).catch(() => {});
      } catch (e) {}
    };

    wv.addEventListener('dom-ready', () => {
      clearWebviewError(account.id);
      pollAccountNotifications(account.id);
      applyAccountZoom(account.id);
      injectThemeIntoWebview(wv);
      injectWebviewAudioBridge();

      // Support seamless file drag-and-drop into Discord chat box
      wv.executeJavaScript(`
        (() => {
          window.addEventListener('dragover', (e) => {
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
              e.dataTransfer.dropEffect = 'copy';
            }
          });
        })()
      `).catch(() => {});
    });

    wv.addEventListener('did-navigate', injectWebviewAudioBridge);
    wv.addEventListener('did-navigate-in-page', injectWebviewAudioBridge);

    webviewContainer.appendChild(wv);
  }
  return wv;
}

/**
 * Switch active account tab instantly without reloading.
 */
function switchAccount(accountId) {
  saveActiveAccountId(accountId);

  // Update sidebar active class
  const items = accountStack.querySelectorAll('.account-item');
  items.forEach((item) => {
    if (item.dataset.accountId === accountId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  if (isSplitView) {
    if (splitSecondaryId === accountId) {
      // Swap primary and secondary panes
      splitSecondaryId = splitPrimaryId;
    }
    splitPrimaryId = accountId;
    renderSplitView();
  } else {
    activateWebview(accountId);
  }

  wakeAccountIfHibernating(accountId);
  sendTrayStatus();
  pollAccountNotifications(accountId);
}

/**
 * Toggle webview active / hidden classes.
 */
function activateWebview(accountId) {
  const allWebviews = webviewContainer.querySelectorAll('.discord-webview');
  allWebviews.forEach((wv) => {
    if (wv.id === `wv-${accountId}`) {
      wv.classList.remove('hidden-view');
      wv.classList.add('active-view');
      applyAccountZoom(accountId);
      wv.focus();
    } else {
      wv.classList.remove('active-view');
      wv.classList.add('hidden-view');
    }
  });
  updateErrorOverlayPositions();
}

/**
 * Parse notification badge value from Discord's document title.
 * Examples:
 *  - "(4) Discord | #general" -> "4"
 *  - "(1) Discord | Friends" -> "1"
 *  - "(99+) Discord" -> "99+"
 *  - "• Discord | Friends" -> "•"
 *  - "Discord | Friends" -> 0
 */
function handleTitleNotifications(accountId, title) {
  if (!title) {
    updateNotificationBadge(accountId, 0);
    return;
  }

  // 1. Direct mention / DM format: "(4) Discord", "(1) Discord | #welcome", "(99+) Discord"
  const mentionMatch = title.match(/^\(([^)]+)\)/);
  if (mentionMatch && mentionMatch[1]) {
    updateNotificationBadge(accountId, mentionMatch[1]);
    return;
  }

  // 2. Unread channel messages dot: "• Discord" or title containing "•" or "(*)"
  if (title.includes('•') || title.startsWith('(*)')) {
    updateNotificationBadge(accountId, '•');
    return;
  }

  // 3. Normal title without unreads
  updateNotificationBadge(accountId, 0);
}

/**
 * Update the notification badge on an account's sidebar icon.
 * @param {string} accountId
 * @param {string|number|null} rawValue - e.g. "4", 4, "•", or 0/null
 */
function updateNotificationBadge(accountId, rawValue) {
  const notifEl = document.getElementById(`notif-badge-${accountId}`);

  let formatted = null;
  if (rawValue && rawValue !== 0 && rawValue !== '0') {
    if (rawValue === '•' || rawValue === '*') {
      formatted = '•';
    } else {
      const num = parseInt(rawValue, 10);
      if (!isNaN(num)) {
        formatted = num > 99 ? '99+' : String(num);
      } else if (typeof rawValue === 'string') {
        formatted = rawValue.trim();
      }
    }
  }

  const prev = accountNotifications[accountId];
  if (formatted) {
    accountNotifications[accountId] = formatted;
  } else {
    delete accountNotifications[accountId];
  }

  // Update DOM element if rendered
  if (notifEl) {
    if (!formatted) {
      notifEl.className = 'notification-badge hidden';
      notifEl.textContent = '';
    } else if (formatted === '•') {
      notifEl.className = 'notification-badge unread-dot';
      notifEl.textContent = '';
    } else {
      notifEl.className = 'notification-badge';
      notifEl.textContent = formatted;
    }
  }

  // Update tooltip if rendered
  const item = document.querySelector(`.account-item[data-account-id="${accountId}"]`);
  if (item) {
    const tooltipName = item.querySelector('.tooltip-name');
    const acc = accounts.find((a) => a.id === accountId);
    if (tooltipName && acc) {
      const unreadHint = formatted ? (formatted === '•' ? ' (Unread)' : ` (${formatted} unread)`) : '';
      tooltipName.textContent = `${acc.name}${unreadHint}`;
    }
  }

  // Update window title and tray status if notification status changed
  if (prev !== formatted) {
    sendTrayStatus();
  }
}

/**
 * Poll notifications directly from guest webview DOM or getTitle()
 */
async function pollAccountNotifications(accountId) {
  const wv = document.getElementById(`wv-${accountId}`);
  if (!wv) return;

  try {
    if (typeof wv.getTitle === 'function') {
      const title = wv.getTitle();
      if (title) {
        handleTitleNotifications(accountId, title);
        return;
      }
    }

    // Secondary fallback: check DOM badges inside Discord guest page
    const res = await wv.executeJavaScript(`
      (() => {
        const title = document.title || '';
        const match = title.match(/^\\(([^)]+)\\)/);
        if (match) return match[1];
        if (title.includes('•') || title.startsWith('(*)')) return '•';

        // Check Discord DOM badges
        const badges = document.querySelectorAll('[class*="numberBadge"], [class*="unreadMentionsIndicator"]');
        let total = 0;
        badges.forEach(b => {
          const n = parseInt(b.textContent, 10);
          if (!isNaN(n)) total += n;
        });
        if (total > 0) return total > 99 ? '99+' : String(total);
        if (document.querySelector('[class*="unread_"]')) return '•';

        return 0;
      })()
    `);

    // M2: Type-check return values before trusting guest content
    if (res !== undefined && res !== null && (typeof res === 'string' || typeof res === 'number')) {
      updateNotificationBadge(accountId, res);
    }
  } catch {
    // Guest webview not ready or navigating
  }
}

// M4: Poll at 10s interval (primary signal is page-title-updated), skip hibernated accounts
setInterval(() => {
  accounts.forEach((acc) => {
    if (accountHibernating[acc.id]) return;
    pollAccountNotifications(acc.id);
  });
}, 10000);

/**
 * Visual loading bar controller.
 */
function showLoading(isLoading) {
  if (isLoading) {
    loadingBar.classList.add('active');
  } else {
    loadingBar.classList.remove('active');
  }
}

/**
 * Update the avatar preview in the modal based on current selection.
 */
function updateModalAvatarPreview() {
  const name = inputAccountName.value.trim() || 'Account';
  if (currentAvatarDataUrl) {
    modalAvatarPreview.style.backgroundImage = `url("${currentAvatarDataUrl}")`;
    modalAvatarPreview.style.backgroundColor = 'transparent';
    modalAvatarPreview.textContent = '';
    btnRemoveAvatar.classList.remove('hidden');
  } else {
    modalAvatarPreview.style.backgroundImage = 'none';
    modalAvatarPreview.style.backgroundColor = selectedColor;
    modalAvatarPreview.textContent = getInitials(name);
    btnRemoveAvatar.classList.add('hidden');
  }
}

/**
 * Handle avatar image upload with automatic square crop & optimization.
 */
function handleAvatarFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Downscale to 128x128 center-cropped for crisp display and lightweight localStorage
      const canvas = document.createElement('canvas');
      const size = 128;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      currentAvatarDataUrl = canvas.toDataURL('image/png');
      updateModalAvatarPreview();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/**
 * Build the color picker inside the modal.
 */
function renderColorPalette() {
  colorPalette.innerHTML = '';
  PRESET_COLORS.forEach((color) => {
    const opt = document.createElement('div');
    opt.className = `color-option ${color.toLowerCase() === selectedColor.toLowerCase() ? 'selected' : ''}`;
    opt.style.backgroundColor = color;
    opt.addEventListener('click', () => {
      selectedColor = color;
      renderColorPalette();
      updateModalAvatarPreview();
    });
    colorPalette.appendChild(opt);
  });
}

/**
 * Open Modal in Create mode.
 */
function openAddAccountModal() {
  modalMode = 'create';
  modalTitle.textContent = 'Add New Account';
  btnModalSubmit.textContent = 'Create Account';

  const nextIndex = accounts.length + 1;
  inputAccountName.value = `Account ${nextIndex}`;
  inputAccountProxy.value = '';
  selectedColor = PRESET_COLORS[(nextIndex - 1) % PRESET_COLORS.length];
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';

  renderColorPalette();
  updateModalAvatarPreview();
  modalOverlay.classList.add('active');
  inputAccountName.focus();
  inputAccountName.select();
}

/**
 * Open Modal in Edit/Rename mode.
 */
function openEditAccountModal(accountId) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;

  editingAccountId = accountId;
  modalMode = 'edit';
  modalTitle.textContent = 'Edit Account';
  btnModalSubmit.textContent = 'Save Changes';

  inputAccountName.value = account.name;
  inputAccountProxy.value = account.proxy || '';
  selectedColor = account.color || PRESET_COLORS[0];
  currentAvatarDataUrl = account.avatar || null;
  inputAccountAvatar.value = '';

  renderColorPalette();
  updateModalAvatarPreview();
  modalOverlay.classList.add('active');
  inputAccountName.focus();
  inputAccountName.select();
}

/**
 * Close Modal.
 */
function closeModal() {
  modalOverlay.classList.remove('active');
  inputAccountName.value = '';
  inputAccountProxy.value = '';
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';
  editingAccountId = null;
}

/**
 * Submit Modal (Create or Update).
 */
function handleModalSubmit() {
  const name = inputAccountName.value.trim();
  if (!name) return;
  const proxy = inputAccountProxy.value.trim();

  if (modalMode === 'create') {
    const newId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    const newAccount = {
      id: newId,
      name: name,
      color: selectedColor,
      avatar: currentAvatarDataUrl,
      proxy: proxy
    };

    accounts.push(newAccount);
    saveAccounts();
    renderAccountStack();
    syncWebviews();
    if (proxy) applyAccountProxy(newId, proxy);
    switchAccount(newId);
  } else if (modalMode === 'edit') {
    const target = accounts.find((a) => a.id === editingAccountId);
    if (target) {
      target.name = name;
      target.color = selectedColor;
      target.avatar = currentAvatarDataUrl;
      target.proxy = proxy;
      saveAccounts();
      renderAccountStack();
      sendTrayStatus();
      applyAccountProxy(target.id, proxy);
      if (isSplitView) renderSplitView();
    }
  }

  closeModal();
}

/**
 * Remove an account and its webview.
 */
function removeAccount(accountId) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;

  const confirmed = confirm(`Are you sure you want to remove "${account.name}"? Active session data will be preserved in your profile.`);
  if (!confirmed) return;

  // Remove webview from DOM
  const wv = document.getElementById(`wv-${accountId}`);
  if (wv) wv.remove();
  clearWebviewError(accountId);

  // Remove from accounts
  accounts = accounts.filter((a) => a.id !== accountId);
  delete accountNotifications[accountId];

  // If no accounts left, reset to Account 1
  if (accounts.length === 0) {
    accounts = [
      {
        id: Date.now().toString(36),
        name: 'Account 1',
        color: PRESET_COLORS[0]
      }
    ];
  }

  saveAccounts();

  // If we deleted the active account, switch to another
  if (activeAccountId === accountId) {
    activeAccountId = accounts[0].id;
    saveActiveAccountId(activeAccountId);
  }

  renderAccountStack();
  syncWebviews();
  sendTrayStatus();
}

/**
 * Reload active account webview.
 */
function reloadActiveAccount(ignoreCache = false) {
  triggerReloadAnimation();
  const activeWv = document.getElementById(`wv-${activeAccountId}`);
  if (activeWv) {
    showLoading(true);
    try {
      if (ignoreCache && typeof activeWv.reloadIgnoringCache === 'function') {
        activeWv.reloadIgnoringCache();
      } else if (typeof activeWv.reload === 'function') {
        activeWv.reload();
      } else {
        activeWv.src = 'https://discord.com/app';
      }
    } catch (err) {
      console.warn('Error reloading webview:', err);
      activeWv.src = 'https://discord.com/app';
    }
  }
}

/**
 * Reload entire MultiSpace client application UI without restarting process.
 */
function reloadApp() {
  triggerReloadAnimation();
  try {
    eAPI.send('app-reload-window');
  } catch {
    window.location.reload();
  }
}

/**
 * Trigger visual rotation animation on the reload icon.
 */
function triggerReloadAnimation() {
  const badge = btnReloadActive ? btnReloadActive.querySelector('.action-badge') : null;
  if (badge) {
    badge.classList.remove('spinning');
    void badge.offsetWidth;
    badge.classList.add('spinning');
    setTimeout(() => badge.classList.remove('spinning'), 650);
  }
}

/**
 * Context Menu Management.
 */
function openContextMenu(x, y, accountId) {
  closeReloadContextMenu();
  contextTargetAccountId = accountId;
  const target = accounts.find((a) => a.id === accountId);
  if (target) {
    ctxAccountTitle.textContent = target.name;
  }

  contextMenu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  contextMenu.classList.add('visible');
}

function closeContextMenu() {
  contextMenu.classList.remove('visible');
  contextTargetAccountId = null;
}

function openReloadContextMenu(x, y) {
  closeContextMenu();
  if (reloadContextMenu) {
    const menuWidth = 230;
    const menuHeight = 170;
    const posX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
    const posY = Math.max(10, Math.min(y - 120, window.innerHeight - menuHeight - 10));
    reloadContextMenu.style.left = `${posX}px`;
    reloadContextMenu.style.top = `${posY}px`;
    reloadContextMenu.classList.add('visible');
  }
}

function closeReloadContextMenu() {
  if (reloadContextMenu) {
    reloadContextMenu.classList.remove('visible');
  }
}

// Global Event Listeners
window.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) {
    closeContextMenu();
  }
  if (reloadContextMenu && !reloadContextMenu.contains(e.target)) {
    closeReloadContextMenu();
  }
});

window.addEventListener('keydown', (e) => {
  // ESC to close modal or context menus
  if (e.key === 'Escape') {
    closeContextMenu();
    closeReloadContextMenu();
    closeModal();
    if (settingsModalOverlay) settingsModalOverlay.classList.remove('active');
    if (typeof closeScreenPicker === 'function') closeScreenPicker(true);
  }

  // Enter to submit modal if open
  if (e.key === 'Enter') {
    if (modalOverlay.classList.contains('active')) {
      handleModalSubmit();
    } else if (typeof screenPickerModal !== 'undefined' && screenPickerModal && screenPickerModal.classList.contains('active')) {
      if (typeof submitScreenPicker === 'function') submitScreenPicker();
    }
  }

  // Ctrl+Shift+R or Shift+F5 to reload entire app UI
  if (e.shiftKey && (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R')))) {
    e.preventDefault();
    reloadApp();
    return;
  }

  // F5 or Ctrl+R to reload active account webview
  if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
    e.preventDefault();
    reloadActiveAccount(false);
  }

  // Ctrl + 1..9 to switch tabs
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const targetIdx = parseInt(e.key, 10) - 1;
    if (accounts[targetIdx]) {
      e.preventDefault();
      switchAccount(accounts[targetIdx].id);
    }
  }

  // Ctrl + Tab to cycle accounts
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const currentIdx = accounts.findIndex((a) => a.id === activeAccountId);
    if (currentIdx !== -1) {
      const nextIdx = (currentIdx + (e.shiftKey ? -1 : 1) + accounts.length) % accounts.length;
      switchAccount(accounts[nextIdx].id);
    }
  }
});

// Add Account button
btnAddAccount.addEventListener('click', () => {
  openAddAccountModal();
});

// Reload button: click for webview reload, shift+click for client app reload, right-click for menu
btnReloadActive.addEventListener('click', (e) => {
  if (e.shiftKey) {
    reloadApp();
  } else {
    reloadActiveAccount(false);
  }
});

btnReloadActive.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openReloadContextMenu(e.clientX, e.clientY);
});

if (btnOpenSettings) {
  btnOpenSettings.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openReloadContextMenu(e.clientX, e.clientY);
  });
}

// Reload Context Menu Actions
ctxReloadTab.addEventListener('click', () => {
  closeReloadContextMenu();
  reloadActiveAccount(false);
});

ctxReloadTabHard.addEventListener('click', () => {
  closeReloadContextMenu();
  reloadActiveAccount(true);
});

ctxReloadApp.addEventListener('click', () => {
  closeReloadContextMenu();
  reloadApp();
});

// Modal Actions
btnModalCancel.addEventListener('click', closeModal);
btnModalSubmit.addEventListener('click', handleModalSubmit);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Live update avatar preview when account name changes
inputAccountName.addEventListener('input', () => {
  updateModalAvatarPreview();
});

// Avatar Upload & Removal Event Listeners
btnUploadAvatar.addEventListener('click', () => {
  inputAccountAvatar.click();
});

avatarPreviewBox.addEventListener('click', () => {
  inputAccountAvatar.click();
});

inputAccountAvatar.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleAvatarFile(e.target.files[0]);
  }
});

btnRemoveAvatar.addEventListener('click', () => {
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';
  updateModalAvatarPreview();
});

// Context Menu Actions
ctxActionEdit.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  if (targetId) openEditAccountModal(targetId);
});

ctxActionReload.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  const targetWv = document.getElementById(`wv-${targetId}`);
  if (targetWv) {
    if (targetId === activeAccountId) showLoading(true);
    targetWv.reload();
  }
});

if (ctxActionClearCache) {
  ctxActionClearCache.addEventListener('click', () => {
    const targetId = contextTargetAccountId;
    closeContextMenu();
    if (!targetId) return;
    const target = accounts.find((a) => a.id === targetId);
    const accountName = target ? target.name : 'Account';
    eAPI.send('clear-account-cache', {
      partition: `persist:discord_account_${targetId}`,
      accountName: accountName
    });
    showToast(`Cache cleared for ${accountName}`);
  });
}

ctxActionDelete.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  if (targetId) removeAccount(targetId);
});

// ==========================================================================
// Side-by-Side Dual Split View Management
// ==========================================================================

/**
 * Toggle Side-by-Side Split View mode.
 */
function toggleSplitView() {
  if (accounts.length < 2) {
    alert('Dual Split View requires at least 2 accounts. Click the "+" button to add another account first.');
    return;
  }

  isSplitView = !isSplitView;

  if (isSplitView) {
    splitPrimaryId = activeAccountId;
    const otherAcc = accounts.find((a) => a.id !== splitPrimaryId) || accounts[1];
    splitSecondaryId = otherAcc ? otherAcc.id : null;
  }

  renderSplitView();
}

/**
 * Render Split View or restore single view.
 */
function renderSplitView() {
  const splitBadge = btnSplitView ? btnSplitView.querySelector('.action-badge') : null;

  if (isSplitView && splitPrimaryId && splitSecondaryId) {
    webviewContainer.classList.add('split-mode');
    splitHeader.classList.remove('hidden');
    if (splitBadge) splitBadge.classList.add('active');

    // Populate dropdown selectors
    splitSelectPrimary.innerHTML = '';
    splitSelectSecondary.innerHTML = '';

    accounts.forEach((acc) => {
      const opt1 = document.createElement('option');
      opt1.value = acc.id;
      opt1.textContent = acc.name;
      if (acc.id === splitPrimaryId) opt1.selected = true;
      splitSelectPrimary.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = acc.id;
      opt2.textContent = acc.name;
      if (acc.id === splitSecondaryId) opt2.selected = true;
      splitSelectSecondary.appendChild(opt2);
    });

    // Configure webviews
    const allWebviews = webviewContainer.querySelectorAll('.discord-webview');
    allWebviews.forEach((wv) => {
      const wvId = wv.id.replace('wv-', '');
      if (wvId === splitPrimaryId) {
        wv.className = 'discord-webview split-pane';
        wv.style.position = 'absolute';
        wv.style.top = '0px';
        wv.style.bottom = '0px';
        wv.style.left = '0px';
        wv.style.right = 'auto';
        wv.style.width = '50%';
        wv.style.height = '100%';
        wv.style.display = 'flex';
        wv.style.visibility = 'visible';
        wv.style.pointerEvents = 'auto';
        wv.style.zIndex = '5';
        wv.focus();
      } else if (wvId === splitSecondaryId) {
        wv.className = 'discord-webview split-pane split-pane-secondary';
        wv.style.position = 'absolute';
        wv.style.top = '0px';
        wv.style.bottom = '0px';
        wv.style.left = '50%';
        wv.style.right = '0px';
        wv.style.width = '50%';
        wv.style.height = '100%';
        wv.style.display = 'flex';
        wv.style.visibility = 'visible';
        wv.style.pointerEvents = 'auto';
        wv.style.zIndex = '5';
      } else {
        wv.className = 'discord-webview hidden-view';
        wv.style.cssText = '';
      }
    });

    accountLastActive[splitPrimaryId] = Date.now();
    accountLastActive[splitSecondaryId] = Date.now();

    applyAccountZoom(splitPrimaryId);
    applyAccountZoom(splitSecondaryId);
  } else {
    isSplitView = false;
    webviewContainer.classList.remove('split-mode');
    splitHeader.classList.add('hidden');
    if (splitBadge) splitBadge.classList.remove('active');
    const allWebviews = webviewContainer.querySelectorAll('.discord-webview');
    allWebviews.forEach((wv) => {
      wv.style.cssText = '';
    });
    activateWebview(activeAccountId);
  }
  updateErrorOverlayPositions();
}

if (btnSplitView) {
  btnSplitView.addEventListener('click', toggleSplitView);
}

if (splitSelectPrimary) {
  splitSelectPrimary.addEventListener('change', (e) => {
    const newPrimary = e.target.value;
    if (newPrimary === splitSecondaryId) {
      splitSecondaryId = splitPrimaryId;
    }
    splitPrimaryId = newPrimary;
    activeAccountId = splitPrimaryId;
    saveActiveAccountId(splitPrimaryId);
    renderAccountStack();
    renderSplitView();
  });
}

if (splitSelectSecondary) {
  splitSelectSecondary.addEventListener('change', (e) => {
    const newSecondary = e.target.value;
    if (newSecondary === splitPrimaryId) {
      splitPrimaryId = splitSecondaryId;
      activeAccountId = splitPrimaryId;
      saveActiveAccountId(splitPrimaryId);
      renderAccountStack();
    }
    splitSecondaryId = newSecondary;
    renderSplitView();
  });
}

if (btnCloseSplit) {
  btnCloseSplit.addEventListener('click', () => {
    isSplitView = false;
    renderSplitView();
  });
}

// ==========================================================================
// Global Mute & Deafen Quick Actions
// ==========================================================================

/**
 * Set Discord Mute state on a guest webview.
 * Inspects Discord's DOM to click the mute/unmute button only if state differs,
 * falling back to a single input event (avoiding double-toggling).
 */
function setDiscordMuteState(wv, targetMuted) {
  if (!wv) return;
  const script = `
    (() => {
      try {
        const targetMuted = ${Boolean(targetMuted)};
        const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
        const muteBtn = buttons.find((b) => {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          return l.includes('mute');
        });

        if (muteBtn) {
          const label = (muteBtn.getAttribute('aria-label') || '').toLowerCase();
          const isCurrentlyMuted = label.includes('unmute');
          if (targetMuted !== isCurrentlyMuted) {
            muteBtn.click();
            return { success: true, method: 'dom-click' };
          }
          return { success: true, method: 'already-in-state' };
        }
        return { success: false, method: 'button-not-found' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })()
  `;

  wv.executeJavaScript(script).then((res) => {
    if (!res || !res.success || res.method === 'button-not-found') {
      // Single shortcut event without artificial duplicate DOM event
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'shift'] });
      wv.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'shift'] });
    }
  }).catch(() => {
    wv.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'shift'] });
    wv.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'shift'] });
  });
}

/**
 * Set Discord Deafen state on a guest webview.
 * Inspects Discord's DOM to click the deafen/undeafen button only if state differs,
 * falling back to a single input event (avoiding double-toggling).
 */
function setDiscordDeafenState(wv, targetDeafened) {
  if (!wv) return;
  const script = `
    (() => {
      try {
        const targetDeafened = ${Boolean(targetDeafened)};
        const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
        const deafenBtn = buttons.find((b) => {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          return l.includes('deafen');
        });

        if (deafenBtn) {
          const label = (deafenBtn.getAttribute('aria-label') || '').toLowerCase();
          const isCurrentlyDeafened = label.includes('undeafen');
          if (targetDeafened !== isCurrentlyDeafened) {
            deafenBtn.click();
            return { success: true, method: 'dom-click' };
          }
          return { success: true, method: 'already-in-state' };
        }
        return { success: false, method: 'button-not-found' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })()
  `;

  wv.executeJavaScript(script).then((res) => {
    try {
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(targetDeafened);
      }
    } catch {}

    if (!res || !res.success || res.method === 'button-not-found') {
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['control', 'shift'] });
      wv.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['control', 'shift'] });
    }
  }).catch(() => {
    try {
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(targetDeafened);
      }
    } catch {}
    wv.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['control', 'shift'] });
    wv.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['control', 'shift'] });
  });
}

/**
 * Toggle Mute All across open accounts.
 */
function toggleMuteAll() {
  isMutedAll = !isMutedAll;
  if (btnMuteAll) {
    btnMuteAll.classList.toggle('active-muted', isMutedAll);
  }

  accounts.forEach((acc) => {
    const wv = document.getElementById(`wv-${acc.id}`);
    if (wv) {
      setDiscordMuteState(wv, isMutedAll);
    }
  });

  showToast(isMutedAll ? 'All accounts muted' : 'All accounts unmuted');
}

/**
 * Toggle Deafen All across open accounts.
 */
function toggleDeafenAll() {
  isDeafenedAll = !isDeafenedAll;
  if (btnDeafenAll) {
    btnDeafenAll.classList.toggle('active-deafened', isDeafenedAll);
  }

  accounts.forEach((acc) => {
    const wv = document.getElementById(`wv-${acc.id}`);
    if (wv) {
      setDiscordDeafenState(wv, isDeafenedAll);
    }
  });

  showToast(isDeafenedAll ? 'All accounts deafened' : 'All accounts undeafened');
}

if (btnMuteAll) {
  btnMuteAll.addEventListener('click', toggleMuteAll);
}

if (btnDeafenAll) {
  btnDeafenAll.addEventListener('click', toggleDeafenAll);
}

eAPI.on('trigger-global-mute-all', () => {
  toggleMuteAll();
});

eAPI.on('trigger-global-deafen-all', () => {
  toggleDeafenAll();
});

// ==========================================================================
// Toast Notification Utility
// ==========================================================================
function showToast(message, duration = 2500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'app-toast';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  toast.appendChild(iconSpan);

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
  }, duration);
}

// ==========================================================================
// File Drag & Drop Attachment Pass-Through & Navigation Blocker
// ==========================================================================
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    e.preventDefault();
  }, false);

  document.addEventListener(eventName, (e) => {
    e.preventDefault();
  }, false);
});

if (webviewContainer) {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    webviewContainer.addEventListener(eventName, (e) => {
      e.preventDefault();
    }, false);
  });
}

// ==========================================================================
// Emergency Privacy "Boss Key" Audio Muting Handlers
// ==========================================================================
let audioMuteStateBeforeBossKey = {};

eAPI.on('boss-key-mute-all', () => {
  audioMuteStateBeforeBossKey = {};
  const allWebviews = webviewContainer ? webviewContainer.querySelectorAll('.discord-webview') : [];
  allWebviews.forEach((wv) => {
    try {
      if (typeof wv.isAudioMuted === 'function') {
        audioMuteStateBeforeBossKey[wv.id] = wv.isAudioMuted();
      }
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(true);
      }
    } catch {}
  });
});

eAPI.on('boss-key-unmute-all', () => {
  const allWebviews = webviewContainer ? webviewContainer.querySelectorAll('.discord-webview') : [];
  allWebviews.forEach((wv) => {
    try {
      const wasMuted = audioMuteStateBeforeBossKey[wv.id];
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(wasMuted === true);
      }
    } catch {}
  });
  audioMuteStateBeforeBossKey = {};
});

// ==========================================================================
// Background Memory Saver / Hibernation
// ==========================================================================

/**
 * Wake an account from hibernation if it was sleeping.
 */
function wakeAccountIfHibernating(accountId) {
  accountLastActive[accountId] = Date.now();
  if (accountHibernating[accountId]) {
    delete accountHibernating[accountId];
    const wv = document.getElementById(`wv-${accountId}`);
    if (wv) {
      try {
        if (typeof wv.setAudioMuted === 'function') {
          wv.setAudioMuted(false);
        }
      } catch {}
    }
  }
}

/**
 * Check background accounts for hibernation (>15 min idle, not in voice).
 */
async function checkMemorySaverHibernation() {
  if (!memorySaverEnabled) return;

  const now = Date.now();
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  for (const acc of accounts) {
    // Never hibernate active or visible split panes
    if (acc.id === activeAccountId) continue;
    if (isSplitView && (acc.id === splitPrimaryId || acc.id === splitSecondaryId)) continue;

    const lastActive = accountLastActive[acc.id] || now;
    if (now - lastActive > FIFTEEN_MINUTES) {
      const wv = document.getElementById(`wv-${acc.id}`);
      if (!wv) continue;

      try {
        // Check if currently inside active voice call
        const inVoice = await wv.executeJavaScript(`
          (() => {
            return !!document.querySelector('[class*="rtcConnectionStatusConnected"], [class*="voiceChannelEffect"], [class*="connected_"]');
          })()
        `);

        if (!inVoice && !accountHibernating[acc.id]) {
          accountHibernating[acc.id] = true;
          if (typeof wv.setAudioMuted === 'function') {
            wv.setAudioMuted(true);
          }
        }
      } catch {
        // Guest not ready
      }
    }
  }
}

// Memory saver check every 30 seconds
setInterval(checkMemorySaverHibernation, 30000);

// ==========================================================================
// Settings Modal Event Listeners
// ==========================================================================

if (btnOpenSettings) {
  btnOpenSettings.addEventListener('click', async () => {
    if (toggleMemorySaver) {
      toggleMemorySaver.checked = memorySaverEnabled;
    }
    if (toggleStartup) {
      try {
        const isStartup = await eAPI.invoke('get-startup-setting');
        toggleStartup.checked = Boolean(isStartup);
      } catch {
        toggleStartup.checked = false;
      }
    }
    updateReloadButtonVisibility();
    updateThemeUI();
    if (settingsModalOverlay) {
      settingsModalOverlay.classList.add('active');
    }
  });
}

if (btnSettingsClose) {
  btnSettingsClose.addEventListener('click', () => {
    if (settingsModalOverlay) {
      settingsModalOverlay.classList.remove('active');
    }
  });
}

const btnSettingsForceReload = document.getElementById('btn-settings-force-reload');
if (btnSettingsForceReload) {
  btnSettingsForceReload.addEventListener('click', () => {
    if (settingsModalOverlay) {
      settingsModalOverlay.classList.remove('active');
    }
    reloadApp();
  });
}

if (settingsModalOverlay) {
  settingsModalOverlay.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) {
      settingsModalOverlay.classList.remove('active');
    }
  });
}

if (toggleMemorySaver) {
  toggleMemorySaver.addEventListener('change', (e) => {
    memorySaverEnabled = e.target.checked;
    localStorage.setItem('multispace_memory_saver', String(memorySaverEnabled));
    if (!memorySaverEnabled) {
      // Wake all hibernating accounts
      accounts.forEach((acc) => {
        wakeAccountIfHibernating(acc.id);
      });
    }
  });
}

if (toggleStartup) {
  toggleStartup.addEventListener('change', (e) => {
    eAPI.send('set-startup-setting', e.target.checked);
  });
}

const toggleShowReloadBtn = document.getElementById('toggle-show-reload-btn');
if (toggleShowReloadBtn) {
  toggleShowReloadBtn.addEventListener('change', (e) => {
    showReloadBtn = e.target.checked;
    localStorage.setItem(STORAGE_SHOW_RELOAD_BTN_KEY, String(showReloadBtn));
    updateReloadButtonVisibility();
    showToast(showReloadBtn ? 'Reload button enabled' : 'Reload button hidden');
  });
}

// Community Theme Directory links (openExternal in default web browser via preload bridge)
const themeSourceLinks = document.querySelectorAll('.theme-source-link');
themeSourceLinks.forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const url = btn.dataset.url;
    if (url) {
      eAPI.openExternal(url);
    }
  });
});

// Preset Cards 1-click apply
const presetCards = document.querySelectorAll('.theme-preset-card');
presetCards.forEach((card) => {
  card.addEventListener('click', () => {
    const presetId = card.dataset.preset;
    applyTheme(presetId);
  });
});

// Custom CSS Apply & Clear buttons
const btnApplyTheme = document.getElementById('btn-apply-theme');
const btnClearTheme = document.getElementById('btn-clear-theme');
const inputThemeCss = document.getElementById('input-theme-css');

if (btnApplyTheme && inputThemeCss) {
  btnApplyTheme.addEventListener('click', () => {
    const css = inputThemeCss.value.trim();
    applyTheme('custom', css);
  });
}

if (btnClearTheme) {
  btnClearTheme.addEventListener('click', () => {
    applyTheme('default', '');
  });
}

// ==========================================================================
// Native WebRTC Screen & Application Share Picker Engine
// ==========================================================================
const screenPickerModal = document.getElementById('screen-picker-modal-overlay');
const screenPickerGrid = document.getElementById('screen-picker-grid');
const tabPickerScreens = document.getElementById('tab-picker-screens');
const tabPickerWindows = document.getElementById('tab-picker-windows');
const badgeScreensCount = document.getElementById('badge-screens-count');
const badgeWindowsCount = document.getElementById('badge-windows-count');
const btnScreenPickerCancel = document.getElementById('btn-screen-picker-cancel');
const btnScreenPickerCloseX = document.getElementById('btn-screen-picker-close-x');
const btnScreenPickerSubmit = document.getElementById('btn-screen-picker-submit');
const screenPickerAudioToggle = document.getElementById('screen-picker-audio-toggle');

let currentScreenPickerRequestId = null;
let currentScreenPickerSources = [];
let selectedScreenPickerSourceId = null;
let currentScreenPickerTab = 'screens'; // 'screens' | 'windows'

function openScreenPicker({ requestId, sources }) {
  currentScreenPickerRequestId = requestId;
  currentScreenPickerSources = Array.isArray(sources) ? sources : [];
  selectedScreenPickerSourceId = null;

  const screens = currentScreenPickerSources.filter((s) => s.id.startsWith('screen:'));
  const windows = currentScreenPickerSources.filter((s) => s.id.startsWith('window:'));

  if (badgeScreensCount) badgeScreensCount.textContent = String(screens.length);
  if (badgeWindowsCount) badgeWindowsCount.textContent = String(windows.length);

  // Default to screens if available, otherwise windows
  currentScreenPickerTab = screens.length > 0 ? 'screens' : 'windows';
  updateScreenPickerTabs();
  renderScreenPickerSources();

  if (btnScreenPickerSubmit) {
    btnScreenPickerSubmit.disabled = true;
  }

  if (screenPickerModal) {
    screenPickerModal.classList.add('active');
  }
}

function closeScreenPicker(wasCancelled = true) {
  if (!screenPickerModal || !screenPickerModal.classList.contains('active')) return;

  screenPickerModal.classList.remove('active');

  if (wasCancelled && currentScreenPickerRequestId) {
    eAPI.send('screen-picker-cancel', { requestId: currentScreenPickerRequestId });
  }

  currentScreenPickerRequestId = null;
  currentScreenPickerSources = [];
  selectedScreenPickerSourceId = null;
}

function updateScreenPickerTabs() {
  if (tabPickerScreens) {
    tabPickerScreens.classList.toggle('active', currentScreenPickerTab === 'screens');
  }
  if (tabPickerWindows) {
    tabPickerWindows.classList.toggle('active', currentScreenPickerTab === 'windows');
  }
}

function renderScreenPickerSources() {
  if (!screenPickerGrid) return;
  screenPickerGrid.innerHTML = '';

  const isScreensTab = currentScreenPickerTab === 'screens';
  const filtered = currentScreenPickerSources.filter((s) =>
    isScreensTab ? s.id.startsWith('screen:') : s.id.startsWith('window:')
  );

  if (filtered.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'screen-picker-empty';
    emptyDiv.textContent = isScreensTab ? 'No displays detected.' : 'No open applications found.';
    screenPickerGrid.appendChild(emptyDiv);
    return;
  }

  filtered.forEach((source) => {
    const card = document.createElement('div');
    card.className = `screen-source-card ${selectedScreenPickerSourceId === source.id ? 'selected' : ''}`;
    card.dataset.sourceId = source.id;

    // Preview wrap
    const previewWrap = document.createElement('div');
    previewWrap.className = 'screen-source-preview-wrap';

    if (source.thumbnail) {
      const img = document.createElement('img');
      img.className = 'screen-source-thumb';
      img.src = source.thumbnail;
      img.alt = source.name || 'Preview';
      previewWrap.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'screen-source-thumb-fallback';
      fallback.innerHTML = isScreensTab
        ? '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>'
        : '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>';
      previewWrap.appendChild(fallback);
    }

    // Selected checkmark badge
    const checkBadge = document.createElement('div');
    checkBadge.className = 'screen-source-selected-badge';
    checkBadge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    previewWrap.appendChild(checkBadge);

    // Footer with icon + name
    const footer = document.createElement('div');
    footer.className = 'screen-source-footer';

    if (source.appIcon) {
      const iconImg = document.createElement('img');
      iconImg.className = 'screen-source-icon';
      iconImg.src = source.appIcon;
      iconImg.alt = '';
      footer.appendChild(iconImg);
    } else {
      const defaultIcon = document.createElement('div');
      defaultIcon.style.cssText = 'width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; color: var(--text-muted);';
      defaultIcon.innerHTML = isScreensTab
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line></svg>';
      footer.appendChild(defaultIcon);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'screen-source-name';
    nameSpan.textContent = source.name || 'Screen Source';
    nameSpan.title = source.name || 'Screen Source';
    footer.appendChild(nameSpan);

    card.appendChild(previewWrap);
    card.appendChild(footer);

    // Click to select
    card.addEventListener('click', () => {
      selectScreenPickerSource(source.id);
    });

    // Double-click to share immediately
    card.addEventListener('dblclick', () => {
      selectScreenPickerSource(source.id);
      submitScreenPicker();
    });

    screenPickerGrid.appendChild(card);
  });
}

function selectScreenPickerSource(sourceId) {
  selectedScreenPickerSourceId = sourceId;
  const cards = screenPickerGrid ? screenPickerGrid.querySelectorAll('.screen-source-card') : [];
  cards.forEach((c) => {
    c.classList.toggle('selected', c.dataset.sourceId === sourceId);
  });
  if (btnScreenPickerSubmit) {
    btnScreenPickerSubmit.disabled = !selectedScreenPickerSourceId;
  }
}

function submitScreenPicker() {
  if (!currentScreenPickerRequestId || !selectedScreenPickerSourceId) return;

  const withAudio = screenPickerAudioToggle ? screenPickerAudioToggle.checked : true;
  eAPI.send('screen-picker-select', {
    requestId: currentScreenPickerRequestId,
    sourceId: selectedScreenPickerSourceId,
    withAudio
  });

  const selectedSource = currentScreenPickerSources.find((s) => s.id === selectedScreenPickerSourceId);
  showToast(`Streaming ${selectedSource ? selectedSource.name : 'Screen'}`);

  closeScreenPicker(false);
}

// Tab click listeners
if (tabPickerScreens) {
  tabPickerScreens.addEventListener('click', () => {
    if (currentScreenPickerTab !== 'screens') {
      currentScreenPickerTab = 'screens';
      updateScreenPickerTabs();
      renderScreenPickerSources();
    }
  });
}

if (tabPickerWindows) {
  tabPickerWindows.addEventListener('click', () => {
    if (currentScreenPickerTab !== 'windows') {
      currentScreenPickerTab = 'windows';
      updateScreenPickerTabs();
      renderScreenPickerSources();
    }
  });
}

// Action button listeners
if (btnScreenPickerCancel) {
  btnScreenPickerCancel.addEventListener('click', () => {
    closeScreenPicker(true);
  });
}

if (btnScreenPickerCloseX) {
  btnScreenPickerCloseX.addEventListener('click', () => {
    closeScreenPicker(true);
  });
}

if (btnScreenPickerSubmit) {
  btnScreenPickerSubmit.addEventListener('click', () => {
    submitScreenPicker();
  });
}

// Click outside modal container to cancel
if (screenPickerModal) {
  screenPickerModal.addEventListener('click', (e) => {
    if (e.target === screenPickerModal) {
      closeScreenPicker(true);
    }
  });
}

// IPC listener to open screen picker from main process
eAPI.on('open-screen-picker', (data) => {
  openScreenPicker(data);
});

// IPC listener to cancel screen picker from main process if session ends
eAPI.on('cancel-screen-picker', () => {
  closeScreenPicker(false);
});

// Initial boot
initAccounts();
updateReloadButtonVisibility();
