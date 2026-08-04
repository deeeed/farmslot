// methods/terminal-attachment.ts — terminal.attachment.upload / .deliver / .cleanup
//
// Upload stages image bytes under Farmslot-managed temporary storage on the slot machine
// (local fs or the node binary write path, identically). Delivery is a separate call that
// hands the staged path to the runner's registered attachment provider, so a completed
// upload never implies the runner received the image.

import {
  isTerminalAttachmentCleanupScope,
  TERMINAL_ATTACHMENT_CLEANUP_SCOPES,
  type TerminalAttachmentCleanupParams,
  type TerminalAttachmentCleanupResult,
  type TerminalAttachmentCleanupScope,
  type TerminalAttachmentDeliverParams,
  type TerminalAttachmentDeliverResult,
  type TerminalAttachmentUploadParams,
  type TerminalAttachmentUploadResult,
} from '@farmslot/protocol';
import { normalizeRunner } from '@farmslot/protocol';

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import {
  GatewayMethodError,
  readSlotField,
  slotDeletePath,
  slotFileExists,
  slotListDir,
  slotMkdir,
  slotStat,
  slotWriteFiles,
} from '../core/index.js';
import {
  getRunnerAttachmentProvider,
  runnerAttachmentUnsupportedDetail,
} from '../runners/attachment-provider.js';

import {
  isStaleTerminalAttachment,
  isTerminalAttachmentStoredName,
  resolveTerminalAttachmentPath,
  sha256Hex,
  terminalAttachmentDir,
  terminalAttachmentStoredName,
  validateTerminalAttachmentChunk,
} from './terminal-attachment-model.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

/**
 * Ownership check: the slot must exist in a pool config (loadSlotVars throws otherwise) and
 * the requested run/role selector must resolve to a tmux target that belongs to that slot.
 */
async function resolveAttachmentTarget(
  params: TerminalAttachmentUploadParams | TerminalAttachmentDeliverParams,
): Promise<{ vars: SlotVars; target: string; dir: string; runner: string | null }> {
  const vars = await loadSlotVars(params.slotId);
  const resolved = await resolveAgentTarget(params.slotId, params);
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  return {
    vars,
    target: resolved.target,
    dir: terminalAttachmentDir(vars.remoteRepo, runtimeDir),
    // The selected agent context owns the runner: a Codex reviewer context can sit beside a
    // Claude primary on one slot, so the slot-level field is only a fallback for bare-session
    // terminals with no resolved context. Choosing the wrong one would run one runner's
    // delivery interaction against another runner's pane.
    runner: resolved.runner
      ? normalizeRunner(resolved.runner)
      : await resolveSlotRunner(params.slotId),
  };
}

async function resolveSlotRunner(slotId: string): Promise<string | null> {
  const raw = (await readSlotField(slotId, 'runner')) as string | null;
  const trimmed = raw?.trim();
  return trimmed ? normalizeRunner(trimmed) : null;
}

/**
 * Chunks accepted so far for an in-flight upload. An interrupted upload leaves an entry here
 * and never reaches the filesystem, so this map is bounded three ways: an age sweep, a total
 * byte ceiling with oldest-first eviction, and slot-scoped clearing on lifecycle cleanup.
 */
interface PendingUpload {
  slotId: string;
  /** tmux target resolved when this upload started; later chunks must resolve to the same one. */
  target: string;
  mimeType: string;
  byteLength: number;
  chunks: Array<Buffer | undefined>;
  updatedAt: number;
}

const PENDING_UPLOAD_TTL_MS = 10 * 60 * 1000;
/** Ceiling across all in-flight uploads; oldest partial buffers are evicted first. */
const PENDING_UPLOAD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const pendingUploads = new Map<string, PendingUpload>();

function pendingKey(slotId: string, attachmentId: string): string {
  return `${slotId}:${attachmentId}`;
}

function sweepPendingUploads(now = Date.now()): void {
  for (const [key, pending] of pendingUploads) {
    if (now - pending.updatedAt > PENDING_UPLOAD_TTL_MS) pendingUploads.delete(key);
  }
}

/**
 * Age alone does not bound memory: enough concurrent uploads inside the TTL window would still
 * grow without limit. Evict oldest-first until the retained buffers fit the ceiling.
 */
function enforcePendingUploadByteCeiling(): void {
  let total = 0;
  for (const pending of pendingUploads.values()) total += receivedBytesOf(pending);
  if (total <= PENDING_UPLOAD_MAX_TOTAL_BYTES) return;
  const oldestFirst = [...pendingUploads.entries()].sort(
    ([, a], [, b]) => a.updatedAt - b.updatedAt,
  );
  for (const [key, pending] of oldestFirst) {
    if (total <= PENDING_UPLOAD_MAX_TOTAL_BYTES) break;
    total -= receivedBytesOf(pending);
    pendingUploads.delete(key);
    console.warn(`[terminal-attachment] evicted partial upload ${key} to stay under the ceiling`);
  }
}

