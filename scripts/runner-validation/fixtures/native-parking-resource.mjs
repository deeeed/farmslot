// Disposable resource used by real parking hooks. Control stays on a private Unix socket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, root] = process.argv.slice(2);
assert.ok(root && path.isAbsolute(root));
assert.ok(path.basename(root).startsWith('native-parking-resource-'));
assert.ok(['boot', 'health', 'shutdown', 'serve'].includes(action));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const configPath = path.join(root, 'resource.json');
if (!fs.existsSync(configPath)) {
  assert.equal(action, 'boot');
  const id = randomUUID();
  fs.writeFileSync(configPath, JSON.stringify({ id, socket: `/tmp/fs-native-park-${id}.sock` }), {
    mode: 0o600,
  });
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.match(config.id, /^[a-f0-9-]{36}$/);
assert.equal(config.socket, `/tmp/fs-native-park-${config.id}.sock`);
const statePath = path.join(root, 'state.json');
const request = (method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.socket, path: '/', method, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            const value = JSON.parse(body);
            assert.equal(value.id, config.id);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(1000, () => req.destroy(new Error('Private resource request timed out')));
    req.on('error', reject);
    req.end();
  });
const health = async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null;
      // Shutdown can close a connection after connect but before the health
      // request is written. Confirm absence with a fresh connection.
      if (attempt < 2 && ['EPIPE', 'ECONNRESET'].includes(error.code)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
};

if (action === 'serve') {
  const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const state = { id: config.id, pid: process.pid, starts: (previous.starts ?? 0) + 1 };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(state));
    if (req.method === 'POST') server.close();
  });
  server.on('error', (error) => {
    throw error;
  });
  server.listen(config.socket, () => {
    fs.chmodSync(config.socket, 0o600);
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  });
} else if (action === 'boot') {
  let state = await health();
  if (!state) {
    // A refused socket belongs to this exact fixture identity and has no listener.
    if (fs.existsSync(config.socket)) fs.unlinkSync(config.socket);
    const log = fs.openSync(path.join(root, 'resource.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', root], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', (error) => {
      throw error;
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 10000;
    while (!state && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await health();
    }
    assert.ok(state, 'Private resource did not start');
  }
  console.log(JSON.stringify(state));
} else if (action === 'shutdown') {
  const workerPath = path.join(root, 'worker.json');
  if (fs.existsSync(workerPath)) {
    const { pid } = JSON.parse(fs.readFileSync(workerPath, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
    assert.equal(alive, false, 'Resource shutdown ran before the native worker stopped');
  }
  if (await health()) await request('POST');
  const deadline = Date.now() + 5000;
  while (await health()) {
    assert.ok(Date.now() < deadline, 'Private resource did not stop');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(JSON.stringify({ stopped: true, id: config.id }));
} else {
  const state = await health();
  if (state) console.log(JSON.stringify(state));
  else process.exitCode = 1;
}
