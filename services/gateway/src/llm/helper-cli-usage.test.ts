import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunnerSessionUsage } from '@farmslot/protocol';

import { withAgentUsageContext } from '../runtime/agent-usage-context.js';

mock.module('../core/exec.js', {
  namedExports: {
    execLocal: async (command: string) =>
      command.includes('claude -p')
        ? {
            exitCode: 1,
            stderr: 'provider failed',
            stdout: JSON.stringify({
              session_id: 'failed-helper-native',
              num_turns: 3,
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              total_cost_usd: 0.25,
              result: 'error',
            }),
          }
        : { exitCode: 0, stderr: '', stdout: 'fallback answer' },
  },
});
const { callLLM } = await import('./index.js');

test('failed CLI helper preserves structured accounting before the next fallback', async () => {
  const receipts: RunnerSessionUsage[] = [];
  const result = await withAgentUsageContext(
    {
      runId: 'run',
      flowType: 'dev',
      role: 'summary',
      record: (row) => {
        receipts.push(row);
      },
    },
    () =>
      callLLM({
        provider: '__no_auth_for_usage_fixture__',
        model: 'fixture',
        userPrompt: 'fixture',
      }),
  );
  const failed = [...receipts].reverse().find((row) => row.runner === 'claude');
  assert.equal(result.text, 'fallback answer');
  assert.equal(failed?.outcome, 'failed');
  assert.equal(failed?.runnerSessionId, 'failed-helper-native');
  assert.equal(failed?.totalTokens, 30);
  assert.equal(failed?.turns, 3);
  assert.equal(failed?.costUsd, 0.25);
  assert.equal(failed?.costStatus, 'estimated');
});