function clearPendingUploadsForSlot(slotId: string): number {
  let cleared = 0;
  for (const [key, pending] of pendingUploads) {
    if (pending.slotId !== slotId) continue;
    pendingUploads.delete(key);
    cleared++;
  }
  return cleared;
}

function receivedBytesOf(pending: PendingUpload): number {
  return pending.chunks.reduce((total, chunk) => total + (chunk?.byteLength ?? 0), 0);
}

export async function terminalAttachmentUpload(
  params: TerminalAttachmentUploadParams,
): Promise<TerminalAttachmentUploadResult> {
  const validated = validateTerminalAttachmentChunk(params);
  // Target ownership is checked on every chunk, not only the first, so a mid-upload
  // retarget cannot smuggle bytes onto a slot the caller never resolved.
  const { vars, dir, target, runner } = await resolveAttachmentTarget(params);

  sweepPendingUploads();
  const key = pendingKey(params.slotId, validated.attachmentId);
  const existing = pendingUploads.get(key);
  // Later chunks must land on the pane the upload started against. Switching run/role/context
  // mid-upload would otherwise stitch one image out of bytes destined for two different panes.
  if (existing && existing.target !== target) {
    pendingUploads.delete(key);
    throw new GatewayMethodError(
      'ATTACHMENT_TARGET_CHANGED',
      `Attachment ${validated.attachmentId} started against ${existing.target} but this chunk resolved to ${target}`,
      { userAction: 'Re-attach the image on the terminal you want it delivered to.' },
    );
  }
  // A restarted upload for the same id (retry after interruption) must not merge with the
  // stale partial buffer of a different image.
  const pending =
    existing &&
    existing.byteLength === validated.byteLength &&
    existing.mimeType === validated.mimeType
      ? existing
      : {
          slotId: params.slotId,
          target,
          mimeType: validated.mimeType,
          byteLength: validated.byteLength,
          chunks: [],
          updatedAt: 0,
        };
  pending.chunks.length = validated.chunkCount;
  pending.chunks[validated.chunkIndex] = validated.chunk;
  pending.updatedAt = Date.now();
  pendingUploads.set(key, pending);
  enforcePendingUploadByteCeiling();

  const receivedBytes = receivedBytesOf(pending);
  if (receivedBytes < validated.byteLength) {
    return {
      attachmentId: validated.attachmentId,
      complete: false,
      receivedBytes,
      byteLength: validated.byteLength,
      mimeType: validated.mimeType,
    };
  }

  pendingUploads.delete(key);
  const bytes = Buffer.concat(pending.chunks.map((chunk) => chunk ?? Buffer.alloc(0)));
  const storedName = terminalAttachmentStoredName(validated.attachmentId, validated.mimeType);
  const storedPath = resolveTerminalAttachmentPath(dir, storedName);
  if (!storedPath) {
    throw new GatewayMethodError(
      'ATTACHMENT_PATH_ESCAPE',
      `Refusing to stage attachment outside ${dir}`,
    );
  }

  await slotMkdir(vars, dir);
  await sweepStaleAttachments(vars, dir);

  // Same attachmentId → same staged file. A duplicate paste/drop of an in-flight
  // attachment therefore re-stages identical bytes instead of creating a second target
  // the UI could deliver twice.
  const reused = await slotFileExists(vars, storedPath);
  await slotWriteFiles(vars, dir, [
    { path: storedName, content: bytes.toString('base64'), mode: 0o600 },
  ]);

  const sha256 = sha256Hex(bytes);
  stagedTargets.set(storedPath, { slotId: params.slotId, target });
  console.log(
    `[terminal-attachment] staged slot=${params.slotId} id=${validated.attachmentId} target=${target} runner=${runner ?? 'none'} bytes=${bytes.byteLength} sha256=${sha256} path=${storedPath} reused=${reused}`,
  );
  return {
    attachmentId: validated.attachmentId,
    complete: true,
    receivedBytes: bytes.byteLength,
    byteLength: bytes.byteLength,
    mimeType: validated.mimeType,
    storedPath,
    storedName,
    sha256,
    runner,
    deliverySupported: getRunnerAttachmentProvider(runner) !== null,
    reused,
    target,
  };
}

/**
 * Target each staged file was uploaded for. Delivery re-resolves the caller's selector and must
 * land on the same pane, so a target switch between upload and submit cannot deliver an image to
 * a terminal the operator never attached it to.
 */
const stagedTargets = new Map<string, { slotId: string; target: string }>();

