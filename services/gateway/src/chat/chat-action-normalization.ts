// chat/chat-action-normalization.ts — Normalize model-suggested actions into server-owned payloads.

import {
  AGENT_ROLES,
  type AgentRole,
  type ChatSuggestedAction,
  FLOW_STEPS,
  type FlowType,
  type RunCreateParams,
} from '@farmslot/protocol';

import { normalizeTicketRef } from '../methods/dispatch/ticket-ref.js';
import { getAllRuns, getRun } from '../runs/store.js';

export type SupportedChatActionType =
  | 'run.create'
  | 'run.cancel'
  | 'run.delete'
  | 'run.replayStep'
  | 'slot.release'
  | 'slot.prepare'
  | 'terminal.send'
  | 'decision.resolve'
  | 'memory.update';

export interface NormalizedChatAction {
  type: SupportedChatActionType;
  label: string;
  params: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  // structuredClone copes with Date/Map/BigInt/etc; JSON round-trip throws.
  // Action params are typed Record<string, unknown> so unsupported types
  // (functions, DOM nodes) shouldn't appear, but the safer primitive removes
  // the latent failure mode for free.
  return structuredClone(value) as Record<string, unknown>;
}

function compactLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return label ? label.slice(0, 120) : null;
}

export function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  return stringParam(params, key) ?? undefined;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function resolveKnownRunIdPrefix(value: string): string {
  const runId = value.trim();
  if (!runId) return runId;
  if (getRun(runId)) return runId;
  // Co-Pilot often summarizes runs with the same 8-char prefix shown in the UI.
  // Store the full UUID when that prefix is unambiguous so the later confirmed
  // action can pass the same server-side guards as an exact-id action.
  if (runId.length < 8) return runId;
  const matches = getAllRuns().filter((run) => run.id.startsWith(runId));
  return matches.length === 1 ? matches[0].id : runId;
}

export function normalizeFlowType(value: unknown): FlowType | null {
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(FLOW_STEPS, value) ? (value as FlowType) : null;
}

export function normalizeAgentRole(value: unknown): AgentRole | undefined {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
    ? (value as AgentRole)
    : undefined;
}

