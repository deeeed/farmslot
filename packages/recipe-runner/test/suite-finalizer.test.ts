import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  RECIPE_PROTOCOL_SCHEMA_URL,
  RECIPE_SUITE_SCOPE_SCHEMA_URL,
  type RecipeActionManifestDocument,
  validateRecipeSuitePackage,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { finalizeRecipeSuite, freezeRecipeSuiteScope } from '../src/core/suite.js';
import type { VideoRecorder } from '../src/core/types.js';

const actionManifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Run a real child process.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        additionalProperties: false,
      },
      execution_capabilities: ['host-exec'],
      examples: [
        {
          action: 'command',
          intent: 'Run the retained suite process.',
          cmd: 'node -e "process.exit(0)"',
          next: 'done',
        },
      ],
    },
    end: {
      description: 'Finish the recipe.',
      examples: [{ action: 'end', status: 'pass' }],
    },
  },
};

function processRecipe(exitCode: number) {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    description: 'Produce a retained summary from a real process.',
    workflow: {
      entry: 'run',
      nodes: {
        run: {
          action: 'command',
          intent: 'Run the retained suite case process.',
          cmd: `node -e "process.exit(${exitCode})"`,
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

test('finalizes real recipe results and explicit non-execution without scheduling cases', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-suite-finalizer-'));
  try {
    const runner = createRecipeRunner({
      actionManifest,
      adapters: createStandardCoreAdapters({ actions: ['command'] }),
      defaultSource: { kind: 'operator', trust: 'trusted' },
    });
    const pass = await runner.run({
      recipeDocument: processRecipe(0),
      artifactsDir: path.join(tempRoot, 'pass-run'),
      projectRoot: tempRoot,
    });
    const fail = await runner.run({
      recipeDocument: processRecipe(7),
      artifactsDir: path.join(tempRoot, 'fail-run'),
      projectRoot: tempRoot,
    });
    const scope = freezeRecipeSuiteScope({
      $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL,
      suite_id: 'suite.finalizer',
      cases: [{ id: 'passes' }, { id: 'fails' }, { id: 'manual' }],
    });
    const rejectedDir = path.join(tempRoot, 'rejected-suite');
    await assert.rejects(
      finalizeRecipeSuite({
        scope,
        outputDir: rejectedDir,
        resolutions: [{ id: 'passes', kind: 'verdict', result: pass }],
      }),
      /missing_resolution/u,
    );
    await assert.rejects(readFile(path.join(rejectedDir, 'summaries', '0001.json')), {
      code: 'ENOENT',
    });
    const finalized = await finalizeRecipeSuite({
      scope,
      outputDir: path.join(tempRoot, 'suite'),
      resolutions: [
        { id: 'passes', kind: 'verdict', result: pass },
        { id: 'fails', kind: 'verdict', result: fail },
        {
          id: 'manual',
          kind: 'not_executed',
          reason_class: 'needs_manual',
          detail: 'A human must approve the device prompt.',
        },
      ],
    });
    const retainedScope = await readJson(finalized.scopePath);
    const retainedResult = await readJson(finalized.resultPath);
    const summaries = Object.fromEntries(
      finalized.result.resolutions
        .filter((entry) => entry.kind === 'verdict')
        .map((entry) => entry.summary_path)
        .map((summaryPath) => [summaryPath, readJson(path.join(tempRoot, 'suite', summaryPath))]),
    );
    const resolvedSummaries = Object.fromEntries(
      await Promise.all(
        Object.entries(summaries).map(async ([summaryPath, promise]) => [
          summaryPath,
          await promise,
        ]),
      ),
    );
    assert.equal(
      validateRecipeSuitePackage({
        scope: retainedScope,
        result: retainedResult,
        summaries: resolvedSummaries,
      }).status,
      'valid',
    );
    assert.deepEqual(finalized.result.totals, { declared: 3, executed: 2, not_executed: 1 });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects missing cases and explicit oversight instead of inventing a reason', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-suite-incomplete-'));
  try {
    const scope = freezeRecipeSuiteScope({
      $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL,
      suite_id: 'suite.incomplete',
      cases: [{ id: 'first' }, { id: 'second' }],
    });
    await assert.rejects(
      finalizeRecipeSuite({
        scope,
        outputDir: path.join(tempRoot, 'missing'),
        resolutions: [
          {
            id: 'first',
            kind: 'not_executed',
            reason_class: 'needs_manual',
            detail: 'Requires a human.',
          },
        ],
      }),
      /missing_resolution/u,
    );
    await assert.rejects(
      finalizeRecipeSuite({
        scope,
        outputDir: path.join(tempRoot, 'oversight'),
        resolutions: [
          {
            id: 'first',
            kind: 'not_executed',
            reason_class: 'needs_manual',
            detail: 'Requires a human.',
          },
          {
            id: 'second',
            kind: 'not_executed',
            reason_class: 'oversight',
            detail: 'The caller skipped the case.',
          },
        ],
      }),
      /incomplete_oversight/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a case failed only by an interrupted recording is marked evidence_incomplete; a product failure is not', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-suite-capture-'));
  try {
    const interruption = {
      frames: 12,
      mediaTimeMs: 400,
      cause: 'SCStreamErrorDomain -3805: interrupted',
    };
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      async start(request) {
        return {
          async stop() {
            await writeFile(request.outputPath, 'partial mp4');
            return { interruption };
          },
        };
      },
    };
    const runner = createRecipeRunner({
      actionManifest,
      adapters: createStandardCoreAdapters({ actions: ['command'] }),
      defaultSource: { kind: 'operator', trust: 'trusted' },
      recording: {
        videoRecorder: recorder,
        targetProvider: { resolveRecordingTarget: async () => ({ kind: 'pid', pid: 1 }) },
      },
    });
    const run = (exitCode: number, name: string) =>
      runner.run({
        recipeDocument: processRecipe(exitCode),
        artifactsDir: path.join(tempRoot, name),
        projectRoot: tempRoot,
        recordVideo: true,
      });
    const interrupted = await run(0, 'interrupted');
    const alsoFailed = await run(7, 'also-failed');
    assert.equal(interrupted.status, 'fail');
    assert.equal(alsoFailed.status, 'fail');
    const scope = freezeRecipeSuiteScope({
      $schema: RECIPE_SUITE_SCOPE_SCHEMA_URL,
      suite_id: 'suite.capture',
      cases: [{ id: 'interrupted' }, { id: 'also-failed' }],
    });
    const finalized = await finalizeRecipeSuite({
      scope,
      outputDir: path.join(tempRoot, 'suite'),
      resolutions: [
        { id: 'interrupted', kind: 'verdict', result: interrupted },
        { id: 'also-failed', kind: 'verdict', result: alsoFailed },
      ],
    });
    const [first, second] = finalized.result.resolutions;
    assert.equal(first?.kind === 'verdict' && first.status, 'fail');
    assert.deepEqual(first?.kind === 'verdict' ? first.evidence_incomplete : undefined, {
      reason: 'capture_interrupted',
      detail: interrupted.captureInterruption?.message,
      evidence_path: 'videos/recipe-run.mp4',
    });
    assert.equal(second?.kind === 'verdict' ? second.evidence_incomplete : 'missing', undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
