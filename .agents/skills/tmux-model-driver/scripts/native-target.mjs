import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  durableWrite,
  privateDirectory,
  readJson,
} from '../../../../packages/agent-runtime/src/native/storage.ts';
import { GatewayClient } from '../../../../packages/cli/src/gateway-client.ts';
import { resolveGatewayTarget } from '../../../../packages/cli/src/gateway-profiles.ts';

import { acquireLock, releaseLock } from './driver.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function descriptor(target) {
  const file = target.slice('native:'.length);
  if (!path.isAbsolute(file)) throw new Error('Native target requires an absolute descriptor path');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['gateway', 'sessionId', 'executionNodeId', 'generation'].every((key) =>
      nonempty(value[key]),
    ) ||
    Object.keys(value).some(
      (key) => !['gateway', 'sessionId', 'executionNodeId', 'generation', 'worker'].includes(key),
    )
  )
    throw new Error(
      'Native target requires gateway profile, sessionId, executionNodeId and generation',
    );
  if (
    value.worker !== undefined &&
    (!value.worker ||
      typeof value.worker !== 'object' ||
      !['runId', 'contextId', 'generation', 'leaseId'].every((key) =>
        nonempty(value.worker[key]),
      ) ||
      Object.keys(value.worker).some(
        (key) => !['runId', 'contextId', 'generation', 'leaseId'].includes(key),
      ))
  )
    throw new Error('Native worker target requires exact run, context, generation and lease');
  return {
    gateway: value.gateway,
    executionNodeId: value.executionNodeId,
    sessionId: value.sessionId,
    generation: value.generation,
    ...(value.worker
      ? {
          worker: {
            runId: value.worker.runId,
            contextId: value.worker.contextId,
            generation: value.worker.generation,
            leaseId: value.worker.leaseId,
          },
        }
      : {}),
  };
}

async function connectGateway(gateway) {
  const target = resolveGatewayTarget({ gateway });
  const client = new GatewayClient({
    url: target.url,
    timeout: 15_000,
    credential: target.credential,
  });
  return { connection: await client.connect(), url: target.url };
}

function currentTarget(page, target, runner) {
  if (
    page.session.id !== target.sessionId ||
    page.session.executionNodeId !== target.executionNodeId ||
    page.session.generation !== target.generation
  )
    return 'stale_target';
  if (runner && page.session.runner !== runner) return 'wrong_runner';
  if (
    page.session.workerManaged &&
    (!target.worker ||
      page.scope?.released ||
      page.scope?.leaseId !== target.worker.leaseId ||
      page.session.workerLeaseId !== target.worker.leaseId)
  )
    return 'stale_worker';
  return null;
}

function questionState(page, target) {
  const event = page.pendingRequests[0];
  if (!event) return { pending_question: false, question: null, question_fingerprint: null };
  return {
    pending_question: true,
    question: { ...event.request, type: event.type, responseState: event.responseState },
    question_fingerprint: hash([target, event.generation, event.type, event.request]),
  };
}

function delivery(receipt) {
  const cancelled = receipt.outcome === 'cancelled';
  const verification =
    !cancelled && receipt.accepted
      ? 'submitted'
      : !cancelled && receipt.queued
        ? 'queued'
        : 'unverified';
  return {
    verification,
    submitted: verification !== 'unverified',
    queued: verification === 'queued',
    evidence: { source: 'native-session-rpc', ...receipt },
  };
}

function readSaved(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function responseFor(question, input) {
  const response = JSON.parse(input);
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new Error('Native answers require a response object');
  if (question.type === 'approval.requested') {
    if (!['approve', 'deny'].includes(response.decision) || Object.keys(response).length !== 1)
      throw new Error('An approval requires an explicit approve or deny decision');
    return response;
  }
  const questions = question.questions ?? [];
  const answers = response.answers;
  if (
    Object.keys(response).length !== 1 ||
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers) ||
    Object.keys(answers).length !== questions.length ||
    !questions.length ||
    !questions.every(
      (q) =>
        Array.isArray(answers[q.id]) &&
        answers[q.id].length > 0 &&
        (q.multiSelect || answers[q.id].length === 1) &&
        answers[q.id].every(nonempty),
    )
  )
    throw new Error(
      'Answer each current question explicitly, using option labels or a custom answer',
    );
  return response;
}

