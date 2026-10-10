// Manual live proof: yarn workspace @farmslot/recipe-runner exec tsx ../../scripts/e2e-capture-followups.mts
// Requires isolated Agent Chrome and capture-helper with native recording timing on the same Mac.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestRecipeDocument, type RecipeActionManifestDocument } from '@farmslot/protocol';
import { createStandardCoreAdapters } from '../packages/recipe-runner/src/adapters/core.js';
import { createStandardUiAdapters } from '../packages/recipe-runner/src/adapters/ui.js';
import { createRecipeRunner } from '../packages/recipe-runner/src/core/runner.js';
import type { VideoRecorder } from '../packages/recipe-runner/src/core/types.js';
import { createCaptureHelperVideoRecorder } from '../packages/recipe-runner/src/recording/capture-helper.js';
import {
  CdpSession,
  CdpWebPage,
  createCdpWebUiTransport,
  type CdpTargetInfo,
} from '../packages/recipe-runner/src/runtime/cdp.js';

const port = Number(process.env.FARMSLOT_CDP_PORT ?? 19223);
assert.ok([19222, 19223, 19224].includes(port), 'Use isolated Agent Chrome');
const helper = process.env.FARMSLOT_CAPTURE_HELPER ?? 'capture-helper';
const version = JSON.parse(execFileSync(helper, ['version', '--json'], { encoding: 'utf8' }));
assert.ok(
  ['record_session_snapshot', 'record_session_timing_v1'].every((capability) =>
    version.capabilities?.includes(capability),
  ),
  'This proof requires native timing and session snapshots',
);
const doctor = JSON.parse(execFileSync(helper, ['doctor', '--json'], { encoding: 'utf8' }));
assert.equal(doctor.ok, true, 'Capture-helper must pass its real doctor checks');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve(
  process.env.FARMSLOT_CAPTURE_PROOF_DIR ?? 'temp/capture-followups-proof',
  stamp,
);
await mkdir(root, { recursive: true });
const runnerModule = process.env.FARMSLOT_CAPTURE_PROOF_RUNNER;
const runnerFactory: typeof createRecipeRunner = runnerModule
  ? (await import(pathToFileURL(path.resolve(runnerModule)).href)).createRecipeRunner
  : createRecipeRunner;
const browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await CdpSession.connect(browserInfo.webSocketDebuggerUrl);
type OwnedPage = { id: string; page: CdpWebPage; closed: boolean };
type Event = { event: string; at: string; stopped?: boolean; status?: unknown; hud?: string[] };
type WindowBounds = { left: number; top: number; width: number; height: number };
type NativeWindow = {
  id: number;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type DomNode = {
  nodeId: number;
  attributes?: string[];
  nodeValue?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
};
const owned: OwnedPage[] = [];
const results: unknown[] = [];
const suiteEvidence = {
  pass: false,
  helper: version,
  browser: browserInfo.Browser,
  runnerModule: runnerModule ?? 'production source',
  results,
};
async function writeJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2));
}
await writeJson(path.join(root, 'proof.json'), suiteEvidence);

async function readHud(page: CdpWebPage): Promise<string[]> {
  const { root: document } = await page.session.call<{ root: DomNode }>('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  function find(value: DomNode): DomNode | undefined {
    if (value.attributes?.includes('farmslot-recipe-hud')) return value;
    for (const child of value.children ?? []) {
      const found = find(child);
      if (found) return found;
    }
  }
  const node = find(document);
  assert.ok(node, 'Evidence must show the production recipe HUD');
  const text: string[] = [];
  function visit(value: DomNode) {
    if (value.nodeValue?.trim()) text.push(value.nodeValue.trim());
    for (const child of [...(value.children ?? []), ...(value.shadowRoots ?? [])]) visit(child);
  }
  visit(node);
  assert.ok(text.length, 'CDP must read the rendered closed-shadow HUD');
  return text;
}

