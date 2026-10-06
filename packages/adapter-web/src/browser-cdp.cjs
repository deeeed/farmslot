// browser-cdp.cjs — browser-level CDP client with deadlines, and the extension
// operations the launchers build on it: proof that a CDP port belongs to a
// slot profile, Extensions.loadUnpacked, and isolation of the loaded extension from
// other user extensions in that profile.
//
// Every command has a deadline and every pending command fails when the
// socket closes, so a browser that dies or stalls never hangs a launcher.
// Observers subscribe to CDP events (`onEvent`) and to the socket closing
// (`onClose`) on the same client.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extensionIdFromExtensionDir } = require('./extension-id.cjs');

const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deadlineError(what, ms) {
  return Object.assign(new Error(`${what} did not answer within ${ms}ms`), { code: 'CDP_TIMEOUT' });
}

/**
 * @typedef {{ method: string, params: Record<string, any>, sessionId?: string }} BrowserCdpEvent
 * @typedef {{ targetId: string, type: string, url: string }} BrowserCdpTarget
 */

async function connectBrowserCdp(
  port,
  { timeoutMs = 30000, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let url = null;
  while (!url && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
      });
      url = (await response.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(Math.max(1, Math.min(250, deadline - Date.now())));
    }
  }
  if (!url)
    throw Object.assign(
      new Error(`No browser CDP endpoint on 127.0.0.1:${port} within ${timeoutMs}ms.`),
      { code: 'CDP_TIMEOUT' },
    );
  const WebSocketImpl = globalThis.WebSocket ?? require('ws');
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  /** @type {Set<(event: BrowserCdpEvent) => void>} */
  const eventHandlers = new Set();
  /** @type {Set<() => void>} */
  const closeHandlers = new Set();
  let closedError = null;
  const failAll = (error) => {
    closedError ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(closedError);
    }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        reject(deadlineError(`Opening the browser CDP socket ${url}`, timeoutMs));
        try {
          socket.close();
        } catch {
          // Never opened.
        }
      },
      Math.max(1, deadline - Date.now()),
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Could not open browser CDP socket ${url}.`));
    };
  });
  const lost = () =>
    failAll(new Error('Browser CDP socket closed (the browser exited or disconnected).'));
  socket.onerror = lost;
  socket.onclose = () => {
    lost();
    for (const handler of [...closeHandlers]) handler();
    closeHandlers.clear();
    eventHandlers.clear();
  };
  let nextId = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (message.id === undefined && message.method) {
      const cdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const handler of [...eventHandlers]) handler(cdpEvent);
      return;
    }
    const entry = message.id === undefined ? null : pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  };
  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {string} [sessionId]
   * @param {number} [timeout]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}, sessionId, timeout = commandTimeoutMs) =>
    new Promise((resolve, reject) => {
      if (closedError) {
        reject(closedError);
        return;
      }
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(deadlineError(method, timeout));
        },
        Math.max(1, timeout),
      );
      pending.set(id, { resolve, reject, method, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    // Every CDP event (a message without an id), from the browser or an
    // attached session. Returns the unsubscribe function; a closed client
    // has no more events and keeps no handler.
    /**
     * @param {(event: BrowserCdpEvent) => void} handler
     * @returns {() => void}
     */
    onEvent: (handler) => {
      if (closedError) return () => {};
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    // Once, when the socket closes: the browser exited or `close()` was called.
    // On a client that is already closed, the handler runs at once.
    /**
     * @param {() => void} handler
     * @returns {() => void}
     */
    onClose: (handler) => {
      if (closedError) {
        handler();
        return () => {};
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close: () => {
      failAll(new Error('Browser CDP client closed.'));
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// ---- CDP port ownership ---------------------------------------------------

// lsof can take many seconds on a loaded Mac; give it room before failing,
// within the caller's budget. LC_ALL=C keeps `ps -o lstart` parseable and
// TZ=UTC makes it the same string for every caller, whatever its time zone.
const SUBPROCESS_TIMEOUT_MS = 30000;
const START_TIME_SLACK_MS = 2000;

function defaultExec(command, args, { timeoutMs = SUBPROCESS_TIMEOUT_MS } = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: Math.max(1, timeoutMs),
    // SIGKILL: a timed-out lsof must not linger past the caller's budget.
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
}

// The time left before `deadline` for one ownership subprocess; a spent budget
// is a specific error instead of a generic watchdog kill later.
// Not yet ready rather than refused: a browser that has just opened its port
// may not have written its SingletonLock or opened its profile yet.
function settling(message) {
  return Object.assign(new Error(message), { settling: true });
}

function budget(deadline, what) {
  const left = deadline - Date.now();
  if (left <= 0)
    throw Object.assign(new Error(`${what} ran out of its time budget.`), { code: 'CDP_TIMEOUT' });
  return Math.min(SUBPROCESS_TIMEOUT_MS, left);
}

// lsof exits 1 when nothing listens. A missing lsof must not read as "port
// free": callers would then start or load into a browser blind.
function cdpListenerPids(
  port,
  exec = defaultExec,
  { deadline = Date.now() + 2 * SUBPROCESS_TIMEOUT_MS } = {},
) {
  const what = `Inspecting CDP port ${port} with lsof`;
  const run = () =>
    exec('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], {
      timeoutMs: budget(deadline, what),
    });
  let output = '';
  try {
    try {
      output = run();
    } catch (error) {
      // One retry when lsof was killed by its timeout (heavily loaded host).
      if (!error.signal) throw error;
      output = run();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'lsof is required to prove which process holds a CDP port, and it is not on PATH. Next: install lsof (macOS ships it in /usr/sbin) and rerun.',
      );
    }
    if (error.code === 'CDP_TIMEOUT') throw error;
    if (error.status === 1) return [];
    throw new Error(`lsof could not inspect CDP port ${port}: ${error.message}`);
  }
  return String(output)
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// One spelling per profile: absolute, symlinks resolved, no trailing slash.
function canonicalProfile(profile) {
  const resolved = path.resolve(String(profile));
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Not created yet: the resolved path is the canonical spelling.
  }
  let canonical = real;
  while (canonical.length > 1 && canonical.endsWith(path.sep)) canonical = canonical.slice(0, -1);
  return canonical;
}

// Chrome's process singleton: <user-data-dir>/SingletonLock is a symlink to
// "<host>-<pid>" naming the browser process that holds the profile. Unlike a
// command line, it cannot be spoofed by another profile whose path merely
// starts with, or contains, this one. Returns the host, pid and the time the
// lock was written.
function profileLock(profile) {
  const lockPath = path.join(profile, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const dash = target.lastIndexOf('-');
    const pid = Number(target.slice(dash + 1));
    if (dash <= 0 || !Number.isInteger(pid) || pid <= 0) return null;
    return { host: target.slice(0, dash), pid, writtenAtMs: fs.lstatSync(lockPath).mtimeMs };
  } catch {
    return null;
  }
}

function processStartTime(pid, exec = defaultExec, { timeoutMs = SUBPROCESS_TIMEOUT_MS } = {}) {
  try {
    return String(exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs })).trim() || null;
  } catch (error) {
    if (error.signal) {
      throw Object.assign(
        new Error(`Reading the start time of pid ${pid} ran out of its time budget.`),
        { code: 'CDP_TIMEOUT' },
      );
    }
    return null;
  }
}

// Whether `pid` has a file open inside `profile` (Chrome keeps its profile
// databases open for its whole life). A process that merely reuses the pid
// of a dead browser holds nothing there.
function holdsProfileOpen(pid, profile, exec, timeoutMs) {
  let output = '';
  try {
    output = String(exec('lsof', ['-nP', '-p', String(pid), '-Fn'], { timeoutMs }));
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    if (error.signal) {
      throw Object.assign(
        new Error(`Listing the files pid ${pid} holds open ran out of its time budget.`),
        { code: 'CDP_TIMEOUT' },
      );
    }
    // lsof exits 1 when some files could not be listed; use what it printed.
    output = String(error.stdout ?? '');
  }
  const prefix = `n${profile}${path.sep}`;
  return output.split('\n').some((line) => line.startsWith(prefix));
}

// The browser on `port` is ours only if every listener is the process that
// holds this profile's SingletonLock, and that process is the one that wrote
// the lock: the lock names this host, the process started no later than the
// lock was written (a pid reused after the browser died started later), and
// it has files open inside the profile. Returns its identity (pid + start
// time) so a connection can be bound to it and re-checked; refuses anything
// else (another slot, the operator's own Chrome, an unknown process).
function cdpOwner(
  port,
  profile,
  { exec = defaultExec, timeoutMs = 2 * SUBPROCESS_TIMEOUT_MS + 10000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const canonical = canonicalProfile(profile);
  const pids = cdpListenerPids(port, exec, { deadline });
  if (pids.length === 0)
    throw settling(`No process listens on CDP port ${port}; refusing to load the extension.`);
  const lock = profileLock(canonical);
  if (lock === null) {
    throw settling(
      `No browser holds the profile ${canonical} (no SingletonLock); refusing to load the extension into the browser on CDP port ${port}.`,
    );
  }
  const lockPid = lock.pid;
  const foreign = pids.filter((pid) => pid !== lockPid);
  if (foreign.length > 0 || !pids.includes(lockPid)) {
    throw new Error(
      `CDP port ${port} is held by pid ${pids.join(', ')}, but the browser holding ${canonical} is pid ${lockPid}; ` +
        'refusing to load the extension into a browser this launch did not start.',
    );
  }
  if (lock.host !== os.hostname()) {
    throw new Error(
      `The SingletonLock of ${canonical} names host ${lock.host}, not ${os.hostname()}; refusing to load the extension.`,
    );
  }
  const startedAt = processStartTime(lockPid, exec, {
    timeoutMs: budget(deadline, `Reading the start time of pid ${lockPid}`),
  });
  if (!startedAt)
    throw new Error(
      `Could not read the start time of pid ${lockPid}; refusing to load the extension.`,
    );
  const startedMs = Date.parse(`${startedAt} UTC`);
  if (!Number.isFinite(startedMs))
    throw new Error(
      `Could not parse the start time of pid ${lockPid} (${startedAt}); refusing to load the extension.`,
    );
  // lstart truncates to the second, and on Linux it is derived from boot time
  // and can read a little late after clock slews; allow that slack. A reused
  // pid starts long after the dead browser wrote its lock.
  if (startedMs > lock.writtenAtMs + START_TIME_SLACK_MS) {
    throw new Error(
      `pid ${lockPid} started after the SingletonLock of ${canonical} was written, so it is not the browser that holds the profile (a reused pid); ` +
        'refusing to load the extension.',
    );
  }
  if (
    !holdsProfileOpen(
      lockPid,
      canonical,
      exec,
      budget(deadline, `Listing the files pid ${lockPid} holds open`),
    )
  ) {
    throw settling(
      `pid ${lockPid} has no file open in ${canonical}, so it is not the browser that holds the profile; refusing to load the extension.`,
    );
  }
  return { pid: lockPid, startedAt, profile: canonical, cdpPort: Number(port) };
}

// Re-prove ownership after connecting: same pid, same start time (no pid reuse,
// no browser swapped in between the check and the connection).
/**
 * @param {{ pid: number, startedAt: string, profile: string, cdpPort: number }} owner
 * @param {{ exec?: typeof defaultExec, timeoutMs?: number }} [options]
 */
function assertSameOwner(owner, { exec = defaultExec, timeoutMs } = {}) {
  const current = cdpOwner(owner.cdpPort, owner.profile, {
    exec,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (current.pid !== owner.pid || current.startedAt !== owner.startedAt) {
    throw new Error(
      `CDP port ${owner.cdpPort} changed hands (pid ${owner.pid} → ${current.pid}); refusing to load the extension.`,
    );
  }
  return current;
}

/**
 * @param {number} port
 * @param {string} profile
 * @param {{ exec?: typeof defaultExec, timeoutMs?: number }} [options]
 */
function assertCdpOwnedByProfile(port, profile, options = {}) {
  return cdpOwner(port, profile, options);
}

// The owning browser's identity right after a launch: retries only while the
// browser is still settling (no listener, lock or open profile yet), and every
// attempt and wait is clipped to the remaining `timeoutMs`. Synchronous for the
// sync launchers.
function waitForCdpOwner(port, profile, { timeoutMs = 30000, exec = defaultExec } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0)
      throw Object.assign(
        new Error(
          `The browser on CDP port ${port} did not prove it holds ${profile} within ${timeoutMs}ms.`,
        ),
        { code: 'CDP_TIMEOUT' },
      );
    try {
      return cdpOwner(port, profile, { exec, timeoutMs: left });
    } catch (error) {
      if (!error.settling || Date.now() + 200 >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

// ---- extension loading ----------------------------------------------------

// Load an unpacked extension through a browser-level CDP `send` and wait until
// one of its targets (service worker / background) is up.
async function loadUnpackedExtension(
  send,
  extensionDir,
  { expectedId = null, timeoutMs = 60000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const dir = path.resolve(extensionDir);
  let id = null;
  let lastError = null;
  while (!id && Date.now() < deadline) {
    try {
      id = (
        await send(
          'Extensions.loadUnpacked',
          { path: dir },
          undefined,
          Math.min(remaining(), DEFAULT_COMMAND_TIMEOUT_MS),
        )
      ).id;
    } catch (error) {
      lastError = error;
      if (/socket closed|client closed/u.test(error.message)) break;
      await sleep(Math.min(500, remaining()));
    }
  }
  if (!id) {
    throw new Error(
      `Extensions.loadUnpacked failed for ${dir}: ${lastError?.message ?? 'timed out'}. The browser must run with --enable-unsafe-extension-debugging.`,
    );
  }
  if (expectedId && id !== expectedId) {
    throw new Error(
      `Extensions.loadUnpacked returned extension id ${id}, but the manifest key gives ${expectedId}.`,
    );
  }
  const prefix = `chrome-extension://${id}/`;
  while (Date.now() < deadline) {
    const { targetInfos } = await send(
      'Target.getTargets',
      {},
      undefined,
      Math.min(remaining(), DEFAULT_COMMAND_TIMEOUT_MS),
    );
    if (
      targetInfos.some(
        (target) =>
          target.url.startsWith(prefix) &&
          ['service_worker', 'background_page', 'page', 'other'].includes(target.type),
      )
    ) {
      return { id };
    }
    await sleep(Math.min(250, remaining()));
  }
  throw new Error(`Extension ${id} loaded but no extension target started within ${timeoutMs}ms.`);
}

