import { execFile as execFileCb } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type {
  GatewayDoctorCheck,
  GatewayDoctorResult,
  GatewayDoctorSection,
} from '@farmslot/protocol';

import { getAllNodes } from '../fleet/machine-registry.js';
import { loadPoolConfigs, loadProjectConfigs } from '../fleet/state.js';

import { gatewayStatus } from './gateway-status.js';

const execFile = promisify(execFileCb);
const CHECK_TIMEOUT_MS = 5_000;

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function gatewayDoctor(): Promise<GatewayDoctorResult> {
  const [gateway, workspace, capture, browser, simulator, android] = await Promise.all([
    gatewaySection(),
    workspaceSection(),
    captureHelperSection(),
    browserSection(),
    simulatorSection(),
    androidSection(),
  ]);
  const sections = [gateway, workspace, capture, browser, simulator, android];
  const checks = sections.flatMap((section) => section.checks);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      ok: checks.filter((check) => check.ok && !check.warn).length,
      warn: checks.filter((check) => check.ok && check.warn).length,
      fail: checks.filter((check) => !check.ok).length,
    },
    sections,
  };
}

async function gatewaySection(): Promise<GatewayDoctorSection> {
  const checks: GatewayDoctorCheck[] = [];
  const status = await gatewayStatus();
  checks.push({
    id: 'gateway-version',
    label: 'Gateway',
    ok: true,
    detail: `version ${status.version}`,
  });
  checks.push({
    id: 'gateway-update',
    label: 'Farmslot checkout',
    ok: !status.update.error,
    warn: status.update.updateAvailable,
    detail: status.update.error
      ? status.update.error
      : status.update.updateAvailable
        ? `${status.update.commitsBehind} commit(s) behind origin/${status.update.branch}`
        : `up to date at ${status.update.localSha || 'unknown sha'}`,
    hint: status.update.updateAvailable ? status.update.updateCommand : undefined,
  });
  const nodes = getAllNodes();
  checks.push({
    id: 'nodes',
    label: 'Nodes',
    ok: true,
    warn: nodes.length === 0,
    detail: nodes.length === 0 ? 'no remote nodes connected' : `${nodes.length} node(s) connected`,
    hint: nodes.length === 0 ? 'Remote nodes are optional for a local-only farm.' : undefined,
  });
  return { id: 'gateway', label: 'Gateway', checks };
}

async function workspaceSection(): Promise<GatewayDoctorSection> {
  const [projects, pools] = await Promise.all([loadProjectConfigs(), loadPoolConfigs()]);
  const slots = pools.flatMap((pool) => pool.slots.map((slot) => ({ pool, slot })));
  return {
    id: 'workspace',
    label: 'Workspace',
    checks: [
      {
        id: 'projects',
        label: 'Projects',
        ok: projects.length > 0,
        detail:
          projects.length > 0 ? `${projects.length} project(s) imported` : 'no projects imported',
        hint: projects.length === 0 ? 'Run `farmslot project add <pack> --no-setup`.' : undefined,
      },
      {
        id: 'slots',
        label: 'Slots',
        ok: slots.length > 0,
        detail: slots.length > 0 ? `${slots.length} slot(s) configured` : 'no slots configured',
        hint:
          slots.length === 0
            ? 'Run `farmslot project add <pack> --slots 3 --no-setup`.'
            : undefined,
      },
    ],
  };
}

async function captureHelperSection(): Promise<GatewayDoctorSection> {
  const command = await runCommand('capture-helper', ['doctor', '--json']);
  const ok = command.ok && captureDoctorPassed(command.stdout);
  return {
    id: 'capture',
    label: 'Evidence capture',
    checks: [
      {
        id: 'capture-helper',
        label: 'capture-helper',
        ok,
        detail: ok
          ? 'capture-helper doctor passed'
          : command.stderr || command.stdout || 'capture-helper doctor failed',
        hint: ok
          ? undefined
          : 'Install the external capture-helper package and run `capture-helper doctor --open-permissions`.',
      },
    ],
  };
}

async function browserSection(): Promise<GatewayDoctorSection> {
  const chrome = await runShell(
    'command -v google-chrome || command -v chromium || test -d "/Applications/Google Chrome.app" || test -d "/Applications/Chromium.app"',
  );
  const cdp = await runShell('pgrep -fl "remote-debugging-port" | head -1');
  return {
    id: 'browser',
    label: 'Browser/CDP',
    checks: [
      {
        id: 'chromium',
        label: 'Chromium browser',
        ok: chrome.ok,
        detail: chrome.ok ? 'Chrome/Chromium available' : 'Chrome/Chromium not found',
        hint: chrome.ok ? undefined : 'Install Google Chrome or Chromium for CDP validation.',
      },
      {
        id: 'cdp',
        label: 'CDP session',
        ok: true,
        warn: !cdp.ok,
        detail: cdp.ok
          ? cdp.stdout.trim()
          : 'no browser currently running with remote-debugging-port',
        hint: cdp.ok
          ? undefined
          : 'Farmslot can launch CDP Chrome when a browser slot/demo starts.',
      },
    ],
  };
}

async function simulatorSection(): Promise<GatewayDoctorSection> {
  const mac = os.platform() === 'darwin';
  const simctl = mac ? await runCommand('xcrun', ['simctl', 'list', 'devices', '-j']) : null;
  return {
    id: 'simulator',
    label: 'iOS simulator',
    checks: [
      {
        id: 'simctl',
        label: 'simctl',
        ok: !mac || Boolean(simctl?.ok),
        warn: !mac,
        detail: !mac
          ? 'not macOS; iOS simulator unavailable'
          : simctl?.ok
            ? 'simctl available'
            : simctl?.stderr || 'simctl failed',
        hint: mac && !simctl?.ok ? 'Install Xcode and run `xcode-select --install`.' : undefined,
      },
    ],
  };
}

async function androidSection(): Promise<GatewayDoctorSection> {
  const adb = await runCommand('adb', ['devices']);
  return {
    id: 'android',
    label: 'Android',
    checks: [
      {
        id: 'adb',
        label: 'ADB',
        ok: adb.ok,
        warn:
          adb.ok &&
          !adb.stdout
            .split('\n')
            .slice(1)
            .some((line) => line.trim().endsWith('\tdevice')),
        detail: adb.ok ? adbSummary(adb.stdout) : adb.stderr || 'adb not found',
        hint: adb.ok ? undefined : 'Install Android platform-tools and ensure `adb` is on PATH.',
      },
    ],
  };
}

async function runShell(script: string): Promise<CommandResult> {
  return runCommand('bash', ['-lc', script]);
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFile(command, args, {
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

function captureDoctorPassed(stdout: string): boolean {
  if (!stdout.trim()) return false;
  try {
    const parsed = JSON.parse(stdout) as { checks?: Array<{ ok?: boolean; required?: boolean }> };
    return (parsed.checks ?? []).every((check) => check.ok || check.required === false);
  } catch (error) {
    // Older or broken capture-helper builds can print non-JSON; treat that as a failed doctor check.
    return false;
  }
}

function adbSummary(stdout: string): string {
  const devices = stdout
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().endsWith('\tdevice')).length;
  return devices > 0
    ? `${devices} Android device(s) connected`
    : 'adb available; no Android devices connected';
}
