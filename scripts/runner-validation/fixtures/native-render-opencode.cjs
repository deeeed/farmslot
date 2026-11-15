#!/usr/bin/env node
// Synthetic OpenCode ACP peer for the Companion native render proof. Each prompt edits two files in
// the session folder, reports the first edit as a tool call with its diff, and replies with
// markdown that has a list, a fenced TypeScript block and links to both files. No model runs.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv.includes('--version')) {
  console.log('opencode 1.2.27');
  process.exit(0);
}
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
let session = 'render-session';
let cwd = process.cwd();
const update = (value) =>
  send({ method: 'session/update', params: { sessionId: session, update: value } });
const configOptions = [
  { id: 'model', currentValue: 'synthetic/render', options: [{ value: 'synthetic/render' }] },
];

const REPLY = `Updated the greeting count and wrote the plan.

- Bumped \`count\` in [demo.ts line 32](src/demo.ts:32)
- Wrote the plan in \`notes/plan.md\`

\`\`\`ts
export function greet(input: Greeting): string {
  const count = 2;
  return \`Hello, \${input.name}! (\${count})\`;
}
\`\`\`
`;

const PLAN = `# Plan

1. Bump the greeting count.
2. Keep the filler steps.

\`\`\`ts
const count = 2;
\`\`\`

See [the greeting](../src/demo.ts:32).
`;

function edit() {
  const file = path.join(cwd, 'src/demo.ts');
  const oldText = fs.readFileSync(file, 'utf8');
  const newText = oldText.replace('const count = 1;', 'const count = 2;');
  fs.writeFileSync(file, newText);
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), PLAN);
  return { file, oldText, newText };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    return result(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'opencode-login' }],
    });
  if (message.method === 'authenticate') return result(message.id, {});
  if (message.method === 'session/new' || message.method === 'session/load') {
    if (message.params?.cwd) cwd = message.params.cwd;
    if (message.method === 'session/load') session = message.params.sessionId;
    return result(message.id, {
      ...(message.method === 'session/new' ? { sessionId: session } : {}),
      modes: { availableModes: [{ id: 'default' }] },
      configOptions,
    });
  }
  if (message.method === 'session/set_config_option') {
    const option = configOptions.find((candidate) => candidate.id === message.params.configId);
    if (option) option.currentValue = message.params.value;
    return result(message.id, { configOptions });
  }
  if (message.method === 'session/set_model' || message.method === 'session/set_mode')
    return result(message.id, {});
  if (message.method === 'session/cancel') return result(message.id, {});
  if (message.method === 'session/prompt') {
    const { file, oldText, newText } = edit();
    update({
      sessionUpdate: 'tool_call',
      toolCallId: `edit-${message.id}`,
      title: 'Edit src/demo.ts',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: file }],
      content: [{ type: 'diff', path: file, oldText, newText }],
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: `edit-${message.id}`,
      status: 'completed',
    });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } });
    return result(message.id, { stopReason: 'end_turn' });
  }
  if (message.id !== undefined && message.method) result(message.id, {});
});
