// pty-stream.ts — Spawn node-pty with `tmux attach`, multicast data to subscribers

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import * as pty from 'node-pty';

import { shellQuote } from '../core/tmux.js';

const execFileAsync = promisify(execFile);

export type PtyDataHandler = (data: string) => void;
export type PtyExitHandler = (key: string, exitCode: number) => void;

interface PtySession {
  ptyProcess: pty.IPty;
  session: string;
  attachSession: string;
  handlers: Set<PtyDataHandler>;
  id: number; // monotonic ID for debug tracing
}

const ptySessions = new Map<string, PtySession>();
const exitHandlers = new Set<PtyExitHandler>();
let nextPtyId = 0;

// Pending detaches — defer SIGHUP so a quick resubscribe (HMR, prop change,
// secondary <terminal-view> mount) can reuse the live ssh+tmux client instead
// of paying ~1-2s to respawn it. Cancelled by subscribePty when it sees a
// session still in the map.
const PTY_DETACH_LINGER_MS = 8000;
const pendingDetaches = new Map<string, NodeJS.Timeout>();

const require = createRequire(import.meta.url);

function ensureNodePtySpawnHelpersExecutable(): void {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('node-pty/package.json');
  } catch (err) {
    console.warn(`[pty] failed to resolve node-pty package path: ${(err as Error).message}`);
    return;
  }

  const prebuildsDir = path.join(path.dirname(packageJsonPath), 'prebuilds');
  let platforms: string[];
  try {
    platforms = fs.readdirSync(prebuildsDir);
  } catch (err) {
    console.warn(`[pty] failed to inspect node-pty prebuilds: ${(err as Error).message}`);
    return;
  }

  for (const platform of platforms) {
    const helperPath = path.join(prebuildsDir, platform, 'spawn-helper');
    if (!fs.existsSync(helperPath)) continue;

    try {
      const mode = fs.statSync(helperPath).mode;
      if ((mode & 0o111) === 0o111) continue;
      fs.chmodSync(helperPath, mode | 0o755);
      console.warn(`[pty] repaired executable bit on ${helperPath}`);
    } catch (err) {
      console.warn(
        `[pty] failed to repair node-pty spawn-helper ${helperPath}: ${(err as Error).message}`,
      );
    }
  }
}

ensureNodePtySpawnHelpersExecutable();

// Resolve tmux absolute path once at load time
let tmuxPath = 'tmux';
try {
  tmuxPath = execFileSync('which', ['tmux'], { encoding: 'utf-8' }).trim();
} catch (err) {
  // `tmux` may still be available through the shell even when `which` fails in
  // the gateway environment, so keep the bare command name as the fallback.
  console.warn(
    `[pty] failed to resolve tmux path with which; using PATH fallback: ${(err as Error).message}`,
  );
}

// Set escape-time 10 at startup — escape-time 0 causes tmux to send init sequences
// byte-by-byte, which xterm.js can't parse (renders as garbled first line).
try {
  execFileSync(tmuxPath, ['set-option', '-s', 'escape-time', '10']);
  execFileSync(tmuxPath, ['set-option', '-g', 'status-left-length', '30']);
  console.log('[pty] set tmux escape-time=10 status-left-length=30');
} catch (err) {
  // The tmux server may not be running yet; applyTmuxAttachOptions reapplies
  // these cosmetic options when a session is created or attached.
  console.warn(
    `[pty] deferred tmux startup options until session attach: ${(err as Error).message}`,
  );
}

async function applyTmuxAttachOptions(session: string, sshTarget?: string): Promise<void> {
  try {
    if (sshTarget) {
      await runRemoteShell(
        sshTarget,
        [
          'tmux set-option -s escape-time 10 >/dev/null 2>&1',
          `tmux set-option -t ${shellQuote(session)} status-left-length 30 >/dev/null 2>&1`,
        ].join('; '),
      );
      return;
    }
    execFileSync(tmuxPath, ['set-option', '-s', 'escape-time', '10'], { stdio: 'ignore' });
    execFileSync(tmuxPath, ['set-option', '-t', session, 'status-left-length', '30'], {
      stdio: 'ignore',
    });
  } catch (err) {
    console.warn(
      `[pty] failed to apply tmux attach options session=${session}: ${(err as Error).message}`,
    );
  }
}

async function runRemoteShell(sshTarget: string, script: string): Promise<void> {
  // execFile (async) instead of execFileSync to avoid blocking the gateway
  // event loop on every PTY attach/reinit (each subscribe round-trips at least
  // two SSH invocations to the slot).
  await execFileAsync('ssh', [
    '-o',
    'ConnectTimeout=5',
    sshTarget,
    `zsh -lc ${shellQuote(script)}`,
  ]);
}

