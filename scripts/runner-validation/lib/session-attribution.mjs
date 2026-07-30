import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventName } from './hooks.mjs';

export const RUNNER_SESSION_DISPATCH_SLACK_MS = 60_000;

export const ATTRIBUTION_MODELS = {
  claude: 'opus',
  codex: 'gpt-5.4',
  grok: 'grok-4.5',
};

export const STALE_MODELS = {
  claude: 'claude-haiku-4-5',
  codex: 'gpt-5.3',
  grok: 'grok-2-1212',
};

export function claudeProjectDir(repo) {
  return path.join(os.homedir(), '.claude', 'projects', repo.replace(/\//g, '-'));
}

export function grokRepoKey(repo) {
  try {
    return fs.realpathSync.native(repo);
  } catch {
    return path.resolve(repo);
  }
}

export function repoPathMatches(sessionPath, repo) {
  if (!sessionPath || typeof sessionPath !== 'string') return false;
  const repoKey = grokRepoKey(repo);
  try {
    return fs.realpathSync.native(sessionPath) === repoKey;
  } catch {
    return sessionPath === repo || sessionPath === repoKey;
  }
}

export function grokCwdMatches(summaryCwd, repo) {
  return repoPathMatches(summaryCwd, repo);
}

export function grokSessionDirKeys(repo) {
  return [...new Set([encodeURIComponent(repo), encodeURIComponent(grokRepoKey(repo))])];
}

export function grokSessionsDir(repo) {
  return path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(grokRepoKey(repo)));
}

export function codexSessionsRoot(repo, runtimeDir) {
  const slotHome = path.join(repo, runtimeDir, 'codex-home', 'sessions');
  if (fs.existsSync(slotHome)) return slotHome;
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function modelsMatch(dispatched, actual) {
  if (!dispatched || !actual) return true;
  const d = dispatched.toLowerCase();
  const a = actual.toLowerCase();
  if (d === a) return true;
  if (a.includes(d)) return true;
  const aliases = {
    sonnet: 'claude-sonnet',
    opus: 'claude-opus',
    haiku: 'claude-haiku',
  };
  const prefix = aliases[d];
  return prefix ? a.startsWith(prefix) : false;
}

export function chooseRunnerSessionPath({
  candidates,
  mtimeMsByPath,
  beforePaths = [],
  sinceMs,
  existingPath,
}) {
  const before = new Set(beforePaths);
  const eligible = candidates.filter((candidate) => {
    const mtimeMs = mtimeMsByPath.get(candidate);
    if (mtimeMs === undefined) return false;
    if (sinceMs !== undefined && mtimeMs < sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS) return false;
    return true;
  });
  const fresh = eligible.filter((candidate) => !before.has(candidate));
  if (existingPath && eligible.includes(existingPath)) return existingPath;
  if (fresh[0]) return fresh[0];
  return eligible[0] ?? null;
}

export function statMtimeMs(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return null;
  }
}

export function loadMtimes(paths) {
  const map = new Map();
  for (const candidate of paths) {
    const mtimeMs = statMtimeMs(candidate);
    if (mtimeMs !== null) map.set(candidate, mtimeMs);
  }
  return map;
}

export function runnerSessionIdForPath(sessionPath) {
  const base = path.basename(sessionPath);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

export function findSessionStartBinding(rows, { paneId, slotId, sinceMs }) {
  let best = null;
  for (const row of rows) {
    if (eventName(row) !== 'SessionStart') continue;
    const observedAt = row.observedAt ?? row.timestamp;
    if (
      sinceMs !== undefined &&
      typeof observedAt === 'number' &&
      observedAt < sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS
    ) {
      continue;
    }
    if (paneId && row.tmuxPane && row.tmuxPane !== paneId) continue;
    if (slotId && row.slotId && row.slotId !== slotId) continue;
    const transcriptPath =
      typeof row.transcript_path === 'string' && row.transcript_path.trim()
        ? row.transcript_path.trim()
        : null;
    if (!transcriptPath) continue;
    const sessionId =
      typeof row.session_id === 'string' && row.session_id.trim() ? row.session_id.trim() : null;
    if (!best || (typeof observedAt === 'number' && observedAt >= (best.observedAt ?? 0))) {
      best = { sessionId, transcriptPath, observedAt, tmuxPane: row.tmuxPane ?? null };
    }
  }
  return best;
}

export function listSessionCandidates(runner, repo, runtimeDir = '.agent') {
  if (runner === 'claude') {
    const sessionDir = claudeProjectDir(repo);
    if (!fs.existsSync(sessionDir)) return [];
    return fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(sessionDir, name))
      .sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  }
  if (runner === 'grok') {
    const paths = [];
    for (const key of grokSessionDirKeys(repo)) {
      const sessionsDir = path.join(os.homedir(), '.grok', 'sessions', key);
      if (!fs.existsSync(sessionsDir)) continue;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const entry of fs.readdirSync(sessionsDir)) {
        const summaryPath = path.join(sessionsDir, entry, 'summary.json');
        if (!fs.existsSync(summaryPath)) continue;
        if (statMtimeMs(summaryPath) < cutoff) continue;
        try {
          const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
          if (grokCwdMatches(summary?.info?.cwd, repo)) paths.push(path.dirname(summaryPath));
        } catch {
          // Grok may write summary.json incrementally during launch.
        }
      }
    }
    return paths.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  }
  if (runner === 'codex') {
    const sessionsRoot = codexSessionsRoot(repo, runtimeDir);
    if (!fs.existsSync(sessionsRoot)) return [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const paths = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.jsonl')) continue;
        if (statMtimeMs(full) < cutoff) continue;
        try {
          const first = JSON.parse(fs.readFileSync(full, 'utf8').split('\n')[0]);
          if (first?.type === 'session_meta' && repoPathMatches(first?.payload?.cwd, repo))
            paths.push(full);
        } catch {
          // Codex-owned session files may be partial during discovery.
        }
        if (paths.length >= 200) return;
      }
    };
    walk(sessionsRoot);
    return paths.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  }
  return [];
}

