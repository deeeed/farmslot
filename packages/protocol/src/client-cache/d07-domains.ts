import { ASSESSMENT_CONSUMERS } from '../contracts/assessment.js';
import { GLOBAL_CHAT_SESSION_ID } from '../surfaces/command-center.js';

import type { ResourceKey } from './keys.js';

/** Selectors only. Commands, arbitrary input packets, credentials and paths never enter IDs. */
export function domainParams(params: unknown, allowed: readonly string[]): Record<string, unknown> {
  const input = params ?? {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('Domain observations require an object');
  const value = Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined));
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Domain observations do not accept commands, paths or owner fields');
  return value;
}

export function domainId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value))
    throw new Error(`Invalid domain selector: ${name}`);
  return value;
}

export function idParams(params: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = domainParams(params, fields);
  for (const field of fields) domainId(value[field], field);
  return value;
}

export function assessmentHistoryParams(params: unknown): Record<string, unknown> {
  const value = domainParams(params, ['before', 'limit', 'consumer']);
  if (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 100))
    throw new Error('Invalid assessment cursor');
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
  )
    throw new Error('Invalid assessment page size');
  if (
    value.consumer !== undefined &&
    !ASSESSMENT_CONSUMERS.some((consumer) => consumer === value.consumer)
  )
    throw new Error('Invalid assessment consumer');
  return value;
}

export function triageParams(params: unknown): Record<string, unknown> {
  const value = domainParams(params, ['runId', 'step', 'includeEvidence']);
  domainId(value.runId, 'runId');
  if (
    value.step !== undefined &&
    (typeof value.step !== 'string' || !/^[\w .-]{1,100}$/.test(value.step))
  )
    throw new Error('Invalid triage step');
  if (value.includeEvidence !== undefined && typeof value.includeEvidence !== 'boolean')
    throw new Error('Invalid triage evidence selector');
  return value;
}

export function analyticsParams(params: unknown): Record<string, unknown> {
  const value = domainParams(params, [
    'project',
    'host',
    'flowType',
    'runner',
    'model',
    'lane',
    'since',
    'until',
  ]);
  for (const [field, entry] of Object.entries(value)) {
    if (field === 'since' || field === 'until') {
      if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry)))
        throw new Error(`Invalid analytics time: ${field}`);
      value[field] = new Date(entry).toISOString();
    } else if (field === 'model') {
      if (typeof entry !== 'string' || !entry || entry.length > 200 || /[\x00-\x1f]/.test(entry))
        throw new Error('Invalid analytics model');
    } else domainId(entry, field);
  }
  return value;
}

export function sessionContextParams(params: unknown): Record<string, unknown> {
  const value = domainParams(params, ['sessionId']);
  const id = typeof value.sessionId === 'string' ? value.sessionId.trim() : value.sessionId;
  const sessionId =
    id === undefined || id === '' || id === 'default'
      ? GLOBAL_CHAT_SESSION_ID
      : domainId(id, 'sessionId');
  if (sessionId.length > 160) throw new Error('Invalid chat session selector');
  return { sessionId };
}

export const prAutomationDependencies = (): ResourceKey[] => [
  { family: 'pr-automation', scope: 'farm' },
  { family: 'runs', scope: 'farm' },
  { family: 'planning', collection: 'dispatch-queue' },
  { family: 'configuration', scope: 'farm' },
];
export const assessmentDependencies = (): ResourceKey[] => [
  // No private assessment IDs are broadcast to other administrators.
  { family: 'assessment', scope: 'farm' },
];
export const copilotRuntimeKey = { family: 'copilot', ownerId: 'gateway-copilot' } as const;

export function observerEvidenceParams(params: unknown): Record<string, unknown> {
  const value = domainParams(params, ['windowMs', 'limit', 'severity', 'type', 'runId', 'slotId']);
  for (const field of ['windowMs', 'limit']) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== 'number' || !Number.isFinite(value[field]))
    )
      throw new Error(`Invalid observer selector: ${field}`);
  }
  if (value.severity !== undefined && !['info', 'warn', 'error'].includes(String(value.severity)))
    throw new Error('Invalid observer severity');
  for (const field of ['type', 'runId', 'slotId'])
    if (value[field] !== undefined) domainId(value[field], field);
  return {
    ...value,
    windowMs: Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1000, Math.floor(Number(value.windowMs ?? 2 * 60 * 60 * 1000))),
    ),
    limit: Math.min(50, Math.max(1, Math.floor(Number(value.limit ?? 20)))),
  };
}
