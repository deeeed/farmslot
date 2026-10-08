'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, describe, it } = require('node:test');

const { extensionIdFromExtensionDir } = require('../src/extension-id.cjs');
const { cdpHttp, pruneExtraHomeTabs } = require('../src/launch-browser.cjs');

// A CDP HTTP endpoint in its own process: cdpHttp blocks this one in spawnSync.
// It serves /json/list from TARGETS and logs every request path to REQUESTS.
const SERVER = `
const fs = require('node:fs');
const http = require('node:http');
const [targetsFile, requestsFile] = process.argv.slice(1);
const server = http.createServer((req, res) => {
  fs.appendFileSync(requestsFile, req.url + '\\n');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/json/list') res.end(fs.readFileSync(targetsFile, 'utf8'));
  else if (req.url.startsWith('/json/close/')) res.end('Target is closing');
  else if (req.url === '/json/version') res.end('{"Browser":"Fake/1.0"}');
  else { res.statusCode = 404; res.end('{}'); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

let root;
let server;
let port;
let targetsFile;
let requestsFile;
let extensionDir;
let extensionId;

const requests = () =>
  fs.existsSync(requestsFile)
    ? fs.readFileSync(requestsFile, 'utf8').split('\n').filter(Boolean)
    : [];

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-web-cdp-http-')));
  targetsFile = path.join(root, 'targets.json');
  requestsFile = path.join(root, 'requests.log');
  fs.writeFileSync(targetsFile, '[]');
  extensionDir = path.join(root, 'ext');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'fixture',
      version: '1.0.0',
      key: 'Zml4dHVyZS1rZXk=',
    }),
  );
  extensionId = extensionIdFromExtensionDir(extensionDir);
  server = spawn(process.execPath, ['-e', SERVER, targetsFile, requestsFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise((resolve, reject) => {
    server.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    server.once('exit', (code) => reject(new Error(`fake CDP server exited ${code}`)));
  });
});

beforeEach(() => {
  fs.rmSync(requestsFile, { force: true });
});

after(() => {
  server?.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

const home = (id) => ({
  id,
  type: 'page',
  url: `chrome-extension://${extensionId}/home.html`,
  title: 'MetaMask',
});

describe('cdpHttp', () => {
  it('fetches an allowed CDP path', () => {
    assert.equal(cdpHttp(port, '/json/version'), '{"Browser":"Fake/1.0"}');
    assert.deepEqual(requests(), ['/json/version']);
  });

  it('keeps a quoted or backticked path out of the script: no code runs, nothing is requested', () => {
    const sentinel = path.join(root, 'cdp-http-ran');
    for (const pathname of [
      `/json/list'); require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1'); ('`,
      `/json/list\`); require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1'); (\``,
      '/json/list/../version',
      'http://example.com/json/list',
    ]) {
      assert.equal(cdpHttp(port, pathname), null, pathname);
    }
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(requests(), []);
  });

  it('refuses a port that is not an integer from 1 to 65535', () => {
    for (const bad of [0, 65536, 1.5, Number.NaN, `${port}/json/version#`]) {
      assert.equal(cdpHttp(bad, '/json/version'), null, String(bad));
    }
    assert.deepEqual(requests(), []);
  });
});

// A fresh launch-browser whose spawnSync records each call instead of running it.
function withCapturedSpawns(run) {
  const childProcess = require('node:child_process');
  const realSpawnSync = childProcess.spawnSync;
  const modulePath = require.resolve('../src/launch-browser.cjs');
  const cached = require.cache[modulePath];
  const calls = [];
  childProcess.spawnSync = (file, args) => {
    calls.push({ file, args });
    return { status: 1, stdout: '' };
  };
  delete require.cache[modulePath];
  try {
    run(require(modulePath), calls);
  } finally {
    childProcess.spawnSync = realSpawnSync;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
}

describe('cdpHttp child process', () => {
  it('runs one constant script and passes the port and path as argv', () => {
    withCapturedSpawns((isolated, calls) => {
      const requests = [
        [9222, '/json/list'],
        [65535, '/json/version'],
        [1, '/json/close/ABC-123'],
      ];
      for (const [requestPort, pathname] of requests) isolated.cdpHttp(requestPort, pathname);
      assert.equal(calls.length, requests.length);
      const [script] = new Set(calls.map((call) => call.args[1]));
      for (const [index, call] of calls.entries()) {
        const [requestPort, pathname] = requests[index];
        assert.equal(call.file, process.execPath);
        assert.deepEqual(call.args, ['-e', script, String(requestPort), pathname]);
        assert.equal(call.args[1].includes(pathname), false, 'the path is in the script source');
      }
      assert.equal(
        new Set(calls.map((call) => call.args[1])).size,
        1,
        'the script varies with input',
      );
    });
  });

  it('spawns nothing for a rejected port or path', () => {
    withCapturedSpawns((isolated, calls) => {
      isolated.cdpHttp(0, '/json/list');
      isolated.cdpHttp(65536, '/json/list');
      isolated.cdpHttp(9222, `/json/list'); process.exit(7); ('`);
      isolated.cdpHttp(9222, '/json/close/../version');
      assert.deepEqual(calls, []);
    });
  });
});

describe('pruneExtraHomeTabs', () => {
  it('closes extra home tabs and skips, with a warning, a target id that is not a CDP id', () => {
    const sentinel = path.join(root, 'target-id-ran');
    const injected = `x'); require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1'); process.exit(7); ('`;
    fs.writeFileSync(
      targetsFile,
      JSON.stringify([
        home('KEEP-1'),
        home('0A1B2C3D4E5F'),
        home(injected),
        home('../version'),
        { id: 'blank-1', type: 'page', url: 'about:blank' },
      ]),
    );

    const problems = pruneExtraHomeTabs(port, extensionDir, { homePage: 'home.html' });

    assert.equal(fs.existsSync(sentinel), false, 'the injected id ran code');
    assert.deepEqual(requests(), ['/json/list', '/json/close/0A1B2C3D4E5F', '/json/close/blank-1']);
    assert.deepEqual(
      problems.map((problem) => problem.split(':')[0]),
      ['skipped target with an invalid id', 'skipped target with an invalid id'],
    );
  });

  it('reports an unreachable endpoint without throwing', () => {
    fs.writeFileSync(targetsFile, '[]');
    assert.deepEqual(pruneExtraHomeTabs(1, extensionDir, { homePage: 'home.html' }), [
      'GET http://127.0.0.1:1/json/list failed',
    ]);
  });
});
