// Manual proof: real private registry leases and provider hooks, without workers or active slots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeCapabilityProofMode } from '@farmslot/protocol';

interface InitialProofObservation {
  runId: string;
  mode: RuntimeCapabilityProofMode;
  leaseId: string;
  noPriorPlan: boolean;
  markerObserved: boolean;
}

const source = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-proof-mode-'));
const checkout = path.join(scratch, 'checkout');
const tmuxDir = fs.mkdtempSync('/tmp/fs-proof-tmux-');
process.env.TMUX_TMPDIR = tmuxDir;
delete process.env.TMUX;
const project = path.join(scratch, 'projects', 'proof-project');
fs.mkdirSync(checkout, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(scratch, 'pool'));
for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  const target = path.join(scratch, marker);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, marker), target);
}
Object.assign(process.env, {
  FARMSLOT_ROOT: scratch,
  FARMSLOT_PROJECTS_DIR: path.join(scratch, 'projects'),
  FARMSLOT_POOL_DIR: path.join(scratch, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(scratch, '.runs'),
});
fs.writeFileSync(
  path.join(project, 'project.json'),
  JSON.stringify({
    name: 'proof-project',
    slot_actions: {
      acquire: {
        label: 'Acquire owned marker',
        command: 'printf acquired > .owned-proof-resource',
      },
      health: { label: 'Observe owned marker', command: 'test -f .owned-proof-resource' },
      release: { label: 'Release owned marker', command: 'rm -f .owned-proof-resource' },
    },
    runtime_capabilities: {
      providers: {
        'owned-marker': {
          label: 'Owned marker',
          version: '1',
          share_policy: 'exclusive',
          cost: { class: 'low', resources: [] },
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          actions: {
            acquire: { kind: 'slot-action', action_id: 'acquire' },
            health: { kind: 'slot-action', action_id: 'health' },
            release: { kind: 'slot-action', action_id: 'release' },
          },
          affected_resources: [],
          release_effects: ['Remove the owned marker'],
        },
      },
    },
  }),
);
fs.writeFileSync(
  path.join(scratch, 'pool', 'proof-machine.json'),
  JSON.stringify({
    machine: 'proof-machine',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [
      {
        id: 'proof-slot',
        session: 'proof-session',
        project: 'proof-project',
        platform: 'cli',
        repo: checkout,
      },
    ],
  }),
);
const { recipeFlowRequirements } =
  await import('../../../packages/protocol/src/contracts/recipe-conformance.js');
const { createRun, persistRunNow } = await import('../../../services/gateway/src/runs/store.js');
const { prepareDeclaredRunCapabilities } =
  await import('../../../services/gateway/src/run-engine/declared-capabilities.js');
const { runtimeCapabilityStatus, runtimeCapabilityRelease } =
  await import('../../../services/gateway/src/methods/runtime-capabilities.js');
const observations: InitialProofObservation[] = [];
for (const mode of ['state', 'visual', 'mixed'] as const) {
  const run = createRun({
    project: 'proof-project',
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'Initial proof requirement validation',
    slotId: 'proof-slot',
    transport: 'tmux',
  });
  await persistRunNow(run);
  try {
    const before = await runtimeCapabilityStatus({ slotId: 'proof-slot' });
    assert.equal(before.proofPlans[run.id], undefined);
    const refused = await prepareDeclaredRunCapabilities(run.id, ['owned-marker']);
    assert.equal(refused.ok, false);
    assert.equal(fs.existsSync(path.join(checkout, '.owned-proof-resource')), false);
    const declared = recipeFlowRequirements({
      runtime_capabilities: ['owned-marker'],
      runtime_capability_requirements: JSON.stringify([
        {
          capabilityId: 'owned-marker',
          mode,
          reason: 'Observe initial owned provider acquisition',
        },
      ]),
    });
    const acquired = await prepareDeclaredRunCapabilities(
      run.id,
      declared.resources,
      undefined,
      declared.proofRequirements,
    );
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    assert.equal(fs.readFileSync(path.join(checkout, '.owned-proof-resource'), 'utf8'), 'acquired');
    const after = await runtimeCapabilityStatus({ slotId: 'proof-slot' });
    const lease = after.leases.find(
      (item) => item.owner.runId === run.id && item.state === 'acquired',
    );
    assert.ok(lease);
    assert.equal(after.proofPlans[run.id].requirements[0].mode, mode);
    observations.push({
      runId: run.id,
      mode,
      leaseId: lease.id,
      noPriorPlan: true,
      markerObserved: true,
    });
  } finally {
    const released = await runtimeCapabilityRelease({
      slotId: 'proof-slot',
      ownerRunId: run.id,
      keepWarm: false,
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(fs.existsSync(path.join(checkout, '.owned-proof-resource')), false);
  }
}
assert.equal(fs.existsSync(path.join(tmuxDir, `tmux-${process.getuid?.()}/default`)), false);
console.log(
  'INITIAL_PROOF_MODE_PASS ' +
    JSON.stringify({
      scratch,
      observations,
      cleanup: 'All provider resources released; isolated records retained',
    }),
);
