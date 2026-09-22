import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
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
import { deepLinkFromRoute, routeFromDeepLink } from './deep-links.mjs';
import {
  attentionBadge,
  attentionLabel,
  createPreferencesStore,
  DEFAULT_SHORTCUT,
  restoreBounds,
  savedRoute,
  validateAttention,
  validateShortcut,
} from './preferences.mjs';
import { desktopProfile } from './profile.mjs';
import {
  allowsPermission,
  assertTrustedSender,
  CONTENT_SECURITY_POLICY,
  isAppPage,
  isUiPage,
  linkAction,
} from './security.mjs';
import { startUiServer } from './server.mjs';
import { uiUrl, validateDevelopmentSource } from './ui-source.mjs';
import { viewLinkFromRoute } from './view-links.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const profile = desktopProfile(
  app.isPackaged ? metadata.desktopProfile : process.env.FARMSLOT_DESKTOP_PROFILE,
);
app.setName(profile.name);
app.setPath('userData', join(app.getPath('appData'), profile.name));
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

let window;
let clientSession;
let server;
let store;
let connection = null;
let quitting = false;
let quitConfirmation = null;
let preferencesStore;
let preferences = {
  shortcut: DEFAULT_SHORTCUT,
  route: '#fleet',
  development: validateDevelopmentSource({ enabled: profile.development }),
};
let registeredShortcut = '';
let shortcutError = '';
let tray;
let attention = { connected: false, ready: false, decisions: 0 };
let boundsTimer;
let desktopReady = false;
let pendingRoute = null;
let openingDeepLink = false;
let developmentRecovery = null;

function developmentUrl() {
  return profile.development && preferences.development.enabled
    ? preferences.development.url
    : null;
}

function showDevelopmentUnavailable() {
  if (quitting) return Promise.resolve();
  if (!developmentRecovery) {
    developmentRecovery = loadPage('/settings?developmentUnavailable=1').finally(() => {
      developmentRecovery = null;
    });
  }
  return developmentRecovery;
}

async function loadUi(route) {
  const target = uiUrl(server.origin, developmentUrl()) + route;
  try {
    await window.loadURL(target);
    return true;
  } catch (error) {
    // Another navigation can supersede an in-flight load.
    if (error.code === 'ERR_ABORTED') return false;
    if (!developmentUrl()) throw error;
    await showDevelopmentUnavailable();
    return false;
  }
}

function profileRoute(value) {
  if (typeof value !== 'string' || !value.toLowerCase().startsWith(`${profile.scheme}:`))
    return null;
  return routeFromDeepLink('farmslot:' + value.slice(profile.scheme.length + 1));
}

function receiveDeepLink(value) {
  if (quitting) return;
  const route = profileRoute(value);
  if (!route) {
    console.warn('Ignored unsupported Farmslot link.');
    return;
  }
  pendingRoute = route;
  flushDeepLink().catch((error) => reportError('Could not open Farmslot link', error));
}

async function flushDeepLink() {
  if (!desktopReady || openingDeepLink || quitting) return;
  openingDeepLink = true;
  try {
    while (pendingRoute && !quitting) {
      const route = pendingRoute;
      const opened = await showWindow(connection ? route : undefined);
      // Connection Settings consumes the pending route after login. Do not
      // reload that form when another link arrives while the user is typing.
      if (!connection || opened === false) break;
      if (pendingRoute === route) pendingRoute = null;
    }
  } finally {
    openingDeepLink = false;
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveDeepLink(url);
});

function currentDeepLink(url = window?.webContents.getURL()) {
  if (!url || !isUiPage(url, server.origin, developmentUrl())) return null;
  return deepLinkFromRoute(new URL(url).hash)?.replace(/^farmslot:/, `${profile.scheme}:`) ?? null;
}

function currentViewLink(url = window?.webContents.getURL()) {
  if (!url || !isUiPage(url, server.origin, developmentUrl())) return null;
  return viewLinkFromRoute(new URL(url).hash || '#fleet')?.replace(
    /^farmslot:/,
    `${profile.scheme}:`,
  );
}

