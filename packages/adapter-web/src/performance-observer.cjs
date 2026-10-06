// performance-observer.cjs — CDP performance traces of a browser extension's
// UI renderer: attach to the extension page the host names, write the clock
// marker there with `performance.mark`, and trace through recipe-runner's
// CDP trace collector.
'use strict';

const { connectBrowserCdp } = require('./browser-cdp.cjs');
const { selectExtensionTarget } = require('./page-target.cjs');

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @template {string} [P=string]
 * @param {{
 *   cdpPort: number,
 *   extensionId: string,
 *   uiPaths: readonly string[],
 *   kind: import('@farmslot/recipe-runner/runtime/cdp-trace').TraceKind,
 *   platform: P,
 *   markerPrefix?: string,
 *   connectTimeoutMs?: number,
 *   commandTimeoutMs?: number,
 * }} options
 *   `uiPaths` are the extension pages to trace, in order of preference (see
 *   `selectExtensionTarget`); `kind`, `platform` and `markerPrefix` go to the collector.
 * @returns {Promise<import('@farmslot/recipe-runner/runtime/cdp-trace').PerformanceBackend<P>>}
 */
async function createExtensionPerformanceBackend({
  cdpPort,
  extensionId,
  uiPaths,
  kind,
  platform,
  markerPrefix,
  connectTimeoutMs = DEFAULT_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!extensionId) {
    throw new Error('Extension performance observation requires the extension id.');
  }
  // Loaded on use: recipe-runner's trace engine is an ES module built to dist,
  // and the other adapter-web modules must load without it.
  const { createCdpTraceCollector } = require('@farmslot/recipe-runner/runtime/cdp-trace');
  const browser = await connectBrowserCdp(cdpPort, {
    timeoutMs: connectTimeoutMs,
    commandTimeoutMs,
  });
  let sessionId = '';
  try {
    const { targetInfos } = await browser.send('Target.getTargets', {});
    const uiTarget = selectExtensionTarget(targetInfos, extensionId, { paths: uiPaths });
    if (!uiTarget) {
      throw new Error('Extension performance observation requires an open extension UI target.');
    }
    const attached = await browser.send('Target.attachToTarget', {
      targetId: uiTarget.targetId,
      flatten: true,
    });
    sessionId = String(attached?.sessionId ?? '');
    if (!sessionId) {
      throw new Error(
        'Extension performance observation could not attach to the extension UI target.',
      );
    }
  } catch (error) {
    browser.close();
    throw error;
  }
  const client = {
    send: (method, params = {}, timeoutMs) => browser.send(method, params, undefined, timeoutMs),
    on: (method, handler) =>
      browser.onEvent((event) => {
        if (event.method === method) handler(event.params);
      }),
    close: () => browser.close(),
  };
  return createCdpTraceCollector(client, {
    kind,
    platform,
    markerPrefix,
    marker: async (name) => {
      const before = Date.now();
      await browser.send(
        'Runtime.evaluate',
        { expression: `performance.mark(${JSON.stringify(name)})`, returnByValue: true },
        sessionId,
      );
      const after = Date.now();
      return { hostEpochMs: (before + after) / 2, uncertaintyMs: (after - before) / 2 };
    },
  });
}

module.exports = { createExtensionPerformanceBackend };
