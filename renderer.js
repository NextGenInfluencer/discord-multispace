/**
 * Discord MultiSpace — Shell Renderer Process (v2.0.0 WebContentsView Architecture)
 *
 * Manages multi-account UI state, sidebar badges, split-view layout geometry,
 * zero-occlusion overlay/snapshot coordination with main-process WebContentsViews,
 * bundled & custom HTTPS themes, screen-share source picker, and explicit updates.
 */

const eAPI = window.electronAPI;

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
const STORAGE_SHOW_RELOAD_BTN_KEY = 'multispace_show_reload_btn';
const STORAGE_ZOOM_KEY = 'discord_multispace_zoom';
const STORAGE_THEME_CSS_KEY = 'discord_multispace_theme_css';
const STORAGE_THEME_ID_KEY = 'discord_multispace_theme_id';
const STORAGE_STREAM_AUDIO_DEVICE = 'discord_multispace_stream_audio_device';

// Core State
let accounts = [];
let activeAccountId = null;
let contextTargetAccountId = null;
let editingAccountId = null;
let pendingRemoveAccountId = null;
let modalMode = 'create'; // 'create' | 'edit'
let selectedColor = PRESET_COLORS[0];
let currentAvatarDataUrl = null;

// Notifications, Loading & Error State
const accountNotifications = {};
const loadingAccounts = new Set();
const erroredAccounts = new Set();

// Split View, Audio & Performance State
let isSplitView = false;
let splitPrimaryId = null;
let splitSecondaryId = null;
let isMutedAll = false;
let isDeafenedAll = false;
let memorySaverEnabled = true;
let globalShortcutsEnabled = false;
const accountLastActive = {};
const accountHibernating = {};

// Overlay Blocking State (for native WebContentsView z-order coordination)
let lastOverlayBlocked = false;

// Reload Button Visibility
let showReloadBtn = localStorage.getItem(STORAGE_SHOW_RELOAD_BTN_KEY) !== 'false';

// Per-account Zoom Persistence
let accountZooms = {};
try {
  accountZooms = JSON.parse(localStorage.getItem(STORAGE_ZOOM_KEY) || '{}');
} catch {
  accountZooms = {};
}

// Themes State
const THEME_PRESETS = {
  default: { name: 'Default Discord', id: 'default', css: '' },
  midnight: { name: 'Midnight Dark', id: 'midnight', css: '/* Bundled locally: Midnight Dark by refact0r */' },
  amoled: { name: 'Pitch Black AMOLED', id: 'amoled', css: '/* Bundled locally: Pitch Black AMOLED by dimden */' },
  minimalist: { name: 'Clean Minimalist', id: 'minimalist', css: '/* Bundled locally: Clean Minimalist */' }
};

let currentThemeCss = localStorage.getItem(STORAGE_THEME_CSS_KEY) || '';
let currentThemeId = localStorage.getItem(STORAGE_THEME_ID_KEY) || 'default';

// ==========================================================================
// DOM Element References
// ==========================================================================
const accountStack = document.getElementById('account-stack');
const webviewContainer = document.getElementById('webview-container');
const loadingStrip = document.getElementById('webview-loading-strip');
const loadingBar = document.getElementById('webview-loading-bar');
const paneSnapshotPrimary = document.getElementById('pane-snapshot-primary');
const paneSnapshotSecondary = document.getElementById('pane-snapshot-secondary');
const paneSplitDivider = document.getElementById('pane-split-divider');

const btnAddAccount = document.getElementById('btn-add-account');
const btnReloadActive = document.getElementById('btn-reload-active');
const btnSplitView = document.getElementById('btn-split-view');
const btnMuteAll = document.getElementById('btn-mute-all');
const btnDeafenAll = document.getElementById('btn-deafen-all');
const btnOpenSettings = document.getElementById('btn-open-settings');

const splitHeader = document.getElementById('split-header');
const splitSelectPrimary = document.getElementById('split-select-primary');
const splitSelectSecondary = document.getElementById('split-select-secondary');
const btnCloseSplit = document.getElementById('btn-close-split');

// Add/Edit Account Modal
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const inputAccountName = document.getElementById('input-account-name');
const colorPalette = document.getElementById('color-palette');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSubmit = document.getElementById('btn-modal-submit');
const inputAccountProxy = document.getElementById('input-account-proxy');
const modalProxyError = document.getElementById('modal-proxy-error');

const modalAvatarPreview = document.getElementById('modal-avatar-preview');
const avatarPreviewBox = document.getElementById('avatar-preview-box');
const inputAccountAvatar = document.getElementById('input-account-avatar');
const btnUploadAvatar = document.getElementById('btn-upload-avatar');
const btnRemoveAvatar = document.getElementById('btn-remove-avatar');

// Remove Account Confirmation Modal
const removeAccountModalOverlay = document.getElementById('remove-account-modal-overlay');
const removeAccountNameLabel = document.getElementById('remove-account-name-label');
const checkboxWipeAccountData = document.getElementById('checkbox-wipe-account-data');
const btnRemoveAccountCancel = document.getElementById('btn-remove-account-cancel');
const btnRemoveAccountConfirm = document.getElementById('btn-remove-account-confirm');

// Settings Modal
const settingsModalOverlay = document.getElementById('settings-modal-overlay');
const toggleMemorySaver = document.getElementById('toggle-memory-saver');
const toggleStartup = document.getElementById('toggle-startup');
const toggleGlobalShortcuts = document.getElementById('toggle-global-shortcuts');
const toggleShowReloadBtn = document.getElementById('toggle-show-reload-btn');
const btnSettingsClose = document.getElementById('btn-settings-close');
const btnSettingsForceReload = document.getElementById('btn-settings-force-reload');

// Context Menus
const contextMenu = document.getElementById('context-menu');
const ctxAccountTitle = document.getElementById('ctx-account-title');
const ctxActionEdit = document.getElementById('ctx-action-edit');
const ctxActionReload = document.getElementById('ctx-action-reload');
const ctxActionClearCache = document.getElementById('ctx-action-clear-cache');
const ctxActionDelete = document.getElementById('ctx-action-delete');

const reloadContextMenu = document.getElementById('reload-context-menu');
const ctxReloadTab = document.getElementById('ctx-reload-tab');
const ctxReloadTabHard = document.getElementById('ctx-reload-tab-hard');
const ctxReloadApp = document.getElementById('ctx-reload-app');

// Screen Picker Modal
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
const screenPickerAudioDeviceSelect = document.getElementById('screen-picker-audio-device-select');
const selectStreamAudioSource = document.getElementById('select-stream-audio-source');

// ==========================================================================
// Unified Toast Notification & Zoom Pill (HTML + Native HUD Support)
// ==========================================================================
function showToast(message, optionsOrIsError = false) {
  let isError = false;
  let duration = 2800;
  if (typeof optionsOrIsError === 'boolean') {
    isError = optionsOrIsError;
  } else if (typeof optionsOrIsError === 'number') {
    duration = optionsOrIsError;
  } else if (optionsOrIsError && typeof optionsOrIsError === 'object') {
    isError = Boolean(optionsOrIsError.isError);
    if (typeof optionsOrIsError.duration === 'number') {
      duration = optionsOrIsError.duration;
    }
  }

  // Render in HTML overlay container when modals/menus block HUD; otherwise render in native HUD pill so toasts never double-overlap
  if (isAnyOverlayOpen()) {
    const container = document.getElementById('toast-container');
    if (container) {
      const toast = document.createElement('div');
      toast.className = 'app-toast';

      const icon = document.createElement('span');
      icon.className = 'toast-icon';
      if (isError) {
        icon.style.color = 'var(--accent-red)';
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      } else {
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      }

      const text = document.createElement('span');
      text.className = 'toast-message';
      text.textContent = message;

      toast.appendChild(icon);
      toast.appendChild(text);
      container.appendChild(toast);

      requestAnimationFrame(() => toast.classList.add('visible'));
      setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 250);
      }, duration);
    }
  } else {
    eAPI.send('hud:show-toast', { message, isError, duration });
  }
}

let zoomToastTimer = null;
function showZoomIndicator(factor) {
  const text = `Zoom: ${Math.round(factor * 100)}%`;
  if (isAnyOverlayOpen()) {
    const zoomIndicator = document.getElementById('zoom-indicator');
    if (zoomIndicator) {
      zoomIndicator.textContent = text;
      zoomIndicator.classList.add('visible');
      clearTimeout(zoomToastTimer);
      zoomToastTimer = setTimeout(() => {
        zoomIndicator.classList.remove('visible');
      }, 1400);
    }
  } else {
    eAPI.send('hud:show-zoom', { text });
  }
}