function touchOld(targetPath, ageMs = 30 * 24 * 60 * 60 * 1000) {
  const staleTime = new Date(Date.now() - ageMs);
  fs.utimesSync(targetPath, staleTime, staleTime);
}

export function seedStaleSession(runner, repo, runtimeDir = '.agent') {
  if (runner === 'claude') {
    const sessionDir = claudeProjectDir(repo);
    fs.mkdirSync(sessionDir, { recursive: true });
    const stalePath = path.join(sessionDir, '00000000-0000-4000-8000-runner-stale.jsonl');
    fs.writeFileSync(
      stalePath,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: STALE_MODELS.claude,
          role: 'assistant',
          content: [{ type: 'text', text: 'stale session' }],
        },
      })}\n`,
    );
    touchOld(stalePath);
    return stalePath;
  }
  if (runner === 'codex') {
    const sessionsRoot = codexSessionsRoot(repo, runtimeDir);
    const staleDir = path.join(sessionsRoot, 'runner-stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const stalePath = path.join(staleDir, 'session.jsonl');
    fs.writeFileSync(
      stalePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { cwd: repo, model: STALE_MODELS.codex },
      })}\n`,
    );
    touchOld(stalePath);
    return stalePath;
  }
  if (runner === 'grok') {
    const sessionsDir = grokSessionsDir(repo);
    const staleDir = path.join(sessionsDir, 'runner-stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const summaryPath = path.join(staleDir, 'summary.json');
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        info: { id: 'runner-stale', cwd: repo },
        current_model_id: STALE_MODELS.grok,
      }),
    );
    touchOld(summaryPath);
    return staleDir;
  }
  return null;
}

/** First model id in transcript — attribution only; tokens use session-usage.sh */
export function modelFromTranscript(runner, sessionPath) {
  if (runner === 'claude') {
    for (const line of fs.readFileSync(sessionPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.model) return obj.message.model;
      } catch {
        // partial jsonl while runner writes
      }
    }
    return null;
  }
  if (runner === 'codex') {
    for (const line of fs.readFileSync(sessionPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session_meta') {
          return obj.payload?.model ?? obj.payload?.model_slug ?? null;
        }
        if (obj.type === 'turn_context') return obj.payload?.model ?? null;
      } catch {
        // partial jsonl while runner writes
      }
    }
    return null;
  }
  if (runner === 'grok') {
    const summaryPath = path.join(sessionPath, 'summary.json');
    if (!fs.existsSync(summaryPath)) return null;
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      return summary.current_model_id ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveSessionBinding({
  runner,
  repo,
  runtimeDir,
  beforePaths,
  sinceMs,
  hookRows,
  paneId,
  slotId,
}) {
  if (runner === 'claude' || runner === 'codex') {
    const hookBinding = findSessionStartBinding(hookRows, { paneId, slotId, sinceMs });
    if (hookBinding?.transcriptPath && fs.existsSync(hookBinding.transcriptPath)) {
      return {
        runnerSessionPath: hookBinding.transcriptPath,
        runnerSessionId:
          hookBinding.sessionId ?? runnerSessionIdForPath(hookBinding.transcriptPath),
        source: 'hook',
        hookBinding,
      };
    }
  }
  const candidates = listSessionCandidates(runner, repo, runtimeDir);
  const chosen = chooseRunnerSessionPath({
    candidates,
    mtimeMsByPath: loadMtimes(candidates),
    beforePaths,
    sinceMs,
  });
  if (!chosen) return null;
  return {
    runnerSessionPath: chosen,
    runnerSessionId: runnerSessionIdForPath(chosen),
    source: 'filesystem',
    hookBinding: null,
  };
}

export function selfTestChooseRunnerSessionPath() {
  const dispatchMs = Date.parse('2026-06-30T19:58:40.642Z');
  const stale = '/home/.claude/projects/repo/stale.jsonl';
  const fresh = '/home/.claude/projects/repo/fresh.jsonl';
  const chosen = chooseRunnerSessionPath({
    candidates: [stale, fresh],
    mtimeMsByPath: new Map([
      [stale, dispatchMs - 24 * 60 * 60 * 1000],
      [fresh, dispatchMs + 5_000],
    ]),
    beforePaths: [stale, fresh],
    sinceMs: dispatchMs,
  });
  if (chosen !== fresh) {
    throw new Error(`expected fresh session, got ${chosen}`);
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  selfTestChooseRunnerSessionPath();
  console.log('session-attribution self-test ok');
}