// Branded Chrome runs without --disable-extensions-except (it would disable the
// CDP-loaded extension), so External Extensions and enterprise force-installs
// reach a slot profile. chrome://extensions lists user extensions (component
// extensions excluded). Every other extension the user may modify is disabled
// in the slot profile, matching what --disable-extensions-except does for
// Chrome for Testing. Extensions an enterprise policy pins (mustRemainInstalled,
// not user-modifiable) cannot be disabled by any client; they are returned so
// the caller records them in the run evidence. Anything left enabled that is
// neither the loaded extension nor policy-pinned fails the load.
const LIST_EXTENSIONS =
  'new Promise((resolve, reject) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, (items) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(items.map(({ id, name, location, state, mustRemainInstalled, userMayModify }) => ({ id, name, location, state, mustRemainInstalled, userMayModify })))))';

const SET_DISABLED =
  'function (id) { return new Promise((resolve) => chrome.management.setEnabled(id, false, () => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok"))); }';

async function isolateExtension(send, extensionId, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  // A background tab (or, in a browser with no window yet, a background
  // window): the extensions page must never take the operator's focus.
  const { targetInfos } = await send('Target.getTargets', {}, undefined, left());
  const hasWindow = (targetInfos || []).some((target) => target.type === 'page');
  const { targetId } = await send(
    'Target.createTarget',
    { url: 'chrome://extensions/', background: true, ...(hasWindow ? {} : { newWindow: true }) },
    undefined,
    left(),
  );
  try {
    const { sessionId } = await send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      left(),
    );
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        Math.max(1, deadline - Date.now()),
      );
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    const list = async () => {
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          return (await evaluate(LIST_EXTENSIONS)).filter((entry) => entry.id !== extensionId);
        } catch (error) {
          lastError = error;
          await sleep(Math.min(250, left()));
        }
      }
      throw new Error(`Could not list installed extensions: ${lastError?.message ?? 'timed out'}`);
    };
    const policyPinned = (entry) =>
      entry.mustRemainInstalled === true && entry.userMayModify === false;
    const describe = ({ id, name, location }) => ({ id, name, location });
    const disabled = [];
    // The page's global object, so the id travels as a CDP call argument
    // rather than as text spliced into evaluated code.
    const { result: pageGlobal } = await send(
      'Runtime.evaluate',
      { expression: 'globalThis' },
      sessionId,
      Math.max(1, deadline - Date.now()),
    );
    for (const entry of await list()) {
      if (entry.state !== 'ENABLED' || policyPinned(entry)) continue;
      const { result, exceptionDetails } = await send(
        'Runtime.callFunctionOn',
        {
          objectId: pageGlobal.objectId,
          functionDeclaration: SET_DISABLED,
          arguments: [{ value: entry.id }],
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        Math.max(1, deadline - Date.now()),
      );
      if (!exceptionDetails && result.value === 'ok') disabled.push(describe(entry));
    }
    const remaining = await list();
    const stillEnabled = remaining.filter(
      (entry) => entry.state === 'ENABLED' && !policyPinned(entry),
    );
    if (stillEnabled.length > 0) {
      throw new Error(
        `The slot profile keeps user extensions besides the loaded extension enabled: ${stillEnabled.map((entry) => `${entry.id} (${entry.name}, ${entry.location})`).join(', ')}. ` +
          'Remove them from External Extensions, or use RECIPE_HARNESS_BROWSER=cft.',
      );
    }
    return {
      disabled,
      policyPinned: remaining
        .filter((entry) => entry.state === 'ENABLED' && policyPinned(entry))
        .map(describe),
    };
  } finally {
    await send('Target.closeTarget', { targetId }, undefined, Math.min(5000, left())).catch(
      () => {},
    );
  }
}