function attachSidebarHudTooltip(el, getTextFn, getShortcutFn) {
  if (!el) return;
  el.addEventListener('mouseenter', () => {
    if (isAnyOverlayOpen()) return;
    const rect = el.getBoundingClientRect();
    const y = Math.round(rect.top + rect.height / 2 - 20);
    eAPI.send('hud:show-tooltip', {
      visible: true,
      text: getTextFn(),
      shortcut: getShortcutFn ? getShortcutFn() : '',
      y
    });
  });
  const hide = () => eAPI.send('hud:show-tooltip', { visible: false });
  el.addEventListener('mouseleave', hide);
  el.addEventListener('mousedown', hide);
}

// ==========================================================================
// Layout, Geometry & Overlay Blocking Coordination
// ==========================================================================
function getContainerRect() {
  if (!webviewContainer) return { x: 72, y: 0, width: 0, height: 0 };
  const r = webviewContainer.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
}

function isAnyOverlayOpen() {
  return Boolean(
    (modalOverlay && modalOverlay.classList.contains('active')) ||
    (removeAccountModalOverlay && removeAccountModalOverlay.classList.contains('active')) ||
    (settingsModalOverlay && settingsModalOverlay.classList.contains('active')) ||
    (screenPickerModal && screenPickerModal.classList.contains('active')) ||
    (contextMenu && contextMenu.classList.contains('visible')) ||
    (reloadContextMenu && reloadContextMenu.classList.contains('visible'))
  );
}

function clearSnapshots() {
  if (paneSnapshotPrimary) {
    paneSnapshotPrimary.src = '';
    paneSnapshotPrimary.classList.add('hidden');
    paneSnapshotPrimary.style.cssText = '';
  }
  if (paneSnapshotSecondary) {
    paneSnapshotSecondary.src = '';
    paneSnapshotSecondary.classList.add('hidden');
    paneSnapshotSecondary.style.cssText = '';
  }
}

function renderSnapshots(snapshots) {
  clearSnapshots();
  if (!snapshots || typeof snapshots !== 'object') return;

  if (isSplitView && splitPrimaryId && splitSecondaryId) {
    if (snapshots[splitPrimaryId] && paneSnapshotPrimary) {
      paneSnapshotPrimary.src = snapshots[splitPrimaryId];
      paneSnapshotPrimary.style.left = '0';
      paneSnapshotPrimary.style.width = 'calc(50% - 1px)';
      paneSnapshotPrimary.classList.remove('hidden');
    }
    if (snapshots[splitSecondaryId] && paneSnapshotSecondary) {
      paneSnapshotSecondary.src = snapshots[splitSecondaryId];
      paneSnapshotSecondary.style.left = 'calc(50% + 1px)';
      paneSnapshotSecondary.style.width = 'calc(50% - 1px)';
      paneSnapshotSecondary.classList.remove('hidden');
    }
  } else if (activeAccountId && snapshots[activeAccountId] && paneSnapshotPrimary) {
    paneSnapshotPrimary.src = snapshots[activeAccountId];
    paneSnapshotPrimary.style.left = '0';
    paneSnapshotPrimary.style.width = '100%';
    paneSnapshotPrimary.classList.remove('hidden');
  }
}

let overlaySyncSeq = 0;
let overlayInFlightCount = 0;

async function syncOverlayBlockState() {
  const blocked = isAnyOverlayOpen();
  if (blocked === lastOverlayBlocked && overlayInFlightCount === 0) return;

  const wasAlreadyBlocked = lastOverlayBlocked;
  lastOverlayBlocked = blocked;
  const seq = ++overlaySyncSeq;
  overlayInFlightCount += 1;

  try {
    if (blocked) {
      eAPI.send('hud:show-tooltip', { visible: false });
      const res = await eAPI.invoke('views:set-overlay-blocked', {
        blocked: true,
        capture: !wasAlreadyBlocked,
        seq
      });
      if (seq === overlaySyncSeq && isAnyOverlayOpen() && res && !res.stale && res.snapshots) {
        renderSnapshots(res.snapshots);
      }
    } else {
      clearSnapshots();
      await eAPI.invoke('views:set-overlay-blocked', { blocked: false, seq });
    }
  } catch {} finally {
    overlayInFlightCount = Math.max(0, overlayInFlightCount - 1);
  }
}

function updateSplitDividerVisibility() {
  if (paneSplitDivider) {
    paneSplitDivider.classList.toggle('hidden', !isSplitView);
    if (isSplitView) {
      const rect = getContainerRect();
      paneSplitDivider.style.left = `${Math.max(0, Math.floor((rect.width - 2) / 2))}px`;
    }
  }
}

function pushLayoutToMain(focusActive = false) {
  updateSplitDividerVisibility();
  updateErrorOverlayPositions();
  eAPI.invoke('views:set-layout', {
    activeAccountId,
    isSplitView,
    splitPrimaryId,
    splitSecondaryId,
    containerRect: getContainerRect(),
    focusActive
  }).catch(() => {});
}

if (webviewContainer && typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => {
    pushLayoutToMain(false);
  });
  ro.observe(webviewContainer);
}
window.addEventListener('resize', () => pushLayoutToMain(false));
window.addEventListener('blur', () => eAPI.send('hud:show-tooltip', { visible: false }));

function serializeAccountsWithZoom() {
  return accounts.map((acc) => ({
    id: acc.id,
    name: acc.name,
    proxy: acc.proxy || '',
    zoom: getAccountZoom(acc.id)
  }));
}

async function syncAccountsWithMain() {
  const res = await eAPI.invoke('views:sync-accounts', {
    accounts: serializeAccountsWithZoom(),
    activeAccountId,
    isSplitView,
    splitPrimaryId,
    splitSecondaryId,
    containerRect: getContainerRect(),
    overlayBlocked: isAnyOverlayOpen()
  });

  if (res && res.ok) {
    if (res.audioState && typeof res.audioState === 'object') {
      isMutedAll = Boolean(res.audioState.isMutedAll);
      isDeafenedAll = Boolean(res.audioState.isDeafenedAll);
      if (btnMuteAll) btnMuteAll.classList.toggle('active-muted', isMutedAll);
      if (btnDeafenAll) btnDeafenAll.classList.toggle('active-deafened', isDeafenedAll);
    }

    if (res.viewStates && typeof res.viewStates === 'object') {
      for (const [id, st] of Object.entries(res.viewStates)) {
        if (!st || typeof st !== 'object') continue;
        if (st.isLoading) loadingAccounts.add(id);
        else loadingAccounts.delete(id);

        if (st.isHibernated) accountHibernating[id] = true;
        else delete accountHibernating[id];

        if (st.badge !== undefined) {
          updateNotificationBadge(id, st.badge);
        }

        if (st.hasError) {
          erroredAccounts.add(id);
          showWebviewError(id, st.errorDescription, st.errorCode);
        } else if (erroredAccounts.has(id)) {
          erroredAccounts.delete(id);
          clearWebviewError(id);
        }
      }
      refreshLoadingBar();
    }
  }

  return res;
}

// ==========================================================================
// Zoom Controls
// ==========================================================================
function getAccountZoom(accountId) {
  if (!accountId) return 1.0;
  return accountZooms[accountId] !== undefined ? accountZooms[accountId] : 1.0;
}

function setAccountZoom(accountId, factor, notifyMain = true) {
  if (!accountId) return 1.0;
  const clamped = Math.min(2.0, Math.max(0.5, Math.round(factor * 10) / 10));
  accountZooms[accountId] = clamped;
  try {
    localStorage.setItem(STORAGE_ZOOM_KEY, JSON.stringify(accountZooms));
  } catch {}
  if (notifyMain) {
    eAPI.send('views:set-zoom', { accountId, zoomFactor: clamped });
  }
  showZoomIndicator(clamped);
  return clamped;
}

eAPI.on('view:zoom-changed', ({ accountId, zoomFactor }) => {
  if (!accountId || typeof zoomFactor !== 'number') return;
  setAccountZoom(accountId, zoomFactor, false);
});

// ==========================================================================
// Loading Bar & Error Overlays
// ==========================================================================
function refreshLoadingBar() {
  const visibleIds = isSplitView
    ? [splitPrimaryId, splitSecondaryId].filter(Boolean)
    : [activeAccountId].filter(Boolean);
  const anyLoading = visibleIds.some((id) => loadingAccounts.has(id));
  if (loadingBar) loadingBar.classList.toggle('active', anyLoading);
  if (loadingStrip) loadingStrip.classList.toggle('active', anyLoading);
}

eAPI.on('view:loading-state', ({ accountId, isLoading }) => {
  if (!accountId) return;
  if (isLoading) loadingAccounts.add(accountId);
  else loadingAccounts.delete(accountId);
  refreshLoadingBar();
});

eAPI.on('view:did-fail-load', ({ accountId, errorCode, errorDescription }) => {
  if (!accountId) return;
  erroredAccounts.add(accountId);
  showWebviewError(accountId, errorDescription, errorCode);
});

