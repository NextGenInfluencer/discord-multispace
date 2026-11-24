/**
 * Discord MultiSpace — Preload Script (Context Bridge)
 *
 * Exposes a minimal, validated API surface from the main process to the
 * shell renderer via contextBridge. The renderer can ONLY call the methods
 * listed here — it has no access to require(), ipcRenderer, shell, or
 * any other Node.js / Electron API directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of IPC channels the renderer is allowed to send on (one-way)
const ALLOWED_SEND_CHANNELS = [
  'update-tray-status',
  'update-taskbar-overlay',
  'update-title',
  'app-reload-window',
  'clear-account-cache',
  'set-startup-setting',
  'screen-picker-select',
  'screen-picker-cancel',
  'check-for-updates',
  'install-update-now',
  'set-stream-audio-device',
  'views:reload-account',
  'views:set-zoom',
  'views:retry-account',
  'hud:show-tooltip',
  'hud:show-toast',
  'hud:show-zoom'
];

// Whitelist of IPC channels the renderer is allowed to invoke (request/response)
const ALLOWED_INVOKE_CHANNELS = [
  'get-startup-setting',
  'set-global-shortcuts-enabled',
  'fetch-theme-css',
  'get-app-version',
  'get-stream-audio-device',
  'views:sync-accounts',
  'views:validate-proxy',
  'views:update-account-proxy',
  'views:remove-account',
  'views:set-layout',
  'views:set-overlay-blocked',
  'views:apply-theme',
  'views:set-mute-all',
  'views:set-deafen-all',
  'views:check-hibernation',
  'updater:download'
];

// Whitelist of IPC channels the renderer is allowed to listen on
const ALLOWED_RECEIVE_CHANNELS = [
  'view:loading-state',
  'view:did-fail-load',
  'view:did-recover-load',
  'view:notification-updated',
  'view:zoom-changed',
  'shortcut:switch-account-index',
  'shortcut:cycle-account',
  'tray-reload-session',
  'trigger-global-mute-all',
  'trigger-global-deafen-all',
  'open-screen-picker',
  'cancel-screen-picker',
  'update-checking',
  'update-available',
  'update-not-available',
  'update-download-progress',
  'update-downloaded',
  'update-error'
];

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Send a one-way message to the main process.
   * Only whitelisted channels are permitted.
   */
  send(channel, ...args) {
    if (ALLOWED_SEND_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },

  /**
   * Send a request to the main process and await a response.
   * Only whitelisted channels are permitted.
   */
  invoke(channel, ...args) {
    if (ALLOWED_INVOKE_CHANNELS.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Channel "${channel}" is not allowed`));
  },

  /**
   * Subscribe to messages from the main process.
   * Strips raw IpcRendererEvent and returns an unsubscribe function.
   */
  on(channel, callback) {
    if (ALLOWED_RECEIVE_CHANNELS.includes(channel) && typeof callback === 'function') {
      const handler = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
    return () => {};
  },

  /**
   * Open a URL in the system's default browser.
   * Only http:// and https:// protocols are permitted — blocks file://,
   * smb://, custom URI schemes, and other potentially dangerous protocols.
   */
  openExternal(url) {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      ipcRenderer.send('open-external-url', url);
    }
  }
});
