// Read-only readiness of a web-dapp slot for recipe runs: checkout shape,
// dependencies, the slot dev server, forced testnet, wallet fixture, browser,
// the extension signer's own checks (its `readinessChecks` hook) and the
// per-slot CDP port. Never launches anything except the optional short-lived
// browser start probe.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ownsProcess, pidAlive, portFree } from './processes.mjs';
import {
  canonicalPath,
  fixtureEntry,
  loadWalletFixture,
  readBrowserState,
  viemAccountFromEntry,
  webDappPolicy,
  webDappRuntimeDir,
} from './runtime.mjs';

/**
 * @param {string} id
 * @param {boolean} ok
 * @param {string} detail
 * @param {{ required?: boolean, status?: 'pass' | 'fail' | 'warn' }} [options]
 */
export function check(id, ok, detail, { required = true, status } = {}) {
  return { id, status: status ?? (ok ? 'pass' : 'fail'), required, detail };
}

async function httpStatus(url, timeoutMs = 20000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    return response.status;
  } catch (error) {
    return error?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
  }
}

// Diagnostic only. Whether the slot's dev server looks configured for testnet:
// the farm starts `next dev` (temp/farmslot/next-dev.pid) with the policy's
// testnet variable set to true (the Terminal's
// NEXT_PUBLIC_HYPERLIQUID_FORCE_TESTNET). Process inspection cannot prove
// what the browser talks to (macOS reports a process's initial environment,
// and lsof cannot see other users' sockets), so this only warns; the browser
// is held to testnet by the network and wallet layers (the venue policy's
// blocked hosts, the wallet host). Each listener on the app port must descend
// from the pid-file process and run from the checkout (its cwd); every process on the way from
// a listener up to the pid-file process is read exactly (argv and environment
// entries from sysctl KERN_PROCARGS2) and must carry the testnet variable. An
// unreadable process makes the result unknown.
export const DEV_SERVER_PID_FILE = 'temp/farmslot/next-dev.pid';

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    return typeof error?.stdout === 'string' ? error.stdout : '';
  }
}

const PROCARGS_HELPER = `
import ctypes, ctypes.util, json, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
pid = int(sys.argv[1])
argmax = ctypes.c_int(0)
size = ctypes.c_size_t(ctypes.sizeof(argmax))
if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
    print("null"); sys.exit(0)
buf = ctypes.create_string_buffer(argmax.value)
size = ctypes.c_size_t(argmax.value)
if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buf, ctypes.byref(size), None, 0) != 0:
    print("null"); sys.exit(0)
raw = buf.raw[:size.value]
argc = struct.unpack("i", raw[:4])[0]
rest = raw[4:]
rest = rest[rest.index(b"\\0"):].lstrip(b"\\0")
parts = rest.split(b"\\0")
env = []
for part in parts[argc:]:
    if not part: break
    env.append(part.decode("utf-8", "replace"))
print(json.dumps({"argv": [p.decode("utf-8", "replace") for p in parts[:argc]], "env": env}))
`;

export const systemProbe = Object.freeze({
  listeners: (port) =>
    run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      .split('\n')
      .map(Number)
      .filter((pid) => pid > 0),
  parents: () =>
    new Map(
      run('ps', ['-A', '-o', 'pid=,ppid='])
        .split('\n')
        .map((line) => line.trim().split(/\s+/u).map(Number))
        .filter(([pid, ppid]) => pid > 0 && ppid >= 0),
    ),
  cwd: (pid) =>
    (
      run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
        .split('\n')
        .find((line) => line.startsWith('n')) ?? ''
    ).slice(1) || null,
  // { argv: string[], env: string[] } with exact element boundaries, or null.
  procArgs: (pid) => {
    const python = usablePython();
    if (!python) return null;
    try {
      return JSON.parse(
        execFileSync(python, ['-c', PROCARGS_HELPER, String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 15000,
        }).trim(),
      );
    } catch {
      return null;
    }
  },
});

// macOS's /usr/bin/python3 is a stub until the Command Line Tools are
// installed, and running it opens an install dialog that takes keyboard
// focus. Use it only when xcode-select reports a developer directory; any
// other python3 on PATH is a real install.
export function pythonFor({ found, platform = process.platform, developerDir }) {
  if (!found) return null;
  if (platform === 'darwin' && found === '/usr/bin/python3' && !developerDir()) return null;
  return found;
}

let pythonChoice;
function usablePython() {
  if (pythonChoice === undefined) {
    pythonChoice = pythonFor({
      found: run('/usr/bin/which', ['python3']).trim(),
      developerDir: () => run('/usr/bin/xcode-select', ['-p']).trim(),
    });
  }
  return pythonChoice;
}

