#!/usr/bin/env tsx
// Real Electron UI + isolated gateway + disposable Git remote. No model calls.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, openSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const evidence = path.resolve('temp/checkout-update');
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(evidence, 'fixture-'));
const checkout = path.join(fixture, 'checkout');
const publisher = path.join(fixture, 'publisher');
const remote = path.join(fixture, 'remote.git');
const home = path.join(fixture, 'home');
const profile = path.join(fixture, 'desktop');
const token = randomBytes(24).toString('hex');
const gatewayUrl = 'ws://127.0.0.1:8991/ws';
const uiUrl = 'http://localhost:5190/';
const env = {
  ...process.env,
  FARMSLOT_CDP_PORT: '9523',
  FARMSLOT_GATEWAY: gatewayUrl,
  FARMSLOT_GATEWAY_TOKEN: token,
};
const children: ReturnType<typeof spawn>[] = [];
const bin = path.join(fixture, 'bin');
const pauseFile = path.join(fixture, 'pause-update');
const mergeStarted = path.join(fixture, 'merge-started');
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const stopped = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  await Promise.race([stopped, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, 'SIGKILL');
    await stopped;
  }
}
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}
function cdp(...args: string[]) {
  return execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30000,
  }).trim();
}
function value(expression: string) {
  return JSON.parse(cdp('eval', '-', `return {value:await (${expression})};`)).value;
}
async function wait(check: () => boolean | Promise<boolean>, name: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${name}`);
}
async function listening(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  } // Fixture servers are not listening before launch.
}
function launch(command: string, args: string[], extra: Record<string, string>) {
  const log = openSync(path.join(evidence, 'process.log'), 'a', 0o600);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  children.push(child);
  return child;
}
async function publish(text: string) {
  await writeFile(path.join(publisher, 'README.md'), text);
  git(publisher, 'add', 'README.md');
  git(publisher, 'commit', '-m', 'fix: advance fixture');
  git(publisher, 'push', 'origin', 'main');
  return git(publisher, 'rev-parse', 'HEAD');
}
function status(refresh = false) {
  return JSON.parse(cdp('gateway', 'gateway.status', JSON.stringify({ refresh }))).update;
}
function bannerText() {
  return value('document.querySelector("update-banner")?.shadowRoot?.textContent ?? ""');
}
function click(selector: string) {
  cdp(
    'eval',
    '-',
    `const button=document.querySelector('update-banner')?.shadowRoot?.querySelector(${JSON.stringify(selector)}); if(!button)throw new Error('Missing banner control'); button.click(); return true;`,
  );
}
const checks: string[] = [];
function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}
try {
  for (const port of [8991, 5190, 9523])
    assert(!(await listening(port)), `Port ${port} is occupied`);
  git(fixture, 'init', '--bare', '--initial-branch=main', remote);
  git(fixture, 'clone', remote, publisher);
  await mkdir(path.join(publisher, 'services/gateway'), { recursive: true });
  await mkdir(path.join(publisher, 'scripts'), { recursive: true });
  for (const [file, content] of Object.entries({
    'CLAUDE.md': 'Fixture',
    'scripts/dev.sh': '# fixture',
    'services/gateway/package.json': '{"version":"0.0.0"}',
    'README.md': 'before\n',
    '.gitignore': '*\n',
  }))
    await writeFile(path.join(publisher, file), content);
  git(publisher, 'add', '-f', '.');
  git(publisher, 'commit', '-m', 'chore: initialize fixture');
  git(publisher, 'push', 'origin', 'main');
  git(fixture, 'clone', remote, checkout);
  const original = git(checkout, 'rev-parse', 'HEAD');
  const target = await publish('first update\n');
  for (const dir of [home, profile, path.join(fixture, 'pool'), path.join(fixture, 'projects')])
    await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify({ shortcut: '', route: '#fleet', development: { enabled: true, url: uiUrl } }),
  );
  await mkdir(bin);
  // Delay the real Git merge to exercise a gateway restart during an update.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = merge ]; then\n  touch ${quote(mergeStarted)}\n  while [ -e ${quote(pauseFile)} ]; do sleep 0.1; done\nfi\nexec ${quote(realGit)} "$@"\n`,
  );
  await chmod(path.join(bin, 'git'), 0o700);
  await writeFile(pauseFile, 'pause');
  const startGateway = () =>
    launch(
      path.join(root, 'node_modules/.bin/tsx'),
      ['--tsconfig', 'services/gateway/tsconfig.json', 'services/gateway/src/index.ts'],
      {
        PATH: `${bin}:${process.env.PATH}`,
        FARMSLOT_ROOT: checkout,
        FARMSLOT_HOME: home,
        FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
        FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
        FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
        FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
        FARMSLOT_TEST_STATUS_FILE: path.join(fixture, 'status.json'),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: '8991',
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
        FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
        NODE_TEST_CONTEXT: '1',
        FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      },
    );
  let gatewayProcess = startGateway();
  launch(
    path.join(root, 'node_modules/.bin/vite'),
    ['--config', 'apps/command-center/ui/vite.config.ts'],
    { VITE_PORT: '5190', GATEWAY_PORT: '8991' },
  );
  await wait(() => listening(8991), 'gateway startup');
  await wait(async () => {
    try {
      return (await fetch(uiUrl)).ok;
    } catch {
      return false;
    }
  }, 'Vite startup');
  const bundle =
    process.env.FARMSLOT_DESKTOP_APP ??
    path.join(root, 'apps/command-center-desktop/release-dev/mac-arm64/Farmslot Dev.app');
  launch(path.join(bundle, 'Contents/MacOS/Farmslot Dev'), [], {
    FARMSLOT_DESKTOP_CDP_PORT: '9523',
    FARMSLOT_DESKTOP_USER_DATA: profile,
  });
  await wait(() => listening(9523), 'Electron startup');
  await wait(async () => {
    const targets = await (await fetch('http://127.0.0.1:9523/json/list')).json();
    return targets.some((target: { url: string }) => target.url.includes('/settings'));
  }, 'settings document');
  await wait(
    () =>
      value(
        'Boolean(document.querySelector("#gateway-url") && !document.querySelector("#connection-form button").disabled)',
      ),
    'settings ready',
  );
  cdp('fill', '-', '#gateway-url', gatewayUrl);
  cdp('fill', '-', '#secret', token);
  cdp('click', '-', '#connection-form button');
  await wait(
    () => value('document.querySelector("farm-app")?.hydrated === true'),
    'client connection',
  );
  cdp(
    'eval',
    '-',
    'document.querySelector("whats-new-modal")?.shadowRoot?.querySelector("button.primary")?.click(); return true;',
  );
  await wait(() => String(bannerText()).includes('1 commit behind'), 'update banner');
  assert.equal(status().localSha, original.slice(0, status().localSha.length));
  click('.update');
  assert(
    String(bannerText()).includes(checkout),
    'Confirmation identifies the actual gateway checkout',
  );
  click('.update');
  await wait(() => existsSync(mergeStarted), 'update worker reaches merge');
  assert.equal(status().operation?.phase, 'running');
  await stop(gatewayProcess);
  gatewayProcess = startGateway();
  await wait(() => listening(8991), 'gateway restart');
  assert.equal(status().operation?.phase, 'running');
  await rm(pauseFile);
  await wait(() => status().operation?.phase === 'complete', 'checkout update');
  record('Update progress and the detached worker survive a gateway restart');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'first update\n');
  await wait(() => String(bannerText()).includes('Checkout updated'), 'success message');
  cdp('screenshot', '-', path.join(evidence, 'updated.png'));
  record('Real update button fast-forwards the gateway checkout and reports completion');
  const second = await publish('second update\n');
  click('.refresh');
  await wait(() => String(bannerText()).includes('1 commit behind'), 'next update');
  await writeFile(path.join(checkout, 'README.md'), 'local work\n');
  click('.update');
  click('.update');
  await wait(() => status().operation?.phase === 'error', 'dirty refusal');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'local work\n');
  await wait(() => String(bannerText()).includes('local changes'), 'visible refusal');
  cdp('screenshot', '-', path.join(evidence, 'local-edits.png'));
  record('Local edits produce a visible error and survive unchanged');
  await writeFile(path.join(checkout, 'README.md'), 'first update\n');
  git(checkout, 'fetch', 'origin', 'main');
  git(checkout, 'merge', '--ff-only', second);
  click('.refresh');
  await wait(
    () => status().localSha === second.slice(0, status().localSha.length),
    'manual pull freshness',
  );
  assert.equal(status().updateAvailable, false);
  await wait(() => String(bannerText()) === '', 'stale banner cleared');
  record('A local pull clears the stale commit count without restarting the gateway');
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ checks }, null, 2));
} catch (error) {
  console.error(String(error).replaceAll(token, '[redacted]'));
  process.exitCode = 1;
} finally {
  // Release a delayed fixture merge even when an assertion fails.
  await rm(pauseFile, { force: true });
  for (const child of children.reverse()) await stop(child);
}
