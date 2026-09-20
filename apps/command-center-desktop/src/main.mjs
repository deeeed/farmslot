import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  session,
  shell,
} from 'electron';

import { createConnectionStore } from './connection.mjs';
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

function reportError(title, error) {
  dialog.showErrorBox(title, error instanceof Error ? error.message : String(error));
}

async function loadPage(path) {
  if (quitting) return;
  if (!window || window.isDestroyed()) await createWindow();
  await window.loadURL(`${server.origin}${path}`);
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
    width: 1440,
    height: 960,
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
  window.on('closed', () => {
    window = null;
  });
  window.once('ready-to-show', () => window?.show());
  await window.loadURL(`${server.origin}${connection ? '/cc/' : '/settings'}`);
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
      store = createConnectionStore(app.getPath('userData'), safeStorage);
      try {
        connection = await store.load();
      } catch (error) {
        // A damaged or inaccessible credential record is recoverable through Connection Settings.
        reportError('Could not read saved connection', error);
      }
      ipcMain.handle('desktop:load-connection', (event) => {
        assertTrustedSender(event, window, server.origin);
        return store.load();
      });
      ipcMain.handle('desktop:save-connection', async (event, value) => {
        assertTrustedSender(event, window, server.origin);
        await store.save(value);
        connection = await store.load();
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
  server
    .close()
    .then(() => app.quit())
    .catch((error) => {
      reportError('Could not stop the desktop asset server', error);
      app.exit(1);
    });
});