eAPI.on('view:did-recover-load', ({ accountId }) => {
  if (!accountId) return;
  erroredAccounts.delete(accountId);
  clearWebviewError(accountId);
});

function showWebviewError(accountId, errorDescription, errorCode) {
  const account = accounts.find((a) => a.id === accountId);
  const accountName = account ? account.name : 'Account';

  clearWebviewError(accountId);

  const overlay = document.createElement('div');
  overlay.id = `error-overlay-${accountId}`;
  overlay.className = 'webview-error-overlay';
  webviewContainer.appendChild(overlay);

  const card = document.createElement('div');
  card.className = 'error-card';

  const iconWrapper = document.createElement('div');
  iconWrapper.className = 'error-icon-wrapper';
  iconWrapper.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>';
  card.appendChild(iconWrapper);

  const title = document.createElement('h2');
  title.className = 'error-title';
  title.textContent = 'Connection Blocked or Lost';
  card.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'error-desc';
  desc.textContent = 'Unable to connect to Discord for ';
  const strong = document.createElement('strong');
  strong.textContent = accountName;
  desc.appendChild(strong);
  desc.appendChild(document.createTextNode('. Check your network connection or proxy configuration.'));
  card.appendChild(desc);

  const codePill = document.createElement('div');
  codePill.className = 'error-code-pill';
  codePill.textContent = `${errorDescription || 'ERR_CONNECTION_FAILED'} (${errorCode || 'Unknown'})`;
  card.appendChild(codePill);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'error-actions-row';

  const btnRetry = document.createElement('button');
  btnRetry.className = 'btn-primary btn-retry-connection';
  btnRetry.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg><span>Retry Connection</span>';
  btnRetry.addEventListener('click', () => {
    clearWebviewError(accountId);
    erroredAccounts.delete(accountId);
    eAPI.send('views:retry-account', { accountId });
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
  if (overlay) overlay.remove();
}

function updateErrorOverlayPositions() {
  accounts.forEach((acc) => {
    const overlay = document.getElementById(`error-overlay-${acc.id}`);
    if (!overlay) return;

    if (isSplitView) {
      if (acc.id === splitPrimaryId) {
        overlay.style.cssText = 'position:absolute;top:0;bottom:0;left:0;width:calc(50% - 1px);height:100%;display:flex;z-index:25;';
      } else if (acc.id === splitSecondaryId) {
        overlay.style.cssText = 'position:absolute;top:0;bottom:0;left:calc(50% + 1px);width:calc(50% - 1px);height:100%;display:flex;z-index:25;';
      } else {
        overlay.style.display = 'none';
      }
    } else if (acc.id === activeAccountId) {
      overlay.style.cssText = 'position:absolute;top:0;bottom:0;left:0;right:0;width:100%;height:100%;display:flex;z-index:25;';
    } else {
      overlay.style.display = 'none';
    }
  });
}

// ==========================================================================
// Taskbar Overlay & Tray Status
// ==========================================================================
function generateTaskbarBadgeDataUrl(count) {
  if (count <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#f23f43';
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e1f22';
    ctx.stroke();

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
      if (!Number.isNaN(n)) totalUnreads += n;
      else if (val === '•') totalUnreads += 1;
    });

    eAPI.send('update-tray-status', {
      accountCount: accounts.length,
      activeAccountName: activeName,
      unreadCount: totalUnreads
    });

    eAPI.send('update-taskbar-overlay', {
      count: totalUnreads,
      dataUrl: generateTaskbarBadgeDataUrl(totalUnreads)
    });

    eAPI.send('update-title', winTitle);
  } catch {}
}

eAPI.on('view:notification-updated', ({ accountId, badge }) => {
  if (!accountId) return;
  updateNotificationBadge(accountId, badge);
});

function updateNotificationBadge(accountId, rawValue) {
  const notifEl = document.getElementById(`notif-badge-${accountId}`);

  let formatted = null;
  if (rawValue && rawValue !== 0 && rawValue !== '0') {
    if (rawValue === '•' || rawValue === '*') {
      formatted = '•';
    } else {
      const num = parseInt(rawValue, 10);
      if (!Number.isNaN(num) && num > 0) {
        formatted = num > 99 ? '99+' : String(num);
      } else if (typeof rawValue === 'string' && rawValue.trim()) {
        formatted = rawValue.trim();
      }
    }
  }

  const prev = accountNotifications[accountId];
  if (formatted) accountNotifications[accountId] = formatted;
  else delete accountNotifications[accountId];

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

  const item = document.querySelector(`.account-item[data-account-id="${accountId}"]`);
  if (item) {
    const tooltipName = item.querySelector('.tooltip-name');
    const acc = accounts.find((a) => a.id === accountId);
    if (tooltipName && acc) {
      const unreadHint = formatted ? (formatted === '•' ? ' (Unread)' : ` (${formatted} unread)`) : '';
      tooltipName.textContent = `${acc.name}${unreadHint}`;
    }
  }

  if (prev !== formatted) {
    sendTrayStatus();
  }
}

// ==========================================================================
// Theme Engine (Bundled Offline Presets + SSRF-Hardened Custom HTTPS Themes)
// ==========================================================================
async function applyTheme(presetId, customCss, silent = false) {
  const nextId = presetId || 'custom';
  let nextCss = '';

  if (nextId && THEME_PRESETS[nextId]) {
    nextCss = THEME_PRESETS[nextId].css;
  } else {
    let raw = (customCss !== undefined ? customCss : '').trim();
    if (raw && (raw.startsWith('https://') || raw.startsWith('http://')) && !raw.includes('{') && !raw.startsWith('@import')) {
      raw = `@import url("${raw}");`;
    }
    nextCss = raw;
  }

  const res = await eAPI.invoke('views:apply-theme', {
    presetId: nextId,
    customCss: nextCss
  });

  if (!res || !res.ok) {
    if (!silent) {
      showToast((res && res.error) || 'Failed to apply theme.', true);
    }
    return false;
  }

  currentThemeId = nextId;
  currentThemeCss = nextCss;
  try {
    localStorage.setItem(STORAGE_THEME_ID_KEY, currentThemeId);
    localStorage.setItem(STORAGE_THEME_CSS_KEY, currentThemeCss);
  } catch {}

  updateThemeUI();

  if (!silent) {
    const preset = THEME_PRESETS[currentThemeId];
    if (currentThemeId === 'default' || (!preset && !currentThemeCss)) {
      showToast('Theme reset to Default Discord');
    } else if (preset) {
      showToast(`Applied ${preset.name} to all accounts`);
    } else {
      showToast('Custom theme applied to all accounts');
    }
  }
  return true;
}

function updateThemeUI() {
  const statusEl = document.getElementById('theme-active-status');
  const inputCss = document.getElementById('input-theme-css');
  const presetCards = document.querySelectorAll('.theme-preset-card');

  if (statusEl) {
    const preset = THEME_PRESETS[currentThemeId];
    statusEl.textContent = preset ? preset.name : 'Custom CSS';
  }

  if (inputCss && document.activeElement !== inputCss) {
    inputCss.value = THEME_PRESETS[currentThemeId] ? '' : currentThemeCss;
  }

  presetCards.forEach((card) => {
    card.classList.toggle('active', card.dataset.preset === currentThemeId);
  });
}

// ==========================================================================
// Account Persistence, Sidebar Rendering & Switching
// ==========================================================================
function saveAccounts() {
  localStorage.setItem(STORAGE_ACCOUNTS_KEY, JSON.stringify(accounts));
}

function saveActiveAccountId(id) {
  activeAccountId = id;
  localStorage.setItem(STORAGE_ACTIVE_ID_KEY, id);
}

