import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import type { ActionExecutionContext } from '../src/core/types.js';

const catalog = JSON.parse(
  readFileSync(
    new URL('../../../docs/examples/recipes/farmslot-v1.action-manifest.json', import.meta.url),
    'utf8',
  ),
);
const manifest: RecipeActionManifestDocument = {
  $schema: catalog.$schema,
  actions: Object.fromEntries(
    ['watch_logs', 'command', 'end'].map((name) => [name, catalog.actions[name]]),
  ),
};
const source = { kind: 'operator', trust: 'trusted', name: 'log-observation-test' } as const;
const watch = createStandardCoreAdapters().find((adapter) => adapter.action === 'watch_logs')!;

function context(
  root: string,
  offset: number | undefined = 0,
  signal?: AbortSignal,
): ActionExecutionContext {
  return {
    nodeId: 'watch',
    recipe: {},
    projectRoot: root,
    artifactsDir: root,
    env: {},
    outputs: new Map(),
    getOutput: () => undefined,
    getRunFileOffset: () => offset,
    resolveProjectPath: (file) => path.join(root, file),
    resolveArtifactPath: (file) => path.join(root, file),
    registerArtifact: () => undefined,
    logger: console,
    signal,
  };
}

function recipe(fields: Record<string, unknown> = {}) {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    paramsSchema: {
      type: 'object',
      properties: {
        log: { type: 'string', default: 'app.log' },
        window: { type: 'integer', default: 0 },
        marker: { type: 'string', default: 'ready' },
      },
      additionalProperties: false,
    },
    workflow: {
      entry: 'watch',
      nodes: {
        watch: {
          action: 'watch_logs',
          path: '{{params.log}}',
          contains: '{{params.marker}}',
          timeout_ms: '{{params.window}}',
          intent: 'Observe readiness',
          next: 'done',
          ...fields,
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

function runner() {
  return createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    hud: false,
  });
}

test('cancelling a pending observation still executes authored teardown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const adapters = createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }).map(
    (adapter) =>
      adapter.action === 'watch_logs'
        ? {
            ...adapter,
            execute(node: Record<string, unknown>, ctx: ActionExecutionContext) {
              timer = setTimeout(() => controller.abort(), 20);
              return adapter.execute(node, ctx);
            },
          }
        : adapter,
  );
  const document = recipe({ timeout_ms: 60000 });
  try {
    const result = await createRecipeRunner({ actionManifest: manifest, adapters, hud: false }).run(
      {
        source,
        projectRoot: root,
        artifactsDir: path.join(root, 'artifacts'),
        signal: controller.signal,
        recipeDocument: {
          ...document,
          workflow: {
            ...document.workflow,
            teardown: 'cleanup',
            nodes: {
              ...document.workflow.nodes,
              cleanup: {
                action: 'command',
                cmd: 'printf cleaned > cleanup.txt',
                intent: 'Record cleanup',
                next: 'cleaned',
              },
              cleaned: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    );
    assert.equal(result.status, 'fail');
    assert.equal(await readFile(path.join(root, 'cleanup.txt'), 'utf8'), 'cleaned');
    assert.match(await readFile(result.tracePath, 'utf8'), /RECIPE_ABORTED/u);
  } finally {
    clearTimeout(timer);
  }
});

test('delayed append and creation succeed; immediate outputs remain compatible', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const exists of [false, true]) {
    const file = exists ? 'existing.log' : 'new.log';
    if (exists) await writeFile(path.join(root, file), 'old\n');
    let producer: Promise<void> | undefined;
    const timer = setTimeout(() => {
      producer = appendFile(path.join(root, file), 'ready\n');
    }, 25);
    try {
      const result = await watch.execute(
        { path: file, contains: 'ready', timeout_ms: 400 },
        context(root, exists ? 4 : 0),
      );
      assert.deepEqual(result.output, {
        path: file,
        matched: 'ready',
        scope: 'run',
        offset: exists ? 4 : 0,
        bytesScanned: 6,
      });
    } finally {
      clearTimeout(timer);
      await producer;
    }
  }
  assert.deepEqual(
    (await watch.execute({ path: 'existing.log', scope: 'file' }, context(root))).output,
    {
      path: 'existing.log',
      matched: null,
      scope: 'file',
      offset: 0,
      bytesScanned: 10,
    },
  );
  await assert.rejects(
    watch.execute({ path: 'existing.log', contains: 'ready' }, context(root, 10)),
    /does not contain/u,
  );
});

test('expiry is a subject failure; cancellation retains RECIPE_ABORTED', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.log'), 'old');
  await assert.rejects(
    watch.execute({ path: 'app.log', contains: 'absent', timeout_ms: 35 }, context(root)),
    { causeClass: 'subject' },
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(
      watch.execute(
        { path: 'app.log', contains: 'absent', timeout_ms: 60000 },
        context(root, 0, controller.signal),
      ),
      { code: 'RECIPE_ABORTED' },
    );
  } finally {
    clearTimeout(timer);
  }
});

test('truncation rebases remaining polls and missing baselines refuse before reads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.log'), '');
  let producer: Promise<void> | undefined;
  const timer = setTimeout(() => {
    producer = appendFile(path.join(root, 'app.log'), 'ready and longer');
  }, 25);
  try {
    const result = await watch.execute(
      { path: 'app.log', contains: 'ready', timeout_ms: 400 },
      context(root, 6),
    );
    assert.equal((result.output as { offset: number }).offset, 0);
  } finally {
    clearTimeout(timer);
    await producer;
  }
  const noBaseline = context(root);
  noBaseline.getRunFileOffset = () => undefined;
  await assert.rejects(
    watch.execute({ path: 'not-created.log', contains: 'ready' }, noBaseline),
    /no captured baseline/u,
  );
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  await assert.rejects(
    watch.execute(
      { path: 'outside', scope: 'file', contains: 'ready', timeout_ms: 400 },
      context(root),
    ),
    /outside|escape|within/u,
  );
});

