// @ts-check
// The generic web-dapp lifecycle as an adapter-sdk PlatformAdapter: a web app
// under test whose dev server the slot owns; the adapter owns the slot browser
// (an extension signer or the injected strict wallet) and its wallet host. What
// it knows about the app's venue comes from the venue policy of the adapter that
// extends it, bound into RECIPE_WEB_DAPP_POLICY by `bindWebDappPolicy`. Selected
// on its own, web-dapp has no policy: launch, verify and runtime status refuse,
// doctor reports it.
//
// The leaf scripts (launch, wallet-host, inject, verify, stop, cleanup) are CLIs
// that run as their own node processes; `webDappLeafPath` names them.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recipeRuntimePath, shellQuote } from './lib/paths.mjs';
import { POLICY_ENV, webDappAdapterId, webDappPolicy } from './lib/policy.mjs';
import { check, webDappReadiness } from './lib/readiness.mjs';
import { loadSigners, SIGNER_MODULE_ENV } from './lib/signers.mjs';
import { resolveBrowser } from './launch.mjs';

export {
  loadSigners,
  POLICY_ENV,
  check as readinessCheck,
  SIGNER_MODULE_ENV,
  webDappAdapterId,
  webDappPolicy,
};
export { cleanupWebDappRuntime } from './cleanup.mjs';
export { installWebDappRuntime } from './inject.mjs';
export {
  backgroundWindowParams,
  checkFocusAfterLaunch,
  chromeForTestingCandidates,
  LAUNCH_TIMEOUTS,
  launchMethodFor,
  launchWebDappBrowser,
  macApplicationForExecutable,
  parseLaunchArgs,
  resolveBrowser,
  spawnDetached,
} from './launch.mjs';
export { hostOf, hostResolverRules, isBlockedUrl } from './lib/blocked-hosts.mjs';
export { browserWebSocketUrl, CdpClient } from './lib/cdp-client.mjs';
export {
  recipeHarnessPath,
  recipeRuntimeDir,
  recipeRuntimePath,
  shellQuote,
  walletFixturePath,
} from './lib/paths.mjs';
export {
  assertPolicyDigest,
  fencePolicy,
  POLICY_DIGEST_ENV,
  PolicyFenceError,
} from './lib/policy-fence.mjs';
export {
  cdpListenerPids,
  ownedBrowserPids,
  OWNER_FLAG,
  OWNER_KINDS,
  ownerMarker,
  ownsProcess,
  pidAlive,
  portFree,
  stopConsoleCollector,
  stopWebDappBrowser,
  terminate,
} from './lib/processes.mjs';
export {
  assertLaunchNetwork,
  DEV_SERVER_PID_FILE,
  devServerTestnetDiagnostic,
  pythonFor,
  webDappReadiness,
} from './lib/readiness.mjs';
export {
  accountName,
  appOrigin,
  appPort,
  canonicalPath,
  cdpPort,
  DEFAULT_ACCOUNT,
  fixtureAccount,
  fixtureEntry,
  fixturePath,
  loadWalletFixture,
  readBrowserState,
  readJsonFile,
  resolveAccountAddress,
  resolveSigner,
  SIGNER_MODES,
  viemAccountFromEntry,
  webDappRuntimeDir,
  webDappRuntimePath,
  writePrivateJson,
} from './lib/runtime.mjs';

const LEAVES = Object.freeze(['launch', 'wallet-host', 'inject', 'verify', 'stop', 'cleanup']);

/**
 * The absolute path of a leaf script (`launch`, `wallet-host`, `inject`,
 * `verify`, `stop` or `cleanup`).
 * @param {'launch' | 'wallet-host' | 'inject' | 'verify' | 'stop' | 'cleanup'} name
 */
export function webDappLeafPath(name) {
  if (!LEAVES.includes(name))
    throw new Error(`unknown web-dapp leaf ${JSON.stringify(name)}; one of ${LEAVES.join(', ')}.`);
  return fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
}

// Console files, next to the slot browser's other runtime files:
//   app-console.log        the app page(s): console calls and uncaught exceptions
//   extension-console.log  the wallet extension's service worker and UI pages (signer=extension)
export const WEB_DAPP_CONSOLE_FILES = Object.freeze({
  app: 'app-console.log',
  extension: 'extension-console.log',
  collectorLog: 'console-tail.log',
  pidFile: 'console-tail.pid',
});