function getInitials(name) {
  if (!name) return 'A';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  if (name.length <= 3) return name.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function renderAccountStack() {
  eAPI.send('hud:show-tooltip', { visible: false });
  accountStack.innerHTML = '';

  accounts.forEach((acc, index) => {
    const item = document.createElement('div');
    item.className = `account-item ${acc.id === activeAccountId ? 'active' : ''}`;
    item.dataset.accountId = acc.id;

    const pill = document.createElement('div');
    pill.className = 'indicator-pill';

    const badgeWrapper = document.createElement('div');
    badgeWrapper.className = 'account-badge-wrapper';

    const badge = document.createElement('button');
    badge.className = 'account-badge';
    badge.setAttribute('aria-label', acc.name);
    if (acc.avatar) {
      badge.style.backgroundColor = 'transparent';
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

    const notifBadge = document.createElement('div');
    notifBadge.id = `notif-badge-${acc.id}`;
    const savedNotif = accountNotifications[acc.id];
    if (savedNotif === '•') {
      notifBadge.className = 'notification-badge unread-dot';
    } else if (savedNotif) {
      notifBadge.className = 'notification-badge';
      notifBadge.textContent = savedNotif;
    } else {
      notifBadge.className = 'notification-badge hidden';
    }
    badgeWrapper.appendChild(notifBadge);

    const tooltip = document.createElement('div');
    tooltip.className = 'badge-tooltip';
    const unreadTooltipText = savedNotif ? (savedNotif === '•' ? ' (Unread)' : ` (${savedNotif} unread)`) : '';
    const tooltipNameSpan = document.createElement('span');
    tooltipNameSpan.className = 'tooltip-name';
    tooltipNameSpan.textContent = `${acc.name}${unreadTooltipText}`;
    const tooltipShortcutSpan = document.createElement('span');
    tooltipShortcutSpan.className = 'tooltip-shortcut';
    tooltipShortcutSpan.textContent = index < 9 ? `Ctrl+${index + 1}` : '';
    tooltip.appendChild(tooltipNameSpan);
    if (index < 9) tooltip.appendChild(tooltipShortcutSpan);

    const nameLabel = document.createElement('span');
    nameLabel.className = 'account-name-tag';
    nameLabel.textContent = acc.name;
    nameLabel.title = acc.name;

    item.appendChild(pill);
    item.appendChild(badgeWrapper);
    item.appendChild(nameLabel);
    item.appendChild(tooltip);

    item.addEventListener('click', () => switchAccount(acc.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, acc.id);
    });

    attachSidebarHudTooltip(
      item,
      () => {
        const cur = accountNotifications[acc.id];
        const hint = cur ? (cur === '•' ? ' (Unread)' : ` (${cur} unread)`) : '';
        return `${acc.name}${hint}`;
      },
      () => (index < 9 ? `Ctrl+${index + 1}` : '')
    );

    accountStack.appendChild(item);
  });
}

function switchAccount(accountId) {
  if (!accounts.some((a) => a.id === accountId)) return;
  saveActiveAccountId(accountId);
  accountLastActive[accountId] = Date.now();
  delete accountHibernating[accountId];

  const items = accountStack.querySelectorAll('.account-item');
  items.forEach((item) => {
    item.classList.toggle('active', item.dataset.accountId === accountId);
  });

  if (isSplitView) {
    if (splitSecondaryId === accountId) {
      splitSecondaryId = splitPrimaryId;
    }
    splitPrimaryId = accountId;
    renderSplitView();
  } else {
    pushLayoutToMain(true);
  }

  refreshLoadingBar();
  sendTrayStatus();
}

// Keyboard shortcuts forwarded from main process (works even when Discord has focus!)
eAPI.on('shortcut:switch-account-index', (targetIdx) => {
  if (typeof targetIdx === 'number' && accounts[targetIdx]) {
    switchAccount(accounts[targetIdx].id);
  }
});

eAPI.on('shortcut:cycle-account', ({ reverse } = {}) => {
  if (accounts.length < 2) return;
  const currentIdx = accounts.findIndex((a) => a.id === activeAccountId);
  if (currentIdx !== -1) {
    const nextIdx = (currentIdx + (reverse ? -1 : 1) + accounts.length) % accounts.length;
    switchAccount(accounts[nextIdx].id);
  }
});

eAPI.on('tray-reload-session', () => {
  reloadActiveAccount(false);
});

// ==========================================================================
// Add / Edit Account Modal & Remove Account Confirmation Modal
// ==========================================================================
function setModalProxyError(errMsg) {
  if (!modalProxyError) return;
  if (errMsg) {
    modalProxyError.textContent = errMsg;
    modalProxyError.classList.remove('hidden');
  } else {
    modalProxyError.textContent = '';
    modalProxyError.classList.add('hidden');
  }
}

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

function handleAvatarFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
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

async function openAddAccountModal() {
  modalMode = 'create';
  modalTitle.textContent = 'Add New Account';
  btnModalSubmit.textContent = 'Create Account';
  setModalProxyError('');

  const nextIndex = accounts.length + 1;
  inputAccountName.value = `Account ${nextIndex}`;
  inputAccountProxy.value = '';
  selectedColor = PRESET_COLORS[(nextIndex - 1) % PRESET_COLORS.length];
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';

  renderColorPalette();
  updateModalAvatarPreview();
  modalOverlay.classList.add('active');
  await syncOverlayBlockState();
  inputAccountName.focus();
  inputAccountName.select();
}

async function openEditAccountModal(accountId) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;

  editingAccountId = accountId;
  modalMode = 'edit';
  modalTitle.textContent = 'Edit Account';
  btnModalSubmit.textContent = 'Save Changes';
  setModalProxyError('');

  inputAccountName.value = account.name;
  inputAccountProxy.value = account.proxy || '';
  selectedColor = account.color || PRESET_COLORS[0];
  currentAvatarDataUrl = account.avatar || null;
  inputAccountAvatar.value = '';

  renderColorPalette();
  updateModalAvatarPreview();
  modalOverlay.classList.add('active');
  await syncOverlayBlockState();
  inputAccountName.focus();
  inputAccountName.select();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  setModalProxyError('');
  inputAccountName.value = '';
  inputAccountProxy.value = '';
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';
  editingAccountId = null;
  syncOverlayBlockState();
}

async function handleModalSubmit() {
  const name = inputAccountName.value.trim();
  if (!name) return;
  const proxy = inputAccountProxy.value.trim();

  if (proxy) {
    const check = await eAPI.invoke('views:validate-proxy', proxy);
    if (!check || !check.valid) {
      setModalProxyError((check && check.error) || 'Invalid proxy server format.');
      return;
    }
  }
  setModalProxyError('');

  btnModalSubmit.disabled = true;
  try {
    if (modalMode === 'create') {
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const newAccount = {
        id: newId,
        name,
        color: selectedColor,
        avatar: currentAvatarDataUrl,
        proxy
      };

      accounts.push(newAccount);
      accountLastActive[newId] = Date.now();
      saveAccounts();
      saveActiveAccountId(newId);
      renderAccountStack();

      if (isSplitView) {
        splitPrimaryId = newId;
        renderSplitView();
      }

      // Sync accounts awaits proxy setup BEFORE creating or loading the WebContentsView
      await syncAccountsWithMain();
      closeModal();
      sendTrayStatus();
    } else if (modalMode === 'edit') {
      const target = accounts.find((a) => a.id === editingAccountId);
      if (target) {
        const proxyChanged = (target.proxy || '') !== proxy;
        target.name = name;
        target.color = selectedColor;
        target.avatar = currentAvatarDataUrl;
        target.proxy = proxy;
        saveAccounts();
        renderAccountStack();
        sendTrayStatus();

        if (proxyChanged) {
          const proxyRes = await eAPI.invoke('views:update-account-proxy', {
            accountId: target.id,
            proxy
          });
          if (!proxyRes || !proxyRes.ok) {
            setModalProxyError((proxyRes && proxyRes.error) || 'Failed to apply proxy.');
            return;
          }
          showToast(proxy ? `Proxy updated for ${target.name}` : `Direct connection restored for ${target.name}`);
        }
        if (isSplitView) renderSplitView();
      }
      closeModal();
    }
  } finally {
    btnModalSubmit.disabled = false;
  }
}

async function openRemoveAccountModal(accountId) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account || !removeAccountModalOverlay) return;

  pendingRemoveAccountId = accountId;
  if (removeAccountNameLabel) {
    removeAccountNameLabel.textContent = account.name;
  }
  // Wipe session data is ALWAYS pre-checked by default per user decision
  if (checkboxWipeAccountData) {
    checkboxWipeAccountData.checked = true;
  }
  removeAccountModalOverlay.classList.add('active');
  await syncOverlayBlockState();
}

function closeRemoveAccountModal() {
  if (removeAccountModalOverlay) {
    removeAccountModalOverlay.classList.remove('active');
  }
  pendingRemoveAccountId = null;
  syncOverlayBlockState();
}

