// Locate executable adb and idb clients, cache their paths, and export them to
// child processes through RECIPE_RN_ADB_PATH / RECIPE_RN_IDB_PATH.
import { accessSync, constants as fsConstants, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MobileTool = 'adb' | 'idb';

export interface MobileToolPaths {
  adb: string | null;
  idb: string | null;
}

const TOOL_ENV: Record<MobileTool, string> = {
  adb: 'RECIPE_RN_ADB_PATH',
  idb: 'RECIPE_RN_IDB_PATH',
};

const TOOL_RECOVERY: Record<MobileTool, string> = {
  adb: 'brew install android-platform-tools',
  idb: 'brew install idb-companion pipx python@3.13 && pipx install fb-idb --python python3.13',
};

const resolvedPaths = new Map<MobileTool, string>();

export function mobileToolRecovery(tool: MobileTool): string {
  assertTool(tool);
  return TOOL_RECOVERY[tool];
}

export function mobileToolEnvName(tool: MobileTool): string {
  assertTool(tool);
  return TOOL_ENV[tool];
}

export function resolveMobileToolPath(
  tool: MobileTool,
  { required = false }: { required?: boolean } = {},
): string | null {
  assertTool(tool);
  const cached = resolvedPaths.get(tool);
  if (cached && executablePath(cached)) return cached;

  for (const candidate of candidatesFor(tool)) {
    const resolved = executablePath(candidate);
    if (!resolved) continue;
    resolvedPaths.set(tool, resolved);
    process.env[TOOL_ENV[tool]] = resolved;
    return resolved;
  }

  resolvedPaths.delete(tool);
  if (!required) return null;
  const label = tool === 'adb' ? 'Android SDK Platform-Tools (adb)' : 'Facebook idb client';
  throw new Error(
    `${label} is required but no executable was found.\n  Next: ${TOOL_RECOVERY[tool]}`,
  );
}

export function resolveAndExportMobileToolPaths(platform?: string): MobileToolPaths {
  if (platform === 'android') {
    return { adb: resolveMobileToolPath('adb', { required: true }), idb: null };
  }
  if (platform === 'ios') {
    return { adb: null, idb: resolveMobileToolPath('idb') };
  }
  return {
    adb: resolveMobileToolPath('adb'),
    idb: resolveMobileToolPath('idb'),
  };
}

export function clearMobileToolPathCache(): void {
  resolvedPaths.clear();
}

function candidatesFor(tool: MobileTool): string[] {
  const override = process.env[TOOL_ENV[tool]];
  const pathCandidates = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, tool));
  const candidates = override ? [override] : [];
  candidates.push(...pathCandidates);
  if (tool === 'adb') {
    for (const root of [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(os.homedir(), 'Library/Android/sdk'),
      path.join(os.homedir(), 'Android/Sdk'),
    ]) {
      if (root) candidates.push(path.join(root, 'platform-tools', 'adb'));
    }
  } else {
    if (process.env.IDB_PATH) candidates.push(process.env.IDB_PATH);
    candidates.push(
      '/opt/homebrew/bin/idb',
      '/usr/local/bin/idb',
      path.join(os.homedir(), '.local/bin/idb'),
    );
    candidates.push(...pythonUserCandidates());
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

// Filesystem errors that only mean "this candidate is not there or not usable".
const UNUSABLE_CANDIDATE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

function isUnusableCandidate(error: unknown): boolean {
  return UNUSABLE_CANDIDATE_CODES.has(String((error as NodeJS.ErrnoException)?.code));
}

function pythonUserCandidates(): string[] {
  const root = path.join(os.homedir(), 'Library/Python');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'bin/idb'));
  } catch (error) {
    // No readable ~/Library/Python (Linux, or no pip --user installs): no candidates here.
    if (isUnusableCandidate(error)) return [];
    throw error;
  }
}

// A candidate that does not exist, dangles, or is not executable is simply not a
// match; the caller tries the next one.
function executablePath(candidate: string): string | null {
  try {
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    if (!stat.isFile()) return null;
    accessSync(resolved, fsConstants.X_OK);
    return path.resolve(resolved);
  } catch (error) {
    if (isUnusableCandidate(error)) return null;
    throw error;
  }
}

function assertTool(tool: string): asserts tool is MobileTool {
  if (tool !== 'adb' && tool !== 'idb') {
    throw new Error(`Unsupported mobile device tool: ${String(tool)}.`);
  }
}
