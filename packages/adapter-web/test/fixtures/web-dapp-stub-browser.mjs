#!/usr/bin/env node
// Stand-in for the slot browser in web-dapp adapter tests: answers --version,
// serves /json/version on --remote-debugging-port, and speaks enough CDP over a
// WebSocket for the wallet host's tab setup. Behaviour comes from env:
//   STUB_MODE        ok | silent | http-only | probe | restored | no-binding | console | no-commit | link-only
//                    | mainnet-app | probe-reaches | reject-preload | early-log
//                    | probe-cors | probe-other-blocker | no-resolver | icon | stale-commit
//                    | notification | double-commit | detach-pending
//   STUB_APP_ORIGIN  the app origin the host navigates the tab to
//   STUB_LOG         JSONL file of CDP commands received (method, session,
//                    contextId, whether a resolve carried an error)
// probe: after the app document commits, the page logs and signs once from the
// top frame, and an iframe and a blank popup try the same.
// restored: a restored app tab exists, and the app tab is attached twice.
// console: /json/list shows one app page whose console logs an error and
// whose script throws once a client enables Runtime.
// mainnet-app: the app document requests the mainnet venue and asks to sign a
// mainnet action. probe-reaches: the mainnet probe gets through.
// reject-preload: installing the page script fails. early-log: a second app
// tab logs before its frame tree (committed URL) is answered.
// probe-cors: the HTTP probe fails, but by CORS rather than the request block.
// probe-other-blocker: it fails as blocked by client, but not by the host.
// no-resolver: the resolver probe fails, but not at name resolution.
// notification: once the app is open, MetaMask opens a notification window.
// double-commit: the blank tab's commit is reported by both Page.frameNavigated
// and Page.getFrameTree (same loaderId), then the app document logs before
// its own commit. detach-pending: a second app tab logs before its commit is
// known and detaches before it is.
// icon: the app also loads a coin icon from app.hyperliquid.xyz (not a venue
// endpoint). stale-commit: the app document's context exists and logs before
// its frameNavigated, while the previous commit (about:blank) is still the
// tab's latest. The launch probes fail as Chrome reports them (the request
// block, the resolver rule) unless probe-reaches or probe-cors.
// Every app document requests the testnet venue unless mainnet-app.

import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('StubBrowser 1.0');
  process.exit(0);
}
const port = Number(args.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1]);
const mode = process.env.STUB_MODE ?? 'ok';
const appOrigin = process.env.STUB_APP_ORIGIN ?? 'http://localhost:1';