async function confirmRemoveAccount() {
  const accountId = pendingRemoveAccountId;
  if (!accountId) return;
  const account = accounts.find((a) => a.id === accountId);
  const accountName = account ? account.name : 'Account';
  const wipeSessionData = checkboxWipeAccountData ? checkboxWipeAccountData.checked : true;

  btnRemoveAccountConfirm.disabled = true;
  try {
    await eAPI.invoke('views:remove-account', { accountId, wipeSessionData });

    clearWebviewError(accountId);
    erroredAccounts.delete(accountId);
    loadingAccounts.delete(accountId);
    delete accountNotifications[accountId];
    delete accountLastActive[accountId];
    delete accountHibernating[accountId];
    delete accountZooms[accountId];
    try {
      localStorage.setItem(STORAGE_ZOOM_KEY, JSON.stringify(accountZooms));
    } catch {}

    accounts = accounts.filter((a) => a.id !== accountId);

    if (accounts.length === 0) {
      const freshId = Date.now().toString(36);
      accounts = [{ id: freshId, name: 'Account 1', color: PRESET_COLORS[0] }];
      accountLastActive[freshId] = Date.now();
    }

    saveAccounts();

    if (activeAccountId === accountId || !accounts.some((a) => a.id === activeAccountId)) {
      saveActiveAccountId(accounts[0].id);
    }

    // Reconcile Split View cleanly if an active split pane was removed
    if (isSplitView) {
      if (accounts.length < 2) {
        isSplitView = false;
        splitPrimaryId = null;
        splitSecondaryId = null;
      } else {
        if (splitPrimaryId === accountId || !accounts.some((a) => a.id === splitPrimaryId)) {
          const replacement = accounts.find((a) => a.id !== splitSecondaryId) || accounts[0];
          splitPrimaryId = replacement.id;
          saveActiveAccountId(splitPrimaryId);
        }
        if (splitSecondaryId === accountId || splitSecondaryId === splitPrimaryId || !accounts.some((a) => a.id === splitSecondaryId)) {
          const replacement = accounts.find((a) => a.id !== splitPrimaryId) || accounts[0];
          splitSecondaryId = replacement.id;
        }
      }
    }

    renderAccountStack();
    renderSplitView();
    await syncAccountsWithMain();
    refreshLoadingBar();
    sendTrayStatus();

    closeRemoveAccountModal();
    showToast(wipeSessionData ? `Removed ${accountName} & wiped session data` : `Removed ${accountName}`);
  } finally {
    btnRemoveAccountConfirm.disabled = false;
  }
}

// ==========================================================================
// Reload & Context Menus
// ==========================================================================
function reloadActiveAccount(ignoreCache = false) {
  triggerReloadAnimation();
  if (!activeAccountId) return;
  eAPI.send('views:reload-account', { accountId: activeAccountId, ignoreCache });
}

function reloadApp() {
  triggerReloadAnimation();
  eAPI.send('app-reload-window');
}

function triggerReloadAnimation() {
  const badge = btnReloadActive ? btnReloadActive.querySelector('.action-badge') : null;
  if (badge) {
    badge.classList.remove('spinning');
    void badge.offsetWidth;
    badge.classList.add('spinning');
    setTimeout(() => badge.classList.remove('spinning'), 650);
  }
}

function updateReloadButtonVisibility() {
  if (btnReloadActive) {
    btnReloadActive.style.display = showReloadBtn ? '' : 'none';
  }
  if (toggleShowReloadBtn) {
    toggleShowReloadBtn.checked = showReloadBtn;
  }
}

function openContextMenu(x, y, accountId) {
  if (reloadContextMenu) reloadContextMenu.classList.remove('visible');
  contextTargetAccountId = accountId;
  const target = accounts.find((a) => a.id === accountId);
  if (target) ctxAccountTitle.textContent = target.name;

  contextMenu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  contextMenu.classList.add('visible');
  syncOverlayBlockState();
}

function closeContextMenu() {
  if (!contextMenu.classList.contains('visible')) return;
  contextMenu.classList.remove('visible');
  contextTargetAccountId = null;
  syncOverlayBlockState();
}

function openReloadContextMenu(x, y) {
  if (contextMenu.classList.contains('visible')) {
    contextMenu.classList.remove('visible');
    contextTargetAccountId = null;
  }
  if (reloadContextMenu) {
    const menuWidth = 230;
    const menuHeight = 170;
    const posX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
    const posY = Math.max(10, Math.min(y - 120, window.innerHeight - menuHeight - 10));
    reloadContextMenu.style.left = `${posX}px`;
    reloadContextMenu.style.top = `${posY}px`;
    reloadContextMenu.classList.add('visible');
    syncOverlayBlockState();
  }
}

function closeReloadContextMenu() {
  if (reloadContextMenu && reloadContextMenu.classList.contains('visible')) {
    reloadContextMenu.classList.remove('visible');
    syncOverlayBlockState();
  }
}

// ==========================================================================
// Dual Split View Management
// ==========================================================================
function toggleSplitView() {
  if (accounts.length < 2) {
    showToast('Split View requires at least 2 accounts. Click "+" to add one.', true);
    return;
  }

  isSplitView = !isSplitView;
  if (isSplitView) {
    splitPrimaryId = activeAccountId;
    const otherAcc = accounts.find((a) => a.id !== splitPrimaryId) || accounts[1];
    splitSecondaryId = otherAcc ? otherAcc.id : null;
  } else {
    splitPrimaryId = null;
    splitSecondaryId = null;
  }

  renderSplitView();
}

function renderSplitView() {
  const splitBadge = btnSplitView ? btnSplitView.querySelector('.action-badge') : null;

  if (isSplitView && splitPrimaryId && splitSecondaryId && accounts.length >= 2) {
    webviewContainer.classList.add('split-mode');
    splitHeader.classList.remove('hidden');
    if (splitBadge) splitBadge.classList.add('active');

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

    accountLastActive[splitPrimaryId] = Date.now();
    accountLastActive[splitSecondaryId] = Date.now();
    delete accountHibernating[splitPrimaryId];
    delete accountHibernating[splitSecondaryId];
  } else {
    isSplitView = false;
    splitPrimaryId = null;
    splitSecondaryId = null;
    webviewContainer.classList.remove('split-mode');
    splitHeader.classList.add('hidden');
    if (splitBadge) splitBadge.classList.remove('active');
  }

  refreshLoadingBar();
  pushLayoutToMain(true);
}

// ==========================================================================
// Global Mute & Deafen Quick Actions
// ==========================================================================
function updateAudioButtonTooltips() {
  if (btnMuteAll) {
    btnMuteAll.title = globalShortcutsEnabled ? 'Mute All (Ctrl+Alt+M)' : 'Mute All Accounts';
  }
  if (btnDeafenAll) {
    btnDeafenAll.title = globalShortcutsEnabled ? 'Deafen All (Ctrl+Alt+D)' : 'Deafen All Accounts';
  }
}

async function toggleMuteAll() {
  isMutedAll = !isMutedAll;
  if (btnMuteAll) btnMuteAll.classList.toggle('active-muted', isMutedAll);
  await eAPI.invoke('views:set-mute-all', { muted: isMutedAll });
  showToast(isMutedAll ? 'All accounts muted' : 'All accounts unmuted');
}

async function toggleDeafenAll() {
  isDeafenedAll = !isDeafenedAll;
  if (btnDeafenAll) btnDeafenAll.classList.toggle('active-deafened', isDeafenedAll);
  await eAPI.invoke('views:set-deafen-all', { deafened: isDeafenedAll });
  showToast(isDeafenedAll ? 'All accounts deafened' : 'All accounts undeafened');
}

if (btnMuteAll) btnMuteAll.addEventListener('click', toggleMuteAll);
if (btnDeafenAll) btnDeafenAll.addEventListener('click', toggleDeafenAll);
eAPI.on('trigger-global-mute-all', toggleMuteAll);
eAPI.on('trigger-global-deafen-all', toggleDeafenAll);

// ==========================================================================
// Background Memory Saver (Real FPS Throttling — Never Mutes Incoming Audio)
// ==========================================================================
async function checkMemorySaverHibernation() {
  if (!memorySaverEnabled) return;

  const now = Date.now();
  const FIFTEEN_MINUTES = 15 * 60 * 1000;
  const idleAccountIds = [];

  for (const acc of accounts) {
    if (acc.id === activeAccountId) continue;
    if (isSplitView && (acc.id === splitPrimaryId || acc.id === splitSecondaryId)) continue;
    if (accountHibernating[acc.id]) continue;

    const lastActive = accountLastActive[acc.id] || now;
    if (now - lastActive > FIFTEEN_MINUTES) {
      idleAccountIds.push(acc.id);
    }
  }

  if (idleAccountIds.length === 0) return;

  try {
    const res = await eAPI.invoke('views:check-hibernation', {
      idleAccountIds,
      memorySaverEnabled: true
    });
    if (res && Array.isArray(res.hibernatedIds)) {
      res.hibernatedIds.forEach((id) => {
        accountHibernating[id] = true;
      });
    }
  } catch {}
}

setInterval(checkMemorySaverHibernation, 30000);

// ==========================================================================
// Screen Share Picker & Custom Audio Device Selection
// ==========================================================================
let currentStreamAudioDevice = localStorage.getItem(STORAGE_STREAM_AUDIO_DEVICE) || 'loopback';
let currentScreenPickerRequestId = null;
let currentScreenPickerSources = [];
let selectedScreenPickerSourceId = null;
let currentScreenPickerTab = 'screens';

