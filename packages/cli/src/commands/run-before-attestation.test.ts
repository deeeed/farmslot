import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Command } from 'commander';

import { Methods } from '@farmslot/protocol';

const calls: Array<{ method: string; params: unknown }> = [];
const output: unknown[] = [];
mock.module('../context.js', {
  namedExports: {
    resolveContext: () => ({
      output: {},
      client: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === 'run.get')
            return {
              run: {
                id: 'run',
                status: 'human-gating',
                decisions: [
                  {
                    id: 'gate',
                    type: 'engine_human_gate',
                    actions: [],
                    payload: { kind: 'ready', prPackage: { packageHash: 'shown' } },
                  },
                ],
              },
            };
          return { attestation: { id: 'attestation' } };
        },
      },
    }),
  },
});
mock.module('../envelope.js', {
  namedExports: {
    createEmitter: () => ({
      machine: true,
      ok: (value: unknown) => output.push(value),
      fail: (error: Error) => output.push(error.message),
    }),
  },
});
const { registerRunCommand } = await import('./run.js');

test('attest-before-attempt routes to the typed RPC with the displayed package hash', async () => {
  const program = new Command('farmslot');
  registerRunCommand(program);
  await program.parseAsync(
    [
      'run',
      'gate',
      'run',
      '--action',
      'attest-before-attempt',
      '--recipe-run',
      '20261031042938001-53783',
      '--reason',
      'The recipe needs files this change adds.',
    ],
    { from: 'user' },
  );
  assert.deepEqual(calls[1], {
    method: Methods.RUN_ATTEST_BEFORE_ATTEMPT,
    params: {
      runId: 'run',
      decisionId: 'gate',
      recipeRunId: '20261031042938001-53783',
      reason: 'The recipe needs files this change adds.',
      packageHash: 'shown',
    },
  });
  assert.deepEqual(output, [{ attestation: { id: 'attestation' } }]);
});