if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'StubBrowser/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/stub`,
        }),
      );
      return;
    }
    if (mode === 'console' && req.url?.startsWith('/json/list')) {
      res.end(
        JSON.stringify(
          [
            {
              id: 'PAGE',
              type: 'page',
              url: `${appOrigin}/order/ETH`,
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE`,
            },
            // Chrome for Testing's own component extension, listed first.
            {
              id: 'COMPONENT',
              type: 'service_worker',
              url: 'chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/background.js',
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/COMPONENT`,
            },
            {
              id: 'SW',
              type: 'service_worker',
              url: `chrome-extension://${'a'.repeat(32)}/scripts/app-init.js`,
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/SW`,
            },
          ].filter((target) => target.id !== 'SW' || process.env.STUB_NO_METAMASK !== '1'),
        ),
      );
      return;
    }
    res.end('[]');
  });
  if (mode === 'http-only') {
    server.on('upgrade', (_req, socket) => socket.destroy());
  } else {
    const { WebSocketServer } = createRequire(import.meta.url)('ws');
    new WebSocketServer({ server }).on('connection', (socket, req) => {
      if (req.url === '/devtools/page/PAGE') servePage(socket, 'PAGE');
      else if (req.url === '/devtools/page/SW') servePage(socket, 'SW');
      else if (req.url === '/devtools/page/COMPONENT') servePage(socket, 'COMPONENT');
      else serveCdp(socket);
    });
  }
  server.listen(port, '127.0.0.1');
}

function serveCdp(socket) {
  const committed = new Map([
    ['APP', 'about:blank'],
    ['OLD', `${appOrigin}/`],
    ['POPUP', 'about:blank'],
    ['APP2', `${appOrigin}/order/ETH`],
  ]);
  const bindings = new Map();
  const send = (message) => socket.send(JSON.stringify(message));
  const emit = (method, params, sessionId) =>
    send({ method, params, ...(sessionId ? { sessionId } : {}) });
  const record = (entry) => {
    if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${JSON.stringify(entry)}\n`);
  };
  const sessionTarget = { S1: 'APP', S2: 'APP', SOLD: 'OLD', SPOP: 'POPUP', S3: 'APP2' };
  // A binding call reaches every session that registered the binding, as in
  // Chrome when two sessions hook the same page.
  const callBinding = (targetId, name, contextId, payload) => {
    for (const [sessionId, target] of Object.entries(sessionTarget)) {
      if (target === targetId && bindings.get(sessionId)?.has(name)) {
        emit(
          'Runtime.bindingCalled',
          { name, executionContextId: contextId, payload: JSON.stringify(payload) },
          sessionId,
        );
      }
    }
  };

  socket.on('message', (raw) => {
    const { id, method, params = {}, sessionId } = JSON.parse(String(raw));
    record({
      method,
      sessionId: sessionId ?? null,
      contextId: params.contextId ?? null,
      refused: /"code":4100/u.test(params.expression ?? ''),
      targetId: params.targetId ?? null,
      requestId: params.requestId ?? null,
      background: params.background ?? null,
      newWindow: params.newWindow ?? null,
    });
    if (mode === 'reject-preload' && method === 'Page.addScriptToEvaluateOnNewDocument') {
      send({
        id,
        error: { code: -32000, message: 'stub refused the page script' },
        ...(sessionId ? { sessionId } : {}),
      });
      return;
    }
    if (mode === 'detach-pending' && method === 'Page.getFrameTree' && sessionId === 'S3') {
      setTimeout(
        () => emit('Target.detachedFromTarget', { sessionId: 'S3', targetId: 'APP2' }),
        200,
      );
      return;
    }
    if (mode === 'double-commit' && method === 'Page.enable' && sessionId === 'S1') {
      emit(
        'Page.frameNavigated',
        { frame: { id: 'APP', url: 'about:blank', loaderId: 'L0' } },
        'S1',
      );
    }
    if (mode === 'early-log' && method === 'Page.getFrameTree' && sessionId === 'S3') {
      setTimeout(
        () =>
          send({
            id,
            result: { frameTree: { frame: { id: 'APP2', url: committed.get('APP2') } } },
            sessionId,
          }),
        600,
      );
      return;
    }
    let result = {};
    if (method === 'Target.getTargets') {
      result = {
        targetInfos:
          mode === 'restored' ? [{ targetId: 'OLD', type: 'page', url: `${appOrigin}/` }] : [],
      };
    } else if (method === 'Target.createTarget') {
      result = { targetId: 'APP' };
    } else if (method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: {
            id: sessionTarget[sessionId],
            url: committed.get(sessionTarget[sessionId]),
            loaderId: committed.get(sessionTarget[sessionId]) === 'about:blank' ? 'L0' : 'L1',
          },
        },
      };
    } else if (method === 'Page.navigate') {
      result = { frameId: 'APP', loaderId: 'L1' };
    } else if (method === 'Target.getTargetInfo') {
      result = { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
    } else if (
      method === 'Runtime.evaluate' &&
      /typeof window\.__farmslotWalletLog === 'function'/u.test(params.expression ?? '')
    ) {
      result = { result: { type: 'boolean', value: mode !== 'no-binding' } };
    } else if (
      method === 'Runtime.evaluate' &&
      /mm-harness-probe=1/u.test(params.expression ?? '')
    ) {
      result = {
        result: { type: 'string', value: mode === 'probe-reaches' ? 'reached' : 'blocked' },
      };
      if (
        mode !== 'probe-reaches' &&
        /fetch\('https:\/\/api\.hyperliquid\.xyz:444\//u.test(params.expression)
      ) {
        // The resolver rule fails every port of the host.
        emit(
          'Network.requestWillBeSent',
          {
            requestId: 'PROBE-RESOLVER',
            request: { url: 'https://api.hyperliquid.xyz:444/info?mm-harness-probe=1' },
          },
          sessionId,
        );
        emit(
          'Network.loadingFailed',
          {
            requestId: 'PROBE-RESOLVER',
            errorText:
              mode === 'no-resolver' ? 'net::ERR_CONNECTION_REFUSED' : 'net::ERR_NAME_NOT_RESOLVED',
          },
          sessionId,
        );
      } else if (mode !== 'probe-reaches' && /fetch\(/u.test(params.expression)) {
        const url = 'https://api.hyperliquid.xyz/info?mm-harness-probe=1';
        emit('Network.requestWillBeSent', { requestId: 'PROBE-HTTP', request: { url } }, sessionId);
        // As headful Chrome reports a request the host failed with
        // Fetch.failRequest (headless says net::ERR_BLOCKED_BY_CLIENT.Inspector).
        if (mode !== 'probe-cors' && mode !== 'probe-other-blocker')
          emit(
            'Fetch.requestPaused',
            { requestId: 'PROBE-FETCH', request: { url }, resourceType: 'Fetch' },
            sessionId,
          );
        setTimeout(
          () =>
            emit(
              'Network.loadingFailed',
              mode === 'probe-cors'
                ? {
                    requestId: 'PROBE-HTTP',
                    errorText: 'net::ERR_FAILED',
                    corsErrorStatus: { corsError: 'MissingAllowOriginHeader' },
                  }
                : {
                    requestId: 'PROBE-HTTP',
                    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
                    blockedReason: 'other',
                  },
              sessionId,
            ),
          50,
        );
      }
      if (mode !== 'probe-reaches' && /new WebSocket\(/u.test(params.expression)) {
        emit(
          'Network.webSocketCreated',
          { requestId: 'PROBE-WS', url: 'wss://api.hyperliquid.xyz/ws?mm-harness-probe=1' },
          sessionId,
        );
        // Headful Chrome can report the failure with an empty message.
        emit('Network.webSocketFrameError', { requestId: 'PROBE-WS', errorMessage: '' }, sessionId);
      }
    } else if (method === 'Runtime.addBinding') {
      const set = bindings.get(sessionId) ?? new Set();
      set.add(params.name);
      bindings.set(sessionId, set);
    }
    send({ id, result, ...(sessionId ? { sessionId } : {}) });

    if (method === 'Page.navigate' && mode === 'notification') {
      setTimeout(
        () =>
          emit('Target.targetCreated', {
            targetInfo: {
              targetId: 'NOTE',
              type: 'page',
              url: `chrome-extension://${'a'.repeat(32)}/notification.html#/confirm-transaction/1/signature-request`,
            },
          }),
        400,
      );
    }
    if (method === 'Target.setAutoAttach' && mode === 'restored') {
      emit('Target.attachedToTarget', {
        sessionId: 'SOLD',
        targetInfo: { targetId: 'OLD', type: 'page', url: `${appOrigin}/` },
        waitingForDebugger: false,
      });
    }
    if (method === 'Target.createTarget') {
      emit('Target.attachedToTarget', {
        sessionId: 'S1',
        targetInfo: { targetId: 'APP', type: 'page', url: 'about:blank' },
        waitingForDebugger: true,
      });
      if (mode === 'restored') {
        setTimeout(
          () =>
            emit('Target.attachedToTarget', {
              sessionId: 'S2',
              targetInfo: { targetId: 'APP', type: 'page', url: 'about:blank' },
              waitingForDebugger: false,
            }),
          20,
        );
      }
    }
    if (method === 'Runtime.enable' && sessionId === 'S3') {
      // The early log: context and binding call before the frame tree answer.
      emit(
        'Runtime.executionContextCreated',
        { context: { id: 40, origin: appOrigin, auxData: { frameId: 'APP2', isDefault: true } } },
        'S3',
      );
      callBinding('APP2', '__farmslotWalletLog', 40, {
        kind: 'request',
        method: 'wallet_requestPermissions',
        outcome: 'approved',
      });
    }
    if (method === 'Runtime.enable' && (sessionId === 'S1' || sessionId === 'SPOP')) {
      const target = sessionTarget[sessionId];
      emit(
        'Runtime.executionContextCreated',
        {
          context: {
            id: target === 'APP' ? 1 : 30,
            origin: target === 'APP' ? '' : appOrigin,
            auxData: { frameId: target, isDefault: true },
          },
        },
        sessionId,
      );
    }
    if (method === 'Page.navigate' && sessionId === 'S1' && mode === 'no-commit') {
      // The document request is sent and never answered.
      emit(
        'Network.requestWillBeSent',
        { requestId: 'DOC', type: 'Document', request: { url: params.url } },
        'S1',
      );
    } else if (method === 'Page.navigate' && sessionId === 'S1') {
      committed.set('APP', `${appOrigin}/`);
      setTimeout(() => {
        emit('Runtime.executionContextsCleared', {}, 'S1');
        emit(
          'Runtime.executionContextCreated',
          { context: { id: 2, origin: appOrigin, auxData: { frameId: 'APP', isDefault: true } } },
          'S1',
        );
        emit(
          'Runtime.executionContextCreated',
          { context: { id: 3, origin: appOrigin, auxData: { frameId: 'CHILD', isDefault: true } } },
          'S1',
        );
        if (mode === 'stale-commit' || mode === 'double-commit') {
          // The new document's preload logs before the tab reports the commit.
          callBinding('APP', '__farmslotWalletLog', 2, {
            kind: 'request',
            method: 'eth_requestAccounts',
            outcome: 'approved',
          });
          setTimeout(
            () =>
              emit(
                'Page.frameNavigated',
                { frame: { id: 'APP', url: `${appOrigin}/order/BTC`, loaderId: 'L1' } },
                'S1',
              ),
            150,
          );
        } else {
          emit(
            'Page.frameNavigated',
            { frame: { id: 'APP', url: `${appOrigin}/order/BTC` } },
            'S1',
          );
        }
        if (mode === 'icon')
          emit(
            'Network.requestWillBeSent',
            { request: { url: 'https://app.hyperliquid.xyz/coins/BTC.svg' } },
            'S1',
          );
        if (mode === 'mainnet-app') {
          emit(
            'Network.requestWillBeSent',
            { request: { url: 'https://api.hyperliquid.xyz/exchange' } },
            'S1',
          );
          emit(
            'Fetch.requestPaused',
            {
              requestId: 'MAINNET-1',
              request: { url: 'https://api.hyperliquid.xyz/exchange' },
              resourceType: 'Fetch',
            },
            'S1',
          );
          const typed = {
            primaryType: 'HyperliquidTransaction:ApproveAgent',
            domain: { chainId: 42161 },
            types: {},
            message: { hyperliquidChain: 'Mainnet' },
          };
          callBinding('APP', '__farmslotWalletRequest', 2, {
            id: 7,
            method: 'eth_signTypedData_v4',
            params: ['0x0000000000000000000000000000000000000001', JSON.stringify(typed)],
          });
        } else if (mode === 'link-only') {
          // The only testnet traffic is the venue's web host (an icon).
          setTimeout(
            () =>
              emit(
                'Network.requestWillBeSent',
                { request: { url: 'https://app.hyperliquid-testnet.xyz/coins/BTC.svg' } },
                'S1',
              ),
            100,
          );
        } else {
          setTimeout(
            () =>
              emit(
                'Network.requestWillBeSent',
                { request: { url: 'https://api.hyperliquid-testnet.xyz/info' } },
                'S1',
              ),
            100,
          );
        }
        if (mode === 'probe' || mode === 'restored') setTimeout(() => firstDocumentTraffic(), 300);
        if (mode === 'early-log' || mode === 'detach-pending') {
          setTimeout(
            () =>
              emit('Target.attachedToTarget', {
                sessionId: 'S3',
                targetInfo: { targetId: 'APP2', type: 'page', url: `${appOrigin}/order/ETH` },
                waitingForDebugger: false,
              }),
            300,
          );
        }
      }, 50);
    }
  });

  function firstDocumentTraffic() {
    // The app's first document: one logged request and one signing request.
    callBinding('APP', '__farmslotWalletLog', 2, {
      kind: 'request',
      method: 'eth_requestAccounts',
      outcome: 'approved',
    });
    callBinding('APP', '__farmslotWalletRequest', 2, { id: 1, method: 'eth_accounts', params: [] });
    if (mode !== 'probe') return;
    // An iframe on the app origin.
    callBinding('APP', '__farmslotWalletLog', 3, {
      kind: 'request',
      method: 'personal_sign',
      outcome: 'signed',
    });
    callBinding('APP', '__farmslotWalletRequest', 3, { id: 2, method: 'eth_accounts', params: [] });
    // A blank popup the app opened: inherits the app origin, commits about:blank.
    emit('Target.attachedToTarget', {
      sessionId: 'SPOP',
      targetInfo: { targetId: 'POPUP', type: 'page', url: 'about:blank' },
      waitingForDebugger: false,
    });
    setTimeout(() => {
      callBinding('POPUP', '__farmslotWalletLog', 30, {
        kind: 'request',
        method: 'eth_signTypedData_v4',
        outcome: 'signed',
      });
      callBinding('POPUP', '__farmslotWalletRequest', 30, {
        id: 3,
        method: 'eth_accounts',
        params: [],
      });
    }, 500);
  }
}

// The app page (PAGE) and MetaMask's service worker (SW) of STUB_MODE=console,
// as console-tail sees them: the page logs an error and throws once, for the
// first client that enables Runtime.
const targetClients = { PAGE: new Set(), SW: new Set(), COMPONENT: new Set() };
function servePage(socket, targetId) {
  const pageClients = targetClients[targetId];
  socket.on('message', (raw) => {
    const { id, method, params = {} } = JSON.parse(String(raw));
    socket.send(JSON.stringify({ id, result: {} }));
    // A console.info(...) evaluated in the page (the capture control line)
    // reaches every client with Runtime enabled.
    const logged =
      method === 'Runtime.evaluate'
        ? /^console\.info\((".*")\)$/u.exec(params.expression ?? '')
        : null;
    if (logged) {
      for (const client of pageClients)
        client.send(
          JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'info', args: [{ type: 'string', value: JSON.parse(logged[1]) }] },
          }),
        );
    }
    if (method === 'Log.enable' && targetId === 'PAGE') {
      // The launch probe's own failure, as the browser logs it.
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'Log.entryAdded',
              params: {
                entry: {
                  source: 'network',
                  level: 'error',
                  text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT',
                  url: 'https://api.hyperliquid.xyz/info?mm-harness-probe=1',
                },
              },
            }),
          ),
        300,
      );
    }
    if (method !== 'Runtime.enable') return;
    pageClients.add(socket);
    socket.on('close', () => pageClients.delete(socket));
    if (pageClients.size > 1 || targetId !== 'PAGE') return;
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: {
            type: 'error',
            args: [
              {
                type: 'string',
                value:
                  process.env.STUB_PAGE_MESSAGE ??
                  'A handler for NetworkController:getState has not been delegated to PerpsController',
              },
            ],
          },
        }),
      );
      socket.send(
        JSON.stringify({
          method: 'Runtime.exceptionThrown',
          params: {
            exceptionDetails: {
              text: 'Uncaught',
              exception: { description: 'Error: fixture page threw' },
            },
          },
        }),
      );
    }, 300);
  });
}
