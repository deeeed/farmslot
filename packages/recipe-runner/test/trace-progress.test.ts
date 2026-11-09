import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';

test('the runner publishes each finished step to trace.json while the run continues', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'run');
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Run a command.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [{ action: 'command', cmd: 'printf ok', intent: 'Read it.', next: 'done' }],
        },
        assert_output: {
          description: 'Verify a step output.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: 'ok',
              intent: 'Verify it.',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
  });
  const result = await runner.run({
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Follow the trace',
      proofTargets: [{ id: 'AC-1', claim: 'The first step is published.', proofMode: 'state' }],
      workflow: {
        entry: 'first',
        nodes: {
          first: {
            action: 'command',
            cmd: 'printf first',
            intent: 'Do the first step.',
            next: 'peek',
          },
          // Read the live trace from inside the run, before the run writes its summary.
          peek: {
            action: 'command',
            cmd: 'cat trace.json',
            intent: 'Read the live trace.',
            next: 'check',
          },
          check: {
            action: 'assert_output',
            source: 'peek',
            contains: 'Do the first step.',
            proves: ['AC-1'],
            intent: 'Confirm the first step was already published.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
    projectRoot: artifactsDir,
    artifactsDir,
    recordVideo: false,
    recordingReason: 'Fixture has no recorder.',
  });
  assert.equal(result.status, 'pass');
  const trace = JSON.parse(await readFile(path.join(artifactsDir, 'trace.json'), 'utf8')) as
    | { entries: { nodeId: string }[] }
    | { nodeId: string }[];
  const entries = Array.isArray(trace) ? trace : trace.entries;
  assert.deepEqual(
    entries.map((entry) => entry.nodeId),
    ['first', 'peek', 'check', 'done'],
  );
  assert.ok(!(await readdir(artifactsDir)).includes('.trace.json.partial'));
});
