import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  probeRunnerHandoffAck,
  waitForRunnerLaunchAck,
} from '../../runners/prompt-delivery-evidence.js';
import { getRunnerDefinition } from '../../runners/registry.js';
import { makeVars } from '../../runners/test-fixtures.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-launch-ack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const obs = join(dir, '.agent', '.observability');
  mkdirSync(obs, { recursive: true });
  return {
    obs,
    vars: makeVars({ repo: dir, remoteRepo: dir, projectName: 'synthetic-missing-project' }),
    write: (records: object[]) =>
      writeFileSync(
        join(obs, 'hooks.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      ),
  };
}

test('dispatch rejects a configuration failure delayed past its first process check', async (t) => {
  assert.equal(getRunnerDefinition('pi').requiresInitialPromptAck, true);
  const f = fixture(t);
  const since = Date.now();
  const extensionUrl = new URL(
    '../../../../../scripts/runners/pi-farmslot-observability.ts',
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `
    const { default: install } = await import(${JSON.stringify(extensionUrl)});
    const events = new Map();
    let model;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/model/info')) return Response.json({ data: [] });
      if (!String(input).endsWith('/models')) throw new Error('Inference forbidden');
      process.send('discovering');
      await new Promise(resolve => process.once('message', resolve));
      return Response.json({ data: [{ id: 'model', reasoning: false, context_length: 8192, max_output_tokens: 1024 }] });
    };
    await install({
      on: (event, handler) => events.set(event, handler),
      registerProvider: (provider, spec) => { model = { ...spec.models[0], provider }; },
    });
    await events.get('session_start')({}, {
      model, hasUI: false, abort: () => {},
      shutdown: () => setImmediate(async () => {
        await events.get('session_shutdown')({ reason: 'exit' });
        process.exit(0);
      }),
    });
  `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        FARMSLOT_PI_OLLAMA: '0',
        LITELLM_URL: 'http://synthetic.test/v1',
        FARMSLOT_THINKING: 'medium',
        FARMSLOT_OBS_DIR: f.obs,
        TMUX_PANE: '%129',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      timeout: 3000,
    },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  assert.deepEqual(await once(child, 'message'), ['discovering', undefined]);
  assert.equal(child.exitCode, null, 'first process check passes while discovery is gated');
  let polls = 0;
  await assert.rejects(
    waitForRunnerLaunchAck(f.vars, 'unused', 'TASK.md', since, {
      paneId: '%129',
      isAlive: async () => child.exitCode === null,
      timeoutMs: 2000,
      sleep: async () => {
        polls++;
        child.send('release discovery');
        await exited;
      },
    }),
    /PI_REASONING_EFFORT_MISMATCH: Model litellm\/model requested medium/,
  );
  assert.equal(polls, 1, 'the configuration failure arrives after the first acknowledgement probe');
  assert.equal(child.exitCode, 1);
  assert.match(stderr, /PI_REASONING_EFFORT_MISMATCH/);
});

test('launch acknowledgement ignores stale and foreign failures and accepts a current prompt', async (t) => {
  const f = fixture(t);
  const since = Date.now();
  f.write([
    { event: 'StopFailure', observedAt: since - 1, tmuxPane: '%129', failure: 'stale' },
    { event: 'StopFailure', observedAt: since + 1, tmuxPane: '%130', failure: 'foreign' },
    { event: 'UserPromptSubmit', observedAt: since + 1, tmuxPane: '%129' },
  ]);
  await waitForRunnerLaunchAck(f.vars, 'unused', 'TASK.md', since, {
    paneId: '%129',
    isAlive: async () => false,
    timeoutMs: 500,
  });
});

test('launch fails closed when the runner exits before prompt acceptance', async () => {
  let probes = 0;
  await assert.rejects(
    waitForRunnerLaunchAck(makeVars(), 'unused', 'TASK.md', Date.now(), {
      paneId: '%129',
      isAlive: async () => false,
      timeoutMs: 500,
      probe: async () => {
        probes++;
        return { accepted: false, reason: 'no hooks' };
      },
    }),
    /exited before accepting/,
  );
  assert.equal(probes, 2, 'exit re-reads the final failure receipt');
});

test('a final failure receipt wins the race with process exit', async (t) => {
  const f = fixture(t);
  const since = Date.now();
  await assert.rejects(
    waitForRunnerLaunchAck(f.vars, 'unused', 'TASK.md', since, {
      paneId: '%129',
      timeoutMs: 500,
      isAlive: async () => {
        f.write([
          {
            event: 'StopFailure',
            observedAt: since,
            tmuxPane: '%129',
            failure: 'configuration error',
          },
        ]);
        return false;
      },
    }),
    /configuration error/,
  );
});

test('current failure takes precedence over positive handoff evidence', async (t) => {
  const f = fixture(t);
  const since = Date.now();
  f.write([
    { event: 'UserPromptSubmit', observedAt: since, tmuxPane: '%129' },
    {
      event: 'StopFailure',
      observedAt: since + 1,
      tmuxPane: '%129',
      failure: 'configuration error',
    },
  ]);
  await assert.rejects(
    probeRunnerHandoffAck(f.vars, 'unused', 'TASK.md', since, { paneId: '%129' }),
    /configuration error/,
  );
});

test('launch acknowledgement has a bounded deadline while discovery stays alive', async () => {
  let clock = 0;
  await assert.rejects(
    waitForRunnerLaunchAck(makeVars(), 'unused', 'TASK.md', Date.now(), {
      paneId: '%129',
      isAlive: async () => true,
      timeoutMs: 200,
      probe: async () => ({ accepted: false, reason: 'discovery pending' }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    /startup deadline/,
  );
});
