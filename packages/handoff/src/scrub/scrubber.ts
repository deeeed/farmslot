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

import { scanForFloorSecrets } from './floor.js';

/** Text file types eligible for the package (spec section 5.1 layer 1 allowlist). */
const ELIGIBLE_EXTENSIONS = new Set(['.md', '.json', '.jsonl', '.txt', '.diff', '.patch']);

/** Path prefixes redacted to portable tokens (spec section 5.1 layer 3). */
export interface RedactionTokens {
  workspace?: string;
  farmslotHome?: string;
  home?: string;
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
  /** Scrubbed text files to write into the package (present regardless of status). */
  retainedText: RetainedTextFile[];
  /** Package-relative paths of media artifacts that cleared the gate. */
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
export function scrubFiles(files: ScrubInputFile[], tokens: RedactionTokens = {}): ScrubOutcome {
  const blocked: ScrubBlockedRecord[] = [];
  const redactions: ScrubRedactionRecord[] = [];
  const omitted: ScrubOmittedRecord[] = [];
  const visualPassAttestations: VisualPassAttestation[] = [];
  const retainedText: RetainedTextFile[] = [];
  const retainedMedia: string[] = [];

  for (const file of files) {
    if (file.isMedia) {
      if (file.visualPass) visualPassAttestations.push(file.visualPass);
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
      omitted.push({ path: file.packagePath, reason: 'unscannable' });
      continue;
    }
    if (isBinary(content)) {
      omitted.push({ path: file.packagePath, reason: 'unscannable' });
      continue;
    }

    for (const hit of scanForFloorSecrets(content)) {
      blocked.push({ file: file.packagePath, kind: hit.kind, fingerprint: hit.fingerprint });
    }

    const redacted = redactPaths(content, tokens);
    if (redacted.count > 0) {
      redactions.push({ file: file.packagePath, kind: 'absolute-path', count: redacted.count });
    }
    retainedText.push({ packagePath: file.packagePath, content: redacted.content });
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

  return { status, report, retainedText, retainedMedia };
}
