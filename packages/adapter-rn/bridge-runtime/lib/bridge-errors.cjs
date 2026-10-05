'use strict';

// Typed bridge failure codes — the single source of truth for classifying a
// cdp-bridge failure. Substring needles on a critical path are brittle; the
// bridge classifies at the source and stamps a code, so callers (bridge.mjs,
// adapters.ts) branch on the code and only fall back to needles for output
// produced by an older bridge that predates the codes.
//
//   NO_TARGET          no debug target answered (app backgrounded / not attached
//                      / a device pin matched nothing).
//   CDP_TIMEOUT        the CDP connection or a single CDP message timed out.
//   WS_CLOSED          the Hermes debug socket closed mid-command (app reload).
//   METRO_UNREACHABLE  Metro's inspector HTTP endpoint could not be reached.
const BRIDGE_ERROR_CODES = {
  NO_TARGET: 'NO_TARGET',
  CDP_TIMEOUT: 'CDP_TIMEOUT',
  WS_CLOSED: 'WS_CLOSED',
  METRO_UNREACHABLE: 'METRO_UNREACHABLE',
};

const BRIDGE_RESULT_ERROR_CODES = {
  SCROLLABLE_NOT_FOUND: 'SCROLLABLE_NOT_FOUND',
};

// Process exit code the bridge returns per failure code so a caller that only
// sees the child's exit status (no stderr) can still recover the code. Kept
// clear of exit 1 (unknown/uncoded) and 2 (usage).
const EXIT_CODE_BY_ERROR_CODE = {
  NO_TARGET: 10,
  CDP_TIMEOUT: 11,
  WS_CLOSED: 12,
  METRO_UNREACHABLE: 13,
};

const ERROR_CODE_BY_EXIT_CODE = Object.fromEntries(
  Object.entries(EXIT_CODE_BY_ERROR_CODE).map(([code, exit]) => [exit, code]),
);

// Needle → code fallback for uncoded output (older bridge). Case-insensitive,
// first match wins, so order the more specific Metro/no-target needles ahead of
// the generic 'timed out'.
const NEEDLE_CODES = [
  ['cannot reach metro', BRIDGE_ERROR_CODES.METRO_UNREACHABLE],
  ['is metro running', BRIDGE_ERROR_CODES.METRO_UNREACHABLE],
  ['timeout fetching', BRIDGE_ERROR_CODES.METRO_UNREACHABLE],
  ['no responding bridge target', BRIDGE_ERROR_CODES.NO_TARGET],
  ['no debug targets found', BRIDGE_ERROR_CODES.NO_TARGET],
  ['no suitable debug target', BRIDGE_ERROR_CODES.NO_TARGET],
  ['did not match any metro target', BRIDGE_ERROR_CODES.NO_TARGET],
  ['pinned android device', BRIDGE_ERROR_CODES.NO_TARGET],
  ['no react native bridge target', BRIDGE_ERROR_CODES.NO_TARGET],
  ['cdp broker target unavailable', BRIDGE_ERROR_CODES.NO_TARGET],
  ['cdp broker never observed the requested target', BRIDGE_ERROR_CODES.NO_TARGET],
  ['websocket closed', BRIDGE_ERROR_CODES.WS_CLOSED],
  ['websocket error', BRIDGE_ERROR_CODES.WS_CLOSED],
  ['cdp connection timeout', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
  ['cdp message timeout', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
  ['cdp broker connection timeout', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
  ['cdp broker request timeout', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
  ['evaluation timed out', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
  ['timed out', BRIDGE_ERROR_CODES.CDP_TIMEOUT],
];

function classifyBridgeErrorMessage(message) {
  const text = String(message == null ? '' : message).toLowerCase();
  for (const [needle, code] of NEEDLE_CODES) {
    if (text.includes(needle)) return code;
  }
  return null;
}

function classifyBridgeResultError(command, result) {
  if (command !== 'scroll-view' || result?.ok !== false) return null;
  return /^No scrollable(?: found)? near testID=/u.test(String(result.error ?? ''))
    ? BRIDGE_RESULT_ERROR_CODES.SCROLLABLE_NOT_FOUND
    : null;
}

// Attach a code to an error at its throw site (source classification).
function coded(error, code) {
  if (error && typeof error === 'object') error.code = code;
  return error;
}

// The bridge prints this marker on stderr so a caller recovers the code without
// relying on the exit status alone.
const MARKER = /^ERROR\[([A-Z_]+)\]:/mu;

function formatErrorMarker(code, message) {
  return `ERROR[${code}]: ${message}`;
}

function parseErrorMarker(text) {
  const match = MARKER.exec(String(text == null ? '' : text));
  return match ? match[1] : null;
}

module.exports = {
  BRIDGE_ERROR_CODES,
  BRIDGE_RESULT_ERROR_CODES,
  EXIT_CODE_BY_ERROR_CODE,
  ERROR_CODE_BY_EXIT_CODE,
  classifyBridgeErrorMessage,
  classifyBridgeResultError,
  coded,
  formatErrorMarker,
  parseErrorMarker,
};
