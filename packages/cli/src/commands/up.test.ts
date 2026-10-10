import assert from 'node:assert/strict';
import test from 'node:test';

import { OutputContext } from '../output.js';

import { buildHostedGatewayCandidates, writeUpResult } from './up.js';

const TOKEN = 'test-gateway-token-abc123';

class CaptureOutput extends OutputContext {
  text = '';
  data: Record<string, unknown> | null = null;
  override write(text: string): void {
    this.text += text;
  }
  override writeJson(data: unknown): void {
    this.data = data as Record<string, unknown>;
  }
}

function runUpResult(opts: {
  json?: boolean;
  printConnectUrl?: boolean;
  status?: 'gateway up' | 'gateway already running';
  open?: (url: string) => boolean;
  tlsPort?: number;
}): CaptureOutput {
  const output = new CaptureOutput(opts.json ?? false);
  writeUpResult({
    output,
    status: opts.status ?? 'gateway up',
    pid: 4242,
    port: 7777,
    token: TOKEN,
    localActive: true,
    dashboardBuilt: false,
    openBrowser: opts.open !== undefined,
    printConnectUrl: opts.printConnectUrl ?? false,
    tlsPort: opts.tlsPort ?? null,
    open: opts.open,
  });
  return output;
}

function connectPayloads(text: string): Array<Record<string, unknown>> {
  return [...text.matchAll(/connect=([A-Za-z0-9_-]+)/g)].map(
    (m) => JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as Record<string, unknown>,
  );
}

test('hosted candidates are ws:// only when TLS is inactive', () => {
  const candidates = buildHostedGatewayCandidates(7777, null, 'mac', ['192.168.1.5']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    ['ws://localhost:7777/ws', 'ws://192.168.1.5:7777/ws'],
  );
});

test('hosted candidates lead with wss:// when TLS is active, keeping ws:// as fallback', () => {
  const candidates = buildHostedGatewayCandidates(7777, 7778, 'mac', ['192.168.1.5']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      'wss://localhost:7778/ws',
      'wss://192.168.1.5:7778/ws',
      'ws://localhost:7777/ws',
      'ws://192.168.1.5:7777/ws',
    ],
  );
  // A hosted HTTPS Command Center picks the first reachable candidate — it must be wss://.
  assert.match(candidates[0].url, /^wss:\/\//);
});

test('hosted candidates cover every LAN address on both transports', () => {
  const candidates = buildHostedGatewayCandidates(7777, 7778, 'mac', ['10.0.0.2', '10.0.0.3']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      'wss://localhost:7778/ws',
      'wss://10.0.0.2:7778/ws',
      'wss://10.0.0.3:7778/ws',
      'ws://localhost:7777/ws',
      'ws://10.0.0.2:7777/ws',
      'ws://10.0.0.3:7777/ws',
    ],
  );
});

test('up output hides the token-bearing connect link by default and hints the opt-in flag', () => {
  const { text } = runUpResult({});
  assert.ok(!text.includes(TOKEN));
  const payloads = connectPayloads(text);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].token, undefined);
  assert.ok(Array.isArray(payloads[0].gateways) && payloads[0].gateways.length > 0);
  assert.match(text, /farmslot up --print-connect-url/);
});

test('up --print-connect-url prints the full auto-connect link', () => {
  const { text } = runUpResult({ printConnectUrl: true });
  assert.ok(connectPayloads(text).some((payload) => payload.token === TOKEN));
  assert.doesNotMatch(text, /--print-connect-url/);
});

test('up --print-connect-url is honoured when the gateway is already running', () => {
  const quiet = runUpResult({ status: 'gateway already running' }).text;
  assert.match(quiet, /gateway already running/);
  assert.ok(!connectPayloads(quiet).some((payload) => payload.token === TOKEN));
  const printed = runUpResult({ status: 'gateway already running', printConnectUrl: true }).text;
  assert.ok(connectPayloads(printed).some((payload) => payload.token === TOKEN));
});

test('up --json carries no token by default; token and connectUrl only with --print-connect-url', () => {
  const quiet = runUpResult({ json: true }).data!;
  assert.equal(connectPayloads(String(quiet.hostedDashboard))[0].token, undefined);
  assert.equal('connectUrl' in quiet, false);
  assert.equal('token' in quiet, false);
  assert.ok(!JSON.stringify(quiet).includes(TOKEN));
  const printed = runUpResult({ json: true, printConnectUrl: true }).data!;
  assert.equal(connectPayloads(String(printed.connectUrl))[0].token, TOKEN);
  assert.equal(printed.token, TOKEN);
  assert.equal(connectPayloads(String(printed.hostedDashboard))[0].token, undefined);
});

test('up reports the browser open on its own line, without promising a connection', () => {
  const opened: string[] = [];
  const { text } = runUpResult({
    open: (url) => {
      opened.push(url);
      return true;
    },
  });
  // The browser gets the token-bearing link; stdout still never shows the token.
  assert.equal(connectPayloads(opened[0])[0].token, TOKEN);
  assert.ok(!text.includes(TOKEN));
  const dashboardLine = text.split('\n').find((line) => line.includes('dashboard'));
  assert.doesNotMatch(String(dashboardLine), /opened|auto-connect/);
  assert.match(text, /\n {2}browser {8}opened the auto-connect link \(.*farmslot certs setup\)\n/);

  const tls = runUpResult({ open: () => true, tlsPort: 7778 }).text;
  assert.match(tls, /\n {2}browser {8}opened the auto-connect link\n/);

  assert.doesNotMatch(runUpResult({ open: () => false }).text, /\n {2}browser /);
});
