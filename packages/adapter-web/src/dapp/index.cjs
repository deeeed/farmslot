'use strict';

// The web-dapp layer of the web adapter: a strict EIP-1193 test wallet, the
// page script that wraps the app's provider and logs its wallet requests (or
// injects a provider the host answers), the host's side of that binding, and
// the request log that wallet assertions read. Product policy (typed data to
// refuse, the injected wallet's identity, forbidden log entries) is an input.

const {
  DEFAULT_KNOWN_CHAINS,
  READ_ONLY_RPC_METHODS,
  createStrictWallet,
} = require('./strict-wallet.cjs');
const {
  ERROR_CATEGORIES,
  LOGGED_METHODS,
  LOG_BINDING,
  PAGE_MARKER,
  REQUEST_BINDING,
  RESOLVE_FN,
  pageReadyExpression,
  pageScriptSource,
} = require('./page-script.cjs');
const { PENDING_CALL_TTL_MS, createWalletRequestBinding } = require('./wallet-requests.cjs');
const {
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
} = require('./signature-log.cjs');

module.exports = {
  DEFAULT_KNOWN_CHAINS,
  ERROR_CATEGORIES,
  LOGGED_METHODS,
  LOG_BINDING,
  PAGE_MARKER,
  PENDING_CALL_TTL_MS,
  READ_ONLY_RPC_METHODS,
  REQUEST_BINDING,
  RESOLVE_FN,
  awaitSignatureLog,
  createStrictWallet,
  createWalletRequestBinding,
  evaluateSignatureLog,
  isTypedDataRequest,
  pageReadyExpression,
  pageScriptSource,
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
