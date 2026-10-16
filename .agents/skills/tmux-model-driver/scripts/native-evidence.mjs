import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
  codexSessionObservability,
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
  runnerPromptDigest,
} from '../../../../services/gateway/src/runners/observability-prompt-digest.ts';
import {
  buildRunnerOpenFileProbeCommand,
  parseOpenFilePaths,
} from '../../../../services/gateway/src/runners/process-open-files.ts';
import {
  runnerPaneHasBufferedInstruction,
  runnerPaneHasQueuedInstruction,
} from '../../../../services/gateway/src/runners/runner-pane-input.ts';

export function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const supportsMidTurnPrompt = (runner) =>
  runner === 'codex' && codexSessionObservability.supportsMidTurnPrompt === true;

export const hasSubmittedQueue = (runner, tail) =>
  supportsMidTurnPrompt(runner) && runnerPaneHasQueuedInstruction(tail);

export const paneIdentity = (meta) =>
  JSON.stringify([meta.pane_pid, meta.process_started_at, meta.runner_pids]);

export function nativeProbeTimeoutMs() {
  const timeout = Number(process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS ?? 10000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
    throw new Error(
      'TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS must be a positive integer in milliseconds',
    );
  return timeout;
}

function runProbe(command, parse) {
  return parse(
    execFileSync('bash', ['-c', command], {
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
  const hooks = parseHookJsonl(readOptional(path.join(obsDir, 'hooks.jsonl'))).filter(
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
  const records = transcriptPath ? parseHookJsonl(readOptional(transcriptPath)) : [];
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
  for (const record of parseHookJsonl(readOptional(transcriptPath))) {
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

function sessionBinding(meta, runner, obsDir) {
  const bound = hookSnapshot(meta, runner, obsDir);
  if (bound || runner !== 'codex') return bound;
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
  if (runner === 'claude') {
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
  if (!receipt || !supportsMidTurnPrompt(runner)) return null;
  if (
    receipt.submitted_at &&
    receipt.pane_identity === paneIdentity(meta) &&
    runnerPaneHasQueuedInstruction(
      meta.tail || '',
      receipt.payload,
      true,
      receipt.queue_was_empty === true,
    )
  )
    return {
      source: 'runner-queue',
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
  // An Enter-submitted, complete driver-owned queue proves delivery, not a new turn.
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

export function acceptedCodexGoal(sessionPath, sessionId, receipt) {
  if (!receipt.payload.startsWith('/goal ')) return null;
  const records = parseHookJsonl(readOptional(sessionPath));
  if (records[0]?.type !== 'session_meta' || records[0]?.payload?.id !== sessionId) return null;
  let applied = null;
  for (const record of records) {
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
