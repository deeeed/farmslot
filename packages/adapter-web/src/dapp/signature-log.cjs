'use strict';

// Read, window and assert the wallet request log a wallet host writes: one
// JSON line per request the app sent to the wallet (method, EIP-712 primary
// type, domain/active chain, outcome) and, with a wallet extension, one line
// per confirmation window it opened. Never holds params, messages or
// signatures. A cursor file marks where the current window starts.
//
// `log` is `{ logFile, cursorFile }`. `policy` adds what the product forbids:
// - `typedDataClasses`: `{ [counter]: { match(entry), param, defaultMax, failure(count, max) } }`,
//   typed-data requests counted under `counter`, at most `node[param]`
//   (default `defaultMax`) allowed;
// - `forbiddenEntries`: `{ [counter]: { match(entry), failure(count) } }`, log
//   entries that fail the assertion whenever one is present.

const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

/**
 * @typedef {{ logFile: string, cursorFile: string }} SignatureLog
 * @typedef {{ seq: number, kind?: string, [field: string]: any }} LogEntry
 * @typedef {{ requested: number, signed: number, rejected: number, chainIds: Array<number | null | undefined> }} PrimaryTypeSummary
 * @typedef {object} SignatureSummary
 * @property {number} requests
 * @property {number} typedDataRequests
 * @property {number} confirmationsShown
 * @property {number} unattributed
 * @property {number} outsideAppFrame
 * @property {Record<string, PrimaryTypeSummary>} byPrimaryType
 * @property {Record<string, number>} byMethod
 * @typedef {object} SignaturePolicy
 * @property {Record<string, { match(entry: LogEntry): boolean, param: string, defaultMax: number, failure(count: number, max: number): string }>} [typedDataClasses]
 * @property {Record<string, { match(entry: LogEntry): boolean, failure(count: number): string }>} [forbiddenEntries]
 */

/** @param {string} text @returns {LogEntry[]} */
function parseLog(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return { seq: index, ...JSON.parse(line) };
      } catch {
        return { seq: index, kind: 'unparseable' };
      }
    });
}

