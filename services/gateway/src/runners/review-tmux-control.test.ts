import assert from 'node:assert/strict';
import path from 'node:path';
import { mock, test } from 'node:test';
import vm from 'node:vm';

await import('../runtime/mock-pty.test-support.js');
const exec = await import('../core/exec.js');
const written = new Map<string, string>();
let frozenRuntime: string | undefined;
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execFileArgv: async (argv: string[]) => {
      assert.equal(argv[1], '-e');
      let stdout = '';
      const process = {
        execPath: argv[0],
        argv: [argv[0], ...argv.slice(3)],
        stdout: {
          write: (value: string) => {
            stdout += value;
          },
        },
        stderr: {
          write: (value: string) => {
            throw new Error(value);
          },
        },
      };
      vm.runInNewContext(argv[2], {
        process,
        require: (name: string) => {
          assert.equal(name, 'node:module');
          return {
            createRequire: (file: string) => {
              frozenRuntime = file;
              // The retained helper itself has no resume support. Only its dependencies are used.
              return (dependency: string) => {
                if (dependency === 'node:fs')
                  return {
                    existsSync: () => false,
                    writeFileSync: (file: string, value: string) => written.set(file, value),
                  };
                if (dependency === 'node:path') return path;
                if (dependency === 'node:child_process')
                  return {
                    spawnSync: (command: string, args: string[]) => {
                      assert.equal(command, 'tmux');
                      assert.equal(args[0], 'has-session');
                      return { status: 1, stdout: '', stderr: '' };
                    },
                  };
                if (dependency === './review-filesystem.cjs')
                  return {
                    sandbox: () => {
                      throw new Error('No reviewer launch');
                    },
                  };
                if (dependency === './review-codex-folder-access.cjs') return {};
                throw new Error(`Unexpected dependency ${dependency}`);
              };
            },
          };
        },
      });
      assert.deepEqual(JSON.parse(stdout), { stopped: true });
      return { stdout, stderr: '', exitCode: 0 };
    },
  },
});
const owner = await import('../security/native-worker-owner.js');
mock.module('../security/native-worker-owner.js', {
  namedExports: { ...owner, assertNativeRunOwner: () => {} },
});
const { makeRun } = await import('../run-completion/test-fixtures.js');
const { reviewTmuxOperation } = await import('./review-tmux.js');

test('gateway control fences a continuation even when the retained task runtime predates resume', async () => {
  const run = makeRun();
  run.transport = 'tmux';
  run.nativeOwnerPrincipalId = 'owner';
  run.reviewWorkspace = {
    workspaceId: 'old-workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/retained/source',
    taskPath: '/retained/task',
    artifactPath: '/retained/task/artifacts',
  };
  run.steps = [
    {
      name: 'dispatch',
      status: 'running',
      outputs: { retainedReviewResume: { commandId: 'pending-resume' } },
    },
  ];
  await reviewTmuxOperation(run, 'stop');
  assert.equal(
    frozenRuntime,
    '/retained/task/inputs/runtime/node_modules/@farmslot/agent-runtime/scripts/review-terminal.cjs',
  );
  assert.equal(written.get('/retained/task/.terminal-cancelled-pending-resume'), run.id);
  assert.equal(written.get('/retained/task/.terminal-cancelled'), run.id);
});
