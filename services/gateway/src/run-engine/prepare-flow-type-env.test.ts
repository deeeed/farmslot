// A prepare's hooks see FARMSLOT_FLOW_TYPE beside FARMSLOT_PREPARE_PROFILE, so a pack can set up
// a runtime for a dev run without doing it for a review of the same domain. A flowless prepare
// unsets it, so a value inherited from the gateway's environment never leaks in.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ExecResult } from '@farmslot/protocol';

import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

// The fixture reads the tracked farmslot-farm pack, whatever the caller's environment points at.
process.env.FARMSLOT_PROJECTS_DIR = fileURLToPath(new URL('../../../../projects', import.meta.url));
process.env.FARMSLOT_FLOW_TYPE = 'inherited-from-the-gateway';

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
const { mockPrepareCommand, needsTmuxSandbox, slotPrepare, stackFixture } = await import(
  './stack-base-prepare.test-support.js'
);

test('prepare hooks see the flow type of the prepare, and none without one', needsTmuxSandbox, async (t) => {
  const { slotId } = await stackFixture(t, 'flow-env', 48818);
  const commands: string[] = [];
  mockPrepareCommand(t, async (_vars, _logPath, command): Promise<ExecResult> => {
    commands.push(command);
    return { stdout: 'ok\n', stderr: '', exitCode: 0 };
  });
  const prepare = async (flowType?: string) => {
    commands.length = 0;
    healthCommands.length = 0;
    const started = Date.now();
    const result = await slotPrepare(
      { slotId, branch: 'main', prepareProfile: 'typecheck', ...(flowType ? { flowType } : {}) },
      () => {},
    );
    assert.equal(result.prepared, true);
    const hooks = {
      deps: commands.filter((command) => command.includes('yarn install')),
      preflight: commands.filter((command) => command.includes('yarn typecheck')),
      health: [...healthCommands],
    };
    for (const [phase, ran] of Object.entries(hooks)) assert.ok(ran.length > 0, `${phase} ran`);
    t.diagnostic(`prepare ${flowType ?? '(no flow)'} took ${Date.now() - started} ms`);
    return Object.values(hooks).flat();
  };

  for (const flowType of ['dev', 'review-pr']) {
    for (const command of await prepare(flowType))
      assert.match(command, new RegExp(`export FARMSLOT_FLOW_TYPE='${flowType}'`));
  }
  for (const command of await prepare()) {
    assert.match(command, /unset FARMSLOT_FLOW_TYPE/);
    assert.doesNotMatch(command, /export FARMSLOT_FLOW_TYPE/);
  }
});

