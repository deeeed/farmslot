import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, type FSWatcher, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { NodeTmuxPane, NodeTmuxPaneSignals } from '@farmslot/protocol';

const execFileAsync = promisify(execFile);
const TMUX_INVENTORY_CACHE_MS = 3_000;
const GIT_BRANCH_CACHE_MS = 10_000;

interface PaneCacheEntry {
  signature: string;
  lastChangedAt: number;
}

let paneInventoryCache: { observedAt: number; panes: NodeTmuxPane[] } | null = null;
const paneChangeCache = new Map<string, PaneCacheEntry>();
const gitBranchCache = new Map<string, { observedAt: number; branch?: string }>();
const gitBranchWatchers = new Map<string, FSWatcher[]>();

// Resolve tmux binary — launchd agents have a minimal PATH that may not include /opt/homebrew/bin
const TMUX = (() => {
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    return execFileSync('which', ['tmux'], { timeout: 2000 }).toString().trim();
  } catch {
    /* legacy fallback: older node methods treat missing tmux as empty state */
  }
  return 'tmux'; // fallback
})();

export async function capture(session: string, lines = 200): Promise<string[]> {
  try {
    const args = ['capture-pane', '-t', session, '-p', '-S', `-${lines}`];
    const { stdout } = await execFileAsync(TMUX, args, { timeout: 5000 });
    return stdout.split('\n');
  } catch {
    return [];
  }
}

export async function send(session: string, text: string, enter = true): Promise<void> {
  const args = ['send-keys', '-t', session, text];
  if (enter) args.push('Enter');
  await execFileAsync(TMUX, args, { timeout: 5000 });
}

export async function resizePane(target: string, cols: number, rows: number): Promise<void> {
  await execFileAsync(TMUX, ['resize-pane', '-t', target, '-x', String(cols), '-y', String(rows)], {
    timeout: 5000,
  });
}

