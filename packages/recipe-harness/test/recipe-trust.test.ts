import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type {
  RecipeActionCatalogEntry,
  RecipeActionManifestDocument,
  RecipeSourceProvenance,
} from '@farmslot/protocol';
import {
  canonicalRecipeJson,
  OFFICIAL_RECIPE_ACTIONS,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
} from '@farmslot/protocol/recipe';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { writeJsonFile } from '../src/core/json.js';
import { loadRecipeLibraries } from '../src/core/library.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { RecipeTrustError } from '../src/core/trust-error.js';
import { resolveRecipeTrustInput } from '../src/core/trust-input.js';

const trusted: RecipeSourceProvenance = { kind: 'bundled', trust: 'trusted', name: 'test' };
const untrusted: RecipeSourceProvenance = { kind: 'task', trust: 'untrusted', name: 'pr' };
const officialActions = new Set<string>(OFFICIAL_RECIPE_ACTIONS);

function testActionSchema(action: string): Record<string, unknown> {
  const properties =
    action === 'command'
      ? { cmd: { type: 'string' } }
      : action === 'index_artifacts'
        ? {
            artifacts: {
              type: 'array',
              items: { type: ['string', 'object'], additionalProperties: true },
            },
          }
        : {};
  return { type: 'object', properties, additionalProperties: false };
}

function testAction(
  action: string,
  overrides: Partial<RecipeActionCatalogEntry> = {},
): RecipeActionCatalogEntry {
  return {
    description: `Exercise ${action} trust behavior.`,
    ...(action === 'call' || action === 'end' ? {} : { schema: testActionSchema(action) }),
    ...(!officialActions.has(action) ? { execution_capabilities: [] } : {}),
    examples:
      action === 'end'
        ? [{ action, status: 'pass' }]
        : action === 'call'
          ? [
              {
                action,
                intent: 'Reuse the requested trust-policy recipe.',
                ref: 'test.child',
                params: {},
                next: 'done',
              },
            ]
          : [{ action, intent: 'Confirm the requested trust-policy state.', next: 'done' }],
    ...overrides,
  };
}

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: testAction('command', {
      description: 'Run a test command.',
      schema: testActionSchema('command'),
    }),
    index_artifacts: testAction('index_artifacts', {
      description: 'Index test artifacts.',
      schema: testActionSchema('index_artifacts'),
    }),
    call: testAction('call'),
    end: testAction('end'),
  },
};

function withOfficialActions(...actions: string[]): RecipeActionManifestDocument {
  return {
    ...manifest,
    actions: {
      ...manifest.actions,
      ...Object.fromEntries(actions.map((action) => [action, testAction(action)])),
    },
  };
}

function recipe(node: Record<string, unknown>): Record<string, unknown> {
  const terminal = node.action === 'end';
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Trust test',
    description: 'Exercises recipe execution trust.',
    workflow: {
      entry: 'step',
      nodes: {
        step: terminal ? node : { intent: 'Exercise the trust policy', ...node, next: 'done' },
        ...(terminal ? {} : { done: { action: 'end', status: 'pass' } }),
      },
    },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-trust-'));
}

