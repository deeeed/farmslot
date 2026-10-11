import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableWrite } from '../../../../packages/agent-runtime/src/native/storage.ts';
import { readPaneStateFromCapture } from '../../../../services/gateway/src/runners/pane-state-script.ts';

import {
  acceptedPrompt,
  hasSubmittedQueue,
  nativeState,
  paneIdentity,
  queuedPrompt,
  readOptional,
  supportsMidTurnPrompt,
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
      process_started_at: Number(process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT || 0),
      foreground_commands: (process.env.TMUX_PANE_STATE_FOREGROUND_COMMANDS || '')
        .split('\n')
        .filter(Boolean),
    };
  }
  const values = tmux([
    'display-message',
    '-p',
    '-t',
    pane,
    '#{pane_id}\t#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_pid}',
  ])
    .trimEnd()
    .split('\t');
  const [pane_id, session_name, current_command, current_path, pane_title, pane_pid] = values;
  const override = (name, value) => process.env[`TMUX_PANE_STATE_${name}`] ?? value;
  const pid = override('PANE_PID', pane_pid);
  let foreground = '';
  let started = 0;
  const runnerPids = [];
  if (pid) {
    const row = execFileSync('ps', ['-o', 'tpgid=,lstart=', '-p', pid], {
      encoding: 'utf8',
    }).trim();
    const [pgid, ...birth] = row.split(/\s+/);
    started = Date.parse(birth.join(' ')) || Date.now();
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
    session_name: override('SESSION_NAME', session_name),
    current_command: override('CURRENT_COMMAND', current_command),
    current_path: override('CURRENT_PATH', current_path),
    pane_title: override('PANE_TITLE', pane_title),
    pane_pid: pid,
    process_started_at: Number(process.env.TMUX_PANE_STATE_PROCESS_STARTED_AT ?? started),
    foreground_commands: override('FOREGROUND_COMMANDS', foreground).split('\n').filter(Boolean),
    runner_pids: runnerPids,
  };
}

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

// Rendered text is a fail-closed veto only. It never proves readiness or delivery.
export function paneSafety(tail, runner) {
  const lines = tail.trimEnd().split('\n');
  const footer = lines.slice(-5).join('\n');
  const menu = /enter to (?:confirm|select)|esc to cancel|use arrow keys/i.test(footer);
  const active = menu ? lines.slice(-25).join('\n') : footer;
  const pending =
    menu ||
    /(?:\[y\/n\]|\[Y\/n\]|\[y\/N\]|do you (?:want|wish)|would you like|select an option)/i.test(
      active,
    );
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
    pending_question: pending,
    queued,
    busy,
    launch_blocker: blocker.launchBlocker,
    auto_action: blocker.autoAction,
    question: pending ? { source: 'pane-safety', text: active } : null,
  };
}

