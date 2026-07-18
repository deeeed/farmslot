import assert from 'node:assert/strict';
import test from 'node:test';

import { clearLaunchInputWithSessionRecovery } from './launch-clear.js';

test('clear succeeds on the first send and keeps the original target', async () => {
  const commands: string[] = [];
  const target = await clearLaunchInputWithSessionRecovery({
    stage: 'pre-clear',
    runner: 'cursor',
    target: 'ff-2:1',
    session: 'ff-2',
    exec: async (tmuxCommand) => {
      commands.push(tmuxCommand);
      return { exitCode: 0, stdout: '' };
    },
    reensureTarget: async () => {
      throw new Error('must not re-ensure on success');
    },
  });
  assert.equal(target, 'ff-2:1');
  assert.deepEqual(commands, ["send-keys -t 'ff-2:1' C-c C-u"]);
});

test('a lost session is recreated and the clear retried on the fresh target', async () => {
  const commands: string[] = [];
  let reensured = 0;
  const target = await clearLaunchInputWithSessionRecovery({
    stage: 'post-clear',
    runner: 'cursor',
    target: 'ff-2:1',
    session: 'ff-2',
    exec: async (tmuxCommand) => {
      commands.push(tmuxCommand);
      if (tmuxCommand.startsWith('has-session')) {
        return { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
      }
      // First clear fails (session died mid-prelude); retry after recreation succeeds.
      const isRetry = commands.filter((c) => c.startsWith('send-keys')).length > 1;
      return isRetry
        ? { exitCode: 0, stdout: '' }
        : { exitCode: 1, stdout: '', stderr: "can't find session: ff-2" };
    },
    reensureTarget: async () => {
      reensured += 1;
      return 'ff-2:worker';
    },
  });
  assert.equal(target, 'ff-2:worker');
  assert.equal(reensured, 1);
  assert.deepEqual(commands, [
    "send-keys -t 'ff-2:1' C-c C-u",
    "has-session -t 'ff-2' 2>/dev/null",
    "send-keys -t 'ff-2:worker' C-c C-u",
  ]);
});

test('a send failure with the session still alive throws without recreating', async () => {
  let reensured = 0;
  await assert.rejects(
    () =>
      clearLaunchInputWithSessionRecovery({
        stage: 'pre-clear',
        runner: 'grok',
        target: 'ff-2:1',
        session: 'ff-2',
        exec: async (tmuxCommand) =>
          tmuxCommand.startsWith('has-session')
            ? { exitCode: 0, stdout: '' }
            : { exitCode: 1, stdout: '', stderr: 'pane is dead' },
        reensureTarget: async () => {
          reensured += 1;
          return 'ff-2:worker';
        },
      }),
    /Failed to clear grok launch input \(pre-clear\) in ff-2:1: pane is dead/,
  );
  assert.equal(reensured, 0);
});

test('a clear that still fails after session recreation throws with the recreation context', async () => {
  await assert.rejects(
    () =>
      clearLaunchInputWithSessionRecovery({
        stage: 'post-clear',
        runner: 'cursor',
        target: 'ff-2:1',
        session: 'ff-2',
        exec: async (tmuxCommand) =>
          tmuxCommand.startsWith('has-session')
            ? { exitCode: 1, stdout: '' }
            : { exitCode: 1, stdout: '', stderr: 'send failed' },
        reensureTarget: async () => 'ff-2:worker',
      }),
    /Failed to clear cursor launch input \(post-clear\) in ff-2:worker after session recreation: send failed/,
  );
});
