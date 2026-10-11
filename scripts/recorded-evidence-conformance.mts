/** Manual live conformance. Uses a new background target; never touches an existing page. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDefaultRecipeEngine,
  type PlatformAdapter,
  ADAPTER_SDK_VERSION,
  type RecipeCatalog,
  type VideoRecorderStartRequest,
} from '@farmslot/adapter-sdk';
import {
  type RecipeActionManifestDocument,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  officialRecipeActionCapabilities,
  type OfficialActionName,
  validateRecipeActionManifestDocument,
} from '@farmslot/protocol';
import { createCdpVideoRecorder } from '@farmslot/recipe-runner';
import { CdpSession, CdpWebPage, selectCdpTarget } from '@farmslot/recipe-runner/runtime/cdp';

const argument = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const cdpPort = Number(argument('--cdp-port'));
const recipePath =
  argument('--recipe') ??
  fileURLToPath(new URL('./runner-validation/recorded-evidence.recipe.json', import.meta.url));
const artifactsDir = argument('--artifacts-dir');
if (!Number.isInteger(cdpPort) || cdpPort < 1 || !artifactsDir)
  throw new Error('Usage: --cdp-port <port> --artifacts-dir <output> [--recipe <plain recipe>]');
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recorded-evidence-conformance-'));
const recipe = JSON.parse(await fs.readFile(recipePath, 'utf8'));
const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    'ui.press': {
      description: 'Activate a DOM control.',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'ui.press',
          selector: '#increment',
          intent: 'Increase the displayed counter.',
          next: 'check',
        },
      ],
    },
    'ui.wait_for': {
      description: 'Check a visible selector and its text.',
      schema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'ui.wait_for',
          selector: '#count',
          text: '1',
          intent: 'The displayed count must be one.',
          next: 'done',
        },
      ],
    },
    'app.hud': {
      description: 'Shared framework HUD.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.hud', intent: 'Show the current outcome.', next: 'done' }],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};
const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>Recorded evidence conformance</title></head><body style="margin:40px;font:24px system-ui;background:#fff;color:#111"><h1>Counter</h1><button id="increment" style="font:inherit;padding:16px">Increment</button><p>Count: <output id="count">0</output></p><script>document.querySelector("#increment").addEventListener("click",()=>{const count=document.querySelector("#count");count.textContent=String(Number(count.textContent)+1)})</script></body></html>';
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(html);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/recorded-evidence`;
let browser: CdpSession | undefined;
let targetId: string | undefined;
let page: CdpWebPage | undefined;
try {
  const version = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  browser = await CdpSession.connect(version.webSocketDebuggerUrl);
  ({ targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
    url,
    background: true,
  }));
  const target = await selectCdpTarget({
    port: cdpPort,
    predicate: (entry) => entry.id === targetId,
  });
  page = await CdpWebPage.connectToTarget(target);
  await page.waitForDocumentReady({ expectedUrl: url });
  const activePage = page;
  const runtime: PlatformAdapter = {
    id: 'browser',
    sdkVersion: ADAPTER_SDK_VERSION,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: 'fixture',
      describe: () => 'fixture',
      stop: () => ({
        kind: 'headless',
        message: 'Owned fixture server.',
        userAction: 'Conformance owns cleanup.',
      }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: {
      launch: 'run conformance',
      relaunch: 'run conformance',
      runtimeProbeRecovery: () => 'check the isolated browser endpoint',
    },
    actions: {
      manifestPath: () => fileURLToPath(import.meta.url),
      semantic: [],
      cdpTarget: { transport: 'cdp', probePath: '/json/version' },
      ui: (harness) => ({
        base: harness.createCdpWebUiTransport({ withPage: async (_input, use) => use(activePage) }),
      }),
    },
    recording: {
      target: async () => ({
        kind: 'cdp-page',
        host: '127.0.0.1',
        port: cdpPort,
        targetId: targetId!,
      }),
      videoRecorder: async () => {
        const recorder = createCdpVideoRecorder({
          cdpPort,
          urlIncludes: url,
          ...(argument('--spool-bytes') ? { spoolBytes: Number(argument('--spool-bytes')) } : {}),
        });
        if (!process.argv.includes('--derive-stills')) return recorder;
        return {
          ...recorder,
          name: recorder.name,
          continuousSegments: recorder.continuousSegments,
          doctor: () => recorder.doctor!(),
          async start(request: VideoRecorderStartRequest) {
            const session = await recorder.start(request);
            return { stop: () => session.stop() };
          },
        };
      },
    },
    harness: {
      install: { entry: 'none', fallback: 'none' },
      cleanup: { entry: 'none', fallback: 'none' },
      verify: () => ({ error: 'Not used by direct SDK conformance.' }),
    },
    runtimeContext: { forbiddenFields: [] },
    launch: async () => 0,
  };
  const catalog: RecipeCatalog = {
    bundledLibrary: { name: 'conformance', root: projectRoot, actionNamespace: 'conformance' },
    validateManifest: async (value) => {
      const validation = validateRecipeActionManifestDocument(value);
      assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
      return validation;
    },
    resolveActionManifest: async () => ({ manifest, actionSources: new Map() }),
    actionCapabilities: (action) => officialRecipeActionCapabilities(action as OfficialActionName),
  };
  const engine = createDefaultRecipeEngine({
    runtime,
    catalog,
    runtimeSource: { kind: 'bundled', trust: 'trusted', name: 'framework-conformance' },
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
  const runner = await engine.createRunner(runtime.id, manifest, {
    actionSources: new Map(),
    trustTaskActions: false,
  });
  const request = { recipeDocument: recipe, projectRoot, artifactsDir: path.resolve(artifactsDir) };
  await runner.preflight(request);
  const result = await runner.run(request);
  const indexed = JSON.parse(await fs.readFile(result.artifactManifestPath, 'utf8')) as {
    artifacts: { path: string; type: string; metadata?: Record<string, unknown> }[];
  };
  const checks = {
    passed: result.status === 'pass',
    registeredClaims:
      result.claims.criteria.length === recipe.proofTargets.length &&
      result.claims.criteria.every((claim) => claim.verdict === 'proven'),
    moments: result.claims.criteria.every(
      (claim) => claim.moments.length > 0 && claim.timing === 'measured',
    ),
    recordedStills:
      indexed.artifacts.filter(
        (artifact) => artifact.type === 'screenshot' && artifact.metadata?.recordedEvidence,
      ).length ===
      Object.values(recipe.workflow.nodes).filter(
        (node: unknown) =>
          typeof node === 'object' &&
          node !== null &&
          'action' in node &&
          node.action === 'ui.wait_for',
      ).length,
    recordingComplete: result.claims.recording.status === 'complete',
  };
  await fs.writeFile(
    path.join(artifactsDir, 'conformance-checks.json'),
    `${JSON.stringify({ checks, recipeRunId: result.claims.recipeRunId, targetId }, null, 2)}\n`,
  );
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  console.log(JSON.stringify({ status: 'pass', checks, artifactsDir: path.resolve(artifactsDir) }));
} finally {
  page?.close();
  if (browser && targetId) await browser.call('Target.closeTarget', { targetId });
  browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.rm(projectRoot, { recursive: true, force: true });
}
