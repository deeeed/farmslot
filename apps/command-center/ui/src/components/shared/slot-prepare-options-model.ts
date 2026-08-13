import type { SlotHealth } from '@farmslot/protocol';

import type { PrepareProfileOption } from '../dispatch/dispatch-wizard-draft.js';

export interface SlotPrepareOptionsState {
  prepareProfile: string;
  strictProfile: boolean;
  forcePrepare: boolean;
}

export interface SlotPreparePlan {
  mode: 'bind-only' | 'checkout';
  lines: string[];
  warnings: string[];
}

export interface PrepareRecoverySuggestion {
  profile: string | null;
  label: string;
}

/** Empty prepareProfile means use project.json prepare.default (gateway resolvePrepareProfile). */
export const DEFAULT_SLOT_PREPARE_OPTIONS: SlotPrepareOptionsState = {
  prepareProfile: '',
  strictProfile: true,
  forcePrepare: false,
};

const PREFS_KEY_PREFIX = 'farmslot:slot-prepare-options:';

export function loadSlotPreparePrefs(project: string): Partial<SlotPrepareOptionsState> {
  if (!project) return {};
  try {
    const raw = localStorage.getItem(`${PREFS_KEY_PREFIX}${project}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SlotPrepareOptionsState>;
    return {
      ...(typeof parsed.prepareProfile === 'string'
        ? { prepareProfile: parsed.prepareProfile }
        : {}),
      ...(typeof parsed.strictProfile === 'boolean' ? { strictProfile: parsed.strictProfile } : {}),
      ...(typeof parsed.forcePrepare === 'boolean' ? { forcePrepare: parsed.forcePrepare } : {}),
    };
  } catch {
    return {};
  }
}

export function saveSlotPreparePrefs(project: string, state: SlotPrepareOptionsState): void {
  if (!project) return;
  try {
    localStorage.setItem(`${PREFS_KEY_PREFIX}${project}`, JSON.stringify(state));
  } catch {
    // Preference persistence is best-effort.
  }
}

export function reconcilePrepareProfile(
  profiles: readonly PrepareProfileOption[],
  current: string,
): string {
  const names = profiles.map((profile) => profile.name);
  if (names.length === 0) return current;
  if (current && names.includes(current)) return current;
  return profiles.find((profile) => profile.isDefault)?.name ?? names[0]!;
}

export function projectPrepareProfileFallback(
  configs: ReadonlyArray<{
    name: string;
    prepare?: import('@farmslot/protocol').ProjectPrepareConfig;
  }>,
  project: string,
  profileName: string,
): string | null {
  const fallback = configs.find((entry) => entry.name === project)?.prepare?.profiles?.[profileName]
    ?.fallback;
  return fallback?.trim() || null;
}

export function suggestPrepareRecovery(
  error: string,
  currentProfile: string,
  configs: ReadonlyArray<{
    name: string;
    prepare?: import('@farmslot/protocol').ProjectPrepareConfig;
  }>,
  project: string,
): PrepareRecoverySuggestion {
  const fallback = projectPrepareProfileFallback(configs, project, currentProfile);
  const preconditionFailed =
    /preconditions failed/i.test(error) || /health_ok|dev_server_up|deps_current/i.test(error);
  if (fallback && preconditionFailed && fallback !== currentProfile) {
    return {
      profile: fallback,
      label: `Retry with ${fallback}`,
    };
  }
  if (preconditionFailed && currentProfile === 'attach') {
    return {
      profile: null,
      label: 'Retry with allow fallback (strict off)',
    };
  }
  return { profile: null, label: '' };
}

function healthWarnings(
  health: SlotHealth | null | undefined,
  strictProfile: boolean,
  prepareProfile: string,
): string[] {
  if (!strictProfile || prepareProfile !== 'attach' || !health) return [];
  const warnings: string[] = [];
  const cdp = health.cdp?.trim() ?? '';
  const devserver = health.devserver?.trim().toUpperCase() ?? '';
  if (cdp && cdp !== '-' && cdp.toUpperCase() !== 'OK' && !/wallet/i.test(cdp)) {
    warnings.push(`CDP ${cdp} — strict attach may fail until health is ready`);
  }
  if (devserver === 'OFF') {
    warnings.push('Dev server off — strict attach may fail');
  }
  return warnings;
}

export function buildSlotPreparePlan(args: {
  runBranch: string | null | undefined;
  slotBranch: string | null | undefined;
  slotHealth?: SlotHealth | null;
  strictProfile: boolean;
  prepareProfile: string;
  forcePrepare: boolean;
}): SlotPreparePlan {
  const runBranch = args.runBranch?.trim() || null;
  const slotBranch = args.slotBranch?.trim() || null;
  const bindOnly =
    !args.forcePrepare && Boolean(runBranch && slotBranch && runBranch === slotBranch);
  const warnings = healthWarnings(args.slotHealth, args.strictProfile, args.prepareProfile);
  if (bindOnly) {
    warnings.push(
      'Bind only skips health/deps preconditions — run ensure-js-runtime prepare or slot check before recipe replay if Metro is cold',
    );
    return {
      mode: 'bind-only',
      lines: [`Bind run on ${slotBranch} (branch already matches)`],
      warnings,
    };
  }
  const lines = [
    runBranch && slotBranch && runBranch !== slotBranch
      ? `Checkout ${slotBranch || '(unknown)'} → ${runBranch}`
      : runBranch
        ? `Prepare on ${runBranch}`
        : 'Prepare slot',
    `Profile: ${args.prepareProfile || 'project default'}${args.strictProfile ? ' (strict)' : ' (allow fallback)'}`,
  ];
  return { mode: 'checkout', lines, warnings };
}

export function resolveBindOnly(
  runBranch: string | null | undefined,
  slotBranch: string | null | undefined,
  forcePrepare: boolean,
): boolean {
  if (forcePrepare) return false;
  const run = runBranch?.trim();
  const slot = slotBranch?.trim();
  return Boolean(run && slot && run === slot);
}