// A new window that does not take the operator's focus: a browser started in
// the background (no startup window) opens its first window this way.
async function openBackgroundWindow(send, url, timeoutMs) {
  return send(
    'Target.createTarget',
    { url, newWindow: true, background: true },
    undefined,
    timeoutMs,
  );
}

const isBlankPage = (target) =>
  target.type === 'page' &&
  (target.url === 'about:blank' ||
    target.url.startsWith('chrome://newtab') ||
    target.url.startsWith('chrome://new-tab-page'));

// A browser started without a window gets a blank background window, so the
// first window never takes the operator's focus and nothing is navigated yet.
async function ensureBackgroundWindow(send, remaining) {
  const { targetInfos } = await send('Target.getTargets', {}, undefined, remaining());
  if ((targetInfos || []).some((target) => target.type === 'page')) return;
  await openBackgroundWindow(send, 'about:blank', remaining());
}

// Move a target's window to `bounds` over CDP, so an off-display window becomes
// recordable. A visible window moves without activating the browser; restoring a
// minimized one can bring Chrome to the front on macOS.
async function placeWindow(send, targetId, bounds, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const { windowId } = await send('Browser.getWindowForTarget', { targetId }, undefined, timeoutMs);
  // Chrome refuses a position or size change on a minimized window.
  await send(
    'Browser.setWindowBounds',
    { windowId, bounds: { windowState: 'normal' } },
    undefined,
    timeoutMs,
  );
  await send('Browser.setWindowBounds', { windowId, bounds }, undefined, timeoutMs);
  return windowId;
}

