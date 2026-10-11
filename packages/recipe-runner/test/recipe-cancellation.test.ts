import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  RECIPE_PROTOCOL_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import {
  recipeExecutionSignal,
  runOwnedRecipeProcess,
  withRecipeExecutionSignal,
} from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';

const actionManifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Run the selected command.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
      },
      execution_capabilities: [],
      examples: [{ action: 'command', cmd: 'proof', intent: 'Read the proof.', next: 'done' }],
    },
    call: {
      description: 'Run a library recipe.',
      examples: [{ action: 'call', ref: 'child', intent: 'Run the child proof.', next: 'done' }],
    },
    end: {
      description: 'End the graph.',
      examples: [{ action: 'end', status: 'pass' }],
    },
  },
};

const recipeDocument = {
  $schema: RECIPE_PROTOCOL_SCHEMA_URL,
  description: 'Stop the proof on cancellation and keep its teardown.',
  workflow: {
    entry: 'proof',
    teardown: 'cleanup',
    nodes: {
      proof: { action: 'command', cmd: 'proof', intent: 'Observe the target.', next: 'later' },
      later: { action: 'command', cmd: 'later', intent: 'Change the target.', next: 'done' },
      done: { action: 'end', status: 'pass' },
      cleanup: {
        action: 'command',
        cmd: 'cleanup',
        intent: 'Restore owned state.',
        next: 'closed',
      },
      closed: { action: 'end', status: 'pass' },
    },
  },
};

test('independent runner copies share main and cleanup signal scopes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-signal-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const copy = path.join(root, 'execution-signal.ts');
  await copyFile(new URL('../src/core/execution-signal.ts', import.meta.url), copy);
  const other: typeof import('../src/core/execution-signal.js') = await import(
    pathToFileURL(copy).href
  );
  const owner = new AbortController();
  const cleanup = new AbortController();
  owner.abort('SIGTERM');
  await withRecipeExecutionSignal(owner.signal, async () => {
    await Promise.resolve();
    assert.equal(other.recipeExecutionSignal(), owner.signal);
    await other.withRecipeExecutionSignal(cleanup.signal, async () => {
      await Promise.resolve();
      assert.equal(recipeExecutionSignal(), cleanup.signal);
      assert.equal(recipeExecutionSignal()?.aborted, false);
    });
    assert.equal(recipeExecutionSignal(), owner.signal);
  });
  assert.equal(recipeExecutionSignal(), undefined);
  assert.equal(other.recipeExecutionSignal(), undefined);
});

for (const nested of [false, true]) {
  for (const when of ['before run', 'during action', 'action rejection', 'after action'] as const) {
    test(
      `${nested ? 'nested ' : ''}cancellation ${when} skips later nodes and preserves teardown`,
      { timeout: 2000 },
      async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-cancellation-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const controller = new AbortController();
        t.after(() => controller.abort('test cleanup'));
        const libraryRoot = path.join(root, 'library');
        if (nested) {
          await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
          await writeFile(
            path.join(libraryRoot, 'recipes/child.recipe.json'),
            JSON.stringify(recipeDocument),
          );
        }
        const requestedRecipe = nested
          ? {
              ...recipeDocument,
              workflow: {
                ...recipeDocument.workflow,
                nodes: {
                  ...recipeDocument.workflow.nodes,
                  proof: {
                    action: 'call',
                    ref: 'child',
                    intent: 'Run the child proof.',
                    next: 'later',
                  },
                },
              },
            }
          : recipeDocument;
        const executed: string[] = [];
        let ready!: () => void;
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const runner = createRecipeRunner({
          actionManifest,
          defaultSource: { kind: 'operator', trust: 'trusted' },
          adapters: [
            {
              action: 'command',
              source: { kind: 'bundled', trust: 'trusted' },
              async execute(node, context) {
                assert.equal(recipeExecutionSignal(), context.signal);
                const command = String(node.cmd);
                executed.push(command);
                if (command === 'cleanup') {
                  assert.equal(context.signal?.aborted ?? false, false);
                  return {};
                }
                assert.equal(context.signal, controller.signal);
                if (when === 'after action') controller.abort('SIGTERM');
                else {
                  await new Promise<void>((resolve) => {
                    context.signal!.addEventListener('abort', () => resolve(), { once: true });
                    ready();
                  });
                  if (when === 'action rejection') throw new Error('Child stopped.');
                }
                return {};
              },
            },
          ],
        });
        if (when === 'before run') controller.abort('SIGTERM');
        const run = runner.run({
          recipeDocument: requestedRecipe,
          ...(nested
            ? {
                librarySources: [
                  {
                    root: libraryRoot,
                    provenance: { kind: 'library' as const, trust: 'trusted' as const },
                  },
                ],
              }
            : {}),
          projectRoot: root,
          artifactsDir: path.join(root, 'artifacts'),
          signal: controller.signal,
        });
        if (when === 'during action' || when === 'action rejection') {
          await started;
          controller.abort('SIGTERM');
        }
        const result = await run;
        assert.equal(result.status, 'fail');
        assert.deepEqual(
          executed,
          when === 'before run'
            ? ['cleanup']
            : nested
              ? ['proof', 'cleanup', 'cleanup']
              : ['proof', 'cleanup'],
        );
        const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
        const failure = trace.find(
          (entry: { error_code?: string }) => entry.error_code === 'RECIPE_ABORTED',
        );
        assert.equal(failure.nodeId, nested && when !== 'before run' ? 'proof/proof' : 'proof');
        assert.equal(failure.cause_class, 'environment');
        assert.equal(trace.at(-1).nodeId, 'closed');
        assert.equal(trace.at(-1).ok, true);
      },
    );
  }
}

