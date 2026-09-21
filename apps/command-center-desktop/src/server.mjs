import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

import { CONTENT_SECURITY_POLICY } from './security.mjs';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export async function startUiServer(uiDirectory, settingsDirectory, userDataDirectory) {
  const portFile = userDataDirectory ? join(userDataDirectory, 'ui-port.json') : null;
  let port = 0;
  if (portFile) {
    try {
      port = JSON.parse(await readFile(portFile, 'utf8'));
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error(
          'Invalid saved desktop port. Restore ui-port.json from your profile backup.',
        );
      }
    } catch (error) {
      // First launch allocates a port. Existing profiles must retain their storage origin.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const uiRoot = await realpath(uiDirectory);
  const settingsRoot = await realpath(settingsDirectory);
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const finish = (status, message) => {
      response.writeHead(status);
      response.end(message);
    };
    if (request.headers.host !== new URL(origin).host) return finish(403, 'Forbidden host');
    if (!['GET', 'HEAD'].includes(request.method)) return finish(405, 'Method not allowed');
    try {
      const rawPath = decodeURIComponent((request.url ?? '').split('?')[0]);
      if (
        !rawPath.startsWith('/') ||
        rawPath.includes('\\') ||
        rawPath.includes('\0') ||
        rawPath.split('/').some((part) => part === '..' || part === '.')
      ) {
        return finish(400, 'Invalid path');
      }
      let root;
      let relative;
      if (rawPath === '/settings') {
        root = settingsRoot;
        relative = 'index.html';
      } else if (['/settings.js', '/settings.css'].includes(rawPath)) {
        root = settingsRoot;
        relative = rawPath.slice(1);
      } else if (rawPath.startsWith('/cc/')) {
        root = uiRoot;
        relative = rawPath.slice(4) || 'index.html';
      } else {
        return finish(404, 'Not found');
      }
      const file = await realpath(resolve(root, relative));
      if (!file.startsWith(`${root}${sep}`)) return finish(403, 'Forbidden path');
      const body = await readFile(file);
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error instanceof URIError) return finish(400, 'Invalid path');
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return finish(404, 'Not found');
      console.error('Desktop asset request failed:', error);
      finish(500, 'Could not load application assets');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Farmslot's saved desktop port ${port} is in use. Close the process using it and reopen Farmslot.`,
              { cause: error },
            )
          : error,
      ),
    );
    server.listen(port, '127.0.0.1', resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (portFile && port === 0) {
    try {
      await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
      await writeFile(portFile, JSON.stringify(server.address().port), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      // Never expose a window with an origin that could not be persisted.
      server.close();
      throw error;
    }
  }
  return {
    origin,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}
