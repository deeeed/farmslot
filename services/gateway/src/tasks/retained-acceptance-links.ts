import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  acceptanceCriterionId,
  type AcceptanceCriterionRef,
  type AcceptanceEvidenceLink,
} from '@farmslot/protocol';

import { writeAtomicJSON } from '../core/atomic-json.js';
import { sha256File } from '../run-completion/ready-gate-package.js';
import { runsDirectory } from '../runs/store.js';

// ADR-062 Amendment 8: import an explicitly reviewed inventory, never derive links.
export const RETAINED_LINK_SOURCE = '5d57e6675a3f86ebc21ae9a41072b61fb958e418';
export const RETAINED_LINK_HELPER_SHA256 =
  '93b9b04c76a37fff11b8ce0e6e5026cd9c111618f310ff6f1a41c9219b633b43';

interface RetainedFileRef {
  path: string;
  sha256: string;
}

interface RetainedLinkSource {
  commit: string;
  helperSha256: string;
  inventorySha256: string;
}

interface RetainedAcceptanceLinks {
  schemaVersion: 1;
  taskDir: string;
  source: RetainedLinkSource;
  handoffSha256: string;
  manifestSha256: string;
  criteria: AcceptanceCriterionRef[];
  links: AcceptanceEvidenceLink[];
  refs: RetainedFileRef[];
}

export interface RetainedLinkRead {
  evidenceLinks?: AcceptanceEvidenceLink[];
  evidenceLinksError?: string;
}

