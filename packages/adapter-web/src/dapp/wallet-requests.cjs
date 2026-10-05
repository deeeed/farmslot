'use strict';

// The wallet host's side of the page script's bindings. Every binding call is
// judged against the frame and document that made it: only the app's own top
// frame may log a wallet request or ask the injected wallet to sign. Anything
// else (an iframe, a blank popup, a page the tab navigated to) is dropped and
// recorded, and a refused request is answered with 4100. A call that arrives
// before its execution context or its document's commit is known waits
// briefly; one that still cannot be judged is recorded as unattributed (and a
// request is refused).
//
// The host owns the CDP connection and the tabs; it tells the binding when it
// hooks a tab (install), when the tab's top frame commits a document (commit),
// when the tab's domains are enabled (drain) and when the tab detaches
// (detach). Records never hold params, messages or signatures.

const { isAppTopFrameContext, shortUrl } = require('../origin.cjs');
const {
  LOG_BINDING,
  REFUSAL_CHECK_FAILED,
  REQUEST_BINDING,
  RESOLVE_FN,
  assertTypedDataRefusal,
} = require('./page-script.cjs');

const PENDING_CALL_TTL_MS = 5000;

/**
 * - `client`: `{ send(method, params, sessionId), on(event, handler(params, sessionId)) }`.
 * - `signer`: 'extension' (log only) or 'injected' (`wallet` answers requests).
 * - `wallet`: an EIP-1193 `{ request }` for the injected signer.
 * - `refuseTypedData`: the page script's policy (`{ reason, kind, message }`),
 *   applied again here before the wallet signs.
 * - `record(entry)`: append one entry to the wallet request log.
 * - `say(message)`: the host's own log.
 *
 * @param {object} options
 * @param {{ send(method: string, params?: object, sessionId?: string): Promise<any>, on(method: string, handler: (params: any, sessionId?: string) => void): unknown }} options.client
 * @param {string} options.appOrigin
 * @param {'extension' | 'injected'} options.signer
 * @param {{ request(args: { method: string, params?: unknown }): Promise<unknown> } | null} [options.wallet]
 * @param {import('./page-script.cjs').TypedDataRefusal | null} [options.refuseTypedData]
 * @param {(entry: Record<string, unknown>) => void} options.record
 * @param {(message: string) => void} [options.say]
 */