test('root default and per-call paths capture stale content before any producer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.log'), 'ready\n');
  const request = { source, projectRoot: root, artifactsDir: path.join(root, 'default') };
  assert.equal((await runner().run({ ...request, recipeDocument: recipe() })).status, 'fail');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'recipes'), { recursive: true });
  await writeFile(path.join(library, 'recipes/child.recipe.json'), JSON.stringify(recipe()));
  await writeFile(path.join(root, 'other.log'), 'ready\n');
  const librarySources = [
    {
      name: 'logs',
      root: library,
      provenance: { kind: 'library', trust: 'trusted', name: 'logs' } as const,
    },
  ];
  const parent = {
    $schema: recipe().$schema,
    workflow: {
      entry: 'first',
      nodes: {
        first: {
          action: 'call',
          ref: 'child',
          params: { log: 'app.log', marker: 'fresh' },
          intent: 'Check first log',
          next: 'second',
        },
        second: {
          action: 'call',
          ref: 'child',
          params: { log: 'other.log' },
          intent: 'Reject stale second log',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  // Both offsets must precede the first child, which supplies the first log's fresh data.
  const adapters = createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }).map(
    (adapter) =>
      adapter.action === 'watch_logs'
        ? {
            ...adapter,
            async execute(node: Record<string, unknown>, ctx: ActionExecutionContext) {
              if (node.contains === 'fresh') await appendFile(path.join(root, 'app.log'), 'fresh');
              return adapter.execute(node, ctx);
            },
          }
        : adapter,
  );
  const result = await createRecipeRunner({ actionManifest: manifest, adapters, hud: false }).run({
    ...request,
    artifactsDir: path.join(root, 'calls'),
    recipeDocument: parent,
    librarySources,
  });
  assert.equal(result.status, 'fail');
  const trace = await readFile(result.tracePath, 'utf8');
  assert.match(trace, /other.log does not contain/u);
  await assert.rejects(
    runner().preflight({
      ...request,
      recipeDocument: {
        ...parent,
        workflow: {
          ...parent.workflow,
          nodes: {
            ...parent.workflow.nodes,
            second: { ...parent.workflow.nodes.second, params: { window: 100, marker: '' } },
          },
        },
      },
      librarySources,
    }),
    /requires nonempty contains/u,
  );
});

test('bad resolved windows and output run paths fail preflight without artifacts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { source, projectRoot: root, artifactsDir: path.join(root, 'artifacts') };
  for (const params of [{ window: 60001 }, { window: 100, marker: '' }]) {
    await assert.rejects(
      runner().preflight({ ...request, recipeDocument: recipe(), params }),
      /watch_logs|nonempty/u,
    );
  }
  await assert.rejects(
    runner().preflight({ ...request, recipeDocument: recipe({ path: '{{outputs.read.path}}' }) }),
    /explicit scope=file/u,
  );
  await runner().preflight({
    ...request,
    recipeDocument: recipe({
      path: '{{outputs.read.path}}',
      scope: 'file',
      timeout_ms: '{{outputs.read.window}}',
    }),
  });
  assert.equal(existsSync(request.artifactsDir), false);
});
