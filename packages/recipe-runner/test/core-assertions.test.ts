import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { recipeFailureCause, recipeFailureTraceFields } from '../src/core/failure.js';
import { getJsonPathValue } from '../src/core/json.js';
import { createRecipeRunner } from '../src/core/runner.js';
import type { ActionExecutionContext } from '../src/core/types.js';

const source = { kind: 'operator', trust: 'trusted', name: 'assertion-test' } as const;
const output = { stdout: 'ready', stderr: 'notice', count: 2, rows: [{ state: 'ready' }] };
const context: ActionExecutionContext = {
  nodeId: 'check',
  recipe: {},
  projectRoot: '.',
  artifactsDir: '.',
  env: {},
  outputs: new Map([['read', output]]),
  getOutput: () => output,
  resolveProjectPath: (file) => file,
  resolveArtifactPath: (file) => file,
  getRunFileOffset: () => undefined,
  registerArtifact: () => undefined,
  logger: console,
};
const adapter = createStandardCoreAdapters().find((entry) => entry.action === 'assert_output')!;
const count = { path: '$.count', operator: 'eq', value: 2 };

test('file content checks retain the resolved expectation and actual match on both outcomes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-file-assertion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.log');
  await writeFile(file, 'service ready\n');
  const check = createStandardCoreAdapters().find((entry) => entry.action === 'assert_file')!;
  const fileContext = { ...context, projectRoot: root };
  const result = await check.execute({ path: 'state.log', contains: 'ready' }, fileContext);
  assert.deepEqual(result.output, {
    path: 'state.log',
    sizeBytes: 14,
    contains: 'ready',
    matched: true,
  });
  await writeFile(file, 'service stopped\n');
  await assert.rejects(
    check.execute({ path: 'state.log', contains: 'ready' }, fileContext),
    (error) => {
      assert.equal(recipeFailureCause(error), 'subject');
      assert.deepEqual(recipeFailureTraceFields(error), {
        error_code: 'FILE_CONTENT_MISMATCH',
        error_details: { path: 'state.log', sizeBytes: 16, contains: 'ready', matched: false },
      });
      return true;
    },
  );
  assert.deepEqual((await check.execute({ path: 'state.log' }, fileContext)).output, {
    path: 'state.log',
    sizeBytes: 16,
  });
  await assert.rejects(
    check.execute({ path: 'missing.log', contains: 'ready' }, fileContext),
    (error) => {
      assert.notEqual(recipeFailureCause(error), 'subject');
      assert.deepEqual(recipeFailureTraceFields(error), {});
      return true;
    },
  );
});

for (const [name, assertion] of Object.entries({
  all: { all: [count, { path: '$', operator: 'eq', value: 'ready' }] },
  any: { any: [{ ...count, value: 9 }, count] },
  none: { none: [{ ...count, value: 9 }] },
  nested: { all: [{ any: [count] }, { none: [{ path: '$.missing', operator: 'exists' }] }] },
})) {
  test('output assertion executes ' + name, async () => {
    await adapter.execute({ source: 'read', assert: assertion }, context);
  });
}

for (const [name, assertion] of Object.entries({
  all: { all: [count, { ...count, value: 9 }] },
  any: { any: [{ ...count, value: 9 }] },
  none: { none: [count] },
})) {
  test('false ' + name + ' output assertion fails', async () => {
    await assert.rejects(
      adapter.execute({ source: 'read', assert: assertion }, context),
      /failed assertion/u,
    );
  });
}

test('atomic output and selected-stream semantics are preserved', async () => {
  const result = await adapter.execute({ source: 'read', assert: count }, context);
  assert.deepEqual(result.output, {
    source: 'read',
    stream: 'stdout',
    assertion: { ...count, actual: 2 },
  });
  await adapter.execute(
    {
      source: 'read',
      stream: 'stderr',
      assert: { all: [count, { path: '$', operator: 'eq', value: 'notice' }] },
    },
    context,
  );
  await adapter.execute({ source: 'read', contains: 'ready', assert: { path: 'unused' } }, context);
  await adapter.execute({ source: 'read', match: '^ready$', assert: { path: 'unused' } }, context);
});

