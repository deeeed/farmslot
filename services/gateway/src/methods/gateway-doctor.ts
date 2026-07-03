import { execFile as execFileCb } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import {
  type GatewayDoctorCheck,
  type GatewayDoctorParams,
  type GatewayDoctorResult,
  type GatewayDoctorSection,
  type GatewayDoctorSectionDefinition,
  type GatewayDoctorSectionId,
} from '@farmslot/protocol';
import { captureHelperPath } from '@farmslot/protocol/node/capture-helper-path';

import { listOrphanedBacklogQueueItems } from '../backlog/store.js';
import { getGatewayListenSnapshot, remotePairingBlockedHint } from '../core/listen-address.js';
import { getAllNodes } from '../fleet/machine-registry.js';
import { loadPoolConfigs, loadProjectConfigs } from '../fleet/state.js';

import { gatewayStatus } from './gateway-status.js';

const execFile = promisify(execFileCb);
const CHECK_TIMEOUT_MS = 5_000;

const DOCTOR_SECTION_DEFINITIONS: GatewayDoctorSectionDefinition[] = [
  {
    id: 'gateway',
    label: 'Gateway',
    description: 'Gateway version, checkout freshness, and connected node summary.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Imported projects and configured farm slots.',
  },
  {
    id: 'capture',
    label: 'Evidence capture',
    description: 'External screenshot/video capture helper readiness.',
  },
  {
    id: 'browser',
    label: 'Browser/CDP',
    description: 'Chrome/Chromium and active CDP debugging session detection.',
  },
  {
    id: 'simulator',
    label: 'iOS simulator',
    description: 'macOS Xcode simulator tooling availability.',
  },
  {
    id: 'android',
    label: 'Android',
    description: 'ADB availability and connected Android device summary.',
  },
];

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

type GatewayDoctorRunner = () => Promise<GatewayDoctorSection>;

const SECTION_RUNNERS: Record<GatewayDoctorSectionId, GatewayDoctorRunner> = {
  gateway: gatewaySection,
  workspace: workspaceSection,
  capture: captureHelperSection,
  browser: browserSection,
  simulator: simulatorSection,
  android: androidSection,
};

export async function gatewayDoctor(
  params: GatewayDoctorParams = {},
): Promise<GatewayDoctorResult> {
  const sectionIds = requestedDoctorSectionIds(params);
  if (params.run === false) return doctorResult(sectionIds, []);
  const sections = await Promise.all(sectionIds.map((sectionId) => SECTION_RUNNERS[sectionId]()));
  return doctorResult(sectionIds, sections);
}

function requestedDoctorSectionIds(params: GatewayDoctorParams): GatewayDoctorSectionId[] {
  if (params.sectionId && params.sectionIds?.length) {
    throw new Error('gateway.doctor accepts sectionId or sectionIds, not both');
  }
  const requested = params.sectionId
    ? [params.sectionId]
    : params.sectionIds && params.sectionIds.length > 0
      ? params.sectionIds
      : DOCTOR_SECTION_DEFINITIONS.map((section) => section.id);
  const requestedSet = new Set(requested.map(assertDoctorSectionId));
  return DOCTOR_SECTION_DEFINITIONS.map((section) => section.id).filter((sectionId) =>
    requestedSet.has(sectionId),
  );
}

function assertDoctorSectionId(sectionId: string): GatewayDoctorSectionId {
  if (sectionId in SECTION_RUNNERS) return sectionId as GatewayDoctorSectionId;
  throw new Error(`Unknown gateway.doctor sectionId: ${sectionId}`);
}

function doctorResult(
  requestedSectionIds: GatewayDoctorSectionId[],
  sections: GatewayDoctorSection[],
): GatewayDoctorResult {
  const checks = sections.flatMap((section) => section.checks);
  return {
    generatedAt: new Date().toISOString(),
    availableSections: DOCTOR_SECTION_DEFINITIONS,
    requestedSectionIds,
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
  const listen = status.listen ?? getGatewayListenSnapshot();
  if (listen) {
    checks.push({
      id: 'gateway-listen',
      label: 'Companion LAN pairing',
      ok: listen.remotePairingAllowed,
      warn: !listen.remotePairingAllowed,
      detail: listen.remotePairingAllowed
        ? `listening on ${listen.host}:${listen.port} (remote devices can connect)`
        : remotePairingBlockedHint(listen.host, listen.port),
      hint: listen.remotePairingAllowed
        ? undefined
        : 'Restart with GATEWAY_HOST=0.0.0.0 (yarn farmdev when .env.local-auth is present) or run farmslot up.',
    });
  }
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
  const localMachine = os.hostname().replace(/\.local$/, '');
  const localNodeUp = nodes.some((n) => n.machine === localMachine);
  const remoteCount = nodes.filter((n) => n.machine !== localMachine).length;
  checks.push({
    id: 'nodes',
    label: 'Nodes',
    ok: true,
    // The local node is what powers live monitoring (branch/file/screen/resource watches)
    // for local slots and the machine's fleet presence — warn when it is absent (degraded).
    warn: !localNodeUp,
    detail: localNodeUp
      ? `local node connected${remoteCount > 0 ? ` (+${remoteCount} remote)` : ''}`
      : nodes.length === 0
        ? 'no node connected — monitoring degraded (slots still run)'
        : `local node not connected (${remoteCount} remote) — local monitoring degraded`,
    hint: localNodeUp
      ? undefined
      : 'Live branch/file/screen/resource watches are off until a node connects. `farmslot up` co-launches the local node; remote machines: bash scripts/deploy-node.sh <machine>.',
  });
  const orphanedQueueItems = listOrphanedBacklogQueueItems();
  checks.push({
    id: 'queue-orphans',
    label: 'Dispatch queue integrity',
    ok: orphanedQueueItems.length === 0,
    detail:
      orphanedQueueItems.length === 0
        ? 'no orphaned backlog-linked queue items'
        : `${orphanedQueueItems.length} queued item(s) reference missing backlog records`,
    hint:
      orphanedQueueItems.length > 0
        ? 'Remove orphaned items from Upcoming Work on #runs or restore .backlog.json before re-enqueueing.'
        : undefined,
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
  const helper = captureHelperPath();
  const command = await runCommand(helper, ['doctor', '--json']);
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
          ? `${helper} doctor passed`
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
  } catch {
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
