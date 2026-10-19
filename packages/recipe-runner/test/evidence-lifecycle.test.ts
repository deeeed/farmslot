import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardUiAdapters } from '../src/adapters/ui.js';
import { RecipeExecutionError } from '../src/core/failure.js';
import { createRecipeRunner } from '../src/core/runner.js';

import { framePng } from './fixtures/png.js';

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    'ui.press': {
      description: 'Activate a control.',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'ui.press',
          selector: '#increment',
          intent: 'Increase the counter.',
          next: 'done',
        },
      ],
    },
    'ui.wait_for': {
      description: 'Check a value.',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'ui.wait_for',
          selector: '#count',
          text: '1',
          intent: 'The count must be one.',
          next: 'done',
        },
      ],
    },
    'app.hud': {
      description: 'Display the outcome.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.hud', intent: 'Show the current outcome.', next: 'done' }],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

for (const outcome of ['passed', 'predicate-failed', 'still-unavailable', 'retry'] as const) {
  test(`automatic UI evidence preserves assertion and capture outcomes: ${outcome}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-lifecycle-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const events: string[] = [];
    let checks = 0;
    const runner = createRecipeRunner({
      actionManifest: manifest,
      defaultSource: { kind: 'operator', trust: 'trusted' },
      adapters: createStandardUiAdapters({
        actions: Object.keys(manifest.actions),
        transport: {
          async execute(action, node) {
            if (action === 'app.hud') {
              if (node.phase === 'complete') events.push('final-hud');
              return {};
            }
            events.push(action);
            if (
              action === 'ui.wait_for' &&
              (outcome === 'predicate-failed' || (outcome === 'retry' && checks++ === 0))
            )
              throw new RecipeExecutionError('subject', 'The observed value does not match.');
            return { matched: true };
          },
        },
      }),
      recording: {
        targetProvider: { resolveRecordingTarget: async () => ({ kind: 'pid', pid: 1 }) },
        videoRecorder: {
          name: 'fixture',
          async start(request) {
            const zero = Date.now();
            events.push('record-start');
            return {
              snapshot: async (output) => {
                if (outcome === 'still-unavailable') throw new Error('No source frame available.');
                await writeFile(output, framePng());
                return { output };
              },
              stop: async () => {
                events.push('record-stop');
                await writeFile(request.outputPath, 'source video fixture');
                return {
                  segments: [
                    {
                      path: request.outputPath.split(/[\\/]/u).at(-1)!,
                      timing: {
                        framesMs: [0, 10],
                        durationMs: 1_000,
                        clock: {
                          source: 'fixture',
                          earliestZeroUnixMs: zero,
                          latestZeroUnixMs: zero,
                        },
                      },
                    },
                  ],
                };
              },
            };
          },
        },
      },
    });
    const result = await runner.run({
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        proofTargets: [{ id: 'AC-1', claim: 'The observed count is one.', proofMode: 'state' }],
        workflow: {
          entry: 'input',
          nodes: {
            input: {
              action: 'ui.press',
              selector: '#increment',
              intent: 'Increase the displayed count.',
              next: 'check',
            },
            check: {
              action: 'ui.wait_for',
              selector: '#count',
              text: '1',
              intent: 'The count must be one.',
              proves: ['AC-1'],
              ...(outcome === 'retry' ? { retryGroup: 'count-check', retryAttempts: 2 } : {}),
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });
    assert.equal(events[0], 'record-start');
    assert.deepEqual(events.slice(-2), ['final-hud', 'record-stop']);
    assert.equal(events.filter((event) => event === 'record-stop').length, 1);
    assert.equal(
      result.claims.criteria[0]?.verdict,
      outcome === 'predicate-failed' ? 'failed' : 'proven',
    );
    assert.equal(
      result.status,
      outcome === 'predicate-failed' || outcome === 'still-unavailable' ? 'fail' : 'pass',
    );
    const trace = JSON.parse(await readFile(result.tracePath, 'utf8')) as {
      action: string;
      ok: boolean;
      cause_class?: string;
    }[];
    if (outcome === 'still-unavailable') {
      assert.equal(
        trace.find((entry) => entry.action === 'record.snapshot')?.cause_class,
        'environment',
      );
      assert.equal(trace.find((entry) => entry.action === 'ui.wait_for')?.ok, true);
    }
    if (outcome === 'retry')
      assert.deepEqual(
        trace.filter((entry) => entry.action === 'ui.wait_for').map((entry) => entry.ok),
        [false, true],
      );
  });
}