export function normalizeActionParams(action: ChatSuggestedAction): NormalizedChatAction | null {
  const label = compactLabel(action.label);
  if (!label || !isObject(action.params)) return null;

  if (action.type === 'run.create') {
    const flowType = normalizeFlowType(action.params.flowType);
    const project = stringParam(action.params, 'project');
    const ticketOrPr =
      stringParam(action.params, 'ticketOrPr') ?? stringParam(action.params, 'ticketUrl');
    if (!flowType || !project || !ticketOrPr) return null;
    const params = {
      flowType,
      project,
      ticketOrPr: normalizeTicketRef(ticketOrPr),
      ...(optionalStringParam(action.params, 'familyId')
        ? { familyId: optionalStringParam(action.params, 'familyId') }
        : {}),
      ...(optionalStringParam(action.params, 'parentRunId')
        ? { parentRunId: optionalStringParam(action.params, 'parentRunId') }
        : {}),
      ...(optionalStringParam(action.params, 'familyRootTicketOrPr')
        ? { familyRootTicketOrPr: optionalStringParam(action.params, 'familyRootTicketOrPr') }
        : {}),
      ...(optionalStringParam(action.params, 'slotId')
        ? { slotId: optionalStringParam(action.params, 'slotId') }
        : {}),
      ...(optionalStringParam(action.params, 'branch')
        ? { branch: optionalStringParam(action.params, 'branch') }
        : {}),
      ...(optionalStringParam(action.params, 'model')
        ? { model: optionalStringParam(action.params, 'model') }
        : {}),
      ...(optionalStringParam(action.params, 'runner')
        ? { runner: optionalStringParam(action.params, 'runner') }
        : {}),
      ...(optionalStringParam(action.params, 'effort')
        ? { effort: optionalStringParam(action.params, 'effort') }
        : {}),
      ...(optionalStringParam(action.params, 'app')
        ? { app: optionalStringParam(action.params, 'app') }
        : {}),
      ...(optionalStringParam(action.params, 'reviewTier')
        ? { reviewTier: optionalStringParam(action.params, 'reviewTier') }
        : {}),
      ...(optionalStringParam(action.params, 'mode') === 'interactive' ||
      optionalStringParam(action.params, 'mode') === 'autonomous' ||
      optionalStringParam(action.params, 'mode') === 'validation'
        ? { mode: optionalStringParam(action.params, 'mode') as RunCreateParams['mode'] }
        : {}),
      ...(booleanParam(action.params, 'skipPrepare') !== undefined
        ? { skipPrepare: booleanParam(action.params, 'skipPrepare') }
        : {}),
      ...(booleanParam(action.params, 'nudgeReuse') !== undefined
        ? { nudgeReuse: booleanParam(action.params, 'nudgeReuse') }
        : {}),
      ...(booleanParam(action.params, 'freshReuse') !== undefined
        ? { freshReuse: booleanParam(action.params, 'freshReuse') }
        : {}),
      ...(stringArrayParam(action.params, 'allowedSlots')
        ? { allowedSlots: stringArrayParam(action.params, 'allowedSlots') }
        : {}),
      // safetyTier is intentionally dropped here. Co-Pilot does not get to
      // pick the runner safety tier from a chat card; the operator must set
      // it via the dispatch wizard. Add it through the wizard, not here.
    } satisfies RunCreateParams;
    return { type: 'run.create', label, params };
  }

  if (action.type === 'run.cancel') {
    const rawRunId = stringParam(action.params, 'runId');
    if (!rawRunId) return null;
    const runId = resolveKnownRunIdPrefix(rawRunId);
    return {
      type: 'run.cancel',
      label,
      params: {
        runId,
        ...(optionalStringParam(action.params, 'reason')
          ? { reason: optionalStringParam(action.params, 'reason') }
          : {}),
      },
    };
  }

  if (action.type === 'run.delete') {
    const rawRunId = stringParam(action.params, 'runId');
    if (!rawRunId) return null;
    const runId = resolveKnownRunIdPrefix(rawRunId);
    return { type: 'run.delete', label, params: { runId } };
  }

  if (action.type === 'terminal.send') {
    const slotId = stringParam(action.params, 'slotId');
    const text = stringParam(action.params, 'text');
    if (!slotId || !text) return null;
    return {
      type: 'terminal.send',
      label,
      params: {
        slotId,
        text,
        ...(booleanParam(action.params, 'enter') !== undefined
          ? { enter: booleanParam(action.params, 'enter') }
          : {}),
        ...(normalizeAgentRole(action.params.role)
          ? { role: normalizeAgentRole(action.params.role) }
          : {}),
        ...(optionalStringParam(action.params, 'contextId')
          ? { contextId: optionalStringParam(action.params, 'contextId') }
          : {}),
        ...(optionalStringParam(action.params, 'target')
          ? { target: optionalStringParam(action.params, 'target') }
          : {}),
      },
    };
  }

  if (action.type === 'memory.update') {
    const content = stringParam(action.params, 'content');
    if (!content) return null;
    return { type: 'memory.update', label, params: { content } };
  }

  if (action.type === 'decision.resolve') {
    const decisionId = stringParam(action.params, 'decisionId');
    const actionId = stringParam(action.params, 'actionId') ?? stringParam(action.params, 'choice');
    if (!decisionId || !actionId) return null;
    return { type: 'decision.resolve', label, params: { decisionId, actionId } };
  }

  if (action.type === 'run.replayStep') {
    const rawRunId = stringParam(action.params, 'runId');
    const step = stringParam(action.params, 'step');
    if (!rawRunId || !step) return null;
    const runId = resolveKnownRunIdPrefix(rawRunId);
    return { type: 'run.replayStep', label, params: { runId, step } };
  }

  if (action.type === 'slot.release') {
    const slotId = stringParam(action.params, 'slotId');
    if (!slotId) return null;
    return { type: 'slot.release', label, params: { slotId } };
  }

  if (action.type === 'slot.prepare') {
    const slotId = stringParam(action.params, 'slotId');
    if (!slotId) return null;
    // {slotId} ONLY — no branch, no mergeMain, no project-scoped vars. Server
    // resolves default branch internally. Project-scoped vars (FARMSLOT_VAR_*)
    // are never accepted from chat cards; operator sets them via the dispatch
    // wizard or `slot.prepare` direct API.
    return { type: 'slot.prepare', label, params: { slotId } };
  }

  return null;
}