/**
 * A file in the slot's runtime directory (the realpath of the target, as the
 * launcher uses): <checkout>/<runtime>/<adapter id>/<name>.
 * @param {string} target
 * @param {string} name
 */
export function webDappRuntimeFile(target, name) {
  let root = path.resolve(target);
  try {
    root = fs.realpathSync(root);
  } catch {
    // A missing checkout keeps the resolved path; callers report it.
  }
  return recipeRuntimePath(root, webDappAdapterId(), name);
}

// Flags only the web-dapp launcher reads; other adapters reject them instead
// of silently ignoring them.
export const WEB_DAPP_ONLY_LAUNCH_OPTIONS = Object.freeze({
  signer: '--signer',
  account: '--account',
  freshProfile: '--fresh-profile',
  headless: '--headless',
  headful: '--headful',
  slowMo: '--slow-mo',
  network: '--network',
  mainnetConfirmation: '--mainnet-confirmation',
});

/** @param {Record<string, string | boolean>} options */
export function webDappOnlyLaunchFlags(options) {
  return Object.entries(WEB_DAPP_ONLY_LAUNCH_OPTIONS)
    .filter(([key]) => options[key] !== undefined && options[key] !== false)
    .map(([, name]) => name);
}

/**
 * The leaf prints one JSON document (compact with --json, indented without).
 * Parse it whole; fall back to the last line for any log noise before it.
 * @param {string} output
 * @returns {Record<string, unknown>}
 */
export function parseWebDappLauncherOutput(output) {
  const text = output.trim();
  if (!text)
    return { status: 'fail', error: `the ${webDappAdapterId()} launcher printed no summary` };
  try {
    return JSON.parse(text);
  } catch {
    const last =
      text
        .split('\n')
        .filter((line) => line.trim())
        .pop() ?? '';
    try {
      return JSON.parse(last);
    } catch {
      return {
        status: 'fail',
        error: `the ${webDappAdapterId()} launcher printed no JSON summary: ${last.slice(0, 200)}`,
      };
    }
  }
}

/** @param {...string} names */
function portFromEnv(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw && /^\d+$/u.test(raw)) return Number(raw);
  }
  return undefined;
}

export function webDappAppPort() {
  return portFromEnv('TERMINAL_APP_PORT', 'RECIPE_WATCHER_PORT', 'WATCHER_PORT');
}

export function webDappCdpPort() {
  return portFromEnv('RECIPE_CDP_PORT', 'CDP_PORT');
}

// The running browser's signer, else the requested one, else extension.
/** @param {string} target */
function webDappSignerFor(target) {
  try {
    const state = JSON.parse(fs.readFileSync(webDappRuntimeFile(target, 'browser.json'), 'utf8'));
    if (typeof state.signer === 'string') return state.signer;
  } catch {
    // No running slot browser.
  }
  return process.env.TERMINAL_SIGNER || 'extension';
}

/**
 * Bind the venue policy of an adapter that extends web-dapp: its module path
 * goes to RECIPE_WEB_DAPP_POLICY, which web-dapp's members, leaf processes and
 * live actions read for this command. Called when the host adopts the adapter.
 * @template {{ extends?: string, policy?: { module?: unknown } }} T
 * @param {T} adapter
 * @returns {T}
 */
export function bindWebDappPolicy(adapter) {
  if (adapter.extends === 'web-dapp' && typeof adapter.policy?.module === 'string') {
    process.env[POLICY_ENV] = adapter.policy.module;
  }
  return adapter;
}

// Mainnet attempts the slot browser blocked or the wallet refused, and wallet
// log entries that could not be attributed, during the run (whatever a
// read_signatures cursor later skips). The launch's own probes are excluded.
/**
 * @param {readonly string[]} lines
 * @returns {import('@farmslot/adapter-sdk').AdapterLogFinding[]}
 */
export function walletRequestFindings(lines) {
  /** @type {import('@farmslot/adapter-sdk').AdapterLogFinding[]} */
  const findings = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    let text = null;
    if (entry.kind === 'blocked-mainnet' && entry.probe !== true)
      text = `blocked-mainnet: ${String(entry.transport ?? 'request')} to ${String(entry.url ?? '?')}`;
    else if (entry.kind === 'refused-mainnet')
      text = `refused-mainnet: ${String(entry.method ?? '?')} (${String(entry.reason ?? '?')})`;
    else if (entry.kind === 'unattributed')
      text = `unattributed wallet ${entry.binding === 'request' ? 'request' : 'log entry'}${typeof entry.method === 'string' ? ` (${entry.method})` : ''}`;
    if (text) findings.push({ level: 'error', source: 'wallet', text });
  }
  return findings;
}

