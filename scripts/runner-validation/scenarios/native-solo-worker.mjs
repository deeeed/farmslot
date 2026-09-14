import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { connect } from './native-node-broker-smoke.mjs';

export const SCENARIO_ID = 'native-solo-worker';

/** Run only against a disposable, unactivated identity domain and an idle native worker slot. */
export async function runScenario({ runnerAdapter, outDir, explicit, timeoutMs = 180000 }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', skipped: true, pass: true };
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false };
  const clients = [];
  let solo;
  let runId;
  let cancelled = false;
  const request = async (client, method, params = {}) => {
    const result = await client.request(method, params, 120000);
    assert.equal(result.ok, true, `${method}: ${result.error?.code}: ${result.error?.message}`);
    return result.payload;
  };
  const wait = async (read, accept) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      assert.ok(Date.now() < deadline, 'Solo worker condition timed out');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  try {
    const base = path.join(ROOT, 'temp/native-validation/g004-solo-private');
    const fixture = JSON.parse(fs.readFileSync(path.join(base, 'fixture.json'), 'utf8'));
    assert.equal(fixture.gateway, 'ws://127.0.0.1:19797');
    assert.equal(fs.realpathSync(fixture.privateRoot), fs.realpathSync(base));
    assert.ok(fs.realpathSync(fixture.cwd).startsWith(fs.realpathSync(base) + path.sep));
    assert.equal(fixture.slotId, 'native-worker-solo-private');
    solo = await connect(undefined, 'ui', undefined, fixture.gateway);
    clients.push(solo);
    assert.equal(solo.principalId, 'local-admin');
    await request(solo, 'fleet.refresh');
    const fleet = await request(solo, 'fleet.status');
    assert.ok(
      fleet.fleet.slots.some((slot) => slot.slot === fixture.slotId),
      'Private solo slot must be registered',
    );
    assert.equal(
      fleet.fleet.slots.find((slot) => slot.slot === fixture.slotId)?.currentRunId,
      null,
    );
    const nonce = randomUUID();
    const marker = `solo-worker-${nonce}.txt`;
    const taskFile = path.join(fixture.projectsDir, fixture.project, 'tasks/dev', nonce, 'TASK.md');
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    await writeNativeFixtureTask(
      taskFile,
      '# Worker: dev\n\n## Checklist\n\n' +
        `- [ ] Write ${marker} containing exactly ${nonce}.\n` +
        '- [ ] Check both boxes in CHECKLIST.md and end the turn without a terminal signal.\n\n' +
        'Do not commit, publish, contact services, or change other files.\n',
      fixture.project,
    );
    const created = await request(solo, 'run.createNative', {
      flowType: 'dev',
      project: fixture.project,
      ticketOrPr: `SOLO-${nonce}`,
      slotId: fixture.slotId,
      allowedSlots: [fixture.slotId],
      taskFile,
      runner: report.runner,
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
    });
    runId = created.run.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const run = await wait(
      async () => (await request(solo, 'run.get', { runId })).run,
      (run) => {
        assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
        return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
      },
    );
    const context = run.agentContexts.find((context) => context.nativeSession?.acceptedAt);
    const binding = context.nativeSession;
    const target = {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      worker: {
        runId,
        contextId: context.id,
        generation: binding.generation,
        leaseId: binding.leaseId,
      },
    };
    const read = () => request(solo, 'native.session.read', target);
    await wait(
      read,
      (snapshot) =>
        snapshot.commands.some(
          (command) => command.commandId === binding.commandId && command.outcome === 'completed',
        ) && snapshot.session.state === 'idle',
    );
    assert.equal(fs.readFileSync(path.join(fixture.cwd, marker), 'utf8').trim(), nonce);
    const catalog = await request(solo, 'native.session.catalog');
    assert.equal(
      catalog.runners.find((runner) => runner.runner === report.runner)?.supportsWorkers,
      true,
    );
    report.checks.push(
      'solo local-admin can see worker capability and read its real native worker',
    );
    const commandId = randomUUID();
    const secondMarker = `solo-input-${commandId}.txt`;
    const sent = await request(solo, 'native.session.send', {
      ...target,
      commandId,
      text: `Write ${secondMarker} containing exactly ${commandId}, then end the turn. No other changes or terminal signal.`,
    });
    assert.equal(sent.accepted, true);
    await wait(
      read,
      (snapshot) =>
        snapshot.commands.some(
          (command) => command.commandId === commandId && command.outcome === 'completed',
        ) && snapshot.session.state === 'idle',
    );
    assert.equal(fs.readFileSync(path.join(fixture.cwd, secondMarker), 'utf8').trim(), commandId);
    report.checks.push(
      'solo local-admin pinned input reaches the exact worker and makes its file effect',
    );
    const stopped = await request(solo, 'run.cancel', {
      runId,
      reason: 'Solo authority proof complete',
    });
    assert.ok(stopped.effects.every((effect) => effect.status !== 'failed'));
    assert.equal((await read()).session.processStopped, true);
    cancelled = true;
    const adminPrincipal = (
      await request(solo, 'principal.create', {
        subject: { type: 'person', displayName: 'Solo proof issued administrator' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      })
    ).principal;
    const issued = await request(solo, 'credential.issue', {
      principalId: adminPrincipal.id,
      displayName: 'Solo proof activation',
    });
    fs.writeFileSync(path.join(base, 'auth/admin-token'), issued.secret, { mode: 0o600 });
    await assert.rejects(
      connect(undefined, 'ui', undefined, fixture.gateway),
      /did not authenticate/,
    );
    const admin = await connect(issued.secret, 'ui', undefined, fixture.gateway);
    clients.push(admin);
    const ownRead = await admin.request('native.session.read', target);
    assert.equal(
      ownRead.ok,
      false,
      'New issued administrator must not inherit the previous native owner',
    );
    const owner = (
      await request(admin, 'principal.create', {
        subject: { type: 'person', displayName: 'Solo proof role-free owner' },
        roles: [],
      })
    ).principal;
    await request(admin, 'principal.create', {
      subject: {
        type: 'node',
        displayName: 'Solo proof unused node',
        machine: `native-solo-${nonce}`,
        nativeOwnerPrincipalId: owner.id,
      },
      roles: [],
    });
    const ownerIssue = await request(admin, 'credential.issue', {
      principalId: owner.id,
      displayName: 'Solo role-free proof',
    });
    const other = await connect(ownerIssue.secret, 'companion', undefined, fixture.gateway);
    clients.push(other);
    const ownerCatalog = await request(other, 'native.session.catalog');
    assert.ok(ownerCatalog.runners.every((runner) => !runner.supportsWorkers));
    assert.equal(
      (await other.request('native.session.read', target)).error?.code,
      'AUTH_FORBIDDEN',
    );
    await request(admin, 'credential.revoke', { credentialId: ownerIssue.credential.id });
    report.checks.push(
      'credential activation disables anonymous local-admin; issued and role-free principals do not inherit its worker',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (runId && !cancelled) {
      try {
        const result = await request(solo, 'run.cancel', {
          runId,
          reason: 'Solo proof failure cleanup',
        });
        assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        report.checks.push('failed proof cancelled its exact fixture worker');
      } catch (error) {
        report.pass = false;
        report.error = `${report.error ?? ''}; cleanup: ${error.message}`;
      }
    }
    for (const client of clients) client.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
