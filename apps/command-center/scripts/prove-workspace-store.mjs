import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(await realpath(process.cwd()), await realpath(root));
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert(process.env.FARMSLOT_SLOT_RESOURCE_PROOF && process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR);
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
const home = await realpath(process.env.FARMSLOT_HOME);
assert.equal(await realpath(fixture.home), home);
const repo = await realpath(fixture.repo);
assert(repo.startsWith(`${home}/`), 'Use only the disposable workspace');
const git = (...args) =>
  execute('git', ['-C', repo, ...args], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  });
const metadata = (await git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'))
  .stdout;
for (const entry of metadata.trim().split('\n'))
  assert(
    (await realpath(entry)).startsWith(`${home}/`),
    'Git metadata must belong to the private fixture',
  );

const target = await automationGatewayTarget();
const backend = new URL(target.url);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname));
assert.equal(Number(backend.port), Number(process.env.GATEWAY_PORT));
const artifacts = path.resolve(process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR);
assert(!artifacts.startsWith(`${root}/`), 'Keep generated evidence outside source');
await mkdir(artifacts, { recursive: true });
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const probe = path.join(root, 'apps/command-center/scripts/probes/offline-workspace.js');
const cdp = async (...args) =>
  JSON.parse((await execute(process.execPath, [cdpFile, ...args], { timeout: 60000 })).stdout);
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
assert.equal((await rpc('run.list', { limit: 1 })).runs.length, 0);
const fleet = (await rpc('fleet.status')).fleet;
assert.equal(fleet.slots.length, 1);
assert.equal(fleet.slots[0].slot, fixture.slotId);
assert.equal(fleet.slots[0].repo, repo);
const name = `offline-workspace-${randomUUID()}.txt`;
const file = path.join(repo, name);
const original = `Owned workspace A ${randomUUID()}\n`;
const changed = `Owned workspace B ${randomUUID()}\n`;
const base = new URL(process.env.FARMSLOT_UI_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
base.searchParams.set('workspace-proof', randomUUID());
base.hash = `slot/${fixture.slotId}?file=${encodeURIComponent(name)}&activity=files`;
const route = `slot/${fixture.slotId}`;
const read = () => cdp('eval', route, '--file', probe);
const snapshots = [];
async function until(accepts, label) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  await writeFile(path.join(artifacts, 'last-observation.json'), JSON.stringify(value, null, 2));
  await cdp('screenshot', route, path.join(artifacts, 'failed-workspace.png'));
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
let created = false;
let indexed = false;
let failure;
const cleanupErrors = [];
try {
  await writeFile(file, original, { flag: 'wx', mode: 0o600 });
  created = true;
  await cdp('goto', base.href);
  await cdp('focus', route);
  if (
    await cdp(
      'eval',
      route,
      "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.backdrop'))",
    )
  )
    await cdp('click', route, 'whats-new-modal >>> button.primary');
  if (
    !(await cdp(
      'eval',
      route,
      "return Boolean(document.querySelector('slot-view')?.renderRoot.querySelector('file-tree'))",
    ))
  )
    await cdp('click', route, 'slot-view .sv-activity-btn[title="Explorer (Cmd+B)"]');
  const warm = await until(
    (value) => value.ready && value.content === original && value.renderedEditor,
    'The real workspace must open the owned file through shared queries',
  );
  assert.equal(warm.storage, 'opfs-sahpool');
  snapshots.push({ phase: 'warm', ...warm });
  await writeFile(file, changed);
  const updated = await until(
    (value) => value.ready && value.content === changed,
    'An external workspace write must reach the open editor without Refresh',
  );
  snapshots.push({ phase: 'external-write', ...updated });
  await git('add', '--', name);
  indexed = true;
  const staged = await until(
    (value) => value.ready && value.git?.changes?.some((row) => row.path === name && row.staged),
    'An index-only write must update the open workspace without Refresh',
  );
  snapshots.push({ phase: 'index-write', ...staged });
  const idle = await cdp(
    'idle-reads',
    route,
    '11000',
    JSON.stringify(['fs.list', 'fs.read', 'git.status', 'git.diff']),
  );
  assert.equal(idle.total, 0, 'An idle workspace must issue zero periodic panel reads');
  await writeFile(path.join(artifacts, 'idle-reads.json'), JSON.stringify(idle, null, 2));
  await cdp('screenshot', route, path.join(artifacts, 'workspace-current.png'));
  const saved = await read();
  const fileRead = saved.readStates.find(
    (row) => row.method === 'fs.read' && row.id.includes(name),
  );
  assert(fileRead?.observedAt);
  await withOwnedGatewayOffline(async () => {
    base.searchParams.set('workspace-cold', randomUUID());
    await cdp('goto', base.href);
    await cdp('focus', route);
    const cold = await until(
      (value) =>
        !value.ready &&
        value.content === changed &&
        value.renderedEditor &&
        value.readStates.some((row) => row.method === 'fs.read' && row.status === 'stale'),
      'A new offline document must render the saved opened workspace file',
    );
    assert.equal(
      cold.readStates.find((row) => row.id === fileRead.id)?.observedAt,
      fileRead.observedAt,
    );
    assert.equal(cold.treeActionsDisabled, true);
    assert.equal(cold.saveDisabled, true);
    assert(
      cold.visibleStatus.some(
        (text) => text.includes('Saved workspace') && text.includes('current read'),
      ),
    );
    snapshots.push({ phase: 'cold', ...cold });
    await cdp('screenshot', route, path.join(artifacts, 'workspace-cold-offline.png'));
  });
  const recovered = await until(
    (value) => value.ready && value.content === changed,
    'The saved workspace must recover through current reads after gateway restart',
  );
  snapshots.push({ phase: 'recovered', ...recovered });
  console.log(
    JSON.stringify({
      result: 'PASS',
      externalWrite: true,
      indexWrite: true,
      idleReads: 0,
      coldWorkspace: true,
      savedAge: true,
      staleActionsDisabled: true,
      recovery: true,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  if (indexed) {
    try {
      await git('reset', 'HEAD', '--', name);
    } catch (error) {
      cleanupErrors.push(`Owned index entry: ${error.message}`);
    }
  }
  if (created) {
    try {
      const bytes = await readFile(file, 'utf8');
      assert(bytes === original || bytes === changed, 'Preserve foreign replacement bytes');
      await unlink(file);
    } catch (error) {
      cleanupErrors.push(`Owned file: ${error.message}`);
    }
  }
  await writeFile(
    path.join(artifacts, 'workspace-observations.json'),
    JSON.stringify(snapshots, null, 2),
  );
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        result: failure || cleanupErrors.length ? 'FAIL' : 'PASS',
        failure: failure?.message,
        cleanupErrors,
        fixture: fixture.slotId,
      },
      null,
      2,
    ),
  );
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors.map((message) => new Error(message))],
    'Workspace proof failed; original failure and cleanup retained',
  );
