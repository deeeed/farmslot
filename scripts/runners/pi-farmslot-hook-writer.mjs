// Writes Claude-shaped hooks.jsonl records from PI lifecycle events.
// Keep digest helpers in sync with services/gateway/src/runners/observability-prompt-digest.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function normalizeInstructionText(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([/-])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function instructionNeedle(message) {
  return normalizeInstructionText(message).slice(0, 160);
}

export function runnerPromptDigest(message) {
  return crypto.createHash('sha1').update(instructionNeedle(message)).digest('hex').slice(0, 16);
}

function loadSentinel(sentDir, digest) {
  const full = path.join(sentDir, `${digest}.json`);
  if (!fs.existsSync(full)) return null;
  const body = JSON.parse(fs.readFileSync(full, 'utf8'));
  return { digest: body.digest || digest, sentAt: body.sentAt };
}

function matchSentinelForPrompt(sentDir, promptText) {
  const needle = instructionNeedle(promptText);
  const expectedDigest = runnerPromptDigest(promptText);
  const exact = loadSentinel(sentDir, expectedDigest);
  if (exact) return exact;
  let files = [];
  try {
    files = fs.readdirSync(sentDir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(path.join(sentDir, file), 'utf8'));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (
      needle &&
      prompt &&
      (prompt === needle || needle.startsWith(prompt) || prompt.startsWith(needle))
    ) {
      return { digest: body.digest || file.replace(/\.json$/, ''), sentAt: body.sentAt };
    }
  }
  return null;
}

function rotateIfLarge(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 5 * 1024 * 1024) return;
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeSnapshot(directory, key, record) {
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, `${encodeURIComponent(key)}.json`);
  const pendingPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(pendingPath, `${JSON.stringify(record)}\n`);
  fs.renameSync(pendingPath, statePath);
}

function readSnapshot(directory, key) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(directory, `${encodeURIComponent(key)}.json`), 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {{
 *   obsDir: string,
 *   event: string,
 *   sessionId?: string | null,
 *   promptText?: string | null,
 *   toolName?: string | null,
 *   cwd?: string | null,
 *   env?: NodeJS.ProcessEnv,
 * }} params
 */
export function writePiHook(params) {
  const env = params.env ?? process.env;
  const obsDir = params.obsDir || env.FARMSLOT_OBS_DIR;
  if (!obsDir) throw new Error('FARMSLOT_OBS_DIR is required');
  fs.mkdirSync(obsDir, { recursive: true });
  const logPath = path.join(obsDir, 'hooks.jsonl');
  rotateIfLarge(logPath);
  const observedAt = Date.now();
  const event = params.event;
  let matchedDigest;
  let sentAt;
  if (event === 'UserPromptSubmit' && params.promptText) {
    const matched = matchSentinelForPrompt(path.join(obsDir, 'sent'), params.promptText);
    if (matched) {
      matchedDigest = matched.digest;
      sentAt = matched.sentAt;
    }
  }
  const sessionId = params.sessionId || undefined;
  const previousSession = sessionId ? readSnapshot(path.join(obsDir, 'sessions'), sessionId) : null;
  const tmuxPane = env.TMUX_PANE || undefined;
  const previousPane = tmuxPane ? readSnapshot(path.join(obsDir, 'panes'), tmuxPane) : null;
  const startsTurn = event === 'UserPromptSubmit';
  const resetsTurn = event === 'SessionStart';
  const stopsTurn = event === 'Stop' || event === 'StopFailure';
  const turnStartedAt = startsTurn
    ? observedAt
    : resetsTurn
      ? undefined
      : previousSession?.turnStartedAt;
  const turnActive = startsTurn
    ? true
    : resetsTurn
      ? false
      : stopsTurn
        ? false
        : typeof previousSession?.turnActive === 'boolean'
          ? previousSession.turnActive
          : undefined;
  const rootSessionId =
    event === 'SessionStart'
      ? sessionId
      : previousPane?.rootSessionId || previousPane?.session_id || sessionId;
  const record = {
    schemaVersion: 1,
    observedAt,
    timestamp: observedAt,
    hook_event_name: event,
    event,
    session_id: sessionId,
    cwd: params.cwd || undefined,
    tool_name: params.toolName || undefined,
    tmuxPane,
    slotId: env.FARMSLOT_SLOT_ID || undefined,
    runner: env.FARMSLOT_RUNNER || 'pi',
    ...(typeof turnStartedAt === 'number' ? { turnStartedAt } : {}),
    ...(typeof turnActive === 'boolean' ? { turnActive } : {}),
    ...(typeof rootSessionId === 'string' && rootSessionId ? { rootSessionId } : {}),
    ...(matchedDigest ? { runnerPromptDigest: matchedDigest } : {}),
    ...(sentAt ? { sentAt } : {}),
  };
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  if (typeof record.session_id === 'string' && record.session_id) {
    writeSnapshot(path.join(obsDir, 'sessions'), record.session_id, record);
  }
  if (typeof record.tmuxPane === 'string' && record.tmuxPane) {
    writeSnapshot(path.join(obsDir, 'panes'), record.tmuxPane, record);
  }
  return record;
}
