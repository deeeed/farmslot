#!/usr/bin/env node
// gw — Gateway CLI client (zero dependencies — uses Node's native WebSocket)
// Connects to the running gateway via WebSocket, sends a method call, prints the result.
//
// Usage:
//   gw <method> [json-params]
//   gw fleet.status
//   gw slot.check '{"slotId":"runner-mobile-1"}'
//   gw --stream slot.prepare '{"slotId":"runner-mobile-1"}'
//
// Environment:
//   GW_URL     — gateway WebSocket URL (default: ws://localhost:7777)
//   GW_TIMEOUT — timeout in ms (default: 30000)

const GW_URL = process.env.GW_URL || 'ws://localhost:7777';
const GW_TIMEOUT = Number(process.env.GW_TIMEOUT) || 30_000;

// Parse args
let stream = false;
const args = process.argv.slice(2);
if (args[0] === '--stream') {
  stream = true;
  args.shift();
}

const method = args[0];
let params = {};
if (args[1]) {
  try {
    params = JSON.parse(args[1]);
  } catch {
    process.stderr.write(`gw: invalid JSON params: ${args[1]}\n`);
    process.exit(1);
  }
}

if (!method) {
  process.stderr.write('Usage: gw [--stream] <method> [json-params]\n');
  process.exit(1);
}

const reqId = `gw-${Date.now()}`;
const ws = new WebSocket(GW_URL);
let done = false;

const timer = setTimeout(() => {
  if (!done) {
    process.stderr.write(`gw: timeout after ${GW_TIMEOUT}ms\n`);
    ws.close();
    process.exit(1);
  }
}, GW_TIMEOUT);

ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify({
      type: 'req',
      id: reqId,
      method,
      params,
    }),
  );
});

ws.addEventListener('message', (event) => {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }

  // Stream events to stderr (script.output, script.complete, etc.)
  if (frame.type === 'event' && stream) {
    const payload = frame.payload;
    if (payload?.data) {
      process.stderr.write(payload.data);
    }
    return;
  }

  // Skip non-response frames (hello event, etc.)
  if (frame.type !== 'res' || frame.id !== reqId) return;

  done = true;
  clearTimeout(timer);

  if (frame.ok) {
    process.stdout.write(JSON.stringify(frame.payload) + '\n');
    ws.close();
    process.exit(0);
  } else {
    process.stderr.write(`gw: ${frame.error?.message || 'unknown error'}\n`);
    ws.close();
    process.exit(1);
  }
});

ws.addEventListener('error', (event) => {
  if (!done) {
    process.stderr.write(`gw: connection failed — is the gateway running?\n`);
    clearTimeout(timer);
    process.exit(1);
  }
});

ws.addEventListener('close', () => {
  if (!done) {
    clearTimeout(timer);
    process.exit(1);
  }
});