export function environmentValue(env, name) {
  const entry = env.find((item) => item.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(name.length + 1);
}

// `next dev` / `next start`: the argument after the next binary.
export function nextServerMode(argv) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    const element = argv[index];
    if (
      element === 'next' ||
      element.endsWith('/next') ||
      element.endsWith('/next/dist/bin/next')
    ) {
      if (argv[index + 1] === 'dev' || argv[index + 1] === 'start') return argv[index + 1];
    }
  }
  return null;
}

function chainTo(listener, root, parents) {
  const chain = [];
  let current = listener;
  for (let hops = 0; current && hops < 64; hops += 1) {
    chain.push(current);
    if (current === root) return chain;
    current = parents.get(current);
  }
  return null;
}

/**
 * @param {string} target
 * @param {{ appPort?: number, variable?: string, probe?: typeof systemProbe }} [options]
 */
export function devServerTestnetDiagnostic(
  target,
  { appPort, variable, probe = systemProbe } = {},
) {
  const checkout = canonicalPath(target);
  const unknown = (detail) => ({ known: false, forced: false, detail });
  const pidFile = path.join(checkout, DEV_SERVER_PID_FILE);
  if (!existsSync(pidFile)) return unknown(`no ${DEV_SERVER_PID_FILE}`);
  const root = Number(readFileSync(pidFile, 'utf8').trim());
  if (!pidAlive(root)) return unknown(`next dev pid ${root} is not running`);
  if (!appPort) return unknown('no app port to check');
  const listeners = probe.listeners(appPort);
  if (listeners.length === 0)
    return unknown(`nothing (visible to this user) listens on app port ${appPort}`);
  const parents = probe.parents();
  let mode = null;
  for (const listener of listeners) {
    const chain = chainTo(listener, root, parents);
    if (!chain)
      return {
        known: true,
        forced: false,
        detail: `app port ${appPort} is served by pid ${listener}, outside next dev pid ${root}`,
      };
    const cwd = probe.cwd(listener);
    if (!cwd || canonicalPath(cwd) !== checkout) {
      return {
        known: true,
        forced: false,
        detail: `pid ${listener} on app port ${appPort} runs from ${cwd ?? 'an unknown directory'}, not ${checkout}`,
      };
    }
    for (const pid of chain) {
      const args = probe.procArgs(pid);
      if (!args) return unknown(`cannot read the arguments and environment of pid ${pid}`);
      // A process that rewrote its title (next-server) overwrote the memory
      // its arguments and environment are read from.
      if (args.env.length === 0)
        return unknown(
          `pid ${pid} (${args.argv[0] ?? '?'}) rewrote its process title; its environment is not readable`,
        );
      const processMode = nextServerMode(args.argv);
      if (processMode === 'start')
        return {
          known: true,
          forced: false,
          detail: `pid ${pid} runs next start; its environment cannot prove what the build inlined`,
        };
      if (processMode === 'dev') mode = 'dev';
      const value = environmentValue(args.env, variable);
      if (value !== 'true') {
        return {
          known: true,
          forced: false,
          detail: `pid ${pid} (between app port ${appPort} and next dev pid ${root}) has ${variable}=${value ?? '<unset>'}`,
        };
      }
    }
  }
  if (mode !== 'dev')
    return {
      known: true,
      forced: false,
      detail: `no process serving app port ${appPort} runs next dev`,
    };
  return {
    known: true,
    forced: true,
    detail: `every process from app port ${appPort}'s listeners (cwd ${checkout}) up to next dev pid ${root} has ${variable}=true`,
  };
}

export const MAINNET_CONFIRMATION = 'REAL_FUNDS';

// The launch only checks the requested network: mainnet needs the real-funds
// confirmation. Testnet is enforced inside the browser (the venue policy's blocked hosts).
/**
 * @param {string} _target
 * @param {{ network?: string | null, mainnetConfirmation?: string }} [options]
 * @returns {'testnet' | 'mainnet'}
 */
export function assertLaunchNetwork(_target, { network, mainnetConfirmation } = {}) {
  const requested = network == null || network === '' ? 'testnet' : String(network);
  if (requested !== 'testnet' && requested !== 'mainnet') {
    throw new Error(`network must be testnet or mainnet, got ${JSON.stringify(network)}.`);
  }
  if (requested === 'mainnet' && mainnetConfirmation !== MAINNET_CONFIRMATION) {
    throw new Error(
      `network=mainnet needs mainnet_confirmation=${MAINNET_CONFIRMATION}; refusing to launch the ${webDappPolicy().adapterId} browser.`,
    );
  }
  return requested;
}

