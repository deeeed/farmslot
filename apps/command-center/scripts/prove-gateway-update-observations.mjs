import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const execute = promisify(execFile);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const configFile = process.env.FARMSLOT_GATEWAY_UPDATE_PROOF;
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.equal(config.sourceRoot, source);
const fixture = JSON.parse(await readFile(path.join(config.caseRoot, 'fixture.json'), 'utf8'));
const artifacts = path.join(config.caseRoot, 'client');
await mkdir(artifacts, { recursive: true });
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 65000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout,
  );
const tab = '@' + config.tabId;
const inspect = (target = tab) =>
  cdp(
    'eval',
    target,
    '--file',
    path.join(source, 'apps/command-center/scripts/probes/gateway-update-observations.js'),
  );
async function until(check, label, timeout = 15000, target = tab) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await inspect(target);
    if (check(last)) return last;
    await delay(80);
  } while (Date.now() < end);
  assert.fail(label + ': ' + JSON.stringify(last));
}
const save = (name, value) =>
  writeFile(path.join(artifacts, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const image = (name) => cdp('screenshot', tab, path.join(artifacts, name + '.png'));
async function checkpoint(name) {
  const request = path.join(artifacts, name + '-request.json');
  await writeFile(request + '.tmp', JSON.stringify({ case: config.name, tabId: config.tabId }));
  await rename(request + '.tmp', request);
  const end = Date.now() + 30000;
  while (true) {
    try {
      const ack = JSON.parse(await readFile(path.join(artifacts, name + '-ack.json'), 'utf8'));
      assert.equal(ack.case, config.name);
      assert.equal(ack.tabId, config.tabId);
      return ack;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert(Date.now() < end, name + ' controller acknowledgement deadline');
    await delay(80);
  }
}
const write = async (mode) => {
  const result = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(source, 'apps/command-center/scripts/gateway-update-proof-fixture.mjs'),
          mode,
          configFile,
        ],
        { cwd: source, timeout: 30000 },
      )
    ).stdout,
  );
  assert(result.completed);
  return result;
};
const fetches = async () => {
  const records = (await readFile(path.join(config.caseRoot, 'git-reads.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return records.filter((row) => row.args[0] === 'fetch').length;
};
const warm = await until(
  (value) => value.ready && value.canonical && value.persistent && value.stored,
  'The real gateway status must be current and persisted',
);
assert.equal(warm.scope.principalId, fixture.actorId);
assert.equal(warm.data.update.updateAvailable, true);
assert.equal(warm.sourceObservation.status, 'ready');
assert.deepEqual(warm.collectorMethods, ['gateway.status']);
assert(!Object.hasOwn(warm.stored.data, 'githubQuerySpend'));
assert(!Object.hasOwn(warm.stored.data, 'listen'));
await save('warm', warm);
await image('warm');
const beforeViewers = await fetches();
assert.equal(beforeViewers, 1, 'The initial mounted observer must sample its source once');
const second = await cdp(
  'goto',
  `http://127.0.0.1:5208/?gateway-proof=${config.name}&viewer=2#fleet`,
  '--new',
);
config.ownedTabIds = [config.tabId, second.id];
await writeFile(configFile + '.tabs.tmp', JSON.stringify(config));
await rename(configFile + '.tabs.tmp', configFile);
try {
  const secondary = await until(
    (value) => value.ready && value.canonical,
    'A second mounted viewer must use the same retained source',
    15000,
    '@' + second.id,
  );
  assert.deepEqual(secondary.scope, warm.scope);
  assert.equal(secondary.persistent, false, 'Only the first tab may own persistent SQLite');
  assert.deepEqual(secondary.data.update, warm.data.update);
  assert.equal(secondary.sourceObservation.observedAt, warm.sourceObservation.observedAt);
  assert.equal(await fetches(), beforeViewers, 'A second viewer must not resample the upstream');
  await save('secondary', secondary);
  await cdp('screenshot', '@' + second.id, path.join(artifacts, 'secondary.png'));
} finally {
  await cdp('close', '@' + second.id);
  config.ownedTabIds = [config.tabId];
  await writeFile(configFile + '.tabs.tmp', JSON.stringify(config));
  await rename(configFile + '.tabs.tmp', configFile);
}
await cdp('focus', tab);
const idle = await cdp('idle-reads', tab, '31000', JSON.stringify(['gateway.status']));
assert(idle.elapsedMs >= 31000);
assert.equal(idle.total, 0, 'Mounted gateway status must not retain its old 30-second panel poll');
assert.equal(await fetches(), beforeViewers);
await save('idle', idle);
await cdp('click', tab, '.fa-version-footer');
await write('outage');
await cdp('click', tab, '.fa-version-actions button');
const failed = await until(
  (value) => value.status === 'stale' && value.error?.code === 'GATEWAY_UPDATE_SOURCE_UNAVAILABLE',
  'A real failed Git read must retain the known source',
);
assert.equal(failed.sourceObservation.observedAt, warm.sourceObservation.observedAt);
assert.equal(failed.data.update.remoteSha, warm.data.update.remoteSha);
assert.equal(failed.ready, false);
await save('outage', failed);
await image('outage');
await write('repair');
await cdp('click', tab, '.fa-version-actions button');
const repaired = await until(
  (value) => value.ready && value.sourceObservation.observedAt > warm.sourceObservation.observedAt,
  'The same mounted observer must recover after a real source check',
);
assert.equal(repaired.timeOrigin, warm.timeOrigin);
await save('repaired', repaired);
await image('repaired');
const beforeLocal = await fetches();
await write('operation');
const operation = await until(
  (value) => value.data?.update.operation?.message === 'Private source operation notice',
  'An independent atomic worker record must update the real panel',
);
assert(operation.banner?.includes('Private source operation notice'));
await save('operation', operation);
await image('operation');
await write('installed');
const installed = await until(
  (value) =>
    value.data?.update.localSha && fixture.targetSha.startsWith(value.data.update.localSha),
  'A real Git checkout must update the mounted installed state',
);
assert.equal(installed.sourceObservation.observedAt, repaired.sourceObservation.observedAt);
assert.equal(await fetches(), beforeLocal, 'Local changes must not recheck the remote');
assert.equal(installed.timeOrigin, warm.timeOrigin);
await save('installed', installed);
await image('installed');
await checkpoint('cold-outage');
await until(
  (value) => value.connection !== 'connected' && !value.ready,
  'The owned gateway must actually be disconnected before a cold browser runtime',
);
const navigated = await cdp(
  'goto',
  `http://127.0.0.1:5208/?gateway-proof=${config.name}&cold=1#fleet`,
);
assert.equal(navigated.id, config.tabId, 'Cold navigation must retain the one owned tab');
const cold = await until(
  (value) =>
    value.timeOrigin > warm.timeOrigin &&
    value.persistent &&
    value.canonical &&
    value.connection !== 'connected' &&
    value.status === 'stale' &&
    value.data,
  'A new offline browser runtime must hydrate the actual scoped SQLite facts',
);
assert.equal(cold.ready, false);
assert.deepEqual(cold.scope, warm.scope);
assert.deepEqual(cold.data, installed.stored.data);
assert.deepEqual(cold.stored.data, installed.stored.data);
assert.equal(cold.stored.observedAt, installed.stored.observedAt);
assert.equal(cold.sourceObservation.observedAt, repaired.sourceObservation.observedAt);
assert(cold.banner?.includes('Saved gateway update,'));
await save('cold', cold);
await image('cold');
await checkpoint('cold-recovery');
const recovered = await until(
  (value) =>
    value.ready &&
    value.connection === 'connected' &&
    value.sourceObservation.observedAt > cold.sourceObservation.observedAt,
  'The same cold browser runtime must recover against the restarted gateway',
  20000,
);
assert.equal(recovered.timeOrigin, cold.timeOrigin);
assert.equal(recovered.canonical, true);
assert(fixture.targetSha.startsWith(recovered.data.update.localSha));
await save('recovered', recovered);
await image('recovered');
const result = {
  gatewaySourceErrorsRetainAge: true,
  gatewaySourceRecovery: true,
  gatewayOperationNotification: true,
  gatewayInstalledNotification: true,
  gatewayLocalNoRemoteRead: true,
  gatewayDurableFactsOnly: true,
  gatewayColdSqlite: true,
  gatewayColdSourceAge: true,
  gatewayColdRecovery: true,
  gatewaySharedViewers: true,
  gatewayNoIdlePoll: true,
};
await save('result', result);
console.log(JSON.stringify(result));
