import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { startUiServer } from '../src/server.mjs';

function get(origin, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, headers, method }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('asset server confines files, binds loopback, rejects foreign hosts, and supplies CSP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'farmslot-assets-'));
  const ui = join(directory, 'ui');
  const settings = join(directory, 'settings');
  await mkdir(ui);
  await mkdir(settings);
  await writeFile(join(ui, 'index.html'), '<h1>Command Center</h1>');
  await writeFile(join(ui, 'app.js'), 'export default 1');
  await writeFile(join(settings, 'index.html'), '<h1>Settings</h1>');
  await writeFile(join(directory, 'secret'), 'must not escape');
  await symlink(join(directory, 'secret'), join(ui, 'escape'));
  const server = await startUiServer(ui, settings);
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await get(server.origin, '/cc/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Command Center/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match((await get(server.origin, '/cc/app.js')).headers['content-type'], /javascript/);
  assert.equal((await get(server.origin, '/settings')).status, 200);
  assert.equal((await get(server.origin, '/cc/', { Host: 'attacker.example' })).status, 403);
  assert.equal((await get(server.origin, '/cc/escape')).status, 403);
  for (const path of [
    '/cc/../secret',
    '/cc/%2e%2e/secret',
    '/cc/%2e%2e%2fsecret',
    '/cc/..%5csecret',
    '/cc/%00',
    '/cc/%GG',
  ]) {
    assert.equal((await get(server.origin, path)).status, 400, path);
  }
  assert.equal((await get(server.origin, '/cc/missing.js')).status, 404);
  assert.equal((await get(server.origin, '/api/run-artifact')).status, 404);
  assert.equal((await get(server.origin, '/cc/', {}, 'POST')).status, 405);
  assert.equal((await get(server.origin, '/cc/', {}, 'HEAD')).body, '');
});

test('profile keeps its origin across restart and fails closed when the saved port is occupied', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'farmslot-stable-origin-'));
  const ui = join(directory, 'ui');
  const settings = join(directory, 'settings');
  const profile = join(directory, 'profile');
  await mkdir(ui);
  await mkdir(settings);
  await writeFile(join(ui, 'index.html'), 'app');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startUiServer(ui, settings, profile);
  const expectedOrigin = first.origin;
  await first.close();
  const second = await startUiServer(ui, settings, profile);
  try {
    assert.equal(second.origin, expectedOrigin);
    await assert.rejects(startUiServer(ui, settings, profile), /saved desktop port .* is in use/);
    assert.equal((await get(second.origin, '/cc/')).body, 'app');
  } finally {
    await second.close();
  }
  await writeFile(join(profile, 'ui-port.json'), '0');
  await assert.rejects(startUiServer(ui, settings, profile), /Invalid saved desktop port/);
});

test(
  'shutdown closes an unfinished HTTP request instead of holding the app open',
  { timeout: 2000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'farmslot-shutdown-'));
    const server = await startUiServer(directory, directory);
    const socket = createConnection(Number(new URL(server.origin).port), '127.0.0.1');
    t.after(async () => {
      socket.destroy();
      await rm(directory, { recursive: true, force: true });
    });
    await once(socket, 'connect');
    // Force-closing an unfinished request may reset the peer instead of sending a FIN.
    socket.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
    socket.write('GET /cc/ HTTP/1.1\r\nHost:');
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await server.close();
    await closed;
  },
);
