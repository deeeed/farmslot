// Entity sync (ADR-071 Amendment 3): stored, paged and pushed entities are untrusted. One set of
// guards admits them: the shape every consumer dereferences, the identity and the content version.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import type { PRStatus } from '../contracts/reviews.js';
import type { MachineHealth, SlotEntity } from '../contracts/slots.js';

import { canonicalResourceJson } from './keys.js';

const encoder = new TextEncoder();

/** An entity's version: sha256 of its canonical JSON, the same digest the gateway stores. */
export function entityContentVersion(entity: unknown): string {
  return bytesToHex(sha256(encoder.encode(canonicalResourceJson(entity))));
}

/** A pushed entity rides on its notification only up to this many UTF-8 JSON bytes. */
export const CHANGED_ENTITY_MAX_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullableString = (value: unknown) => value === null || typeof value === 'string';

/**
 * The fields of a slot that summary, host-load reattachment, sorting and the slot views read
 * without a check of their own; the gateway's row transform always fills them.
 */
export function isSlotEntity(value: unknown): value is SlotEntity {
  if (!isRecord(value) || !isRecord(value.health)) return false;
  const health = value.health;
  return (
    isString(value.slot) &&
    value.slot.length > 0 &&
    isString(value.machine) &&
    isString(value.platform) &&
    isString(value.project) &&
    isString(value.branch) &&
    isString(value.agent) &&
    isString(value.lifecycle) &&
    isNullableString(value.phase) &&
    typeof value.enabled === 'boolean' &&
    typeof value.dispatchable === 'boolean' &&
    typeof value.warm === 'boolean' &&
    isString(health.ssh) &&
    isString(health.device) &&
    isString(health.devserver) &&
    isString(health.cdp) &&
    isString(health.fixtures) &&
    // Host load is reattached from machine samples and never part of a slot entity.
    value.hostLoad === undefined
  );
}

function isCheckSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.passed) &&
    isNumber(value.failed) &&
    isNumber(value.pending) &&
    isNumber(value.skipped) &&
    isNumber(value.total)
  );
}

/** The fields of a PR row the board, its filters and the project scopes read without a check. */
export function isPRStatusEntity(value: unknown): value is PRStatus {
  return (
    isRecord(value) &&
    isString(value.repo) &&
    value.repo.length > 0 &&
    isNumber(value.pr) &&
    isString(value.title) &&
    isString(value.project) &&
    isString(value.prState) &&
    isString(value.recommendation) &&
    isString(value.mergeable) &&
    isString(value.reviewDecision) &&
    typeof value.allPassed === 'boolean' &&
    typeof value.anyFailed === 'boolean' &&
    typeof value.merged === 'boolean' &&
    typeof value.mergeConflict === 'boolean' &&
    Array.isArray(value.checks) &&
    Array.isArray(value.failedNames) &&
    Array.isArray(value.botComments) &&
    Array.isArray(value.actionableBotComments) &&
    isCheckSummary(value.checkSummary)
  );
}

/** The fields host-load reattachment and the machine bar read. */
export function isMachineHealthEntity(value: unknown): value is MachineHealth {
  if (!isRecord(value) || !isString(value.machine) || !value.machine) return false;
  if (typeof value.online !== 'boolean' || !isString(value.headroom)) return false;
  if (value.system === undefined) return true;
  const system = value.system;
  return (
    isRecord(system) &&
    isNumber(system.cpuPercent) &&
    isNumber(system.memoryPercent) &&
    isNumber(system.diskPercent)
  );
}

/** A PR's entity id within its list: `owner/repo/number`. */
export function prEntityId(row: Pick<PRStatus, 'repo' | 'pr'>): string {
  return `${row.repo}/${row.pr}`;
}

/** Admits an untrusted body only when its shape, identity and content version all match. */
export function admitEntity<T>(
  guard: (value: unknown) => value is T,
  idOf: (entity: T) => string,
  value: unknown,
  id: string,
  version: string,
): value is T {
  return (
    guard(value) &&
    idOf(value) === id &&
    typeof version === 'string' &&
    entityContentVersion(value) === version
  );
}
