export type DocumentBlockKind =
  | 'paragraph'
  | 'heading'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'separator'
  | 'code'
  | 'json'
  | 'table';

export interface DocumentBlock {
  kind: DocumentBlockKind;
  text: string;
}

export function formatDocument(title: string, body: string): DocumentBlock[] {
  if (!body.trim()) return [];
  if (/\.json$/i.test(title)) {
    return [{ kind: 'json', text: formatJson(body) }];
  }

  const blocks: DocumentBlock[] = [];
  let inFence = false;
  let codeBuffer: string[] = [];
  let tableBuffer: string[] = [];

  const flushCode = () => {
    if (!codeBuffer.length) return;
    blocks.push({ kind: 'code', text: codeBuffer.join('\n') });
    codeBuffer = [];
  };
  const flushTable = () => {
    if (!tableBuffer.length) return;
    blocks.push({ kind: 'table', text: formatTable(tableBuffer) });
    tableBuffer = [];
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim().startsWith('```')) {
      flushTable();
      if (inFence) flushCode();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      codeBuffer.push(line);
      continue;
    }
    if (looksLikeTableLine(line)) {
      tableBuffer.push(line);
      continue;
    }

    flushTable();
    if (!line.trim()) {
      flushCode();
      blocks.push({ kind: 'paragraph', text: '' });
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ kind: 'heading', text: cleanInlineMarkdown(line.replace(/^#{1,6}\s+/, '')) });
    } else if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const checked = /\[[xX]\]/.test(line);
      blocks.push({
        kind: 'bullet',
        text: `${checked ? '☑' : '☐'} ${cleanInlineMarkdown(line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, ''))}`,
      });
    } else if (/^\s*[-*]\s+/.test(line)) {
      blocks.push({
        kind: 'bullet',
        text: `• ${cleanInlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}`,
      });
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      blocks.push({ kind: 'numbered', text: cleanInlineMarkdown(line.trim()) });
    } else if (/^\s*>\s?/.test(line)) {
      blocks.push({ kind: 'quote', text: cleanInlineMarkdown(line.replace(/^\s*>\s?/, '')) });
    } else if (/^\s*-{3,}\s*$/.test(line)) {
      blocks.push({ kind: 'separator', text: '' });
    } else {
      blocks.push({ kind: 'paragraph', text: cleanInlineMarkdown(line) });
    }
  }
  flushTable();
  if (inFence || codeBuffer.length) flushCode();
  return blocks;
}

function formatJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch (error) {
    if (error instanceof SyntaxError) return body;
    throw error;
  }
}

function looksLikeTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

function formatTable(lines: string[]): string {
  return lines
    .filter((line) => !/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cleanInlineMarkdown(cell.trim()))
        .join('  |  '),
    )
    .join('\n');
}

function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2');
}
