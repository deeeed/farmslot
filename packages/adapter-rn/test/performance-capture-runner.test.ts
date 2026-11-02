import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeUiTransportQuietly, runExpoRecipeDocument } from '../src/runner.js';
import { clearMobileToolPathCache } from '../src/tool-paths.js';

import { matchesObject } from './_helpers.js';

const HEADER =
  'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,FrameDeadline,FrameStartTime,FrameInterval,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,';

// A device whose uptime is 1 s at the clock sync: ten frames at 90 Hz, 50 ms later.
function framestats(): string {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const vsync = 1_050_000_000 + index * 11_111_111;
    return `0,${index + 1},${vsync},${vsync},0,0,0,0,0,${vsync + 22_000_000},0,11111111,${vsync + 3_000_000},0,0,0,${vsync + 8_000_000},`;
  });
  return [
    'Uptime: 1000 Realtime: 2000',
    '---PROFILEDATA---',
    HEADER,
    ...rows,
    '---PROFILEDATA---',
  ].join('\n');
}

test('a recipe measures a window on the device and reports it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adapter-rn-perf-run-'));
  const adb = path.join(root, 'adb');
  const calls = path.join(root, 'adb-calls.log');
  await writeFile(path.join(root, 'framestats.txt'), framestats());
  await writeFile(
    adb,
    `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$*" in *framestats*) cat "${path.join(root, 'framestats.txt')}";; esac\n`,
  );
  await chmod(adb, 0o755);
  const template = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('../templates/scripts/agentic/recipe/action-manifest.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { actions: Record<string, unknown> };
  template.actions['app.performance_capture'] = {
    description: 'Measure native frames.',
    execution_capabilities: [],
    schema: {
      type: 'object',
      properties: {
        phase: { type: 'string' },
        id: { type: 'string' },
        budget: { type: 'object', additionalProperties: true },
      },
      required: ['phase'],
      additionalProperties: false,
    },
    examples: [
      {
        action: 'app.performance_capture',
        intent: 'Report every window.',
        phase: 'report',
        next: 'done',
      },
    ],
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(template));
  const recipePath = path.join(root, 'recipe.json');
  await writeFile(
    recipePath,
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Measure a short window and report it.',
      proofTargets: [{ id: 'smooth', claim: 'The window holds its budget.', proofMode: 'state' }],
      workflow: {
        entry: 'start',
        nodes: {
          start: {
            action: 'app.performance_capture',
            intent: 'Start measuring.',
            phase: 'start',
            id: 'idle',
            next: 'hold',
          },
          hold: { action: 'wait', intent: 'Let frames render.', duration_ms: 900, next: 'stop' },
          stop: {
            action: 'app.performance_capture',
            intent: 'Close the window.',
            phase: 'end',
            id: 'idle',
            budget: { min_sustained_fps: 30, min_frames: 5 },
            next: 'report',
          },
          report: {
            action: 'app.performance_capture',
            intent: 'Fail on a broken budget.',
            phase: 'report',
            next: 'check',
          },
          check: {
            action: 'assert_output',
            intent: 'Every window held its budget.',
            source: 'report',
            assert: { path: '$.verdict', operator: 'eq', value: 'pass' },
            proves: ['smooth'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  const saved = { ...process.env };
  Object.assign(process.env, {
    PLATFORM: 'android',
    ADB_SERIAL: 'emulator-5554',
    FARMSLOT_RECIPE_APP_ID: 'com.example.app',
    RECIPE_RN_ADB_PATH: adb,
  });
  clearMobileToolPathCache();
  try {
    const artifactsDir = path.join(root, 'artifacts');
    const result = await runExpoRecipeDocument(recipePath, {
      projectRoot: root,
      manifestPath,
      artifactsDir,
    });
    assert.equal(result.status, 'pass');
    const report: unknown = JSON.parse(
      await readFile(path.join(artifactsDir, 'performance/report.json'), 'utf8'),
    );
    assert.ok(
      matchesObject(report, {
        verdict: 'pass',
        windows: [{ id: 'idle', frames: { frameCount: 10 }, budget: { verdict: 'pass' } }],
      }),
    );
    const log = await readFile(calls, 'utf8');
    assert.match(log, /-s emulator-5554 shell dumpsys gfxinfo com\.example\.app reset/u);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    clearMobileToolPathCache();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cleanup that rejects is logged, never thrown', async () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    await closeUiTransportQuietly(
      {
        async close() {
          throw new Error('adb: device offline');
        },
      },
      'Performance capture',
    );
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(warnings, ['Performance capture cleanup failed: adb: device offline']);
});