function updateCopyLink(url) {
  const item = Menu.getApplicationMenu()?.getMenuItemById('copy-desktop-link');
  if (item) item.enabled = Boolean(currentDeepLink(url));
}

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
  let opened = true;
  if (route && connection) {
    const current = window.webContents.getURL();
    if (
      isUiPage(current, server.origin, developmentUrl()) &&
      !window.webContents.isLoadingMainFrame()
    ) {
      // loadURL waits for a full document load, which a fragment change may
      // never produce. The preload receives this even before the UI boots.
      window.webContents.send('desktop:navigate', route);
    } else {
      opened = await loadUi(route);
    }
  }
  window.show();
  window.focus();
  return opened;
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
  app.dock?.setBadge(attentionBadge(attention));
  if (!tray) return;
  const label = attentionLabel(attention);
  tray.setToolTip(`${profile.name}: ${label}`);
  tray.setTitle(attentionBadge(attention));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      {
        label: `Show ${profile.name}`,
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
  const source = nativeImage.createFromPath(join(root, 'build', profile.icon));
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    icon.addRepresentation({
      scaleFactor,
      buffer: source.resize({ width: 18 * scaleFactor, height: 18 * scaleFactor }).toPNG(),
    });
  }
  // Template images lose their profile color when macOS renders the menu bar.
  icon.setTemplateImage(false);
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
  if (profileRoute(url)) {
    receiveDeepLink(url);
    return;
  }
  switch (linkAction(url, server.origin, connection, developmentUrl())) {
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
    title: profile.name,
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
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    window.setTitle(
      profile.development
        ? `${profile.name}: ${title}${developmentUrl() ? ' [Live]' : ' [Bundled]'}`
        : title,
    );
  });
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (
      isMainFrame &&
      code !== -3 &&
      developmentUrl() &&
      isUiPage(url, server.origin, developmentUrl())
    ) {
      showDevelopmentUnavailable().catch((error) =>
        reportError('Could not open recovery settings', error),
      );
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    openLink(url).catch((error) => reportError('Could not open link', error));
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppPage(url, server.origin, developmentUrl())) return;
    event.preventDefault();
    openLink(url).catch((error) => reportError('Could not open link', error));
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppPage(url, server.origin, developmentUrl())) event.preventDefault();
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
    updateCopyLink(url);
    if (!isUiPage(url, server.origin, developmentUrl())) return;
    try {
      const route = savedRoute(new URL(url).hash);
      savePreferences({ route });
      if (pendingRoute === route) pendingRoute = null;
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
  if (connection) await loadUi(pendingRoute ?? preferences.route);
  else await window.loadURL(`${server.origin}/settings`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  for (const value of process.argv.filter((arg) => profileRoute(arg))) receiveDeepLink(value);
  app.on('second-instance', (_event, argv) => {
    if (quitting) return;
    const link = argv.find((arg) => profileRoute(arg));
    if (link) {
      receiveDeepLink(link);
      return;
    }
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
      // Isolated validation profiles must not replace the installed URL handler.
      if (
        app.isPackaged &&
        !process.env.FARMSLOT_DESKTOP_USER_DATA &&
        !app.setAsDefaultProtocolClient(profile.scheme)
      ) {
        reportError(
          'Could not register Farmslot links',
          new Error('Install Farmslot in Applications and reopen it to enable farmslot:// links.'),
        );
      }
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
      preferencesStore = createPreferencesStore(app.getPath('userData'), profile.development);
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
      app.dock?.setIcon(join(root, 'build', profile.icon));
      createTray();
      store = createConnectionStore(app.getPath('userData'), safeStorage);
      try {
        connection = await store.load();
      } catch (error) {
        // A damaged or inaccessible credential record is recoverable through Connection Settings.
        reportError('Could not read saved connection', error);
      }
      ipcMain.handle('desktop:load-connection', (event) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        return connection;
      });
      ipcMain.handle('desktop:save-connection', async (event, value) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        connection = await store.save(value);
      });
      ipcMain.handle('desktop:load-preferences', (event) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        return {
          shortcut: preferences.shortcut,
          shortcutError,
          route: pendingRoute ?? preferences.route,
          development: preferences.development,
          profile: profile.name,
          supportsDevelopment: profile.development,
          uiUrl: uiUrl(server.origin, developmentUrl()),
        };
      });
      ipcMain.handle('desktop:save-development', (event, value) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        if (!profile.development) throw new Error('Use Farmslot Dev for the Development UI.');
        if (new URL(event.senderFrame.url).pathname !== '/settings')
          throw new Error('Change Development UI from Connection Settings.');
        savePreferences({ development: validateDevelopmentSource(value) });
      });
      ipcMain.handle('desktop:open-ui', (event) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        const route = pendingRoute ?? preferences.route;
        // Acknowledge before navigation replaces the settings frame.
        const opening = connection ? loadUi(route) : loadPage('/settings');
        opening.catch((error) => reportError('Could not open Command Center', error));
      });
      ipcMain.handle('desktop:copy-current-link', async (event) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        const url = window?.webContents.getURL();
        if (!url || !isAppPage(url, server.origin, developmentUrl()))
          throw new Error('The current Farmslot view is not available to copy.');
        const link = currentViewLink(url);
        if (!link) throw new Error('This view contains URL parameters that cannot be shared.');
        await clipboard.writeText(link);
        return link;
      });
      ipcMain.handle('desktop:save-shortcut', (event, value) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        setShortcut(value);
      });
      ipcMain.handle('desktop:update-attention', (event, value) => {
        assertTrustedSender(event, window, server.origin, developmentUrl());
        if (!isUiPage(event.senderFrame.url, server.origin, developmentUrl()))
          throw new Error('Status must come from Command Center.');
        attention = validateAttention(value);
        updateTray();
      });
      clientSession.webRequest.onHeadersReceived((details, callback) => {
        if (
          details.resourceType !== 'mainFrame' ||
          !developmentUrl() ||
          !isUiPage(details.url, server.origin, developmentUrl())
        ) {
          callback({});
          return;
        }
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-security-policy') delete headers[key];
        }
        headers['Content-Security-Policy'] = [CONTENT_SECURITY_POLICY];
        callback({ responseHeaders: headers });
      });
      clientSession.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(
          allowsPermission(window, contents, permission, details, server.origin, developmentUrl()),
        ),
      );
      clientSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
        allowsPermission(window, contents, permission, details, server.origin, developmentUrl()),
      );
      clientSession.on('will-download', (event, item, contents) => {
        const action = linkAction(item.getURL(), server.origin, connection, developmentUrl());
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
            label: profile.name,
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
              {
                id: 'copy-desktop-link',
                label: 'Copy Link to Current View',
                enabled: false,
                click: () => {
                  const link = currentDeepLink();
                  if (link)
                    clipboard
                      .writeText(link)
                      .catch((error) => reportError('Could not copy link', error));
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
        if (window && isAppPage(window.webContents.getURL(), server.origin, developmentUrl())) {
          window.webContents.send('desktop:resume');
        }
      });
      await createWindow();
      desktopReady = true;
      await flushDeepLink();
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

// Closing a window keeps the client available in the Dock. An intentional quit
// must be confirmed before tearing down its window, tray or saved connection.
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  // Startup failure and the redundant second process must still be able to exit.
  if (!server) return;
  event.preventDefault();
  if (quitting || quitConfirmation) return;
  const parent = window && !window.isDestroyed() ? window : null;
  if (parent) {
    if (parent.isMinimized()) parent.restore();
    parent.show();
    parent.focus();
  }
  const options = {
    type: 'question',
    title: `Quit ${profile.name}?`,
    message: `Quit ${profile.name}?`,
    detail: 'Gateway work will keep running. You can reopen this app from the Dock.',
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  quitConfirmation = (
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  )
    .then(async ({ response }) => {
      if (response !== 1) return;
      quitting = true;
      try {
        saveWindowBounds();
      } catch (error) {
        reportError('Could not save window position', error);
      }
      app.dock?.setBadge('');
      globalShortcut.unregisterAll();
      tray?.destroy();
      tray = null;
      await server.close();
      // Re-entering app.quit() from a cancelled native quit can close every
      // window without exiting Electron. Confirmation and cleanup are complete;
      // exit once so no background instance can block a subsequent Dock launch.
      app.exit(0);
    })
    .catch((error) => {
      reportError(quitting ? 'Could not stop Farmslot' : 'Could not confirm quit', error);
      if (quitting) app.exit(1);
    })
    .finally(() => {
      quitConfirmation = null;
    });
});