function paths(meta) {
  const obs =
    process.env.TMUX_MODEL_DRIVER_OBSERVABILITY_DIR ||
    path.join(meta.current_path, '.agent', '.observability');
  const root =
    process.env.TMUX_MODEL_DRIVER_STATE_DIR ||
    path.join(os.tmpdir(), `tmux-model-driver-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = hash(
    `${process.env.TMUX_MODEL_DRIVER_SOCKET || process.env.TMUX || 'default'}:${meta.pane_id}:${meta.pane_pid}:${meta.process_started_at}`,
  );
  return {
    obs,
    receipt: path.join(root, `${key}.json`),
    lock: path.join(root, `${key}.lock`),
    acknowledged: path.join(root, `${key}.acknowledged.json`),
  };
}

function acquireLock(files) {
  try {
    fs.mkdirSync(files.lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
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

function clearAcceptedReceipt(files, receipt) {
  const ids = JSON.parse(readOptional(files.acknowledged) || '[]');
  const id = receiptIdentity(receipt);
  if (!ids.includes(id)) ids.push(id);
  durableWrite(files.acknowledged, ids);
  fs.unlinkSync(files.receipt);
}

export function paneState(pane, expectedRunner) {
  const meta = metadata(pane);
  const state = processState(meta);
  const runner = expectedRunner || state;
  const tail =
    process.env.TMUX_PANE_STATE_TAIL_CAPTURE ??
    tmux(['capture-pane', '-p', '-t', pane, '-S', '-40']);
  const safety = paneSafety(tail, runner);
  const files = paths(meta);
  const { obs } = files;
  const native = runners.has(state)
    ? nativeState(meta, state, obs)
    : { phase: state === 'shell' ? 'idle' : 'unknown', source: 'process', question: null };
  const receipt = readReceipt(files);
  let accepted = receipt?.accepted || null;
  if (
    accepted &&
    (accepted.receipt_id !== receiptIdentity(receipt) ||
      accepted.payload_hash !== receipt.payload_hash ||
      accepted.session_id !== receipt.session_id ||
      accepted.session_id !== native.session_id)
  )
    accepted = null;
  if (receipt && runners.has(state)) {
    if (!accepted) {
      accepted = acceptedPrompt({ ...meta, tail }, state, obs, receipt);
      if (accepted) {
        accepted.payload_hash = receipt.payload_hash;
        accepted.receipt_id = receiptIdentity(receipt);
        // An inspection may finish after another process has acknowledged or sent.
        // Persist only under the shared mutation lock and for the same receipt.
        if (process.env.TMUX_MODEL_DRIVER_READ_ONLY !== '1' && acquireLock(files)) {
          try {
            const current = readReceipt(files);
            if (
              current &&
              receiptIdentity(current) === accepted.receipt_id &&
              current.payload_hash === accepted.payload_hash
            ) {
              durableWrite(files.receipt, {
                ...current,
                session_id: accepted.session_id,
                accepted,
              });
            }
          } finally {
            fs.rmdirSync(files.lock);
          }
        }
      }
    }
  }
  const question = native.question || safety.question;
  const questionFingerprint = question
    ? hash(
        JSON.stringify({
          socket: process.env.TMUX_MODEL_DRIVER_SOCKET || process.env.TMUX || 'default',
          pane_id: meta.pane_id,
          pane_pid: meta.pane_pid,
          process_started_at: meta.process_started_at,
          session_id: native.session_id,
          question,
        }),
      )
    : null;
  const queued = safety.queued || Boolean(receipt && !accepted);
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
    queue_kind: safety.queued ? 'runner-queue' : receipt && !accepted ? 'driver-buffer' : null,
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
    buffered_digest: receipt && !accepted ? receipt.payload_hash : null,
  };
}

export function acknowledgeAcceptance(pane, runner, receiptId) {
  const before = paneState(pane, runner);
  let verification = before.state !== runner ? 'wrong_runner' : null;
  const files = paths(before);
  let locked = false;
  try {
    if (!verification) {
      locked = acquireLock(files);
      if (!locked)
        verification = wasAcknowledged(files, receiptId) ? 'already_acknowledged' : 'driver_busy';
    }
    if (!verification) {
      const current = paneState(pane, runner);
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
    if (locked) fs.rmdirSync(files.lock);
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
    if (locked) fs.rmdirSync(files.lock);
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
  if (before.accepted) return 'acceptance_unacknowledged';
  if (flush || !supportsMidTurnPrompt(runner)) {
    if (before.delivery_phase === 'busy' || before.phase === 'busy') return 'busy';
    if (before.delivery_phase !== 'idle') return 'observability_unavailable';
  }
  if (flush) return before.queue_kind === 'driver-buffer' ? null : 'queue_not_owned';
  return before.queued ? 'queued_input' : null;
}

export async function send(pane, runner, payload, tracePath, flush = false) {
  let before = paneState(pane, runner);
  let after = before;
  let verification = refusal(before, runner, flush);
  let evidence = null;
  let typed = false;
  const files = paths(before);
  const timeout = Number(process.env.TMUX_MODEL_DRIVER_VERIFY_TIMEOUT_MS || 3000);
  let scratch = null;
  let locked = false;
  try {
    if (!verification) {
      locked = acquireLock(files);
      if (!locked) verification = 'driver_busy';
    }
    if (!verification) {
      before = paneState(pane, runner);
      verification = refusal(before, runner, flush);
    }
    if (!verification) {
      let receipt;
      if (flush) {
        receipt = JSON.parse(fs.readFileSync(files.receipt, 'utf8'));
        if (!receipt.typed || !before.tail.includes(receipt.payload))
          verification = 'queue_buffer_unconfirmed';
        if (payload && hash(payload) !== receipt.payload_hash)
          verification = 'queued_payload_mismatch';
        payload = receipt.payload;
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
            typed: false,
          };
          durableWrite(files.receipt, receipt);
        }
      }
      if (!verification) {
        let transportPayload = payload;
        if (runner === 'shell') {
          scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-model-driver-shell-'));
          transportPayload = `printf started > ${quote(path.join(scratch, 'started'))}; ${payload}`;
        }
        if (!flush) {
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
        after = paneState(pane, runner);
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
            durableWrite(files.receipt, receipt);
          }
        }
        verification ||= 'unverified';
        const deadline = Date.now() + timeout;
        if (verification === 'unverified') {
          do {
            after = paneState(pane, runner);
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
                clearAcceptedReceipt(files, current);
              }
              verification = 'submitted';
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
              verification = 'queued';
              break;
            }
            await delay(40);
          } while (Date.now() < deadline);
        }
      }
    }
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true });
    if (locked) fs.rmdirSync(files.lock);
  }
  const result = {
    pane_id: pane,
    session_name: before.session_name,
    action_kind: runner,
    payload,
    before_state: before.state,
    after_state: after.state,
    verification,
    submitted: verification === 'submitted',
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
  if (operation !== 'state' && !result.submitted && !result.queued && !result.acknowledged)
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
