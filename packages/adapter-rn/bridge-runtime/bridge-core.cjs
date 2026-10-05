/**
 * Bridge core — the generic React Native CDP bridge CLI a host harness builds
 * on. It attaches to the running app's Hermes runtime (directly, or through the
 * CDP broker when one is running) and dispatches one command per process.
 *
 * The host owns a small preset file that calls `runBridgeCli(config)` with its
 * product commands, route table, recovery hints and help lines; everything
 * generic (UI gestures, eval, HUD, profiler, issue capture, network capture,
 * the debugger-slot lock, target selection and typed errors) lives here.
 * Loading this module runs nothing.
 *
 * Environment:
 *   WATCHER_PORT  Metro port (default: 8081, read from .js.env if present)
 *   CDP_TIMEOUT   Connection timeout in ms (default: 5000)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  brokerSocketPath,
  createBrokerClient,
  deviceIdFromUrl,
} = require('@farmslot/recipe-runner/cdp-broker');
const { loadPort } = require('./lib/config.cjs');
const { discoverAllTargets, discoverTarget } = require('./lib/target-discovery.cjs');
const { createWSClient } = require('./lib/ws-client.cjs');
const {
  BRIDGE_ERROR_CODES,
  EXIT_CODE_BY_ERROR_CODE,
  classifyBridgeErrorMessage,
  coded,
  formatErrorMarker,
} = require('./lib/bridge-errors.cjs');
const { cdpEval, cdpEvalAsync } = require('./lib/cdp-eval.cjs');
const { buildArmSnippet, buildCollectSnippet } = require('./lib/issue-capture.cjs');

/**
 * A bridge command. Built-ins and host commands share this signature; the
 * resolved value is printed as pretty JSON on stdout.
 * @callback BridgeCommand
 * @param {object} client CDP client (direct WebSocket or broker client).
 * @param {string[]} args Arguments after the command name.
 * @param {BridgeCommandContext} [context]
 * @returns {Promise<unknown>}
 */

/**
 * @typedef {object} BridgeCommandContext
 * @property {string} [deviceName] Name of the selected target.
 * @property {string} [platform] `__AGENTIC__.platform` of the target ('' for deferred commands).
 * @property {string} [runtimeIdentity] Set for `status-selected` only.
 */

/**
 * Where a host command shows up in `--help` and in the unknown-command listing.
 * An anchor names a command already placed (built-in or an earlier host
 * command); without one the command goes last.
 * @typedef {object} BridgeCommandDoc
 * @property {string} [help] Verbatim `--help` line(s), without a trailing newline.
 * @property {string} [helpAfter] Command whose help line this one follows.
 * @property {string} [listAfter] Command this one follows in the `Available:` listing.
 */

/**
 * Route table for `navigate`.
 * @typedef {object} BridgeRoutes
 * @property {Record<string, string>} [aliases] Friendly name → route name.
 * @property {Record<string, string>} [nestedParents] Nested route → parent
 *   navigator; such routes navigate as `navigate(parent, { screen, params })`.
 */

/**
 * @typedef {object} BridgeCliConfig
 * @property {Record<string, BridgeCommand>} [commands] Host commands. A name that
 *   collides with a built-in throws. A host `status` command is probed on every
 *   target, and `status-selected` runs it on the selected target only.
 * @property {Record<string, BridgeCommandDoc>} [commandDocs] Help and listing
 *   placement for host commands.
 * @property {BridgeRoutes} [routes] Route table used by `navigate`.
 * @property {Record<string, string>} [teachingByErrorCode] Recovery hint printed
 *   after the `ERROR[<CODE>]` marker of a coded failure.
 * @property {string} [appLabel] App name in the `--help` title.
 * @property {string} [usagePath] Script path in the `--help` usage line
 *   (default: the script's file name).
 * @property {string[]} [perfMarkerPrefixes] Console prefixes whose JSON payload
 *   `measure-scroll-transition` reads as a visible-stage event.
 * @property {string} [readyExpression] JS expression evaluated when
 *   `measure-scroll-transition` gets `requireWalletReady: true`. It must return
 *   `{ ready: boolean, observedAtMs: number, ... }`; without it there is no
 *   readiness gate.
 */

const APPLY_HUD_UPDATE_FUNCTION = `function(step) {
  const bridge = this.__AGENTIC__;
  if (step === null) {
    if (typeof bridge?.hideStep !== 'function') return false;
    setTimeout(() => bridge.hideStep(), 0);
    return true;
  }
  if (typeof bridge?.showStep !== 'function') return false;
  setTimeout(() => bridge.showStep(step), 0);
  return true;
}`;

function mobileToolPath(tool) {
  return process.env[`RECIPE_RN_${tool.toUpperCase()}_PATH`] || tool;
}

function bootedIosDevice(deviceName) {
  if (!deviceName) return null;
  let listing;
  try {
    listing = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
      encoding: 'utf8',
    });
  } catch {
    // Recovery is correct: without a working `xcrun simctl` (no Xcode, or not
    // macOS) no simulator is booted for us; callers fall back or report it.
    return null;
  }
  const devices = JSON.parse(listing);
  const device = Object.values(devices.devices || {})
    .flat()
    .find(
      (candidate) =>
        (candidate?.name === deviceName || candidate?.udid === deviceName) &&
        candidate?.state === 'Booted',
    );
  return device?.udid ? device : null;
}

function tapVisibleIosAccessibilityTarget(testId, deviceName, platform) {
  if (platform !== 'ios') return null;
  const device = bootedIosDevice(deviceName);
  if (!device) return null;
  const idb = mobileToolPath('idb');
  let describeOutput;
  try {
    describeOutput = execFileSync(idb, ['ui', 'describe-all', '--udid', device.udid, '--json'], {
      encoding: 'utf8',
    });
  } catch {
    // Recovery is correct: the native tap is a fallback; when idb cannot run,
    // press-test-id reports the app bridge's own result or error instead.
    return null;
  }
  const elements = JSON.parse(describeOutput);
  const windowFrame = elements
    .map((element) => element?.frame)
    .filter(
      (frame) => frame && frame.x === 0 && frame.y === 0 && frame.width > 0 && frame.height > 0,
    )
    .sort((first, second) => second.width * second.height - first.width * first.height)[0];
  if (!windowFrame) return null;
  const target = elements.find((element) => {
    const frame = element?.frame;
    return (
      element?.AXUniqueId === testId &&
      element?.enabled !== false &&
      element?.hittable !== false &&
      frame &&
      frame.width > 0 &&
      frame.height > 0 &&
      frame.x >= 0 &&
      frame.y >= 0 &&
      frame.x + frame.width <= windowFrame.width &&
      frame.y + frame.height <= windowFrame.height
    );
  });
  if (!target) return null;
  const x = Math.round(target.frame.x + target.frame.width / 2);
  const y = Math.round(target.frame.y + target.frame.height / 2);
  try {
    execFileSync(idb, ['ui', 'tap', String(x), String(y), '--udid', device.udid], {
      encoding: 'utf8',
    });
  } catch {
    // Recovery is correct: same fallback contract as describe-all above.
    return null;
  }
  return { ok: true, testId, deviceName, provider: 'idb-accessibility' };
}

