function acceptanceCriteriaBounds(lines: string[]): { start: number; end: number } | null {
  const headingIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (headingIndex < 0) return null;
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s+\S/.test(lines[i]) || /^Backlog (?:notes|source):/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: headingIndex, end };
}

export function extractBacklogAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const bounds = acceptanceCriteriaBounds(lines);
  if (!bounds) return [];
  return lines
    .slice(bounds.start + 1, bounds.end)
    .map((line) =>
      line
        .replace(/^\s*[-*]\s+/, '')
        // Specs often author ACs as markdown checkboxes; the checkbox marker is
        // syntax, not criterion text. Leaving it in re-introduces phantom
        // `[ ]` boxes wherever the AC list is rendered into task markdown.
        .replace(/^\[(?: |x|X)\]\s*/, '')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Remove the `## Acceptance Criteria` section from a spec body. Used when the
 * ACs are extracted and rendered separately, so the same list is not duplicated
 * (once as checkboxes, once as text) in generated task markdown.
 */
export function stripBacklogAcceptanceCriteriaSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const bounds = acceptanceCriteriaBounds(lines);
  if (!bounds) return markdown;
  return [...lines.slice(0, bounds.start), ...lines.slice(bounds.end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
