import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron';

import { createConnectionStore } from './connection.mjs';
import {
  attentionLabel,
  createPreferencesStore,
  DEFAULT_SHORTCUT,
  restoreBounds,
  savedRoute,
  validateAttention,
  validateShortcut,
} from './preferences.mjs';
import { allowsPermission, assertTrustedSender, isAppPage, linkAction } from './security.mjs';
import { startUiServer } from './server.mjs';

app.setName('Farmslot');
if (process.env.FARMSLOT_DESKTOP_USER_DATA) {
  app.setPath('userData', resolve(process.env.FARMSLOT_DESKTOP_USER_DATA));
}
if (process.env.FARMSLOT_DESKTOP_CDP_PORT) {
  const port = Number(process.env.FARMSLOT_DESKTOP_CDP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid desktop CDP port.');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let window;
let clientSession;
let server;
let store;
let connection = null;
let quitting = false;
let preferencesStore;
let preferences = { shortcut: DEFAULT_SHORTCUT, route: '#fleet' };
let registeredShortcut = '';
let shortcutError = '';
let tray;
let attention = { connected: false, ready: false, decisions: 0 };
let boundsTimer;

function savePreferences(change) {
  const next = { ...preferences, ...change };
  preferencesStore.save(next);
  preferences = next;
}

function saveWindowBounds() {
  clearTimeout(boundsTimer);
  if (window && !window.isDestroyed()) savePreferences({ bounds: window.getNormalBounds() });
}

async function showWindow(route) {
  if (!window || window.isDestroyed()) await createWindow();
  if (window.isMinimized()) window.restore();
  if (route && connection) await window.loadURL(`${server.origin}/cc/${route}`);
  window.show();
  window.focus();
}

function toggleWindow() {
  if (window && window.isVisible() && window.isFocused()) window.hide();
  else showWindow().catch((error) => reportError('Could not open Farmslot', error));
}

function setShortcut(value, persist = true) {
  const next = validateShortcut(value);
  const previous = registeredShortcut;
  if (next === previous) {
    if (persist) savePreferences({ shortcut: next });
    shortcutError = '';
    return;
  }
  if (next && !globalShortcut.register(next, toggleWindow))
    throw new Error('That shortcut is unavailable. Choose another combination.');
  try {
    if (persist) savePreferences({ shortcut: next });
  } catch (error) {
    if (next) globalShortcut.unregister(next);
    throw error;
  }
  if (previous) globalShortcut.unregister(previous);
  registeredShortcut = next;
  shortcutError = '';
}

function updateTray() {
  if (!tray) return;
  const label = attentionLabel(attention);
  tray.setToolTip(`Farmslot: ${label}`);
  tray.setTitle(
    attention.connected && attention.ready && attention.decisions > 0
      ? String(attention.decisions)
      : '',
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      {
        label: 'Show Farmslot',
        click: () => showWindow().catch((error) => reportError('Could not open Farmslot', error)),
      },
      {
        label: 'Pending Decisions',
        enabled: attention.connected && attention.ready,
        click: () =>
          showWindow('#decisions').catch((error) => reportError('Could not open decisions', error)),
      },
      {
        label: 'Connection Settings…',
        click: () =>
          loadPage('/settings').catch((error) => reportError('Could not open settings', error)),
      },
      { type: 'separator' },
      { role: 'quit' },
    ]),
  );
}

function createTray() {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 2; y < 14; y++)
    for (let x = 4; x < 13; x++) {
      if (x < 7 || y < 5 || (y >= 7 && y < 10 && x < 11)) pixels[(y * 16 + x) * 4 + 3] = 255;
    }
  const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
}

function reportError(title, error) {
  dialog.showErrorBox(title, error instanceof Error ? error.message : String(error));
}

async function loadPage(path) {
  if (quitting) return;
  if (!window || window.isDestroyed()) await createWindow();
  await window.loadURL(`${server.origin}${path}`);
  window.show();
  window.focus();
}

async function openLink(url) {
  switch (linkAction(url, server.origin, connection)) {
    case 'internal':
      await window.loadURL(url);
      break;
    case 'download':
      window.webContents.downloadURL(url);
      break;
    case 'external':
      await shell.openExternal(url);
      break;
  }
}

