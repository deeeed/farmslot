import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const script = fileURLToPath(new URL('../../scripts/review-terminal.cjs', import.meta.url));
const realRequire = createRequire(script);

// Run the actual helper with process operations intercepted. No tmux server or model starts.
async function fixture(
  work: (
    invoke: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ code: number; error: string; output: string }>,
    root: string,
    creations: () => number,
  ) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'review-terminal-resume-')));
  const original = {
    runId: 'same-run',
    workspaceId: 'same-workspace',
    session: 'same-terminal',
    runner: 'pi',
    model: 'glm',
    signalAttemptId: 'same-attempt',
    startedAt: 'before',
  };
  const marker = path.join(root, '.terminal-launch.json');
  writeFileSync(marker, JSON.stringify(original));
  writeFileSync(path.join(root, '.terminal-cancelled'), original.runId);
  let exists = false;
  let created = 0;
  const invoke = async (overrides: Record<string, unknown> = {}) => {
    let output = '';
    let error = '';
    const fakeProcess = {
      argv: [
        'node',
        script,
        JSON.stringify({
          ...original,
          action: 'resume',
          cwd: root,
          task: root,
          resumeSessionId: 'saved-conversation',
          resumeCommandId: 'resume-command',
          command: 'true',
          prompt: 'Continue the same review.',
          environment: { set: {}, unset: [] },
          runtimeRoots: [],
          ...overrides,
        }),
      ],
      env: { HOME: root },
      execPath: process.execPath,
      pid: process.pid,
      exitCode: 0,
      stdout: {
        write: (text: string) => {
          output += text;
        },
      },
      stderr: {
        write: (text: string) => {
          error += text;
        },
      },
    };
    const require = (name: string) => {
      if (name === 'node:child_process')
        return {
          spawnSync: (command: string, args: string[]) => {
            if (command === 'git') return { status: 0, stdout: root, stderr: '' };
            assert.equal(command, 'tmux');
            if (args[0] === 'has-session')
              return { status: exists ? 0 : 1, stdout: '', stderr: '' };
            if (args[0] === 'show-option')
              return { status: 0, stdout: original.workspaceId, stderr: '' };
            if (args[0] === 'new-session') {
              exists = true;
              created++;
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      if (name === './review-filesystem.cjs')
        return {
          sandbox: async () => ({
            temporaryDirectory: root,
            sandbox: { executable: '/bin/false', args: [] },
          }),
        };
      if (name === './workspace-trust.cjs')
        return {
          workspaceTrustByRunner: {},
          reviewConfigurationRootsByRunner: {},
          terminalReviewRefusalByRunner: {},
          reviewRuntimeRootsByRunner: {},
          reviewTemporaryDirectoryVariablesByRunner: {},
        };
      if (name === './review-codex-folder-access.cjs')
        return {
          answerCodexFolderAccess: () => {
            throw new Error('No Codex handshake in this fixture');
          },
        };
      return realRequire(name);
    };
    await vm.runInNewContext(
      readFileSync(script, 'utf8'),
      { require, process: fakeProcess, console, Buffer, setTimeout },
      { filename: script },
    );
    return { code: fakeProcess.exitCode, error, output };
  };
  try {
    await work(invoke, root, () => created);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('explicit terminal resume preserves its original attempt and receipts, and reuses the same resumed launch', async () => {
  await fixture(async (invoke, root, creations) => {
    const resumed = await invoke();
    assert.equal(resumed.code, 0, resumed.error);
    const record = JSON.parse(resumed.output);
    assert.equal(record.signalAttemptId, 'same-attempt');
    assert.equal(record.resumeSessionId, 'saved-conversation');
    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, '.terminal-launch.before-resume-command.json'), 'utf8'),
      ).signalAttemptId,
      'same-attempt',
    );
    assert.equal(
      readFileSync(path.join(root, '.terminal-cancelled.before-resume-command'), 'utf8'),
      'same-run',
    );
    assert.equal((await invoke()).code, 0);
    assert.equal(creations(), 1);
  });
});

test('unknown conversation or a foreign cancellation cannot mutate the retained terminal receipt', async () => {
  await fixture(async (invoke, root, creations) => {
    const marker = path.join(root, '.terminal-launch.json');
    const original = readFileSync(marker, 'utf8');
    assert.notEqual((await invoke({ resumeSessionId: undefined })).code, 0);
    assert.equal(readFileSync(marker, 'utf8'), original);
    writeFileSync(path.join(root, '.terminal-cancelled'), 'another-run');
    assert.notEqual((await invoke()).code, 0);
    assert.equal(readFileSync(marker, 'utf8'), original);
    assert.equal(creations(), 0);
  });
});

test('a newer cancellation fences its own continuation before old receipts can be archived', async () => {
  await fixture(async (invoke, root, creations) => {
    const marker = path.join(root, '.terminal-launch.json');
    const original = readFileSync(marker, 'utf8');
    const stopped = await invoke({ action: 'stop' });
    assert.equal(stopped.code, 0, stopped.error);
    const resumed = await invoke();
    assert.notEqual(resumed.code, 0);
    assert.match(resumed.error, /continuation was cancelled/);
    assert.equal(readFileSync(marker, 'utf8'), original);
    assert.equal(creations(), 0);
  });
});
