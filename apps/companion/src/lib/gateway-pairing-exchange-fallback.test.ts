import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeGatewayPairingQr } from './gateway-pairing-exchange';

type Frame = { id: string; method: string; params: Record<string, unknown> };
type Reply = (socket: FakeSocket, frame: Frame) => void;

class FakeSocket {
  static opened: FakeSocket[] = [];
  static unreachable = new Set<string>();
  static reply: Reply = () => {};
  onopen?: () => void;
  onerror?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  readonly sent: Frame[] = [];

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    setImmediate(() => (FakeSocket.unreachable.has(url) ? this.onerror?.() : this.onopen?.()));
  }

  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    setImmediate(() => FakeSocket.reply(this, frame));
  }

  respond(id: string, ok: boolean, body: unknown) {
    this.onmessage?.({
      data: JSON.stringify(
        ok ? { type: 'res', id, ok, payload: body } : { type: 'res', id, ok, error: body },
      ),
    });
  }

  close() {}
}

const tailnet = 'ws://macwork.tail73dab7.ts.net:7801/ws';
const lan = 'ws://192.168.128.52:7801/ws';
const payload = {
  type: 'farmslot.gateway-pairing.v1' as const,
  profiles: [
    { url: lan, code: 'one-use-code', profileName: 'macwork (LAN)' },
    { url: tailnet, code: 'one-use-code', profileName: 'macwork (Tailscale)' },
  ],
};
const id = 'a'.repeat(32);
const grant = {
  accessToken: `fsa_${id}_${'x'.repeat(43)}`,
  accessExpiresAt: '2026-10-30T04:00:00.000Z',
  refreshToken: `fsr_${id}_${'y'.repeat(43)}`,
  session: {
    id,
    principalId: 'arthur',
    principalGeneration: 1,
    deviceName: 'Mobile Companion',
    deviceKind: 'companion',
    createdAt: '2026-10-30T03:00:00.000Z',
    lastRefreshedAt: '2026-10-30T03:00:00.000Z',
    refreshExpiresAt: '2026-11-29T03:00:00.000Z',
    revokedAt: null,
  },
};
const connected = (principal: { id: string; subjectKind: string }) => ({
  ok: true,
  clientKind: 'companion',
  authMode: 'token',
  authenticatedAt: Date.now(),
  capabilities: { httpBearerAuth: true, voiceInstructionFormatting: true },
  principal: { ...principal, generation: 1, displayName: principal.id, roles: [] },
});

function withFakeSockets(t: test.TestContext, reply: Reply, unreachable: string[] = []) {
  const original = globalThis.WebSocket;
  FakeSocket.opened = [];
  FakeSocket.unreachable = new Set(unreachable);
  FakeSocket.reply = reply;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
}

test('a pairing that fails after the gateway took the code reports that failure, not a spent code on the next URL', async (t) => {
  withFakeSockets(t, (socket, frame) => {
    if (frame.method === 'pairing.exchange')
      socket.respond(frame.id, false, {
        code: 'AUTH_PERSON_SESSION_REQUIRED',
        message: 'Sign in using a current Farmslot client.',
      });
    else if (frame.method === 'auth.session.exchange') socket.respond(frame.id, true, grant);
    else socket.respond(frame.id, false, { code: 'AUTH_FAILED', message: 'Verification refused' });
  });
  await assert.rejects(exchangeGatewayPairingQr(payload), /Verification refused/u);
  assert.deepEqual(
    FakeSocket.opened.map(({ url }) => url),
    [tailnet],
  );
});

test('an unreachable first URL falls back before the code is sent', async (t) => {
  withFakeSockets(
    t,
    (socket, frame) => {
      if (frame.method === 'pairing.exchange')
        socket.respond(frame.id, true, {
          profile: { name: 'macwork', url: lan, authMode: 'token', secret: 'device-secret' },
          expiresAt: '2026-10-30T03:05:00.000Z',
        });
      else
        socket.respond(
          frame.id,
          true,
          connected({ id: 'farm-automation', subjectKind: 'service' }),
        );
    },
    [tailnet],
  );
  const profiles = await exchangeGatewayPairingQr(payload);
  assert.deepEqual(
    FakeSocket.opened.map(({ url, sent }) => [url, sent.map(({ method }) => method)]),
    [
      [tailnet, []],
      [lan, ['pairing.exchange', 'auth.connect']],
    ],
  );
  assert.deepEqual(
    profiles.map(({ url }) => url),
    [lan, tailnet],
  );
});
