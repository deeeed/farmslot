#!/usr/bin/env node
// Synthetic Claude stream-json peer for the native stream latency probe. Each text delta carries
// the wall-clock time it was written, so the probe can measure runner-to-client latency.
const readline = require('node:readline');

if (process.argv.includes('--version')) {
  console.log('2.1.269');
  process.exit(0);
}
if (process.argv.includes('auth')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  process.exit(0);
}
const deltas = Number(process.env.NATIVE_LATENCY_DELTAS ?? 200);
const intervalMs = Number(process.env.NATIVE_LATENCY_INTERVAL_MS ?? 20);
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const conversation = process.argv.includes('--resume')
  ? argument('--resume')
  : argument('--session-id');
const send = (message) =>
  process.stdout.write(JSON.stringify({ ...message, session_id: conversation }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    // Initialize, set_permission_mode and interrupt all succeed; only initialize starts the session.
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id },
    });
    if (message.request?.subtype === 'initialize') send({ type: 'system', subtype: 'init' });
    return;
  }
  if (message.type !== 'user') return;
  send({ type: 'user', message: message.message });
  // A prompt marked [short] gets a two-line answer, so a proof can keep the prompt in view.
  const count = JSON.stringify(message.message).includes('[short]') ? 2 : deltas;
  const id = `msg-${Date.now()}`;
  send({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  let index = 0;
  let text = '';
  const timer = setInterval(() => {
    const chunk = `[t=${Date.now()}] line ${index} of a synthetic streamed answer.\n`;
    text += chunk;
    send({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    });
    if (++index < count) return;
    clearInterval(timer);
    send({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }, intervalMs);
});
