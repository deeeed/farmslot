import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyClaudeInterruptionProbe,
  buildClaudeInterruptionProbeCommand,
  parseClaudeInterruptionProbe,
} from '../../../../services/gateway/src/runners/claude-observability.ts';
import {
  buildCodexPromptProbeCommand,
  buildCodexSessionBindingProbeCommand,
  buildCodexTurnStateProbeCommand,
  parseCodexPromptProbe,
  parseCodexSessionBindingProbe,
  parseCodexTurnStateProbe,
} from '../../../../services/gateway/src/runners/codex-observability.ts';
import {
  deriveRunnerActivity,
  deriveRunnerSessionDeliveryState,
  hookEventName,
  observedAtFromRecord,
  parseHookJsonl,
  promptAcceptedFromHooks,
} from '../../../../services/gateway/src/runners/observability-files.ts';
import {
  instructionNeedle,
  normalizeInstructionText,
  runnerPromptDigest,
} from '../../../../services/gateway/src/runners/observability-prompt-digest.ts';
import {
  buildRunnerOpenFileProbeCommand,
  parseOpenFilePaths,
} from '../../../../services/gateway/src/runners/process-open-files.ts';
import { getRunnerObservability } from '../../../../services/gateway/src/runners/registry.ts';
import {
  runnerPaneHasBufferedInstruction,
  runnerPaneHasQueuedInstruction,
} from '../../../../services/gateway/src/runners/runner-pane-input.ts';

// Native logs grow past the largest string a process can hold, so they are read in ranges.
const READ_LIMIT_BYTES = 64 * 1024 * 1024;
// Unresolved questions block the turn and acceptance follows the send: both are recent.
const RECENT_NATIVE_BYTES = 8 * 1024 * 1024;
const SESSION_HEADER_BYTES = 1024 * 1024;

// Reads `length` bytes from `start`; a negative start counts back from the end of the file.
export function readOptional(file, start = 0, length = Infinity) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = start < 0 ? Math.max(0, size + start) : start;
    if (from > size) return '';
    const bytes = Math.min(size - from, length);
    if (bytes > READ_LIMIT_BYTES)
      throw new Error(`${file} needs a ${bytes}-byte read; native logs are read in bounded ranges`);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, from);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const readRecent = (file) => readOptional(file, -RECENT_NATIVE_BYTES);
// Proof follows the send, so it is among the records written just after the send offset.
const recordsSinceSend = (sessionPath, receipt) =>
  parseHookJsonl(
    Number.isSafeInteger(receipt.session_offset)
      ? readOptional(sessionPath, receipt.session_offset, RECENT_NATIVE_BYTES)
      : readRecent(sessionPath),
  );