// Point the launch tab at `url` once the extension exists: the tab opened at
// launch would otherwise show an error page for chrome-extension:// URLs.
async function openUrl(send, url, remaining) {
  const { targetInfos } = await send('Target.getTargets', {}, undefined, remaining());
  const blank = (targetInfos || []).find(isBlankPage);
  if (!blank) {
    await openBackgroundWindow(send, url, remaining());
    return;
  }
  const { sessionId } = await send(
    'Target.attachToTarget',
    { targetId: blank.targetId, flatten: true },
    undefined,
    remaining(),
  );
  await send('Page.navigate', { url }, sessionId, remaining());
  await send('Target.detachFromTarget', { sessionId }, undefined, remaining());
}

// Prove the browser on `port` holds `profile`, bind the connection to that
// process, load the extension, check its id against the manifest key, isolate
// it from other user extensions, then open `url` — all inside one deadline.
// Returns { id, otherExtensions: { disabled, policyPinned }, owner } for the
// caller's browser record. Callers own stopping the browser when this throws.
const OWNER_SETTLE_MS = 5000;

/**
 * @param {number} port
 * @param {string} extensionDir
 * @param {{ profile: string, expectedId?: string | null, url?: string | null, timeoutMs?: number, exec?: typeof defaultExec }} options
 */
