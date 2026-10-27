import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';
import {
  createCdpVideoRecorder,
  createRecipeRunner,
  createStandardUiAdapters,
} from '@farmslot/recipe-runner';
import {
  CdpSession,
  CdpWebPage,
  createCdpWebUiTransport,
  selectCdpTarget,
} from '@farmslot/recipe-runner/runtime/cdp';

interface ProofBrowserClose {
  requestClose?(): Promise<unknown>;
  closeConnection?(): void;
}

/** The owned process exit completes cleanup even if its CDP close command stalls. */
export async function closeProofBrowser(
  child: ChildProcess,
  exited: Promise<unknown>,
  connection: ProofBrowserClose,
  killAfterMs = 10_000,
): Promise<void> {
  const killTimer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  try {
    try {
      if (connection.requestClose) await Promise.race([connection.requestClose(), exited]);
      else child.kill('SIGTERM');
    } finally {
      await exited;
    }
  } finally {
    clearTimeout(killTimer);
    connection.closeConnection?.();
  }
}

/** Two browser processes share only a disposable profile. FARMSLOT_BROWSER_PROOF_BINARY overrides Canary. */
export async function browserPersistenceAttempts(
  root: string,
  projectRoot: string,
  headSha: string,
  screenshotCount = 1,
) {
  const taskDir = path.join(root, 'browser-task');
  const profile = path.join(root, 'browser-profile');
  const expected = randomUUID();
  const html = `<!doctype html><html><body style="font:24px system-ui;padding:32px"><h1>Session persistence</h1><button id="save">Save value</button><button id="load">Read saved value</button><p id="value"></p><script>const show=()=>document.querySelector('#value').textContent=localStorage.getItem('proof-value')||'Empty';document.querySelector('#save').onclick=()=>{localStorage.setItem('proof-value',${JSON.stringify(expected)});show()};document.querySelector('#load').onclick=show;show();</script></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/persistence`;
  const manifest: RecipeActionManifestDocument = {
    $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
    actions: {
      'ui.press': {
        schema: {
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
          additionalProperties: false,
        },
        description: 'Press a control.',
        examples: [
          { action: 'ui.press', selector: '#save', intent: 'Save the value.', next: 'check' },
        ],
      },
      'ui.wait_for': {
        schema: {
          type: 'object',
          properties: { selector: { type: 'string' }, text: { type: 'string' } },
          required: ['selector', 'text'],
          additionalProperties: false,
        },
        description: 'Assert rendered text.',
        examples: [
          {
            action: 'ui.wait_for',
            selector: '#value',
            text: 'value',
            intent: 'Check the value.',
            next: 'shot',
          },
        ],
      },
      'ui.screenshot': {
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        description: 'Retain the recorded frame.',
        examples: [
          {
            action: 'ui.screenshot',
            path: 'proof.png',
            intent: 'The saved value remains visible.',
            next: 'done',
          },
        ],
      },
      'app.hud': {
        description: 'Render the current proof state.',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        examples: [
          { action: 'app.hud', intent: 'The current proof state stays visible.', next: 'done' },
        ],
      },
      end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    },
  };
  const pids: number[] = [];
  const targets: string[] = [];
  const baselineRoot = 'recipe-runs/session-write';
  const headRoot = 'recipe-runs/session-read';
  const attempts = [];
  try {
    for (const [index, artifactRoot] of [baselineRoot, headRoot].entries()) {
      await mkdir(profile, { recursive: true });
      const portFile = path.join(profile, 'DevToolsActivePort');
      await rm(portFile, { force: true });
      const child = spawn(
        process.env.FARMSLOT_BROWSER_PROOF_BINARY ??
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        [
          '--headless=new',
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ],
        { stdio: 'ignore' },
      );
      assert.ok(child.pid);
      pids.push(child.pid);
      const exited = once(child, 'exit');
      let browser: CdpSession | undefined;
      let page: CdpWebPage | undefined;
      try {
        let port: number | undefined;
        const deadline = Date.now() + 20_000;
        while (!port) {
          assert.equal(child.exitCode, null, 'Owned browser must stay alive during startup');
          assert.ok(Date.now() < deadline, 'Owned browser did not expose CDP');
          try {
            port = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
          response.json(),
        )) as { webSocketDebuggerUrl: string };
        browser = await CdpSession.connect(version.webSocketDebuggerUrl);
        const { targetId } = await browser.call<{ targetId: string }>('Target.createTarget', {
          url,
        });
        targets.push(targetId);
        const target = await selectCdpTarget({
          host: '127.0.0.1',
          port,
          predicate: (target) => target.id === targetId,
        });
        page = await CdpWebPage.connectToTarget(target);
        await page.waitForDocumentReady({ expectedUrl: url });
        const activePage = page;
        const cdpPort = port;
        const runner = createRecipeRunner({
          actionManifest: manifest,
          adapters: createStandardUiAdapters({
            actions: ['ui.press', 'ui.wait_for', 'ui.screenshot', 'app.hud'],
            transport: createCdpWebUiTransport({
              withPage: async (_input, use) => use(activePage),
            }),
          }),
          hud: {},
          defaultSource: { kind: 'operator', trust: 'trusted' },
          recording: {
            targetProvider: {
              resolveRecordingTarget: async () => ({
                kind: 'cdp-page',
                host: '127.0.0.1',
                port,
                targetId,
              }),
            },
            videoRecorder: createCdpVideoRecorder({ cdpPort, urlIncludes: url }),
          },
        });
        const artifactsDir = path.join(taskDir, 'artifacts', artifactRoot);
        const result = await runner.run({
          projectRoot,
          artifactsDir,
          recordVideo: { mode: 'full-run', stillFormat: 'png' },
          params: { expected, browserPid: child.pid, sessionOrdinal: index + 1 },
          recipeDocument: {
            $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
            title: index ? 'Read after browser restart' : 'Write in the initial browser session',
            description: 'Keep both sessions as original executions in one publication package.',
            paramsSchema: {
              type: 'object',
              properties: {
                expected: { type: 'string' },
                browserPid: { type: 'integer' },
                sessionOrdinal: { type: 'integer' },
              },
              required: ['expected', 'browserPid', 'sessionOrdinal'],
              additionalProperties: false,
            },
            proofTargets: index
              ? [
                  {
                    id: 'AC-1',
                    claim: 'The saved value persists across browser sessions.',
                    proofMode: 'state',
                  },
                ]
              : [],
            workflow: {
              entry: index ? 'load' : 'save',
              nodes: {
                ...(index
                  ? {
                      load: {
                        action: 'ui.press',
                        selector: '#load',
                        intent: 'Read the value saved by the previous browser session.',
                        next: 'check',
                      },
                    }
                  : {
                      save: {
                        action: 'ui.press',
                        selector: '#save',
                        intent: 'Save the unique value.',
                        next: 'check',
                      },
                    }),
                check: {
                  action: 'ui.wait_for',
                  selector: '#value',
                  text: '{{params.expected}}',
                  ...(index ? { proves: ['AC-1'] } : {}),
                  intent: index
                    ? 'The new session must retain the same value.'
                    : 'The original session must show its saved value.',
                  next: 'shot',
                },
                ...Object.fromEntries(
                  Array.from({ length: screenshotCount }, (_, i) => [
                    i === 0 ? 'shot' : `shot-${i}`,
                    {
                      action: 'ui.screenshot',
                      path: i === 0 ? 'proof.png' : `screenshots/proof-${i}.png`,
                      ...(index ? { ac: 'AC-1', role: 'after' } : {}),
                      intent: 'The saved value remains visible for review.',
                      next: i + 1 === screenshotCount ? 'done' : `shot-${i + 1}`,
                    },
                  ]),
                ),
                done: { action: 'end', status: 'pass' },
              },
            },
          },
        });
        assert.equal(result.status, 'pass');
        assert.equal(result.claims.recording.status, 'complete');
        if (index) assert.equal(result.claims.criteria[0]?.verdict, 'proven');
        else assert.equal(result.claims.criteria.length, 0);
        const provenancePath = path.join(artifactsDir, 'product-provenance.json');
        await writeFile(
          provenancePath,
          JSON.stringify({ schemaVersion: 1, git_ref: headSha, dirty: false, branch: 'feature' }),
        );
        const artifactManifestPath = path.join(artifactsDir, 'artifact-manifest.json');
        const artifactManifest = JSON.parse(await readFile(artifactManifestPath, 'utf8'));
        artifactManifest.artifacts.push({
          path: 'product-provenance.json',
          type: 'json',
          category: 'system',
        });
        await writeFile(artifactManifestPath, JSON.stringify(artifactManifest));
        attempts.push(result);
      } finally {
        page?.close();
        const ownedBrowser = browser;
        await closeProofBrowser(child, exited, {
          ...(ownedBrowser ? { requestClose: () => ownedBrowser.call('Browser.close') } : {}),
          closeConnection: () => ownedBrowser?.close(),
        });
      }
    }
    assert.notEqual(pids[0], pids[1]);
    assert.notEqual(targets[0], targets[1]);
    await writeFile(
      path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
      JSON.stringify({ version: 1, relativeArtifactRoot: headRoot }),
    );
    return {
      taskDir,
      baselineRoot,
      headRoot,
      head: attempts[1]!,
      browserProof: {
        pids,
        targets,
        sameProfile: true,
        twoCompleteRecordings: true,
        setupClaimCount: attempts[0]!.claims.criteria.length,
        selectedPersistenceVerdict: attempts[1]!.claims.criteria[0]?.verdict,
      },
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