/**
 * @param {Record<string, string | boolean>} options
 * @param {string} key
 */
const str = (options, key) => (typeof options[key] === 'string' ? options[key] : undefined);
/**
 * @param {Record<string, string | boolean>} options
 * @param {string} key
 */
const flag = (options, key) => options[key] === true;

/**
 * @typedef {Partial<Omit<import('@farmslot/adapter-sdk').PlatformAdapter, 'id' | 'sdkVersion' | 'harness'>> & {
 *   harness?: Partial<import('@farmslot/adapter-sdk').AdapterHarness>,
 * }} WebDappAdapterHooks
 */

/**
 * @typedef {object} WebDappAdapterOptions
 * @property {string} [id] The adapter id; web-dapp by default.
 * @property {Record<string, any>} [signers] Signer hooks by mode, in this process
 *   (see lib/signers.mjs). Only `extension` exists today.
 * @property {string} [signerModule] Absolute path of the ESM module exporting the
 *   same `signers`, which the leaf processes load; read in-process too when `signers` is absent.
 * @property {string} [cli] The host's bin name, for `Next:` lines. farmslot-recipe by default.
 * @property {WebDappAdapterHooks} [hooks]
 *   Anything of the PlatformAdapter the host supplies or replaces. `actions` is
 *   required in practice (web-dapp ships no action manifest); `diagnostics`,
 *   `readiness` and `harness` merge over the generic members, the rest replace.
 */

/**
 * @param {WebDappAdapterOptions} [options]
 * @returns {import('@farmslot/adapter-sdk').PlatformAdapter}
 */