export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(TMUX, ['list-sessions', '-F', '#{session_name}'], {
      timeout: 5000,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function readOptionalText(
  filePath: string,
  maxBytes = 64 * 1024,
): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    const content = await readFile(filePath, 'utf8');
    return content.slice(Math.max(0, content.length - Math.min(maxBytes, fileStat.size)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Optional observability/task files are expected to be absent for plain shell panes
    // and can disappear between stat/read while workers rotate files.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return undefined;
  }
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function observedAtFromValue(value: unknown): number | undefined {
  const numberValue = numberField(value);
  if (numberValue == null) return undefined;
  return numberValue < 10_000_000_000 ? Math.round(numberValue * 1000) : numberValue;
}

function parseLastHookEvent(text: string | undefined): NodeTmuxPaneSignals['hook'] | undefined {
  if (!text) return undefined;
  for (const line of text.split('\n').reverse()) {
    const parsed = parseJsonObject(line.trim());
    if (!parsed) continue;
    const event = stringField(parsed.hook_event_name) ?? stringField(parsed.event);
    return {
      ...(event ? { event, label: `hook ${event}` } : { label: 'hook event' }),
      ...(observedAtFromValue(parsed.observed_at ?? parsed.observedAt ?? parsed.timestamp) != null
        ? {
            observedAt: observedAtFromValue(
              parsed.observed_at ?? parsed.observedAt ?? parsed.timestamp,
            ),
          }
        : {}),
    };
  }
  return undefined;
}

export async function readPaneSignals(
  cwd: string | undefined,
): Promise<NodeTmuxPaneSignals | undefined> {
  if (!cwd) return undefined;
  const [statuslineRaw, signalRaw, hooksRaw] = await Promise.all([
    readOptionalText(path.join(cwd, '.observability', 'statusline.json')),
    readOptionalText(path.join(cwd, 'SIGNAL.json')),
    readOptionalText(path.join(cwd, '.observability', 'hooks.jsonl')),
  ]);
  const statusline = parseJsonObject(statuslineRaw);
  const signal = parseJsonObject(signalRaw);
  const parsed: NodeTmuxPaneSignals = {};
  const hook = parseLastHookEvent(hooksRaw);
  if (hook) parsed.hook = hook;
  if (statusline) {
    const ctxPct = numberField(statusline.ctxPct ?? statusline.contextPct);
    const model = stringField(statusline.model);
    const busy = typeof statusline.busy === 'boolean' ? statusline.busy : undefined;
    parsed.statusline = {
      label:
        [
          busy === true ? 'busy' : busy === false ? 'idle' : undefined,
          model,
          ctxPct != null ? `ctx ${ctxPct}%` : undefined,
        ]
          .filter(Boolean)
          .join(' · ') || 'statusline',
      ...(observedAtFromValue(statusline.mtime ?? statusline.observedAt ?? statusline.timestamp) !=
      null
        ? {
            observedAt: observedAtFromValue(
              statusline.mtime ?? statusline.observedAt ?? statusline.timestamp,
            ),
          }
        : {}),
      ...(busy != null ? { busy } : {}),
      ...(model ? { model } : {}),
      ...(ctxPct != null ? { ctxPct } : {}),
    };
  }
  if (signal) {
    const status = stringField(signal.status);
    const phase = stringField(signal.phase);
    parsed.taskFile = {
      label: [phase, status].filter(Boolean).join(' · ') || 'task signal',
      ...(observedAtFromValue(signal.timestamp ?? signal.observedAt) != null
        ? { observedAt: observedAtFromValue(signal.timestamp ?? signal.observedAt) }
        : {}),
      ...(status ? { status } : {}),
      ...(phase ? { phase } : {}),
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

// Use a printable sentinel instead of a C0 control character. The launchd-hosted
// node path has observed tmux replacing the previous unit-separator delimiter
// with underscores before stdout reached the parser, which collapsed each pane
// into a malformed session name. A long printable sentinel survives tmux,
// launchd, JSON transport, and shell diagnostics unchanged.
export const PANE_FIELD_SEPARATOR = '<<<FARMSLOT_TMUX_FIELD>>>';
export const PANE_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_index}',
  '#{pane_id}',
  '#{pane_active}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_title}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{pane_pid}',
].join(PANE_FIELD_SEPARATOR);

function paneStableKey(pane: NodeTmuxPane): string {
  return pane.paneId || `${pane.session}:${pane.window}.${pane.pane}`;
}

function paneSignature(pane: NodeTmuxPane): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        session: pane.session,
        window: pane.window,
        windowName: pane.windowName,
        pane: pane.pane,
        title: pane.title,
        cwd: pane.cwd,
        command: pane.command,
        pid: pane.pid,
        branch: pane.branch,
        hook: pane.signals?.hook,
        statusline: pane.signals?.statusline,
        taskFile: pane.signals?.taskFile,
      }),
    )
    .digest('hex');
}

function attachPaneChangeMetadata(panes: NodeTmuxPane[], observedAt: number): NodeTmuxPane[] {
  const seenKeys = new Set<string>();
  const enriched = panes.map((pane) => {
    const key = paneStableKey(pane);
    seenKeys.add(key);
    const signature = paneSignature(pane);
    const previous = paneChangeCache.get(key);
    const lastChangedAt = previous?.signature === signature ? previous.lastChangedAt : observedAt;
    paneChangeCache.set(key, { signature, lastChangedAt });
    return { ...pane, observedAt, lastChangedAt };
  });
  for (const key of paneChangeCache.keys()) {
    if (!seenKeys.has(key)) paneChangeCache.delete(key);
  }
  return enriched;
}

async function resolveGitBranch(
  cwd: string | undefined,
  observedAt: number,
): Promise<string | undefined> {
  if (!cwd) return undefined;
  const cached = gitBranchCache.get(cwd);
  if (cached && observedAt - cached.observedAt <= GIT_BRANCH_CACHE_MS) return cached.branch;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      { timeout: 1000 },
    );
    const branch = stdout.trim() || undefined;
    gitBranchCache.set(cwd, { observedAt, branch });
    await ensureGitBranchWatch(cwd);
    return branch;
  } catch {
    // Detached HEADs or non-git directories are expected for arbitrary tmux panes.
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
        timeout: 1000,
      });
      const branch = stdout.trim() || undefined;
      gitBranchCache.set(cwd, { observedAt, branch });
      await ensureGitBranchWatch(cwd);
      return branch;
    } catch {
      // Plain shell panes often run outside a git worktree; cache the miss briefly.
      gitBranchCache.set(cwd, { observedAt, branch: undefined });
      return undefined;
    }
  }
}