async function createWindow() {
  window = new BrowserWindow({
    title: 'Farmslot',
    ...restoreBounds(
      preferences.bounds,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#11141b',
    show: false,
    webPreferences: {
      session: clientSession,
      preload: join(root, 'src/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url).catch((error) => reportError('Could not open link', error));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppPage(url, server.origin)) return;
    event.preventDefault();
    openLink(url).catch((error) => reportError('Could not open link', error));
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppPage(url, server.origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => {
    try {
      saveWindowBounds();
    } catch (error) {
      reportError('Could not save window position', error);
    }
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  for (const event of ['resize', 'move'])
    window.on(event, () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        try {
          saveWindowBounds();
        } catch (error) {
          reportError('Could not save window position', error);
        }
      }, 300);
    });
  const rememberRoute = (url) => {
    if (!isAppPage(url, server.origin) || new URL(url).pathname !== '/cc/') return;
    try {
      savePreferences({ route: savedRoute(new URL(url).hash) });
    } catch (error) {
      reportError('Could not save last view', error);
    }
  };
  contents.on('did-navigate', (_event, url) => rememberRoute(url));
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) rememberRoute(url);
  });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      attention = { connected: false, ready: false, decisions: 0 };
      updateTray();
    }
  });
  contents.on('render-process-gone', () => {
    attention = { connected: false, ready: false, decisions: 0 };
    updateTray();
  });
  window.on('closed', () => {
    window = null;
  });
  window.once('ready-to-show', () => window?.show());
  await window.loadURL(`${server.origin}${connection ? '/cc/' + preferences.route : '/settings'}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (quitting) return;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } else if (server)
      createWindow().catch((error) => reportError('Could not open Farmslot', error));
  });
  app
    .whenReady()
    .then(async () => {
      // Remove cached credential-bearing URLs from earlier builds before loading the UI.
      await session.defaultSession.clearCache();
      // Keep preferences persistent, but never write credential-bearing resource URLs to HTTP cache.
      clientSession = session.fromPartition('persist:command-center', { cache: false });
      await clientSession.clearCache();
      server = await startUiServer(
        join(root, 'ui-dist'),
        join(root, 'settings'),
        app.getPath('userData'),
      );
      preferencesStore = createPreferencesStore(app.getPath('userData'));
      try {
        preferences = preferencesStore.load();
      } catch (error) {
        reportError('Could not read desktop preferences', error);
      }
      try {
        setShortcut(preferences.shortcut, false);
      } catch (error) {
        shortcutError = error instanceof Error ? error.message : String(error);
      }
      createTray();
      store = createConnectionStore(app.getPath('userData'), safeStorage);
      try {
        connection = await store.load();
      } catch (error) {
        // A damaged or inaccessible credential record is recoverable through Connection Settings.
        reportError('Could not read saved connection', error);
      }
      ipcMain.handle('desktop:load-connection', (event) => {
        assertTrustedSender(event, window, server.origin);
        return connection;
      });
      ipcMain.handle('desktop:save-connection', async (event, value) => {
        assertTrustedSender(event, window, server.origin);
        connection = await store.save(value);
      });
      ipcMain.handle('desktop:load-preferences', (event) => {
        assertTrustedSender(event, window, server.origin);
        return { shortcut: preferences.shortcut, shortcutError, route: preferences.route };
      });
      ipcMain.handle('desktop:save-shortcut', (event, value) => {
        assertTrustedSender(event, window, server.origin);
        setShortcut(value);
      });
      ipcMain.handle('desktop:update-attention', (event, value) => {
        assertTrustedSender(event, window, server.origin);
        if (new URL(event.senderFrame.url).pathname !== '/cc/')
          throw new Error('Status must come from Command Center.');
        attention = validateAttention(value);
        updateTray();
      });
      clientSession.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(allowsPermission(window, contents, permission, details, server.origin)),
      );
      clientSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
        allowsPermission(window, contents, permission, details, server.origin),
      );
      clientSession.on('will-download', (event, item, contents) => {
        const action = linkAction(item.getURL(), server.origin, connection);
        if (!window || contents !== window.webContents || action !== 'download') {
          event.preventDefault();
          return;
        }
        item.once('done', (_event, state) => {
          if (state === 'interrupted')
            reportError('Download failed', new Error('The download was interrupted. Try again.'));
        });
        // Electron's native Save dialog lets the user choose the destination.
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Farmslot',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Connection Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  loadPage('/settings').catch((error) =>
                    reportError('Could not open settings', error),
                  );
                },
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu' },
        ]),
      );
      powerMonitor.on('resume', () => {
        if (window && isAppPage(window.webContents.getURL(), server.origin)) {
          window.webContents.send('desktop:resume');
        }
      });
      await createWindow();
      app.on('activate', () => {
        if (quitting) return;
        if (!window) createWindow().catch((error) => reportError('Could not open Farmslot', error));
        else window.show();
      });
    })
    .catch((error) => {
      reportError('Could not start Farmslot', error);
      app.exit(1);
    });
}

// macOS keeps the app running after the window closes. Cmd+Q stops only this client.
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (!server || quitting) return;
  event.preventDefault();
  quitting = true;
  try {
    saveWindowBounds();
  } catch (error) {
    reportError('Could not save window position', error);
  }
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  server
    .close()
    .then(() => app.quit())
    .catch((error) => {
      reportError('Could not stop the desktop asset server', error);
      app.exit(1);
    });
});
