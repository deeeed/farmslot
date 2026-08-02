export function extractBacklogAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (headingIndex < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,2}\s+\S/.test(line) || /^Backlog (?:notes|source):/i.test(line)) break;
    body.push(line);
  }
  return body
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}
