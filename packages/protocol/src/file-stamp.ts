/** How long after a change a file's stat stamp is not trusted to reveal its next change. */
export const RACY_STAMP_MS = 2_000;

/**
 * Whether a cache keyed by a file's stat stamp (inode, size, mtime) must read the file again
 * instead of trusting the stamp. Some filesystems keep coarse timestamps and reuse inodes, so two
 * writes close together can leave an identical stamp; only a change older than RACY_STAMP_MS is
 * known to show up in the next stamp. This is git's "racy clean" rule.
 */
export function isRacyStamp(changedAtMs: number, now = Date.now()): boolean {
  return now - changedAtMs < RACY_STAMP_MS;
}
