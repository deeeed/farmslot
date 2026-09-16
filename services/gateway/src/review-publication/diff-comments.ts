/** GitHub permits RIGHT-side review comments only on lines represented in a diff hunk. */
export function rightDiffLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let line = 0;
  let remaining = 0;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (remaining > 0 && (text.startsWith('+') || text.startsWith(' '))) {
      lines.add(line++);
      remaining--;
    }
  }
  return lines;
}

export interface PublicationComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

/** Preserve off-diff findings in the body; never invent a nearby inline location. */
export function locatePublicationComments(
  comments: PublicationComment[],
  pages: unknown,
  source: { host: string; repo: string; headSha: string },
): { inline: PublicationComment[]; bodySuffix: string } {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('GitHub diff file list is incomplete');
  const locations = new Map<string, Set<number>>();
  for (const file of pages.flat()) {
    if (!file || typeof file.filename !== 'string')
      throw new Error('GitHub returned an invalid diff file');
    locations.set(file.filename, rightDiffLines(typeof file.patch === 'string' ? file.patch : ''));
  }
  const inline: PublicationComment[] = [];
  const outside: string[] = [];
  for (const comment of comments) {
    if (locations.get(comment.path)?.has(comment.line)) {
      inline.push(comment);
      continue;
    }
    const url = `https://${source.host}/${source.repo}/blob/${source.headSha}/${comment.path.split('/').map(encodeURIComponent).join('/')}#L${comment.line}`;
    const label = `${comment.path}:${comment.line}`.replace(/[\\`*_{}\[\]()<>]/g, '\\$&');
    outside.push(`### [${label}](${url})\n\n${comment.body}`);
  }
  return {
    inline,
    bodySuffix: outside.length
      ? `\n\n## Findings outside the PR diff\n\nThese findings refer to the reviewed commit, but GitHub cannot attach them inline.\n\n${outside.join('\n\n')}`
      : '',
  };
}
