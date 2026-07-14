import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  OmitReason,
  ScrubBlockedRecord,
  ScrubOmittedRecord,
  ScrubRedactionRecord,
  ScrubReport,
  ScrubStatus,
  VisualPassAttestation,
} from '../spec/types.js';
import { SCRUB_FLOOR_VERSION } from '../spec/version.js';

import { type FloorPattern, scanForFloorSecrets } from './floor.js';

/** Text file types eligible for the package (spec section 5.1 layer 1 allowlist). */
const ELIGIBLE_EXTENSIONS = new Set(['.md', '.json', '.jsonl', '.txt', '.diff', '.patch']);

/** Media formats the attestation-gated media path applies to (spec section 5.1 layer 4). */
const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.mp4',
  '.mov',
  '.webm',
  '.m4v',
]);

/** Path prefixes redacted to portable tokens (spec section 5.1 layer 3). */
export interface RedactionTokens {
  workspace?: string;
  farmslotHome?: string;
  home?: string;
}

/**
 * Optional scrub configuration. UNION-only (spec section 5.1 layer 5): every
 * option ADDS restriction or relaxes a redaction preference the spec marks as
 * farm-configurable - nothing here can loosen the crypto-secret floor.
 */
export interface ScrubOptions {
  /** Farm/personal deny patterns scanned IN ADDITION to the floor. */
  extraDenyPatterns?: FloorPattern[];
  /**
   * Skip wallet-address redaction (spec section 5.1 layer 3 lets farm config mark
   * addresses as public test addresses). Redaction preference only - addresses
   * are non-blocking either way; the floor is unaffected.
   */
  allowWalletAddresses?: boolean;
}

/**
 * Non-blocking detected secrets replaced in-file with `[REDACTED:<kind>:sha256:<12>]`
 * (spec section 5.1 layer 3). These are PII/config hygiene, not floor hits: the
 * package still passes, the value never survives into stored content.
 */
