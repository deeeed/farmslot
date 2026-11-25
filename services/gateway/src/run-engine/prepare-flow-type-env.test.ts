// A prepare's hooks see FARMSLOT_FLOW_TYPE beside FARMSLOT_PREPARE_PROFILE, so a pack can set up
// a runtime for a dev run without doing it for a review of the same domain. A flowless prepare
// unsets it, so a value inherited from the gateway's environment never leaks in.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ExecResult } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

// A private copy of the tracked farmslot-farm pack, with an unlock hook so that phase is covered too,
// whatever the caller's environment points at.
const projects = mkdtempSync(path.join(os.tmpdir(), 'prepare-flow-env-projects-'));
after(() => rmSync(projects, { recursive: true, force: true }));
cpSync(
  fileURLToPath(new URL('../../../../projects/farmslot-farm', import.meta.url)),
  path.join(projects, 'farmslot-farm'),
  {
    recursive: true,
  },
);
const packJson = path.join(projects, 'farmslot-farm/project.json');
const pack = JSON.parse(readFileSync(packJson, 'utf8'));
writeFileSync(
  packJson,
  JSON.stringify({ ...pack, hooks: { ...pack.hooks, unlock: 'unlock-slot' } }, null, 2),
);
process.env.FARMSLOT_PROJECTS_DIR = projects;

// Health and unlock commands reach verifyPrepareHealth, not runPrepareCommand.
const healthCommands: string[] = [];
const realHealth = await import('../methods/slot/prepare-health.js');
mock.module('../methods/slot/prepare-health.js', {
  namedExports: {
    ...realHealth,
    verifyPrepareHealth: async (_vars: unknown, commands: { health: string; unlock: string }) => {
      healthCommands.push(commands.health);
      if (commands.unlock) healthCommands.push(commands.unlock);
      return 'OK';
    },
  },
});
const { mockPrepareCommand, needsTmuxSandbox, slotPrepare, stackFixture } =
  await import('./stack-base-prepare.test-support.js');

async function preparedHooks(t: import('node:test').TestContext, label: string, flowType?: string) {
  const { slotId } = await stackFixture(t, `flow-env-${label}`, 48818);
  const commands: string[] = [];
  mockPrepareCommand(t, async (_vars, _logPath, command): Promise<ExecResult> => {
    commands.push(command);
    return { stdout: 'ok\n', stderr: '', exitCode: 0 };
  });
  healthCommands.length = 0;
  const result = await slotPrepare(
    { slotId, branch: 'main', prepareProfile: 'typecheck', ...(flowType ? { flowType } : {}) },
    () => {},
  );
  assert.equal(result.prepared, true);
  const hooks = {
    deps: commands.filter((command) => command.includes('yarn install')),
    preflight: commands.filter((command) => command.includes('yarn typecheck')),
    health: healthCommands.filter((command) => !command.includes('unlock-slot')),
    unlock: healthCommands.filter((command) => command.includes('unlock-slot')),
  };
  for (const [phase, ran] of Object.entries(hooks)) assert.ok(ran.length > 0, `${phase} ran`);
  return Object.values(hooks).flat();
}

for (const flowType of ['dev', 'review-pr']) {
  test(
    `a ${flowType} prepare's deps, preflight, health and unlock hooks see FARMSLOT_FLOW_TYPE=${flowType}`,
    needsTmuxSandbox,
    async (t) => {
      for (const command of await preparedHooks(t, flowType, flowType))
        assert.match(command, new RegExp(`export FARMSLOT_FLOW_TYPE='${flowType}'`));
    },
  );
}

test('a flowless prepare unsets FARMSLOT_FLOW_TYPE for its hooks', needsTmuxSandbox, async (t) => {
  for (const command of await preparedHooks(t, 'none')) {
    assert.match(command, /unset FARMSLOT_FLOW_TYPE/);
    assert.doesNotMatch(command, /export FARMSLOT_FLOW_TYPE/);
  }
});
