// A regular website in a slot-owned browser. The project owns its application server.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpWebPage, listCdpTargets } from '@farmslot/recipe-runner/runtime/cdp';

import { assertSameOwner, cdpOwner } from './browser-cdp.cjs';
import { resolveBrowser } from './browser-resolver.cjs';
import { removeRuntimeIdentity } from './chrome-args.cjs';
import { launchBrowser } from './launch-browser.cjs';
import { stopProfileProcessesSync } from './validation-process-ownership.cjs';

/** @typedef {{
 * manifestPath: string,
 * url: (target: string) => string,
 * serverLabel?: string
 * }} PlainWebAdapterConfig
 */

function port(env = process.env) {
  const value = Number(env.RECIPE_CDP_PORT ?? env.CDP_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error('The plain web runtime requires the assigned --cdp-port.');
  return value;
}

/** Runtime files and the browser profile always belong to the selected checkout. */
export function plainWebRuntimeDir(target) {
  return path.join(fs.realpathSync(target), '.agent', 'web');
}

function browserOptions(target, env = process.env) {
  const runtimeDir = plainWebRuntimeDir(target);
  return {
    cdpPort: port(env),
    runtimeDir,
    profile: path.join(runtimeDir, 'profile'),
    chromeLog: path.join(runtimeDir, 'browser.log'),
    chromePid: path.join(runtimeDir, 'browser.pid'),
  };
}

function owned(target, env = process.env) {
  const options = browserOptions(target, env);
  return cdpOwner(options.cdpPort, options.profile);
}

/**
 * Use existing browser ownership, CDP actions and whole-run recording for a plain website.
 * @param {PlainWebAdapterConfig} config
 * @returns {import('@farmslot/adapter-sdk').ProjectRuntime}
 */
export function createPlainWebAdapter(config) {
  const hint = 'Prepare the selected slot, then launch its plain web browser.';
  async function page(target, env = process.env) {
    const owner = owned(target, env);
    const file = path.join(plainWebRuntimeDir(target), 'page.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const selected = (await listCdpTargets('127.0.0.1', port(env))).find(
      (entry) => entry.id === state.pageId && entry.type === 'page',
    );
    assertSameOwner(owner);
    if (!selected) throw new Error(`The owned application page is unavailable. ${hint}`);
    return selected;
  }
  /** @type {import('@farmslot/adapter-sdk').ProjectRuntime} */
  const runtime = {
    id: 'web',
    sdkVersion: 1,
    headless: false,
    targets: ['web', 'cli'],
    resolveSlotPorts() {},
    async runtimeStatus(target) {
      try {
        await page(target);
        const response = await fetch(config.url(target), { signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Application returned HTTP ${response.status}.`);
        return {
          decision: 'ready',
          reasons: [],
          devServer: { label: config.serverLabel ?? 'website', status: 'up' },
        };
      } catch (error) {
        return {
          decision: 'blocked',
          reasons: [error instanceof Error ? error.message : String(error)],
          nextAction: hint,
        };
      }
    },
    devServer: {
      label: 'browser',
      describe: () => 'The owned website browser; the application server belongs to the project',
      stop(target) {
        stopPlainWebBrowser(target);
        return {
          kind: 'stopped',
          status: 0,
          summary: 'Website browser stopped; application server retained.',
        };
      },
    },
    logSources: (target) => [
      { label: 'Browser', path: path.join(plainWebRuntimeDir(target), 'browser.log') },
    ],
    appLogSource: () => null,
    hints: { launch: hint, relaunch: hint, runtimeProbeRecovery: () => hint },
    harness: {
      kind: 'built-in',
      verify(target) {
        return {
          inProcess: async () => async (_args, io) => {
            const status = await runtime.runtimeStatus(target);
            if (status.decision !== 'ready') {
              io.err(status.reasons.join('; '));
              return 1;
            }
            io.out('ready');
            return 0;
          },
        };
      },
    },
    runtimeContext: { forbiddenFields: [] },
    readiness: { captureProviders: ['cdp'], readyIndicator: () => 'ready' },
    recording: {
      async target(context) {
        const owner = owned(context.projectRoot, context.env);
        await page(context.projectRoot, context.env);
        assertSameOwner(owner);
        return { kind: 'pid', pid: owner.pid };
      },
    },
    async launch({ target, jsonOutput }) {
      const url = config.url(target);
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Expected an HTTP(S) application URL.');
      const options = browserOptions(target);
      const resolution = await resolveBrowser({
        env: {
          ...process.env,
          RECIPE_HARNESS_BROWSER: process.env.RECIPE_HARNESS_BROWSER ?? 'chrome',
        },
        cft: () => ({
          error:
            'Select installed Chrome or set RECIPE_HARNESS_CHROME_BIN to an installed Chromium executable.',
        }),
        cachePath: path.join(options.runtimeDir, 'browser-probe.json'),
        launchMethod: process.platform === 'darwin' ? 'launch-services' : 'spawn',
        display: 'headful',
      });
      launchBrowser({ ...options, chromeBin: resolution.bin, startUrl: url });
      try {
        const owner = owned(target);
        const deadline = Date.now() + 15_000;
        let candidates = [];
        do {
          candidates = (await listCdpTargets('127.0.0.1', port())).filter(
            (entry) => entry.type === 'page' && entry.url.startsWith(`${parsed.origin}/`),
          );
          if (candidates.length) break;
          await delay(100);
        } while (Date.now() < deadline);
        if (candidates.length !== 1)
          throw new Error('Expected one application page in the owned browser.');
        assertSameOwner(owner);
        fs.writeFileSync(
          path.join(options.runtimeDir, 'page.json'),
          JSON.stringify({ pageId: candidates[0].id }),
          { mode: 0o600 },
        );
        const status = await runtime.runtimeStatus(target);
        if (status.decision !== 'ready') throw new Error(status.reasons.join('; '));
      } catch (error) {
        stopPlainWebBrowser(target);
        throw error;
      }
      if (jsonOutput)
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            command: 'launch',
            status: 'pass',
            adapter: 'web',
            target,
            url,
            cdpPort: options.cdpPort,
          }),
        );
      return 0;
    },
    actions: {
      manifestPath: () => config.manifestPath,
      semantic: [],
      cdpTarget: { transport: 'cdp', probePath: '/json/version' },
      ui: ({ createCdpWebUiTransport }) => ({
        base: createCdpWebUiTransport({
          getPage: async ({ context }) =>
            CdpWebPage.connectToTarget(await page(context.projectRoot, context.env)),
        }),
      }),
    },
  };
  return runtime;
}

/** Releases only the selected checkout's owned profile. The application server is retained. */
export function stopPlainWebBrowser(target) {
  const runtimeDir = plainWebRuntimeDir(target);
  // Stop also works without active port options, including a repeated closeout.
  stopProfileProcessesSync(path.join(runtimeDir, 'profile'));
  removeRuntimeIdentity(runtimeDir);
  fs.rmSync(path.join(runtimeDir, 'browser.pid'), { force: true });
  fs.rmSync(path.join(runtimeDir, 'page.json'), { force: true });
  return { stopped: true };
}
