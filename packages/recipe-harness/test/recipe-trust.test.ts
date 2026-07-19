import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RecipeActionManifestDocument, RecipeSourceProvenance } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { writeJsonFile } from '../src/core/json.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { canonicalRecipeJson } from '../src/core/trust.js';
import { RecipeTrustError } from '../src/core/trust-error.js';
import { resolveRecipeTrustInput } from '../src/core/trust-input.js';

const trusted: RecipeSourceProvenance = { kind: 'bundled', trust: 'trusted', name: 'test' };
const untrusted: RecipeSourceProvenance = { kind: 'task', trust: 'untrusted', name: 'pr' };
const manifest: RecipeActionManifestDocument = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: ['command', 'index_artifacts', 'call', 'end'],
};

function recipe(node: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    title: 'Trust test',
    description: 'Exercises recipe execution trust.',
    validate: {
      workflow: {
        entry: 'step',
        nodes: {
          step: { intent: 'Exercise the trust policy', ...node, next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
}

function dynamicDispatchFlows(includeLiteralDecoy = false): Record<string, unknown> {
  return {
    dispatch: {
      workflow: {
        entry: 'go',
        nodes: {
          go: {
            action: 'call',
            intent: 'Resolve a flow from a parameter',
            ref: '{{params.target}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
    ...(includeLiteralDecoy
      ? {
          '{{params.target}}': {
            workflow: {
              entry: 'done',
              nodes: { done: { action: 'end', status: 'pass' } },
            },
          },
        }
      : {}),
    danger: {
      workflow: {
        entry: 'write',
        nodes: {
          write: {
            action: 'command',
            intent: 'Write an unauthorized host file',
            cmd: 'touch pwned.txt',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
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
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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

test('flow-ref normalization cannot hide a restricted flow behind a whitespace collision', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
    });
    const document = {
      schema_version: 1,
      title: 'Flow collision test',
      description: 'Proves planning and execution resolve the same flow.',
      flows: {
        ' restricted': {
          workflow: {
            entry: 'safe',
            nodes: { safe: { action: 'end', status: 'pass' } },
          },
        },
        restricted: {
          workflow: {
            entry: 'exec',
            nodes: {
              exec: {
                intent: 'Attempt a restricted host command',
                action: 'command',
                cmd: 'touch escaped.txt',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'invoke',
          nodes: {
            invoke: {
              intent: 'Invoke the normalized flow reference',
              action: 'call',
              ref: ' restricted',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };

    await assert.rejects(
      runner.run({
        recipeDocument: document,
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: untrusted,
      }),
      /collides with another flow after whitespace normalization/u,
    );
    assert.equal(await missing(path.join(root, 'escaped.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parameter-templated call refs are rejected before hidden flow side effects', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
    });
    const artifactsDir = path.join(root, 'artifacts');
    const document = {
      schema_version: 1,
      title: 'Dynamic flow dispatch',
      description: 'A dynamic flow ref must not escape the static trust plan.',
      flows: dynamicDispatchFlows(true),
      validate: {
        workflow: {
          entry: 'dispatch',
          nodes: {
            dispatch: {
              action: 'call',
              intent: 'Dispatch to the requested flow',
              ref: 'dispatch',
              params: { target: 'danger' },
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };

    await assert.rejects(
      runner.run({
        recipeDocument: document,
        artifactsDir,
        projectRoot: root,
        source: untrusted,
      }),
      /workflow\.dynamic_call_ref/,
    );
    assert.equal(await missing(path.join(root, 'pwned.txt')), true);
    assert.equal(await missing(artifactsDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog flows cannot introduce parameter-templated call refs after validation', async () => {
  const root = await tempRoot();
  try {
    await writeJsonFile(path.join(root, 'flows.json'), {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: dynamicDispatchFlows(),
    });
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
    });
    const artifactsDir = path.join(root, 'artifacts');

    await assert.rejects(
      runner.run({
        recipeDocument: {
          ...recipe({
            action: 'call',
            ref: 'dispatch',
            params: { target: 'danger' },
          }),
          uses: ['flows.json'],
        },
        artifactsDir,
        projectRoot: root,
        source: untrusted,
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
    assert.equal(await missing(path.join(root, 'pwned.txt')), true);
    assert.equal(await missing(artifactsDir), true);
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
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }).map(
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
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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

test('untrusted recipes cannot export checkout files through index_artifacts', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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

test('untrusted recipes cannot trigger UI effects or capture screenshots', async () => {
  const root = await tempRoot();
  try {
    const executed: string[] = [];
    const runner = createRecipeRunner({
      actionManifest: {
        ...manifest,
        supported_official_actions: [
          ...manifest.supported_official_actions,
          'ui.press',
          'ui.screenshot',
        ],
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
        {
          action: 'ui.press',
          capabilities: [],
          source: trusted,
          async execute() {
            executed.push('press');
            return { status: 'pass' };
          },
        },
        {
          action: 'ui.screenshot',
          capabilities: [],
          source: trusted,
          async execute() {
            executed.push('screenshot');
            return { status: 'pass' };
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
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['end'],
        custom_actions: [{ name: 'example.read', description: 'Claims to read only.' }],
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
            return { status: 'pass' };
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

test('official action names do not make caller-provided adapters trusted', async () => {
  const root = await tempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['end'],
      },
      adapters: [
        {
          action: 'end',
          async execute() {
            return { status: 'pass' };
          },
        },
      ],
      defaultSource: trusted,
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: {
          schema_version: 1,
          title: 'Official adapter trust',
          description: 'Official names do not confer implementation trust.',
          validate: {
            workflow: {
              entry: 'done',
              nodes: { done: { action: 'end', status: 'pass' } },
            },
          },
        },
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
      }),
      (error) => error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom precondition checkers require implementation provenance', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-trust-precondition-'));
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        ...manifest,
        pre_conditions: [{ id: 'workspace.ready', description: 'Workspace is ready.' }],
      },
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
      defaultSource: trusted,
      preconditions: [
        {
          id: 'workspace.ready',
          async execute() {
            return { output: true };
          },
        },
      ],
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: {
          schema_version: 1,
          title: 'Precondition trust',
          description: 'Requires provenance for checker code.',
          validate: {
            workflow: {
              pre_conditions: ['workspace.ready'],
              entry: 'done',
              nodes: { done: { action: 'end', status: 'pass' } },
            },
          },
        },
        artifactsDir: path.join(tempRoot, 'artifacts'),
        projectRoot: tempRoot,
      }),
      (error) => error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('manifest risk metadata adds restrictions that adapters cannot remove', async () => {
  const root = await tempRoot();
  try {
    let executed = false;
    const runner = createRecipeRunner({
      actionManifest: {
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['end'],
        custom_actions: [
          {
            name: 'example.mutate',
            description: 'Mutates an external system.',
            execution_capabilities: ['external-mutation'],
          },
        ],
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.mutate',
          capabilities: [],
          source: trusted,
          async execute() {
            executed = true;
            return { status: 'pass' };
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
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['end'],
        custom_actions: [{ name: 'example.exec', description: 'Runs custom code.' }],
      },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'example.exec',
          source: { kind: 'custom-adapter', trust: 'untrusted', name: 'task action' },
          async execute() {
            return { status: 'pass' };
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
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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

test('flow provenance is enforced transitively and exact-digest approval detects changes', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    await mkdir(path.join(libraryRoot, 'flows'), { recursive: true });
    await writeJsonFile(path.join(libraryRoot, 'library.json'), {
      kind: 'recipe-library',
      schema_version: 1,
      name: 'task-library',
    });
    const catalogPath = path.join(libraryRoot, 'flows', 'task.flows.json');
    await writeJsonFile(catalogPath, {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'task.exec': {
          workflow: {
            entry: 'exec',
            nodes: {
              exec: {
                action: 'command',
                intent: 'Create the approved marker',
                cmd: 'touch approved.txt',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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
      assert.equal(error.failure.blocked?.[0]?.origin.path, undefined);
      return true;
    });
    const approved = await runner.run({ ...request, approval: { planDigest: digest } });
    assert.equal(approved.status, 'pass');
    assert.equal(await missing(path.join(root, 'approved.txt')), false);

    await writeJsonFile(catalogPath, {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'task.exec': {
          workflow: {
            entry: 'exec',
            nodes: {
              exec: {
                action: 'command',
                intent: 'Create the changed marker',
                cmd: 'touch changed.txt',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    });
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

test('untrusted callers cannot launder restricted actions through trusted library flows', async () => {
  const root = await tempRoot();
  try {
    const libraryRoot = path.join(root, 'library');
    await mkdir(path.join(libraryRoot, 'flows'), { recursive: true });
    await writeJsonFile(path.join(libraryRoot, 'library.json'), {
      kind: 'recipe-library',
      schema_version: 1,
      name: 'trusted-library',
    });
    await writeJsonFile(path.join(libraryRoot, 'flows', 'trusted.flows.json'), {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'trusted.exec': {
          workflow: {
            entry: 'exec',
            nodes: {
              exec: {
                action: 'command',
                intent: 'Create a marker through a trusted flow',
                cmd: 'touch laundered.txt',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
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

test('uses catalogs cannot escape the project root through symlinks', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  try {
    await writeJsonFile(path.join(outside, 'outside.flows.json'), {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {},
    });
    await symlink(path.join(outside, 'outside.flows.json'), path.join(root, 'linked.flows.json'));
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: manifest.supported_official_actions }),
    });
    const document = recipe({ action: 'end', status: 'pass' });
    document.uses = ['linked.flows.json'];
    await assert.rejects(
      runner.run({
        recipeDocument: document,
        artifactsDir: path.join(root, 'artifacts'),
        projectRoot: root,
        source: trusted,
      }),
      (error: unknown) =>
        error instanceof RecipeTrustError && error.code === 'RECIPE_SOURCE_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
