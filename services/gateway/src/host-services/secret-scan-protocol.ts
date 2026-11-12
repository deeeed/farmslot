// host-services/secret-scan-protocol.ts — messages between the gateway and its scan process.
import type { FloorHit } from '@farmslot/handoff/scrub';

/** One publication scan: the texts publication would carry, in order. */
export interface PublicationScanRequest {
  id: number;
  texts: string[];
}

/** The hits of the first text holding secret values (none when all are clean), or why the scan failed. */
export interface PublicationScanReply {
  id: number;
  hits?: FloorHit[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPublicationScanRequest(value: unknown): value is PublicationScanRequest {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.id) &&
    Array.isArray(value.texts) &&
    value.texts.every((text) => typeof text === 'string')
  );
}

function isFloorHit(value: unknown): value is FloorHit {
  return isRecord(value) && typeof value.kind === 'string' && typeof value.fingerprint === 'string';
}

export function isPublicationScanReply(value: unknown): value is PublicationScanReply {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) return false;
  if (value.hits !== undefined) return Array.isArray(value.hits) && value.hits.every(isFloorHit);
  return typeof value.error === 'string';
}
