import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

let returnedSession = 'conversation';
const calls: Array<{ owner: string; node: string; argv: string[] }> = [];
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: async (owner: string, node: string, argv: string[]) => {
      calls.push({ owner, node, argv });
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            key: 'review',
            runnerSessionId: returnedSession,
            sessionPath: '/owned/transcript.jsonl',
            output:
              'model=recorded-model\nturns=2\ninput_tokens=10\noutput_tokens=20\ntotal_tokens=30\ncache_read=4\ncost_usd=0.1',
          },
        ]),
      };
    },
  },
});
const { extractNativeAgentSessionUsage } = await import('./native-session-usage.js');

test('native accounting follows the recorded reviewer owner/node rather than the producing slot', async () => {
  for (const runner of ['claude', 'codex']) {
    const result = await extractNativeAgentSessionUsage({
      vars: { ...makeVars(), machine: 'producing-node' },
      runner,
      runnerSessionId: 'conversation',
      nativeSession: {
        sessionId: 'host',
        executionNodeId: 'reviewer-node',
        ownerPrincipalId: 'review-owner',
        leaseId: 'lease',
        commandId: 'command',
      },
    });
    assert.equal(result.source, 'runner-transcript');
    assert.equal(result.totalTokens, 30);
    assert.equal(result.runnerSessionId, 'conversation');
    assert.equal(calls.at(-1)?.node, 'reviewer-node');
    assert.equal(calls.at(-1)?.owner, 'review-owner');
    assert.equal(JSON.parse(calls.at(-1)!.argv.at(-2)!)[0].runner, runner);
  }
  returnedSession = 'foreign-conversation';
  const failed = await extractNativeAgentSessionUsage({
    vars: makeVars(),
    runner: 'claude',
    runnerSessionId: 'conversation',
    nativeSession: {
      sessionId: 'host',
      executionNodeId: 'reviewer-node',
      ownerPrincipalId: 'review-owner',
      leaseId: 'lease',
      commandId: 'command',
    },
  });
  assert.equal(failed.source, 'unavailable');
  assert.equal(failed.totalTokens, undefined);
  assert.match(failed.error ?? '', /identity changed/);
});
