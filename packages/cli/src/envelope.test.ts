import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { commandPathOf, errorEnvelope, okEnvelope } from './envelope.js';
import { GatewayRpcError } from './gateway-client.js';

test('okEnvelope wraps data with schema, command, and zero exit code', () => {
  assert.deepEqual(okEnvelope('fleet.status', { fleet: [] }), {
    schemaVersion: 1,
    command: 'fleet.status',
    status: 'ok',
    exitCode: 0,
    data: { fleet: [] },
  });
});

test('errorEnvelope preserves gateway code, userAction, and details', () => {
  const err = new GatewayRpcError(
    'Slot not found',
    'SLOT_NOT_FOUND',
    'Run `farmslot fleet refresh`.',
    {
      availableSlotIds: ['macwork-ff-1'],
    },
  );
  const envelope = errorEnvelope('slot.prepare', err);
  assert.equal(envelope.status, 'error');
  assert.equal(envelope.exitCode, 1);
  assert.equal(envelope.error?.code, 'SLOT_NOT_FOUND');
  assert.equal(envelope.error?.userAction, 'Run `farmslot fleet refresh`.');
  assert.deepEqual(envelope.error?.details, { availableSlotIds: ['macwork-ff-1'] });
});

test('errorEnvelope always supplies a userAction, even for plain errors', () => {
  const envelope = errorEnvelope('runs.list', new Error('boom'));
  assert.equal(envelope.error?.code, 'CLI_ERROR');
  assert.ok(envelope.error?.userAction && envelope.error.userAction.length > 0);

  const connErr = new Error('Connection failed — is the gateway running?');
  connErr.name = 'GatewayConnectionError';
  const connEnvelope = errorEnvelope('fleet.status', connErr);
  assert.match(connEnvelope.error?.userAction ?? '', /farmslot up|--url|farmslot doctor/u);
});

test('commandPathOf derives dotted paths and drops the program root', () => {
  const program = new Command('farmslot');
  const slot = program.command('slot');
  const prepare = slot.command('prepare');
  assert.equal(commandPathOf(prepare), 'slot.prepare');
  assert.equal(commandPathOf(slot), 'slot');
});

function spawnCli(args: string[], home: string) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = path.resolve(packageDir, '../..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = path.join(packageDir, 'src', 'entry.ts');
  return spawnSync(tsxBin, [entry, ...args], {
    cwd: packageDir,
    env: { ...process.env, FARMSLOT_HOME: home },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

test('machine-mode gateway failure emits one envelope on stdout with userAction and exits non-zero', () => {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = path.resolve(packageDir, '../..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = path.join(packageDir, 'src', 'entry.ts');
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-envelope-'));
  try {
    // Port 1 always refuses — deterministic connection failure without a gateway.
    const result = spawnSync(
      tsxBin,
      [entry, '--url', 'ws://127.0.0.1:1', '--timeout', '3000', 'fleet', 'status', '--json'],
      {
        cwd: packageDir,
        env: { ...process.env, FARMSLOT_HOME: home },
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.command, 'fleet.status');
    assert.equal(envelope.status, 'error');
    assert.equal(envelope.exitCode, 1);
    assert.ok(envelope.error.userAction.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-TTY stdout implies machine mode without --json', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-envelope-tty-'));
  try {
    const result = spawnCli(
      ['--url', 'ws://127.0.0.1:1', '--timeout', '3000', 'fleet', 'status'],
      home,
    );
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.status, 'error');
    assert.ok(envelope.error.userAction.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('commander usage errors emit a USAGE_ERROR envelope in machine mode', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-envelope-usage-'));
  try {
    // slot prepare requires an argumentless id? use a subcommand with required arg missing: slot action run needs args
    const result = spawnCli(['slot', 'action', 'run', '--json'], home);
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, 'error');
    assert.equal(envelope.error.code, 'USAGE_ERROR');
    assert.match(envelope.error.userAction, /--help/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('wired command validation errors emit envelopes with fallback userAction', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-envelope-validate-'));
  try {
    const result = spawnCli(['runs', 'export', '--json'], home);
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, 'error');
    assert.ok(envelope.error.userAction.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('usage-error command derivation ignores positionals', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-envelope-positional-'));
  try {
    const result = spawnCli(['slot', 'check', 'some-slot-id', '--bogus-flag', '--json'], home);
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.command, 'slot.check');
    assert.match(envelope.error.userAction, /farmslot slot check --help/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