async function remoteSessionExists(sshTarget: string, session: string): Promise<boolean> {
  try {
    await runRemoteShell(sshTarget, `tmux has-session -t ${shellQuote(session)} 2>/dev/null`);
    return true;
  } catch (err) {
    // Logged unconditionally so an unexpected SSH/tmux failure surfaces in
    // operator logs instead of being hidden behind a debug gate. The caller
    // creates the session on `false`, so the warning is the only signal that
    // distinguishes "no session yet" from "ssh broken / wrong host".
    const stderr = (err as { stderr?: string | Buffer }).stderr?.toString().trim();
    const detail = stderr || (err as Error).message;
    console.warn(
      `[pty] tmux session ${session} not found on ${sshTarget} (will create): ${detail}`,
    );
    return false;
  }
}

function localTmuxSessionExists(session: string): boolean {
  try {
    execFileSync(tmuxPath, ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // Logged unconditionally — failures here surface either "no session yet"
    // (caller creates it) or a real tmux/exec problem (operator needs to see
    // it). Hiding behind a debug gate masks the second case.
    console.warn(
      `[pty] tmux session ${session} not found locally (will create): ${(err as Error).message}`,
    );
    return false;
  }
}

function log(action: string, key: string, detail?: string) {
  const parts = [`[pty] ${action} key=${key}`];
  if (detail) parts.push(detail);
  const ps = ptySessions.get(key);
  if (ps) parts.push(`ptyId=${ps.id} handlers=${ps.handlers.size} pid=${ps.ptyProcess.pid}`);
  console.log(parts.join(' '));
}

export function onPtyExit(handler: PtyExitHandler): () => void {
  exitHandlers.add(handler);
  return () => {
    exitHandlers.delete(handler);
  };
}

export interface PtyAttachOptions {
  sshTarget?: string; // e.g. "deeeed@mini.local" — if set, PTY goes through SSH
  selectTarget?: string; // optional window/pane target to activate after attaching to the session
}

export function subscribePty(
  key: string,
  session: string,
  handler: PtyDataHandler,
  cols?: number,
  rows?: number,
  opts?: PtyAttachOptions,
): void {
  let ps = ptySessions.get(key);
  const lingering = pendingDetaches.get(key);
  if (lingering) {
    clearTimeout(lingering);
    pendingDetaches.delete(key);
    log('linger-cancel', key, 'reusing live pty');
  }
  if (!ps) {
    ps = attachPty(key, session, cols, rows, opts);
  }
  ps.handlers.add(handler);
  log(
    'subscribe',
    key,
    `session=${session} cols=${cols} rows=${rows} ssh=${opts?.sshTarget || 'local'}`,
  );
}

export function unsubscribePty(key: string, handler: PtyDataHandler): void {
  const ps = ptySessions.get(key);
  if (!ps) {
    log('unsubscribe-noop', key, 'no pty session in map');
    return;
  }
  ps.handlers.delete(handler);
  log('unsubscribe', key);
  if (ps.handlers.size === 0) {
    scheduleDetach(key);
  }
}

export function unsubscribeAllPty(handler: PtyDataHandler): void {
  for (const [key, ps] of ptySessions) {
    ps.handlers.delete(handler);
    if (ps.handlers.size === 0) {
      scheduleDetach(key);
    }
  }
}

function scheduleDetach(key: string): void {
  const existing = pendingDetaches.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingDetaches.delete(key);
    const ps = ptySessions.get(key);
    if (!ps || ps.handlers.size > 0) return;
    log('linger-expired', key, 'detaching');
    detachPty(key);
  }, PTY_DETACH_LINGER_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingDetaches.set(key, timer);
  log('linger-scheduled', key, `ms=${PTY_DETACH_LINGER_MS}`);
}

export function writePty(key: string, data: string): void {
  const ps = ptySessions.get(key);
  if (!ps) throw new Error(`No PTY session for key ${key}`);
  ps.ptyProcess.write(data);
}

export function resizePty(key: string, cols: number, rows: number): void {
  const ps = ptySessions.get(key);
  if (!ps) return;
  log('resize', key, `cols=${cols} rows=${rows}`);
  ps.ptyProcess.resize(cols, rows);
}

export function hasPty(key: string): boolean {
  return ptySessions.has(key);
}