const REDACTION_PATTERNS: FloorPattern[] = [
  { kind: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** 40-hex account address, bounded so 64-hex values (hashes, keys) never match. */
const WALLET_ADDRESS = /\b0x[0-9a-fA-F]{40}\b(?![0-9a-fA-F])/g;

function redactionToken(kind: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `[REDACTED:${kind}:sha256:${digest}]`;
}

function redactSecrets(
  content: string,
  options: ScrubOptions,
): { content: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const patterns = [...REDACTION_PATTERNS];
  if (!options.allowWalletAddresses) {
    patterns.push({ kind: 'wallet-address', pattern: WALLET_ADDRESS });
  }
  let result = content;
  for (const { kind, pattern } of patterns) {
    result = result.replace(pattern, (match) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return redactionToken(kind, match);
    });
  }
  return { content: result, counts };
}

/** One candidate file offered to the scrub gate. */
export interface ScrubInputFile {
  /** Package-relative destination path. */
  packagePath: string;
  /** Absolute source path to read, when content is not supplied inline. */
  absolutePath?: string;
  /** In-memory text content (takes precedence over absolutePath). */
  content?: string;
  /** True for screenshot/video artifacts, which take the media path. */
  isMedia?: boolean;
  /** Whether the run's evidence manifest explicitly selected this media artifact. */
  evidenceManifestSelected?: boolean;
  /** The agent visual-pass attestation for this media artifact, if one exists. */
  visualPass?: VisualPassAttestation;
}

/** A text file that cleared the gate and is retained with its scrubbed content. */
export interface RetainedTextFile {
  packagePath: string;
  content: string;
}

export interface ScrubOutcome {
  status: ScrubStatus;
  report: ScrubReport;
  /**
   * Scrubbed text files cleared by the gate. Empty when status is `'blocked'` so
   * the public API never hands back raw content from a blocked package.
   */
  retainedText: RetainedTextFile[];
  /**
   * Package-relative paths of media artifacts cleared by the gate. Empty when
   * status is `'blocked'`.
   */
  retainedMedia: string[];
}

function isBinary(content: string): boolean {
  return content.includes(String.fromCharCode(0));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactPaths(content: string, tokens: RedactionTokens): { content: string; count: number } {
  const replacements: { prefix: string; token: string }[] = [];
  if (tokens.workspace) replacements.push({ prefix: tokens.workspace, token: '$WORKSPACE' });
  if (tokens.farmslotHome) {
    replacements.push({ prefix: tokens.farmslotHome, token: '$FARMSLOT_HOME' });
  }
  if (tokens.home) replacements.push({ prefix: tokens.home, token: '~' });
  // Longest prefix first so a nested workspace under home tokenizes to the tighter root.
  replacements.sort((a, b) => b.prefix.length - a.prefix.length);

  let result = content;
  let count = 0;
  for (const { prefix, token } of replacements) {
    const pattern = new RegExp(escapeRegExp(prefix), 'g');
    result = result.replace(pattern, () => {
      count += 1;
      return token;
    });
  }
  return { content: result, count };
}

function mediaOmitReason(file: ScrubInputFile): OmitReason | undefined {
  if (!file.evidenceManifestSelected) return 'media-not-selected';
  if (!file.visualPass) return 'media-no-attestation';
  if (file.visualPass.finding !== 'clear') return 'media-visual-block';
  return undefined;
}

/**
 * The fail-closed scrub gate (spec section 5). Runs the five-layer content gate
 * over every candidate file:
 *
 * 1. file-type allowlist - non-eligible / unscannable files are omitted, never
 *    included by default;
 * 2. floor scan - any positive secret identification blocks the whole package;
 * 3. path redaction - absolute roots become portable tokens;
 * 4. media policy - media is retained only when evidence-manifest-selected,
 *    visual-pass-cleared, and carrying an attestation.
 *
 * The returned report never reproduces a raw secret - only kind + fingerprint.
 */
export function scrubFiles(
  files: ScrubInputFile[],
  tokens: RedactionTokens = {},
  options: ScrubOptions = {},
): ScrubOutcome {
  const blocked: ScrubBlockedRecord[] = [];
  const redactions: ScrubRedactionRecord[] = [];
  const omitted: ScrubOmittedRecord[] = [];
  const visualPassAttestations: VisualPassAttestation[] = [];
  const retainedText: RetainedTextFile[] = [];
  const retainedMedia: string[] = [];

  for (const file of files) {
    if (file.isMedia) {
      // The media path (attestation-gated, no content scan) is only for actual
      // media formats. A text-eligible or unknown extension flagged as media
      // would bypass the byte-level floor scan - refuse it instead.
      if (!MEDIA_EXTENSIONS.has(path.extname(file.packagePath).toLowerCase())) {
        omitted.push({ path: file.packagePath, reason: 'disallowed-type' });
        continue;
      }
      if (file.visualPass) visualPassAttestations.push(file.visualPass);
      // Residual accepted risk: the BYTES of a selected, clear-attested media
      // file are not content-scanned - the agent visual pass is the control
      // for on-screen secrets (spec sections 3.6 / 5.1 layer 4), backed by the
      // human approval gate.
      const reason = mediaOmitReason(file);
      if (reason) {
        omitted.push({ path: file.packagePath, reason });
      } else {
        retainedMedia.push(file.packagePath);
      }
      continue;
    }

    if (!ELIGIBLE_EXTENSIONS.has(path.extname(file.packagePath).toLowerCase())) {
      omitted.push({ path: file.packagePath, reason: 'disallowed-type' });
      continue;
    }

    let content: string;
    try {
      content = file.content ?? readFileSync(file.absolutePath as string, 'utf8');
    } catch {
      // Read failure (missing file, permissions, bad encoding) means the gate
      // cannot scan the content - fail closed by omitting it (spec section 5.1
      // layer 1: unscannable is never included), recorded in the report; the
      // error detail itself is irrelevant to the caller.
      omitted.push({ path: file.packagePath, reason: 'unscannable' });
      continue;
    }
    if (isBinary(content)) {
      omitted.push({ path: file.packagePath, reason: 'unscannable' });
      continue;
    }

    for (const hit of scanForFloorSecrets(content, options.extraDenyPatterns)) {
      blocked.push({ file: file.packagePath, kind: hit.kind, fingerprint: hit.fingerprint });
    }

    const redactedPaths = redactPaths(content, tokens);
    if (redactedPaths.count > 0) {
      redactions.push({
        file: file.packagePath,
        kind: 'absolute-path',
        count: redactedPaths.count,
      });
    }
    const redactedSecrets = redactSecrets(redactedPaths.content, options);
    for (const [kind, count] of redactedSecrets.counts) {
      redactions.push({ file: file.packagePath, kind, count });
    }
    retainedText.push({ packagePath: file.packagePath, content: redactedSecrets.content });
  }

  const status: ScrubStatus = blocked.length > 0 ? 'blocked' : 'pass';
  const report: ScrubReport = {
    schemaVersion: 1,
    status,
    scannedAt: new Date().toISOString(),
    floorVersion: SCRUB_FLOOR_VERSION,
    blocked,
    redactions,
    omitted,
    visualPassAttestations,
  };

  return {
    status,
    report,
    // Never return raw content when blocked — the report (kinds + fingerprints) is enough.
    retainedText: status === 'blocked' ? [] : retainedText,
    retainedMedia: status === 'blocked' ? [] : retainedMedia,
  };
}
