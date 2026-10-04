// Real browser inputs and encoded-frame inspection; no UI state injection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

import {
  digestRecipeDocument,
  type RecipeActionManifestDocument,
  type RecipeRecordingTimelineDocument,
} from '@farmslot/protocol';
import { createRecipeRunner } from '../packages/recipe-runner/src/core/runner.js';
import { createStandardCoreAdapters } from '../packages/recipe-runner/src/adapters/core.js';
import { createStandardUiAdapters } from '../packages/recipe-runner/src/adapters/ui.js';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  type CdpTargetInfo,
} from '../packages/recipe-runner/src/runtime/cdp.js';
import { createCdpVideoRecorder } from '../packages/recipe-runner/src/recording/cdp-video-recorder.js';
import { createCaptureHelperVideoRecorder } from '../packages/recipe-runner/src/recording/capture-helper.js';

const cdpPort = Number(process.env.FARMSLOT_CDP_PORT ?? 19223);
assert.ok([19222, 19223, 19224].includes(cdpPort), 'Use an isolated Agent Chrome profile');
const root = path.resolve(
  process.env.FARMSLOT_TIMELINE_PROOF_DIR ?? 'temp/recording-timeline-proof',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(path.join(root, 'library/recipes/shared'), { recursive: true });
const title = `Recording timeline validation ${path.basename(root)}`;
const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{background:rgb(240,0,0);font:24px system-ui;padding:40px}button{font:24px system-ui;padding:20px;margin:10px}h1{background:white;padding:20px}</style>
<h1>Recording timeline validation</h1><button id="green" onclick="document.body.style.background='rgb(0,224,0)'">Green</button>
<button id="blue" onclick="document.body.style.background='rgb(0,0,240)'">Blue</button>
<button id="red" onclick="document.body.style.background='rgb(240,0,0)'">Red</button>`;
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/recording-timeline-proof`;
const target = (await (
  await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
).json()) as CdpTargetInfo;
let page: CdpWebPage | undefined;
try {
  page = await CdpWebPage.connectToTarget(target);
  await page.session.call('Page.bringToFront');
  await page.navigate(url);
  const helper = process.env.FARMSLOT_CAPTURE_HELPER;
  let windowId = target.id;
  if (helper) {
    const windows = JSON.parse(
      execFileSync(helper, ['list', '--json'], { encoding: 'utf8' }),
    ).windows;
    const owned = windows.find(
      (window: { title: string; app: string; width: number }) =>
        window.title.includes(title) && window.app === 'Google Chrome Canary' && window.width > 300,
    );
    assert.ok(owned, 'Resolve only the dedicated recording proof window');
    windowId = String(owned.id);
  }
  const actions = ['wait', 'call', 'end', 'ui.press', 'ui.screenshot'];
  const sourceManifest = JSON.parse(
    await readFile('docs/examples/recipes/example-browser-v1.action-manifest.json', 'utf8'),
  );
  sourceManifest.actions.wait = {
    description: 'Retain a visible state for a measured interval.',
    schema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
      additionalProperties: false,
    },
    examples: [{ action: 'wait', ms: 100, intent: 'Observe the current state.', next: 'done' }],
  };
  const manifest: RecipeActionManifestDocument = {
    ...sourceManifest,
    actions: Object.fromEntries(actions.map((action) => [action, sourceManifest.actions[action]])),
  };
  // Keep known transport settling disabled so the proof includes fast inputs.
  const press = manifest.actions['ui.press']!;
  press.schema = {
    ...press.schema,
    properties: { ...(press.schema as any).properties, settle: { type: 'boolean' } },
  };
  const child = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Press a real button, retain a screenshot and wait for a parameterized interval.',
    paramsSchema: {
      type: 'object',
      properties: { color: { type: 'string' }, hold: { type: 'number' } },
      required: ['color', 'hold'],
      additionalProperties: false,
    },
    workflow: {
      entry: 'press',
      nodes: {
        press: {
          action: 'ui.press',
          selector: '#{{params.color}}',
          settle: false,
          intent: 'Show {{params.color}} using a real button press.',
          next: 'capture',
        },
        capture: {
          action: 'ui.screenshot',
          path: 'screenshots/{{params.color}}.png',
          intent: 'Retain the resulting color without altering the application.',
          next: 'hold',
        },
        hold: {
          action: 'wait',
          ms: '{{params.hold}}',
          intent: 'Keep the captured state visible for a measured interval.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  await writeFile(
    path.join(root, 'library/recipes/shared/color.recipe.json'),
    JSON.stringify(child),
  );
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Validate recording time through composed real browser interactions.',
    workflow: {
      entry: 'initial',
      nodes: {
        initial: {
          action: 'wait',
          ms: 350,
          intent: 'Retain the initial red screen.',
          next: 'green',
        },
        green: {
          action: 'call',
          ref: 'color',
          params: { color: 'green', hold: 1700 },
          intent: 'Hold green longer than other states.',
          next: 'blue',
        },
        blue: {
          action: 'call',
          ref: 'color',
          params: { color: 'blue', hold: 180 },
          intent: 'Capture a short blue state.',
          next: 'red',
        },
        red: {
          action: 'call',
          ref: 'color',
          params: { color: 'red', hold: 300 },
          intent: 'Return to red through the same parameterized child.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const transport = createCdpWebUiTransport({ withPage: async (_input, use) => use(page!) });
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'recording validation' },
    adapters: [
      ...createStandardCoreAdapters({ actions }),
      ...createStandardUiAdapters({ transport, actions }),
    ],
    recording: {
      videoRecorder: helper
        ? createCaptureHelperVideoRecorder({ captureHelperPath: helper })
        : createCdpVideoRecorder({ cdpPort, urlIncludes: url }),
      targetProvider: {
        async resolveRecordingTarget() {
          return { kind: 'window-id', windowId };
        },
      },
    },
  });
  const result = await runner.run({
    recipeDocument: recipe,
    artifactsDir: path.join(root, 'artifacts'),
    projectRoot: root,
    recordVideo: { mode: 'full-run', maxFps: 60 },
    librarySources: [
      {
        root: path.join(root, 'library'),
        provenance: { kind: 'library', trust: 'trusted', name: 'recording proof fixtures' },
      },
    ],
  });
  assert.equal(result.status, 'pass', `Recipe failed: ${root}`);
  const manifestResult = JSON.parse(await readFile(result.artifactManifestPath, 'utf8'));
  const video = manifestResult.artifacts.find((artifact: any) => artifact.type === 'video');
  assert.ok(video?.timelinePath, video?.timelineUnavailableReason ?? 'No recording timeline');
  const timeline: RecipeRecordingTimelineDocument = JSON.parse(
    await readFile(path.join(root, 'artifacts', video.timelinePath), 'utf8'),
  );
  const trace = JSON.parse(await readFile(path.join(root, 'artifacts/trace.json'), 'utf8'));
  assert.equal(timeline.traceDigest, digestRecipeDocument(trace));
  const videoPath = path.join(root, 'artifacts', video.path);
  // Sample a corner away from controls for every decoded frame, without re-timing it.
  const pixels = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    videoPath,
    '-vf',
    'crop=2:2:iw*0.8:ih*0.8,scale=1:1',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  assert.equal(pixels.length / 3, timeline.framesMs.length);
  const firstColor = (channel: number) =>
    timeline.framesMs.findIndex(
      (_time, i) =>
        pixels[i * 3 + channel]! > 180 &&
        pixels[i * 3 + ((channel + 1) % 3)]! < 40 &&
        pixels[i * 3 + ((channel + 2) % 3)]! < 40,
    );
  const observations: Record<string, unknown> = {};
  for (const [color, channel] of [
    ['green', 1],
    ['blue', 2],
    ['red', 0],
  ] as const) {
    const capture = timeline.markers.find((marker) => marker.nodeId === `${color}/capture`)!;
    const at = (capture.endRangeMs[0] + capture.endRangeMs[1]) / 2;
    const frame = timeline.framesMs.findLastIndex((time) => time <= at);
    assert.ok(frame >= 0, `${color} capture must be within recorded footage`);
    assert.ok(
      pixels[frame * 3 + channel]! > 180 &&
        pixels[frame * 3 + ((channel + 1) % 3)]! < 40 &&
        pixels[frame * 3 + ((channel + 2) % 3)]! < 40,
      `${color} capture at ${at} ms must display its actual color; frame ${timeline.framesMs[frame]} has RGB ${[...pixels.subarray(frame * 3, frame * 3 + 3)]}`,
    );
    observations[`${color}Capture`] = { at, frameTimeMs: timeline.framesMs[frame] };
  }
  for (const [color, channel] of [
    ['green', 1],
    ['blue', 2],
  ] as const) {
    const frame = firstColor(channel);
    assert.ok(frame >= 0, `${color} must be present in actual encoded pixels`);
    const marker = timeline.markers.find(
      (marker) => marker.action === 'ui.press' && marker.nodeId.startsWith(`${color}/`),
    );
    assert.ok(marker, `Composed ${color} action must retain its namespace`);
    const observedMs = timeline.framesMs[frame]!;
    assert.ok(
      observedMs >= marker.startRangeMs[0] - 5 && observedMs <= marker.endRangeMs[1] + 250,
      `${color} frame ${observedMs} must match the action window ${JSON.stringify(marker)}`,
    );
    observations[color] = { frame, observedMs, marker };
  }
  const greenMs = timeline.framesMs[firstColor(1)]!;
  const blueMs = timeline.framesMs[firstColor(2)]!;
  assert.ok(
    blueMs - greenMs >= 1650,
    'Video must preserve the long green hold, not redistribute sparse frames at a fixed FPS',
  );
  const evidence = {
    pass: true,
    recorder: video.recorder?.name,
    clockSource: timeline.clock.source,
    root,
    video: video.path,
    videoDigest: timeline.videoDigest,
    frames: timeline.framesMs.length,
    durationMs: timeline.durationMs,
    alignmentWindowMs: timeline.clock.latestZeroUnixMs - timeline.clock.earliestZeroUnixMs,
    observations,
  };
  await writeFile(path.join(root, 'live-proof.json'), JSON.stringify(evidence, null, 2));
  const destination = process.env.FARMSLOT_RECORDING_VIEWER_WORKER_ARTIFACTS;
  if (destination) {
    const resolved = await realpath(destination);
    const scratch = await realpath('temp');
    assert.ok(
      resolved.startsWith(`${scratch}${path.sep}`),
      'Stage recording proof only into checkout-local scratch',
    );
    assert.match(
      await readFile(path.join(resolved, '../TASK.md'), 'utf8'),
      /^# Disposable recording viewer validation/,
    );
    await cp(path.join(root, 'artifacts'), resolved, { recursive: true });
    await writeFile(path.join(resolved, 'recording-live-proof.json'), JSON.stringify(evidence));
  }
  console.log(JSON.stringify(evidence));
} finally {
  page?.session.close();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
  server.close();
}