// Recreate a tmux session for a slot and return true if successful.
// Async: SSH round-trips run via execFile (non-blocking) so the gateway event
// loop is not stalled per subscribe.
export async function reinitTmuxSession(
  session: string,
  repoDir?: string,
  sshTarget?: string,
): Promise<boolean> {
  try {
    if (sshTarget) {
      if (await remoteSessionExists(sshTarget, session)) {
        await applyTmuxAttachOptions(session, sshTarget);
        log('reinit', session, `session already exists (remote ${sshTarget})`);
        return true;
      }

      const startDir = repoDir || '/tmp';
      await runRemoteShell(
        sshTarget,
        `tmux new-session -d -s ${shellQuote(session)} -c ${shellQuote(startDir)}`,
      );
      await applyTmuxAttachOptions(session, sshTarget);
      log('reinit', session, `created new session on ${sshTarget} startDir=${startDir}`);
      return true;
    }

    // Local
    if (localTmuxSessionExists(session)) {
      await applyTmuxAttachOptions(session);
      log('reinit', session, 'session already exists');
      return true;
    }

    const startDir = repoDir || process.env.HOME || '/tmp';
    execFileSync(tmuxPath, ['new-session', '-d', '-s', session, '-c', startDir]);
    await applyTmuxAttachOptions(session);
    log('reinit', session, `created new session startDir=${startDir}`);
    return true;
  } catch (err) {
    console.error(`[pty] reinit failed session=${session}:`, err);
    return false;
  }
}

function attachPty(
  key: string,
  session: string,
  cols?: number,
  rows?: number,
  opts?: PtyAttachOptions,
): PtySession {
  const id = ++nextPtyId;
  const c = cols || 120;
  const r = rows || 40;
  const sshTarget = opts?.sshTarget;
  const selectTarget =
    opts?.selectTarget && opts.selectTarget !== session ? opts.selectTarget : undefined;
  const attachSession = session;

  // Local: spawn tmux attach directly
  // Remote: spawn ssh -t <host> tmux attach — full PTY through SSH tunnel
  let cmd: string;
  let args: string[];
  if (sshTarget) {
    cmd = 'ssh';
    const selectCommand = selectTarget
      ? `tmux select-pane -t ${shellQuote(selectTarget)} || tmux select-window -t ${shellQuote(selectTarget)}; `
      : '';
    const remoteScript = `${selectCommand}tmux attach-session -t ${shellQuote(attachSession)}`;
    args = ['-t', '-o', 'ConnectTimeout=5', sshTarget, `zsh -lc ${shellQuote(remoteScript)}`];
    log(
      'attach',
      key,
      `ptyId=${id} session=${attachSession} select=${selectTarget ?? '-'} cols=${c} rows=${r} ssh=${sshTarget}`,
    );
  } else {
    if (selectTarget) {
      cmd = 'zsh';
      args = [
        '-lc',
        `${shellQuote(tmuxPath)} select-pane -t ${shellQuote(selectTarget)} || ${shellQuote(tmuxPath)} select-window -t ${shellQuote(selectTarget)}; exec ${shellQuote(tmuxPath)} attach-session -t ${shellQuote(attachSession)}`,
      ];
    } else {
      cmd = tmuxPath;
      args = ['attach-session', '-t', attachSession];
    }
    log(
      'attach',
      key,
      `ptyId=${id} session=${attachSession} select=${selectTarget ?? '-'} cols=${c} rows=${r} tmux=${tmuxPath}`,
    );
  }

  // Spawn 1 col narrower — the browser's first resize will set the real size,
  // which forces tmux to do a full redraw. Without this size difference, tmux
  // skips the redraw on same-size SIGWINCH and the terminal stays blank.
  const ptyProcess = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: Math.max(1, c - 1),
    rows: r,
    env: process.env as Record<string, string>,
  });

  const ps: PtySession = {
    ptyProcess,
    session,
    attachSession,
    handlers: new Set(),
    id,
  };

  ptyProcess.onData((data: string) => {
    for (const handler of ps.handlers) {
      try {
        handler(data);
      } catch (err) {
        console.warn(`[pty] subscriber handler failed key=${key}: ${(err as Error).message}`);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Only clean up map entry if we're still the active PTY for this slot.
    // A newer PTY may have replaced us in the map already.
    const current = ptySessions.get(key);
    if (current === ps) {
      ptySessions.delete(key);
      console.log(`[pty] exit key=${key} ptyId=${id} code=${exitCode} (removed from map)`);
      // Notify all exit handlers
      for (const handler of exitHandlers) {
        try {
          handler(key, exitCode);
        } catch (err) {
          console.warn(`[pty] exit handler failed key=${key}: ${(err as Error).message}`);
        }
      }
    } else {
      console.log(
        `[pty] exit key=${key} ptyId=${id} code=${exitCode} (stale, map has ptyId=${current?.id ?? 'none'})`,
      );
    }
  });

  ptySessions.set(key, ps);
  return ps;
}

function detachPty(key: string): void {
  const ps = ptySessions.get(key);
  if (!ps) return;
  log('detach', key);
  ptySessions.delete(key);
  // Clear handlers so the dying PTY doesn't send data while SIGHUP propagates
  ps.handlers.clear();
  // SIGHUP cleanly detaches the tmux client
  try {
    process.kill(ps.ptyProcess.pid, 'SIGHUP');
  } catch (err) {
    console.warn(`[pty] failed to signal pty key=${key}: ${(err as Error).message}`);
  }
}