test('JSON paths preserve nested/indexed reads and reject malformed syntax', () => {
  assert.equal(getJsonPathValue(output, '$.rows[0].state'), 'ready');
  assert.equal(getJsonPathValue(output, '$.rows.0.state'), 'ready');
  assert.equal(getJsonPathValue(output.rows, '$.[0].state'), 'ready');
  assert.equal(getJsonPathValue(output, '$'), output);
  assert.equal(getJsonPathValue(output, '$.missing'), undefined);
  for (const invalid of ['pathname', '$.', '$..rows', '$.rows[0', '$.rows[no]', '$.rows[0]state']) {
    assert.throws(() => getJsonPathValue(output, invalid), /Only simple/u, invalid);
  }
});

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    wait: {
      description: 'Observe a wait.',
      schema: {
        type: 'object',
        properties: { duration_ms: { type: 'number' } },
        additionalProperties: false,
      },
      examples: [{ action: 'wait', duration_ms: 0, intent: 'Observe a wait', next: 'done' }],
    },
    assert_output: {
      description: 'Assert an observed output.',
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          contains: { type: 'string' },
          match: { type: 'string' },
          assert: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          source: 'read',
          contains: 'ready',
          intent: 'Check output',
          next: 'done',
        },
      ],
    },
    assert_json: {
      description: 'Assert a JSON file.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          assert: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_json',
          path: 'subject.json',
          assert: count,
          intent: 'Check JSON',
          next: 'done',
        },
      ],
    },
    call: {
      description: 'Call a recipe.',
      examples: [{ action: 'call', ref: 'child', intent: 'Check the child', next: 'done' }],
    },
    end: { description: 'Complete the recipe.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

function recipe(assertion: unknown, action = 'assert_output'): Record<string, unknown> {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Observed assertion preflight',
    description: 'Validate assertions before any action runs.',
    paramsSchema: {
      type: 'object',
      properties: { field: { type: 'string', default: '$.durationMs' } },
      additionalProperties: false,
    },
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'wait', duration_ms: 0, intent: 'Observe the duration', next: 'check' },
        check: {
          action,
          ...(action === 'assert_json' ? { path: 'subject.json' } : { source: 'read' }),
          assert: assertion,
          intent: 'Check the observation',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

test('preflight rejects resolved and nested bad paths without effects or artifacts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-assertion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }).map(
      (entry) => ({
        ...entry,
        execute: async () => {
          executions += 1;
          return {};
        },
      }),
    ),
  });
  const request = { projectRoot: root, artifactsDir: path.join(root, 'artifacts'), source };
  for (const action of ['assert_output', 'assert_json']) {
    await assert.rejects(
      runner.preflight({
        ...request,
        recipeDocument: recipe(
          { all: [{ any: [{ path: 'pathname', operator: 'exists' }] }] },
          action,
        ),
      }),
      /Node check\.assert\.all\[0\]\.any\[0\]\.path/u,
    );
    await assert.rejects(
      runner.preflight({
        ...request,
        recipeDocument: recipe({ path: '{{params.field}}', operator: 'exists' }, action),
        params: { field: 'pathname' },
      }),
      /received pathname/u,
    );
  }
  await runner.preflight({
    ...request,
    recipeDocument: recipe({
      all: [
        { path: '{{outputs.read.path}}', operator: 'eq', value: '{{outputs.read.value}}' },
        { path: '$.durationMs', operator: 'eq', value: 0 },
      ],
    }),
  });
  await assert.rejects(
    runner.preflight({
      ...request,
      recipeDocument: recipe({
        all: [
          { path: '{{outputs.read.path}}', operator: 'exists' },
          { path: 'pathname', operator: 'exists' },
        ],
      }),
    }),
    /received pathname/u,
  );
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'recipes'), { recursive: true });
  await writeFile(
    path.join(library, 'recipes', 'child.recipe.json'),
    JSON.stringify(recipe({ path: '{{params.field}}', operator: 'exists' })),
  );
  const parent = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Called assertion',
    description: 'Validate the selected child parameters.',
    workflow: {
      entry: 'child',
      nodes: {
        child: {
          action: 'call',
          ref: 'child',
          params: { field: 'pathname' },
          intent: 'Check child',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  await assert.rejects(
    runner.preflight({
      ...request,
      recipeDocument: parent,
      librarySources: [{ root: library, provenance: source }],
    }),
    /Node child\/check\.assert\.path/u,
  );
  assert.equal(executions, 0);
  assert.equal(existsSync(request.artifactsDir), false);
});