// "a, b and c".
function listing(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

// `policy`: the venue policy (checkout, dependencies, startPath, testnetVariable);
// by default the one RECIPE_WEB_DAPP_POLICY names. `signers`: the signer hooks
// by mode; signer=extension is judged by `signers.extension.readinessChecks`
// (`{ target, env, required }`, returning checks built with `check`).
/**
 * @param {{
 *   policy?: any,
 *   signers?: Record<string, any>,
 *   target: string,
 *   appPort?: number,
 *   cdpPort?: number,
 *   signer?: string,
 *   account?: string,
 *   env?: NodeJS.ProcessEnv,
 *   probeBrowser?: (env: NodeJS.ProcessEnv) => Promise<{ bin: string, version: string | null, source: string }>,
 * }} options
 */
export async function webDappReadiness({
  policy = webDappPolicy(),
  signers = {},
  target,
  appPort,
  cdpPort,
  signer = 'extension',
  account = 'dev1',
  env = process.env,
  probeBrowser = undefined,
}) {
  const checks = [];
  const shape = policy.checkout.matches(target);
  checks.push(
    check(
      'checkout',
      shape,
      shape ? policy.checkout.label : `${target} is not a ${policy.checkout.name} checkout`,
    ),
  );
  const deps = policy.dependencies.filter(
    (name) => !existsSync(path.join(target, 'node_modules', name, 'package.json')),
  );
  checks.push(
    check(
      'dependencies',
      deps.length === 0,
      deps.length === 0
        ? `${listing(policy.dependencies)} installed`
        : `missing: ${deps.join(', ')} (run npm ci on Node 22)`,
    ),
  );

  if (appPort) {
    const status = await httpStatus(`http://127.0.0.1:${appPort}${policy.startPath}`);
    checks.push(
      check(
        'app-dev-server',
        status === 200,
        `GET http://localhost:${appPort}${policy.startPath} -> ${status}`,
      ),
    );
  } else {
    checks.push(
      check(
        'app-dev-server',
        false,
        'no dev-server port; pass --watcher-port <port> or set TERMINAL_APP_PORT',
      ),
    );
  }
  // Advisory: the browser enforces testnet itself (the venue policy's blocked hosts).
  const testnet = devServerTestnetDiagnostic(target, { appPort, variable: policy.testnetVariable });
  checks.push(
    check('testnet-forced', testnet.known && testnet.forced, testnet.detail, {
      required: false,
      status: testnet.known && testnet.forced ? 'pass' : 'warn',
    }),
  );

  try {
    const { file, fixture } = await loadWalletFixture(target, env);
    const address = viemAccountFromEntry(fixtureEntry(fixture, account), target).address;
    checks.push(
      check('wallet-fixture', true, `${path.basename(file)}: account ${account} -> ${address}`),
    );
  } catch (error) {
    checks.push(check('wallet-fixture', false, error.message.split('\n')[0]));
  }

  if (probeBrowser) {
    try {
      const browser = await probeBrowser(env);
      checks.push(check('browser', true, `${browser.version ?? browser.bin} (${browser.source})`));
    } catch (error) {
      checks.push(check('browser', false, error.message.split('\n')[0]));
    }
  }

  const extensionRequired = signer === 'extension';
  if (signers.extension?.readinessChecks) {
    checks.push(
      ...(await signers.extension.readinessChecks({ target, env, required: extensionRequired })),
    );
  } else if (extensionRequired) {
    checks.push(
      check(
        'extension-signer',
        false,
        'no extension signer is configured (signers.extension / RECIPE_WEB_DAPP_SIGNER_MODULE)',
      ),
    );
  }

  const state = await readBrowserState(target);
  const runtime = webDappRuntimeDir(target);
  const live = Boolean(
    state &&
    ownsProcess('browser', state.browserPid, runtime) &&
    ownsProcess('wallet-host', state.hostPid, runtime),
  );
  if (cdpPort) {
    const free = await portFree(cdpPort);
    const owned = live && state.cdpPort === cdpPort;
    checks.push(
      check(
        'cdp-port',
        free || owned,
        free
          ? `CDP port ${cdpPort} is free`
          : owned
            ? `CDP port ${cdpPort} held by this slot's browser`
            : `CDP port ${cdpPort} is held by another process`,
      ),
    );
  } else {
    checks.push(check('cdp-port', false, 'no CDP port; pass --cdp-port <port>'));
  }
  checks.push(
    check(
      'browser-live',
      live,
      live
        ? `browser pid ${state.browserPid} (${state.signer}, ${state.account?.name}) and wallet host pid ${state.hostPid}`
        : 'no slot browser running (the launch recipe node starts it)',
      { required: false },
    ),
  );

  const failed = checks
    .filter((item) => item.required && item.status === 'fail')
    .map((item) => item.id);
  return {
    status: failed.length === 0 ? 'pass' : 'fail',
    checks,
    failed,
    browser: live ? state : null,
  };
}