async function missing(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

async function captureConsoleLog(callback: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await callback();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('trust input accepts the gateway environment contract and rejects partial provenance', () => {
  assert.deepEqual(
    resolveRecipeTrustInput(
      {},
      {
        FARMSLOT_RECIPE_SOURCE_TRUST: 'untrusted',
        FARMSLOT_RECIPE_SOURCE_KIND: 'task',
        FARMSLOT_RECIPE_SOURCE_NAME: 'pr-body',
        FARMSLOT_RECIPE_APPROVE_PLAN: 'sha256:approved',
      },
    ),
    {
      source: { trust: 'untrusted', kind: 'task', name: 'pr-body' },
      approval: { planDigest: 'sha256:approved' },
    },
  );
  assert.throws(
    () => resolveRecipeTrustInput({}, { FARMSLOT_RECIPE_SOURCE_TRUST: 'untrusted' }),
    (error: unknown) => error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
  );
  assert.throws(
    () => resolveRecipeTrustInput({}, { FARMSLOT_RECIPE_SOURCE_NAME: 'pr-body' }),
    (error: unknown) => error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
  );
});

test('inherited untrusted provenance cannot be upgraded by CLI source flags', () => {
  assert.deepEqual(
    resolveRecipeTrustInput(
      {
        sourceTrust: 'trusted',
        sourceKind: 'operator',
        sourceName: 'self-promoted',
      },
      {
        FARMSLOT_RECIPE_SOURCE_TRUST: 'untrusted',
        FARMSLOT_RECIPE_SOURCE_KIND: 'task',
        FARMSLOT_RECIPE_SOURCE_NAME: 'pr-body',
      },
    ).source,
    {
      trust: 'untrusted',
      kind: 'task',
      name: 'pr-body',
    },
  );
});

test('inherited untrusted provenance ignores CLI approval digests', () => {
  assert.deepEqual(
    resolveRecipeTrustInput(
      { approvalDigest: 'sha256:self-approved' },
      {
        FARMSLOT_RECIPE_SOURCE_TRUST: 'untrusted',
        FARMSLOT_RECIPE_SOURCE_KIND: 'task',
        FARMSLOT_RECIPE_SOURCE_NAME: 'pr-body',
      },
    ),
    {
      source: { trust: 'untrusted', kind: 'task', name: 'pr-body' },
    },
  );
});

test('canonical recipe JSON uses locale-independent code-unit key ordering', () => {
  assert.equal(
    canonicalRecipeJson({ ä: 1, z: { ß: true, A: false }, a: undefined }),
    '{"z":{"A":false,"ß":true},"ä":1}',
  );
});

test('CLI JSON trust failures expose stable code, message, and userAction', async () => {
  const root = await tempRoot();
  const priorExitCode = process.exitCode;
  try {
    const recipePath = path.join(root, 'recipe.json');
    const manifestPath = path.join(root, 'manifest.json');
    await writeJsonFile(recipePath, recipe({ action: 'command', cmd: 'touch blocked.txt' }));
    await writeJsonFile(manifestPath, manifest);
    process.exitCode = undefined;
    const output = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        recipePath,
        '--artifacts-dir',
        path.join(root, 'artifacts'),
        '--action-manifest',
        manifestPath,
        '--project-root',
        root,
        '--source-trust',
        'untrusted',
        '--source-kind',
        'task',
        '--json',
      ]),
    );
    const failure = JSON.parse(output) as Record<string, unknown>;
    assert.equal(failure.code, 'RECIPE_TRUST_REQUIRED');
    assert.equal(typeof failure.message, 'string');
    assert.equal(typeof failure.userAction, 'string');
    assert.equal(process.exitCode, 1);
    assert.equal(await missing(path.join(root, 'blocked.txt')), true);
  } finally {
    process.exitCode = priorExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted read-only recipes run while command is denied before side effects', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const safe = await runner.run({
      recipeDocument: recipe({ action: 'end', status: 'pass' }),
      artifactsDir: path.join(root, 'safe-artifacts'),
      projectRoot: root,
      source: untrusted,
    });
    assert.equal(safe.status, 'pass');

    const artifactsDir = path.join(root, 'blocked-artifacts');
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'command', cmd: 'touch blocked.txt' }),
        artifactsDir,
        projectRoot: root,
        source: {
          ...untrusted,
          name: '/private/task/recipe.json',
          path: '/private/task/recipe.json',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.equal(error.code, 'RECIPE_TRUST_REQUIRED');
        assert.deepEqual(error.failure.blocked?.[0]?.capabilities, ['host-exec']);
        assert.equal(error.failure.blocked?.[0]?.origin.name, undefined);
        assert.equal(error.failure.blocked?.[0]?.origin.path, undefined);
        return true;
      },
    );
    assert.equal(await missing(path.join(root, 'blocked.txt')), true);
    assert.equal(await missing(artifactsDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parameter-templated recipe refs are rejected before side effects', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
      defaultSource: trusted,
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'call', ref: '{{params.target}}' }),
        params: { target: 'danger' },
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
      }),
      /workflow\.dynamic_call_ref/u,
    );
    assert.equal(await missing(path.join(root, 'pwned.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('library recipes cannot introduce parameter-templated refs after root validation', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    await writeJsonFile(path.join(libraryRoot, 'recipes', 'dispatch.recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Attempts a dynamic nested recipe dispatch.',
      workflow: {
        entry: 'dispatch',
        nodes: {
          dispatch: {
            action: 'call',
            intent: 'Attempt a dynamic nested recipe dispatch.',
            ref: '{{params.target}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
      defaultSource: trusted,
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'call', ref: 'dispatch' }),
        librarySources: [{ root: libraryRoot, provenance: trusted }],
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
      }),
      /workflow\.dynamic_call_ref/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('preflight authorizes the exact plan without actions or artifact writes', async () => {
  const root = await tempRoot();
  try {
    let executed = false;
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }).map(
        (adapter) =>
          adapter.action === 'command'
            ? {
                ...adapter,
                async execute(node, context) {
                  executed = true;
                  return adapter.execute(node, context);
                },
              }
            : adapter,
      ),
    });
    const artifactsDir = path.join(root, 'preflight-artifacts');
    const request = {
      recipeDocument: recipe({ action: 'command', cmd: 'touch preflight.txt' }),
      artifactsDir,
      projectRoot: root,
      source: trusted,
    };
    const plan = await runner.preflight(request);
    assert.match(plan.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(plan.nodes[0]?.action, 'command');
    assert.equal(executed, false);
    assert.equal(await missing(path.join(root, 'preflight.txt')), true);
    assert.equal(await missing(artifactsDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('omitted programmatic provenance fails closed for restricted actions', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'command', cmd: 'touch unknown.txt' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError &&
        error.code === 'RECIPE_TRUST_REQUIRED' &&
        error.failure.trust === 'unknown',
    );
    assert.equal(await missing(path.join(root, 'unknown.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('caller source digests cannot misrepresent the loaded recipe document', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: recipe({ action: 'end', status: 'pass' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: { ...untrusted, digest: 'sha256:not-the-recipe' },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approved custom implementations are re-hashed immediately before execution', async () => {
  const root = await tempRoot();
  try {
    let currentDigest = 'sha256:adapter-v1';
    let executed = false;
    const customManifest: RecipeActionManifestDocument = {
      ...manifest,
      actions: {
        ...manifest.actions,
        'custom.exec': testAction('custom.exec', {
          schema: { type: 'object', additionalProperties: false },
          execution_capabilities: ['arbitrary-code'],
        }),
      },
    };
    const runner = createRecipeRunner({
      actionManifest: customManifest,
      adapters: [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        {
          action: 'custom.exec',
          capabilities: ['arbitrary-code'],
          source: {
            kind: 'custom-adapter',
            trust: 'untrusted',
            name: 'task adapter',
            digest: 'sha256:adapter-v1',
          },
          async resolveSourceDigest() {
            return currentDigest;
          },
          async execute() {
            executed = true;
            return { output: {} };
          },
        },
      ],
    });
    const request = {
      recipeDocument: recipe({ action: 'custom.exec' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: untrusted,
    };
    let planDigest = '';
    await assert.rejects(runner.preflight(request), (error: unknown) => {
      assert.ok(error instanceof RecipeTrustError);
      planDigest = error.failure.recipeDigest ?? '';
      return error.code === 'RECIPE_TRUST_REQUIRED';
    });
    assert.match(planDigest, /^sha256:/u);
    currentDigest = 'sha256:adapter-v2';
    const result = await runner.run({
      ...request,
      approval: { planDigest },
    });
    assert.equal(result.status, 'fail');
    assert.equal(executed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact-plan approval is bound to the execution context before side effects', async () => {
  const firstRoot = await tempRoot();
  const secondRoot = await tempRoot();
  const priorAmbient = process.env.FARMSLOT_RECIPE_CONTEXT_TEST;
  const priorApproval = process.env.FARMSLOT_RECIPE_APPROVE_PLAN;
  try {
    process.env.FARMSLOT_RECIPE_CONTEXT_TEST = 'review';
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const baseRequest = {
      recipeDocument: recipe({ action: 'command', cmd: 'touch context-marker.txt' }),
      artifactsDir: path.join(firstRoot, 'artifacts'),
      projectRoot: firstRoot,
      env: { RECIPE_MODE: 'review' },
      source: untrusted,
    };
    const blockedDigest = async (request: typeof baseRequest): Promise<string> => {
      try {
        await runner.preflight(request);
        assert.fail('expected trust preflight to reject');
      } catch (error) {
        assert.ok(error instanceof RecipeTrustError);
        assert.equal(error.code, 'RECIPE_TRUST_REQUIRED');
        return error.failure.recipeDigest ?? '';
      }
    };

    const approvedDigest = await blockedDigest(baseRequest);
    process.env.FARMSLOT_RECIPE_APPROVE_PLAN = approvedDigest;
    assert.equal(await blockedDigest(baseRequest), approvedDigest);
    delete process.env.FARMSLOT_RECIPE_APPROVE_PLAN;
    const otherArtifactsDigest = await blockedDigest({
      ...baseRequest,
      artifactsDir: path.join(firstRoot, 'other-artifacts'),
    });
    const otherEnvDigest = await blockedDigest({
      ...baseRequest,
      env: { RECIPE_MODE: 'execute' },
    });
    const undefinedEnvDigest = await blockedDigest({
      ...baseRequest,
      env: { ...baseRequest.env, OMITTED_VALUE: undefined },
    });
    assert.notEqual(otherArtifactsDigest, approvedDigest);
    assert.notEqual(otherEnvDigest, approvedDigest);
    assert.equal(undefinedEnvDigest, approvedDigest);

    process.env.FARMSLOT_RECIPE_CONTEXT_TEST = 'execute';
    await assert.rejects(
      runner.run({
        ...baseRequest,
        approval: { planDigest: approvedDigest },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
    );
    assert.equal(await missing(path.join(firstRoot, 'context-marker.txt')), true);

    const currentDigest = await blockedDigest(baseRequest);
    await assert.rejects(
      runner.run({
        ...baseRequest,
        projectRoot: secondRoot,
        artifactsDir: path.join(secondRoot, 'artifacts'),
        approval: { planDigest: currentDigest },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
    );
    assert.equal(await missing(path.join(secondRoot, 'context-marker.txt')), true);
    assert.equal(await missing(path.join(secondRoot, 'artifacts')), true);
  } finally {
    if (priorAmbient === undefined) delete process.env.FARMSLOT_RECIPE_CONTEXT_TEST;
    else process.env.FARMSLOT_RECIPE_CONTEXT_TEST = priorAmbient;
    if (priorApproval === undefined) delete process.env.FARMSLOT_RECIPE_APPROVE_PLAN;
    else process.env.FARMSLOT_RECIPE_APPROVE_PLAN = priorApproval;
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

test('exact-plan approval is bound to effective recipe parameters before side effects', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const document = recipe({ action: 'command', cmd: '{{params.cmd}}' });
    document.paramsSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        cmd: { type: 'string', default: 'touch approved-marker.txt' },
        quiet: { type: 'boolean', default: false },
      },
    };
    const request = {
      recipeDocument: document,
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: untrusted,
    };
    const blockedDigest = async (params?: Record<string, unknown>): Promise<string> => {
      try {
        await runner.preflight({ ...request, ...(params ? { params } : {}) });
        assert.fail('expected trust preflight to reject');
      } catch (error) {
        assert.ok(error instanceof RecipeTrustError);
        assert.equal(error.code, 'RECIPE_TRUST_REQUIRED');
        return error.failure.recipeDigest ?? '';
      }
    };

    const approvedDigest = await blockedDigest();
    assert.equal(
      await blockedDigest({ cmd: 'touch approved-marker.txt', quiet: false }),
      approvedDigest,
    );
    assert.notEqual(
      await blockedDigest({ cmd: 'touch changed-marker.txt', quiet: false }),
      approvedDigest,
    );
    assert.notEqual(
      await blockedDigest({ cmd: 'touch approved-marker.txt', quiet: true }),
      approvedDigest,
    );

    await assert.rejects(
      runner.run({
        ...request,
        params: { cmd: 'touch changed-marker.txt', quiet: false },
        approval: { planDigest: approvedDigest },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
    );
    assert.equal(await missing(path.join(root, 'approved-marker.txt')), true);
    assert.equal(await missing(path.join(root, 'changed-marker.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approval cannot authorize restricted values derived from mutable runtime outputs', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const document = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Rejects a command assembled from a prior runtime output.',
      workflow: {
        entry: 'produce',
        nodes: {
          produce: {
            action: 'command',
            intent: 'Produce a runtime command value.',
            cmd: "printf 'touch changed-marker.txt'",
            next: 'execute',
          },
          execute: {
            action: 'command',
            intent: 'Attempt to execute the runtime command value.',
            cmd: '{{outputs.produce.stdout}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const request = {
      recipeDocument: document,
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: untrusted,
    };

    for (const approval of [undefined, { planDigest: 'sha256:reviewed' }]) {
      await assert.rejects(
        runner.preflight({ ...request, ...(approval ? { approval } : {}) }),
        (error: unknown) =>
          error instanceof RecipeTrustError &&
          error.code === 'RECIPE_TRUST_REQUIRED' &&
          error.failure.userAction.includes('replace {{outputs.*}}'),
      );
    }
    assert.equal(await missing(path.join(root, 'changed-marker.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact-plan approval binds parameters forwarded into nested recipes', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    const childPath = path.join(libraryRoot, 'recipes', 'task', 'parameterized.recipe.json');
    await mkdir(path.dirname(childPath), { recursive: true });
    await writeJsonFile(childPath, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Executes an explicitly forwarded command.',
      paramsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cmd: { type: 'string' },
          quiet: { type: 'boolean', default: false },
        },
        required: ['cmd'],
      },
      workflow: {
        entry: 'exec',
        nodes: {
          exec: {
            action: 'command',
            intent: 'Execute the forwarded command.',
            cmd: '{{params.cmd}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    const parent = recipe({
      action: 'call',
      ref: 'task.parameterized',
      params: { cmd: '{{params.cmd}}', quiet: '{{params.quiet}}' },
    });
    parent.paramsSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        cmd: { type: 'string', default: 'touch nested-approved.txt' },
        quiet: { type: 'boolean', default: false },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const request = {
      recipeDocument: parent,
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: untrusted,
      librarySources: [{ root: libraryRoot, provenance: trusted }],
    };
    const digestFor = async (params: Record<string, unknown>): Promise<string> => {
      try {
        await runner.preflight({ ...request, params });
        assert.fail('expected trust preflight to reject');
      } catch (error) {
        assert.ok(error instanceof RecipeTrustError);
        return error.failure.recipeDigest ?? '';
      }
    };
    const approvedDigest = await digestFor({ cmd: 'touch nested-approved.txt', quiet: false });
    assert.notEqual(
      await digestFor({ cmd: 'touch nested-changed.txt', quiet: false }),
      approvedDigest,
    );
    assert.notEqual(
      await digestFor({ cmd: 'touch nested-approved.txt', quiet: true }),
      approvedDigest,
    );
    await assert.rejects(
      runner.run({
        ...request,
        params: { cmd: 'touch nested-changed.txt', quiet: false },
        approval: { planDigest: approvedDigest },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
    );
    assert.equal(await missing(path.join(root, 'nested-approved.txt')), true);
    assert.equal(await missing(path.join(root, 'nested-changed.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit execution environments exclude ambient host control variables', async () => {
  const root = await tempRoot();
  const priorAmbient = process.env.FARMSLOT_RECIPE_CONTEXT_TEST;
  try {
    process.env.FARMSLOT_RECIPE_CONTEXT_TEST = 'preview';
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const request = {
      recipeDocument: recipe({ action: 'command', cmd: 'touch explicit-env-marker.txt' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      env: { PATH: process.env.PATH, RECIPE_MODE: 'review' },
      inheritProcessEnv: false,
      source: untrusted,
    };
    let planDigest = '';
    try {
      await runner.preflight(request);
      assert.fail('expected trust preflight to reject');
    } catch (error) {
      assert.ok(error instanceof RecipeTrustError);
      planDigest = error.failure.recipeDigest ?? '';
    }

    process.env.FARMSLOT_RECIPE_CONTEXT_TEST = 'execute';
    const result = await runner.run({
      ...request,
      approval: { planDigest },
    });
    assert.equal(result.status, 'pass');
    assert.equal(await missing(path.join(root, 'explicit-env-marker.txt')), false);
  } finally {
    if (priorAmbient === undefined) delete process.env.FARMSLOT_RECIPE_CONTEXT_TEST;
    else process.env.FARMSLOT_RECIPE_CONTEXT_TEST = priorAmbient;
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted recipes cannot export checkout files through index_artifacts', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    await writeFile(path.join(root, '.env'), 'SECRET=value\n');
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({
          action: 'index_artifacts',
          artifacts: [{ path: '.env', type: 'log' }],
        }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: untrusted,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.deepEqual(error.failure.blocked?.[0]?.capabilities, ['host-read-export']);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('passive observers are capability- and digest-bound before execution', async () => {
  const root = await tempRoot();
  try {
    const action = testAction('demo.inspect', {
      schema: { type: 'object', additionalProperties: false },
      execution_capabilities: [],
    });
    const baseManifest: RecipeActionManifestDocument = {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        'demo.inspect': action,
        end: testAction('end'),
      },
    };
    const adapter = {
      action: 'demo.inspect',
      capabilities: [] as const,
      source: trusted,
      async execute() {
        return {};
      },
      async observe() {
        return { observations: { 'ui.screen': { name: 'Home' } } };
      },
    };
    const createRunner = (actionManifest: RecipeActionManifestDocument) =>
      createRecipeRunner({ actionManifest, adapters: [adapter] });
    const request = {
      recipeDocument: recipe({ action: 'demo.inspect' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: trusted,
    };
    const plainPlan = await createRunner(baseManifest).preflight(request);
    const observedManifest: RecipeActionManifestDocument = {
      ...baseManifest,
      observers: [{ ref: 'ui.screen', default_for: ['demo.inspect'] }],
    };
    const observedRunner = createRunner(observedManifest);
    const observedPlan = await observedRunner.preflight(request);
    const observedNode = observedPlan.nodes.find((node) => node.action === 'demo.inspect');

    assert.notEqual(observedPlan.digest, plainPlan.digest);
    assert.deepEqual(observedNode?.observerRefs, ['ui.screen']);
    assert.deepEqual(observedNode?.capabilities, ['host-read-export']);
    await assert.rejects(
      observedRunner.preflight({ ...request, source: untrusted }),
      (error: unknown) =>
        error instanceof RecipeTrustError &&
        error.code === 'RECIPE_TRUST_REQUIRED' &&
        error.failure.blocked?.[0]?.capabilities.includes('host-read-export') === true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted recipes cannot trigger UI effects or capture screenshots', async () => {
  const root = await tempRoot();
  try {
    const executed: string[] = [];
    const runner = createRecipeRunner({
      actionManifest: withOfficialActions('ui.press', 'ui.screenshot'),
      adapters: [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        {
          action: 'ui.press',
          capabilities: [],
          source: trusted,
          async execute() {
            executed.push('press');
            return { output: {} };
          },
        },
        {
          action: 'ui.screenshot',
          capabilities: [],
          source: trusted,
          async execute() {
            executed.push('screenshot');
            return { output: {} };
          },
        },
      ],
    });
    for (const action of ['ui.press', 'ui.screenshot']) {
      await assert.rejects(
        runner.run({
          recipeDocument: recipe({ action }),
          artifactsDir: path.join(root, `${action}-artifacts`),
          projectRoot: root,
          source: untrusted,
        }),
        (error: unknown) =>
          error instanceof RecipeTrustError && error.code === 'RECIPE_TRUST_REQUIRED',
      );
    }
    assert.deepEqual(executed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom adapters default to arbitrary code and cannot self-downgrade', async () => {
  const root = await tempRoot();
  try {
    let executed = false;
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          end: testAction('end'),
          'example.read': testAction('example.read', {
            description: 'Claims to read only.',
            schema: { type: 'object', additionalProperties: false },
            execution_capabilities: [],
          }),
        },
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.read',
          capabilities: [],
          source: {
            kind: 'custom-adapter',
            trust: 'untrusted',
            name: 'task action',
            digest: 'sha256:adapter-v1',
          },
          async execute() {
            executed = true;
            return { output: {} };
          },
        },
      ],
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'example.read' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: trusted,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.ok(error.failure.blocked?.[0]?.capabilities.includes('arbitrary-code'));
        return true;
      },
    );
    assert.equal(executed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom adapter capabilities are unique in public trust failures', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          end: testAction('end'),
          'example.exec': testAction('example.exec', {
            schema: { type: 'object', additionalProperties: false },
            execution_capabilities: ['arbitrary-code'],
          }),
        },
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.exec',
          source: {
            kind: 'custom-adapter',
            trust: 'untrusted',
            digest: 'sha256:adapter-v1',
          },
          async execute() {
            return { output: {} };
          },
        },
      ],
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: recipe({ action: 'example.exec' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: trusted,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.deepEqual(error.failure.blocked?.[0]?.capabilities, ['arbitrary-code']);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official action names do not make caller-provided implementations trusted', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          command: testAction('command', {
            description: 'Run a command.',
            schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false,
            },
            examples: [
              {
                action: 'command',
                intent: 'Run the trust-policy probe.',
                cmd: 'true',
                next: 'done',
              },
            ],
          }),
          end: testAction('end'),
        },
      },
      adapters: [
        {
          action: 'command',
          async execute() {
            return { output: {} };
          },
        },
      ],
      defaultSource: trusted,
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: recipe({ action: 'command', cmd: 'true' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
      }),
      (error) => error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest risk metadata adds restrictions that adapters cannot remove', async () => {
  const root = await tempRoot();
  try {
    let executed = false;
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          end: testAction('end'),
          'example.mutate': testAction('example.mutate', {
            description: 'Mutates an external system.',
            schema: { type: 'object', additionalProperties: false },
            execution_capabilities: ['external-mutation'],
          }),
        },
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.mutate',
          capabilities: [],
          source: trusted,
          async execute() {
            executed = true;
            return { output: {} };
          },
        },
      ],
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'example.mutate' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: untrusted,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.ok(error.failure.blocked?.[0]?.capabilities.includes('external-mutation'));
        return true;
      },
    );
    assert.equal(executed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('approval cannot authorize custom implementation code without a digest', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          end: testAction('end'),
          'example.exec': testAction('example.exec', {
            description: 'Runs custom code.',
            schema: { type: 'object', additionalProperties: false },
            execution_capabilities: ['arbitrary-code'],
          }),
        },
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.exec',
          source: { kind: 'custom-adapter', trust: 'untrusted', name: 'task action' },
          async execute() {
            return { output: {} };
          },
        },
      ],
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'example.exec' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: trusted,
        approval: { planDigest: 'sha256:not-enough' },
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted recipes require exact approval before starting video capture', async () => {
  const root = await tempRoot();
  try {
    let recordingStarts = 0;
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
      recording: {
        videoRecorder: {
          name: 'test',
          async start() {
            recordingStarts += 1;
            return {
              async stop() {
                return {};
              },
            };
          },
        },
      },
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'end', status: 'pass' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: untrusted,
        recordVideo: {
          mode: 'full-run',
          target: { kind: 'window-id', windowId: '1' },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.equal(error.failure.blocked?.[0]?.action, 'recording');
        return true;
      },
    );
    assert.equal(recordingStarts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic HUD implementation is included in trust preflight', async () => {
  const root = await tempRoot();
  try {
    let hudExecutions = 0;
    const runner = createRecipeRunner({
      actionManifest: withOfficialActions('app.hud'),
      adapters: [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        {
          action: 'app.hud',
          source: {
            kind: 'custom-adapter',
            trust: 'untrusted',
            name: 'task HUD',
            digest: 'sha256:hud-v1',
          },
          async resolveSourceDigest() {
            return 'sha256:hud-v1';
          },
          async execute() {
            hudExecutions += 1;
            return { output: {} };
          },
        },
      ],
      defaultSource: trusted,
    });
    const request = {
      recipeDocument: recipe({ action: 'end', status: 'pass' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
    };
    let planDigest = '';
    await assert.rejects(runner.preflight(request), (error: unknown) => {
      assert.ok(error instanceof RecipeTrustError);
      planDigest = error.failure.recipeDigest ?? '';
      const hudNode = error.failure.blocked?.find((node) => node.nodeId === 'run:hud');
      assert.equal(hudNode?.action, 'app.hud');
      assert.ok(hudNode?.capabilities.includes('app-mutation'));
      assert.ok(hudNode?.capabilities.includes('arbitrary-code'));
      return error.code === 'RECIPE_TRUST_REQUIRED';
    });
    assert.equal(hudExecutions, 0);

    const approved = await runner.run({ ...request, approval: { planDigest } });
    assert.equal(approved.status, 'pass');
    assert.ok(hudExecutions > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted recipes cannot trigger automatic HUD mutations before approval', async () => {
  const root = await tempRoot();
  try {
    let hudExecutions = 0;
    const runner = createRecipeRunner({
      actionManifest: withOfficialActions('app.hud'),
      adapters: [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        {
          action: 'app.hud',
          source: trusted,
          async execute() {
            hudExecutions += 1;
            return { output: {} };
          },
        },
      ],
    });
    const request = {
      recipeDocument: recipe({ action: 'end', status: 'pass' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: untrusted,
    };
    let planDigest = '';
    await assert.rejects(runner.preflight(request), (error: unknown) => {
      assert.ok(error instanceof RecipeTrustError);
      planDigest = error.failure.recipeDigest ?? '';
      const hudNode = error.failure.blocked?.find((node) => node.nodeId === 'run:hud');
      assert.deepEqual(hudNode?.capabilities, ['app-mutation']);
      return error.code === 'RECIPE_TRUST_REQUIRED';
    });
    assert.equal(hudExecutions, 0);

    const approved = await runner.run({ ...request, approval: { planDigest } });
    assert.equal(approved.status, 'pass');
    assert.ok(hudExecutions > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recipe dependency provenance is transitive and approval is digest-bound', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    const recipePath = path.join(libraryRoot, 'recipes', 'task', 'exec.recipe.json');
    await mkdir(path.dirname(recipePath), { recursive: true });
    const writeDependency = async (marker: string) =>
      writeJsonFile(
        recipePath,
        recipe({
          action: 'command',
          intent: `Create the ${marker} marker.`,
          cmd: `touch ${marker}.txt`,
        }),
      );
    await writeDependency('approved');

    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    const request = {
      recipeDocument: recipe({ action: 'call', ref: 'task.exec' }),
      artifactsDir: path.join(root, 'artifacts'),
      projectRoot: root,
      source: trusted,
      librarySources: [{ root: libraryRoot, provenance: untrusted }],
    };
    let digest = '';
    await assert.rejects(runner.run(request), (error: unknown) => {
      assert.ok(error instanceof RecipeTrustError);
      digest = error.failure.recipeDigest ?? '';
      const blocked = error.failure.blocked?.find((node) => node.action === 'command');
      assert.equal(blocked?.origin.trust, 'untrusted');
      assert.equal(blocked?.origin.path, undefined);
      return error.code === 'RECIPE_TRUST_REQUIRED';
    });

    const approved = await runner.run({ ...request, approval: { planDigest: digest } });
    assert.equal(approved.status, 'pass');
    assert.equal(await missing(path.join(root, 'approved.txt')), false);

    await writeDependency('changed');
    await assert.rejects(
      runner.run({ ...request, approval: { planDigest: digest } }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
    );
    assert.equal(await missing(path.join(root, 'changed.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted callers cannot launder restricted actions through trusted recipes', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    const recipePath = path.join(libraryRoot, 'recipes', 'trusted', 'exec.recipe.json');
    await mkdir(path.dirname(recipePath), { recursive: true });
    await writeJsonFile(
      recipePath,
      recipe({
        action: 'command',
        intent: 'Create a marker through a trusted recipe.',
        cmd: 'touch laundered.txt',
      }),
    );
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    });
    await assert.rejects(
      runner.run({
        recipeDocument: recipe({ action: 'call', ref: 'trusted.exec' }),
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: untrusted,
        librarySources: [{ root: libraryRoot, provenance: trusted }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        const blocked = error.failure.blocked?.find((node) => node.action === 'command');
        assert.equal(blocked?.origin.trust, 'trusted');
        assert.equal(blocked?.invocationOrigin?.trust, 'untrusted');
        return true;
      },
    );
    assert.equal(await missing(path.join(root, 'laundered.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('library recipe symlinks cannot escape the library root', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  try {
    await mkdir(path.join(root, 'recipes'), { recursive: true });
    const outsideRecipe = path.join(outside, 'outside.recipe.json');
    await writeJsonFile(outsideRecipe, recipe({ action: 'end', status: 'pass' }));
    await symlink(outsideRecipe, path.join(root, 'recipes', 'linked.recipe.json'));
    await assert.rejects(
      loadRecipeLibraries([{ root, provenance: trusted }]),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