function record(value: unknown, label: string, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  const result = value as Record<string, unknown>;
  if (
    keys &&
    (keys.some((key) => !(key in result)) || Object.keys(result).some((key) => !keys.includes(key)))
  ) {
    throw new Error(`${label}: unexpected or missing fields`);
  }
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label}: expected nonempty string`);
  return value;
}

function digest(value: unknown): string {
  const result = text(value, 'digest');
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('digest: expected SHA256');
  return result;
}

function relativePath(value: unknown, artifact = false): string {
  const result = text(value, 'relative path');
  if (
    path.posix.isAbsolute(result) ||
    result.includes('\\') ||
    result.split('/').some((part) => !part || part === '.' || part === '..') ||
    (artifact && !result.startsWith('artifacts/'))
  ) {
    throw new Error(`noncanonical retained path: ${result}`);
  }
  return result;
}

function linksFrom(value: unknown): AcceptanceEvidenceLink[] {
  return array(value, 'links').map((entry) => {
    const row = record(entry, 'link', ['id', 'evidence']);
    return {
      id: text(row.id, 'criterion id'),
      evidence: array(row.evidence, 'evidence').map((ref) => relativePath(ref, true)),
    };
  });
}

function refsFrom(value: unknown, inventory = false): RetainedFileRef[] {
  return array(value, 'refs').map((entry) => {
    const row = record(entry, 'ref', inventory ? undefined : ['path', 'sha256']);
    if (inventory && (row.contained !== true || row.present !== true))
      throw new Error('retained reference was not verified present and contained');
    return { path: relativePath(row.path, true), sha256: digest(row.sha256) };
  });
}

function validateRelationships(snapshot: RetainedAcceptanceLinks): void {
  const ids = new Set(snapshot.criteria.map((row) => row.id));
  const seen = new Set<string>();
  for (const link of snapshot.links) {
    if (
      !ids.has(link.id) ||
      seen.has(link.id) ||
      link.evidence.length === 0 ||
      new Set(link.evidence).size !== link.evidence.length
    )
      throw new Error(`invalid retained criterion relationship: ${link.id}`);
    seen.add(link.id);
  }
  const linked = new Set(snapshot.links.flatMap((link) => link.evidence));
  const refs = new Set(snapshot.refs.map((ref) => ref.path));
  if (
    refs.size !== snapshot.refs.length ||
    linked.size !== refs.size ||
    [...linked].some((ref) => !refs.has(ref))
  )
    throw new Error('retained file inventory does not match links');
}

function parseSnapshot(value: unknown): RetainedAcceptanceLinks {
  const row = record(value, 'snapshot', [
    'schemaVersion',
    'taskDir',
    'source',
    'handoffSha256',
    'manifestSha256',
    'criteria',
    'links',
    'refs',
  ]);
  if (row.schemaVersion !== 1) throw new Error('unsupported retained-link snapshot version');
  const taskDir = text(row.taskDir, 'taskDir');
  if (!path.isAbsolute(taskDir) || path.normalize(taskDir) !== taskDir)
    throw new Error('snapshot task identity must be normalized and absolute');
  const source = record(row.source, 'source', ['commit', 'helperSha256', 'inventorySha256']);
  if (source.commit !== RETAINED_LINK_SOURCE || source.helperSha256 !== RETAINED_LINK_HELPER_SHA256)
    throw new Error('retained-link source identity mismatch');
  const snapshot: RetainedAcceptanceLinks = {
    schemaVersion: 1,
    taskDir,
    source: {
      commit: RETAINED_LINK_SOURCE,
      helperSha256: RETAINED_LINK_HELPER_SHA256,
      inventorySha256: digest(source.inventorySha256),
    },
    handoffSha256: digest(row.handoffSha256),
    manifestSha256: digest(row.manifestSha256),
    criteria: array(row.criteria, 'criteria').map((entry) => {
      const criterion = record(entry, 'criterion', ['id', 'text']);
      return {
        id: text(criterion.id, 'criterion id'),
        text: text(criterion.text, 'criterion text'),
      };
    }),
    links: linksFrom(row.links),
    refs: refsFrom(row.refs),
  };
  if (new Set(snapshot.criteria.map((criterion) => criterion.id)).size !== snapshot.criteria.length)
    throw new Error('duplicate retained criteria');
  validateRelationships(snapshot);
  return snapshot;
}

export function retainedAcceptanceLinksPath(taskDir: string): string {
  const identity = createHash('sha256').update(path.resolve(taskDir)).digest('hex');
  return path.join(runsDirectory(), 'retained-acceptance-links', `${identity}.json`);
}

async function snapshotAt(taskDir: string): Promise<RetainedAcceptanceLinks | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(retainedAcceptanceLinksPath(taskDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const snapshot = parseSnapshot(JSON.parse(bytes.toString('utf8')));
  if (snapshot.taskDir !== path.resolve(taskDir))
    throw new Error('retained-link task identity mismatch');
  return snapshot;
}

async function containedFile(taskDir: string, ref: string): Promise<string> {
  const root = await realpath(taskDir);
  const file = await realpath(path.join(taskDir, ref));
  if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile())
    throw new Error(`retained file escapes task or is not a file: ${ref}`);
  return file;
}

async function verifyOriginalBytes(snapshot: RetainedAcceptanceLinks): Promise<void> {
  if (!(await lstat(snapshot.taskDir)).isDirectory())
    throw new Error('retained task root must be a directory, not a symlink');
  for (const ref of [
    { path: 'inputs/handoff.json', sha256: snapshot.handoffSha256 },
    { path: 'artifacts/evidence-manifest.json', sha256: snapshot.manifestSha256 },
    ...snapshot.refs,
  ]) {
    const file = await containedFile(snapshot.taskDir, ref.path);
    if ((await sha256File(file)) !== ref.sha256)
      throw new Error(`retained bytes changed: ${ref.path}`);
  }
}

/** Display only. No snapshot means no manifest read or relationship derivation. */
export async function readRetainedAcceptanceLinks(
  taskDir: string,
  criteria: AcceptanceCriterionRef[],
): Promise<RetainedLinkRead> {
  try {
    const snapshot = await snapshotAt(taskDir);
    if (!snapshot) return {};
    if (!isDeepStrictEqual(snapshot.criteria, criteria))
      throw new Error('retained criterion identity mismatch');
    await verifyOriginalBytes(snapshot);
    return { evidenceLinks: snapshot.links };
  } catch (err) {
    return { evidenceLinksError: `retained acceptance links: ${(err as Error).message}` };
  }
}

export interface RetainedLinkImportResult {
  tasks: number;
  links: number;
  files: number;
}

/** Finite maintenance import. It accepts reviewed relationships and never parses covers. */
export async function importRetainedAcceptanceLinks(
  inventoryBytes: Buffer,
  taskRoot: string,
): Promise<RetainedLinkImportResult> {
  const inventory = record(JSON.parse(inventoryBytes.toString('utf8')), 'inventory');
  if (
    inventory.frozenSource !== RETAINED_LINK_SOURCE ||
    inventory.helperSha256 !== RETAINED_LINK_HELPER_SHA256
  )
    throw new Error('frozen retained-link inventory source mismatch');
  const source: RetainedLinkSource = {
    commit: RETAINED_LINK_SOURCE,
    helperSha256: RETAINED_LINK_HELPER_SHA256,
    inventorySha256: createHash('sha256').update(inventoryBytes).digest('hex'),
  };
  const root = await realpath(taskRoot);
  const snapshots: RetainedAcceptanceLinks[] = [];
  const identities = new Set<string>();
  for (const entry of array(inventory.records, 'records')) {
    const row = record(entry, 'inventory record');
    const taskDir = path.resolve(taskRoot, relativePath(row.task));
    const realTask = await realpath(taskDir);
    if (!realTask.startsWith(root + path.sep) || identities.has(taskDir))
      throw new Error('duplicate or escaping retained task identity');
    identities.add(taskDir);
    try {
      await lstat(path.join(taskDir, 'artifacts', 'acceptance-status.json'));
      throw new Error('retained-link import refuses a task with an existing ledger');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const handoffPath = await containedFile(taskDir, 'inputs/handoff.json');
    const handoff = record(JSON.parse(await readFile(handoffPath, 'utf8')), 'handoff');
    const task = record(handoff.task, 'handoff task');
    const criteria = array(task.acceptanceCriteria, 'registered criteria')
      .map((value, index) => ({ id: acceptanceCriterionId(index), text: String(value) }))
      .filter((criterion) => criterion.text.trim());
    const snapshot = parseSnapshot({
      schemaVersion: 1,
      taskDir,
      source,
      handoffSha256: row.handoffSha256,
      manifestSha256: row.manifestSha256,
      criteria,
      links: linksFrom(row.links),
      refs: refsFrom(row.refs, true),
    });
    await verifyOriginalBytes(snapshot);
    const existing = await snapshotAt(taskDir);
    if (existing && !isDeepStrictEqual(existing, snapshot))
      throw new Error('retained-link snapshot replacement refused');
    snapshots.push(snapshot);
  }
  // Validate every record before any write. An interrupted import can retry identically.
  for (const snapshot of snapshots) {
    const existing = await snapshotAt(snapshot.taskDir);
    if (existing && !isDeepStrictEqual(existing, snapshot))
      throw new Error('retained-link snapshot replacement refused');
    if (!existing) await writeAtomicJSON(retainedAcceptanceLinksPath(snapshot.taskDir), snapshot);
  }
  return {
    tasks: snapshots.length,
    links: snapshots.reduce((sum, row) => sum + row.links.length, 0),
    files: snapshots.reduce((sum, row) => sum + row.refs.length, 0),
  };
}
