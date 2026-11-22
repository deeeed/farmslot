import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Runs 2a897448 (macpro-mmt-5) and bfc4d886 (macpro-mmt-4): a pi worker's host-wide
// `find`/`grep -r` held its bash call for 41 and 22 minutes. Pi's bash tool has no
// default timeout, so a call the model makes without one never ends on its own.
async function checkBashTimeout(extensionUrl) {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { default: install } = await import(extensionUrl);

  const root = mkdtempSync(path.join(tmpdir(), 'pi-bash-timeout-'));
  const events = new Map();
  process.env = {
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_OBS_DIR: root,
  };
  const bashCall = async (input) => {
    const event = { type: 'tool_call', toolCallId: 't1', toolName: 'bash', input };
    await events.get('tool_call')?.(event, { cwd: root });
    return event.input;
  };
  try {
    await install({ on: (name, handler) => events.set(name, handler) });
    assert.deepEqual(
      await bashCall({ command: 'find /Users -name proof-rules.md' }),
      { command: 'find /Users -name proof-rules.md', timeout: 120 },
      'a bash call without a timeout gets the 120-second default',
    );
    assert.equal(
      (await bashCall({ command: 'yarn test', timeout: 900 })).timeout,
      900,
      'a longer explicit timeout is kept',
    );
    assert.equal(
      (await bashCall({ command: 'true', timeout: 5 })).timeout,
      5,
      'a shorter explicit timeout is kept',
    );
  } finally {
    await events.get('session_shutdown')?.({});
    rmSync(root, { recursive: true, force: true });
  }
}

test('the pi observability extension gives a bash call without a timeout 120 seconds', () => {
  const extension = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `await (${checkBashTimeout.toString()})(${JSON.stringify(extension)});`,
    ],
    { encoding: 'utf8', timeout: 8000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
