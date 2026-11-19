import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  model = 'glm',
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'review-terminal-resume-')));
  const original = {
    runId: 'same-run',
    workspaceId: 'same-workspace',
    session: 'same-terminal',
    runner: 'pi',
    model,
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
          reviewLiteLlmEndpointIdByRunner:
            realRequire('./workspace-trust.cjs').reviewLiteLlmEndpointIdByRunner,
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
      { require, process: fakeProcess, console, Buffer, setTimeout, URL },
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

test('the launch receipt records only a digest of the LiteLLM route Pi is launched with', async () => {
  const { liteLlmEndpointId } = realRequire('./litellm-endpoint.cjs');
  const secrets = ['user', 'pass', 'secret', 'token', 'route.example', 'model-route', 'home-route'];
  assert.notEqual(liteLlmEndpointId('https://route.example'), undefined);
  const agent = (root: string) => ({ PI_CODING_AGENT_DIR: path.join(root, 'agent') });
  const envUrl = { LITELLM_URL: 'https://env-token-secret.example' };
  const cases: Array<[string, (root: string) => Record<string, unknown>, string | undefined]> = [
    // A model listed in models.json keeps its static route, even with a LiteLLM URL in the
    // environment: the Farmslot Pi extension preserves static models over discovered ones.
    [
      'litellm/glm',
      (root) => ({ set: { ...agent(root), ...envUrl }, unset: [] }),
      'https://route.example',
    ],
    // A model's own baseUrl overrides its provider's.
    [
      'litellm/claude-x',
      (root) => ({ set: agent(root), unset: [] }),
      'https://token-secret.model-route.example/proxy',
    ],
    // An unlisted LiteLLM model is routed to the URL the extension registers the provider on.
    [
      'litellm/discovered',
      (root) => ({
        set: { ...agent(root), LITELLM_BASE_URL: 'env-token-secret.example:4000/' },
        unset: [],
      }),
      'http://env-token-secret.example:4000',
    ],
    // Set, then unset: the unset URL and agent directory leave Pi on HOME's models.json route.
    [
      'litellm/glm',
      (root) => ({
        set: { ...agent(root), ...envUrl },
        unset: ['PI_CODING_AGENT_DIR', 'LITELLM_URL'],
      }),
      'https://home-route.example',
    ],
    [
      'litellm/discovered',
      (root) => ({ set: { ...agent(root), ...envUrl }, unset: ['LITELLM_URL'] }),
      undefined,
    ],
    // Another provider, or a model Pi has no LiteLLM route for, records nothing.
    ['other/glm', (root) => ({ set: { ...agent(root), ...envUrl }, unset: [] }), undefined],
    [
      'litellm/glm',
      (root) => ({ set: { PI_CODING_AGENT_DIR: path.join(root, 'missing') }, unset: [] }),
      undefined,
    ],
    // A models.json this parser cannot read leaves the route unknown, not the environment's.
    [
      'litellm/glm',
      (root) => ({ set: { PI_CODING_AGENT_DIR: path.join(root, 'jsonc'), ...envUrl }, unset: [] }),
      undefined,
    ],
  ];
  for (const [model, environment, route] of cases)
    await fixture(async (invoke, root) => {
      const write = (directory: string, providers: unknown) => {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers }));
      };
      write(path.join(root, 'agent'), {
        litellm: {
          baseUrl: 'https://user:pass@route.example/v1/?api_key=secret#fragment',
          models: [
            { id: 'glm' },
            { id: 'claude-x', baseUrl: 'https://token-secret.model-route.example/proxy/v1' },
          ],
        },
        other: { baseUrl: 'https://route.example/v1' },
      });
      write(path.join(root, '.pi/agent'), {
        litellm: { baseUrl: 'https://home-route.example/v1', models: [{ id: 'glm' }] },
      });
      mkdirSync(path.join(root, 'jsonc'));
      writeFileSync(path.join(root, 'jsonc/models.json'), '// comment\n{}');
      const launched = await invoke({ environment: environment(root) });
      assert.equal(launched.code, 0, launched.error);
      const receipt = JSON.parse(launched.output);
      assert.equal(receipt.liteLlmEndpointId, liteLlmEndpointId(route));
      assert.equal(
        JSON.parse(readFileSync(path.join(root, '.terminal-launch.json'), 'utf8'))
          .liteLlmEndpointId,
        receipt.liteLlmEndpointId,
      );
      for (const fragment of secrets)
        assert.equal(launched.output.includes(fragment), false, fragment);
    }, model);
});