function invalidateGitBranchCache(cwd: string): void {
  gitBranchCache.delete(cwd);
  paneInventoryCache = null;
}

function watchGitBranchTarget(cwd: string, targetPath: string, watchers: FSWatcher[]): void {
  try {
    watchers.push(
      watch(targetPath, { persistent: false }, () => {
        invalidateGitBranchCache(cwd);
      }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Git refs can be packed or absent for detached/non-standard worktrees. The TTL cache
    // remains the fallback, so watcher setup failure should not hide the pane.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
}

async function resolveGitDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], {
      timeout: 1000,
    });
    return stdout.trim() || undefined;
  } catch {
    // Non-git panes are expected in the all-tmux inventory; they just have no branch watcher.
    return undefined;
  }
}

async function ensureGitBranchWatch(cwd: string): Promise<void> {
  if (gitBranchWatchers.has(cwd)) return;
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) {
    gitBranchWatchers.set(cwd, []);
    return;
  }

  const watchers: FSWatcher[] = [];
  watchGitBranchTarget(cwd, path.join(gitDir, 'HEAD'), watchers);
  watchGitBranchTarget(cwd, path.join(gitDir, 'refs', 'heads'), watchers);
  gitBranchWatchers.set(cwd, watchers);
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTmuxPaneList(stdout: string): NodeTmuxPane[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.split(PANE_FIELD_SEPARATOR);
      if (fields.length < 12) {
        throw new Error(
          `tmux list-panes returned malformed row: expected 12 fields, got ${fields.length}`,
        );
      }
      const [
        session,
        window,
        windowName,
        pane,
        paneId,
        active,
        width,
        height,
        title,
        cwd,
        command,
        pid,
      ] = fields;
      const target = paneId || `${session}:${window}.${pane}`;
      return {
        session,
        window,
        ...(windowName ? { windowName } : {}),
        pane,
        ...(paneId ? { paneId } : {}),
        target,
        active: active === '1',
        ...(parseOptionalInteger(width) != null ? { width: parseOptionalInteger(width) } : {}),
        ...(parseOptionalInteger(height) != null ? { height: parseOptionalInteger(height) } : {}),
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(command ? { command } : {}),
        ...(parseOptionalInteger(pid) != null ? { pid: parseOptionalInteger(pid) } : {}),
      };
    });
}

async function samplePanes(): Promise<NodeTmuxPane[]> {
  const observedAt = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(TMUX, ['list-panes', '-a', '-F', PANE_FORMAT], {
      timeout: 5000,
    }));
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr
        : '';
    // tmux exits non-zero when the machine simply has no tmux server. For worker
    // inventory that means "no workers", not a degraded node.
    if (stderr.includes('no server running')) return [];
    throw error;
  }
  const panes = parseTmuxPaneList(stdout);
  const signalCache = new Map<string, Promise<NodeTmuxPaneSignals | undefined>>();
  const enriched = await Promise.all(
    panes.map(async (pane) => {
      const [signals, branch] = await Promise.all([
        pane.cwd
          ? (signalCache.get(pane.cwd) ??
            signalCache.set(pane.cwd, readPaneSignals(pane.cwd)).get(pane.cwd)!)
          : undefined,
        resolveGitBranch(pane.cwd, observedAt),
      ]);
      return {
        ...pane,
        ...(branch ? { branch } : {}),
        ...(signals ? { signals } : {}),
      };
    }),
  );
  return attachPaneChangeMetadata(enriched, observedAt);
}

export async function listPanes(): Promise<NodeTmuxPane[]> {
  const now = Date.now();
  if (paneInventoryCache && now - paneInventoryCache.observedAt <= TMUX_INVENTORY_CACHE_MS) {
    return paneInventoryCache.panes;
  }
  const panes = await samplePanes();
  paneInventoryCache = { observedAt: now, panes };
  return panes;
}
