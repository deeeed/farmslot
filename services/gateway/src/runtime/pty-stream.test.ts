import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// No real PTY or tmux command runs. This selector models tmux's separate active
// window and pane: selecting an inactive window's pane does not select its window.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'terminal-attach-'));
const selector = path.join(scratch, 'selector');
const stateFile = path.join(scratch, 'selection.json');
writeFileSync(
  selector,
  `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.TERMINAL_ATTACH_STATE, 'utf8'));
let commands = [[]];
for (const arg of process.argv.slice(2)) {
  if (arg === ';') commands.push([]);
  else commands.at(-1).push(arg);
}
for (const args of commands) {
  if (args[0] === 'select-window') state.window = 'reviewer';
  if (args[0] === 'select-pane') state.pane = '1';
  if (args[0] === 'attach' || args[0] === 'attach-session')
    console.log(state.window + ':' + state.pane);
}
fs.writeFileSync(process.env.TERMINAL_ATTACH_STATE, JSON.stringify(state));
`,
  { mode: 0o700 },
);
after(() => rmSync(scratch, { recursive: true, force: true }));

const tmuxCommands: string[][] = [];
const existingSessions = new Set<string>();
mock.method(childProcess, 'execFileSync', (command: string, args: string[]) => {
  if (command === 'which' && args[0] === 'tmux') return selector;
  if (command === selector) {
    tmuxCommands.push([...args]);
    if (args[0] === 'set-option') return '';
    if (args[0] === 'has-session') {
      if (existingSessions.has(args[2]!)) return '';
      throw new Error('fixture session absent');
    }
    if (args[0] === 'new-session') {
      existingSessions.add(args[3]!);
      return '';
    }
  }
  throw new Error(`Unexpected process during PTY import: ${command}`);
});
syncBuiltinESMExports();

let spawned: { command: string; args: string[] } | undefined;
const exits: Array<() => void> = [];
mock.module('node-pty', {
  namedExports: {
    spawn: (command: string, args: string[]) => {
      spawned = { command, args };
      return {
        onData: () => ({ dispose() {} }),
        onExit: (callback: (event: { exitCode: number }) => void) => {
          exits.push(() => callback({ exitCode: 0 }));
          return { dispose() {} };
        },
      };
    },
  },
});
const { subscribePty, reinitTmuxSession } = await (async () => {
  const previousTmpdir = process.env.TMUX_TMPDIR;
  delete process.env.TMUX_TMPDIR;
  try {
    return await import('./pty-stream.js');
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previousTmpdir;
  }
})();
const importCommands = tmuxCommands.map((args) => [...args]);

test('import without a private tmux directory sends no server command', () => {
  assert.deepEqual(importCommands, []);
});

test('reinitializing an existing session leaves its server options untouched', async () => {
  existingSessions.add('existing-session');
  const before = tmuxCommands.length;
  assert.equal(await reinitTmuxSession('existing-session', '/fixture/repo'), true);
  assert.deepEqual(tmuxCommands.slice(before), [['has-session', '-t', 'existing-session']]);
});

test('creating an owned session applies tuning only after creation', async () => {
  const before = tmuxCommands.length;
  assert.equal(await reinitTmuxSession('new-owned-session', '/fixture/repo'), true);
  assert.deepEqual(tmuxCommands.slice(before), [
    ['has-session', '-t', 'new-owned-session'],
    ['new-session', '-d', '-s', 'new-owned-session', '-c', '/fixture/repo'],
    ['set-option', '-s', 'escape-time', '10'],
    ['set-option', '-t', 'new-owned-session', 'status-left-length', '30'],
  ]);
});

test('a reviewer PTY selects its window and exact pane before attaching', (t) => {
  t.after(() => exits.splice(0).forEach((exit) => exit()));
  writeFileSync(stateFile, JSON.stringify({ window: 'worker', pane: '0' }));
  subscribePty('slot:reviewer', 'proof-session', () => {}, 120, 40, {
    selectTarget: 'proof-session:reviewer.1',
  });
  assert.ok(spawned);
  assert.equal(spawned.command, 'zsh');
  assert.equal(spawned.args[0], '-lc');
  // Execute the POSIX attach script with sh so this regression also runs on Linux CI.
  const result = childProcess.spawnSync('sh', ['-c', spawned.args[1]], {
    encoding: 'utf8',
    env: { ...process.env, TERMINAL_ATTACH_STATE: stateFile },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), 'reviewer:1');
});

test('remote PTY uses the same window and pane selection in one attach command', (t) => {
  t.after(() => exits.splice(0).forEach((exit) => exit()));
  subscribePty('remote:reviewer', 'proof-session', () => {}, 120, 40, {
    selectTarget: 'proof-session:reviewer.1',
    sshTarget: 'proof-node',
  });
  assert.equal(spawned?.command, 'ssh');
  const command = spawned?.args.at(-1) ?? '';
  assert.match(command, /select-window/);
  assert.match(command, /select-pane/);
  assert.ok(command.indexOf('select-window') < command.indexOf('select-pane'));
  assert.doesNotMatch(command, /\|\|/);
});