/** @param {SignatureLog} log @returns {Promise<LogEntry[]>} */
async function readLog({ logFile }) {
  try {
    return parseLog(await readFile(logFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** @param {SignatureLog} log @returns {Promise<number>} */
async function readCursor({ cursorFile }) {
  try {
    const cursor = JSON.parse(await readFile(cursorFile, 'utf8'));
    return Number.isInteger(cursor.seq) ? cursor.seq : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

/** @param {SignatureLog} log @param {number} seq */
async function writeCursor({ cursorFile }, seq) {
  await writeFile(cursorFile, `${JSON.stringify({ seq, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
}

// "Token:Permit" → "Permit".
/** @param {unknown} primaryType @returns {string | null} */
function shortPrimaryType(primaryType) {
  if (primaryType == null) return null;
  const raw = String(primaryType);
  return raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
}

/** @param {LogEntry} entry */
function isTypedDataRequest(entry) {
  return entry.kind === 'request' && /^eth_signTypedData/u.test(String(entry.method));
}

/**
 * @param {LogEntry[]} entries
 * @param {SignaturePolicy} [policy]
 * @returns {SignatureSummary & Record<string, any>} The policy's counters are extra top-level keys.
 */
function summarize(entries, policy = {}) {
  assertPolicyCounters(policy);
  const requests = entries.filter((entry) => entry.kind === 'request');
  const typed = requests.filter(isTypedDataRequest);
  /** @type {Record<string, PrimaryTypeSummary>} */
  const byPrimaryType = {};
  for (const entry of typed) {
    const key = shortPrimaryType(entry.primaryType) ?? '<none>';
    byPrimaryType[key] ??= { requested: 0, signed: 0, rejected: 0, chainIds: [] };
    byPrimaryType[key].requested += 1;
    if (entry.outcome === 'signed') byPrimaryType[key].signed += 1;
    if (entry.outcome === 'rejected' || entry.outcome === 'error') byPrimaryType[key].rejected += 1;
    if (!byPrimaryType[key].chainIds.includes(entry.domainChainId))
      byPrimaryType[key].chainIds.push(entry.domainChainId);
  }
  /** @type {Record<string, number>} */
  const byMethod = {};
  for (const entry of requests) byMethod[entry.method] = (byMethod[entry.method] ?? 0) + 1;
  const counted = (rules, list) =>
    Object.fromEntries(
      Object.entries(rules ?? {}).map(([counter, rule]) => [
        counter,
        list.filter(rule.match).length,
      ]),
    );
  return {
    requests: requests.length,
    typedDataRequests: typed.length,
    ...counted(policy.typedDataClasses, typed),
    confirmationsShown: entries.filter((entry) => entry.kind === 'confirmation-shown').length,
    // Forbidden entries and evidence gaps: each one fails the assertion.
    ...counted(policy.forbiddenEntries, entries),
    unattributed: entries.filter((entry) => entry.kind === 'unattributed').length,
    // Calls from an iframe, a foreign page or a blank document: refused, kept as evidence.
    outsideAppFrame: entries.filter((entry) => entry.kind === 'outside-app-frame').length,
    byPrimaryType,
    byMethod,
  };
}

// The summary's own keys; a policy counter may not reuse one.
const SUMMARY_KEYS = Object.freeze([
  'requests',
  'typedDataRequests',
  'confirmationsShown',
  'unattributed',
  'outsideAppFrame',
  'byPrimaryType',
  'byMethod',
]);

/** @param {SignaturePolicy} policy */
function assertPolicyCounters(policy) {
  const names = [
    ...Object.keys(policy.typedDataClasses ?? {}),
    ...Object.keys(policy.forbiddenEntries ?? {}),
  ];
  const clash = names.find(
    (name, index) => SUMMARY_KEYS.includes(name) || names.indexOf(name) !== index,
  );
  if (clash !== undefined) {
    throw new Error(
      `signature log policy counter "${clash}" is a summary key or used twice; name it something else.`,
    );
  }
}

function exact(label, actual, expected, failures) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

// Every expectation in `node` is optional.
/**
 * @param {LogEntry[]} entries
 * @param {Record<string, any>} [node]
 * @param {SignaturePolicy} [policy]
 * @returns {{ ok: boolean, failures: string[], summary: SignatureSummary & Record<string, any> }}
 */
function evaluateSignatureLog(entries, node = {}, policy = {}) {
  const summary = summarize(entries, policy);
  const typed = entries.filter(isTypedDataRequest);
  const failures = [];
  for (const [counter, rule] of Object.entries(policy.forbiddenEntries ?? {})) {
    if (summary[counter] > 0) failures.push(rule.failure(summary[counter]));
  }
  if (summary.unattributed > 0)
    failures.push(
      `${summary.unattributed} wallet log entr(y/ies) could not be attributed to the app's top frame (unattributed)`,
    );
  for (const [counter, rule] of Object.entries(policy.typedDataClasses ?? {})) {
    const max = node[rule.param] == null ? rule.defaultMax : Number(node[rule.param]);
    if (summary[counter] > max) failures.push(rule.failure(summary[counter], max));
  }
  if (Array.isArray(node.allowed_primary_types)) {
    const allowed = new Set(node.allowed_primary_types.map(shortPrimaryType));
    for (const entry of typed) {
      const type = shortPrimaryType(entry.primaryType);
      if (!allowed.has(type))
        failures.push(`primary type ${type} (seq ${entry.seq}) is not allowed`);
    }
  }
  if (node.counts && typeof node.counts === 'object') {
    for (const [type, expected] of Object.entries(node.counts)) {
      exact(
        `signed ${shortPrimaryType(type)}`,
        summary.byPrimaryType[shortPrimaryType(type)]?.signed ?? 0,
        Number(expected),
        failures,
      );
    }
  }
  if (node.request_counts && typeof node.request_counts === 'object') {
    for (const [type, expected] of Object.entries(node.request_counts)) {
      exact(
        `requested ${shortPrimaryType(type)}`,
        summary.byPrimaryType[shortPrimaryType(type)]?.requested ?? 0,
        Number(expected),
        failures,
      );
    }
  }
  if (node.methods && typeof node.methods === 'object') {
    for (const [method, expected] of Object.entries(node.methods)) {
      exact(`method ${method}`, summary.byMethod[method] ?? 0, Number(expected), failures);
    }
  }
  if (
    node.max_typed_data_requests != null &&
    summary.typedDataRequests > Number(node.max_typed_data_requests)
  ) {
    failures.push(
      `typed-data requests ${summary.typedDataRequests} > ${node.max_typed_data_requests}`,
    );
  }
  if (node.expect_confirmations != null) {
    exact(
      'confirmations shown',
      summary.confirmationsShown,
      Number(node.expect_confirmations),
      failures,
    );
  }
  if (node.require_active_chain === true) {
    for (const entry of typed.filter((item) => item.outcome === 'signed')) {
      if (Number(entry.domainChainId) !== Number(entry.activeChainId)) {
        failures.push(
          `seq ${entry.seq} ${shortPrimaryType(entry.primaryType)} signed with domain chainId ${entry.domainChainId} while the wallet was on ${entry.activeChainId}`,
        );
      }
    }
  }
  if (node.max_rejected != null) {
    const rejected = typed.filter(
      (entry) => entry.outcome === 'rejected' || entry.outcome === 'error',
    ).length;
    if (rejected > Number(node.max_rejected))
      failures.push(`rejected typed-data requests ${rejected} > ${node.max_rejected}`);
  }
  return { ok: failures.length === 0, failures, summary };
}

/** @param {SignatureLog} log */
async function windowSinceCursor(log) {
  const [entries, cursor] = await Promise.all([readLog(log), readCursor(log)]);
  return { cursor, entries: entries.filter((entry) => entry.seq >= cursor), total: entries.length };
}

// Move the window start to the end of the log, so the next read covers only
// what follows.
/** @param {SignatureLog} log */
async function resetWindow(log) {
  const entries = await readLog(log);
  await writeCursor(log, entries.length);
  return { cursor: entries.length, previousEntries: entries.length };
}

// Evaluate the current window; entries arrive asynchronously from the wallet
// host, so a failing evaluation is retried until `node.timeout_ms` passes.
/** @param {SignatureLog} log @param {Record<string, any>} [node] @param {SignaturePolicy} [policy] */
async function awaitSignatureLog(log, node = {}, policy = {}) {
  const deadline = Date.now() + Math.max(0, Number(node.timeout_ms ?? 0));
  let window = await windowSinceCursor(log);
  let result = evaluateSignatureLog(window.entries, node, policy);
  while (!result.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    window = await windowSinceCursor(log);
    result = evaluateSignatureLog(window.entries, node, policy);
  }
  return { window, result };
}

// Retain a window as run evidence: <artifactsDir>/<folder>/<nodeId>-signature-log.json.
/**
 * @param {{ artifactsDir?: string, nodeId: string, folder: string }} target
 * @param {unknown} payload
 * @returns {Promise<Array<{ path: string, type: 'report', nodeId: string }>>}
 */
async function writeLogArtifact({ artifactsDir, nodeId, folder }, payload) {
  if (!artifactsDir) return [];
  const relative = `${folder}/${String(nodeId).replaceAll('/', '__')}-signature-log.json`;
  await mkdir(path.join(artifactsDir, folder), { recursive: true });
  await writeFile(path.join(artifactsDir, relative), `${JSON.stringify(payload, null, 2)}\n`);
  return [{ path: relative, type: 'report', nodeId: String(nodeId) }];
}

module.exports = {
  awaitSignatureLog,
  evaluateSignatureLog,
  isTypedDataRequest,
  parseLog,
  readCursor,
  readLog,
  resetWindow,
  shortPrimaryType,
  summarize,
  windowSinceCursor,
  writeCursor,
  writeLogArtifact,
};
