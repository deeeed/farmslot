import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

function requestedFile(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl ?? '/', 'http://localhost').pathname);
  } catch (error) {
    if (error instanceof URIError) return { status: 400 };
    throw error;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return { status: 403 };
  if (!existsSync(candidate)) return { status: 404 };
  if (statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
  if (!existsSync(candidate)) return { status: 404 };
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return { status: 403 };
  return { status: 200, file: resolved };
}

export async function serveReviewBoard({ directory, host = '127.0.0.1', port = 0 }) {
  const root = realpathSync(path.resolve(directory));
  const server = createServer((request, response) => {
    const result = requestedFile(root, request.url);
    if (!result.file) {
      response.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(result.status === 404 ? 'Not found' : 'Invalid request');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type':
        CONTENT_TYPES.get(path.extname(result.file).toLowerCase()) ?? 'application/octet-stream',
    });
    createReadStream(result.file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Visual review server did not resolve a TCP port.');
  }
  return {
    url: `http://${host}:${address.port}/`,
    host,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
