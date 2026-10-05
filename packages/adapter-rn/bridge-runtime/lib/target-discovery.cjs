'use strict';

const http = require('node:http');
const {
  loadSimulatorName,
  loadAndroidDevice,
  loadAndroidTargetDeviceName,
} = require('./config.cjs');
const { createWSClient } = require('./ws-client.cjs');
const { BRIDGE_ERROR_CODES, coded } = require('./bridge-errors.cjs');

const FETCH_TIMEOUT_MS = Number.parseInt(process.env.CDP_TIMEOUT || '30000', 10);
const DISCOVERY_RETRY_DELAY_MS = 500;
const FETCH_RETRIES = Number.parseInt(
  process.env.CDP_DISCOVERY_RETRIES ||
    String(Math.max(3, Math.ceil(FETCH_TIMEOUT_MS / DISCOVERY_RETRY_DELAY_MS))),
  10,
);

/** Fetch JSON from a URL (http only, no external deps) */
function fetchJSONOnce(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url} after ${FETCH_TIMEOUT_MS}ms`));
    });
  });
}

async function fetchJSON(url, acceptResponse) {
  let lastError;
  let lastResponse;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const response = await fetchJSONOnce(url);
      lastError = undefined;
      lastResponse = response;
      if (!acceptResponse || (await acceptResponse(response))) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt === FETCH_RETRIES) break;
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
  }
  if (lastError !== undefined) throw lastError;
  if (lastResponse !== undefined) return lastResponse;
  throw lastError;
}

/**
 * Quick probe: connect to a CDP target, evaluate `__DEV__`, disconnect.
 * Returns true if __AGENTIC__ is installed, false otherwise.
 */
async function probeTarget(wsUrl) {
  return (await probeTargetDetailed(wsUrl)) === 'agentic';
}

/**
 * Three-state probe so callers can tell a pre-__AGENTIC__ build apart from a
 * dead target:
 *   'agentic'     — JS runtime answered and __AGENTIC__ is installed.
 *   'responsive'  — the target evaluated JS but has no __AGENTIC__ (an app build
 *                   that predates the bridge, or a non-runtime page).
 *   'unreachable' — connect/eval failed.
 */
async function probeTargetDetailed(wsUrl) {
  try {
    const client = await createWSClient(wsUrl, 3000);
    try {
      const result = await client.send('Runtime.evaluate', {
        expression: '(function(){ return typeof globalThis.__AGENTIC__; })()',
        returnByValue: true,
        awaitPromise: false,
      });
      return result?.result?.value === 'object' ? 'agentic' : 'responsive';
    } finally {
      client.close();
    }
  } catch {
    // Connection failed — target is not usable at all
    return 'unreachable';
  }
}

/**
 * Filter Metro /json/list targets to debugger-capable RN/Hermes pages and rank
 * them JS-runtime-first. Pre-RN-0.81 titles say "React Native"/"Hermes";
 * RN 0.81+ Bridgeless titles are bundle-id-only (e.g. "io.metamask.MetaMask
 * (mm-5)") with the runtime kind in `description`. Each device exposes
 * multiple pages — page 1 is the native C++ runtime; the JS runtime (console,
 * __AGENTIC__) has a higher page number, so after the sort the first candidate
 * per device is its JS runtime.
 */
function rankRuntimeCandidates(targets) {
  const candidates = (Array.isArray(targets) ? targets : []).filter(
    (t) =>
      t.webSocketDebuggerUrl &&
      ((t.title && (/react/i.test(t.title) || /hermes/i.test(t.title))) ||
        /bridgeless|hermes/i.test(t.description || '')),
  );
  candidates.sort((a, b) => {
    const aPage = Number.parseInt((a.id || '').split('-').pop() || '0', 10);
    const bPage = Number.parseInt((b.id || '').split('-').pop() || '0', 10);
    return bPage - aPage;
  });
  return candidates;
}

function targetDeviceIdentity(target) {
  try {
    const device = new URL(target.webSocketDebuggerUrl).searchParams.get('device');
    if (device) return device;
  } catch {
    // Fall back to Metro's display identity when the debugger URL is malformed.
  }
  // Without Metro's device id there is no safe way to collapse same-name pages
  // into one physical device. Keep each debugger target distinct and fail closed
  // on ambiguity instead of silently choosing between devices.
  return target.webSocketDebuggerUrl || target.deviceName || '';
}

/**
 * Discover the Hermes CDP WebSocket URL from Metro's /json/list endpoint.
 *
 * Multi-simulator support:
 *   - When IOS_SIMULATOR is set, filters targets by deviceName
 *   - With Hermes bridgeless mode, there are multiple pages per device:
 *     page 1 = native C++ runtime, page 2+ = JS runtime (where __AGENTIC__ lives)
 *   - We probe candidates to find the one with __AGENTIC__ installed
 */
async function discoverTarget(port, { probe = true } = {}) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const androidTargetName = loadAndroidTargetDeviceName();
  const androidDevice = loadAndroidDevice();
  const adbSerial = process.env.ADB_SERIAL || process.env.ANDROID_SERIAL || '';
  const androidPinned = Boolean(androidTargetName || androidDevice);
  const simName = loadSimulatorName();
  const iosPinned =
    process.env.RECIPE_RN_EXPLICIT_PLATFORM === 'ios' || Boolean(process.env.SIM_UDID);
  const matchesAndroidPin = (target) =>
    androidTargetName
      ? target.deviceName !== simName &&
        (target.deviceName === androidTargetName ||
          (target.deviceName != null && target.deviceName.startsWith(androidTargetName)))
      : target.deviceName === androidDevice;
  let acceptedPinnedCandidate;
  let targets;
  try {
    targets = await fetchJSON(listUrl, async (response) => {
      const runtimeCandidates = rankRuntimeCandidates(response);
      if (runtimeCandidates.length === 0) return false;
      if (androidPinned) {
        const pinnedCandidates = runtimeCandidates.filter(matchesAndroidPin);
        for (const candidate of pinnedCandidates) {
          if (!probe || (await probeTarget(candidate.webSocketDebuggerUrl))) {
            acceptedPinnedCandidate = candidate;
            return true;
          }
        }
        return false;
      }
      if (iosPinned && simName) {
        const pinnedCandidates = runtimeCandidates.filter(
          (candidate) => candidate.deviceName === simName,
        );
        for (const candidate of pinnedCandidates) {
          if (!probe || (await probeTarget(candidate.webSocketDebuggerUrl))) {
            acceptedPinnedCandidate = candidate;
            return true;
          }
        }
        return false;
      }
      return true;
    });
  } catch (e) {
    throw coded(
      new Error(`Cannot reach Metro at ${listUrl}. Is Metro running?\n  ${e.message}`),
      BRIDGE_ERROR_CODES.METRO_UNREACHABLE,
    );
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    throw coded(new Error(`No debug targets found at ${listUrl}`), BRIDGE_ERROR_CODES.NO_TARGET);
  }

  // Filter to React Native / Hermes targets with a WebSocket URL
  let candidates = rankRuntimeCandidates(targets);

  // Android pin identities (loaded before the simulator filter so an explicit
  // android pin can take precedence over an ambient simulator name):
  //   ANDROID_TARGET_DEVICE_NAME — Metro-compatible model prefix resolved by bridge.mjs
  //     from the adb serial via `adb -s <serial> shell getprop ro.product.model`.
  //     Example: "Pixel 6" matches Metro deviceName "Pixel 6 - 16 - API 36".
  //   ANDROID_DEVICE — exact user-specified Metro deviceName.
  // Filter by simulator name if IOS_SIMULATOR is set — but never when an android
  // pin is present: dual-platform slots carry an ambient IOS_SIMULATOR in their
  // context, and letting it win here sends a pinned android action to the iOS
  // target. No-match keeps the full candidate set (ambient sim configs tolerate a
  // sim that is not currently attached).
  if (simName && !androidPinned) {
    const deviceFiltered = candidates.filter((t) => t.deviceName === simName);
    if (deviceFiltered.length > 0) {
      candidates = deviceFiltered;
    } else if (iosPinned) {
      throw coded(
        new Error(`Pinned iOS simulator '${simName}' did not match any Metro target.`),
        BRIDGE_ERROR_CODES.NO_TARGET,
      );
    }
  }

  // Android pin enforcement — at ANY candidate count. A pin gated on
  // candidates.length > 1 silently accepted a single WRONG candidate (observed
  // live: the pinned Pixel's target dropped off Metro while the iOS target
  // remained; the pin was ignored and the recipe drove the simulator). When a
  // device is pinned, we MUST NOT silently fall back to another target; an
  // unmatchable pin fails fast with diagnostics.
  if (androidPinned) {
    let androidFiltered = [];

    if (androidTargetName) {
      // Model prefix match: "Pixel 6" matches "Pixel 6 - 16 - API 36". Metro's
      // /json/list has no explicit platform field, so scope the ANDROID pin by
      // excluding the one iOS identity we do know (the pinned simulator name) —
      // a simulator named to shadow a model string must not satisfy an android pin.
      androidFiltered = candidates.filter(matchesAndroidPin);
      const matchingDeviceIdentities = [...new Set(androidFiltered.map(targetDeviceIdentity))];
      if (matchingDeviceIdentities.length > 1) {
        // Two same-model devices produce identical Metro model prefixes — the pin
        // is genuinely ambiguous. Native + JS pages share the same Metro device
        // identity and must remain available for probing.
        const ambiguousList = androidFiltered
          .map(
            (target) =>
              `  deviceName=${JSON.stringify(target.deviceName || '')} ws=${target.webSocketDebuggerUrl || ''}`,
          )
          .join('\n');
        throw coded(
          new Error(
            `Pinned Android device is ambiguous: model '${androidTargetName}' matches ${matchingDeviceIdentities.length} Metro devices.\n` +
              `  Requested --device (ADB_SERIAL): ${adbSerial || '(not set)'}\n` +
              `  Matching Metro targets:\n${ambiguousList}\n` +
              `  Set ANDROID_DEVICE to the exact Metro deviceName to disambiguate.`,
          ),
          BRIDGE_ERROR_CODES.NO_TARGET,
        );
      }
      if (androidFiltered.length === 0) {
        // Pinned device could not be matched — never silently pick another target.
        const candidateList = targets
          .map(
            (t) =>
              `  deviceName=${JSON.stringify(t.deviceName || '')} ws=${t.webSocketDebuggerUrl || ''}`,
          )
          .join('\n');
        throw coded(
          new Error(
            `Pinned Android device did not match any Metro target.\n` +
              `  Requested --device (ADB_SERIAL): ${adbSerial || '(not set)'}\n` +
              `  Resolved model (ANDROID_TARGET_DEVICE_NAME): ${androidTargetName}\n` +
              `  ANDROID_DEVICE: ${androidDevice || '(not set)'}\n` +
              `  Metro /json/list candidates:\n${candidateList}`,
          ),
          BRIDGE_ERROR_CODES.NO_TARGET,
        );
      }
      candidates = androidFiltered;
    } else if (androidDevice) {
      // Exact Metro deviceName match when the user set ANDROID_DEVICE directly.
      androidFiltered = candidates.filter(matchesAndroidPin);
      if (androidFiltered.length === 0) {
        // Pinned by exact Metro name but no candidate matched — fail fast.
        const candidateList = targets
          .map(
            (t) =>
              `  deviceName=${JSON.stringify(t.deviceName || '')} ws=${t.webSocketDebuggerUrl || ''}`,
          )
          .join('\n');
        throw coded(
          new Error(
            `Pinned Android device (ANDROID_DEVICE='${androidDevice}') did not match any Metro target.\n` +
              `  ADB_SERIAL: ${adbSerial || '(not set)'}\n` +
              `  Metro /json/list candidates:\n${candidateList}`,
          ),
          BRIDGE_ERROR_CODES.NO_TARGET,
        );
      }
      candidates = androidFiltered;
    }
  }

  if (candidates.length === 0) {
    candidates = targets.filter((t) => t.webSocketDebuggerUrl);
  }

  if (candidates.length === 0) {
    throw coded(
      new Error(`No suitable debug target found. Targets:\n${JSON.stringify(targets, null, 2)}`),
      BRIDGE_ERROR_CODES.NO_TARGET,
    );
  }

  if (acceptedPinnedCandidate) {
    for (const candidate of candidates) {
      if (candidate.webSocketDebuggerUrl === acceptedPinnedCandidate.webSocketDebuggerUrl) {
        return {
          id: acceptedPinnedCandidate.id || '',
          wsUrl: acceptedPinnedCandidate.webSocketDebuggerUrl,
          deviceName: acceptedPinnedCandidate.deviceName || '',
        };
      }
    }
  }

  // The persistent console forwarder already owns and validates brokered CDP
  // sessions. Re-probing here would evict that debugger; preserve the normal
  // platform/device filtering and select the highest-ranked runtime instead.
  if (!probe) {
    return {
      id: candidates[0].id || '',
      wsUrl: candidates[0].webSocketDebuggerUrl,
      deviceName: candidates[0].deviceName || '',
    };
  }

  // Sort by page number descending (JS runtime has higher page number than C++
  // native). rankRuntimeCandidates output arrives pre-sorted; this re-sort is
  // load-bearing only when the raw targets.filter() fallback above repopulated
  // the candidate list.
  candidates.sort((a, b) => {
    const aPage = Number.parseInt((a.id || '').split('-').pop() || '0', 10);
    const bPage = Number.parseInt((b.id || '').split('-').pop() || '0', 10);
    return bPage - aPage;
  });

  // Probe candidates to find the one with __AGENTIC__ installed (the JS runtime)
  for (const candidate of candidates) {
    const hasAgentic = await probeTarget(candidate.webSocketDebuggerUrl);
    if (hasAgentic) {
      return {
        id: candidate.id || '',
        wsUrl: candidate.webSocketDebuggerUrl,
        deviceName: candidate.deviceName || '',
      };
    }
  }

  if (androidPinned || iosPinned) {
    const candidateList = candidates
      .map(
        (target) =>
          `  deviceName=${JSON.stringify(target.deviceName || '')} ws=${target.webSocketDebuggerUrl || ''}`,
      )
      .join('\n');
    throw coded(
      new Error(
        `Pinned ${androidPinned ? 'Android device' : `iOS simulator '${simName || process.env.SIM_UDID || '(unknown)'}'`} has no responding __AGENTIC__ JS runtime after ${FETCH_RETRIES} discovery attempt(s).\n` +
          (androidPinned
            ? `  Requested --device (ADB_SERIAL): ${adbSerial || '(not set)'}\n`
            : '') +
          `  Matching non-agentic targets:\n${candidateList}\n` +
          `  The native C++ page is not a valid recipe target; wait for Hermes to re-register or relaunch the pinned app.`,
      ),
      BRIDGE_ERROR_CODES.NO_TARGET,
    );
  }

  // Fallback: return highest page number (most likely the JS runtime)
  return {
    id: candidates[0].id || '',
    wsUrl: candidates[0].webSocketDebuggerUrl,
    deviceName: candidates[0].deviceName || '',
  };
}

/**
 * Discover ALL Hermes targets with __AGENTIC__ installed (one per platform/device).
 * Groups by deviceName so each device returns at most one target.
 */
async function discoverAllTargets(port) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  let targets;
  try {
    targets = await fetchJSON(listUrl);
  } catch (e) {
    throw coded(
      new Error(`Cannot reach Metro at ${listUrl}. Is Metro running?\n  ${e.message}`),
      BRIDGE_ERROR_CODES.METRO_UNREACHABLE,
    );
  }

  const candidates = rankRuntimeCandidates(targets);

  // Group by deviceName, probe each to find the JS runtime target. Prefer the
  // device's __AGENTIC__-bearing target; when a device has none, keep its first
  // RESPONSIVE candidate (candidates are sorted JS-runtime-first) so a build
  // that predates the bridge still surfaces — the status consumer reports it as
  // bridge-absent instead of the device silently vanishing from discovery.
  // Known ambiguity: when a device's JS runtime is attached-but-busy while its
  // native C++ Hermes page answers, that page is also 'responsive' (no
  // __AGENTIC__ in the native context), so the device reports bridge-absent even
  // though the app build may carry the bridge. Low probability, and the degraded
  // report is informative rather than harmful.
  const agenticByDevice = new Map();
  const responsiveByDevice = new Map();
  for (const candidate of candidates) {
    const device = candidate.deviceName || candidate.id || candidate.webSocketDebuggerUrl;
    if (agenticByDevice.has(device)) continue;
    const state = await probeTargetDetailed(candidate.webSocketDebuggerUrl);
    if (state === 'agentic') {
      agenticByDevice.set(device, { wsUrl: candidate.webSocketDebuggerUrl, deviceName: device });
    } else if (state === 'responsive' && !responsiveByDevice.has(device)) {
      responsiveByDevice.set(device, { wsUrl: candidate.webSocketDebuggerUrl, deviceName: device });
    }
  }
  const results = [...agenticByDevice.values()];
  for (const [device, entry] of responsiveByDevice) {
    if (!agenticByDevice.has(device)) results.push(entry);
  }
  return results;
}

module.exports = { discoverTarget, discoverAllTargets, rankRuntimeCandidates };