async function loadUnpackedOverPort(
  port,
  extensionDir,
  {
    profile,
    expectedId = extensionIdFromExtensionDir(extensionDir) || null,
    url = null,
    timeoutMs = 60000,
    exec = defaultExec,
  } = {},
) {
  if (!profile)
    throw new Error('loadUnpackedOverPort requires the slot profile that owns the CDP port.');
  const deadline = Date.now() + timeoutMs;
  let step = 'proving the CDP port owner';
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0)
      throw Object.assign(
        deadlineError(`Loading the extension on CDP port ${port} (${step})`, timeoutMs),
        { budgetSpent: true },
      );
    return left;
  };
  let client = null;
  try {
    // A browser that has just opened its port may not have written its lock or
    // opened its profile yet: while it is settling, a new attempt starts only
    // within OWNER_SETTLE_MS. Each attempt is clipped to the load budget, not to
    // that window: lsof alone can take tens of seconds on a loaded host.
    const settleUntil = Math.min(deadline, Date.now() + OWNER_SETTLE_MS);
    let owner = null;
    while (!owner) {
      try {
        owner = cdpOwner(port, profile, { exec, timeoutMs: remaining() });
      } catch (error) {
        if (!error.settling || Date.now() + 250 >= settleUntil) throw error;
        await sleep(250);
        // A late wake must not start an attempt past the settle window.
        if (Date.now() >= settleUntil) throw error;
      }
    }
    step = 'connecting';
    client = await connectBrowserCdp(port, { timeoutMs: remaining() });
    step = 're-proving the CDP port owner';
    assertSameOwner(owner, { exec, timeoutMs: remaining() });
    step = 'Extensions.loadUnpacked';
    const loaded = await loadUnpackedExtension(client.send, extensionDir, {
      expectedId,
      timeoutMs: remaining(),
    });
    // A browser started without a window gets a blank background window
    // first; other extensions are disabled before the start page (a dapp, or
    // the extension home) loads in it.
    step = 'opening a background window';
    await ensureBackgroundWindow(client.send, remaining);
    step = 'isolating the loaded extension from other extensions';
    const otherExtensions = await isolateExtension(client.send, loaded.id, {
      timeoutMs: remaining(),
    });
    step = 'opening the start page';
    if (url) await openUrl(client.send, url, remaining);
    remaining();
    return { ...loaded, otherExtensions, owner };
  } catch (error) {
    // Whatever step was cut short, a spent budget reads as the budget and names the step.
    if (!error.budgetSpent && (Date.now() >= deadline || error.code === 'CDP_TIMEOUT')) {
      const what = Date.now() >= deadline ? `ran out of its ${timeoutMs}ms budget` : 'timed out';
      throw Object.assign(
        new Error(
          `Loading the extension on CDP port ${port} ${what} while ${step}: ${error.message}`,
        ),
        { code: 'CDP_TIMEOUT', cause: error },
      );
    }
    throw error;
  } finally {
    client?.close();
  }
}