async function applyHudUpdate(client, step) {
  const globalObject = await client.send('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
    awaitPromise: false,
  });
  const objectId = globalObject?.result?.objectId;
  if (!objectId) {
    throw new Error('Mobile HUD runtime did not expose globalThis');
  }
  const result = await client.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: APPLY_HUD_UPDATE_FUNCTION,
    arguments: [{ value: step }],
    returnByValue: true,
    awaitPromise: false,
  });
  if (result?.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Mobile HUD update failed',
    );
  }
  return result?.result?.value === true;
}

function parsePerformanceConsoleEvent(params, markers) {
  for (const arg of params?.args || []) {
    const text = typeof arg?.value === 'string' ? arg.value : '';
    const marker = markers.find((candidate) => text.includes(candidate));
    if (!marker) continue;
    const markerIndex = text.indexOf(marker);
    try {
      return JSON.parse(text.slice(markerIndex + marker.length));
    } catch (error) {
      // A marker followed by text that is not JSON is not a perf event; keep
      // scanning the remaining console arguments.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

async function setInput(client, testId, value, { deviceName } = {}, redact = false) {
  if (!testId) {
    throw new Error('Usage: set-input <testId> <value>');
  }
  const expr = `(function() {
    if (globalThis.__AGENTIC__?.setInput) return Promise.resolve(globalThis.__AGENTIC__.setInput(${JSON.stringify(testId)}, ${JSON.stringify(value)}));
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return { ok: false, error: 'No React DevTools hook' };
    var renderers = hook.renderers;
    if (!renderers) return { ok: false, error: 'No renderers' };
    var getFiberRoots = hook.getFiberRoots;
    function findByTestId(fiber) {
      if (!fiber) return null;
      var props = fiber.memoizedProps;
      if (props && props.testID === ${JSON.stringify(testId)}) return fiber;
      return findByTestId(fiber.child) || findByTestId(fiber.sibling);
    }
    for (var [id] of renderers) {
      var roots = getFiberRoots ? getFiberRoots(id) : undefined;
      if (!roots) continue;
      var result = null;
      roots.forEach(function(r) {
        if (result) return;
        var fiber = findByTestId(r.current);
        if (!fiber) return;
        var cur = fiber;
        while (cur) {
          if (cur.memoizedProps && typeof cur.memoizedProps.onChangeText === 'function') {
            cur.memoizedProps.onChangeText(${JSON.stringify(value)});
            result = { ok: true, testId: ${JSON.stringify(testId)} };
            return;
          }
          cur = cur.return || null;
        }
      });
      if (result) return result;
    }
    return { ok: false, error: 'No component with testID=' + ${JSON.stringify(testId)} + ' found or no onChangeText' };
  })()`;
  let result;
  try {
    result = await cdpEvalAsync(client, expr);
  } catch (error) {
    if (redact) {
      throw new Error(`Secret input could not be applied for testID ${testId}.`);
    }
    throw error;
  }
  if (redact && result?.ok === false) {
    result = { ok: false, error: 'Secret input could not be applied.' };
  }
  return {
    ...result,
    testId,
    value: redact ? '<redacted>' : value,
    deviceName,
  };
}

function parseHudStep(args) {
  const raw = args.join(' ');
  let step;
  try {
    step = JSON.parse(raw);
  } catch (error) {
    throw new Error(`show-step-json requires a JSON step payload: ${error.message}`);
  }
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error('show-step-json requires a JSON object step payload');
  }
  if (typeof step.intent !== 'string' || !step.intent.trim()) {
    throw new Error('show-step-json requires step.intent');
  }
  if (step.id !== undefined && typeof step.id !== 'string') {
    throw new Error('show-step-json step.id must be a string when provided');
  }
  return step;
}

/**
 * The generic command table, bound to the host's route table, perf markers and
 * readiness expression.
 * @param {Required<Pick<BridgeCliConfig, 'routes' | 'perfMarkerPrefixes'>> & Pick<BridgeCliConfig, 'readyExpression'>} options
 * @returns {Record<string, BridgeCommand>}
 */
function createBuiltinCommands({ routes, perfMarkerPrefixes, readyExpression }) {
  const routeAliases = routes.aliases || {};
  const nestedRouteParents = routes.nestedParents || {};
  return {
    async 'target-identity-selected'() {
      throw new Error('target-identity-selected is resolved before CDP attachment');
    },
    async navigate(client, args, { deviceName, platform } = {}) {
      const routeName = routeAliases[args[0]] || args[0];
      if (!routeName) {
        throw new Error('Usage: navigate <RouteName> [params-json]');
      }
      let params = {};
      if (args[1]) {
        try {
          params = JSON.parse(args[1]);
        } catch (e) {
          throw new Error(`Invalid params JSON: ${e.message}`);
        }
      }

      // Capture route before navigation
      const previousRoute = await cdpEval(client, 'globalThis.__AGENTIC__?.getRoute()');

      let expr;
      const parent = nestedRouteParents[routeName];
      if (parent) {
        // Nested route: navigate('Parent', { screen: 'Child', params: {...} })
        const navParams =
          Object.keys(params).length > 0
            ? JSON.stringify({ screen: routeName, params })
            : JSON.stringify({ screen: routeName });
        expr = `globalThis.__AGENTIC__?.navigate(${JSON.stringify(parent)}, ${navParams})`;
      } else {
        // Root-level route: navigate('Route', params)
        const paramsStr = JSON.stringify(params);
        expr = `globalThis.__AGENTIC__?.navigate(${JSON.stringify(routeName)}, ${paramsStr})`;
      }

      await cdpEval(client, expr);
      // Small delay for navigation to settle, then return current route
      await new Promise((r) => setTimeout(r, 500));
      const currentRoute = await cdpEval(client, 'globalThis.__AGENTIC__?.getRoute()');
      // Normalize route values: cdpEval returns undefined when the optional-chain
      // short-circuits (mid-navigation transient or bridge not yet installed).
      // null is valid JSON; undefined produces the literal string "undefined".
      return {
        navigated: routeName,
        params,
        previousRoute: previousRoute ?? null,
        currentRoute: currentRoute ?? null,
        deviceName,
        platform,
      };
    },

    async 'get-route'(client) {
      const route = await cdpEval(client, 'globalThis.__AGENTIC__?.getRoute()');
      // cdpEval returns undefined when the optional-chain short-circuits (bridge not
      // yet installed, mid-navigation, or route state transiently missing). Return null
      // so JSON.stringify produces valid JSON ("null") instead of literal "undefined".
      return route ?? null;
    },

    async 'get-state'(client, args) {
      const path = args[0] || '';
      if (!path) {
        // Return navigation state
        const state = await cdpEval(client, 'globalThis?.__AGENTIC__?.getState()');
        return state;
      }
      // Access Redux store at the given dot-path
      const expr = `(() => {
      const store = globalThis?.store;
      if (!store) return { error: 'Redux store not found on globalThis.store' };
      const state = store.getState();
      const parts = ${JSON.stringify(path)}.split('.');
      let current = state;
      for (const p of parts) {
        if (current == null) return undefined;
        current = current[p];
      }
      return current;
    })()`;
      return await cdpEval(client, expr);
    },

    async eval(client, args) {
      const expression = args.join(' ');
      if (!expression) {
        throw new Error('Usage: eval <expression>');
      }
      return await cdpEval(client, expression);
    },

    async 'eval-async'(client, args) {
      const expression = args.join(' ');
      if (!expression) {
        throw new Error('Usage: eval-async <expression>');
      }
      return await cdpEvalAsync(client, expression);
    },

    async 'can-go-back'(client) {
      return await cdpEval(client, 'globalThis.__AGENTIC__?.canGoBack()');
    },

    async 'go-back'(client, _args, { deviceName, platform } = {}) {
      await cdpEval(client, 'globalThis.__AGENTIC__?.goBack()');
      await new Promise((r) => setTimeout(r, 300));
      const route = await cdpEval(client, 'globalThis.__AGENTIC__?.getRoute()');
      // Same normalization as navigate/get-route: a transiently-missing route must
      // serialize as "currentRoute": null, not have the key silently omitted.
      return { currentRoute: route ?? null, deviceName, platform };
    },

    async 'press-test-id'(client, args, { deviceName, platform } = {}) {
      const testId = args[0];
      if (!testId) {
        throw new Error('Usage: press-test-id <testId>');
      }
      // Try the app bridge first. Native accessibility remains an iOS fallback
      // for controls whose React handler cannot be invoked directly.
      const expr = `(function() {
      if (globalThis.__AGENTIC__?.pressTestId) return Promise.resolve(globalThis.__AGENTIC__.pressTestId(${JSON.stringify(testId)}));
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) return { ok: false, error: 'No React DevTools hook' };
      var renderers = hook.renderers;
      if (!renderers) return { ok: false, error: 'No renderers' };
      var getFiberRoots = hook.getFiberRoots;
      function walk(fiber) {
        if (!fiber) return false;
        var props = fiber.memoizedProps;
        if (props && props.testID === ${JSON.stringify(testId)}) {
          if (typeof props.onPress === 'function') { props.onPress(); return true; }
        }
        return walk(fiber.child) || walk(fiber.sibling);
      }
      for (var [id] of renderers) {
        var roots = getFiberRoots ? getFiberRoots(id) : undefined;
        if (!roots) continue;
        var found = false;
        roots.forEach(function(r) { if (!found) found = walk(r.current); });
        if (found) return { ok: true, testId: ${JSON.stringify(testId)} };
      }
      return { ok: false, error: 'No component with testID=' + ${JSON.stringify(testId)} + ' found or no onPress' };
    })()`;
      let result;
      let bridgeError;
      try {
        result = await cdpEvalAsync(client, expr);
        if (result?.ok !== false) {
          return { ...result, testId, deviceName };
        }
      } catch (error) {
        bridgeError = error;
      }
      const nativeResult = tapVisibleIosAccessibilityTarget(testId, deviceName, platform);
      if (nativeResult) return nativeResult;
      if (bridgeError) throw bridgeError;
      return { ...result, testId, deviceName };
    },

    async 'key-press'(_client, args, { deviceName, platform } = {}) {
      const requestedKey = String(args[0] || 'Enter').toLowerCase();
      const isEnter = requestedKey === 'enter' || requestedKey === 'return';
      const isBack = requestedKey === 'escape' || requestedKey === 'back';
      if (!isEnter && !isBack) {
        throw new Error(`Unsupported Mobile key ${JSON.stringify(args[0])}`);
      }
      if (platform === 'android') {
        const serial = process.env.ADB_SERIAL || process.env.ANDROID_SERIAL;
        if (!serial) throw new Error('key-press requires a selected Android device');
        const keyCode = isEnter ? '66' : '4';
        execFileSync(mobileToolPath('adb'), ['-s', serial, 'shell', 'input', 'keyevent', keyCode], {
          encoding: 'utf8',
        });
        return {
          ok: true,
          key: args[0] || 'Enter',
          keyCode,
          deviceName,
          provider: 'adb-key',
        };
      }
      if (platform !== 'ios') {
        throw new Error(`key-press requires a selected Mobile platform`);
      }
      const device = bootedIosDevice(deviceName);
      if (!device) {
        throw new Error(`No booted simulator named ${JSON.stringify(deviceName)}`);
      }
      const keyCode = isEnter ? '40' : '41';
      execFileSync(mobileToolPath('idb'), ['ui', 'key', keyCode, '--udid', device.udid], {
        encoding: 'utf8',
      });
      return {
        ok: true,
        key: args[0] || 'Enter',
        keyCode,
        deviceName,
        provider: 'idb-key',
      };
    },

    async 'long-press-test-id'(client, args, { deviceName } = {}) {
      const testId = args[0];
      if (!testId) {
        throw new Error('Usage: long-press-test-id <testId>');
      }
      const expr = `(function() {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) return { ok: false, error: 'No React DevTools hook' };
      var renderers = hook.renderers;
      if (!renderers) return { ok: false, error: 'No renderers' };
      var getFiberRoots = hook.getFiberRoots;
      function walk(fiber) {
        if (!fiber) return false;
        var props = fiber.memoizedProps;
        if (props && props.testID === ${JSON.stringify(testId)}) {
          if (typeof props.onLongPress === 'function') { props.onLongPress(); return true; }
        }
        return walk(fiber.child) || walk(fiber.sibling);
      }
      for (var [id] of renderers) {
        var roots = getFiberRoots ? getFiberRoots(id) : undefined;
        if (!roots) continue;
        var found = false;
        roots.forEach(function(r) { if (!found) found = walk(r.current); });
        if (found) return { ok: true, testId: ${JSON.stringify(testId)} };
      }
      return { ok: false, error: 'No component with testID=' + ${JSON.stringify(testId)} + ' found or no onLongPress' };
    })()`;
      const result = await cdpEval(client, expr);
      return { ...result, testId, deviceName };
    },

    async 'press-text'(client, args, { deviceName } = {}) {
      const text = args[0];
      if (!text) {
        throw new Error('Usage: press-text <text>');
      }
      const expr = `(function() {
      if (typeof globalThis.__AGENTIC__?.pressText !== 'function') {
        return { ok: false, error: 'The app bridge does not expose pressText' };
      }
      return globalThis.__AGENTIC__.pressText(${JSON.stringify(text)});
    })()`;
      const result = await cdpEval(client, expr);
      return { ...result, text, deviceName };
    },

    async 'scroll-view'(client, args, { deviceName } = {}) {
      let testId;
      let offset = 300;
      let animated = false;
      let intoView = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test-id' && i + 1 < args.length) {
          testId = args[++i];
        } else if (args[i] === '--offset' && i + 1 < args.length) {
          offset = Number(args[++i]);
        } else if (args[i] === '--animated') {
          animated = true;
        } else if (args[i] === '--into-view') {
          intoView = true;
        } else if (args[i] === '--no-animated') {
          animated = false;
        }
      }
      const optsJson = JSON.stringify({ testId, offset, animated, intoView });
      // Try __AGENTIC__ bridge first, fall back to inline fiber walking
      const expr = `(function() {
      // The app helper implements generic scrolling by searching inside the
      // selector fiber. For into-view requests the scroll container is commonly
      // an ancestor (for example, a row inside a sectioned list), so use the
      // ancestor-aware bridge fallback below instead.
      if (${intoView} && globalThis.__AGENTIC__?.scrollIntoView) {
        return globalThis.__AGENTIC__.scrollIntoView(${JSON.stringify(testId)}, ${animated});
      }
      if (!${intoView} && globalThis.__AGENTIC__?.scrollView) return globalThis.__AGENTIC__.scrollView(${optsJson});
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) return { ok: false, error: 'No React DevTools hook' };
      var renderers = hook.renderers;
      if (!renderers) return { ok: false, error: 'No renderers' };
      var getFiberRoots = hook.getFiberRoots;
      var opts = ${optsJson};
      function tryScroll(fiber, walkSiblings) {
        if (walkSiblings === undefined) walkSiblings = true;
        var current = fiber;
        while (current) {
          var rawStateNode = current.stateNode;
          var sn = rawStateNode && rawStateNode.canonical && rawStateNode.canonical.publicInstance
            ? rawStateNode.canonical.publicInstance
            : rawStateNode;
          if (sn) {
            if (typeof sn.scrollTo === 'function') { sn.scrollTo({ y: opts.offset, animated: opts.animated }); return true; }
            if (typeof sn.scrollToOffset === 'function') { sn.scrollToOffset({ offset: opts.offset, animated: opts.animated }); return true; }
          }
          if (tryScroll(current.child)) return true;
          current = walkSiblings ? current.sibling : null;
        }
        return false;
      }
      function findMeasurable(fiber) {
        if (!fiber) return null;
        var rawStateNode = fiber.stateNode;
        var sn = rawStateNode && rawStateNode.canonical && rawStateNode.canonical.publicInstance
          ? rawStateNode.canonical.publicInstance
          : rawStateNode;
        if (sn && typeof sn.measureLayout === 'function') return sn;
        return findMeasurable(fiber.child);
      }
      function tryScrollNear(anchor) {
        if (!opts.intoView && tryScroll(anchor, false)) return true;
        var target = opts.intoView ? findMeasurable(anchor) : null;
        var current = anchor ? anchor.return : null;
        while (current) {
          var rawStateNode = current.stateNode;
          var sn = rawStateNode && rawStateNode.canonical && rawStateNode.canonical.publicInstance
            ? rawStateNode.canonical.publicInstance
            : rawStateNode;
          var currentProps = current.memoizedProps;
          if (sn) {
            if (typeof sn.scrollTo === 'function' && !(currentProps && currentProps.horizontal === true)) {
              if (target) {
                return new Promise(function(resolve) {
                  target.measureLayout(
                    sn,
                    function(x, y) {
                      sn.scrollTo({ y: y, animated: opts.animated });
                      resolve({ ok: true, testId: opts.testId, measuredOffset: y, animated: opts.animated });
                    },
                    function() {
                      resolve({ ok: false, error: 'Unable to measure testID=' + opts.testId + ' relative to its scroll container' });
                    }
                  );
                });
              }
              sn.scrollTo({ y: opts.offset, animated: opts.animated });
              return true;
            }
            if (typeof sn.scrollToOffset === 'function' && !(currentProps && currentProps.horizontal === true)) {
              if (target) {
                return new Promise(function(resolve) {
                  target.measureLayout(
                    sn,
                    function(x, y) {
                      sn.scrollToOffset({ offset: y, animated: opts.animated });
                      resolve({ ok: true, testId: opts.testId, measuredOffset: y, animated: opts.animated });
                    },
                    function() {
                      resolve({ ok: false, error: 'Unable to measure testID=' + opts.testId + ' relative to its scroll container' });
                    }
                  );
                });
              }
              sn.scrollToOffset({ offset: opts.offset, animated: opts.animated });
              return true;
            }
          }
          current = current.return;
        }
        return opts.intoView ? tryScroll(anchor, false) : false;
      }
      function findTestId(fiber) {
        if (!fiber) return null;
        var props = fiber.memoizedProps;
        if (props && props.testID === opts.testId) {
          var ancestor = fiber;
          var inactive = false;
          while (ancestor) {
            var ancestorProps = ancestor.memoizedProps;
            var ancestorStyle = ancestorProps && ancestorProps.style;
            if (
              (ancestorProps && ancestorProps.activityState === 0) ||
              (ancestorStyle && ancestorStyle.display === 'none')
            ) {
              inactive = true;
              break;
            }
            ancestor = ancestor.return;
          }
          if (!inactive) return fiber;
        }
        return findTestId(fiber.child) || findTestId(fiber.sibling);
      }
      for (var [id] of renderers) {
        var roots = getFiberRoots ? getFiberRoots(id) : undefined;
        if (!roots) continue;
        var scrolled = false;
        roots.forEach(function(r) {
          if (scrolled) return;
          if (opts.testId) {
            var anchor = findTestId(r.current);
            if (anchor) scrolled = tryScrollNear(anchor);
          } else {
            scrolled = tryScroll(r.current);
          }
        });
        if (scrolled) {
          if (typeof scrolled.then === 'function') return scrolled;
          return { ok: true, testId: opts.testId, offset: opts.offset, animated: opts.animated };
        }
      }
      return { ok: false, error: opts.testId ? 'No scrollable near testID=' + opts.testId : 'No scrollable found' };
    })()`;
      const result = intoView ? await cdpEvalAsync(client, expr) : await cdpEval(client, expr);
      return { ...result, deviceName };
    },

    async 'measure-scroll-transition'(client, args, { deviceName } = {}) {
      let options;
      try {
        options = JSON.parse(args[0] || '{}');
      } catch (error) {
        throw new Error(`Invalid measure-scroll-transition options: ${error.message}`);
      }
      const timeoutMs = Number(options.timeoutMs);
      const pollIntervalMs = Number(options.pollIntervalMs ?? 100);
      const visibleEventStage = options.visibleEventStage || null;
      const visibleEventGraceMs = Number(options.visibleEventGraceMs ?? 0);
      const targetCount =
        Number(Boolean(options.targetTestId)) + Number(Boolean(options.targetText));
      if (
        !options.fromTestId ||
        targetCount !== 1 ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isFinite(pollIntervalMs) ||
        pollIntervalMs < 16 ||
        (visibleEventStage !== null && typeof visibleEventStage !== 'string') ||
        !Number.isFinite(visibleEventGraceMs) ||
        visibleEventGraceMs < 0
      ) {
        throw new Error(
          'measure-scroll-transition requires fromTestId, exactly one targetTestId or targetText, a positive timeoutMs, pollIntervalMs >= 16, and a non-negative visibleEventGraceMs.',
        );
      }
      const visibleEvents = [];
      let removeConsoleListener = null;
      if (visibleEventStage) {
        removeConsoleListener = client.on('Runtime.consoleAPICalled', (params) => {
          const payload = parsePerformanceConsoleEvent(params, perfMarkerPrefixes);
          if (payload?.stage === visibleEventStage) visibleEvents.push(payload);
        });
        await client.send('Runtime.enable');
      }
      const targetQuery = options.targetTestId
        ? { testId: options.targetTestId, visibility: 'viewport' }
        : { textContains: options.targetText, visibility: 'viewport' };
      const from = await cdpEvalAsync(
        client,
        `globalThis.__AGENTIC__?.queryUiTarget(${JSON.stringify({
          testId: options.fromTestId,
          visibility: 'viewport',
        })})`,
        timeoutMs,
      );
      if (from?.visible !== true) {
        return {
          ok: false,
          error: 'measurement start target is not visible',
          from,
          deviceName,
        };
      }
      let walletReady = null;
      if (options.requireWalletReady === true && readyExpression) {
        walletReady = await cdpEval(client, readyExpression);
        if (walletReady?.ready !== true) {
          return {
            ok: false,
            error: 'wallet is not ready at measurement start',
            walletReady,
            from,
            deviceName,
          };
        }
      }
      const started = await cdpEvalAsync(
        client,
        `(function(){
        const scrollStartedAtMs = performance.now();
        const startedAtMs = ${
          walletReady === null
            ? 'scrollStartedAtMs'
            : JSON.stringify(Number(walletReady.observedAtMs))
        };
        return Promise.resolve(globalThis.__AGENTIC__?.scrollView(${JSON.stringify({
          testId: options.scrollTestId,
          offset: options.offset,
          animated: options.animated,
          intoView: false,
        })})).then(function(scroll){ return { startedAtMs, scrollStartedAtMs, scroll }; });
      })()`,
        timeoutMs,
      );
      if (started?.scroll?.ok === false) {
        return {
          ok: false,
          error: 'scroll failed',
          ...started,
          from,
          deviceName,
        };
      }
      const hostDeadline = Date.now() + timeoutMs;
      if (visibleEventStage && visibleEventGraceMs > 0) {
        const eventDeadline = Math.min(hostDeadline, Date.now() + visibleEventGraceMs);
        while (Date.now() <= eventDeadline) {
          const event = visibleEvents.find(
            (candidate) =>
              Number(candidate.frame_checkpoint_monotonic_ms) >= Number(started.scrollStartedAtMs),
          );
          if (event) {
            removeConsoleListener?.();
            const observedAtMs = Number(event.frame_checkpoint_monotonic_ms);
            return {
              ok: true,
              clock: 'performance.now',
              observationSource: 'runtime-console-event',
              durationMs: observedAtMs - started.startedAtMs,
              scrollDurationMs: observedAtMs - started.scrollStartedAtMs,
              appVisibleDurationMs: Number(event.duration_ms),
              pollIntervalMs,
              preScrollDelayMs: started.scrollStartedAtMs - started.startedAtMs,
              startedAtMs: started.startedAtMs,
              scrollStartedAtMs: started.scrollStartedAtMs,
              observedAtMs,
              visibleEvent: event,
              ...(walletReady ? { walletReady } : {}),
              from,
              scroll: started.scroll,
              deviceName,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      while (Date.now() <= hostDeadline) {
        const remainingMs = hostDeadline - Date.now();
        if (remainingMs <= 1_000) break;
        const queryTimeoutMs = Math.min(5_000, remainingMs);
        const observation = await cdpEvalAsync(
          client,
          `(function(){
          return Promise.resolve(globalThis.__AGENTIC__?.queryUiTarget(${JSON.stringify(targetQuery)})).then(function(target){
            return { target, observedAtMs: performance.now() };
          });
        })()`,
          queryTimeoutMs,
        );
        const requiredPresent =
          observation?.target?.visible === true && options.requiredPresentTestId
            ? await cdpEvalAsync(
                client,
                `globalThis.__AGENTIC__?.queryUiTarget(${JSON.stringify({
                  testId: options.requiredPresentTestId,
                  visibility: 'tree',
                })})`,
                queryTimeoutMs,
              )
            : null;
        if (
          observation?.target?.visible === true &&
          (!options.requiredPresentTestId || requiredPresent?.present === true)
        ) {
          return {
            ok: true,
            clock: 'performance.now',
            durationMs: observation.observedAtMs - started.startedAtMs,
            scrollDurationMs: observation.observedAtMs - started.scrollStartedAtMs,
            pollIntervalMs,
            observationSource: visibleEventStage ? 'fiber-poll-after-event-grace' : 'fiber-poll',
            preScrollDelayMs: started.scrollStartedAtMs - started.startedAtMs,
            startedAtMs: started.startedAtMs,
            scrollStartedAtMs: started.scrollStartedAtMs,
            observedAtMs: observation.observedAtMs,
            ...(walletReady ? { walletReady } : {}),
            from,
            target: observation.target,
            ...(requiredPresent ? { requiredPresent } : {}),
            scroll: started.scroll,
            deviceName,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      removeConsoleListener?.();
      return {
        ok: false,
        error: 'timed out waiting for visible transition target',
        durationMs: await cdpEval(client, `performance.now() - ${Number(started.startedAtMs)}`),
        startedAtMs: started.startedAtMs,
        scrollStartedAtMs: started.scrollStartedAtMs,
        deviceName,
      };
    },

    async 'set-input'(client, args, context = {}) {
      return setInput(client, args[0], args.slice(1).join(' '), context);
    },

    async 'set-input-file'(client, args, context = {}) {
      const testId = args[0];
      const file = args[1];
      if (!testId || !file) {
        throw new Error('Usage: set-input-file <testId> <value-file>');
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('set-input-file requires a regular value file.');
      }
      return setInput(client, testId, fs.readFileSync(file, 'utf8'), context, true);
    },

    async 'sentry-debug'(client, args) {
      const action = args[0] || 'enable';
      if (action === 'enable') {
        const expr = `(function() {
        try {
          var sentryHub = globalThis.__SENTRY__;
          if (!sentryHub) return { ok: false, error: 'globalThis.__SENTRY__ not found' };
          var ver = Object.keys(sentryHub).filter(function(k) { return /^[0-9]/.test(k); })[0];
          if (!ver) return { ok: false, error: 'No Sentry version key found in __SENTRY__' };
          var hub = sentryHub[ver];
          var scope = hub.defaultCurrentScope;
          if (!scope) return { ok: false, error: 'No defaultCurrentScope in Sentry hub' };
          var sentryClient = scope.getClient();
          if (!sentryClient) return { ok: false, error: 'No Sentry client found via scope.getClient()' };

          if (sentryClient.__agenticPatched) return { ok: true, alreadyPatched: true, version: ver };

          var origException = sentryClient.captureException.bind(sentryClient);
          var origMessage = sentryClient.captureMessage.bind(sentryClient);

          sentryClient.captureException = function(err, hint, currentScope) {
            var msg = err && err.message ? err.message : String(err);
            console.warn('[SENTRY-DEBUG] captureException:', msg);
            if (err && err.stack) console.warn('[SENTRY-DEBUG] stack:', err.stack);
            return origException(err, hint, currentScope);
          };
          sentryClient.captureMessage = function(msg, level, hint, currentScope) {
            console.warn('[SENTRY-DEBUG] captureMessage:', msg);
            return origMessage(msg, level, hint, currentScope);
          };
          sentryClient.__agenticPatched = true;
          sentryClient.__agenticOrigException = origException;
          sentryClient.__agenticOrigMessage = origMessage;
          return { ok: true, patched: true, version: ver };
        } catch(e) {
          return { ok: false, error: String(e) };
        }
      })()`;
        return await cdpEval(client, expr);
      } else if (action === 'disable') {
        const expr = `(function() {
        try {
          var sentryHub = globalThis.__SENTRY__;
          if (!sentryHub) return { ok: true, wasNotPatched: true };
          var ver = Object.keys(sentryHub).filter(function(k) { return /^[0-9]/.test(k); })[0];
          if (!ver) return { ok: true, wasNotPatched: true };
          var hub = sentryHub[ver];
          var scope = hub.defaultCurrentScope;
          if (!scope) return { ok: true, wasNotPatched: true };
          var sentryClient = scope.getClient();
          if (!sentryClient || !sentryClient.__agenticPatched) return { ok: true, wasNotPatched: true };
          sentryClient.captureException = sentryClient.__agenticOrigException;
          sentryClient.captureMessage = sentryClient.__agenticOrigMessage;
          delete sentryClient.__agenticPatched;
          delete sentryClient.__agenticOrigException;
          delete sentryClient.__agenticOrigMessage;
          return { ok: true, unpatched: true, version: ver };
        } catch(e) {
          return { ok: false, error: String(e) };
        }
      })()`;
        return await cdpEval(client, expr);
      }
      throw new Error('Usage: sentry-debug [enable|disable]');
    },

    async 'show-step-json'(client, args) {
      const step = parseHudStep(args);
      await applyHudUpdate(client, step);
      return { ok: true };
    },

    async 'show-step-json-deferred'(client, args) {
      const step = parseHudStep(args);
      if (typeof client.control === 'function') {
        return client.control('hud-update', { step });
      }
      await applyHudUpdate(client, step);
      return { ok: true, status: 'applied' };
    },

    async 'hide-step'(client) {
      await applyHudUpdate(client, null);
      return { ok: true };
    },

    async 'hide-step-deferred'(client) {
      if (typeof client.control === 'function') {
        return client.control('hud-update', { step: null });
      }
      await applyHudUpdate(client, null);
      return { ok: true, status: 'applied' };
    },

    async 'profiler-start'(client) {
      // Hermes CDP exposes the sampling profiler via the Profiler domain.
      // Output of Profiler.stop is a Chrome-compatible .cpuprofile object.
      // Note: Hermes does NOT implement Profiler.enable (returns -32601 Unsupported);
      // Profiler.start/stop work without it.
      await client.send('Profiler.start');
      return { ok: true, started: true };
    },

    async 'profiler-stop'(client, args) {
      let outPath = '';
      let label = 'trace';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--out' && i + 1 < args.length) {
          outPath = args[++i];
        } else if (args[i] === '--label' && i + 1 < args.length) {
          label = args[++i];
        }
      }
      const res = await client.send('Profiler.stop', {}, 60000);
      const profile = res?.profile;
      if (!profile) {
        return { ok: false, error: 'Profiler.stop returned no profile' };
      }
      const serialized = JSON.stringify(profile);
      if (!outPath) {
        const tracesDir = path.resolve(
          process.env.APP_ROOT || process.cwd(),
          'temp/agentic/traces',
        );
        fs.mkdirSync(tracesDir, { recursive: true });
        outPath = path.join(tracesDir, `trace-${label}.cpuprofile`);
      } else {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
      }
      fs.writeFileSync(outPath, serialized);
      const nodesCount = Array.isArray(profile.nodes) ? profile.nodes.length : 0;
      const samplesCount = Array.isArray(profile.samples) ? profile.samples.length : 0;
      return {
        ok: true,
        path: outPath,
        label,
        sizeBytes: Buffer.byteLength(serialized, 'utf8'),
        nodesCount,
        samplesCount,
        startTime: profile.startTime ?? null,
        endTime: profile.endTime ?? null,
      };
    },

    async 'issues-arm'(client) {
      // Installs console.warn/error and global error/unhandledrejection hooks
      // that push into globalThis.__AGENTIC_ISSUES__ (capped at 500 entries).
      // Idempotent — subsequent calls return { installed: true, reason: 'already-installed' }.
      const result = await cdpEval(client, buildArmSnippet());
      return result || { installed: false };
    },

    async 'issues-collect'(client) {
      // Snapshots and clears globalThis.__AGENTIC_ISSUES__.
      // Returns { count, entries } where entries are { t, level, text }.
      const result = await cdpEval(client, buildCollectSnippet());
      return result || { count: 0, entries: [] };
    },

    async 'network-capture-start'(client, args) {
      if (typeof client.control !== 'function') {
        throw new Error('Network capture requires the CDP broker');
      }
      const options = JSON.parse(args[0] || '{}');
      return client.control('capture-start', options);
    },

    async 'network-capture-end'(client, args) {
      if (typeof client.control !== 'function') {
        throw new Error('Network capture requires the CDP broker');
      }
      const options = JSON.parse(args[0] || '{}');
      return client.control('capture-end', options);
    },
  };
}
// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** `--help` lines of the built-in commands, in display order. */
const BUILTIN_HELP = [
  ['navigate', '  navigate <RouteName> [params-json]   Navigate to a screen'],
  ['get-route', '  get-route                            Get current route name and params'],
  ['get-state', '  get-state [dot.path]                 Get Redux state (or nav state if no path)'],
  ['eval', '  eval <expression>                    Evaluate arbitrary JS in app context'],
  ['eval-async', '  eval-async <expression>              Evaluate async/Promise expression'],
  ['can-go-back', '  can-go-back                          Check if navigation can go back'],
  ['go-back', '  go-back                              Navigate back'],
  ['press-test-id', '  press-test-id <testId>               Press a component by its testID prop'],
  [
    'long-press-test-id',
    "  long-press-test-id <testId>          Invoke a component's long-press gesture by testID",
  ],
  [
    'press-text',
    '  press-text <text>                     Press a component containing visible text',
  ],
  [
    'scroll-view',
    `  scroll-view [--test-id <id>] [--offset <n>] [--animated]
                                       Scroll a ScrollView/FlatList`,
  ],
  [
    'measure-scroll-transition',
    '  measure-scroll-transition <json>    Scroll and measure a visible target using one CDP session',
  ],
  [
    'set-input',
    '  set-input <testId> <value>           Set text input value by testID (calls onChangeText)',
  ],
  [
    'set-input-file',
    '  set-input-file <testId> <value-file> Set text input from a regular file and redact the value',
  ],
  [
    'sentry-debug',
    '  sentry-debug [enable|disable]          Patch Sentry to log errors to console with [SENTRY-DEBUG] prefix',
  ],
  ['profiler-start', '  profiler-start                       Start Hermes sampling profiler'],
  [
    'profiler-stop',
    `  profiler-stop [--out <path>] [--label <name>]
                                       Stop profiler, dump Chrome-compatible
                                       .cpuprofile to <path> (default:
                                       temp/agentic/traces/trace-<label>.cpuprofile)`,
  ],
  [
    'issues-arm',
    `  issues-arm                           Install console/exception hooks that
                                       populate globalThis.__AGENTIC_ISSUES__`,
  ],
  [
    'issues-collect',
    '  issues-collect                       Snapshot + clear the in-app issue buffer',
  ],
  [
    'network-capture-start',
    '  network-capture-start <json>         Start a broker-owned Network capture',
  ],
  [
    'network-capture-end',
    '  network-capture-end <json>           End capture and return redacted summary',
  ],
];

/**
 * Insert `name` after `anchor` in `order`, or last without an anchor.
 * @param {string[]} order
 * @param {string} name
 * @param {string | undefined} anchor
 * @param {string} field Config field named in the startup error.
 */
function placeAfter(order, name, anchor, field) {
  if (!anchor) {
    order.push(name);
    return;
  }
  const index = order.indexOf(anchor);
  if (index === -1) {
    throw new Error(`bridge-core: commandDocs.${name}.${field} names unknown command ${anchor}`);
  }
  order.splice(index + 1, 0, name);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the bridge CLI for `process.argv`: print help, or resolve the target,
 * run one command and print its JSON result. Failures exit with the typed
 * bridge exit code. Invalid host config throws before anything runs.
 * @param {BridgeCliConfig} [config]
 * @returns {Promise<void>}
 */
function runBridgeCli(config = {}) {
  const hostCommands = config.commands || {};
  const commandDocs = config.commandDocs || {};
  const teachingByErrorCode = config.teachingByErrorCode || {};
  const appLabel = config.appLabel || 'React Native';
  const usagePath = config.usagePath || path.basename(process.argv[1] || 'bridge.cjs');
  const builtins = createBuiltinCommands({
    routes: config.routes || {},
    perfMarkerPrefixes: config.perfMarkerPrefixes || [],
    readyExpression: config.readyExpression,
  });

  /** @type {Record<string, BridgeCommand>} */
  const commands = { ...builtins };
  const listing = Object.keys(builtins);
  const helpOrder = BUILTIN_HELP.map(([name]) => name);
  const helpTextByName = new Map(BUILTIN_HELP);
  for (const name of Object.keys(commandDocs)) {
    if (!Object.hasOwn(hostCommands, name)) {
      throw new Error(`bridge-core: commandDocs names unknown host command ${name}`);
    }
  }
  for (const [name, handler] of Object.entries(hostCommands)) {
    if (Object.hasOwn(builtins, name)) {
      throw new Error(`bridge-core: host command ${name} collides with a built-in command`);
    }
    // `status-selected` is the core's single-target form of the host `status`.
    if (name === 'status-selected') {
      throw new Error('bridge-core: status-selected is reserved; register status instead');
    }
    commands[name] = handler;
    const doc = commandDocs[name] || {};
    placeAfter(listing, name, doc.listAfter, 'listAfter');
    if (doc.help !== undefined) {
      placeAfter(helpOrder, name, doc.helpAfter, 'helpAfter');
      helpTextByName.set(name, doc.help);
    }
  }

  // Bridge-priority lock: the Hermes inspector proxy reliably serves one debugger
  // slot, so the console-forwarder yields it while a bridge command runs (it
  // watches this file and backfills from the runtime's console buffer afterward).
  const bridgeLockFile = path.join(
    process.env.RECIPE_RUNTIME_DIR || path.join('temp', 'recipe', 'runtime'),
    'cdp-bridge.lock',
  );
  const bridgeLockOwnerPid = /^\d+$/.test(process.env.CDP_BRIDGE_LOCK_OWNER_PID || '')
    ? process.env.CDP_BRIDGE_LOCK_OWNER_PID
    : String(process.pid);

  // Ownership semantics: last writer wins. Each bridge stamps its own pid; the
  // forwarder honors the lock while the pid IN THE FILE is alive. Overlapping
  // bridge commands therefore keep the slot guarded as long as the most recent
  // writer runs, and an earlier command that outlives it may lose the slot — one
  // bridge command at a time is the supported concurrency.
  let bridgeLockHeld = false;

  function acquireBridgeLock() {
    try {
      fs.writeFileSync(bridgeLockFile, bridgeLockOwnerPid);
      bridgeLockHeld = true;
    } catch (error) {
      // Lock is best-effort: a missing runtime dir must not break bridge commands.
      if (error.code !== 'ENOENT') throw error;
    }
  }

  process.on('exit', () => {
    // Only the current owner removes the lock: a no-lock invocation (--help,
    // unknown command) or a bridge whose lock was overwritten by a later one
    // must not release the slot under the still-running writer.
    if (!bridgeLockHeld) return;
    try {
      if (fs.readFileSync(bridgeLockFile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(bridgeLockFile);
      }
    } catch (error) {
      // Already gone.
      if (error.code !== 'ENOENT') throw error;
    }
  });

  // Signal-killed bridges (status-probe kills timed-out probes SIGTERM→SIGKILL)
  // skip 'exit' unless a handler turns the signal into process.exit — without
  // this the lock strands and mutes console forwarding until staleness lapses.
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));

  async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help' || command === '-h') {
      console.log(`CDP Bridge — interact with the running ${appLabel} app via Hermes CDP

Usage:
  node ${usagePath} <command> [args...]

Commands:
${helpOrder.map((name) => helpTextByName.get(name)).join('\n')}

Environment:
  WATCHER_PORT    Metro port (default: 8081)
  CDP_TIMEOUT     Connection timeout in ms (default: 5000)
  IOS_SIMULATOR   Filter targets by iOS simulator name
  ANDROID_DEVICE  Filter targets by Android device/emulator serial`);
      process.exit(0);
    }

    const handler = commands[command === 'status-selected' ? 'status' : command];
    if (!handler) {
      console.error(`Unknown command: ${command}`);
      console.error(`Available: ${listing.join(', ')}`);
      process.exit(1);
    }

    const port = loadPort();
    const brokerSocketFile = brokerSocketPath(path.dirname(bridgeLockFile), port);
    const timeout = Number.parseInt(process.env.CDP_TIMEOUT || '5000', 10);
    const brokerAvailable = fs.existsSync(brokerSocketFile);
    if (!brokerAvailable) acquireBridgeLock();

    function selectedTargetPin() {
      const platform = String(process.env.RECIPE_RN_EXPLICIT_PLATFORM || '').toLowerCase();
      const androidPin = process.env.ANDROID_TARGET_DEVICE_NAME || process.env.ANDROID_DEVICE || '';
      const iosPin = process.env.IOS_SIMULATOR || '';
      return String(
        platform === 'android' ? androidPin : platform === 'ios' ? iosPin : androidPin || iosPin,
      ).trim();
    }

    async function brokerTargets({ retainIdentity = false, includeGeneration = false } = {}) {
      const discoveryClient = await createBrokerClient(brokerSocketFile, '', timeout);
      try {
        const targets = await discoveryClient.control(
          retainIdentity
            ? 'resolve-targets'
            : includeGeneration
              ? 'list-target-identities'
              : 'list-targets',
          retainIdentity ? { nameIncludes: selectedTargetPin() } : {},
          timeout,
        );
        return (Array.isArray(targets) ? targets : []).flatMap((target) => {
          const deviceId = String(target?.deviceId || '');
          return deviceId
            ? [
                {
                  wsUrl: deviceId,
                  deviceName: String(target?.name || ''),
                  generation: Number(target?.generation) || 0,
                },
              ]
            : [];
        });
      } finally {
        discoveryClient.close();
      }
    }

    function selectBrokerTarget(targets) {
      const pin = selectedTargetPin();
      const candidates = pin
        ? targets.filter((target) => target.deviceName.toLowerCase().includes(pin.toLowerCase()))
        : targets;
      if (candidates.length !== 1) {
        const error = new Error(
          `Mobile CDP broker target selection requires one target; found ${candidates.length}${pin ? ` for ${JSON.stringify(pin)}` : ''}.`,
        );
        throw candidates.length === 0 ? coded(error, BRIDGE_ERROR_CODES.NO_TARGET) : error;
      }
      return candidates[0];
    }

    if (command === 'target-identity-selected') {
      const target = brokerAvailable
        ? selectBrokerTarget(await brokerTargets({ includeGeneration: true }))
        : await discoverTarget(port, { probe: true });
      const generation = Number(target.generation) || 0;
      console.log(
        JSON.stringify({
          runtimeIdentity: generation ? `${target.wsUrl}:${generation}` : target.wsUrl,
        }),
      );
      return;
    }

    async function clientFor(wsUrl) {
      if (brokerAvailable) {
        return createBrokerClient(brokerSocketFile, deviceIdFromUrl(wsUrl), timeout);
      }
      if (command.startsWith('network-capture-')) {
        throw new Error('Network capture requires a running CDP broker');
      }
      acquireBridgeLock();
      return createWSClient(wsUrl, timeout);
    }

    // `status` probes ALL connected targets so both platforms are visible.
    // `status-selected` falls through to the normal pinned discovery path for
    // action code that must survive one device's Hermes runtime rotation.
    if (command === 'status') {
      const allTargets = brokerAvailable ? await brokerTargets() : await discoverAllTargets(port);
      const results = [];
      for (const target of allTargets) {
        let client;
        try {
          client = await clientFor(target.wsUrl);
          const platform = (await cdpEval(client, 'globalThis.__AGENTIC__?.platform')) || '';
          const result = await handler(client, args.slice(1), {
            deviceName: target.deviceName,
            platform,
          });
          results.push(result);
        } catch {
          // Recovery is correct: status probes every target advisory; an
          // unresponsive one degrades to absent-from-the-listing rather than
          // failing the whole multi-target command.
        } finally {
          if (client) client.close();
        }
      }
      console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      return;
    }

    const selectedTarget = brokerAvailable
      ? selectBrokerTarget(await brokerTargets({ retainIdentity: true }))
      : await discoverTarget(port, { probe: true });
    const { wsUrl, deviceName, generation } = selectedTarget;
    if (!wsUrl) throw new Error('No broker-owned Hermes target is available');
    const client = await clientFor(wsUrl);

    try {
      const platform = command.endsWith('-deferred')
        ? ''
        : (await cdpEval(client, 'globalThis.__AGENTIC__?.platform')) || '';
      const runtimeIdentity =
        command === 'status-selected' ? (generation ? `${wsUrl}:${generation}` : wsUrl) : undefined;
      const result = await handler(client, args.slice(1), {
        deviceName,
        platform,
        runtimeIdentity,
      });
      if (brokerAvailable && command === 'status-selected') {
        const currentTarget = selectBrokerTarget(await brokerTargets({ includeGeneration: true }));
        if (currentTarget.wsUrl !== wsUrl || currentTarget.generation !== generation) {
          throw new Error('Hermes runtime rotated during status-selected');
        }
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      client.close();
    }
  }

  return main().catch((err) => {
    // Typed failure: a code stamped at the throw site wins; otherwise classify the
    // message here (still at the bridge, not by a needle far away in adapters.ts).
    // The marker + teaching go to stderr and the exit code carries the class, so a
    // caller recovers the code from either channel.
    const code = err && err.code ? err.code : classifyBridgeErrorMessage(err && err.message);
    if (code) {
      console.error(formatErrorMarker(code, err.message));
      if (teachingByErrorCode[code]) console.error(teachingByErrorCode[code]);
      process.exit(EXIT_CODE_BY_ERROR_CODE[code] || 1);
    }
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBridgeCli };
