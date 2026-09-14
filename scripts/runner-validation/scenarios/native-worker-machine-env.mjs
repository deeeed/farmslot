import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, shSingleQuote } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-machine-env';

const trustNames = [
  'FARMSLOT_RECIPE_SOURCE_TRUST',
  'FARMSLOT_RECIPE_SOURCE_KIND',
  'FARMSLOT_RECIPE_SOURCE_NAME',
  'FARMSLOT_RECIPE_SOURCE_DIGEST',
  'FARMSLOT_RECIPE_APPROVE_PLAN',
];
const controlPlaneNames = [
  'FARMSLOT_NODE_TOKEN',
  'FARMSLOT_GATEWAY_TOKEN',
  'FARMSLOT_GATEWAY_PASSWORD',
];

function privatePath(value, root) {
  const resolved = fs.realpathSync(value);
  assert.ok(resolved.startsWith(root + path.sep), `Fixture path must be private: ${value}`);
  return resolved;
}

/** Explicit local fixture only. Pool/project directories must match the private gateway's config. */
export async function runScenario({ runnerAdapter, slotId, model, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  if (!slotId && !explicit)
    return { scenario: SCENARIO_ID, runner: report.runner, pass: true, skipped: true };
  const saved = [];
  let runId;
  let context;
  let binding;
  let configChanged = false;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(slotId?.startsWith('native-worker-'), 'Pass --slot native-worker-* explicitly');
    assert.ok(['codex', 'claude'].includes(report.runner));
    const root = fs.realpathSync(path.join(ROOT, 'temp/native-validation'));
    const poolDir = privatePath(process.env.FARMSLOT_POOL_DIR ?? path.join(root, 'pool'), root);
    const projectsDir = privatePath(
      process.env.FARMSLOT_PROJECTS_DIR ?? path.join(root, 'projects'),
      root,
    );
    const fleet = rpc('fleet.status').fleet;
    const slot = fleet.slots.find((item) => item.slot === slotId);
    assert.ok(slot?.project?.startsWith('native-worker-'), 'Use a private worker project');
    assert.equal(slot.currentRunId, null, 'Fixture slot is already owned');
    const cwd = privatePath(slot.repo, root);
    const matches = fs
      .readdirSync(poolDir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const file = privatePath(path.join(poolDir, name), root);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data.slots?.some((item) => item.id === slotId) ? [{ file, data }] : [];
      });
    assert.equal(matches.length, 1, 'Fixture slot must resolve to one private pool file');
    const pool = matches[0];
    assert.ok(
      ['localhost', '127.0.0.1', '::1'].includes(pool.data.host),
      'Use a local fixture pool',
    );
    assert.equal(pool.data.project, slot.project);
    assert.equal(pool.data.machine, slot.machine);
    assert.equal(privatePath(pool.data.slots.find((item) => item.id === slotId).repo, root), cwd);
    for (const item of pool.data.slots) {
      assert.ok(
        item.id.startsWith('native-worker-'),
        'Pool env must affect private fixture slots only',
      );
      privatePath(item.repo, root);
      assert.ok(!fleet.slots.find((entry) => entry.slot === item.id)?.currentRunId);
    }
    for (const item of fleet.slots.filter((item) => item.project === slot.project)) {
      privatePath(item.repo, root);
      assert.ok(!item.currentRunId, 'Project env must not change an active worker');
    }
    const projectFile = privatePath(path.join(projectsDir, slot.project, 'project.json'), root);
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    assert.equal(project.name, slot.project);
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });

    const suffix = randomUUID().replaceAll('-', '').toUpperCase();
    const names = {
      poolOnly: `FARMSLOT_ENV_PROOF_POOL_${suffix}`,
      setConflict: `FARMSLOT_ENV_PROOF_SET_${suffix}`,
      unsetConflict: `FARMSLOT_ENV_PROOF_UNSET_${suffix}`,
      projectOnly: `FARMSLOT_ENV_PROOF_PROJECT_${suffix}`,
    };
    const expected = Object.fromEntries(Object.values(names).map((name) => [name, randomUUID()]));
    const spoof = Object.fromEntries(
      trustNames.map((name) => [name, `fixture-spoof-${randomUUID()}`]),
    );
    const credentials = Object.fromEntries(
      controlPlaneNames.map((name) => [name, `fixture-control-plane-${randomUUID()}`]),
    );
    for (const file of [pool.file, projectFile]) saved.push({ file, bytes: fs.readFileSync(file) });
    const projectEnv = project.command_env ?? {};
    project.command_env = {
      ...projectEnv,
      unset: [...new Set([...(projectEnv.unset ?? []), names.unsetConflict])],
      set: {
        ...projectEnv.set,
        [names.setConflict]: `project-loses-${randomUUID()}`,
        [names.projectOnly]: expected[names.projectOnly],
        ...spoof,
        ...credentials,
      },
    };
    pool.data.env = {
      ...pool.data.env,
      [names.poolOnly]: expected[names.poolOnly],
      [names.setConflict]: expected[names.setConflict],
      [names.unsetConflict]: expected[names.unsetConflict],
      ...spoof,
      ...credentials,
    };
    configChanged = true;
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');
    fs.writeFileSync(pool.file, JSON.stringify(pool.data, null, 2) + '\n');
    rpc('fleet.refresh');
    // Dispatch reads loadProjectVars' five-second cache. Let an earlier fleet
    // read expire before launching with the changed fixture configuration.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const nonce = randomUUID();
    const marker = `native-machine-env-${nonce}.json`;
    const markerPath = path.join(cwd, marker);
    assert.equal(fs.existsSync(markerPath), false);
    const keys = [...Object.values(names), ...trustNames];
    // The task knows only names and the script, never the configured expected values.
    const script = `const fs=require('node:fs');const keys=${JSON.stringify(keys)};const controlPlane=${JSON.stringify(controlPlaneNames)};fs.writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,values:Object.fromEntries(keys.map(key=>[key,process.env[key]??null])),controlPlanePresent:Object.fromEntries(controlPlane.map(key=>[key,Object.hasOwn(process.env,key)]))}),{flag:'wx',mode:0o600});`;
    let taskDir = path.dirname(projectFile);
    for (const directory of ['tasks', 'dev', `NATIVE-ENV-${nonce}`]) {
      taskDir = path.join(taskDir, directory);
      if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir);
      taskDir = privatePath(taskDir, root);
    }
    const taskFile = path.join(taskDir, 'TASK.md');
    await writeNativeFixtureTask(
      taskFile,
      '# Worker: dev\n\n## Checklist\n\n' +
        '- [ ] Execute the exact command below once using your shell tool.\n' +
        '- [ ] Mark both checklist steps after the command succeeds.\n\n' +
        `\`\`\`sh\nnode -e ${shSingleQuote(script)}\n\`\`\`\n\n` +
        'Do not prefix the command with environment assignments, unset variables, or substitute values. ' +
        'Do not read pool/project configuration or create the output with another command. ' +
        'End the turn without a terminal signal. Do not commit, publish, contact services, or change other files.\n',
      slot.project,
    );
    const created = rpc('run.createNative', {
      flowType: 'dev',
      project: slot.project,
      ticketOrPr: `NATIVE-ENV-${nonce}`,
      slotId,
      allowedSlots: [slotId],
      taskFile,
      runner: report.runner,
      ...(model ? { model } : {}),
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
    });
    runId = created.run.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const run = await wait(
      () => rpc('run.get', { runId }).run,
      (run) => {
        assert.ok(!['failed', 'blocked', 'cancelled'].includes(run.status), run.error);
        return run.agentContexts?.some((item) => item.nativeSession?.acceptedAt);
      },
      timeoutMs,
    );
    context = run.agentContexts.find((item) => item.nativeSession?.acceptedAt);
    binding = context.nativeSession;
    assert.equal(binding.executionNodeId, 'local');
    const snapshot = await wait(
      () => rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId)),
      (snapshot) => {
        const receipt = snapshot.commands.find((item) => item.commandId === binding.commandId);
        assert.ok(receipt?.state !== 'failed', 'Environment probe task failed');
        return (
          receipt?.accepted && receipt.outcome === 'completed' && snapshot.session.state === 'idle'
        );
      },
      timeoutMs,
    );
    const taskRoot = path.resolve(cwd, path.dirname(context.taskFile));
    privatePath(taskRoot, root);
    assert.equal(
      fs.existsSync(path.join(taskRoot, 'inputs/inherited/recipe-source.json')),
      false,
      'This probe expects an ordinary task without inherited recipe provenance',
    );
    assert.ok(fs.lstatSync(markerPath).isFile() && !fs.lstatSync(markerPath).isSymbolicLink());
    assert.ok(fs.statSync(markerPath).size < 32_000);
    const observed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(observed.nonce, nonce);
    assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
    assert.equal(
      observed.values[names.projectOnly],
      expected[names.projectOnly],
      'Project-only control must survive independently of machine environment forwarding',
    );
    assert.deepEqual(observed.values, {
      ...expected,
      ...Object.fromEntries(trustNames.map((name) => [name, null])),
    });
    assert.deepEqual(
      observed.controlPlanePresent,
      Object.fromEntries(controlPlaneNames.map((name) => [name, false])),
      'Native worker tools must not inherit configured control-plane credentials',
    );
    report.environment = observed;
    report.command = snapshot.commands.find((item) => item.commandId === binding.commandId);
    report.checks.push(
      'real worker tool inherits pool env; pool overrides project set and unset while project-only values survive',
      'ordinary task clears spoofed recipe trust, kind, name, digest and plan-approval values',
      'real worker tool lacks synthetic node token, gateway token and gateway password overrides',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (runId) {
      try {
        const cancelled = rpc('run.cancel', {
          runId,
          reason: 'Native machine environment fixture complete',
        });
        assert.ok(
          cancelled.effects.every((effect) => effect.status !== 'failed'),
          JSON.stringify(cancelled.effects),
        );
        if (binding)
          assert.equal(
            rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId))
              .session.processStopped,
            true,
          );
        assert.equal(
          rpc('fleet.status').fleet.slots.find((item) => item.slot === slotId).currentRunId,
          null,
        );
        report.checks.push(
          'exact fixture run cancellation confirms process cleanup and slot release',
        );
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `cleanup: ${error.message}`].filter(Boolean).join('; ');
      }
    }
    for (const entry of saved.reverse()) {
      try {
        fs.writeFileSync(entry.file, entry.bytes);
        assert.deepEqual(fs.readFileSync(entry.file), entry.bytes);
        report.checks.push(`restored ${path.basename(entry.file)} byte-for-byte`);
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `restore ${entry.file}: ${error.message}`]
          .filter(Boolean)
          .join('; ');
      }
    }
    if (configChanged) {
      try {
        rpc('fleet.refresh');
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `refresh restored config: ${error.message}`]
          .filter(Boolean)
          .join('; ');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
