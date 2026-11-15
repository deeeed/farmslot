#!/usr/bin/env node
// Synthetic Claude stream-json peer for the native chat rendering proof. Each turn changes one
// workspace file (so the turn has a diff) and streams a markdown answer with a fenced code block,
// a list, file links and inline code paths, in small chunks the way a real answer streams.
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv.includes('--version')) {
  console.log('2.1.269');
  process.exit(0);
}
if (process.argv.includes('auth')) {
  console.log(JSON.stringify({ loggedIn: true, authMode: 'api_key' }));
  process.exit(0);
}
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const conversation = process.argv.includes('--resume')
  ? argument('--resume')
  : argument('--session-id');
const send = (message) =>
  process.stdout.write(JSON.stringify({ ...message, session_id: conversation }) + '\n');

const answer = [
  'Added a greeting helper.',
  '',
  '- The new function is at [src/app.ts:42](src/app.ts:42).',
  '- Usage notes are in `docs/GUIDE.md`.',
  '- Docs site: [farmslot.io](https://farmslot.io).',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `hello ${name}`;',
  '}',
  '```',
  '',
  'Run it with `npm test`.',
].join('\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id },
    });
    if (message.request?.subtype === 'initialize') send({ type: 'system', subtype: 'init' });
    return;
  }
  if (message.type !== 'user') return;
  send({ type: 'user', message: message.message });
  appendFileSync(
    path.join(process.cwd(), 'src/app.ts'),
    '\nexport function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
  );
  const id = `msg-${Date.now()}`;
  send({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  const chunks = answer.match(/[\s\S]{1,24}/g);
  let index = 0;
  const timer = setInterval(() => {
    send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunks[index] },
      },
    });
    if (++index < chunks.length) return;
    clearInterval(timer);
    send({ type: 'assistant', message: { id, content: [{ type: 'text', text: answer }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }, 15);
});