async function openPage(url: string): Promise<OwnedPage> {
  const { targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
    url,
    newWindow: true,
    background: true,
    width: 1000,
    height: 760,
  });
  const targets: CdpTargetInfo[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.id === targetId);
  assert.ok(target, 'Resolve the newly created owned background window');
  const item = { id: targetId, page: await CdpWebPage.connectToTarget(target), closed: false };
  owned.push(item);
  await item.page.waitForDocumentReady({ expectedUrl: url, timeoutMs: 10_000 });
  return item;
}

function action(
  description: string,
  properties: Record<string, unknown>,
  example: Record<string, unknown>,
) {
  return {
    description,
    schema: { type: 'object', properties, additionalProperties: false },
    examples: [example],
  };
}
const sourceManifest = JSON.parse(
  await readFile(
    new URL('../docs/examples/recipes/example-browser-v1.action-manifest.json', import.meta.url),
    'utf8',
  ),
);
const browserActions = Object.fromEntries(
  ['ui.press', 'ui.wait_for', 'ui.screenshot'].map((name) => [name, sourceManifest.actions[name]]),
);
Object.assign(browserActions['ui.press'].schema.properties, { settle: { type: 'boolean' } });
Object.assign(browserActions['ui.screenshot'].schema.properties, {
  fullPage: { type: 'boolean' },
  surface: { type: 'string' },
});
const manifest: RecipeActionManifestDocument = {
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: {
    end: { description: 'Finish the graph.', examples: [{ action: 'end', status: 'pass' }] },
    wait: action(
      'Keep actual footage visible.',
      { ms: { type: 'integer' } },
      { action: 'wait', ms: 100, intent: 'Hold the current state.', next: 'done' },
    ),
    ...browserActions,
    'app.hud': action(
      'Render the production HUD.',
      {},
      { action: 'app.hud', intent: 'Show progress.', next: 'done' },
    ),
    'proof.inspect': {
      ...action(
        'Read live endpoint state and actual CDP targets.',
        {},
        {
          action: 'proof.inspect',
          intent: 'Confirm the endpoint outcome against the browser target list.',
          next: 'done',
        },
      ),
      execution_capabilities: [],
    },
    assert_output: action(
      'Assert endpoint state through the production core adapter.',
      { source: { type: 'string' }, assert: { type: 'object' } },
      {
        action: 'assert_output',
        source: 'inspect',
        assert: { path: '$.state.confirmations', operator: 'eq', value: 1 },
        intent: 'Prove the real confirmation.',
        next: 'done',
      },
    ),
  },
};