for (const ownerExits of [false, true]) {
  test(
    `foreground timeout closes inherited pipes when the owner ${ownerExits ? 'already exited' : 'is running'}`,
    { timeout: 2500, skip: process.platform === 'win32' },
    async (t) => {
      let owner = 0;
      let descendant = 0;
      t.after(() => {
        for (const pid of [owner, descendant]) {
          if (!pid) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      });
      const source = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], { stdio: 'inherit' });
        process.stdout.write(String(child.pid));
        ${ownerExits ? 'child.unref();' : ''}
      `;
      const started = Date.now();
      const result = await runOwnedRecipeProcess(process.execPath, ['-e', source], {
        cwd: os.tmpdir(),
        ownProcessGroup: false,
        timeoutMs: 250,
        onSpawn(pid) {
          owner = pid;
          return undefined;
        },
        onOutput(chunk) {
          descendant = Number(Buffer.from(chunk).toString());
        },
      });
      assert.equal(result.timedOut, true);
      assert.ok(descendant > 0, 'the inherited-pipe holder was started');
      assert.ok(Date.now() - started < 1500, 'timeout settled without waiting for the descendant');
    },
  );
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'timeout'] as const) {
  test(
    `owned command group is gone after ${signal}`,
    { timeout: 4000, skip: process.platform === 'win32' },
    async (t) => {
      const controller = new AbortController();
      let owner = 0;
      let descendant = 0;
      const childSource = `
      process.on('SIGTERM', () => {});
      process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
      setInterval(() => {}, 50);
    `;
      const source = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.pipe(process.stdout);
    `;
      t.after(() => {
        controller.abort('SIGTERM');
        if (owner) {
          try {
            process.kill(-owner, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      });
      let output = '';
      const operation = runOwnedRecipeProcess(process.execPath, ['-e', source], {
        cwd: os.tmpdir(),
        signal: controller.signal,
        timeoutMs: signal === 'timeout' ? 400 : 2000,
        onSpawn(pid) {
          owner = pid;
          return undefined;
        },
        onOutput(chunk, stream) {
          if (stream !== 'stdout') return;
          output += chunk.toString();
          if (output.includes('\n') && !descendant) {
            descendant = JSON.parse(output.trim()).pid;
            if (signal !== 'timeout') controller.abort(signal);
          }
        },
      });
      if (signal === 'timeout') assert.equal((await operation).timedOut, true);
      else await assert.rejects(operation, { code: 'RECIPE_ABORTED' });
      assert.ok(descendant > 0, 'the descendant reached its ready handshake');
      const gone = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      };
      const deadline = Date.now() + 1000;
      while ((!gone(owner) || !gone(descendant)) && Date.now() < deadline) await delay(20);
      assert.equal(gone(owner), true, 'owner was reaped');
      assert.equal(gone(descendant), true, 'descendant was reaped');
      owner = 0;
    },
  );
}
