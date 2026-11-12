// Entity sync (ADR-071 Amendment 4): stored, paged and pushed entities are untrusted. One set of
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

const everyOf = (value: unknown, each: (item: unknown) => boolean) =>
  Array.isArray(value) && value.every(each);
const absentOr = (value: unknown, check: (present: unknown) => boolean) =>
  value === undefined || value === null || check(value);

/**
 * The fields of a slot that summary, host-load reattachment, sorting and the slot views read
 * without a check of their own; the gateway's row transform always fills them.
 *
 * This is the boundary of admission: identity, and the fields list consumers dereference
 * unguarded. Everything else is trusted from the current gateway. A refused row is read again.
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
    // The slot view keys each agent context by its id and sorts them by label.
    absentOr(value.agentContexts, (contexts) =>
      everyOf(
        contexts,
        (context) => isRecord(context) && isString(context.id) && isString(context.label),
      ),
    ) &&
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

const isStrings = (value: unknown) => everyOf(value, isString);
const isCheck = (value: unknown) =>
  isRecord(value) && isString(value.name) && isString(value.status);
const isBotComment = (value: unknown) =>
  isRecord(value) && isString(value.author) && isString(value.createdAt);
const isReviewVerdict = (value: unknown) =>
  isRecord(value) && isString(value.reviewer) && isString(value.state);
const isReviewRequests = (value: unknown) =>
  isRecord(value) && isStrings(value.teams) && isStrings(value.users);

/**
 * The fields of a PR row the board, its filters and the project scopes read without a check,
 * down to the elements they dereference: a check, a bot comment, a reviewer.
 */
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
    everyOf(value.checks, isCheck) &&
    isStrings(value.failedNames) &&
    everyOf(value.botComments, isBotComment) &&
    everyOf(value.actionableBotComments, isBotComment) &&
    isCheckSummary(value.checkSummary) &&
    absentOr(value.allCheckSummary, isCheckSummary) &&
    absentOr(value.allPendingNames, isStrings) &&
    absentOr(value.allFailedNames, isStrings) &&
    absentOr(value.reviewVerdicts, (verdicts) => everyOf(verdicts, isReviewVerdict)) &&
    absentOr(value.reviewRequests, isReviewRequests)
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

/** Most ids one entity read may name. */
export const ENTITY_READ_MAX_IDS = 10_000;

/** A fleet.status or pr.list read: the view it reads and, for entity sync, its read shape. */
export type EntitySyncRead =
  | { ok: true; view: Record<string, unknown>; shape?: { versions: true } | { ids: string[] } }
  | { ok: false; message: string };

/**
 * Splits `{ versions: true }` or `{ ids }` from the view params they read. Both shapes read the
 * same resource as the view, so the gateway stamps and authorizes them as the view.
 */
export function entitySyncRead(params: unknown): EntitySyncRead {
  if (params === undefined || params === null) return { ok: true, view: {} };
  if (!isRecord(params)) return { ok: false, message: 'Read params must be an object' };
  const { versions, ids, ...view } = params;
  if (versions !== undefined && versions !== true)
    return { ok: false, message: 'versions must be true or absent' };
  if (ids !== undefined) {
    if (versions !== undefined) return { ok: false, message: 'Ask for versions or ids, not both' };
    if (
      !Array.isArray(ids) ||
      ids.length > ENTITY_READ_MAX_IDS ||
      !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024)
    )
      return {
        ok: false,
        message: `ids must be at most ${ENTITY_READ_MAX_IDS} non-empty strings`,
      };
    return { ok: true, view, shape: { ids } };
  }
  return versions === true ? { ok: true, view, shape: { versions: true } } : { ok: true, view };
}
