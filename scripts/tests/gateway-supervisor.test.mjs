import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { supervise } from '../gateway-supervisor.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const children = [];
  const signals = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: 900000 + children.length });
    children.push({ command, args, options, child });
    return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => signals.push({ pid, signal }));
  t.mock.method(console, 'error', () => {});
  const done = supervise('yarn', ['workspace', '@farmslot/gateway', 'start']);
  return { children, signals, done };
}

test('aborts restart with capped backoff and clean exit stops supervision', async (t) => {
  const f = fixture(t);
  assert.equal(f.children[0].options.detached, true);
  assert.equal(f.children[0].options.stdio, 'inherit');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = f.children.length;
    f.children.at(-1).child.emit('exit', 134, null);
    t.mock.timers.tick(delay - 1);
    assert.equal(f.children.length, count);
    t.mock.timers.tick(1);
    assert.equal(f.children.length, count + 1);
  }
  f.children.at(-1).child.emit('exit', 0, null);
  assert.equal(await f.done, 0);
  t.mock.timers.tick(60000);
  assert.equal(f.children.length, 8);
});

test('intentional stack shutdown signals the process group and never restarts it', async (t) => {
  const f = fixture(t);
  process.emit('SIGTERM');
  assert.deepEqual(f.signals[0], { pid: -900000, signal: 'SIGTERM' });
  t.mock.timers.tick(5000);
  assert(f.signals.some(({ signal }) => signal === 'SIGKILL'));
  f.children[0].child.emit('exit', null, 'SIGKILL');
  assert.equal(await f.done, 143);
  t.mock.timers.tick(60000);
  assert.equal(f.children.length, 1);
});

test('shutdown during backoff cancels restart', async (t) => {
  const f = fixture(t);
  f.children[0].child.emit('exit', 1, null);
  process.emit('SIGINT');
  assert.equal(await f.done, 130);
  t.mock.timers.tick(60000);
  assert.equal(f.children.length, 1);
});

test('spawn failure stops visibly', async (t) => {
  const second = fixture(t);
  second.children[0].child.emit('error', new Error('spawn ENOENT'));
  assert.equal(await second.done, 1);
});
