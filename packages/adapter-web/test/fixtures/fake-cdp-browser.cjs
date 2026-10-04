#!/usr/bin/env node
// fake-cdp-browser.cjs — stand-in browser for resolver and launcher tests.
// Reads --remote-debugging-port and --user-data-dir like Chrome, holds the
// profile's SingletonLock and a file inside the profile, and serves a browser CDP endpoint. FAKE_CDP_MODE picks the behaviour:
//   ok        answers getTargets/attach/rAF/screenshot/loadUnpacked
//   crash     dies with SIGBUS shortly after start (no DevTools)
//   noframes  answers DevTools but never resolves Runtime.evaluate
//   silent    stays alive without ever listening
//   wrong-id  ok, but Extensions.loadUnpacked returns another extension id
//   foreign   ok, plus a sideloaded user extension that can be disabled
//   stuck     ok, plus a sideloaded user extension that refuses to disable
//   policy    ok, plus an enterprise-pinned extension (cannot be disabled)
//   hangup    closes the socket on the first command
//   unlisten  ok until the first screenshot, then stops listening but stays alive
// Started with --no-startup-window (or FAKE_CDP_WINDOWLESS=1) it has no page
// until Target.createTarget makes one; FAKE_CDP_REJECT_WINDOW=1 makes every
// Target.createTarget fail.
// FAKE_CDP_LOG appends one line per CDP method received.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { WebSocketServer } = require('ws');

const mode = process.env.FAKE_CDP_MODE || 'ok';
const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const requestedPort = portArg ? Number(portArg.split('=')[1]) : 0;
const loadedExtensionId = process.env.FAKE_CDP_EXTENSION_ID || 'hebhblbkkdabgoldnojllkipeoacjioc';
// Hold the profile like Chrome's process singleton: <profile>/SingletonLock -> <host>-<pid>.
const profileArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
if (profileArg) {
  const profile = profileArg.slice('--user-data-dir='.length);
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'SingletonLock'), { force: true });
  fs.symlinkSync(
    `${require('node:os').hostname()}-${process.pid}`,
    path.join(profile, 'SingletonLock'),
  );
  // Chrome keeps its profile databases open; so does the fake.
  fs.openSync(path.join(profile, 'Local State'), 'a');
}
const log = (line) => {
  if (process.env.FAKE_CDP_LOG) fs.appendFileSync(process.env.FAKE_CDP_LOG, `${line}\n`);
};

if (mode === 'crash') {
  setTimeout(() => process.kill(process.pid, 'SIGBUS'), 200);
  setInterval(() => {}, 1000);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'Fake/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
        }),
      );
    } else {
      res.end('[]');
    }
  });
  const wss = new WebSocketServer({ server });
  let loadedId = null;
  const windowless =
    process.env.FAKE_CDP_WINDOWLESS === '1' || process.argv.includes('--no-startup-window');
  const pages = windowless ? [] : [{ targetId: 'page-1', type: 'page', url: 'about:blank' }];
  let attached = null;
  // User extensions besides the loaded extension, per mode.
  const others = [
    ...(mode === 'foreign' || mode === 'stuck'
      ? [
          {
            id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
            name: 'Sideloaded',
            location: 'THIRD_PARTY',
            state: 'ENABLED',
            mustRemainInstalled: false,
            userMayModify: true,
          },
        ]
      : []),
    ...(mode === 'policy'
      ? [
          {
            id: 'glnpjglilkicbckjpbgcfkogebgllemb',
            name: 'Okta Browser Plugin',
            location: 'THIRD_PARTY',
            state: 'ENABLED',
            mustRemainInstalled: true,
            userMayModify: false,
          },
        ]
      : []),
  ];
  wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      log(`${message.method} ${JSON.stringify(message.params ?? {})}`);
      if (mode === 'hangup') {
        socket.terminate();
        return;
      }
      const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
      switch (message.method) {
        case 'Extensions.loadUnpacked':
          loadedId = mode === 'wrong-id' ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : loadedExtensionId;
          reply({ id: loadedId });
          return;
        case 'Target.getTargets':
          reply({
            targetInfos: [
              ...pages,
              ...(loadedId
                ? [
                    {
                      targetId: 'sw-1',
                      type: 'service_worker',
                      url: `chrome-extension://${loadedId}/service-worker.js`,
                    },
                  ]
                : []),
            ],
          });
          return;
        case 'Target.createTarget': {
          if (process.env.FAKE_CDP_REJECT_WINDOW === '1') {
            socket.send(
              JSON.stringify({
                id: message.id,
                error: { code: -32000, message: 'Failed to open a new window' },
              }),
            );
            return;
          }
          const target = {
            targetId: `page-${pages.length + 1}`,
            type: 'page',
            url: message.params?.url ?? 'about:blank',
          };
          pages.push(target);
          reply({ targetId: target.targetId });
          return;
        }
        case 'Target.closeTarget': {
          const index = pages.findIndex((page) => page.targetId === message.params?.targetId);
          if (index >= 0) pages.splice(index, 1);
          reply({ success: true });
          return;
        }
        case 'Target.attachToTarget':
          attached = message.params?.targetId ?? null;
          reply({ sessionId: 'session-1' });
          return;
        case 'Page.navigate': {
          const page = pages.find((entry) => entry.targetId === attached);
          if (page) page.url = message.params?.url ?? page.url;
          reply({ frameId: 'frame-1' });
          return;
        }
        case 'Runtime.evaluate':
          if (mode === 'noframes') return;
          if (String(message.params?.expression).includes('developerPrivate')) {
            reply({
              result: {
                value: [
                  {
                    id: loadedId,
                    name: 'Test Wallet',
                    location: 'UNPACKED',
                    state: 'ENABLED',
                    mustRemainInstalled: false,
                    userMayModify: true,
                  },
                  ...others,
                ],
              },
            });
            return;
          }
          if (message.params?.expression === 'globalThis') {
            reply({ result: { type: 'object', objectId: 'global-1' } });
            return;
          }
          reply({ result: { value: true } });
          return;
        case 'Runtime.callFunctionOn':
          if (String(message.params?.functionDeclaration).includes('management.setEnabled')) {
            const id = message.params.arguments?.[0]?.value;
            const entry = others.find((other) => other.id === id);
            if (mode === 'stuck' || !entry?.userMayModify) {
              reply({ result: { value: `Extension ${id} cannot be modified by user.` } });
            } else {
              entry.state = 'DISABLED';
              reply({ result: { value: 'ok' } });
            }
            return;
          }
          reply({ result: { value: true } });
          return;
        case 'Page.captureScreenshot':
          reply({ data: 'aGk=' });
          if (mode === 'unlisten') {
            setTimeout(() => {
              for (const client of wss.clients) client.terminate();
              server.close();
              setInterval(() => {}, 1000);
            }, 50);
          }
          return;
        default:
          reply({});
      }
    }),
  );
  server.listen(requestedPort, '127.0.0.1', () => {
    process.stderr.write(
      `DevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/fake\n`,
    );
  });
}