function expectedExtensionId(extensionDir) {
  return extensionIdFromExtensionDir(extensionDir) || null;
}

// ---- target lists ---------------------------------------------------------

// One entry of `Target.getTargets` (`targetId`) or of the `/json` list (`id`),
// or null when it lacks an id, type or URL.
/**
 * @param {unknown} value
 * @returns {BrowserCdpTarget | null}
 */
function asBrowserCdpTarget(value) {
  const target = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  const targetId = String(target.targetId ?? target.id ?? '');
  const type = String(target.type ?? '');
  const url = String(target.url ?? '');
  return targetId && type && url ? { targetId, type, url } : null;
}

// The id of the first extension that has a target in the list.
/**
 * @param {unknown} targets
 * @returns {string | null}
 */
function extensionIdFromCdpTargets(targets) {
  for (const candidate of Array.isArray(targets) ? targets : []) {
    const target = asBrowserCdpTarget(candidate);
    if (!target) continue;
    try {
      const url = new URL(target.url);
      if (url.protocol === 'chrome-extension:' && url.hostname) return url.hostname;
    } catch {
      // Not a URL: not an extension target.
    }
  }
  return null;
}

module.exports = {
  DEFAULT_COMMAND_TIMEOUT_MS,
  START_TIME_SLACK_MS,
  assertCdpOwnedByProfile,
  asBrowserCdpTarget,
  assertSameOwner,
  canonicalProfile,
  cdpListenerPids,
  cdpOwner,
  processStartTime,
  waitForCdpOwner,
  connectBrowserCdp,
  expectedExtensionId,
  extensionIdFromCdpTargets,
  loadUnpackedExtension,
  loadUnpackedOverPort,
  ensureBackgroundWindow,
  isolateExtension,
  openBackgroundWindow,
  openUrl,
  placeWindow,
};
