import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(
  new URL('../../projects/farmslot-farm/setup/sandbox-dev.sh', import.meta.url),
);
const exec = promisify(execFile);

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot primary repo '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const linked = path.join(root, 'linked');
  const project = 'projects/farmslot-farm/project.json';
  mkdirSync(path.join(primary, path.dirname(project)), { recursive: true });
  writeFileSync(path.join(primary, project), '{}\n');
  const git = (...args) => execFileSync('git', ['-C', primary, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  git('worktree', 'add', '-qb', 'fixture-linked', linked);

  const ports = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer((_request, response) => response.end('ok'));
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    ports.push(server.address().port);
  }
  for (const repo of [primary, linked]) {
    writeFileSync(
      path.join(repo, '.env.ports'),
      `GATEWAY_PORT=${ports[0]}\nVITE_PORT=${ports[1]}\n`,
    );
  }

  async function health(repo) {
    const { stdout } = await exec('bash', [script, 'health', '--gateway-port', String(ports[0])], {
      encoding: 'utf8',
      timeout: 2000,
      env: {
        ...process.env,
        FARMSLOT_SLOT_REPO: repo,
        FARMSLOT_RUNTIME_DIR: path.join(root, 'runtime'),
        GATEWAY_PORT: String(ports[0]),
        VITE_PORT: String(ports[1]),
      },
    });
    return stdout;
  }
  return { primary, linked, project, health };
}

test('primary checkout is recognized without a configured personal path', async (t) => {
  const f = await fixture(t);
  assert.match(await f.health(f.primary), /primary checkout.*operator gateway/);
});

test('linked worktree retains its isolated gateway classification', async (t) => {
  const f = await fixture(t);
  const output = await f.health(f.linked);
  assert.match(output, /gateway healthy on/);
  assert.doesNotMatch(output, /primary checkout/);
});

test('an explicit primary_repo still overrides Git discovery', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.linked, f.project), JSON.stringify({ primary_repo: f.linked }));
  assert.match(await f.health(f.linked), /primary checkout.*operator gateway/);
});
