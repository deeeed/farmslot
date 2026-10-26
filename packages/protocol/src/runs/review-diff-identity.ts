import { sha256 as sha256Bytes } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import type { ReviewDiffSnapshot } from '../contracts/runs.js';

type UntrackedReviewFile = NonNullable<ReviewDiffSnapshot['untrackedFiles']>[number];

function sha256(text: string): string {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(text)));
}

/** Git may change its automatic object-ID abbreviation without any source change.
 * Text hunks already contain the change; keep their modes but omit display-only
 * blob IDs. Empty-file changes use the same rule; binary patches retain their
 * complete index identity and payload.
 * Callers also compare base/HEAD and include the untracked-file manifest.
 */
export function reviewDiffHash(diffIdentity: string): string {
  const canonical = diffIdentity
    .split(/(?=^diff --git )/m)
    .map((section) => {
      if (/^(GIT binary patch|Binary files .* differ)$/m.test(section)) return section;
      const hunk = section.search(/^@@ /m);
      const headerEnd = hunk < 0 ? section.length : hunk;
      const header = section
        .slice(0, headerEnd)
        .replace(/^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?\n/gm, 'index text$1\n');
      return header + section.slice(headerEnd);
    })
    .join('');
  return sha256(canonical);
}

/** Upgrade only a diff that verifies against its recorded legacy or current hash. */
export function verifiedReviewDiffHash(
  diffIdentity: string,
  recordedHash: string,
): string | undefined {
  const canonicalHash = reviewDiffHash(diffIdentity);
  return recordedHash === canonicalHash || recordedHash === sha256(diffIdentity)
    ? canonicalHash
    : undefined;
}

/** The text `reviewDiffHash` fingerprints: the diff, then its untracked-file manifest. */
export function reviewSnapshotIdentityText(
  diffText: string,
  files: ReadonlyArray<UntrackedReviewFile>,
): string {
  if (files.length === 0) return diffText;
  const separator = diffText && !diffText.endsWith('\n') ? '\n' : '';
  const manifest = [
    '# Farmslot untracked file manifest (Git mode, blob SHA, and JSON-encoded path)',
    ...files.map(
      ({ path: filePath, blobSha, mode }) => `# ${mode}\t${blobSha}\t${JSON.stringify(filePath)}`,
    ),
    '',
  ].join('\n');
  return `${diffText}${separator}${manifest}`;
}
