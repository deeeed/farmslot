import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  RECIPE_PROTOCOL_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { RecipeExecutionError } from '../src/core/failure.js';
import { createRecipeRunner, defineActionAdapter } from '../src/core/runner.js';
import type { ActionAdapter } from '../src/core/types.js';

function manifest(actions: string[]): RecipeActionManifestDocument {
  const schemas: Record<string, Record<string, unknown>> = {
    assert_json: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        assert: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
    command: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      additionalProperties: false,
    },
    switch: {
      type: 'object',
      properties: { value: { type: 'string' }, equals: { type: 'string' } },
      additionalProperties: false,
    },
  };
  return {
    $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
    actions: Object.fromEntries(
      [...actions, 'call', 'end'].map((action) => [
        action,
        {
          description: `Execute ${action}.`,
          ...(action === 'call' || action === 'end'
            ? {}
            : { schema: schemas[action] ?? { type: 'object', additionalProperties: false } }),
          ...(action === 'call' || action === 'end' ? {} : { execution_capabilities: [] }),
          ...(action === 'switch' ? { result_cases: ['match'] } : {}),
          examples:
            action === 'end'
              ? [{ action: 'end', status: 'pass' }]
              : action === 'call'
                ? [
                    {
                      action: 'call',
                      intent: 'Invoke the retained child recipe.',
                      ref: 'child',
                      next: 'done',
                    },
                  ]
                : [{ action, intent: 'Exercise the declared failure path.', next: 'done' }],
        },
      ]),
    ),
  };
}

function recipe(nodes: Record<string, Record<string, unknown>>, entry = Object.keys(nodes)[0]) {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    description: 'Exercise failure attribution through the real recipe runner.',
    workflow: { entry, nodes },
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

test('classifies explicit and untyped adapter failures and reconciles summary counts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-failure-attribution-'));
  try {
    await writeFile(path.join(tempRoot, 'state.json'), '{"ready":false}\n');
    const classified = (action: string, cause: 'harness' | 'environment'): ActionAdapter =>
      defineActionAdapter({
        action,
        source: { kind: 'bundled', trust: 'trusted' },
        async execute() {
          throw new RecipeExecutionError(cause, `${cause} failure`);
        },
      });
    const adapters = [
      ...createStandardCoreAdapters({ actions: ['assert_json', 'command'] }),
      classified('example.harness', 'harness'),
      classified('example.environment', 'environment'),
    ];
    const cases = [
      {
        action: 'assert_json',
        node: { path: 'state.json', assert: { path: '$.ready', operator: 'eq', value: true } },
        cause: 'subject',
      },
      { action: 'example.harness', node: {}, cause: 'harness' },
      { action: 'example.environment', node: {}, cause: 'environment' },
      {
        action: 'command',
        node: { cmd: 'node -e "process.exit(9)"' },
        cause: 'unknown',
      },
    ] as const;

    for (const entry of cases) {
      const artifactsDir = path.join(tempRoot, entry.cause);
      const runner = createRecipeRunner({
        actionManifest: manifest([entry.action]),
        adapters: adapters.filter((adapter) => adapter.action === entry.action),
        defaultSource: { kind: 'operator', trust: 'trusted' },
      });
      const result = await runner.run({
        recipeDocument: recipe({
          check: {
            action: entry.action,
            intent: 'Exercise the declared failure classification.',
            ...entry.node,
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        }),
        artifactsDir,
        projectRoot: tempRoot,
      });
      assert.equal(result.status, 'fail');
      const trace = (await readJson(result.tracePath)) as Array<Record<string, unknown>>;
      assert.equal(trace[0]?.cause_class, entry.cause);
      assert.equal(trace[0]?.ok, false);
      const summary = (await readJson(result.summaryPath)) as Record<string, unknown>;
      assert.deepEqual(summary.cause_counts, {
        subject: entry.cause === 'subject' ? 1 : 0,
        harness: entry.cause === 'harness' ? 1 : 0,
        environment: entry.cause === 'environment' ? 1 : 0,
        unknown: entry.cause === 'unknown' ? 1 : 0,
      });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('preserves a nested structured cause on the parent call failure', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-nested-failure-'));
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    await writeFile(
      path.join(libraryRoot, 'recipes', 'child.recipe.json'),
      `${JSON.stringify(
        recipe({
          fail: {
            action: 'example.subject',
            intent: 'Produce a structured child assertion failure.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        }),
        null,
        2,
      )}\n`,
    );
    const subject = defineActionAdapter({
      action: 'example.subject',
      source: { kind: 'bundled', trust: 'trusted' },
      async execute() {
        throw new RecipeExecutionError('subject', 'assertion mismatch');
      },
    });
    const result = await createRecipeRunner({
      actionManifest: manifest(['example.subject']),
      adapters: [subject],
      defaultSource: { kind: 'operator', trust: 'trusted' },
    }).run({
      recipeDocument: recipe({
        child: {
          action: 'call',
          intent: 'Invoke the child that produces a structured failure.',
          ref: 'child',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
      librarySources: [
        {
          root: libraryRoot,
          provenance: { kind: 'library', trust: 'trusted', name: 'test-library' },
        },
      ],
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    const trace = (await readJson(result.tracePath)) as Array<Record<string, unknown>>;
    assert.deepEqual(
      trace.filter((entry) => entry.ok === false).map((entry) => entry.cause_class),
      ['subject', 'subject'],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('records authored terminal failure as an unknown failed entry', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-terminal-failure-'));
  try {
    const result = await createRecipeRunner({
      actionManifest: manifest([]),
      adapters: [],
    }).run({
      recipeDocument: recipe({ done: { action: 'end', status: 'fail' } }, 'done'),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    const trace = (await readJson(result.tracePath)) as Array<Record<string, unknown>>;
    const summary = (await readJson(result.summaryPath)) as Record<string, unknown>;
    assert.equal(result.status, 'fail');
    assert.equal(trace[0]?.ok, false);
    assert.equal(trace[0]?.cause_class, 'unknown');
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.cause_counts, {
      subject: 0,
      harness: 0,
      environment: 0,
      unknown: 1,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('does not turn a non-taken workflow branch into suite non-execution evidence', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-branch-evidence-'));
  try {
    const result = await createRecipeRunner({
      actionManifest: manifest(['switch']),
      adapters: createStandardCoreAdapters({ actions: ['switch'] }),
      defaultSource: { kind: 'operator', trust: 'trusted' },
    }).run({
      recipeDocument: recipe({
        route: {
          action: 'switch',
          intent: 'Select the matching branch.',
          value: 'yes',
          equals: 'yes',
          cases: { match: 'taken' },
          default: 'skipped',
        },
        taken: { action: 'end', status: 'pass' },
        skipped: { action: 'end', status: 'fail' },
      }),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    const trace = (await readJson(result.tracePath)) as Array<Record<string, unknown>>;
    assert.equal(result.status, 'pass');
    assert.deepEqual(
      trace.map((entry) => entry.nodeId),
      ['route', 'taken'],
    );
    assert.equal(
      trace.every((entry) => !('cause_class' in entry)),
      true,
    );
    assert.equal(
      trace.some((entry) => 'reason_class' in entry),
      false,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