export function sessionSize(sessionPath) {
  try {
    return sessionPath ? fs.statSync(sessionPath).size : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const supportsMidTurnPrompt = (runner) =>
  getRunnerObservability(runner)?.supportsMidTurnPrompt === true;

// Codex renders its pending steering queue. Claude proves queued input only in its transcript.
const rendersSteeringQueue = (runner) => runner === 'codex' && supportsMidTurnPrompt(runner);

export const requiresNativeSession = (runner) =>
  supportsMidTurnPrompt(runner) && !rendersSteeringQueue(runner);

export const hasSubmittedQueue = (runner, tail) =>
  rendersSteeringQueue(runner) && runnerPaneHasQueuedInstruction(tail);

export const paneIdentity = (meta) =>
  JSON.stringify([meta.pane_pid, meta.process_started_at, meta.runner_pids]);

// Claude writes input sent during a turn to its transcript: usually an enqueue at once, then the
// queued_command attachment when its next step takes it in. Under load the enqueue can also wait
// for that step (12 s on one worker). Only Claude's transcript proves a queue: Codex steering
// proved from its history is delivered turn input and stays `submitted`.
export const queuedInTranscript = (runner, proof) =>
  requiresNativeSession(runner) &&
  (proof?.source === 'native-queue' || proof?.source === 'native-steering');

/** A millisecond setting from the environment: unset takes the default; empty is invalid. */
function envMilliseconds(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 2147483647)
    throw new Error(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer in milliseconds`,
    );
  return value;
}

export const queueProofTimeoutMs = () =>
  envMilliseconds('TMUX_MODEL_DRIVER_QUEUE_PROOF_MS', 20000, { allowZero: true });

export const nativeProbeTimeoutMs = () =>
  envMilliseconds('TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS', 10000);

// Probes embed the payload; stdin carries any size, while one argument is capped by the OS.
function runProbe(command, parse) {
  return parse(
    execFileSync('bash', ['-s'], {
      input: command,
      encoding: 'utf8',
      timeout: nativeProbeTimeoutMs(),
    }),
  );
}

export function hookSnapshot(meta, runner, obsDir) {
  const snapshot = parseHookJsonl(
    readOptional(path.join(obsDir, 'panes', `${encodeURIComponent(meta.pane_id)}.json`)),
  )[0];
  // Pane ids can be reused after a crash. An old Stop must never make a new runner ready.
  if (
    !snapshot ||
    snapshot.tmuxPane !== meta.pane_id ||
    snapshot.runner !== runner ||
    observedAtFromRecord(snapshot) < meta.process_started_at
  )
    return null;
  const sessionId = snapshot.rootSessionId || snapshot.session_id;
  if (!sessionId || snapshot.session_id !== sessionId) return null;
  const hooks = parseHookJsonl(readRecent(path.join(obsDir, 'hooks.jsonl'))).filter(
    (record) =>
      record.tmuxPane === meta.pane_id &&
      record.runner === runner &&
      record.session_id === sessionId &&
      observedAtFromRecord(record) >= meta.process_started_at,
  );
  const turn = deriveRunnerSessionDeliveryState(snapshot, sessionId);
  const activity = deriveRunnerActivity(hooks, null);
  return { snapshot, hooks, sessionId, sessionPath: snapshot.transcript_path, turn, activity };
}

function unansweredQuestion(hooks, transcriptPath) {
  // Hook payloads omit tool_input. Recover the actual questions from the native transcript.
  let pending = null;
  for (const record of hooks) {
    if (hookEventName(record) === 'PreToolUse' && record.tool_name === 'AskUserQuestion')
      pending = record;
    if (
      ['Stop', 'StopFailure'].includes(hookEventName(record)) ||
      (['PostToolUse', 'PostToolUseFailure'].includes(hookEventName(record)) &&
        record.tool_name === 'AskUserQuestion')
    )
      pending = null;
  }
  if (!pending) return null;
  const records = transcriptPath ? parseHookJsonl(readRecent(transcriptPath)) : [];
  const tools = records
    .flatMap((record) => record.message?.content || [])
    .filter((item) => item?.type === 'tool_use' && item.name === 'AskUserQuestion');
  return {
    source: 'hook',
    tool: 'AskUserQuestion',
    questions: tools.at(-1)?.input?.questions || [],
    observed_at: observedAtFromRecord(pending),
  };
}

export function transcriptQuestion(transcriptPath) {
  if (!transcriptPath) return null;
  const unresolved = new Map();
  for (const record of parseHookJsonl(readRecent(transcriptPath))) {
    const items =
      record.type === 'response_item' ? [record.payload] : record.message?.content || [];
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'tool_result' || item.type === 'function_call_output')
        unresolved.delete(item.tool_use_id || item.call_id);
      if (
        (item.type === 'tool_use' || item.type === 'function_call') &&
        ['AskUserQuestion', 'request_user_input', 'functions.request_user_input'].includes(
          item.name,
        )
      ) {
        const input = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.input;
        unresolved.set(item.id || item.call_id, {
          source: 'native-session',
          tool: item.name,
          questions: input?.questions || [],
        });
      }
    }
  }
  return [...unresolved.values()].at(-1) || null;
}

const claudeTranscripts = new Map();

function claudeTranscript(root, sessionId) {
  const key = path.join(root, sessionId);
  if (!claudeTranscripts.has(key)) {
    const projects = path.join(root, 'projects');
    // A session resumed from another directory leaves a stale copy behind. The live one is newest.
    const [latest] = (fs.existsSync(projects) ? fs.readdirSync(projects) : [])
      .map((name) => path.join(projects, name, `${sessionId}.jsonl`))
      .flatMap((file) => {
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        return stat ? [{ file, modified: stat.mtimeMs }] : [];
      })
      .sort((a, b) => b.modified - a.modified);
    if (!latest) return null;
    claudeTranscripts.set(key, latest.file);
  }
  return claudeTranscripts.get(key);
}

// Claude Code registers each interactive process with its current session and turn status.
function claudeProcessSession(meta) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const pid of meta.runner_pids || []) {
    const record = parseHookJsonl(readOptional(path.join(root, 'sessions', `${pid}.json`)))[0];
    // A reused pid keeps an older record until the new process registers itself.
    if (String(record?.pid) !== String(pid) || !(record.startedAt >= meta.process_started_at))
      continue;
    if (!record.sessionId) return null;
    return {
      sessionId: record.sessionId,
      // A fresh session writes its transcript with the first prompt.
      sessionPath: claudeTranscript(root, record.sessionId),
      hooks: [],
      snapshot: {},
      processBound: true,
      status: record.status,
      observedAt: record.statusUpdatedAt || null,
    };
  }
  return null;
}

function sessionBinding(meta, runner, obsDir) {
  const bound = hookSnapshot(meta, runner, obsDir);
  if (bound) return bound;
  if (runner === 'claude') return claudeProcessSession(meta);
  if (runner !== 'codex') return null;
  const paths = new Set();
  for (const pid of meta.runner_pids || []) {
    for (const file of runProbe(buildRunnerOpenFileProbeCommand(pid), parseOpenFilePaths)) {
      if (/\/rollout-[^/]+\.jsonl$/.test(file)) paths.add(file);
    }
  }
  if (!paths.size) return null;
  const binding = runProbe(
    buildCodexSessionBindingProbeCommand([...paths], undefined, true),
    parseCodexSessionBindingProbe,
  );
  return binding.status === 'matched'
    ? {
        sessionId: binding.sessionId,
        sessionPath: binding.sessionPath,
        hooks: [],
        snapshot: {},
        processBound: true,
      }
    : null;
}

export function nativeState(meta, runner, obsDir) {
  const bound = sessionBinding(meta, runner, obsDir);
  if (!bound)
    return {
      phase: 'unknown',
      source: 'unknown',
      session_id: null,
      turn_token: null,
      question: null,
    };
  let phase =
    bound.turn?.value === 'active'
      ? 'busy'
      : bound.turn?.value === 'idle'
        ? 'idle'
        : bound.activity?.value === 'idle'
          ? 'idle'
          : 'unknown';
  let turnToken = bound.turn?.turnToken || null;
  let source = 'hook';
  let observedAt = observedAtFromRecord(bound.snapshot);
  if (runner === 'codex' && bound.sessionPath) {
    const probe = runProbe(
      buildCodexTurnStateProbeCommand(bound.sessionId, bound.sessionPath),
      parseCodexTurnStateProbe,
    );
    if (probe.status === 'matched') {
      phase = probe.state === 'active' ? 'busy' : 'idle';
      turnToken = probe.turnId;
      source =
        bound.processBound && process.env.TMUX_MODEL_DRIVER_READ_ONLY === '1'
          ? 'native-session-read-only'
          : 'native-session';
      observedAt = probe.observedAt;
    }
  }
  if (runner === 'claude' && bound.processBound) {
    phase = bound.status === 'busy' ? 'busy' : bound.status === 'idle' ? 'idle' : 'unknown';
    source =
      process.env.TMUX_MODEL_DRIVER_READ_ONLY === '1'
        ? 'native-session-read-only'
        : 'native-session';
    observedAt = bound.observedAt;
  } else if (runner === 'claude') {
    const command = buildClaudeInterruptionProbeCommand(bound.snapshot, bound.sessionId);
    if (command) {
      const turn = applyClaudeInterruptionProbe(
        bound.snapshot,
        bound.sessionId,
        runProbe(command, parseClaudeInterruptionProbe),
      );
      if (turn?.value === 'idle') {
        phase = 'idle';
        source = 'native-session';
        turnToken = turn.turnToken || null;
        observedAt = turn.observedAt;
      }
    }
  }
  const question =
    transcriptQuestion(bound.sessionPath) || unansweredQuestion(bound.hooks, bound.sessionPath);
  return {
    phase,
    source,
    session_id: bound.sessionId,
    session_path: bound.sessionPath,
    turn_token: turnToken,
    observed_at: observedAt,
    question,
  };
}

export function writeSentinel(obsDir, payload, sentAt) {
  const digest = runnerPromptDigest(payload);
  fs.mkdirSync(path.join(obsDir, 'sent'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(obsDir, 'sent', `${digest}.json`),
    JSON.stringify({
      digest,
      sentAt,
      prompt: instructionNeedle(payload),
    }),
    { mode: 0o600 },
  );
  return digest;
}

export function queuedPrompt(meta, runner, receipt) {
  if (!receipt || !rendersSteeringQueue(runner)) return null;
  if (
    receipt.submitted_at &&
    receipt.submit_key === 'Enter' &&
    receipt.pane_identity === paneIdentity(meta) &&
    runnerPaneHasQueuedInstruction(
      meta.tail || '',
      receipt.payload,
      receipt.queue_was_empty === true,
    )
  )
    return {
      source: 'runner-steering',
      session_id: receipt.session_id,
      turn_token: null,
      observed_at: Date.now(),
    };
  return null;
}

export function bufferedPrompt(meta, runner, receipt) {
  return Boolean(
    receipt?.typed &&
    supportsMidTurnPrompt(runner) &&
    receipt.pane_identity === paneIdentity(meta) &&
    runnerPaneHasBufferedInstruction(meta.tail || '', receipt.payload),
  );
}

export function acceptedPrompt(meta, runner, obsDir, receipt) {
  // The owned Enter steering block proves delivery, not a new turn.
  // Native /goal still needs its objective and turn boundary below.
  const queued = !receipt.payload.startsWith('/goal ') && queuedPrompt(meta, runner, receipt);
  if (queued) return queued;
  const bound = sessionBinding(meta, runner, obsDir);
  const mayBind =
    receipt.session_id === null &&
    receipt.steering &&
    receipt.submitted_at &&
    receipt.pane_identity === paneIdentity(meta);
  if (!bound || (bound.sessionId !== receipt.session_id && !mayBind)) return null;
  if (runner === 'codex' && bound.sessionPath) {
    const goal = acceptedCodexGoal(bound.sessionPath, bound.sessionId, receipt);
    if (goal) return goal;
    const probe = runProbe(
      buildCodexPromptProbeCommand(
        bound.sessionId,
        bound.sessionPath,
        receipt.payload,
        receipt.sent_at,
      ),
      parseCodexPromptProbe,
    );
    if (
      probe.status === 'matched' &&
      (probe.turnId !== receipt.before_turn_token || receipt.steering)
    ) {
      return {
        source: probe.turnId === receipt.before_turn_token ? 'native-steering' : 'native-session',
        session_id: bound.sessionId,
        turn_token: probe.turnId,
        observed_at: probe.observedAt,
      };
    }
    // Do not compare native turn ids with hook timestamp tokens or override an exact-history miss.
    return null;
  }
  const transcript =
    runner === 'claude' &&
    Number.isSafeInteger(receipt.session_offset) &&
    acceptedClaudePrompt(bound.sessionPath, bound.sessionId, receipt);
  if (transcript) return transcript;
  // A hook digest covers only the message prefix, so it never proves a longer message whole.
  if (instructionNeedle(receipt.payload) !== normalizeInstructionText(receipt.payload)) return null;
  const proof = promptAcceptedFromHooks(
    bound.hooks,
    receipt.digest,
    receipt.sent_at,
    0,
    Date.now(),
    meta.pane_id,
    true,
  );
  if (
    proof?.value === true &&
    proof.confidence === 'high' &&
    proof.turnToken &&
    proof.turnToken !== receipt.before_turn_token
  ) {
    return {
      source: 'hook',
      session_id: bound.sessionId,
      turn_token: proof.turnToken,
      observed_at: proof.observedAt,
    };
  }
  return null;
}

// Claude records idle input as a human prompt. Input during a turn is queued at once and
// attached to the turn at its next step. Only records written after the send can match.
export function acceptedClaudePrompt(sessionPath, sessionId, receipt) {
  if (!sessionPath) return null;
  const expected = normalizeInstructionText(receipt.payload);
  let queued = null;
  for (const record of recordsSinceSend(sessionPath, receipt)) {
    const observed = Date.parse(record.timestamp);
    if (!(observed >= receipt.sent_at) || (record.sessionId && record.sessionId !== sessionId))
      continue;
    const [source, text] =
      record.type === 'user' && !record.isMeta
        ? ['native-session', record.message?.content]
        : record.type === 'attachment' && record.attachment?.type === 'queued_command'
          ? ['native-steering', record.attachment.prompt]
          : record.type === 'queue-operation' && record.operation === 'enqueue'
            ? ['native-queue', record.content]
            : [null, null];
    // Up pulls queued input back into the composer; that enqueue no longer proves delivery.
    if (
      record.type === 'queue-operation' &&
      record.operation === 'popAll' &&
      normalizeInstructionText(String(record.content || '')).includes(expected)
    )
      queued = null;
    if (typeof text !== 'string' || normalizeInstructionText(text) !== expected) continue;
    const proof = {
      source,
      session_id: sessionId,
      turn_token: record.promptId || null,
      observed_at: observed,
    };
    if (source !== 'native-queue') return proof;
    queued ||= proof;
  }
  return queued;
}

export function acceptedCodexGoal(sessionPath, sessionId, receipt) {
  if (!receipt.payload.startsWith('/goal ')) return null;
  const header = parseHookJsonl(readOptional(sessionPath, 0, SESSION_HEADER_BYTES))[0];
  if (header?.type !== 'session_meta' || header?.payload?.id !== sessionId) return null;
  let applied = null;
  for (const record of recordsSinceSend(sessionPath, receipt)) {
    const payload = record.payload || {};
    const observed = Date.parse(record.timestamp);
    if (record.type !== 'event_msg' || !Number.isFinite(observed) || observed < receipt.sent_at)
      continue;
    if (payload.type === 'thread_goal_updated') {
      applied =
        payload.threadId === sessionId &&
        payload.goal?.threadId === sessionId &&
        payload.goal?.status === 'active' &&
        payload.goal?.objective === receipt.payload.slice(6)
          ? observed
          : null;
    } else if (
      applied &&
      payload.type === 'task_started' &&
      payload.turn_id &&
      payload.turn_id !== receipt.before_turn_token
    ) {
      return {
        source: 'native-goal',
        session_id: sessionId,
        turn_token: payload.turn_id,
        observed_at: observed,
        payload_hash: receipt.payload_hash,
      };
    }
  }
  return null;
}
