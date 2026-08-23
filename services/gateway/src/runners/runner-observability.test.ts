import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildClaudeObservabilityFallbackCommand,
  buildRunnerObservabilityInstallCommand,
  INSTALLER_RELATIVE_PATH,
  RUNNER_OBSERVABILITY_SUPPORT_PATHS,
  withRunnerObservabilityInstall,
} from './runner-observability.js';

test('remote observability install prefers the prepared immutable node-support bundle', () => {
  const command = buildRunnerObservabilityInstallCommand(
    {
      // A hostname no farm machine ever has: locality is decided against the
      // EXECUTING machine's os.hostname(), so naming a real host (mini) makes
      // the expected remote command disappear when the test runs on that host.
      host: 'remote-fixture-host.local',
      machine: 'remote-fixture-host',
      remoteRepo: '/Volumes/FD/farm/farmslot-1',
      slotId: 'remote-fixture-host-ff-1',
    } as never,
    'claude',
    '/Volumes/FD/farm/farmslot-1',
    '.sandbox/farmslot-farm/agent',
  );

  assert.match(command, /node-support-hash/);
  assert.match(
    command,
    /farmslot-node\/support\/\$\{support_hash\}\/scripts\/install-runner-observability\.mjs/,
  );
  assert.match(command, /farmslot-node\/scripts\/install-runner-observability\.mjs/);
  assert.match(command, /scripts\/lib\/provider-accounts\.mjs/);
});

const farmslotRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function relativeImportClosure(entryPath: string): string[] {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const relativePath = pending.pop()!;
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const source = readFileSync(path.join(farmslotRoot, relativePath), 'utf8');
    const specifiers = [
      ...source.matchAll(/\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ].map(([, specifier]) => specifier!);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const dependencyPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativePath), specifier),
      );
      assert.equal(dependencyPath.startsWith('../'), false);
      pending.push(dependencyPath);
    }
  }
  return [...visited].sort();
}

test('immutable observability support covers the installer relative-import closure', () => {
  assert.deepEqual(
    [...RUNNER_OBSERVABILITY_SUPPORT_PATHS].sort(),
    relativeImportClosure(INSTALLER_RELATIVE_PATH),
  );
});

test('remote observability install falls back when an immutable bundle is incomplete', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-observability-support-'));
  try {
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const runtimeDir = '.agent';
    const supportHash = 'a'.repeat(64);
    const supportRoot = path.join(home, 'farmslot-node', 'support', supportHash);
    const fallbackInstaller = path.join(home, 'farmslot-node', INSTALLER_RELATIVE_PATH);
    const immutableInstaller = path.join(supportRoot, INSTALLER_RELATIVE_PATH);
    const selectedPath = path.join(root, 'selected-installer');
    const fakeBin = path.join(root, 'bin');
    const fakeNode = path.join(fakeBin, 'node');

    mkdirSync(path.dirname(fallbackInstaller), { recursive: true });
    mkdirSync(path.dirname(immutableInstaller), { recursive: true });
    mkdirSync(path.join(repo, runtimeDir, '.observability'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fallbackInstaller, 'fallback\n');
    writeFileSync(immutableInstaller, 'immutable\n');
    writeFileSync(
      path.join(repo, runtimeDir, '.observability', 'node-support-hash'),
      `${supportHash}\n`,
    );
    writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$1" > "$SELECTED_INSTALLER"\n', {
      mode: 0o755,
    });

    const command = buildRunnerObservabilityInstallCommand(
      {
        host: 'remote-fixture-host.local',
        machine: 'remote-fixture-host',
        remoteRepo: repo,
        slotId: 'remote-fixture-host-slot-1',
      } as never,
      'claude',
      repo,
      runtimeDir,
    );
    const run = () =>
      execFileSync('/bin/bash', ['-c', command], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          SELECTED_INSTALLER: selectedPath,
        },
      });

    run();
    assert.equal(readFileSync(selectedPath, 'utf8').trim(), fallbackInstaller);

    mkdirSync(path.join(supportRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(path.join(supportRoot, 'scripts/lib/provider-accounts.mjs'), 'dependency\n');
    writeFileSync(path.join(supportRoot, 'scripts/lib/toml-scan.mjs'), 'dependency\n');
    run();
    assert.equal(readFileSync(selectedPath, 'utf8').trim(), immutableInstaller);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude observability fallback replaces corrupt runtime settings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, '{ invalid json', 'utf8');

    execFileSync('/bin/bash', ['-c', buildClaudeObservabilityFallbackCommand(settingsPath)]);

    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude observability fallback preserves valid runtime settings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const settings = '{"hooks":{"Stop":[{"hooks":[]}]}}\n';
    writeFileSync(settingsPath, settings, 'utf8');

    execFileSync('/bin/bash', ['-c', buildClaudeObservabilityFallbackCommand(settingsPath)]);

    assert.equal(readFileSync(settingsPath, 'utf8'), settings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful stale installer still materializes the required Claude settings artifact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    const launchedPath = path.join(root, 'launched');
    const command = withRunnerObservabilityInstall(
      `printf launched > '${launchedPath}'`,
      ':',
      buildClaudeObservabilityFallbackCommand(settingsPath),
    );

    execFileSync('/bin/bash', ['-c', command]);

    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
    assert.equal(readFileSync(launchedPath, 'utf8'), 'launched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
