#!/usr/bin/env node
// Synthetic native protocol peer for the isolated gateway coherence recipe.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');

if (process.argv.includes('--version')) {
  console.log('2.1.269');
  process.exit(0);
}
if (process.argv.includes('auth')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  process.exit(0);
}
const configPath = process.env.NATIVE_COHERENCE_CONFIG;
if (!configPath) throw new Error('Synthetic runner requires an isolated configuration');
if (process.argv.includes('--provider')) {
  const [, name, action] = process.argv.slice(process.argv.indexOf('--provider'));
  const directory = path.join(path.dirname(configPath), 'providers');
  fs.mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, name);
  if (action === 'acquire') fs.writeFileSync(marker, 'running');
  if (action === 'health' && !fs.existsSync(marker)) process.exit(1);
  if (action === 'release') {
    if (name === 'dep' && fs.existsSync(path.join(directory, 'app')))
      throw new Error('Dependency stopped before its shared parent');
    fs.rmSync(marker, { force: true });
    fs.appendFileSync(path.join(directory, 'releases'), name + '\n');
  }
  process.exit(0);
}
const config = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const conversation = process.argv.includes('--resume')
  ? argument('--resume')
  : argument('--session-id');
const send = (message) =>
  process.stdout.write(JSON.stringify({ ...message, session_id: conversation }) + '\n');
const root = process.env.CLAUDE_CONFIG_DIR;
if (!root || !path.resolve(configPath).startsWith(path.resolve(root, '..') + path.sep))
  throw new Error('Fixture state must stay inside its isolated root');
const transcript = path.join(
  root,
  'projects',
  process.cwd().replaceAll('/', '-'),
  `${conversation}.jsonl`,
);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const transcriptFd = fs.openSync(transcript, 'a');
fs.writeSync(
  transcriptFd,
  JSON.stringify({ sessionId: conversation, type: 'fixture-start' }) + '\n',
);
fs.closeSync(transcriptFd);

function completeTask() {
  const task = config().taskDir;
  if (!task || !path.resolve(task).startsWith(path.resolve(root, '..') + path.sep))
    throw new Error('Fixture task is outside its isolated root');
  fs.mkdirSync(path.join(task, 'artifacts'), { recursive: true });
  for (const name of ['learnings.md', 'pr-description.md'])
    fs.writeFileSync(
      path.join(task, 'artifacts', name),
      '# Fixture proof\nA disposable worker completed its assigned validation task.\n',
    );
  const marks = fs.existsSync(path.join(task, 'CHECKLIST.md'))
    ? [['start'], ['1'], ['complete', '--mark-last']]
    : [['start'], ['complete', '--mark-last']];
  for (const args of marks)
    execFileSync(path.join(task, 'mark'), args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

if (!process.argv.includes('--print')) {
  fs.writeFileSync(
    config().externalReady,
    JSON.stringify({ pid: process.pid, conversation, transcript }),
  );
  const timer = setInterval(() => {
    if (config().mode === 'external-complete') {
      clearInterval(timer);
      completeTask();
    }
  }, 100);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '/exit') {
      clearInterval(timer);
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
} else {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id },
      });
      send({ type: 'system', subtype: 'init' });
    }
    if (message.type !== 'user') return;
    const text = message.message.content;
    fs.appendFileSync(config().inputs, JSON.stringify({ text, conversation }) + '\n');
    send({ type: 'user', message: message.message });
    send({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: `tool-${Date.now()}`,
            name: 'Bash',
            input: { command: 'synthetic task operation' },
          },
        ],
      },
    });
    if (config().mode === 'crash') {
      fs.writeFileSync(config().crashObserved, 'started');
      setTimeout(
        () =>
          process.stderr.write(
            Array.from(
              { length: 60 },
              (_, index) =>
                `stderr ${index}${index === 58 ? ' token=synthetic-secret' : index === 59 ? ' {"Cookie":"synthetic-cookie", "Authorization":"custom synthetic-header"}' : ''}`,
            ).join('\n') + '\n',
            () => process.kill(process.pid, 'SIGTERM'),
          ),
        1000,
      );
    } else {
      setTimeout(
        () => send({ type: 'result', subtype: 'success', is_error: false }),
        text === 'hold-turn' ? (config().holdMs ?? 4000) : 100,
      );
    }
  });
}