try {
  for (const scenario of process.env.FARMSLOT_CAPTURE_PROOF_SCENARIO
    ? [process.env.FARMSLOT_CAPTURE_PROOF_SCENARIO as 'normal' | 'interrupted']
    : (['normal', 'interrupted'] as const)) {
    assert.ok(['normal', 'interrupted'].includes(scenario));
    suiteEvidence.pass = false;
    await writeJson(path.join(root, 'proof.json'), suiteEvidence);
    const directory = path.join(root, scenario);
    await mkdir(directory, { recursive: true });
    const ownedStart = owned.length;
    const events: Event[] = [];
    const state = { confirmations: 0, captureClosed: false };
    let capture: OwnedPage | undefined;
    let captureClosing = false;
    const serverErrors: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const request = new URL(req.url!, 'http://localhost');
        if (request.pathname === '/confirm') {
          state.confirmations += 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(state));
        } else if (request.pathname === '/close') {
          assert.ok(capture && !capture.closed, 'Close only this proof capture target');
          captureClosing = true;
          await readHud(capture.page);
          const closed = await browser.call<{ success: boolean }>('Target.closeTarget', {
            targetId: capture.id,
          });
          assert.equal(closed.success, true);
          capture.closed = true;
          state.captureClosed = true;
          events.push({ event: 'target.closed', at: new Date().toISOString() });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(state));
        } else if (request.pathname === '/state') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(state));
        } else {
          const title = `Capture lifecycle ${scenario} ${stamp} ${request.pathname}`;
          res.setHeader('Content-Type', 'text/html');
          res.end(
            `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#eaf0f8;color:#182334;font:22px system-ui;padding:42px}h1{font-size:32px}button{font:20px system-ui;padding:18px;margin:12px 16px 12px 0}#state{padding:20px;background:white;border-radius:12px}</style><h1>Capture lifecycle proof</h1><p>${scenario}: ${request.pathname === '/capture' ? 'Disposable recorded window' : 'Recipe and completion window'}</p><p id="state">Waiting for confirmation</p><button id="confirm">Confirm through endpoint</button><button id="close">Close disposable capture window</button><script>document.querySelector('#confirm').onclick=async()=>{const r=await fetch('/confirm',{method:'POST'});if(!r.ok)throw Error('Confirmation failed');document.querySelector('#state').textContent='Confirmed '+(await r.json()).confirmations};document.querySelector('#close').onclick=async()=>{const r=await fetch('/close',{method:'POST'});if(!r.ok)throw Error('Close failed');await r.json();document.querySelector('#state').textContent='Capture target closed'};</script>`,
          );
        }
      })().catch((error: unknown) => {
        serverErrors.push(error instanceof Error ? error.message : String(error));
        res.statusCode = 500;
        res.end('Proof endpoint failed');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      if (scenario === 'interrupted') capture = await openPage(`${origin}/capture`);
      const main = await openPage(`${origin}/proof`);
      const recorded = capture ?? main;
      const chromeWindow = await browser.call<{ windowId: number; bounds: WindowBounds }>(
        'Browser.getWindowForTarget',
        { targetId: recorded.id },
      );
      const windows: NativeWindow[] = JSON.parse(
        execFileSync(helper, ['list', '--json'], { encoding: 'utf8' }),
      ).windows;
      // Chrome omits inactive native window titles. Exact CDP bounds identify our owned window.
      const candidates = windows.filter(
        (item) =>
          item.app === 'Google Chrome Canary' &&
          item.x === chromeWindow.bounds.left &&
          item.y === chromeWindow.bounds.top &&
          item.width === chromeWindow.bounds.width &&
          item.height === chromeWindow.bounds.height,
      );
      assert.equal(candidates.length, 1, 'Resolve only the owned recording window unambiguously');
      const window = candidates[0]!;
      let stopped = false;
      const native = createCaptureHelperVideoRecorder({ captureHelperPath: helper });
      const recorder: VideoRecorder = {
        name: native.name,
        doctor: native.doctor?.bind(native),
        async start(request) {
          const active = await native.start(request);
          events.push({ event: 'recorder.started', at: new Date().toISOString() });
          return {
            ...(active.snapshot ? { snapshot: (output: string) => active.snapshot!(output) } : {}),
            async stop() {
              events.push({ event: 'recorder.stop.begin', at: new Date().toISOString() });
              const result = await active.stop();
              stopped = true;
              events.push({ event: 'recorder.stop.done', at: new Date().toISOString() });
              if (scenario === 'normal' && active.snapshot) {
                await assert.rejects(
                  active.snapshot(path.join(directory, 'refused-after-stop.png')),
                  /Recording is no longer active/u,
                );
                events.push({ event: 'snapshot.after-stop.refused', at: new Date().toISOString() });
              }
              return result;
            },
          };
        },
      };
      const transport = createCdpWebUiTransport({
        async withPage(input, use) {
          const result = await use(input.node.surface === 'capture' ? recorded.page : main.page);
          if (input.action === 'app.hud') {
            if (capture && !captureClosing && !capture.closed) await use(capture.page);
            if (input.node.phase === 'complete') {
              const hud = await readHud(main.page);
              events.push({
                event: 'hud.complete',
                at: new Date().toISOString(),
                stopped,
                status: input.node.status,
                hud,
              });
              await transport.execute(
                'ui.screenshot',
                {
                  path: 'screenshots/final.png',
                  label: 'Production completion HUD after recorder finalization',
                  category: 'evidence',
                  fullPage: true,
                },
                input.context,
              );
            }
          }
          return result;
        },
      });
      const runner = runnerFactory({
        actionManifest: manifest,
        defaultSource: { kind: 'operator', trust: 'trusted', name: 'capture lifecycle live proof' },
        hud: { title: 'Capture lifecycle proof', display: { showTitle: true } },
        adapters: [
          ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
          ...createStandardUiAdapters({ transport, actions: Object.keys(manifest.actions) }),
          {
            action: 'proof.inspect',
            source: {
              kind: 'operator',
              trust: 'trusted',
              name: 'live endpoint and target observer',
            },
            async execute() {
              const actualState = await (await fetch(`${origin}/state`)).json();
              const targets = await browser.call<{ targetInfos: { targetId: string }[] }>(
                'Target.getTargets',
              );
              return {
                output: {
                  state: actualState,
                  captureTargetPresent: targets.targetInfos.some(
                    (item) => item.targetId === recorded.id,
                  ),
                },
              };
            },
          },
        ],
        recording: {
          videoRecorder: recorder,
          targetProvider: {
            async resolveRecordingTarget() {
              return { kind: 'window-id', windowId: String(window.id) };
            },
          },
        },
      });
      const nodes: Record<string, Record<string, unknown>> = {
        before: {
          action: 'ui.screenshot',
          path: 'screenshots/before.png',
          fullPage: true,
          intent: 'Record the running HUD before confirmation.',
          next: 'confirm',
        },
        confirm: {
          action: 'ui.press',
          selector: '#confirm',
          settle: false,
          intent: 'Send confirmation through the real endpoint.',
          next: 'confirmed',
        },
        confirmed: {
          action: 'ui.wait_for',
          selector: '#state',
          text: 'Confirmed 1',
          timeout_ms: 5000,
          intent: 'Confirm the endpoint response appears on the page.',
          next: 'inspect',
        },
        inspect: {
          action: 'proof.inspect',
          intent: 'Read actual endpoint state.',
          next: 'assert-confirmed',
        },
        'assert-confirmed': {
          action: 'assert_output',
          source: 'inspect',
          assert: { path: '$.state.confirmations', operator: 'eq', value: 1 },
          intent: 'Prove the endpoint processed exactly one confirmation.',
          next: 'hold',
        },
        hold: {
          action: 'wait',
          ms: 1100,
          intent: 'Keep the real running HUD in the recorded footage.',
          next: scenario === 'normal' ? 'done' : 'capture-before',
        },
        done: { action: 'end', status: 'pass' },
      };
      if (scenario === 'interrupted')
        Object.assign(nodes, {
          'capture-before': {
            action: 'ui.screenshot',
            surface: 'capture',
            path: 'screenshots/capture-before-close.png',
            fullPage: true,
            intent: 'Keep the production HUD on the recorded disposable window.',
            next: 'close',
          },
          close: {
            action: 'ui.press',
            selector: '#close',
            settle: false,
            intent: 'Close the disposable capture window through the real endpoint.',
            next: 'closed',
          },
          closed: {
            action: 'ui.wait_for',
            selector: '#state',
            text: 'Capture target closed',
            timeout_ms: 5000,
            intent: 'Confirm the page reports the disposable capture window closed.',
            next: 'inspect-closed',
          },
          'inspect-closed': {
            action: 'proof.inspect',
            intent: 'Read the real browser target list after closure.',
            next: 'assert-closed',
          },
          'assert-closed': {
            action: 'assert_output',
            source: 'inspect-closed',
            assert: { path: '$.captureTargetPresent', operator: 'eq', value: false },
            intent: 'Prove the captured window no longer exists.',
            next: 'after-close',
          },
          'after-close': {
            action: 'wait',
            ms: 800,
            intent: 'Allow ScreenCaptureKit to finalize the partial recording.',
            next: 'done',
          },
        });
      const recipe = {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: `Capture lifecycle ${scenario}`,
        description:
          'Prove final HUD ordering and retained partial capture using real recipe actions.',
        workflow: { entry: 'before', nodes },
      };
      const result = await runner.run({
        recipeDocument: recipe,
        projectRoot: directory,
        artifactsDir: path.join(directory, 'artifacts'),
        recordVideo: { mode: 'full-run', maxFps: 30 },
      });
      const artifacts = JSON.parse(await readFile(result.artifactManifestPath, 'utf8'));
      const video = artifacts.artifacts.find((item: { type: string }) => item.type === 'video');
      assert.ok(
        video?.timelinePath,
        video?.timelineUnavailableReason ?? 'Retain the real MP4 and timeline',
      );
      const timeline = JSON.parse(
        await readFile(path.join(directory, 'artifacts', video.timelinePath), 'utf8'),
      );
      const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
      const completion = events.find((item) => item.event === 'hud.complete');
      const ordered =
        completion?.stopped === true &&
        events.findIndex((item) => item.event === 'recorder.stop.done') <
          events.findIndex((item) => item.event === 'hud.complete');
      const evidence = {
        scenario,
        pass: false,
        recordedTarget: recorded.id,
        chromeWindow,
        finalScreenshot: path.join(directory, 'artifacts/screenshots/final.png'),
        result,
        video,
        frames: timeline.framesMs.length,
        durationMs: timeline.durationMs,
        completion,
        events,
        serverErrors,
      };
      results.push(evidence);
      await writeJson(path.join(directory, 'proof.json'), evidence);
      await writeJson(path.join(root, 'proof.json'), suiteEvidence);
      assert.ok(
        ordered,
        'Production completion HUD must render only after actual recorder.stop finishes',
      );
      assert.equal(serverErrors.length, 0, 'All real endpoint actions must succeed');
      assert.equal(video.recorder.name, 'capture-helper');
      assert.equal(video.recorder.version, version.version);
      assert.equal(timeline.traceDigest, digestRecipeDocument(trace));
      assert.ok(timeline.framesMs.length > 0 && timeline.durationMs > 0);
      assert.equal(result.status, scenario === 'normal' ? 'pass' : 'fail');
      assert.equal(completion.status, result.status);
      assert.ok(
        completion.hud?.some((text) => text.startsWith(scenario === 'normal' ? 'OK' : 'FAIL')),
        'Read the actual final HUD verdict',
      );
      assert.equal(Boolean(result.captureInterruption), scenario === 'interrupted');
      if (scenario === 'interrupted') {
        assert.ok(
          video.interruption?.frames > 0,
          'Keep typed interruption metadata on the partial MP4',
        );
        assert.ok(
          trace.some((item: { error_code?: string }) => item.error_code === 'CAPTURE_INTERRUPTED'),
        );
        assert.ok(
          trace
            .filter((item: { ok: boolean }) => !item.ok)
            .every((item: { error_code?: string }) => item.error_code === 'CAPTURE_INTERRUPTED'),
          'Only capture interruption may fail the completed recipe graph',
        );
      }
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        path.join(directory, 'artifacts', video.path),
        '-vf',
        `select=eq(n\\,${timeline.framesMs.length - 1})`,
        '-frames:v',
        '1',
        path.join(directory, 'last-recorded-frame.png'),
      ]);
      evidence.pass = true;
      suiteEvidence.pass = results.length === (process.env.FARMSLOT_CAPTURE_PROOF_SCENARIO ? 1 : 2);
      await writeJson(path.join(directory, 'proof.json'), evidence);
      await writeJson(path.join(root, 'proof.json'), suiteEvidence);
      console.log(
        JSON.stringify({
          scenario,
          status: result.status,
          video: path.join(directory, 'artifacts', video.path),
          proof: path.join(directory, 'proof.json'),
        }),
      );
    } finally {
      for (const item of owned.slice(ownedStart)) {
        if (!item.closed) {
          const closed = await browser.call<{ success: boolean }>('Target.closeTarget', {
            targetId: item.id,
          });
          assert.equal(closed.success, true);
          item.closed = true;
        }
      }
      // Chrome can leave speculative HTTP connections open on this owned fixture server.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
} finally {
  for (const item of owned) {
    item.page.session.close();
    if (!item.closed) {
      const closed = await browser.call<{ success: boolean }>('Target.closeTarget', {
        targetId: item.id,
      });
      assert.equal(closed.success, true, 'Clean up only the owned background proof windows');
    }
  }
  browser.close();
}
