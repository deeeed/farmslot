// terminal-attachment-model.ts — one state machine for both clipboard-image paste and
// terminal drag/drop. Upload and delivery are separate phases on purpose: a completed
// upload only means the bytes reached the slot, never that the runner saw the image.

import {
  isTerminalAttachmentMime,
  TERMINAL_ATTACHMENT_CHUNK_BYTES,
  TERMINAL_ATTACHMENT_MAX_BYTES,
  terminalAttachmentChunkCount,
  type TerminalAttachmentDeliverResult,
  type TerminalAttachmentUploadResult,
} from '@farmslot/protocol';

export type TerminalAttachmentPhase =
  | 'uploading'
  | 'uploaded'
  | 'delivering'
  | 'attached'
  | 'unsupported'
  | 'failed';

export interface TerminalAttachment {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  /** Object URL for the thumbnail; the owner revokes it on remove. */
  previewUrl: string;
  phase: TerminalAttachmentPhase;
  /** 0–100, derived from acknowledged chunk bytes. */
  uploadPercent: number;
  storedPath?: string;
  runner?: string | null;
  detail: string;
}

/** Phases where a repeat paste/drop/submit must not start a second send. */
export function isTerminalAttachmentActive(attachment: TerminalAttachment): boolean {
  return attachment.phase === 'uploading' || attachment.phase === 'delivering';
}