async function populateStreamAudioDevices() {
  try {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = allDevices.filter((d) => d.kind === 'audioinput');

    const updateSelect = (selectEl) => {
      if (!selectEl) return;
      selectEl.innerHTML = '';

      const defOpt = document.createElement('option');
      defOpt.value = 'loopback';
      defOpt.textContent = 'Default (Windows System Audio Loopback)';
      selectEl.appendChild(defOpt);

      audioInputs.forEach((dev) => {
        const label = dev.label || (dev.deviceId ? `Audio Device (${dev.deviceId.slice(0, 8)}...)` : '');
        if (!label) return;
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        selectEl.appendChild(opt);
      });

      selectEl.value = currentStreamAudioDevice;
      if (selectEl.value !== currentStreamAudioDevice) {
        let matched = false;
        for (let i = 0; i < selectEl.options.length; i++) {
          const val = selectEl.options[i].value;
          if (val && val !== 'loopback' && val === currentStreamAudioDevice) {
            selectEl.selectedIndex = i;
            matched = true;
            break;
          }
        }
        if (!matched) {
          selectEl.value = 'loopback';
          currentStreamAudioDevice = 'loopback';
        }
      }
    };

    updateSelect(selectStreamAudioSource);
    updateSelect(screenPickerAudioDeviceSelect);
  } catch (err) {
    console.warn('Failed to enumerate audio devices for screen share:', err);
  }
}

function handleStreamAudioDeviceSelection(newVal) {
  currentStreamAudioDevice = newVal || 'loopback';
  localStorage.setItem(STORAGE_STREAM_AUDIO_DEVICE, currentStreamAudioDevice);
  if (selectStreamAudioSource) selectStreamAudioSource.value = currentStreamAudioDevice;
  if (screenPickerAudioDeviceSelect) screenPickerAudioDeviceSelect.value = currentStreamAudioDevice;
  eAPI.send('set-stream-audio-device', currentStreamAudioDevice);
}

if (selectStreamAudioSource) {
  selectStreamAudioSource.addEventListener('change', () => {
    handleStreamAudioDeviceSelection(selectStreamAudioSource.value);
  });
}

if (screenPickerAudioDeviceSelect) {
  screenPickerAudioDeviceSelect.addEventListener('change', () => {
    handleStreamAudioDeviceSelection(screenPickerAudioDeviceSelect.value);
  });
}

async function openScreenPicker({ requestId, sources }) {
  populateStreamAudioDevices();
  currentScreenPickerRequestId = requestId;
  currentScreenPickerSources = Array.isArray(sources) ? sources : [];
  selectedScreenPickerSourceId = null;

  const screens = currentScreenPickerSources.filter((s) => s.id.startsWith('screen:'));
  const windows = currentScreenPickerSources.filter((s) => s.id.startsWith('window:'));

  if (badgeScreensCount) badgeScreensCount.textContent = String(screens.length);
  if (badgeWindowsCount) badgeWindowsCount.textContent = String(windows.length);

  currentScreenPickerTab = screens.length > 0 ? 'screens' : 'windows';
  updateScreenPickerTabs();
  renderScreenPickerSources();

  if (btnScreenPickerSubmit) btnScreenPickerSubmit.disabled = true;
  if (screenPickerModal) {
    screenPickerModal.classList.add('active');
    await syncOverlayBlockState();
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
  syncOverlayBlockState();
}

function updateScreenPickerTabs() {
  if (tabPickerScreens) tabPickerScreens.classList.toggle('active', currentScreenPickerTab === 'screens');
  if (tabPickerWindows) tabPickerWindows.classList.toggle('active', currentScreenPickerTab === 'windows');
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

    const checkBadge = document.createElement('div');
    checkBadge.className = 'screen-source-selected-badge';
    checkBadge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    previewWrap.appendChild(checkBadge);

    const footer = document.createElement('div');
    footer.className = 'screen-source-footer';

    if (source.appIcon) {
      const iconImg = document.createElement('img');
      iconImg.className = 'screen-source-icon';
      iconImg.src = source.appIcon;
      iconImg.alt = '';
      footer.appendChild(iconImg);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'screen-source-name';
    nameSpan.textContent = source.name || 'Screen Source';
    nameSpan.title = source.name || 'Screen Source';
    footer.appendChild(nameSpan);

    card.appendChild(previewWrap);
    card.appendChild(footer);

    card.addEventListener('click', () => selectScreenPickerSource(source.id));
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
  cards.forEach((c) => c.classList.toggle('selected', c.dataset.sourceId === sourceId));
  if (btnScreenPickerSubmit) btnScreenPickerSubmit.disabled = !selectedScreenPickerSourceId;
}

function submitScreenPicker() {
  if (!currentScreenPickerRequestId || !selectedScreenPickerSourceId) return;

  const withAudio = screenPickerAudioToggle ? screenPickerAudioToggle.checked : true;
  const audioSourceDeviceId = screenPickerAudioDeviceSelect ? screenPickerAudioDeviceSelect.value : currentStreamAudioDevice;

  eAPI.send('screen-picker-select', {
    requestId: currentScreenPickerRequestId,
    sourceId: selectedScreenPickerSourceId,
    withAudio,
    audioSourceDeviceId
  });

  const selectedSource = currentScreenPickerSources.find((s) => s.id === selectedScreenPickerSourceId);
  closeScreenPicker(false);
  showToast(`Streaming ${selectedSource ? selectedSource.name : 'Screen'}${withAudio ? '' : ' (Video only)'}`);
}

eAPI.on('open-screen-picker', (data) => openScreenPicker(data));
eAPI.on('cancel-screen-picker', () => closeScreenPicker(false));

// ==========================================================================
// Event Listeners Wiring
// ==========================================================================
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => e.preventDefault(), false);
  document.addEventListener(eventName, (e) => e.preventDefault(), false);
});

window.addEventListener('click', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu();
  if (reloadContextMenu && !reloadContextMenu.contains(e.target)) closeReloadContextMenu();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeContextMenu();
    closeReloadContextMenu();
    if (modalOverlay && modalOverlay.classList.contains('active')) closeModal();
    if (removeAccountModalOverlay && removeAccountModalOverlay.classList.contains('active')) closeRemoveAccountModal();
    if (settingsModalOverlay && settingsModalOverlay.classList.contains('active')) closeSettingsModal();
    if (screenPickerModal && screenPickerModal.classList.contains('active')) closeScreenPicker(true);
    return;
  }

  if (e.key === 'Enter') {
    if (modalOverlay && modalOverlay.classList.contains('active') && document.activeElement !== btnModalCancel) {
      e.preventDefault();
      handleModalSubmit();
      return;
    }
    if (removeAccountModalOverlay && removeAccountModalOverlay.classList.contains('active') && document.activeElement !== btnRemoveAccountCancel) {
      e.preventDefault();
      confirmRemoveAccount();
      return;
    }
    if (screenPickerModal && screenPickerModal.classList.contains('active')) {
      e.preventDefault();
      submitScreenPicker();
      return;
    }
  }

  // Host shell keyboard shortcuts (when sidebar or shell has focus)
  if (!isAnyOverlayOpen()) {
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (ctrlOrMeta && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) {
      e.preventDefault();
      setAccountZoom(activeAccountId, getAccountZoom(activeAccountId) + 0.1);
      return;
    }
    if (ctrlOrMeta && (e.key === '-' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      setAccountZoom(activeAccountId, getAccountZoom(activeAccountId) - 0.1);
      return;
    }
    if (ctrlOrMeta && (e.key === '0' || e.code === 'Numpad0')) {
      e.preventDefault();
      setAccountZoom(activeAccountId, 1.0);
      return;
    }
    if (e.shiftKey && (e.key === 'F5' || (ctrlOrMeta && e.key.toLowerCase() === 'r'))) {
      e.preventDefault();
      reloadApp();
      return;
    }
    if (e.key === 'F5' || (ctrlOrMeta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      reloadActiveAccount(false);
      return;
    }
    if (ctrlOrMeta && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const targetIdx = parseInt(e.key, 10) - 1;
      if (accounts[targetIdx]) {
        e.preventDefault();
        switchAccount(accounts[targetIdx].id);
      }
      return;
    }
    if (ctrlOrMeta && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      if (accounts.length >= 2) {
        const currentIdx = accounts.findIndex((a) => a.id === activeAccountId);
        if (currentIdx !== -1) {
          const nextIdx = (currentIdx + (e.shiftKey ? -1 : 1) + accounts.length) % accounts.length;
          switchAccount(accounts[nextIdx].id);
        }
      }
    }
  }
});

// Sidebar Static Action Tooltips
document.querySelectorAll('[data-hud-tooltip]').forEach((el) => {
  attachSidebarHudTooltip(
    el,
    () => el.getAttribute('data-hud-tooltip') || '',
    () => el.getAttribute('data-hud-shortcut') || ''
  );
});

