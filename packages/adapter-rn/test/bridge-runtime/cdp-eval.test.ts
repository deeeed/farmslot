import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

interface EvalClient {
  send(
    method: string,
    params: { expression: string },
    timeoutMs?: number,
  ): Promise<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>;
}
const require = createRequire(import.meta.url);
const { cdpEvalAsync } = require('../../bridge-runtime/lib/cdp-eval.cjs') as {
  cdpEvalAsync(client: EvalClient, expression: string, timeoutMs?: number): Promise<unknown>;
};

function fixture() {
  const effects = { count: 0 };
  const runtime = vm.createContext({ effects });
  const calls: string[] = [];
  const client: EvalClient = {
    async send(_method, { expression }) {
      calls.push(expression);
      try {
        return { result: { value: vm.runInContext(expression, runtime) } };
      } catch (error) {
        return { exceptionDetails: { text: String(error) } };
      }
    },
  };
  return { client, calls, effects };
}

test('reads an already resolved result before waiting and executes its producer once', async () => {
  const { client, calls, effects } = fixture();
  const pending = cdpEvalAsync(client, 'Promise.resolve(++effects.count)', 1000);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      calls.some((expression) => expression.startsWith('delete globalThis')),
      'ready result must be returned and cleaned up without a polling delay',
    );
    assert.equal(await pending, 1);
    assert.equal(effects.count, 1);
  } finally {
    // Drain the call even when the immediate-return assertion fails.
    await pending;
  }
});

test('keeps rejected evaluation errors and removes their private result slot', async () => {
  const { client, calls } = fixture();
  await assert.rejects(
    () => cdpEvalAsync(client, 'Promise.reject(new Error("read failed"))', 1000),
    /read failed/,
  );
  assert.equal(calls.filter((expression) => expression.startsWith('delete globalThis')).length, 1);
});

test('pending results retain their deadline without rerunning the expression', async () => {
  const { client, calls, effects } = fixture();
  await assert.rejects(
    () => cdpEvalAsync(client, '(++effects.count, new Promise(() => {}))', 30),
    /timed out after 30ms/,
  );
  assert.equal(effects.count, 1);
  assert.equal(calls.filter((expression) => expression.startsWith('delete globalThis')).length, 1);
});