/** Native targets never use tmux, process-name guesses or alternate credentials. */
export async function runNative(args, options = {}) {
  const { operation, target: name, runner, input = '', argument } = args;
  const target = descriptor(name);
  if (!['state', 'read', 'send', 'answer', 'ack'].includes(operation))
    return { submitted: false, verification: 'unsupported_native_operation' };
  const after = operation === 'read' && argument !== undefined ? Number(argument) : undefined;
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
    throw new Error('Invalid native read cursor');
  const { connection, url } = await (options.connect ?? connectGateway)(target.gateway);
  let files,
    locked = false;
  const base = { target: name, action_kind: runner, submitted: false, verification: 'unverified' };
  const rpcTarget = {
    sessionId: target.sessionId,
    executionNodeId: target.executionNodeId,
    ...(target.worker ? { worker: target.worker } : {}),
  };
  try {
    const root = path.join(
      options.stateDir ??
        process.env.TMUX_MODEL_DRIVER_STATE_DIR ??
        path.join(os.tmpdir(), `tmux-model-driver-${process.getuid?.() ?? 'user'}`),
      'native',
    );
    privateDirectory(root);
    const key = hash([url, target]);
    files = { lock: path.join(root, `${key}.lock`) };
    const mutating = ['send', 'answer', 'ack'].includes(operation);
    if (mutating) {
      locked = acquireLock(files);
      if (!locked) return { ...base, verification: 'driver_busy' };
    }
    const page = await connection.call('native.session.read', {
      ...rpcTarget,
      limit: 200,
      ...(after !== undefined ? { after } : {}),
    });
    const invalid = currentTarget(page, target, runner);
    if (invalid) return { ...base, verification: invalid };
    const state = {
      ...base,
      state: page.session.runner,
      phase: page.session.state,
      confidence: 'native',
      session_id: target.sessionId,
      generation: target.generation,
      evidence_source: 'native-session-rpc',
      ...questionState(page, target),
    };
    if (operation === 'state' || operation === 'read')
      return {
        ...state,
        verification: operation === 'read' ? 'read' : state.verification,
        events: page.events,
        cursor: page.cursor,
        hasMore: page.hasMore,
        commands: page.commands,
        pendingRequests: page.pendingRequests,
      };
    if (operation === 'answer') {
      if (!state.pending_question || state.question_fingerprint !== argument)
        return { ...state, verification: 'question_changed' };
      if (state.question.responseState === 'unknown')
        return { ...state, verification: 'unverified' };
      const response = responseFor(state.question, input);
      const file = path.join(root, `${key}-answer-${argument}.json`);
      const saved = readSaved(file);
      // Respond has no idempotency key. Never repeat an attempt with an unknown outcome.
      if (saved)
        return {
          ...state,
          verification:
            saved.responseHash !== hash(response)
              ? 'response_mismatch'
              : saved.confirmed
                ? 'response_sent'
                : 'unverified',
          action_sent: saved.responseHash === hash(response) && saved.confirmed,
        };
      durableWrite(file, {
        requestId: state.question.id,
        responseHash: hash(response),
        confirmed: false,
      });
      try {
        await connection.call('native.session.respond', {
          ...rpcTarget,
          requestId: state.question.id,
          ...response,
        });
        durableWrite(file, {
          requestId: state.question.id,
          responseHash: hash(response),
          confirmed: true,
        });
        return { ...state, action_sent: true, verification: 'response_sent' };
      } catch (error) {
        return { ...state, error: error.message };
      }
    }
    if (operation === 'ack') {
      if (!/^[a-f0-9]{64}:[a-f0-9-]{36}$/.test(argument ?? ''))
        return { ...state, verification: 'receipt_mismatch' };
      const [payloadHash, commandId] = argument.split(':');
      const acknowledged = path.join(root, `${key}-ack-${commandId}.json`);
      if (readSaved(acknowledged))
        return { ...state, acknowledged: true, verification: 'acknowledged' };
      const file = path.join(root, `${key}-${payloadHash}.json`);
      const saved = readSaved(file);
      if (!saved || saved.commandId !== commandId)
        return { ...state, verification: 'receipt_mismatch' };
      const receipt = page.commands.find(
        (command) => command.commandId === commandId && command.generation === target.generation,
      );
      if (!receipt || !delivery(receipt).submitted) return { ...state, verification: 'unverified' };
      durableWrite(file, { ...saved, acknowledged: true });
      durableWrite(acknowledged, { commandId, payloadHash });
      return { ...state, acknowledged: true, verification: 'acknowledged' };
    }
    if (!input.trim()) return { ...state, verification: 'empty_payload' };
    const payloadHash = hash(input);
    const file = path.join(root, `${key}-${payloadHash}.json`);
    let saved = readSaved(file);
    if (saved?.acknowledged) saved = null;
    const receipt =
      saved &&
      page.commands.find(
        (command) =>
          command.commandId === saved.commandId && command.generation === target.generation,
      );
    if (receipt)
      return { ...state, ...delivery(receipt), receipt_id: `${payloadHash}:${saved.commandId}` };
    if (state.pending_question) return { ...state, verification: 'pending_question' };
    if (['closing', 'closed', 'failed'].includes(page.session.state))
      return { ...state, verification: 'session_unavailable' };
    if (!saved) {
      saved = { commandId: randomUUID(), payloadHash, generation: target.generation };
      durableWrite(file, saved);
    }
    try {
      // Retries reuse the durable commandId even if the previous reply was lost or aged out.
      const receipt = await connection.call('native.session.send', {
        ...rpcTarget,
        commandId: saved.commandId,
        text: input,
      });
      if (receipt.commandId !== saved.commandId)
        return { ...state, verification: 'receipt_mismatch' };
      return { ...state, ...delivery(receipt), receipt_id: `${payloadHash}:${saved.commandId}` };
    } catch (error) {
      return {
        ...state,
        receipt_id: `${payloadHash}:${saved.commandId}`,
        evidence: { commandId: saved.commandId, payloadHash },
        error: error.message,
      };
    }
  } finally {
    if (locked) releaseLock(files);
    connection.close();
  }
}