export async function terminalAttachmentDeliver(
  params: TerminalAttachmentDeliverParams,
): Promise<TerminalAttachmentDeliverResult> {
  const { vars, target, dir, runner } = await resolveAttachmentTarget(params);
  // The browser sends back the path it was given; re-derive and re-contain it so a tampered
  // client cannot point delivery at an arbitrary file.
  const expectedPath = resolveTerminalAttachmentPath(dir, basenameOf(params.storedPath));
  if (!expectedPath || expectedPath !== params.storedPath) {
    throw new GatewayMethodError(
      'ATTACHMENT_PATH_ESCAPE',
      `Attachment path ${params.storedPath} is not inside ${dir}`,
    );
  }
  if (!(await slotFileExists(vars, expectedPath))) {
    throw new GatewayMethodError(
      'ATTACHMENT_MISSING',
      `Staged attachment ${params.attachmentId} is no longer on ${params.slotId}`,
      { userAction: 'Re-attach the image; the staged copy was cleaned up.' },
    );
  }
  // Bound at upload time. A record missing after a gateway restart is not evidence of a switch,
  // so only a recorded-and-different target refuses delivery.
  const staged = stagedTargets.get(expectedPath);
  if (staged && (staged.slotId !== params.slotId || staged.target !== target)) {
    throw new GatewayMethodError(
      'ATTACHMENT_TARGET_CHANGED',
      `Attachment ${params.attachmentId} was staged for ${staged.slotId}/${staged.target} but delivery resolved to ${params.slotId}/${target}`,
      { userAction: 'Re-attach the image on the terminal you want it delivered to.' },
    );
  }

  const provider = getRunnerAttachmentProvider(runner);
  if (!provider) {
    console.log(
      `[terminal-attachment] unsupported slot=${params.slotId} runner=${runner ?? 'none'} id=${params.attachmentId}`,
    );
    return {
      attachmentId: params.attachmentId,
      status: 'unsupported',
      runner,
      detail: runnerAttachmentUnsupportedDetail(runner),
    };
  }

  const stat = await slotStat(vars, expectedPath);
  const result = await provider.deliver({
    vars,
    target,
    storedPath: expectedPath,
    filename: params.filename,
    byteLength: stat.size,
  });
  console.log(
    `[terminal-attachment] delivery slot=${params.slotId} runner=${provider.id} id=${params.attachmentId} status=${result.status}`,
  );
  return {
    attachmentId: params.attachmentId,
    status: result.status,
    runner: provider.id,
    detail: result.detail,
  };
}

function basenameOf(candidate: string): string {
  const parts = candidate.split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Bounded sweep for interrupted uploads: staged files older than the stale window are
 * removed whenever the directory is touched, so an aborted upload cannot accumulate.
 */
async function sweepStaleAttachments(
  vars: SlotVars,
  dir: string,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await listAttachmentNames(vars, dir)) {
    const filePath = `${dir}/${name}`;
    const stat = await slotStat(vars, filePath);
    // Fails closed on an unusable timestamp; `scope: 'all'` cleanup still reclaims those at the
    // end of the owning session.
    if (!isStaleTerminalAttachment(stat.mtimeMs, now)) continue;
    await slotDeletePath(vars, filePath);
    stagedTargets.delete(filePath);
    removed.push(name);
  }
  if (removed.length) {
    console.log(`[terminal-attachment] swept ${removed.length} stale file(s) from ${dir}`);
  }
  return removed;
}

async function listAttachmentNames(vars: SlotVars, dir: string): Promise<string[]> {
  if (!(await slotFileExists(vars, dir))) return [];
  const names = await slotListDir(vars, dir);
  return names.filter(isTerminalAttachmentStoredName);
}

/**
 * Lifecycle cleanup. `all` empties the slot's staging directory (called when the owning
 * run/session ends); `stale` applies only the bounded age policy.
 */
export async function terminalAttachmentCleanup(
  params: TerminalAttachmentCleanupParams,
): Promise<TerminalAttachmentCleanupResult> {
  // `scope` arrives untyped from the wire. Anything unrecognised must be refused rather than
  // falling through to the destructive delete-everything branch.
  const requested = params.scope ?? 'all';
  if (!isTerminalAttachmentCleanupScope(requested)) {
    throw new GatewayMethodError(
      'ATTACHMENT_INVALID_SCOPE',
      `Unknown cleanup scope ${JSON.stringify(requested)}; expected one of ${TERMINAL_ATTACHMENT_CLEANUP_SCOPES.join(', ')}`,
    );
  }
  const scope: TerminalAttachmentCleanupScope = requested;
  const vars = await loadSlotVars(params.slotId);
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  const dir = terminalAttachmentDir(vars.remoteRepo, runtimeDir);
  // Interrupted uploads live only in memory, so lifecycle cleanup has to drop them too —
  // otherwise a partial buffer outlives the session that owned it and waits for an unrelated
  // upload to trigger the age sweep.
  const pendingCleared = clearPendingUploadsForSlot(params.slotId);
  if (scope === 'stale') {
    return {
      slotId: params.slotId,
      scope,
      removed: await sweepStaleAttachments(vars, dir),
      pendingCleared,
    };
  }
  const removed: string[] = [];
  for (const name of await listAttachmentNames(vars, dir)) {
    const filePath = `${dir}/${name}`;
    await slotDeletePath(vars, filePath);
    stagedTargets.delete(filePath);
    removed.push(name);
  }
  console.log(
    `[terminal-attachment] cleanup slot=${params.slotId} scope=${scope} removed=${removed.length} pendingCleared=${pendingCleared}`,
  );
  return { slotId: params.slotId, scope, removed, pendingCleared };
}
