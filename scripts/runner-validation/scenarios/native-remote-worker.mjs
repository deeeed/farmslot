import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';

import { ROOT, shSingleQuote } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { verifyRemoteWorkerHandoff } from './native-remote-worker-handoff.mjs';
import { verifyRemoteWorkerCancellationRace } from './native-remote-worker-race.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-remote-worker';

export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  timeoutMs,
  outDir,
  explicit,
  via,
}) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  if (!slotId && !explicit)
    return { scenario: SCENARIO_ID, runner: report.runner, pass: true, skipped: true };
  const remoteRoot = '/Users/deeeed/dev/farmslot-worktrees/native-node-validation';
  const executionNodeId = 'native-macpro-validation';
  const onRemote = (script) =>
    JSON.parse(
      execFileSync(
        'ssh',
        ['-o', 'BatchMode=yes', 'macpro.local', `node -e ${shSingleQuote(script)}`],
        { encoding: 'utf8', timeout: 30000 },
      ),
    );
  let runId;
  let target;
  let selection;
  let supportFault;
  const pinned = () => pinnedWorkerTarget(selection.runId, selection.contextId, selection.leaseId);
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(slotId, 'native-worker-remote');
    const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
    assert.equal(slot.machine, executionNodeId);
    assert.equal(slot.currentRunId, null);
    assert.equal(slot.repo, `${remoteRoot}/worker-fixture`);
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
    const profileId = process.env.FARMSLOT_NATIVE_WORKER_PROFILE;
    const profileStatus = profileId
      ? rpc(Methods.NATIVE_PROFILE_STATUS, { executionNodeId, profileId })
      : undefined;
    if (profileStatus) {
      assert.equal(profileStatus.account.login, 'authenticated');
      assert.equal(profileStatus.profile.runner, report.runner);
    }
    const nativeProfile = profileStatus
      ? {
          executionNodeId,
          runner: report.runner,
          profileId,
          accountContextId: profileStatus.profile.accountContextId,
        }
      : undefined;
    if (via === 'support-bundle') {
      assert.equal(report.runner, 'codex');
      assert.equal(
        nativeProfile,
        undefined,
        'Support installer proof uses the ambient Codex LB route',
      );
      supportFault = process.env.FARMSLOT_NATIVE_SETTLEMENT_FAULT;
      assert.ok(
        supportFault &&
          path
            .resolve(supportFault)
            .startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      assert.equal(fs.existsSync(supportFault), false);
      const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .map(Number);
      assert.equal(pids.length, 1);
      assert.ok(fs.existsSync(`${supportFault}.${pids[0]}.loaded`));
      fs.writeFileSync(
        supportFault,
        JSON.stringify({ gatewayPid: pids[0], mode: 'observe-support' }),
        { mode: 0o600 },
      );
    }
    const token = randomUUID();
    const marker = `native-remote-${randomUUID()}.txt`;
    const taskFile = path.join(
      ROOT,
      'projects',
      slot.project,
      'tasks/dev',
      `NATIVE-REMOTE-${Date.now()}`,
      'TASK.md',
    );
    await writeNativeFixtureTask(
      taskFile,
      `# Worker: dev\n\n## Checklist\n\n- [ ] Read fixture.txt and write ${marker} containing exactly ${token}.\n- [ ] Check both checklist steps after the file is written.\n\nThen end the turn without a terminal signal. Do not commit, publish, contact services or change other files.\n`,
      slot.project,
      {
        markCommand: `node ${remoteRoot}/node/node_modules/@farmslot/agent-runtime/scripts/mark-checklist-step.cjs`,
      },
    );
    const created = rpc('run.createNative', {
      flowType: 'dev',
      project: slot.project,
      ticketOrPr: path.basename(path.dirname(taskFile)),
      taskFile,
      slotId,
      allowedSlots: [slotId],
      runner: report.runner,
      ...(model ? { model } : {}),
      ...(via === 'support-bundle' ? { effort: 'low' } : {}),
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
      ...(nativeProfile ? { nativeProfile } : {}),
    }).run;
    runId = created.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const started = await wait(
      () => rpc('run.get', { runId }).run,
      (run) => {
        assert.ok(
          !['failed', 'blocked', 'cancelled'].includes(run.status),
          `${run.status}: ${run.error}`,
        );
        return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
      },
      timeoutMs,
    );
    assert.deepEqual(started.nativeProfile, nativeProfile);
    const context = started.agentContexts.find((context) => context.role === 'dev');
    assert.equal(context.target, null);
    let binding = context.nativeSession;
    assert.equal(binding.executionNodeId, executionNodeId);
    assert.deepEqual(binding.profile, nativeProfile);
    target = { sessionId: binding.sessionId, executionNodeId };
    selection = { runId, contextId: context.id, leaseId: binding.leaseId };
    report.sessionId = binding.sessionId;
    if (supportFault) {
      assert.equal(
        binding.accountLabel,
        'ambient',
        'Support proof must preserve ambient account selection',
      );
      const installers = fs
        .readFileSync(`${supportFault}.installers`, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(installers.length > 0, 'No native account installer command observed');
      assert.ok(
        installers.every((item) => /^[a-f0-9]{64}$/.test(item.supportHash ?? '')),
        'Native account installer bypassed verified support bundle',
      );
      const hash = installers.at(-1).supportHash;
      const installed = onRemote(
        `const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const support=path.join(os.homedir(),'farmslot-node/support',${JSON.stringify(hash)});console.log(JSON.stringify({manifest:JSON.parse(fs.readFileSync(path.join(support,'manifest.json'),'utf8')).hash,installerSha:crypto.createHash('sha256').update(fs.readFileSync(path.join(support,'scripts/install-runner-observability.mjs'))).digest('hex')}));`,
      );
      assert.equal(installed.manifest, hash);
      assert.equal(
        installed.installerSha,
        createHash('sha256')
          .update(fs.readFileSync(path.join(ROOT, 'scripts/install-runner-observability.mjs')))
          .digest('hex'),
      );
      assert.ok(binding.stateDirectory && !binding.stateDirectory.startsWith(slot.repo + '/'));
      report.support = { ...installed, commands: installers };
      report.checks.push(
        'Remote account installer used this gateway tree support bundle with external state',
      );
    }
    const read = () => rpc('native.session.read', pinned());
    if (via !== 'support-bundle') {
      const first = await wait(
        read,
        (snapshot) => {
          assert.equal(snapshot.session.cwd, slot.repo);
          assert.equal(snapshot.session.ownerPrincipalId, binding.ownerPrincipalId);
          assert.ok(
            snapshot.commands.find((command) => command.commandId === binding.commandId)?.state !==
              'failed',
          );
          return (
            snapshot.session.state === 'idle' &&
            snapshot.commands.find((command) => command.commandId === binding.commandId)
              ?.outcome === 'completed'
          );
        },
        timeoutMs,
      );
      assert.equal(first.session.profileId, nativeProfile?.profileId);
      if (nativeProfile)
        assert.equal(first.session.accountContextId, nativeProfile.accountContextId);
      else assert.ok(first.session.accountContextId, 'Ambient node account identity is bound');
      assert.equal(
        rpc('native.session.workspace.read', { ...pinned(), path: marker }).content.trim(),
        token,
      );
      const remote = onRemote(
        `const fs=require('node:fs');const root=${JSON.stringify(slot.repo)};console.log(JSON.stringify({marker:fs.readFileSync(root+${JSON.stringify('/' + marker)},'utf8'),checklist:fs.readFileSync(root+${JSON.stringify('/' + context.taskFile.replace(/TASK\.md$/, 'CHECKLIST.md'))},'utf8')}));`,
      );
      assert.equal(remote.marker.trim(), token);
      assert.equal(remote.checklist.match(/\[x\]/gi)?.length, 2);
      assert.equal(
        rpc('run.get', { runId }).run.status,
        'monitoring',
        'Remote native turn completion falsely completed task',
      );
      report.checks.push(
        'production remote worker dispatch accepts one native task, writes real remote file and CHECKLIST without a tmux context',
      );
      const worker = {
        runId,
        contextId: context.id,
        generation: binding.generation,
        leaseId: binding.leaseId,
      };
      const memoryFile = `native-remote-memory-${randomUUID()}.txt`;
      const memoryCommand = randomUUID();
      rpc('native.session.send', {
        ...target,
        worker,
        commandId: memoryCommand,
        text: `Write ${memoryFile} with the exact token from the first task using conversation memory. Do not read old markers or tasks. End the turn without a terminal signal.`,
      });
      await wait(
        read,
        (snapshot) =>
          snapshot.session.state === 'idle' &&
          snapshot.commands.find((command) => command.commandId === memoryCommand)?.outcome ===
            'completed',
        timeoutMs,
      );
      assert.equal(
        rpc('native.session.workspace.read', { ...pinned(), path: memoryFile }).content.trim(),
        token,
      );
      if (via === 'cancel-generation-race') {
        report.race = await verifyRemoteWorkerCancellationRace({
          runId,
          context,
          binding,
          slotId,
          timeoutMs,
          onRemote,
        });
        report.checks.push(
          'delayed remote RESUME replaces the process before CANCEL; gateway reconciles generation-changed and stops the successor without resending commands',
        );
        report.pass = true;
        const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
        return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
      }
      rpc('run.pause', { runId });
      rpc('native.session.close', { ...target, worker });
      assert.equal(read().session.processStopped, true);
      const resumed = rpc('run.resume', { runId }).run;
      binding = resumed.agentContexts.find(
        (candidate) => candidate.id === context.id,
      ).nativeSession;
      assert.equal(binding.sessionId, first.session.id);
      assert.notEqual(binding.generation, first.session.generation);
      const restored = await wait(
        read,
        (snapshot) =>
          snapshot.session.state === 'idle' &&
          snapshot.commands.length === 3 &&
          snapshot.commands.at(-1).outcome === 'completed',
        timeoutMs,
      );
      assert.equal(restored.session.nativeSessionId, first.session.nativeSessionId);
      assert.equal(restored.session.profileId, nativeProfile?.profileId);
      assert.equal(restored.session.accountContextId, first.session.accountContextId);
      assert.notEqual(restored.session.processPid, first.session.processPid);
      assert.throws(
        () =>
          rpc('native.session.send', {
            ...target,
            worker,
            commandId: randomUUID(),
            text: 'Old generation must not receive input.',
          }),
        /closed, transferred or stale/,
      );
      report.checks.push(
        'remote leased input preserves memory; stopped-worker Resume reopens the exact conversation with one continuation and rejects stale generation',
      );
      if (via === 'retained-handoff' || via === 'retained-handoff-stopped') {
        report.parentRunId = runId;
        selection = await verifyRemoteWorkerHandoff({
          runId,
          context,
          binding,
          slot,
          token,
          timeoutMs,
          markCommand: `node ${remoteRoot}/node/node_modules/@farmslot/agent-runtime/scripts/mark-checklist-step.cjs`,
          stopped: via === 'retained-handoff-stopped',
          recordChild(id) {
            runId = id;
            report.runId = id;
            writeEvidence(report, SCENARIO_ID, report.runner, outDir);
          },
        });
        report.checks.push(
          `${via}: remote successor preserves saved conversation and memory, rotates lease, sends one task and refuses retired-run input`,
        );
      }
    }
    const cancelled = rpc('run.cancel', {
      runId,
      reason: 'Remote native worker validation complete',
    });
    assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
    const closed = read().session;
    assert.equal(closed.processStopped, true);
    assert.ok(
      onRemote(
        `let alive=true;try{process.kill(${closed.processPid},0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e}console.log(JSON.stringify({stopped:!alive}));`,
      ).stopped,
    );
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
    report.checks.push(
      'run cancellation confirms remote process exit and releases the exact fixture slot',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    for (const cleanupId of [...new Set([runId, report.parentRunId].filter(Boolean))]) {
      try {
        const run = rpc('run.get', { runId: cleanupId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status)) {
          const cancelled = rpc('run.cancel', {
            runId: cleanupId,
            reason: 'Remote worker fixture cleanup',
          });
          assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
        } else if (
          run.status === 'failed' &&
          rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId)?.currentRunId ===
            cleanupId
        )
          rpc('slot.release', { slotId, keepWork: true, expectedRunId: cleanupId });
        const ownedContext = rpc('run.get', { runId: cleanupId }).run.agentContexts.find(
          (item) =>
            item.nativeSession?.sessionId === target?.sessionId && !item.nativeSession.releasedAt,
        );
        if (ownedContext?.nativeSession.generation)
          assert.equal(
            rpc(
              'native.session.read',
              pinnedWorkerTarget(cleanupId, ownedContext.id, ownedContext.nativeSession.leaseId),
            ).session.processStopped,
            true,
          );
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `cleanup: ${error.message}`].filter(Boolean).join('; ');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
