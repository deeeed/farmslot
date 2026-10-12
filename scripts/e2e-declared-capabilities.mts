// Manual extension of the existing native coherence gateway proof, outside CI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FLOW_STEPS, type Run, type RuntimeCapabilityStatusResult } from '@farmslot/protocol';

import { taskInit } from '../packages/agent-runtime/src/task-init/index.js';
import { alive } from '../packages/agent-runtime/src/native/storage.js';

interface Fixture {
  root: string;
  project: string;
  repo: string;
  runId: string;
  slotId: string;
  missingMode: boolean;
}
type WriteJson = (file: string, value: unknown) => void;
type Rpc = <T>(method: string, params: unknown) => T;

// Disposable barrier at a real status read, before the explicit target changes.
if (
  process.env.FARMSLOT_DECLARED_RACE_DIR &&
  process.argv.some((arg) => arg.endsWith(path.join('services', 'gateway', 'src', 'index.ts')))
) {
  const directory = process.env.FARMSLOT_DECLARED_RACE_DIR;
  assert.ok(existsSync(path.join(directory, '.coherence-fixture')));
  writeFileSync(path.join(directory, 'declared-barrier-installed'), String(process.pid));
  const { getRuntimeCapabilityRegistry } =
    await import('../services/gateway/src/methods/runtime-capabilities.js');
  const { getRun } = await import('../services/gateway/src/runs/store.js');
  const registry = getRuntimeCapabilityRegistry();
  const original = registry.status.bind(registry);
  let armedReads = 0;
  registry.status = async (params) => {
    const snapshot = await original(params);
    const configFile = path.join(directory, 'declared-race.json');
    if (!existsSync(configFile)) return snapshot;
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const ready = path.join(directory, 'declared-race-ready');
    if (
      config.armed &&
      params.slotId === config.slotId &&
      getRun(config.runId)?.status === 'dispatching' &&
      !existsSync(ready)
    ) {
      // Retained preparation first locates its plan; the second read freezes
      // the parameters the automatic posture request will carry into its queue.
      if (++armedReads === 1) return snapshot;
      writeFileSync(ready, 'snapshot captured\n');
      const deadline = Date.now() + 60_000;
      while (!existsSync(path.join(directory, 'declared-race-release'))) {
        assert.ok(Date.now() < deadline, 'Retarget proof barrier must be released');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return snapshot;
  };
  // The barrier belongs to this gateway, never its provider or runner children.
  delete process.env.NODE_OPTIONS;
}

export async function prepareDeclaredCapabilityProof(input: Fixture & { writeJson: WriteJson }) {
  const { root, project, repo, runId, slotId, missingMode, writeJson } = input;
  const projectDir = path.join(root, 'projects', project);
  const configFile = path.join(projectDir, 'project.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // The existing minimize policy sheds high-cost providers at an operator wait.
  config.runtime_capabilities.providers['owned-server'].cost.class = 'high';
  config.runtime_capabilities.providers['owned-server'].keep_warm_ms = 0;
  config.runtime_capabilities.providers['owned-server'].parameters = {
    type: 'object',
    properties: { label: { type: 'string' } },
    additionalProperties: false,
  };
  config.runtime_capabilities.providers['refused-service'] = {
    label: 'Refused proof service',
    version: '1',
    share_policy: 'exclusive',
    cost: { class: 'low', resources: [] },
    release_effects: [],
    actions: Object.fromEntries(
      ['acquire', 'health', 'release'].map((action) => {
        const id = `refused-service-${action}`;
        config.slot_actions[id] = { label: id, command: action === 'release' ? 'true' : 'exit 1' };
        return [action, { kind: 'slot-action', action_id: id }];
      }),
    ),
  };
  const templates = path.join(projectDir, 'declared-templates');
  mkdirSync(path.join(templates, 'dev'), { recursive: true });
  writeFileSync(
    path.join(templates, 'dev/declared-runtime.md'),
    '---\nid: dev/declared-runtime\nflow: dev\nplatforms: [cli]\ndescription: Declared runtime proof\nruntime_capabilities: [owned-server]\n---\n# Declared runtime\n- [ ] Inspect the owned service.\n',
  );
  config.execution_templates = {
    sources: [
      {
        id: 'declared-proof',
        kind: 'workspace',
        root: { projectPath: 'declared-templates' },
        layout: 'flow-tree',
      },
    ],
    defaults: [
      {
        when: { flow: 'dev', platform: 'cli', runMode: 'interactive' },
        templateId: 'dev/declared-runtime',
      },
    ],
  };
  writeJson(configFile, config);
  const taskDir = path.join(projectDir, 'tasks/dev/COHERENCE-23');
  const initialized = await taskInit({
    taskDir,
    flow: 'dev',
    runMode: 'interactive',
    platform: 'cli',
    template: {
      sources: [{ id: 'declared-proof', kind: 'workspace', root: templates, layout: 'flow-tree' }],
      explicitId: 'dev/declared-runtime',
    },
    task: { title: 'Declared service acquisition', sourceKind: 'text', ticket: 'COHERENCE-23' },
    handoff: { surface: 'fixture', project, repo },
  });
  const now = new Date().toISOString();
  writeJson(path.join(root, '.runs', `${runId}.json`), {
    id: runId,
    project,
    ticketOrPr: 'COHERENCE-23',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'native',
    nativeOwnerPrincipalId: 'legacy-env',
    safetyTier: 'full-auto',
    status: 'blocked',
    slotId,
    taskFile: path.join(taskDir, 'TASK.md'),
    createdAt: now,
    updatedAt: now,
    decisions: [],
    agentContexts: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    executionTemplate: initialized.executionTemplate,
    engineState: { generation: 0, flags: { skipPrepare: true } },
    steps: FLOW_STEPS.dev.map((name, index) => ({
      name,
      status:
        name === 'dispatch'
          ? 'failed'
          : index < FLOW_STEPS.dev.indexOf('dispatch')
            ? 'done'
            : 'pending',
    })),
  });
  // Explicitly authored existing proof-plan data supplies mode, with no pre-held
  // lease. Goal3 owns the missing first-dispatch declaration front door.
  writeJson(path.join(root, '.runs/capabilities.json'), {
    version: 1,
    leases: [],
    events: [],
    proofPlans: missingMode
      ? {}
      : {
          [runId]: {
            version: 1,
            ownerRunId: runId,
            slotId,
            createdAt: now,
            requirements: [
              { capabilityId: 'owned-server', mode: 'state', reason: 'Authored service proof' },
            ],
          },
        },
  });
  return input;
}

export async function proveDeclaredCapabilityAcquisition(
  input: Fixture & {
    rpc: Rpc;
    wait: <T>(read: () => T, predicate: (value: T) => boolean, label: string) => Promise<T>;
    restartGateway: () => Promise<void>;
    check: (description: string) => void;
    outDir: string;
    sourceRoot: string;
    raceDir: string;
    writeJson: WriteJson;
  },
) {
  const {
    rpc,
    wait,
    restartGateway,
    check,
    root,
    runId,
    slotId,
    repo,
    missingMode,
    outDir,
    sourceRoot,
    raceDir,
    writeJson,
  } = input;
  assert.ok(
    existsSync(path.join(raceDir, 'declared-barrier-installed')),
    'Gateway retarget barrier must be installed',
  );
  const get = () => rpc<{ run: Run }>('run.get', { runId }).run;
  const status = () => rpc<RuntimeCapabilityStatusResult>('runtime.capability.status', { slotId });
  const before = status();
  assert.equal(before.leases.length, 0, 'No operator lease may precede declared dispatch');
  rpc('run.replayStep', { runId, stepName: 'dispatch' });
  if (missingMode) {
    const blocked = await wait(
      get,
      (run) => {
        assert.equal(
          run.agentContexts?.some((context) => context.nativeSession),
          false,
          'Missing authored mode must refuse before native delivery',
        );
        return Boolean(run.error?.includes('authored proof mode'));
      },
      'missing authored mode refusal',
    );
    assert.match(JSON.stringify(blocked), /authored proof mode/);
    assert.equal(status().leases.length, 0);
    assert.equal(existsSync(path.join(repo, 'owned-server.pid')), false);
    assert.equal(
      blocked.agentContexts?.some((context) => context.nativeSession),
      false,
    );
    check('missing initial proof mode refuses before provider and worker effects');
  } else {
    const launched = await wait(
      get,
      (run) => {
        assert.equal(run.error ?? null, null, run.error ?? 'Declared preparation must pass');
        assert.notEqual(run.status, 'failed', run.error);
        assert.notEqual(run.status, 'blocked', run.error);
        return Boolean(run.agentContexts?.some((context) => context.nativeSession?.acceptedAt));
      },
      'declared provider acquired before native peer delivery',
    );
    const held = status().leases.find(
      (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
    );
    assert.ok(held, 'Declared dispatch must acquire the provider without an operator lease');
    assert.equal(held.owner.runId, runId);
    assert.equal(held.health.state, 'healthy');
    const pid = Number(readFileSync(path.join(repo, 'owned-server.pid'), 'utf8'));
    assert.ok(held.providerProcesses?.some((frame) => frame.pid === pid));
    const url = () =>
      `http://127.0.0.1:${readFileSync(path.join(repo, 'owned-server.pid.port'), 'utf8')}`;
    assert.equal(await (await fetch(url())).text(), 'coherence-server');
    check('real owned HTTP provider is healthy at declared worker delivery');
    writeFileSync(
      path.join(root, 'projects', input.project, 'declared-templates/dev/declared-runtime.md'),
      '---\nid: dev/declared-runtime\nflow: dev\nplatforms: [cli]\nruntime_capabilities: [refused-service]\n---\nUpdated pack template\n',
    );
    const stopped = rpc<{ ok: boolean }>('runtime.posture.apply', {
      runId,
      posture: 'operator-wait',
      gateChoice: 'minimize',
    });
    assert.equal(stopped.ok, true);
    assert.equal(status().leases.find((lease) => lease.id === held.id)?.state, 'released');
    await wait(
      () => alive(pid),
      (running) => !running,
      'released provider really stops',
    );
    check('existing operator wait releases the declared provider');
    const refused = rpc<{ ok: boolean }>('runtime.posture.apply', {
      runId,
      posture: 'active',
      proofRequirements: [
        { capabilityId: 'owned-server', mode: 'state', reason: 'Authored service proof' },
        { capabilityId: 'refused-service', mode: 'state', reason: 'Controlled provider refusal' },
      ],
    });
    assert.equal(refused.ok, false);
    assert.equal(
      status().leases.some(
        (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
      ),
      false,
      'A later provider refusal must roll back the newly acquired HTTP provider',
    );
    const rolledBackPid = Number(readFileSync(path.join(repo, 'owned-server.pid.created'), 'utf8'));
    await wait(
      () => alive(rolledBackPid),
      (running) => !running,
      'partial acquire rollback really stops provider',
    );
    check('later provider refusal rolls back the real newly acquired service');
    rpc('run.replayStep', { runId, stepName: 'dispatch' });
    await wait(
      () => {
        const value = status();
        const run = get();
        assert.notEqual(
          run.status,
          'failed',
          'Retained dispatch must ignore later live-template drift',
        );
        if (run.steps.find((step) => step.name === 'dispatch')?.status === 'done')
          assert.ok(
            value.leases.some(
              (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
            ),
            'Retained native replay must reacquire its declared provider before completing dispatch',
          );
        return value;
      },
      (value) =>
        value.leases.some(
          (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
        ),
      'declared provider reacquisition',
    );
    const reacquired = status().leases.find(
      (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
    )!;
    assert.notEqual(reacquired.id, held.id);
    const reacquiredPid = Number(readFileSync(path.join(repo, 'owned-server.pid'), 'utf8'));
    assert.equal(await (await fetch(url())).text(), 'coherence-server');
    check('replayed dispatch reacquires the same declared provider through existing posture');
    check('retained dispatch uses the authored task snapshot after a live template edit');
    await restartGateway();
    const recovered = status().leases.find((lease) => lease.id === reacquired.id);
    assert.equal(recovered?.state, 'acquired');
    assert.equal(recovered?.health.state, 'healthy');
    assert.equal(Number(readFileSync(path.join(repo, 'owned-server.pid'), 'utf8')), reacquiredPid);
    assert.equal(await (await fetch(url())).text(), 'coherence-server');
    check('gateway restart reconciles the same owned provider without a second acquisition');
    writeJson(path.join(raceDir, 'declared-race.json'), { armed: true, runId, slotId });
    rpc('run.replayStep', { runId, stepName: 'dispatch' });
    await wait(
      () => existsSync(path.join(raceDir, 'declared-race-ready')),
      Boolean,
      'automatic preparation captured its starting parameters',
    );
    writeJson(path.join(raceDir, 'declared-race.json'), { armed: false, runId, slotId });
    assert.equal(
      rpc<{ ok: boolean }>('runtime.posture.apply', {
        runId,
        posture: 'active',
        proofRequirements: [
          {
            capabilityId: 'owned-server',
            mode: 'state',
            reason: 'Explicit retarget',
            parameters: { label: 'target-b' },
          },
        ],
      }).ok,
      true,
    );
    const target = status().leases.find(
      (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
    )!;
    const targetPid = Number(readFileSync(path.join(repo, 'owned-server.pid'), 'utf8'));
    writeFileSync(path.join(raceDir, 'declared-race-release'), 'explicit retarget completed\n');
    await wait(
      get,
      (run) => {
        if (run.steps.find((step) => step.name === 'dispatch')?.status === 'done')
          assert.equal(
            status().leases.find(
              (lease) => lease.capabilityId === 'owned-server' && lease.state === 'acquired',
            )?.id,
            target.id,
            'A concurrent explicit retarget must survive stale automatic delivery',
          );
        return Boolean(run.error?.includes('different frozen acquire parameters'));
      },
      'stale automatic delivery refuses after explicit retarget',
    );
    assert.equal(status().leases.find((lease) => lease.id === target.id)?.state, 'acquired');
    assert.equal(Number(readFileSync(path.join(repo, 'owned-server.pid'), 'utf8')), targetPid);
    assert.equal(await (await fetch(url())).text(), 'coherence-server');
    check(
      'stale automatic delivery refuses while the explicit target lease and real provider survive',
    );
    writeJson(path.join(outDir, 'declared-run.json'), launched);
  }
  const files = [
    'services/gateway/src/methods/dispatch/execute.ts',
    'services/gateway/src/run-engine/declared-capabilities.ts',
    'services/gateway/src/runtime-capabilities/registry.ts',
    'services/gateway/src/runtime-capabilities/posture.ts',
    'services/gateway/src/methods/runtime-posture.ts',
    'services/gateway/src/run-engine/resource-posture.ts',
    'services/gateway/src/run-engine/dispatch-lifecycle-steps.ts',
    'services/gateway/src/review/orchestrator.ts',
    'scripts/runner-validation/gateway/native-run-coherence.mjs',
    'scripts/e2e-declared-capabilities.mts',
  ];
  writeJson(path.join(outDir, 'declared-capabilities-receipt.json'), {
    passed: true,
    runId,
    slotId,
    missingMode,
    scope:
      'Real gateway, provider hooks, kernel ownership and HTTP service; synthetic native protocol peer. No application or model execution claim. Authored existing proof plan, no operator lease. Headless service has no visual/HUD claim.',
    hashes: Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(sourceRoot, file)))
          .digest('hex'),
      ]),
    ),
  });
  rpc('run.cancel', { runId });
}