function createWalletRequestBinding({
  client,
  appOrigin,
  signer,
  wallet = null,
  refuseTypedData = null,
  record,
  say = () => {},
}) {
  assertTypedDataRefusal(refuseTypedData);
  // Per app session: its target id (= main frame id) and live execution
  // contexts, so a binding call can be traced to the frame, document and
  // origin that made it.
  const sessionTargets = new Map();
  const sessionContexts = new Map();
  // Binding calls whose execution context, or that context's document, is not
  // known yet.
  const pendingCalls = new Map();
  // Per app session: the URL of a top-frame commit no execution context has
  // been tied to yet.
  const awaitingDocuments = new Map();
  // A commit is applied once: Page.getFrameTree and Page.frameNavigated can
  // both report the same document (its loaderId); a second report would leave
  // a stale commit waiting for the next document's context.
  const appliedCommits = new Map();

  function isTopDefaultContext(sessionId, context) {
    return (
      context?.auxData?.isDefault === true &&
      context.auxData.frameId === sessionTargets.get(sessionId)
    );
  }

  // A top-frame commit is tied to the top frame's default context of its
  // document: one created before the commit and still untied, or else the
  // next one created.
  function assignDocumentUrl(sessionId, url, loaderId) {
    if (loaderId) {
      if (appliedCommits.get(sessionId) === loaderId) return;
      appliedCommits.set(sessionId, loaderId);
    }
    const untied = [...(sessionContexts.get(sessionId)?.values() ?? [])].filter(
      (context) => isTopDefaultContext(sessionId, context) && context.documentUrl === null,
    );
    if (untied.length === 0) {
      awaitingDocuments.set(sessionId, url);
      return;
    }
    for (const context of untied) context.documentUrl = url;
  }

  // Judged against the caller's own document, not the tab's latest commit.
  function callerIsAppTopFrame(sessionId, executionContextId) {
    const context = sessionContexts.get(sessionId)?.get(executionContextId);
    return isAppTopFrameContext(context, {
      targetId: sessionTargets.get(sessionId),
      appOrigin,
      committedUrl: context?.documentUrl ?? null,
    });
  }

  // Answer a request the host refuses, so the page's promise settles instead
  // of hanging; harmless where the preload (and its resolver) is absent.
  function refuse(sessionId, executionContextId, id, message) {
    const outcome = { error: { message, code: 4100 } };
    const expression = `typeof window.${RESOLVE_FN} === 'function' && window.${RESOLVE_FN}(${JSON.stringify(id)}, ${JSON.stringify(outcome)})`;
    return client
      .send('Runtime.evaluate', { expression, contextId: executionContextId }, sessionId)
      .catch(() => {});
  }

  function requestId(name, payload) {
    if (name !== REQUEST_BINDING) return null;
    try {
      return JSON.parse(payload).id ?? null;
    } catch {
      return null;
    }
  }

  async function handleBindingCall({ name, payload, executionContextId }, sessionId) {
    if (!callerIsAppTopFrame(sessionId, executionContextId)) {
      const context = sessionContexts.get(sessionId)?.get(executionContextId);
      record({
        kind: 'outside-app-frame',
        t: Date.now(),
        binding: name === REQUEST_BINDING ? 'request' : 'log',
        origin: context?.origin ?? null,
        document: context?.documentUrl ? shortUrl(context.documentUrl) : null,
      });
      say(
        `ignored ${name === REQUEST_BINDING ? 'wallet request' : 'log entry'} from outside the app top frame`,
      );
      const id = requestId(name, payload);
      if (id !== null)
        await refuse(
          sessionId,
          executionContextId,
          id,
          'Wallet requests are accepted only from the app top frame.',
        );
      return;
    }
    if (name === LOG_BINDING) {
      try {
        record(JSON.parse(payload));
      } catch (error) {
        say(`unparseable log payload: ${error.message}`);
      }
      return;
    }
    if (name !== REQUEST_BINDING || !wallet) return;
    const { id, method, params } = JSON.parse(payload);
    if (refuseTypedData && /^eth_signTypedData/u.test(String(method))) {
      // As in the page: unparseable data is the wallet's to reject; a check that throws refuses.
      let data;
      let parsed = true;
      try {
        data = typeof params?.[1] === 'string' ? JSON.parse(params[1]) : params?.[1];
      } catch {
        parsed = false;
      }
      let reason = null;
      if (parsed) {
        try {
          reason = refuseTypedData.reason(data);
        } catch {
          reason = REFUSAL_CHECK_FAILED;
        }
      }
      if (reason) {
        record({ kind: refuseTypedData.kind, t: Date.now(), method, reason, layer: 'wallet-host' });
        await refuse(sessionId, executionContextId, id, refuseTypedData.message);
        return;
      }
    }
    let outcome;
    try {
      outcome = { result: await wallet.request({ method, params }) };
    } catch (error) {
      outcome = { error: { message: String(error.message), code: error.code ?? -32603 } };
    }
    await client
      .send(
        'Runtime.evaluate',
        {
          expression: `window.${RESOLVE_FN}(${JSON.stringify(id)}, ${JSON.stringify(outcome)})`,
          contextId: executionContextId,
        },
        sessionId,
      )
      .catch((error) => say(`resolve ${method} failed: ${error.message}`));
  }

  function recordUnattributed(call, why) {
    let entry = {};
    try {
      entry = JSON.parse(call.payload);
    } catch {
      entry = {};
    }
    const binding = call.name === REQUEST_BINDING ? 'request' : 'log';
    record({
      kind: 'unattributed',
      t: Date.now(),
      binding,
      method: typeof entry.method === 'string' ? entry.method : null,
      loggedKind: typeof entry.kind === 'string' ? entry.kind : null,
      reason: why,
    });
    say(
      `a wallet ${binding === 'request' ? 'request' : 'log entry'} could not be judged (${why}); recorded as unattributed`,
    );
  }

  // A binding call can be judged once its execution context is known and, for
  // the top frame's default context, the URL of that context's own document.
  function callAttributable(sessionId, executionContextId) {
    const context = sessionContexts.get(sessionId)?.get(executionContextId);
    if (!context) return false;
    return !isTopDefaultContext(sessionId, context) || context.documentUrl !== null;
  }

  // A binding call can arrive before its execution context is reported (the
  // domains are enabled after the tab resumes), or before its document's
  // commit. Hold it until both are known; after a short wait it cannot be
  // judged.
  function drain(sessionId) {
    const queue = pendingCalls.get(sessionId);
    if (!queue) return;
    for (const call of [...queue]) {
      const known = callAttributable(sessionId, call.executionContextId);
      if (!known && Date.now() - call.at < PENDING_CALL_TTL_MS) continue;
      queue.splice(queue.indexOf(call), 1);
      if (known) {
        handleBindingCall(call, sessionId);
        continue;
      }
      recordUnattributed(call, 'its document was never attributed');
      const id = requestId(call.name, call.payload);
      if (id !== null)
        refuse(
          sessionId,
          call.executionContextId,
          id,
          'Wallet request from a document the harness could not attribute.',
        );
    }
  }

  client.on('Runtime.executionContextCreated', ({ context }, sessionId) => {
    const contexts = sessionContexts.get(sessionId);
    if (!contexts) return;
    contexts.set(context.id, context);
    if (isTopDefaultContext(sessionId, context)) {
      // The navigation this document belongs to may already have committed
      // (frameNavigated first) or not yet (the context first).
      const awaiting = awaitingDocuments.get(sessionId);
      context.documentUrl = awaiting ?? null;
      awaitingDocuments.delete(sessionId);
    }
    drain(sessionId);
  });
  client.on('Runtime.executionContextDestroyed', ({ executionContextId }, sessionId) => {
    sessionContexts.get(sessionId)?.delete(executionContextId);
  });
  client.on('Runtime.executionContextsCleared', (_params, sessionId) => {
    sessionContexts.get(sessionId)?.clear();
  });
  client.on('Runtime.bindingCalled', (call, sessionId) => {
    if (callAttributable(sessionId, call.executionContextId)) {
      handleBindingCall(call, sessionId);
      return;
    }
    const queue = pendingCalls.get(sessionId) ?? [];
    queue.push({ ...call, at: Date.now() });
    pendingCalls.set(sessionId, queue);
    setTimeout(() => drain(sessionId), PENDING_CALL_TTL_MS + 50);
  });

  return {
    /**
     * Track an app tab and add its bindings. Call before the page script is
     * registered; neither needs the target running.
     */
    install(sessionId, targetId) {
      sessionTargets.set(sessionId, targetId);
      sessionContexts.set(sessionId, new Map());
      return Promise.all([
        client.send('Runtime.addBinding', { name: LOG_BINDING }, sessionId),
        ...(signer === 'injected'
          ? [client.send('Runtime.addBinding', { name: REQUEST_BINDING }, sessionId)]
          : []),
      ]);
    },
    /** The tab's top frame committed `url` (a frameNavigated or the frame tree). */
    commit(sessionId, url, loaderId) {
      assignDocumentUrl(sessionId, url, loaderId);
      drain(sessionId);
    },
    /** Judge the calls that were waiting for the tab's contexts. */
    drain,
    /** The tab detached: calls still waiting for their document can no longer be judged. */
    detach(sessionId) {
      for (const call of pendingCalls.get(sessionId) ?? [])
        recordUnattributed(call, 'its tab detached first');
      awaitingDocuments.delete(sessionId);
      appliedCommits.delete(sessionId);
      sessionTargets.delete(sessionId);
      sessionContexts.delete(sessionId);
      pendingCalls.delete(sessionId);
    },
  };
}

module.exports = { PENDING_CALL_TTL_MS, createWalletRequestBinding };
