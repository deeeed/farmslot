/** Live tier: an owned app/device, actual recipe execution and retained HUD media. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgentDeviceUiTransport } from '../../packages/adapter-rn/src/agent-device-ui-transport.js';
import { createMetroRecipeBridgeUiTransport } from '../../packages/adapter-rn/src/metro-recipe-bridge-transport.js';
import { createAndroidVideoRecorder } from '../../packages/adapter-rn/src/video-recorder.js';
import {
  hudRenderExpression,
  nextHudState,
} from '../../packages/adapter-web/src/web-dapp/lib/hud.mjs';
import { validateRecordedEvidencePackage } from '../../packages/adapter-sdk/src/evidence.js';
import type { RecipeActionManifestDocument } from '../../packages/protocol/src/index.js';
import {
  createCdpVideoRecorder,
  createRecipeRunner,
  createStandardCoreAdapters,
  createStandardUiAdapters,
  readRecordedEvidencePackage,
  type RecordingTarget,
  type UiActionTransport,
  type VideoRecorder,
} from '../../packages/recipe-runner/src/index.js';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  listCdpTargets,
} from '../../packages/recipe-runner/src/runtime/cdp.js';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  mode: 'native' | 'cdp' | 'web-dapp';
  projectRoot: string;
  manifestPath: string;
  output: string;
  port: number;
  origin?: string;
  serial?: string;
  app?: string;
};
assert.ok(['native', 'cdp', 'web-dapp'].includes(config.mode));
await mkdir(config.output, { recursive: true });
const catalog = JSON.parse(
  await readFile(config.manifestPath, 'utf8'),
) as RecipeActionManifestDocument;
const manifest = {
  $schema: catalog.$schema,
  actions: Object.fromEntries(
    ['end', 'app.hud', 'ui.screenshot'].map((action) => [action, catalog.actions[action]!]),
  ),
};
let page: CdpWebPage | undefined;
let native: ReturnType<typeof createAgentDeviceUiTransport> | undefined;
let target: RecordingTarget;
let transport: UiActionTransport;
let videoRecorder: VideoRecorder;
try {
  if (config.mode === 'native') {
    assert.ok(
      config.serial?.startsWith('emulator-') && config.app,
      'Require an owned emulator and app',
    );
    native = createAgentDeviceUiTransport({
      platform: 'android',
      device: config.serial,
      app: config.app,
      session: `hud-placement-${path.basename(config.output)}`,
      stateDir: path.join(config.output, 'device-session'),
    });
    const bridge = createMetroRecipeBridgeUiTransport({ port: config.port });
    transport = {
      execute: (action, node, context) =>
        action === 'app.hud'
          ? bridge.execute(action, node, context)
          : native!.execute(action, node, context),
    };
    target = { kind: 'android-device', serial: config.serial };
    videoRecorder = createAndroidVideoRecorder(config.serial);
  } else {
    assert.ok(config.origin);
    const selected = (await listCdpTargets('127.0.0.1', config.port)).find(
      (item) => item.type === 'page' && item.url.startsWith(config.origin!),
    );
    assert.ok(selected, 'Require the owned app tab');
    page = await CdpWebPage.connectToTarget(selected);
    await page.navigate(`${config.origin}/#runs`);
    const app = await page.evaluate<{ origin: string; textLength: number }>(
      '({ origin: location.origin, textLength: document.body.innerText.length })',
    );
    assert.equal(app.origin, config.origin, 'Require the app origin, not a browser error page');
    assert.ok(app.textLength > 0, 'Application must render before the proof starts');
    const base = createCdpWebUiTransport({
      getPage: async () => CdpWebPage.connectToTarget(selected),
    });
    let state: ReturnType<typeof nextHudState> | null = null;
    transport =
      config.mode === 'cdp'
        ? base
        : {
            execute: async (action, node, context) => {
              if (action !== 'app.hud') return base.execute(action, node, context);
              state = nextHudState(state, node, context.nodeId);
              return page!.evaluate(hudRenderExpression(state, config.origin));
            },
          };
    target = { kind: 'cdp-page', host: '127.0.0.1', port: config.port, targetId: selected.id };
    videoRecorder = createCdpVideoRecorder({ cdpPort: config.port, urlIncludes: config.origin });
  }
  const runner = createRecipeRunner({
    actionManifest: manifest,
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'hud-placement-qualification' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['end'] }),
      ...createStandardUiAdapters({ actions: ['app.hud', 'ui.screenshot'], transport }),
    ],
    recording: { videoRecorder },
  });
  const result = await runner.run({
    projectRoot: config.projectRoot,
    artifactsDir: config.output,
    recordVideo: { target },
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'HUD placement qualification',
      workflow: {
        entry: 'bottom',
        nodes: {
          bottom: {
            action: 'app.hud',
            intent: 'Keep the HUD visible below the application.',
            display: { position: 'bottom' },
            next: 'capture-bottom',
          },
          'capture-bottom': {
            action: 'ui.screenshot',
            intent: 'The application and its bottom caption are visible together.',
            path: 'bottom.png',
            next: 'top',
          },
          top: {
            action: 'app.hud',
            intent: 'Move the HUD away from the application footer.',
            display: { position: 'top' },
            next: 'capture-top',
          },
          'capture-top': {
            action: 'ui.screenshot',
            intent: 'The application footer is visible below the required caption.',
            path: 'top.png',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  const retained = await readRecordedEvidencePackage(config.output);
  const validation = validateRecordedEvidencePackage(retained.input);
  await writeFile(
    path.join(config.output, 'qualification.json'),
    JSON.stringify(
      {
        mode: config.mode,
        status: result.status,
        recording: result.claims.recording,
        checks: retained.checks,
        validation,
        scope:
          'Owned renderer placement proof; no project visual verdict or published gate admission',
      },
      null,
      2,
    ),
  );
  assert.equal(result.status, 'pass');
  assert.ok(retained.checks.every((check) => check.status === 'pass'));
  assert.equal(validation.status, 'valid');
  assert.equal(result.claims.recording.status, 'complete');
} finally {
  page?.close();
  await native?.close();
}