export function createWebDappAdapter({
  id = 'web-dapp',
  signers,
  signerModule,
  cli = 'farmslot-recipe',
  hooks = {},
} = {}) {
  const { actions, diagnostics, readiness, harness, ...rest } = hooks;
  const resolveSigners = async () =>
    signers ??
    (await loadSigners(
      signerModule ? { ...process.env, [SIGNER_MODULE_ENV]: signerModule } : process.env,
    ));
  const venueHint = `pass --adapter <the adapter that extends ${id}>, e.g. --adapter terminal, with its recipe library on RECIPE_LIBRARY_PATH`;

  return {
    id,
    sdkVersion: 1,
    headless: false,

    resolveSlotPorts() {
      // Ports come from the slot (Farmslot {{port}} / {{cdp_port}}) through
      // --watcher-port / --cdp-port or the runtime context; nothing is claimed here.
    },

    async runtimeStatus(target) {
      if (!process.env[POLICY_ENV]) {
        return {
          decision: 'blocked',
          reasonCode: 'web-dapp-venue-policy',
          reasons: [`${id} needs a venue policy: select an adapter that extends it`],
          nextAction: venueHint,
          deps: 'missing',
          devServer: { label: 'next', status: 'down' },
        };
      }
      const policy = webDappPolicy();
      const report = await webDappReadiness({
        policy,
        signers: await resolveSigners(),
        target: path.resolve(target),
        appPort: webDappAppPort(),
        cdpPort: webDappCdpPort(),
        signer: process.env.TERMINAL_SIGNER || 'extension',
      });
      const blocking = report.checks.filter((item) => item.required && item.status === 'fail');
      const devServer = report.checks.find((item) => item.id === 'app-dev-server');
      return {
        decision: blocking.length === 0 ? 'ready' : 'blocked',
        reasonCode: blocking[0]?.id,
        reasons: (blocking.length ? blocking : report.checks).map(
          (item) => `${item.id}: ${item.detail}`,
        ),
        nextAction:
          blocking.length === 0
            ? undefined
            : blocking[0].id === 'app-dev-server' || blocking[0].id === 'testnet-forced'
              ? 'start the slot dev server with testnet forced (Farmslot preflight), then retry'
              : `${cli} doctor --adapter ${policy.adapterId} --target ${shellQuote(path.resolve(target))} --json`,
        deps:
          report.checks.find((item) => item.id === 'dependencies')?.status === 'pass'
            ? 'current'
            : 'missing',
        devServer: { label: 'next', status: devServer?.status === 'pass' ? 'up' : 'down' },
      };
    },

    devServer: {
      label: 'browser',
      describe: () =>
        `${webDappAdapterId()} slot browser and wallet host (the Next.js dev server belongs to the slot)`,
      stop(target) {
        const args = [webDappLeafPath('stop'), '--target', path.resolve(target)];
        const cdpPort = process.env.RECIPE_CDP_PORT ?? process.env.CDP_PORT;
        if (cdpPort) args.push('--cdp-port', cdpPort);
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const status = result.status ?? 1;
        return {
          kind: 'stopped',
          status,
          summary:
            status === 0
              ? `${webDappAdapterId()} browser and wallet host stopped`
              : `${webDappAdapterId()} browser stop failed`,
          output,
        };
      },
    },

    logSources(target) {
      return [
        { label: 'app-console', path: webDappRuntimeFile(target, WEB_DAPP_CONSOLE_FILES.app) },
        ...(webDappSignerFor(target) === 'extension'
          ? [
              {
                label: 'extension-console',
                path: webDappRuntimeFile(target, WEB_DAPP_CONSOLE_FILES.extension),
              },
            ]
          : []),
        { label: 'wallet-requests', path: webDappRuntimeFile(target, 'wallet-requests.jsonl') },
        { label: 'wallet-host', path: webDappRuntimeFile(target, 'wallet-host.log') },
        { label: 'browser', path: webDappRuntimeFile(target, 'browser.log') },
        { label: 'next', path: path.join(target, 'temp/farmslot/next-dev.log') },
      ];
    },

    // The app page's console and uncaught exceptions: errors make a run REVIEW.
    appLogSource(target) {
      return { label: 'app-console', path: webDappRuntimeFile(target, WEB_DAPP_CONSOLE_FILES.app) };
    },

    flags: { launch: ['freshProfile', 'headless', 'headful'] },
    // Bare web-dapp has no venue: every hint names the adapter that extends it.
    hints: {
      launch: venueHint,
      relaunch: `pass --adapter <the adapter that extends ${id}>, e.g. --adapter terminal, with --fresh-profile`,
      runtimeProbeRecovery: () => venueHint,
    },

    // Start (or reuse) the slot browser with the requested signer. The app's dev
    // server belongs to the slot and is never started here.
    async launch({ options, target, jsonOutput, stream, usage }) {
      const adapterId = webDappAdapterId();
      const cdpPort =
        str(options, 'cdpPort') ?? process.env.RECIPE_CDP_PORT ?? process.env.CDP_PORT;
      // Same precedence as the web-dapp surface and live actions.
      const appPort =
        str(options, 'watcherPort') ??
        process.env.TERMINAL_APP_PORT ??
        process.env.RECIPE_WATCHER_PORT ??
        process.env.WATCHER_PORT;
      if (!cdpPort || !appPort) {
        return usage(
          `${adapterId} launch needs the slot browser CDP port and the slot dev-server port.`,
          `${cli} launch --adapter ${adapterId} --cdp-port <port> --watcher-port <app port>`,
        );
      }
      const args = [
        webDappLeafPath('launch'),
        '--target',
        target,
        '--cdp-port',
        cdpPort,
        '--app-port',
        appPort,
        '--signer',
        str(options, 'signer') ?? process.env.TERMINAL_SIGNER ?? 'extension',
        '--account',
        str(options, 'account') ?? process.env.TERMINAL_ACCOUNT ?? 'dev1',
        '--json',
      ];
      if (signerModule) args.push('--signer-module', signerModule);
      if (flag(options, 'freshProfile')) args.push('--fresh-profile');
      if (flag(options, 'headless')) args.push('--headless');
      if (flag(options, 'headful')) args.push('--headful');
      const slowMo = str(options, 'slowMo');
      if (slowMo) args.push('--slow-mo', slowMo);
      const network = str(options, 'network');
      if (network) args.push('--network', network);
      const mainnetConfirmation = str(options, 'mainnetConfirmation');
      if (mainnetConfirmation) args.push('--mainnet-confirmation', mainnetConfirmation);
      stream.phase('launch', { adapter: adapterId, cdpPort, appPort });
      let output = '';
      let status = 0;
      try {
        output = execFileSync(process.execPath, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
        });
      } catch (error) {
        status = 1;
        output = String(/** @type {{ stdout?: string }} */ (error)?.stdout ?? '');
      }
      const result =
        /** @type {{ status?: string, reused?: boolean, cdpPort?: number, signer?: string, account?: { name?: string }, error?: string }} */ (
          parseWebDappLauncherOutput(output)
        );
      if (jsonOutput)
        console.log(
          JSON.stringify(
            { schemaVersion: 1, command: 'launch', adapter: adapterId, target, ...result },
            null,
            2,
          ),
        );
      else if (result.status === 'pass')
        console.log(
          `✓ ${adapterId} browser ${result.reused ? 'reused' : 'started'} on CDP ${result.cdpPort} (${result.signer}, ${result.account?.name})`,
        );
      else console.error(`✗ ${adapterId} launch failed: ${result.error ?? 'unknown error'}`);
      stream.complete(result.status === 'pass' ? 'pass' : 'fail', status);
      return result.status === 'pass' ? 0 : 1;
    },

    // The web-dapp ships no action manifest: the host supplies its action set
    // (`hooks.actions`).
    actions: actions ?? {
      manifestPath() {
        throw new Error(
          `${id} ships no action manifest: pass hooks.actions to createWebDappAdapter.`,
        );
      },
      semantic: [],
      cdpTarget: { transport: 'chrome-cdp', probePath: 'json/version' },
    },

    // The overlay and slot: install/verify/cleanup leaves.
    harness: {
      install: {
        entry: webDappLeafPath('inject'),
        fallback: webDappLeafPath('inject'),
        node: true,
      },
      cleanup: {
        entry: webDappLeafPath('cleanup'),
        fallback: webDappLeafPath('cleanup'),
        node: true,
      },
      verify: () => ({
        command: process.execPath,
        prefixArgs: [
          webDappLeafPath('verify'),
          ...(signerModule ? ['--signer-module', signerModule] : []),
        ],
      }),
      restart: `${cli} launch`,
      ...harness,
    },

    // An agentic-runtime.json whose ports all belong to the slot (never claimed here).
    runtimeContext: {
      forbiddenFields: ['metroPort', 'simulator', 'simulatorUdid', 'adbSerial', 'extensionId'],
      resources: ({ existing, defaults, envPort }) => ({
        cdpPort: envPort('RECIPE_CDP_PORT', 'CDP_PORT') ?? existing.cdpPort ?? defaults.cdpPort,
      }),
    },

    readiness: {
      // The slot's readiness (dev server, testnet, fixture, browser, the signer's
      // own checks, CDP port) as doctor checks; the browser itself is optional
      // because recipes start it with their launch node. Without a venue policy
      // (web-dapp selected on its own) doctor reports that one required check.
      async liveChecks(target) {
        if (!process.env[POLICY_ENV]) {
          return [
            {
              id: 'web-dapp-venue-policy',
              status: 'fail',
              required: true,
              message: `${id} needs a venue policy: select an adapter that extends it (e.g. --adapter terminal with its recipe library on RECIPE_LIBRARY_PATH).`,
            },
          ];
        }
        const policy = webDappPolicy();
        const report = await webDappReadiness({
          policy,
          signers: await resolveSigners(),
          target,
          appPort: webDappAppPort(),
          cdpPort: webDappCdpPort(),
          signer: process.env.TERMINAL_SIGNER || 'extension',
          account: process.env.TERMINAL_ACCOUNT || 'dev1',
          probeBrowser: resolveBrowser,
        });
        return report.checks.map((item) => ({
          id: `${policy.adapterId}-${item.id}`,
          status: item.status === 'pass' ? 'pass' : 'fail',
          required: item.required,
          message: item.detail,
        }));
      },
      // Screenshots come from the slot browser over CDP.
      captureProviders: ['cdp'],
      ...readiness,
    },

    // The wallet request log; the console capture is the host's (`hooks.diagnostics.console`).
    diagnostics: {
      requestLog: {
        path: (projectRoot) => webDappRuntimeFile(projectRoot, 'wallet-requests.jsonl'),
        findings: (lines) => walletRequestFindings(lines),
      },
      ...diagnostics,
    },

    ...rest,
  };
}
