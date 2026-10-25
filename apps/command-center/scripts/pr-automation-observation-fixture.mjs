// Pre-client private rule seed and exact-source teardown. No scans, providers or workers.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import WebSocket from 'ws';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.FARMSLOT_PR_AUTOMATION_PROOF, '1');
const output = process.env.FARMSLOT_TRIAGE_PROOF_SETUP;
const setup = JSON.parse(await readFile(output, 'utf8'));
assert.equal(setup.home, await realpath(process.env.FARMSLOT_HOME));
const context = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
const farm = await realpath(process.env.FARMSLOT_ROOT);
assert.equal(farm, await realpath(context.root));
assert.equal(setup.home, await realpath(context.home));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checkpoint = () => writeFile(output, JSON.stringify(setup) + '\n', { mode: 0o600 });
const files = ['.pr-rules.json', '.pr-push.json', '.pr-monitors.json'];
const mode = process.argv[2];
assert(['seed', 'cleanup'].includes(mode));
if (mode === 'seed') {
  assert(!setup.prFixture);
  setup.prFixture = { farm, before: {}, allowedHashes: {}, temporaries: [] };
  const fixture = setup.prFixture;
  await checkpoint();
  for (const name of files) {
    fixture.before[name] = null;
    fixture.allowedHashes[name] = [];
    const file = path.join(farm, name);
    try {
      assert.equal(await realpath(file), file);
      const bytes = await readFile(file);
      fixture.before[name] = {
        bytes: bytes.toString('base64'),
        mode: (await stat(file)).mode & 0o777,
      };
      fixture.allowedHashes[name].push(hash(bytes));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await checkpoint();
  const target = await automationGatewayTarget();
  assert.equal(new URL(target.url).origin, 'ws://127.0.0.1:7913');
  const socket = new WebSocket(target.url);
  let principal;
  try {
    principal = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Private actor authentication deadline')),
        10000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      socket.once('error', () => finish(new Error('Private actor transport failed')));
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            type: 'req',
            id: 'auth',
            method: 'auth.connect',
            params: {
              ...target.credential,
              clientKind: 'ui',
              clientName: 'pr-observation-fixture',
            },
          }),
        ),
      );
      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.id !== 'auth') return;
          assert(
            frame.ok && frame.payload.principal.roles.some((binding) => binding.role === 'admin'),
          );
          finish(undefined, frame.payload.principal);
        } catch (error) {
          finish(error);
        }
      });
    });
  } finally {
    socket.close();
  }
  fixture.ownerId = principal.id;
  fixture.ownerGeneration = principal.generation ?? 0;
  fixture.installationId = 'd07-pr-' + randomUUID();
  fixture.profileId = 'd07-disabled-' + randomUUID();
  await checkpoint();
  const { PRRuleStore } = await import('../../../services/gateway/src/pr-rules/store.ts');
  const { PRMonitorStore } = await import('../../../services/gateway/src/pr-monitoring/store.ts');
  const { runWithPrincipalOwner } =
    await import('../../../services/gateway/src/security/work-originator.ts');
  const rules = await PRRuleStore.load(path.join(farm, files[0]));
  await runWithPrincipalOwner(
    { ownerId: fixture.ownerId, ownerGeneration: fixture.ownerGeneration },
    async () => {
      const monitors = await PRMonitorStore.load(path.join(farm, '.pr-monitors.json'));
      const monitor = await monitors.subscribe(fixture.ownerId, {
        pr: { host: 'github.com', repo: 'proof/offline-store', number: 1 },
        account: { host: 'github.com', login: 'offline-proof' },
        project: setup.project,
        policy: { mode: 'notify-only' },
        pollIntervalMs: 300000,
        watchedChecks: [],
        automaticAttemptLimit: 1,
        cooldownMs: 300000,
      });
      fixture.monitorId = monitor.id;
      fixture.allowedHashes['.pr-monitors.json'].push(
        hash(await readFile(path.join(farm, '.pr-monitors.json'))),
      );
      await checkpoint();
      await monitors.setLifecycle(monitor.id, fixture.ownerId, monitor.revision, 'paused');
      fixture.allowedHashes['.pr-monitors.json'].push(
        hash(await readFile(path.join(farm, '.pr-monitors.json'))),
      );
      await checkpoint();
      const predicate = { kind: 'compare', field: 'state', operator: 'equals', value: 'open' };
      const team = await rules.saveTeam(fixture.ownerId, {
        name: 'D07 private observation ' + randomUUID(),
        account: { host: 'github.com', login: 'offline-proof' },
        sources: [{ kind: 'repository', repo: 'proof/offline-store' }],
        predicate,
        repositories: [],
        githubTeams: [],
        notificationPrincipalIds: [],
      });
      fixture.teamId = team.id;
      fixture.allowedHashes[files[0]].push(hash(await readFile(path.join(farm, files[0]))));
      await checkpoint();
      const rule = await rules.saveRule(fixture.ownerId, {
        name: 'D07 observed rule ' + randomUUID(),
        teamId: team.id,
        predicate,
        actions: [{ kind: 'review', autoStart: false }],
        pollIntervalMs: 300000,
        maxAdmissionsPerScan: 1,
        rereviewOnHeadChange: false,
      });
      fixture.ruleId = rule.id;
      fixture.ruleName = rule.config.name;
      fixture.allowedHashes[files[0]].push(hash(await readFile(path.join(farm, files[0]))));
      await checkpoint();
    },
  );
  fixture.seededBeforeUi = true;
  await checkpoint();
  console.log(JSON.stringify({ seededBeforeUi: true, ruleId: fixture.ruleId, providerCalls: 0 }));
} else {
  const fixture = setup.prFixture;
  assert.equal(fixture.farm, farm);
  for (const name of files) {
    const file = path.join(farm, name);
    let bytes;
    try {
      assert.equal(await realpath(file), file);
      bytes = await readFile(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes)
      assert(
        fixture.allowedHashes[name].includes(hash(bytes)),
        'Refuse an unknown PR source write',
      );
    const before = fixture.before[name];
    if (before) {
      assert(bytes, 'Refuse an unexpected source removal');
      await writeFile(file, Buffer.from(before.bytes, 'base64'));
      await chmod(file, before.mode);
      assert.equal(hash(await readFile(file)), hash(Buffer.from(before.bytes, 'base64')));
    } else if (bytes) await unlink(file);
  }
  for (const item of fixture.temporaries) {
    assert.equal(path.dirname(item.file), farm);
    assert(path.basename(item.file).startsWith('.pr-rules.d07-'));
    try {
      assert.equal(await realpath(item.file), item.file);
      assert.equal(hash(await readFile(item.file)), item.sha256);
      await unlink(item.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log(JSON.stringify({ cleanupOnly: true, exactPRSourcesRestored: true }));
}