/** Failure keeps the card so the operator can retry; success and removal drop it. */
export function isTerminalAttachmentRetryable(attachment: TerminalAttachment): boolean {
  return attachment.phase === 'failed';
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function terminalAttachmentStatusLabel(attachment: TerminalAttachment): string {
  switch (attachment.phase) {
    case 'uploading':
      return `Uploading ${attachment.uploadPercent}%`;
    case 'uploaded':
      // Deliberately not "Attached" — the runner has not seen it yet.
      return 'Uploaded to slot';
    case 'delivering':
      return `Delivering to ${attachment.runner ?? 'runner'}`;
    case 'attached':
      return 'Attached';
    case 'unsupported':
      return 'Unsupported runner';
    case 'failed':
      return 'Failed';
  }
}

export interface ImageCandidate {
  file: File;
  filename: string;
  mimeType: string;
}

function candidateFromFile(file: File): ImageCandidate | null {
  if (!isTerminalAttachmentMime(file.type)) return null;
  return { file, filename: file.name || `pasted.${file.type.split('/')[1]}`, mimeType: file.type };
}

/**
 * Image candidates from a clipboard paste. Returns an empty list when the clipboard holds
 * no image, which is what keeps ordinary text paste on its existing path.
 */
export function imageCandidatesFromClipboard(data: DataTransfer | null): ImageCandidate[] {
  if (!data) return [];
  const candidates: ImageCandidate[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    const candidate = file ? candidateFromFile(file) : null;
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function imageCandidatesFromDrop(data: DataTransfer | null): ImageCandidate[] {
  if (!data) return [];
  return Array.from(data.files ?? [])
    .map(candidateFromFile)
    .filter((candidate): candidate is ImageCandidate => candidate !== null);
}

/** Files the browser would otherwise open by navigating away from Command Center. */
export function dropCarriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.types ?? []).includes('Files') || (data.files?.length ?? 0) > 0;
}

/** Names of dropped/pasted files this terminal cannot attach, for an operator-facing message. */
export function unsupportedDropFilenames(data: DataTransfer | null): string[] {
  if (!data) return [];
  return Array.from(data.files ?? [])
    .filter((file) => candidateFromFile(file) === null)
    .map((file) => file.name || file.type || 'unnamed file');
}

/**
 * Terminal identity an attachment is bound to. Captured once when the image is added and
 * replayed on every later request, so switching run/role/context mid-flight can never route a
 * chunk or a delivery to a pane the operator did not attach to.
 */
export type TerminalAttachmentTarget = Record<string, unknown>;

export interface TerminalAttachmentTransport {
  uploadChunk(params: {
    target: TerminalAttachmentTarget;
    attachmentId: string;
    filename: string;
    mimeType: string;
    byteLength: number;
    chunkIndex: number;
    chunkCount: number;
    contentBase64: string;
  }): Promise<TerminalAttachmentUploadResult>;
  deliver(params: {
    target: TerminalAttachmentTarget;
    attachmentId: string;
    storedPath: string;
    filename: string;
  }): Promise<TerminalAttachmentDeliverResult>;
  readChunkBase64(file: File, start: number, end: number): Promise<string>;
  newId(): string;
  revokePreview(url: string): void;
}

/**
 * Owns the attachment list plus the upload → delivery progression. Kept free of DOM APIs
 * (all of those arrive through `TerminalAttachmentTransport`) so the duplicate-send guard,
 * retry path, and phase transitions are directly testable.
 */
export class TerminalAttachmentQueue {
  private readonly items: TerminalAttachment[] = [];
  /** Source blobs kept until removal so a failed attachment can be retried without re-pasting. */
  private readonly files = new Map<string, File>();
  /** Terminal identity captured when each attachment was added; never re-read from the view. */
  private readonly targets = new Map<string, TerminalAttachmentTarget>();

  constructor(
    private readonly transport: TerminalAttachmentTransport,
    private readonly onChange: () => void,
  ) {}

  list(): TerminalAttachment[] {
    return [...this.items];
  }

  get(id: string): TerminalAttachment | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * Record a dropped/pasted payload this terminal cannot attach. Kept as a normal card so the
   * operator gets the same remove affordance instead of silent nothing-happened.
   */
  rejectUnsupported(filenames: string[]): void {
    for (const filename of filenames) {
      this.items.push({
        id: this.transport.newId(),
        filename,
        mimeType: '',
        byteLength: 0,
        previewUrl: '',
        phase: 'failed',
        uploadPercent: 0,
        detail: 'Only PNG, JPEG, GIF, and WebP images can be attached',
      });
    }
    if (filenames.length > 0) this.onChange();
  }

  /** Add a pasted/dropped image and immediately run the upload → delivery sequence. */
  async add(
    candidate: ImageCandidate,
    previewUrl: string,
    target: TerminalAttachmentTarget,
  ): Promise<TerminalAttachment | null> {
    if (candidate.file.size > TERMINAL_ATTACHMENT_MAX_BYTES) {
      const rejected: TerminalAttachment = {
        id: this.transport.newId(),
        filename: candidate.filename,
        mimeType: candidate.mimeType,
        byteLength: candidate.file.size,
        previewUrl,
        phase: 'failed',
        uploadPercent: 0,
        detail: `Image is ${formatAttachmentSize(candidate.file.size)} — the limit is ${formatAttachmentSize(TERMINAL_ATTACHMENT_MAX_BYTES)}`,
      };
      this.items.push(rejected);
      this.onChange();
      return rejected;
    }
    const attachment: TerminalAttachment = {
      id: this.transport.newId(),
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      byteLength: candidate.file.size,
      previewUrl,
      phase: 'uploading',
      uploadPercent: 0,
      detail: '',
    };
    this.items.push(attachment);
    this.files.set(attachment.id, candidate.file);
    this.targets.set(attachment.id, target);
    this.onChange();
    await this.run(attachment, candidate.file, target);
    return attachment;
  }

  /**
   * Re-run a failed attachment from the top. A no-op while the attachment is still
   * uploading/delivering or already attached, so a repeated Retry/submit cannot deliver the
   * same in-progress attachment twice.
   */
  async send(id: string): Promise<void> {
    const attachment = this.get(id);
    const file = this.files.get(id);
    const target = this.targets.get(id);
    if (!attachment || !file || !target || !isTerminalAttachmentRetryable(attachment)) return;
    attachment.phase = 'uploading';
    attachment.uploadPercent = 0;
    attachment.detail = '';
    this.onChange();
    // Retry replays the captured target, not wherever the terminal is pointing now.
    await this.run(attachment, file, target);
  }

  remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const previewUrl = this.items[index]!.previewUrl;
    if (previewUrl) this.transport.revokePreview(previewUrl);
    this.items.splice(index, 1);
    this.files.delete(id);
    this.targets.delete(id);
    this.onChange();
  }

  clear(): void {
    for (const item of this.items) {
      if (item.previewUrl) this.transport.revokePreview(item.previewUrl);
    }
    this.items.length = 0;
    this.files.clear();
    this.targets.clear();
    this.onChange();
  }

  private async run(
    attachment: TerminalAttachment,
    file: File,
    target: TerminalAttachmentTarget,
  ): Promise<void> {
    let uploaded: TerminalAttachmentUploadResult;
    try {
      uploaded = await this.upload(attachment, file, target);
    } catch (err) {
      this.fail(attachment, err);
      return;
    }
    attachment.phase = 'uploaded';
    attachment.uploadPercent = 100;
    attachment.storedPath = uploaded.storedPath;
    attachment.runner = uploaded.runner ?? null;
    attachment.detail = '';
    this.onChange();

    attachment.phase = 'delivering';
    this.onChange();
    try {
      const delivered = await this.transport.deliver({
        target,
        attachmentId: attachment.id,
        storedPath: uploaded.storedPath!,
        filename: attachment.filename,
      });
      attachment.runner = delivered.runner;
      attachment.detail = delivered.detail;
      attachment.phase =
        delivered.status === 'delivered'
          ? 'attached'
          : delivered.status === 'unsupported'
            ? 'unsupported'
            : 'failed';
      // Retryable client state is released only on success; a failed or unsupported
      // attachment keeps its source blob so the operator can retry without re-pasting.
      if (attachment.phase === 'attached') this.files.delete(attachment.id);
    } catch (err) {
      this.fail(attachment, err);
      return;
    }
    this.onChange();
  }

  private async upload(
    attachment: TerminalAttachment,
    file: File,
    target: TerminalAttachmentTarget,
  ): Promise<TerminalAttachmentUploadResult> {
    const chunkCount = terminalAttachmentChunkCount(attachment.byteLength);
    let last: TerminalAttachmentUploadResult | null = null;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const start = chunkIndex * TERMINAL_ATTACHMENT_CHUNK_BYTES;
      const end = Math.min(start + TERMINAL_ATTACHMENT_CHUNK_BYTES, attachment.byteLength);
      const contentBase64 = await this.transport.readChunkBase64(file, start, end);
      last = await this.transport.uploadChunk({
        target,
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteLength: attachment.byteLength,
        chunkIndex,
        chunkCount,
        contentBase64,
      });
      attachment.uploadPercent = Math.round((last.receivedBytes / attachment.byteLength) * 100);
      this.onChange();
    }
    if (!last?.complete || !last.storedPath) {
      throw new Error('Upload finished without a staged path');
    }
    return last;
  }

  private fail(attachment: TerminalAttachment, err: unknown): void {
    attachment.phase = 'failed';
    attachment.detail = err instanceof Error ? err.message : String(err);
    this.onChange();
  }
}
