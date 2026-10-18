import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { alive, durableWrite } from '../../../../packages/agent-runtime/src/native/storage.ts';
import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import {
  paneOpenQuestion,
  readPaneStateFromCapture,
} from '../../../../services/gateway/src/runners/pane-state-script.ts';
import { runnerLaunchBlockerAutoActionKey } from '../../../../services/gateway/src/runners/registry.ts';
import { runnerPaneBufferedInstruction } from '../../../../services/gateway/src/runners/runner-pane-input.ts';

import {
  acceptedPrompt,
  bufferedPrompt,
  hasSubmittedQueue,
  nativeState,
  paneIdentity,
  proofVerification,
  queuedInTranscript,
  queuedPrompt,
  queueProofTimeoutMs,
  readOptional,
  requiresNativeSession,
  sessionSize,
  supportsMidTurnPrompt,
  verifyTimeoutMs,
  writeSentinel,
} from './native-evidence.mjs';

const runners = new Set(['codex', 'claude', 'cursor', 'gemini', 'grok']);
const shellNames = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export function tmux(args, input) {
  const socket = process.env.TMUX_MODEL_DRIVER_SOCKET;
  return execFileSync('tmux', [...(socket ? ['-L', socket] : []), ...args], {
    input,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function metadata(pane) {
  const supplied = [
    'CURRENT_COMMAND',
    'CURRENT_PATH',
    'SESSION_NAME',
    'PANE_TITLE',
    'PANE_PID',
  ].every((key) => process.env[`TMUX_PANE_STATE_${key}`] !== undefined);
  if (supplied) {
    return {
      pane_id: pane,
      session_name: process.env.TMUX_PANE_STATE_SESSION_NAME,
      current_command: process.env.TMUX_PANE_STATE_CURRENT_COMMAND,
      current_path: process.env.TMUX_PANE_STATE_CURRENT_PATH,
      pane_title: process.env.TMUX_PANE_STATE_PANE_TITLE,
      pane_pid: process.env.TMUX_PANE_STATE_PANE_PID,
      pane_started_at: Number(
        process.env.TMUX_PANE_STATE_PANE_STARTED_AT ||
          process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT ||
          0,
      ),
      process_started_at: Number(process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT || 0),
      foreground_commands: (process.env.TMUX_PANE_STATE_FOREGROUND_COMMANDS || '')
        .split('\n')
        .filter(Boolean),
      runner_pids: (process.env.TMUX_PANE_STATE_RUNNER_PIDS || '').split(',').filter(Boolean),
    };
  }
  const values = tmux([
    'display-message',
    '-p',
    '-t',
    pane,
    '#{pane_id}\t#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_pid}\t#{socket_path}',
  ])
    .trimEnd()
    .split('\t');
  const [pane_id, session_name, current_command, current_path, pane_title, pane_pid, socket_path] =
    values;
  const override = (name, value) => process.env[`TMUX_PANE_STATE_${name}`] ?? value;
  const pid = override('PANE_PID', pane_pid);
  let foreground = '';
  let started = 0;
  let paneStarted = 0;
  const runnerPids = [];
  if (pid) {
    const row = execFileSync('ps', ['-o', 'tpgid=,lstart=', '-p', pid], {
      encoding: 'utf8',
    }).trim();
    const [pgid, ...birth] = row.split(/\s+/);
    paneStarted = Date.parse(birth.join(' ')) || 0;
    started = paneStarted || Date.now();
    if (/^\d+$/.test(pgid)) {
      const processes = execFileSync('ps', ['-o', 'pid=,lstart=,args=', '-g', pgid], {
        encoding: 'utf8',
      });
      foreground = processes
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const fields = line.trim().split(/\s+/);
          const command = fields.slice(6).join(' ');
          if (runners.has(processState({ current_command: '', foreground_commands: [command] }))) {
            runnerPids.push(fields[0]);
            started = Math.max(started, Date.parse(fields.slice(1, 6).join(' ')) || started);
          }
          return command;
        })
        .join('\n');
    }
  }
  return {
    pane_id,
    socket_path,
    session_name: override('SESSION_NAME', session_name),
    current_command: override('CURRENT_COMMAND', current_command),
    current_path: override('CURRENT_PATH', current_path),
    pane_title: override('PANE_TITLE', pane_title),
    pane_pid: pid,
    pane_started_at: Number(process.env.TMUX_PANE_STATE_PANE_STARTED_AT ?? paneStarted),
    process_started_at: Number(process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT ?? started),
    foreground_commands: override('FOREGROUND_COMMANDS', foreground).split('\n').filter(Boolean),
    runner_pids: runnerPids,
  };
}

// The live composer holds this receipt's exact text, so it has not been delivered.
const ownsComposer = (state, runner, receipt) =>
  state.queue_kind === 'driver-buffer' && bufferedPrompt(state, runner, receipt);

export function processState(meta) {
  const commands = [meta.current_command, ...meta.foreground_commands];
  for (const command of commands) {
    const tokens = command
      .trim()
      .split(/\s+/)
      .map((token) => path.basename(token));
    const candidates = [tokens[0]];
    if (tokens[0] === 'node') candidates.push(tokens[tokens[1] === 'node' ? 2 : 1]);
    if (/^\d+\.\d+\.\d+$/.test(tokens[0])) candidates.push(tokens[1]);
    if (
      candidates.some((token) =>
        ['claude', 'claude.exe', 'claude_exe', 'claude.js'].includes(token),
      )
    )
      return 'claude';
    if (candidates.some((token) => ['codex', 'codex.js'].includes(token))) return 'codex';
    if (candidates.some((token) => ['cursor-agent', 'agent'].includes(token))) return 'cursor';
    if (candidates.some((token) => ['gemini', 'gemini.js'].includes(token))) return 'gemini';
    if (candidates.includes('grok')) return 'grok';
  }
  return shellNames.has(meta.current_command) ? 'shell' : 'unknown';
}

// Rendered text vetoes unsafe sends. Only receipt-bound steering can prove delivery.
export function paneSafety(tail, runner) {
  const lines = tail.trimEnd().split('\n');
  const question = paneOpenQuestion(tail);
  const queued =
    hasSubmittedQueue(runner, tail) ||
    lines
      .slice(-5)
      .some((line) =>
        /^\s*[│┃║]?\s*(?:\d+\s+queued messages?|message queued|queued messages?)\s*[│┃║]?\s*$/i.test(
          line,
        ),
      );
  const busy = /tab to queue message/i.test(tail);
  const blocker = readPaneStateFromCapture(tail, runner);
  return {
    pending_question: question !== null,
    queued,
    busy,
    launch_blocker: blocker.launchBlocker,
    auto_action: blocker.autoAction,
    question: question === null ? null : { source: 'pane-safety', text: question },
  };
}

function paths(meta, selection = {}) {
  const external = path.join(runnerRuntimeDir(meta.current_path), '.observability');
  const obs =
    process.env.TMUX_MODEL_DRIVER_OBSERVABILITY_DIR ||
    (fs.existsSync(path.join(external, 'install.json'))
      ? external
      : path.join(meta.current_path, '.agent', '.observability'));
  const root =
    process.env.TMUX_MODEL_DRIVER_STATE_DIR ||
    path.join(os.tmpdir(), `tmux-model-driver-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const socket =
    meta.socket_path ||
    process.env.TMUX_MODEL_DRIVER_SOCKET ||
    process.env.TMUX?.split(',')[0] ||
    'default';
  const key = hash(`${socket}:${meta.pane_id}:${meta.pane_pid}:${meta.process_started_at}`);
  // Keep old caller-specific receipts in place. All aliases now share one mutation lock.
  const pending = fs
    .readdirSync(root)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .flatMap((name) => {
      const file = path.join(root, name);
      // Another owner can acknowledge between directory listing and this read.
      const raw = readOptional(file);
      return raw ? [{ file, receipt: JSON.parse(raw) }] : [];
    })
    .filter(
      ({ receipt }) =>
        receipt.pane_identity === paneIdentity(meta) &&
        (!receipt.socket || receipt.socket === socket) &&
        (!receipt.pane_id || receipt.pane_id === meta.pane_id),
    )
    .sort((a, b) => a.receipt.sent_at - b.receipt.sent_at);
  const selected =
    pending.find(({ receipt }) =>
      selection.receiptId
        ? receiptIdentity(receipt) === selection.receiptId
        : selection.payloadHash && receipt.payload_hash === selection.payloadHash,
    ) || pending[0];
  return {
    obs,
    socket,
    receipt: selected?.file || path.join(root, `${key}.json`),
    lock: path.join(root, `${key}.lock`),
    acknowledged: path.join(root, `${key}.acknowledged.json`),
  };
}

// The holder records its pid, so a send killed while holding the lock (a caller's timeout,
// SIGKILL) does not leave the pane busy until its model restarts. Same idiom as
// scripts/lib/node-cli-refresh.sh.
function acquireLock(files) {
  // Taking the lock, clearing a dead reaper's mutex and reaping a dead holder each retry once.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(files.lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reapStaleLock(files.lock)) continue;
      return false;
    }
    try {
      fs.writeFileSync(path.join(files.lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
    } catch (error) {
      fs.rmSync(files.lock, { recursive: true, force: true });
      throw error;
    }
    return true;
  }
  return false;
}

function releaseLock(files) {
  fs.rmSync(path.join(files.lock, 'pid'), { force: true });
  fs.rmdirSync(files.lock);
}

const olderThanAMinute = (dir) => {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > 60_000;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

// A holder that is gone, or one that never wrote its pid a minute on, is stale.
function lockHolderGone(lock, holder) {
  const pid = /^\d{1,10}$/.test(holder) ? Number(holder) : 0;
  if (pid <= 0 || pid > 0x7fffffff) return olderThanAMinute(lock);
  return !alive(pid);
}

// Reap under a second mutex, and only if the lock still belongs to the holder seen first:
// two waiters that saw the same dead holder must not both remove it, or the second removes
// the lock the first just took. True when the caller should try the lock again.
function reapStaleLock(lock) {
  const holder = readOptional(path.join(lock, 'pid'))?.trim() ?? '';
  if (!lockHolderGone(lock, holder)) return false;
  const reap = `${lock}.reap`;
  try {
    fs.mkdirSync(reap, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A reaper killed mid-reap leaves its mutex behind; it is stale a minute on.
    if (!olderThanAMinute(reap)) return false;
    fs.rmSync(reap, { recursive: true, force: true });
    return true;
  }
  try {
    const current = readOptional(path.join(lock, 'pid'))?.trim() ?? '';
    if (current !== holder || !lockHolderGone(lock, holder)) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmdirSync(reap);
  }
}

function receiptIdentity(receipt) {
  const { accepted: _accepted, ...original } = receipt;
  return receipt.receipt_id || hash(JSON.stringify(original));
}

function readReceipt(files) {
  const raw = readOptional(files.receipt);
  return raw ? JSON.parse(raw) : null;
}

function wasAcknowledged(files, id) {
  return JSON.parse(readOptional(files.acknowledged) || '[]').includes(id);
}

// An inspection may finish after another process has acknowledged or sent. Persist only
// under the shared mutation lock (taken here unless the caller holds it) and for the same
// receipt; a null change writes nothing.
function updateReceipt(files, receipt, change, held = false) {
  if (process.env.TMUX_MODEL_DRIVER_READ_ONLY === '1') return;
  const owned = !held && acquireLock(files);
  if (!held && !owned) return;
  try {
    const current = readReceipt(files);
    if (
      current &&
      receiptIdentity(current) === receiptIdentity(receipt) &&
      current.payload_hash === receipt.payload_hash
    ) {
      const next = change(current);
      if (next) durableWrite(files.receipt, next);
    }
  } finally {
    if (owned) releaseLock(files);
  }
}

// A rendered steering proof is stamped with the time it was seen; every other field, and every
// other source's timestamp, comes from the runner and must match exactly.
function sameProof(saved, fresh) {
  if (!saved || saved.source !== fresh.source) return false;
  const fields = (proof) =>
    JSON.stringify(
      Object.keys(proof)
        .filter((key) => !(key === 'observed_at' && proof.source === 'runner-steering'))
        .sort()
        .map((key) => [key, proof[key]]),
    );
  return fields(saved) === fields(fresh);
}

function clearAcceptedReceipt(files, receipt) {
  const ids = JSON.parse(readOptional(files.acknowledged) || '[]');
  const id = receiptIdentity(receipt);
  if (!ids.includes(id)) ids.push(id);
  durableWrite(files.acknowledged, ids);
  fs.unlinkSync(files.receipt);
}

export function paneState(pane, expectedRunner, selection) {
  const meta = metadata(pane);
  const state = processState(meta);
  const runner = expectedRunner || state;
  const capturedAt = Date.now();
  const tail =
    process.env.TMUX_PANE_STATE_TAIL_CAPTURE ??
    tmux(['capture-pane', '-p', '-t', pane, '-S', '-40']);
  const safety = paneSafety(tail, runner);
  const files = paths(meta, selection);
  const { obs } = files;
  const native = runners.has(state)
    ? nativeState(meta, state, obs)
    : { phase: state === 'shell' ? 'idle' : 'unknown', source: 'process', question: null };
  const receipt = readReceipt(files);
  let accepted = receipt?.accepted || null;
  // Old Tab receipts prove postponed input only, not an Enter steering delivery.
  if (accepted?.source === 'runner-queue') accepted = null;
  if (
    accepted &&
    (accepted.receipt_id !== receiptIdentity(receipt) ||
      accepted.payload_hash !== receipt.payload_hash ||
      accepted.session_id !== receipt.session_id ||
      (accepted.source === 'runner-steering'
        ? receipt.pane_identity !== paneIdentity(meta) ||
          (receipt.session_id && native.session_id && receipt.session_id !== native.session_id)
        : accepted.session_id !== native.session_id))
  )
    accepted = null;
  const buffered = supportsMidTurnPrompt(state) && Boolean(runnerPaneBufferedInstruction(tail));
  const ownedBuffer = buffered && bufferedPrompt({ ...meta, tail }, state, receipt);
  // Pulled-back input is not delivered. Claude's queue proof is rechecked against the
  // transcript (popAll) whatever the composer shows; Codex's rendered steering proof yields
  // to its owned text back in the composer (⇧←), unless a retry proved it after this capture.
  // Native proofs are recomputed below.
  const pulledBack =
    accepted?.source === 'runner-steering' && ownedBuffer && !(accepted.observed_at > capturedAt)
      ? accepted
      : null;
  if (accepted?.source === 'native-queue' || pulledBack) accepted = null;
  if (receipt && runners.has(state)) {
    if (!accepted) {
      accepted = acceptedPrompt({ ...meta, tail }, state, obs, receipt);
      if (accepted) {
        accepted.payload_hash = receipt.payload_hash;
        accepted.receipt_id = receiptIdentity(receipt);
        // Re-proving the saved proof changes nothing, so it takes neither the lock nor a write.
        if (sameProof(receipt.accepted, accepted) && receipt.session_id === accepted.session_id)
          accepted = receipt.accepted;
        else
          updateReceipt(
            files,
            receipt,
            (current) => ({ ...current, session_id: accepted.session_id, accepted }),
            selection?.held,
          );
      } else if (pulledBack) {
        // The steering block is gone, so a later edit or clear of the composer must not bring
        // the old proof back. A proof saved meanwhile by a retry is newer and stays.
        updateReceipt(
          files,
          receipt,
          ({ accepted: saved, ...current }) =>
            JSON.stringify(saved) === JSON.stringify(pulledBack) ? current : null,
          selection?.held,
        );
      }
    }
  }
  const question = native.question || safety.question;
  const questionFingerprint = question
    ? hash(
        JSON.stringify({
          socket: files.socket,
          pane_id: meta.pane_id,
          pane_pid: meta.pane_pid,
          process_started_at: meta.process_started_at,
          session_id: native.session_id,
          question,
        }),
      )
    : null;
  // A model receipt stays intact after exit, but cannot be a live shell composer.
  const pendingOtherRunner =
    runners.has(state) && !supportsMidTurnPrompt(state) && Boolean(receipt && !accepted);
  const queued = safety.queued || buffered || pendingOtherRunner;
  const phase = safety.launch_blocker
    ? 'launch-blocker'
    : question
      ? 'question'
      : queued
        ? 'queued'
        : native.phase === 'busy' || safety.busy
          ? 'busy'
          : native.phase;
  return {
    ...meta,
    state,
    phase,
    confidence: state === 'unknown' ? 'low' : 'high',
    pending_question: Boolean(question),
    question,
    question_fingerprint: questionFingerprint,
    queued,
    queue_kind: safety.queued
      ? 'runner-queue'
      : ownedBuffer || pendingOtherRunner
        ? 'driver-buffer'
        : buffered
          ? 'unowned-buffer'
          : null,
    delivery_phase: native.phase,
    evidence_source: native.source,
    session_id: native.session_id || null,
    session_path: native.session_path || null,
    turn_token: native.turn_token || null,
    observed_at: native.observed_at || null,
    accepted,
    launch_blocker: safety.launch_blocker,
    auto_action: safety.auto_action,
    tail,
    last_line: tail.trimEnd().split('\n').at(-1) || '',
    reasons: [
      state === 'unknown'
        ? 'Runner identity is unavailable'
        : 'Runner identity comes from process metadata',
      `Readiness evidence: ${native.source}`,
    ],
    buffered_digest: ownedBuffer || pendingOtherRunner ? receipt.payload_hash : null,
  };
}

export function acknowledgeAcceptance(pane, runner, receiptId) {
  const selection = { receiptId };
  const before = paneState(pane, runner, selection);
  let verification = before.state !== runner ? 'wrong_runner' : null;
  const files = paths(before, selection);
  let locked = false;
  try {
    if (!verification) {
      locked = acquireLock(files);
      if (!locked)
        verification = wasAcknowledged(files, receiptId) ? 'already_acknowledged' : 'driver_busy';
    }
    if (!verification) {
      // Under this lock, so a withdrawal seen only now is saved too.
      const current = paneState(pane, runner, { ...selection, held: true });
      if (current.state !== runner) verification = 'wrong_runner';
      else if (wasAcknowledged(files, receiptId)) {
        const pending = readReceipt(files);
        if (pending && receiptIdentity(pending) === receiptId) fs.unlinkSync(files.receipt);
        verification = 'already_acknowledged';
      } else if (!current.accepted)
        verification = readReceipt(files) ? 'receipt_unverified' : 'no_accepted_receipt';
      else if (current.accepted.receipt_id !== receiptId) verification = 'receipt_mismatch';
      else {
        clearAcceptedReceipt(files, readReceipt(files));
        verification = 'acceptance_acknowledged';
      }
    }
  } finally {
    if (locked) releaseLock(files);
  }
  return {
    pane_id: pane,
    action_kind: runner,
    receipt_id: receiptId,
    verification,
    acknowledged: ['acceptance_acknowledged', 'already_acknowledged'].includes(verification),
    accepted: before.accepted,
  };
}

export function validateAnswer(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 12)
    throw new Error('Answer requires 1 to 12 explicit actions');
  const allowed = new Set(['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape']);
  for (const action of actions) {
    if (typeof action === 'string' && allowed.has(action)) continue;
    if (
      action &&
      Object.keys(action).length === 1 &&
      typeof action.text === 'string' &&
      Buffer.byteLength(action.text) <= 2048 &&
      !/[\x00-\x1f\x7f]/.test(action.text)
    )
      continue;
    throw new Error(
      'Only explicit navigation keys or text up to 2048 bytes without control characters are allowed',
    );
  }
  return actions;
}

export async function answerQuestion(pane, runner, fingerprint, actions, tracePath) {
  validateAnswer(actions);
  const before = paneState(pane, runner);
  let verification =
    before.state !== runner
      ? 'wrong_runner'
      : !before.pending_question
        ? 'no_pending_question'
        : before.question_fingerprint !== fingerprint
          ? 'question_changed'
          : null;
  const files = paths(before);
  let locked = false;
  try {
    if (!verification) {
      locked = acquireLock(files);
      if (!locked) verification = 'driver_busy';
    }
    if (!verification) {
      const current = paneState(pane, runner);
      if (
        current.state !== runner ||
        current.pane_pid !== before.pane_pid ||
        current.process_started_at !== before.process_started_at ||
        current.question_fingerprint !== fingerprint
      )
        verification = 'question_changed';
    }
    if (!verification) {
      for (const action of actions) {
        if (typeof action === 'string') tmux(['send-keys', '-t', pane, action]);
        else tmux(['send-keys', '-t', pane, '-l', action.text]);
      }
      verification = 'response_sent';
    }
  } finally {
    if (locked) releaseLock(files);
  }
  // Response delivery is explicit input, not positive proof of a runner turn.
  const result = {
    pane_id: pane,
    action_kind: runner,
    verification,
    submitted: false,
    acknowledged: verification === 'response_sent',
    question_fingerprint: fingerprint,
    actions,
    before,
  };
  if (tracePath)
    fs.appendFileSync(
      tracePath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...result })}\n`,
      { mode: 0o600 },
    );
  return result;
}

export function refusal(before, runner, flush = false) {
  if (before.evidence_source === 'native-session-read-only') return 'observability_unavailable';
  if (before.state !== runner) return runner === 'shell' ? 'shell_launch_blocked' : 'wrong_runner';
  if (before.confidence !== 'high') return 'unknown';
  if (before.pending_question) return 'pending_question';
  if (before.launch_blocker) return 'launch_blocker';
  // Without its native session, Claude delivery can never be proven.
  if (requiresNativeSession(runner) && !before.session_id) return 'observability_unavailable';
  // Retain delivery bookkeeping without locking fresh mid-turn handoffs out.
  // Live queues, questions and drafts still veto below or above.
  if (before.accepted && (flush || !supportsMidTurnPrompt(runner)))
    return 'acceptance_unacknowledged';
  if (flush || !supportsMidTurnPrompt(runner)) {
    if (before.delivery_phase === 'busy' || before.phase === 'busy') return 'busy';
    if (before.delivery_phase !== 'idle') return 'observability_unavailable';
  }
  if (flush) return before.queue_kind === 'driver-buffer' ? null : 'queue_not_owned';
  return before.queued ? 'queued_input' : null;
}

export function resolveLaunchBlocker(pane, runner, inspect = paneState) {
  const before = inspect(pane, runner);
  const refused = { action_sent: false, verification: 'startup_action_refused' };
  if (before.state !== runner || before.auto_action !== 'codex-skip-update') return refused;
  const files = paths(before);
  if (!acquireLock(files)) return { ...refused, verification: 'driver_busy' };
  try {
    const fresh = inspect(pane, runner);
    if (
      fresh.state !== runner ||
      paneIdentity(fresh) !== paneIdentity(before) ||
      fresh.auto_action !== before.auto_action
    )
      return refused;
    const key = runnerLaunchBlockerAutoActionKey(fresh.auto_action);
    if (!key) return refused;
    tmux(['send-keys', '-t', pane, key, 'Enter']);
    // This acknowledges a startup choice, never model readiness or prompt acceptance.
    return { action_sent: true, action: fresh.auto_action, verification: 'startup_action_sent' };
  } finally {
    releaseLock(files);
  }
}

export async function send(pane, runner, payload, tracePath, flush = false) {
  const startedAt = Date.now();
  const selection = { payloadHash: hash(payload) };
  let before = paneState(pane, runner, selection);
  let after = before;
  let verification = refusal(before, runner, flush);
  let evidence = null;
  let typed = false;
  const files = paths(before, selection);
  const ownedRetry = (state) => {
    const receipt = readReceipt(files);
    return (
      !flush &&
      supportsMidTurnPrompt(runner) &&
      receipt &&
      receipt.payload_hash === selection.payloadHash &&
      receipt.pane_identity === paneIdentity(state) &&
      (state.accepted || ownsComposer(state, runner, receipt))
    );
  };
  if (['queued_input', 'acceptance_unacknowledged'].includes(verification) && ownedRetry(before))
    verification = null;
  // Both settings are read before any key, so a bad value never turns a delivered send into an
  // error, and a non-numeric one never leaves the wait without an end.
  const timeout = verifyTimeoutMs();
  const queueProof = queueProofTimeoutMs();
  let scratch = null;
  let locked = false;
  try {
    if (!verification) {
      locked = acquireLock(files);
      if (!locked) verification = 'driver_busy';
    }
    if (!verification) {
      before = paneState(pane, runner, selection);
      verification = refusal(before, runner, flush);
      if (
        ['queued_input', 'acceptance_unacknowledged'].includes(verification) &&
        ownedRetry(before)
      )
        verification = null;
      const pending = readReceipt(files);
      // Keep uncertain delivery evidence, but never replay that same payload into an empty composer.
      if (
        !verification &&
        !flush &&
        pending?.payload_hash === selection.payloadHash &&
        !ownedRetry(before)
      )
        verification = 'unverified';
    }
    if (!verification) {
      let receipt = runner === 'shell' ? null : readReceipt(files);
      const retry = ownedRetry(before);
      const restored = ownsComposer(before, runner, receipt);
      // paneState has already withdrawn pulled-back proofs; a recalled delivered prompt keeps one.
      if (retry && before.accepted) {
        evidence = before.accepted;
        verification = proofVerification(runner, evidence);
      } else if (flush || retry) {
        receipt = JSON.parse(fs.readFileSync(files.receipt, 'utf8'));
        if (
          !receipt.typed ||
          (retry
            ? !bufferedPrompt(before, runner, receipt)
            : !before.tail.includes(receipt.payload))
        )
          verification = 'queue_buffer_unconfirmed';
        if (payload && hash(payload) !== receipt.payload_hash)
          verification = 'queued_payload_mismatch';
        payload = receipt.payload;
        if (retry) receipt.queue_was_empty = true;
        if ((retry || flush) && restored) {
          // Only records after this submission can prove it.
          delete receipt.accepted;
          receipt.sent_at = Date.now();
          receipt.session_offset = sessionSize(before.session_path) ?? receipt.session_offset;
        }
      } else {
        if (!payload.trim()) verification = 'empty_payload';
        if (!verification && runner !== 'shell') {
          const sentAt = Date.now();
          receipt = {
            receipt_id: randomUUID(),
            payload,
            payload_hash: hash(payload),
            digest: writeSentinel(files.obs, payload, sentAt),
            sent_at: sentAt,
            session_id: before.session_id,
            before_turn_token: before.turn_token,
            steering: supportsMidTurnPrompt(runner) && before.delivery_phase !== 'idle',
            pane_identity: paneIdentity(before),
            pane_id: before.pane_id,
            socket: files.socket,
            queue_was_empty: !before.queued,
            // A session without a transcript yet proves delivery from its first record.
            session_offset: before.session_id ? (sessionSize(before.session_path) ?? 0) : null,
            typed: false,
          };
          // A fresh handoff must not overwrite an older unverified receipt discovered by alias lookup.
          if (readReceipt(files))
            files.receipt = path.join(
              path.dirname(files.receipt),
              `${hash(receipt.receipt_id)}.json`,
            );
          durableWrite(files.receipt, receipt);
        }
      }
      if (!verification) {
        let transportPayload = payload;
        if (runner === 'shell') {
          scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-model-driver-shell-'));
          transportPayload = `printf started > ${quote(path.join(scratch, 'started'))}; ${payload}`;
        }
        if (!flush && !retry) {
          const buffer = `tmux-model-driver-${randomUUID()}`;
          tmux(['load-buffer', '-b', buffer, '-'], transportPayload);
          try {
            tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]);
            typed = true;
          } catch (error) {
            tmux(['delete-buffer', '-b', buffer]);
            throw error;
          }
          if (receipt) {
            receipt.typed = true;
            durableWrite(files.receipt, receipt);
          }
        }
        after = paneState(pane, runner, selection);
        verification = after.pending_question
          ? 'pending_question'
          : after.state !== runner
            ? 'wrong_runner'
            : after.delivery_phase === 'busy' && !supportsMidTurnPrompt(runner)
              ? 'busy'
              : null;
        if (!verification) {
          tmux(['send-keys', '-t', pane, 'Enter']);
          if (receipt) {
            receipt.submitted_at = Date.now();
            receipt.submit_key = 'Enter';
            durableWrite(files.receipt, receipt);
          }
        }
        verification ||= 'unverified';
        let deadline = Date.now() + timeout;
        // A mid-turn Claude send is proven only by its transcript's queue records, which can
        // wait for the turn's next step. The wait counts from the start of this send.
        const queueDeadline =
          requiresNativeSession(runner) && before.delivery_phase !== 'idle'
            ? startedAt + queueProof
            : 0;
        let retriedEnter = false;
        let leftComposer = false;
        if (verification === 'unverified') {
          for (;;) {
            after = paneState(pane, runner, selection);
            evidence =
              runner === 'shell'
                ? fs.existsSync(path.join(scratch, 'started'))
                  ? { source: 'shell-sentinel' }
                  : null
                : after.accepted || acceptedPrompt(after, runner, files.obs, receipt);
            if (evidence) {
              if (runner !== 'shell') {
                const current = readReceipt(files);
                const id = receiptIdentity(receipt);
                evidence = {
                  ...evidence,
                  receipt_id: evidence.receipt_id || id,
                  payload_hash: evidence.payload_hash || receipt.payload_hash,
                };
                if (
                  !current ||
                  receiptIdentity(current) !== id ||
                  current.payload_hash !== receipt.payload_hash ||
                  evidence.receipt_id !== id ||
                  evidence.payload_hash !== receipt.payload_hash
                ) {
                  evidence = null;
                  verification = 'receipt_mismatch';
                  break;
                }
                // Queued input stays retained until its caller acknowledges delivery.
                if (['runner-steering', 'native-queue'].includes(evidence.source))
                  durableWrite(files.receipt, { ...current, accepted: evidence });
                else clearAcceptedReceipt(files, current);
              }
              verification = proofVerification(runner, evidence);
              break;
            }
            if (after.pending_question) {
              verification = 'pending_question';
              break;
            }
            if (after.state !== runner) break;
            const pending = queuedPrompt(after, runner, receipt);
            if (pending) {
              evidence = {
                ...pending,
                receipt_id: receiptIdentity(receipt),
                payload_hash: receipt.payload_hash,
              };
              // Only /goal reaches here; a rendered queue never proves its goal turn.
              verification = 'queued';
              break;
            }
            // Only this receipt's unchanged live composer can authorize another Enter.
            // Historical prompt text and foreign queues never authorize another key.
            // Text that left the composer and came back was pulled back for editing: no Enter.
            const owned = ownsComposer(after, runner, receipt);
            if (!owned) leftComposer = true;
            if (
              !retriedEnter &&
              !flush &&
              !leftComposer &&
              !payload.startsWith('/goal ') &&
              owned
            ) {
              retriedEnter = true;
              tmux(['send-keys', '-t', pane, 'Enter']);
              receipt.submit_key = 'Enter';
              receipt.submitted_at = Date.now();
              durableWrite(files.receipt, receipt);
              deadline = Date.now() + timeout;
              continue;
            }
            // One last read at the deadline, never a sleep past it.
            const left = Math.max(deadline, queueDeadline) - Date.now();
            if (left <= 0) break;
            await delay(Math.min(left, Date.now() < deadline ? 40 : 250));
          }
          if (
            verification === 'unverified' &&
            supportsMidTurnPrompt(runner) &&
            (bufferedPrompt(after, runner, receipt) || hasSubmittedQueue(runner, after.tail))
          )
            verification = 'not_sent';
        }
      }
    }
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true });
    if (locked) releaseLock(files);
  }
  const result = {
    pane_id: pane,
    session_name: before.session_name,
    action_kind: runner,
    payload,
    before_state: before.state,
    after_state: after.state,
    verification,
    // Input Claude's transcript records as queued in its turn was accepted, so it counts as
    // submitted; a rendered queue (Codex /goal) proves nothing about its turn.
    submitted:
      verification === 'submitted' ||
      (verification === 'queued' && queuedInTranscript(runner, evidence)),
    queued: verification === 'queued',
    typed,
    flush,
    evidence,
    before,
    after,
  };
  if (tracePath)
    fs.appendFileSync(
      tracePath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...result })}\n`,
      { mode: 0o600 },
    );
  return result;
}

async function main() {
  const [operation, pane, runner, tracePath, answerTrace] = process.argv.slice(2);
  if (!pane || (operation !== 'state' && !runners.has(runner) && runner !== 'shell'))
    throw new Error(
      'usage: driver.mjs state <pane> [runner] | send|flush <pane> <runner> [trace.jsonl]',
    );
  const result =
    operation === 'state'
      ? paneState(pane, runner)
      : operation === 'resolve-launch-blocker'
        ? resolveLaunchBlocker(pane, runner)
        : operation === 'ack'
          ? acknowledgeAcceptance(pane, runner, tracePath)
          : operation === 'answer'
            ? await answerQuestion(
                pane,
                runner,
                tracePath,
                JSON.parse(fs.readFileSync(0, 'utf8')),
                answerTrace,
              )
            : await send(
                pane,
                runner,
                fs.readFileSync(0, 'utf8').replace(/\n$/, ''),
                tracePath,
                operation === 'flush',
              );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    operation !== 'state' &&
    !result.submitted &&
    !result.queued &&
    !result.acknowledged &&
    !result.action_sent
  )
    process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ verification: 'driver_error', submitted: false, error: error.message })}\n`,
    );
    process.exitCode = 2;
  });
}
