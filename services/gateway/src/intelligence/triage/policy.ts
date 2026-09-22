import { open } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { digest } from '../../assessment/failure-triage/packet.js';
import type { TriagePrice } from '../../assessment/failure-triage/types.js';
import { assertNoCredentials } from '../../assessment/record-validation.js';

export interface TriageSourceApproval {
  runId: string;
  project: string;
  step: string;
  /** Binds the approval to the recorded failure, not just a reused run ID. */
  failureHash: string;
  sources: Array<{ logId: string; digest: string }>;
  origin: { kind: 'public' | 'synthetic'; reference: string };
}
export type TriagePolicy =
  | { enabled: false; policyVersion: string }
  | {
      enabled: true;
      policyVersion: string;
      projects: string[];
      receiptDirectory: string;
      maxCalls: number;
      maxUsd: number;
      price: TriagePrice;
      approvals: TriageSourceApproval[];
    };

/** Bounded reads apply to configuration and registered evidence; no tail/truncation. */
export async function readTriageFile(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Triage source is not a file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error('Triage source exceeds its byte limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f]/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((k) => allowed.includes(k));

export async function readTriagePolicy(): Promise<TriagePolicy> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readTriageFile(path.join(farmslotHome(), 'triage-policy.json'), 128 * 1024),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { enabled: false, policyVersion: 'absent' };
    throw error;
  }
  if (
    !object(value) ||
    !keys(value, [
      'enabled',
      'projects',
      'receiptDirectory',
      'maxCalls',
      'maxUsd',
      'price',
      'approvals',
    ]) ||
    typeof value.enabled !== 'boolean'
  )
    throw new Error('Invalid triage policy');
  assertNoCredentials(JSON.stringify(value));
  const policyVersion = digest(value);
  if (!value.enabled) return { enabled: false, policyVersion };
  if (
    !Array.isArray(value.projects) ||
    !value.projects.length ||
    value.projects.length > 20 ||
    !value.projects.every((p) => text(p) && /^[\w.-]+$/.test(p)) ||
    !text(value.receiptDirectory, 1000) ||
    !path.isAbsolute(value.receiptDirectory) ||
    !Number.isSafeInteger(value.maxCalls) ||
    Number(value.maxCalls) < 1 ||
    Number(value.maxCalls) > 60 ||
    typeof value.maxUsd !== 'number' ||
    !Number.isFinite(value.maxUsd) ||
    value.maxUsd <= 0 ||
    value.maxUsd > 0.1 ||
    !object(value.price) ||
    !Array.isArray(value.approvals) ||
    value.approvals.length > 100
  )
    throw new Error('Invalid triage policy');
  const price = value.price;
  if (
    !keys(price, [
      'version',
      'provider',
      'model',
      'verifiedAt',
      'source',
      'inputUsdPerMillion',
      'outputUsdPerMillion',
      'maxRequestTokens',
    ]) ||
    price.version !== 1 ||
    !text(price.provider) ||
    !text(price.model) ||
    !text(price.verifiedAt) ||
    !text(price.source, 1000) ||
    typeof price.inputUsdPerMillion !== 'number' ||
    typeof price.outputUsdPerMillion !== 'number' ||
    typeof price.maxRequestTokens !== 'number'
  )
    throw new Error('Invalid triage price');
  for (const a of value.approvals) {
    if (
      !object(a) ||
      !keys(a, ['runId', 'project', 'step', 'failureHash', 'sources', 'origin']) ||
      !text(a.runId) ||
      !text(a.project) ||
      !text(a.step) ||
      !hash(a.failureHash) ||
      !Array.isArray(a.sources) ||
      !a.sources.length ||
      a.sources.length > 4 ||
      !a.sources.every(
        (s) => object(s) && keys(s, ['logId', 'digest']) && text(s.logId) && hash(s.digest),
      ) ||
      !object(a.origin) ||
      !keys(a.origin, ['kind', 'reference']) ||
      !['public', 'synthetic'].includes(String(a.origin.kind)) ||
      !text(a.origin.reference, 1000)
    )
      throw new Error('Invalid triage source approval');
    if (a.origin.kind === 'public' && !/^https:\/\//.test(a.origin.reference))
      throw new Error('Public triage approval requires a source reference');
  }
  // Source permission comes from this operator-managed manifest, never RPC input.
  // Price identity/freshness/bounds are checked against the selected model before reservation.
  return {
    enabled: true,
    policyVersion,
    projects: value.projects as string[],
    receiptDirectory: value.receiptDirectory,
    maxCalls: Number(value.maxCalls),
    maxUsd: value.maxUsd,
    price: {
      version: 1,
      provider: price.provider,
      model: price.model,
      verifiedAt: price.verifiedAt,
      source: price.source,
      inputUsdPerMillion: price.inputUsdPerMillion,
      outputUsdPerMillion: price.outputUsdPerMillion,
      maxRequestTokens: price.maxRequestTokens,
    },
    approvals: value.approvals as TriageSourceApproval[],
  };
}