btnAddAccount.addEventListener('click', openAddAccountModal);
btnReloadActive.addEventListener('click', (e) => {
  if (e.shiftKey) reloadApp();
  else reloadActiveAccount(false);
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

btnModalCancel.addEventListener('click', closeModal);
btnModalSubmit.addEventListener('click', handleModalSubmit);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
inputAccountName.addEventListener('input', updateModalAvatarPreview);
inputAccountProxy.addEventListener('input', () => setModalProxyError(''));

btnUploadAvatar.addEventListener('click', () => inputAccountAvatar.click());
avatarPreviewBox.addEventListener('click', () => inputAccountAvatar.click());
inputAccountAvatar.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) handleAvatarFile(e.target.files[0]);
});
btnRemoveAvatar.addEventListener('click', () => {
  currentAvatarDataUrl = null;
  inputAccountAvatar.value = '';
  updateModalAvatarPreview();
});

if (btnRemoveAccountCancel) btnRemoveAccountCancel.addEventListener('click', closeRemoveAccountModal);
if (btnRemoveAccountConfirm) btnRemoveAccountConfirm.addEventListener('click', confirmRemoveAccount);
if (removeAccountModalOverlay) {
  removeAccountModalOverlay.addEventListener('click', (e) => {
    if (e.target === removeAccountModalOverlay) closeRemoveAccountModal();
  });
}

ctxActionEdit.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  if (targetId) openEditAccountModal(targetId);
});

ctxActionReload.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  if (targetId) eAPI.send('views:reload-account', { accountId: targetId, ignoreCache: false });
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
      accountName
    });
    showToast(`Cache cleared for ${accountName}`);
  });
}

ctxActionDelete.addEventListener('click', () => {
  const targetId = contextTargetAccountId;
  closeContextMenu();
  if (targetId) openRemoveAccountModal(targetId);
});

if (btnSplitView) btnSplitView.addEventListener('click', toggleSplitView);

if (splitSelectPrimary) {
  splitSelectPrimary.addEventListener('change', (e) => {
    const newPrimary = e.target.value;
    if (newPrimary === splitSecondaryId) splitSecondaryId = splitPrimaryId;
    splitPrimaryId = newPrimary;
    saveActiveAccountId(splitPrimaryId);
    renderAccountStack();
    renderSplitView();
    sendTrayStatus();
  });
}

if (splitSelectSecondary) {
  splitSelectSecondary.addEventListener('change', (e) => {
    const newSecondary = e.target.value;
    if (newSecondary === splitPrimaryId) {
      splitPrimaryId = splitSecondaryId;
      saveActiveAccountId(splitPrimaryId);
      renderAccountStack();
      sendTrayStatus();
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

// Settings Modal
async function openSettingsModal() {
  if (toggleMemorySaver) toggleMemorySaver.checked = memorySaverEnabled;
  try {
    const settings = await eAPI.invoke('get-startup-setting');
    if (toggleStartup) toggleStartup.checked = Boolean(settings && settings.openAtLogin);
    globalShortcutsEnabled = Boolean(settings && settings.globalShortcutsEnabled);
    if (toggleGlobalShortcuts) toggleGlobalShortcuts.checked = globalShortcutsEnabled;
    updateAudioButtonTooltips();
  } catch {}
  updateReloadButtonVisibility();
  updateThemeUI();
  populateStreamAudioDevices();
  if (settingsModalOverlay) {
    settingsModalOverlay.classList.add('active');
    await syncOverlayBlockState();
  }
}

function closeSettingsModal() {
  if (settingsModalOverlay) {
    settingsModalOverlay.classList.remove('active');
    syncOverlayBlockState();
  }
}

if (btnOpenSettings) btnOpenSettings.addEventListener('click', openSettingsModal);
if (btnSettingsClose) btnSettingsClose.addEventListener('click', closeSettingsModal);
if (btnSettingsForceReload) {
  btnSettingsForceReload.addEventListener('click', () => {
    closeSettingsModal();
    reloadApp();
  });
}
if (settingsModalOverlay) {
  settingsModalOverlay.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) closeSettingsModal();
  });
}

if (toggleMemorySaver) {
  toggleMemorySaver.addEventListener('change', async (e) => {
    memorySaverEnabled = e.target.checked;
    localStorage.setItem('multispace_memory_saver', String(memorySaverEnabled));
    if (!memorySaverEnabled) {
      Object.keys(accountHibernating).forEach((k) => delete accountHibernating[k]);
      await eAPI.invoke('views:check-hibernation', { idleAccountIds: [], memorySaverEnabled: false });
    }
  });
}

if (toggleStartup) {
  toggleStartup.addEventListener('change', (e) => {
    eAPI.send('set-startup-setting', e.target.checked);
  });
}

if (toggleGlobalShortcuts) {
  toggleGlobalShortcuts.addEventListener('change', async (e) => {
    const wantEnabled = e.target.checked;
    const res = await eAPI.invoke('set-global-shortcuts-enabled', wantEnabled);
    globalShortcutsEnabled = Boolean(res && res.enabled);
    toggleGlobalShortcuts.checked = globalShortcutsEnabled;
    updateAudioButtonTooltips();
    showToast(globalShortcutsEnabled ? 'Global OS shortcuts enabled' : 'Global OS shortcuts disabled');
  });
}

if (toggleShowReloadBtn) {
  toggleShowReloadBtn.addEventListener('change', (e) => {
    showReloadBtn = e.target.checked;
    localStorage.setItem(STORAGE_SHOW_RELOAD_BTN_KEY, String(showReloadBtn));
    updateReloadButtonVisibility();
    showToast(showReloadBtn ? 'Reload button enabled' : 'Reload button hidden');
  });
}

document.querySelectorAll('.theme-source-link').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (btn.dataset.url) eAPI.openExternal(btn.dataset.url);
  });
});

document.querySelectorAll('.theme-preset-card').forEach((card) => {
  card.addEventListener('click', () => applyTheme(card.dataset.preset));
});

const btnApplyTheme = document.getElementById('btn-apply-theme');
const btnClearTheme = document.getElementById('btn-clear-theme');
const inputThemeCss = document.getElementById('input-theme-css');

if (btnApplyTheme && inputThemeCss) {
  btnApplyTheme.addEventListener('click', () => applyTheme('custom', inputThemeCss.value.trim()));
}
if (btnClearTheme) {
  btnClearTheme.addEventListener('click', () => applyTheme('default', ''));
}

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
if (btnScreenPickerCancel) btnScreenPickerCancel.addEventListener('click', () => closeScreenPicker(true));
if (btnScreenPickerCloseX) btnScreenPickerCloseX.addEventListener('click', () => closeScreenPicker(true));
if (btnScreenPickerSubmit) btnScreenPickerSubmit.addEventListener('click', submitScreenPicker);
if (screenPickerModal) {
  screenPickerModal.addEventListener('click', (e) => {
    if (e.target === screenPickerModal) closeScreenPicker(true);
  });
}

// ==========================================================================
// Explicit Download & Install Auto-Updater UI
// ==========================================================================
const updaterVersionTag = document.getElementById('updater-version-tag');
const updaterStatusDot = document.getElementById('updater-status-dot');
const updaterStatusText = document.getElementById('updater-status-text');
const updaterSubtext = document.getElementById('updater-subtext');
const updaterProgressContainer = document.getElementById('updater-progress-container');
const updaterProgressBar = document.getElementById('updater-progress-bar');
const btnCheckUpdates = document.getElementById('btn-check-updates');
const btnCheckUpdatesText = document.getElementById('btn-check-updates-text');
const btnDownloadUpdate = document.getElementById('btn-download-update');
const btnInstallUpdate = document.getElementById('btn-install-update');
const updateBanner = document.getElementById('update-notification-banner');
const updateBannerTitle = document.getElementById('update-banner-title');
const updateBannerDesc = document.getElementById('update-banner-desc');
const btnBannerAction = document.getElementById('btn-banner-action');
const btnBannerDismiss = document.getElementById('btn-banner-dismiss');

eAPI.invoke('get-app-version').then((version) => {
  if (version && updaterVersionTag) updaterVersionTag.textContent = `v${version}`;
}).catch(() => {});

async function startExplicitUpdateDownload() {
  if (btnDownloadUpdate) {
    btnDownloadUpdate.disabled = true;
    btnDownloadUpdate.textContent = 'Downloading...';
  }
  if (btnBannerAction) {
    btnBannerAction.disabled = true;
    btnBannerAction.textContent = 'Downloading...';
  }
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot downloading';
  if (updaterStatusText) updaterStatusText.textContent = 'Downloading update...';
  if (updaterProgressContainer) updaterProgressContainer.style.display = 'block';
  if (updaterProgressBar) updaterProgressBar.style.width = '0%';
  await eAPI.invoke('updater:download');
}

if (btnCheckUpdates) {
  btnCheckUpdates.addEventListener('click', () => {
    btnCheckUpdates.disabled = true;
    if (btnCheckUpdatesText) btnCheckUpdatesText.textContent = 'Checking...';
    eAPI.send('check-for-updates');
  });
}

