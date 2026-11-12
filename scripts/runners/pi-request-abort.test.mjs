import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

async function checkAbort(extensionUrl, mode) {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const test = (await import('node:test')).default;
  const { default: install } = await import(extensionUrl);
  test('retry exhaustion records a terminal hook before abort, even without settlement', async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-request-abort-'));
    const originalEnv = process.env;
    const originalFetch = globalThis.fetch;
    const events = new Map();
    process.env = {
      PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_OBS_DIR: root,
      FARMSLOT_PI_REQUEST_TIMEOUT_MS: '100',
      FARMSLOT_PI_REQUEST_TIMEOUT_MODE: mode,
    };
    globalThis.fetch = (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    t.after(async () => {
      await events.get('session_shutdown')?.({});
      globalThis.fetch = originalFetch;
      process.env = originalEnv;
      rmSync(root, { recursive: true, force: true });
    });
    await install({ on: (name, handler) => events.set(name, handler) });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborts = 0;
    const ctx = {
      cwd: root,
      sessionManager: { getSessionFile: () => path.join(root, 'session.jsonl') },
      abort: () => {
        aborts++;
        const hook = JSON.parse(readFileSync(path.join(root, 'sessions/session.json'), 'utf8'));
        assert.equal(hook.event, 'StopFailure');
        assert.equal(hook.turnActive, false);
        assert.match(hook.failure, /timed out after 100ms and one retry/);
      },
    };
    await events.get('input')({ text: 'Synthetic task' }, ctx);
    const input = JSON.parse(readFileSync(path.join(root, 'sessions/session.json'), 'utf8'));
    assert.equal(input.startupGraceMs, mode === 'idle' ? null : 100 * 2 + 30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = assert.rejects(globalThis.fetch('http://fixture.test/v1/chat/completions'));
      t.mock.timers.tick(100);
      await request;
    }
    assert.equal(aborts, 1);
    await events.get('agent_settled')({}, ctx);
    const hook = JSON.parse(readFileSync(path.join(root, 'sessions/session.json'), 'utf8'));
    assert.equal(hook.event, 'StopFailure');
  });
}

for (const mode of ['total', 'idle']) {
  test(`retry exhaustion in ${mode} mode emits StopFailure before abort without settlement`, () => {
    const extension = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `await (${checkAbort.toString()})(${JSON.stringify(extension)}, ${JSON.stringify(mode)});`,
      ],
      { encoding: 'utf8', timeout: 4000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
