import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Run 36cc77e1 (macpro-mm-1): the pi turn was aborted at 05:13:14 HKT, 8 s after
// an early warning about git history past the base. The farm then raised
// "runner unavailable: Pi model request timed out after 300000ms and one retry",
// which is not why the turn ended.
//
// The observability extension has no channel for an intentional abort. On
// `agent_before_settle` it maps only `outcome === 'error'` to a failure; every
// other outcome, 'aborted' included, clears `terminalFailure`. `agent_settled`
// then writes event `Stop` with `failure: null`, so a deliberately aborted turn
// records no reason at all. The only text left in the record is whatever the
// request wrapper happened to set earlier in the turn, and that is the label the
// gateway relayed (run-monitor.ts:1746 passes the hook's message through
// verbatim).
async function checkAbortReason(extensionUrl) {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const test = (await import('node:test')).default;
  const { default: install } = await import(extensionUrl);

  const fixture = async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-abort-reason-'));
    const originalEnv = process.env;
    const events = new Map();
    process.env = {
      PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_OBS_DIR: root,
      FARMSLOT_PI_REQUEST_TIMEOUT_MS: '100',
    };
    t.after(async () => {
      await events.get('session_shutdown')?.({});
      process.env = originalEnv;
      rmSync(root, { recursive: true, force: true });
    });
    await install({ on: (name, handler) => events.set(name, handler) });
    const ctx = {
      cwd: root,
      abort: () => {},
      sessionManager: { getSessionFile: () => path.join(root, 'session.jsonl') },
    };
    await events.get('input')({ text: 'Synthetic task' }, ctx);
    const hook = () => JSON.parse(readFileSync(path.join(root, 'sessions/session.json'), 'utf8'));
    return { events, ctx, hook };
  };

  test('an aborted turn records that it was aborted', async (t) => {
    const f = await fixture(t);
    // The turn produced no model failure; something outside the model ended it.
    await f.events.get('agent_end')({ messages: [] });
    await f.events.get('agent_before_settle')({ outcome: 'aborted' });
    await f.events.get('agent_settled')({}, f.ctx);

    const record = f.hook();
    assert.equal(
      record.event,
      'StopFailure',
      'an aborted turn is not a clean Stop: the gateway cannot tell it from a finished turn',
    );
    assert.match(
      String(record.failure),
      /abort/i,
      'the recorded reason must name the abort, or the only text left in the record is some other failure',
    );
    assert.doesNotMatch(
      String(record.failure ?? ''),
      /timed out/i,
      'an intentional abort must never be labelled a model timeout (36cc77e1)',
    );
  });

  // A request timeout earlier in the turn is not a licence to label a later,
  // unrelated ending as that timeout. `timeoutFailure` is only cleared on the
  // next `input`, and `agent_before_settle` reads it before the turn's own
  // outcome, so it outranks whatever actually ended the turn.
  test('a turn aborted after an earlier request timeout is not reported as the timeout', async (t) => {
    const f = await fixture(t);
    const timedOut = assert.rejects(globalThis.fetch('http://fixture.test/v1/chat/completions'));
    await timedOut.catch(() => {});
    await f.events.get('agent_before_settle')({ outcome: 'aborted' });
    await f.events.get('agent_settled')({}, f.ctx);

    const record = f.hook();
    assert.doesNotMatch(
      String(record.failure ?? ''),
      /timed out after 100ms and one retry/,
      'the turn ended on an abort; the retry-exhaustion text describes a request, not the ending',
    );
  });
}

test('the pi observability extension records an abort as an abort', () => {
  const extension = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `await (${checkAbortReason.toString()})(${JSON.stringify(extension)});`,
    ],
    { encoding: 'utf8', timeout: 8000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