if (btnDownloadUpdate) {
  btnDownloadUpdate.addEventListener('click', startExplicitUpdateDownload);
}

if (btnInstallUpdate) {
  btnInstallUpdate.addEventListener('click', () => {
    btnInstallUpdate.disabled = true;
    btnInstallUpdate.textContent = 'Restarting...';
    eAPI.send('install-update-now');
  });
}

if (btnBannerDismiss && updateBanner) {
  btnBannerDismiss.addEventListener('click', () => {
    updateBanner.style.display = 'none';
    pushLayoutToMain(false);
  });
}

eAPI.on('update-checking', () => {
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot checking';
  if (updaterStatusText) updaterStatusText.textContent = 'Checking for updates...';
  if (updaterSubtext) updaterSubtext.textContent = 'Querying GitHub releases repository...';
});

eAPI.on('update-available', (info) => {
  const versionStr = info && info.version ? `v${info.version}` : 'New Release';
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot available';
  if (updaterStatusText) updaterStatusText.textContent = `Update available (${versionStr})`;
  if (updaterSubtext) {
    updaterSubtext.textContent = info && info.isDev
      ? 'A newer release is published on GitHub.'
      : 'Click Download Update to fetch the installer.';
  }
  if (updaterProgressContainer) updaterProgressContainer.style.display = 'none';
  if (btnCheckUpdates) {
    btnCheckUpdates.disabled = false;
    if (btnCheckUpdatesText) btnCheckUpdatesText.textContent = 'Check for Updates';
  }
  if (btnDownloadUpdate) {
    btnDownloadUpdate.style.display = 'inline-block';
    btnDownloadUpdate.disabled = false;
    btnDownloadUpdate.textContent = info && info.isDev ? 'View Release' : 'Download Update';
  }

  if (updateBanner && updateBannerTitle && updateBannerDesc && btnBannerAction) {
    updateBannerTitle.textContent = `Update Available: ${versionStr}`;
    if (info && info.isDev) {
      updateBannerDesc.textContent = 'A new release is available on GitHub.';
      btnBannerAction.textContent = 'View Release';
      btnBannerAction.disabled = false;
      btnBannerAction.onclick = () => eAPI.openExternal('https://github.com/NextGenInfluencer/discord-multispace/releases/latest');
    } else {
      updateBannerDesc.textContent = 'Download now to upgrade when ready.';
      btnBannerAction.textContent = 'Download Update';
      btnBannerAction.disabled = false;
      btnBannerAction.onclick = startExplicitUpdateDownload;
    }
    updateBanner.style.display = 'block';
    pushLayoutToMain(false);
  }
});

eAPI.on('update-not-available', (info) => {
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot';
  if (updaterStatusText) updaterStatusText.textContent = 'Up to date';
  if (updaterSubtext) updaterSubtext.textContent = 'You are running the latest version of Discord MultiSpace.';
  if (updaterProgressContainer) updaterProgressContainer.style.display = 'none';
  if (btnDownloadUpdate) btnDownloadUpdate.style.display = 'none';
  if (btnCheckUpdates) {
    btnCheckUpdates.style.display = 'inline-flex';
    btnCheckUpdates.disabled = false;
    if (btnCheckUpdatesText) btnCheckUpdatesText.textContent = 'Check for Updates';
  }
  if (info && info.manual) {
    showToast('Discord MultiSpace is up to date!');
  }
});

eAPI.on('update-download-progress', (progress) => {
  const pct = progress && progress.percent !== undefined ? Math.round(progress.percent) : 0;
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot downloading';
  if (updaterStatusText) updaterStatusText.textContent = `Downloading update (${pct}%)`;
  if (updaterProgressContainer) updaterProgressContainer.style.display = 'block';
  if (updaterProgressBar) updaterProgressBar.style.width = `${pct}%`;
  if (updaterSubtext && progress) {
    const speedMb = progress.bytesPerSecond ? (progress.bytesPerSecond / 1024 / 1024).toFixed(1) : '0.0';
    const transferredMb = progress.transferred ? (progress.transferred / 1024 / 1024).toFixed(1) : '0';
    const totalMb = progress.total ? (progress.total / 1024 / 1024).toFixed(1) : '0';
    updaterSubtext.textContent = `${speedMb} MB/s • ${transferredMb}MB / ${totalMb}MB`;
  }
  if (updateBanner && updateBannerDesc) {
    updateBannerDesc.textContent = `Downloading update (${pct}%)...`;
  }
});

eAPI.on('update-downloaded', (info) => {
  const versionStr = info && info.version ? `v${info.version}` : '';
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot ready';
  if (updaterStatusText) updaterStatusText.textContent = `Update ready to install! ${versionStr}`.trim();
  if (updaterSubtext) updaterSubtext.textContent = 'Click Install & Restart when you are ready to apply the update.';
  if (updaterProgressContainer) updaterProgressContainer.style.display = 'block';
  if (updaterProgressBar) updaterProgressBar.style.width = '100%';

  if (btnCheckUpdates) btnCheckUpdates.style.display = 'none';
  if (btnDownloadUpdate) btnDownloadUpdate.style.display = 'none';
  if (btnInstallUpdate) {
    btnInstallUpdate.style.display = 'inline-block';
    btnInstallUpdate.disabled = false;
    btnInstallUpdate.textContent = 'Install & Restart';
  }

  if (updateBanner && updateBannerTitle && updateBannerDesc && btnBannerAction) {
    updateBannerTitle.textContent = `Update Ready ${versionStr}`.trim();
    updateBannerDesc.textContent = 'Downloaded and verified. Click Install & Restart when ready.';
    btnBannerAction.textContent = 'Install & Restart';
    btnBannerAction.disabled = false;
    btnBannerAction.onclick = () => {
      btnBannerAction.disabled = true;
      btnBannerAction.textContent = 'Restarting...';
      eAPI.send('install-update-now');
    };
    updateBanner.style.display = 'block';
    pushLayoutToMain(false);
  }

  showToast('Update downloaded! Click "Install & Restart" when ready.');
});

eAPI.on('update-error', (err) => {
  if (updaterStatusDot) updaterStatusDot.className = 'updater-dot error';
  if (updaterStatusText) updaterStatusText.textContent = 'Update check failed';
  if (updaterSubtext) updaterSubtext.textContent = (err && err.message) || 'Could not connect to update server.';
  if (btnDownloadUpdate) {
    btnDownloadUpdate.disabled = false;
    btnDownloadUpdate.textContent = 'Download Update';
  }
  if (btnCheckUpdates) {
    btnCheckUpdates.disabled = false;
    if (btnCheckUpdatesText) btnCheckUpdatesText.textContent = 'Check for Updates';
  }
  if (err && err.manual) {
    showToast((err && err.message) || 'Could not reach update server.', true);
  }
});

// ==========================================================================
// Application Boot Sequence (Proxy & Theme Awaited Before Views Load!)
// ==========================================================================
async function bootApplication() {
  try {
    const raw = localStorage.getItem(STORAGE_ACCOUNTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) accounts = parsed;
    }
  } catch {
    accounts = [];
  }

  if (!accounts || accounts.length === 0) {
    accounts = [{ id: '1', name: 'Account 1', color: PRESET_COLORS[0] }];
    saveAccounts();
  }

  const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_ID_KEY);
  if (savedActiveId && accounts.some((acc) => acc.id === savedActiveId)) {
    activeAccountId = savedActiveId;
  } else {
    activeAccountId = accounts[0].id;
    saveActiveAccountId(activeAccountId);
  }

  const savedMemSaver = localStorage.getItem('multispace_memory_saver');
  memorySaverEnabled = savedMemSaver !== null ? savedMemSaver === 'true' : true;
  if (toggleMemorySaver) toggleMemorySaver.checked = memorySaverEnabled;

  accounts.forEach((acc) => {
    accountLastActive[acc.id] = Date.now();
  });

  updateReloadButtonVisibility();
  eAPI.send('set-stream-audio-device', currentStreamAudioDevice);
  populateStreamAudioDevices();

  // Render sidebar stack immediately so UI never blocks on slow/offline remote theme fetches
  renderAccountStack();
  updateThemeUI();

  // Sync main-process startup & global shortcut preferences
  try {
    const settings = await eAPI.invoke('get-startup-setting');
    globalShortcutsEnabled = Boolean(settings && settings.globalShortcutsEnabled);
    if (toggleGlobalShortcuts) toggleGlobalShortcuts.checked = globalShortcutsEnabled;
    updateAudioButtonTooltips();
  } catch {}

  // Pre-load saved theme into main process BEFORE Discord views navigate (fixes boot theme pre-fetch)
  await applyTheme(currentThemeId, currentThemeCss, true);

  await syncAccountsWithMain();
  sendTrayStatus();
}

bootApplication();
