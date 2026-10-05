// external/ticket-markdown.ts — ticket bodies as Markdown, and their named sections.
// Jira REST v3 returns descriptions as ADF (Atlassian Document Format); older
// APIs and some imports return wiki markup strings. Both become Markdown that
// keeps paragraphs, headings, lists, code and tables, so TASK.md shows the
// ticket as written and sections such as "Acceptance criteria" can be found by
// heading whatever format the ticket was authored in.

export interface AdfToMarkdownOptions {
  /** Added to every heading level (capped at 6), so ticket headings nest under the host document's. */
  headingOffset?: number;
}

/** One ADF node as Jira returns it; only the fields the conversion reads. */
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
}

/** ADF document (or a wiki/plain string) → Markdown. */
export function ticketBodyToMarkdown(body: unknown, opts: AdfToMarkdownOptions = {}): string {
  if (!body) return '';
  if (typeof body === 'string') return wikiToMarkdown(body, opts);
  const root = asNode(body);
  return tidy(blocks(Array.isArray(root.content) ? asNodes(root.content) : [root], opts));
}

/** ADF → one line of text (comments are rendered as single bullets). */
export function adfToInlineText(body: unknown): string {
  return ticketBodyToMarkdown(body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function asNode(value: unknown): AdfNode {
  return value !== null && typeof value === 'object' ? (value as AdfNode) : {};
}

function asNodes(value: unknown): AdfNode[] {
  return Array.isArray(value) ? value.map(asNode) : [];
}

// An attribute as text ('' when absent or not a string/number).
function attr(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function blocks(nodes: AdfNode[], opts: AdfToMarkdownOptions): string {
  return nodes
    .map((node) => block(node, opts))
    .filter((text) => text !== '')
    .join('\n\n');
}

function block(node: AdfNode, opts: AdfToMarkdownOptions): string {
  const content = asNodes(node.content);
  switch (node.type) {
    case 'paragraph':
      // Leading spaces would make Markdown read the line as code (4+) or a list continuation.
      return inline(content)
        .split('\n')
        .map((line) => line.trimStart())
        .join('\n');
    case 'heading': {
      const level = Math.min(
        6,
        Math.max(1, Number(attr(node, 'level')) || 1) + (opts.headingOffset ?? 0),
      );
      const text = inline(content).replace(/\n/g, ' ').trim();
      return text ? `${'#'.repeat(level)} ${text}` : '';
    }
    case 'bulletList':
      return list(content, () => '- ', opts);
    case 'orderedList': {
      const start = Number(attr(node, 'order')) || 1;
      return list(content, (index) => `${start + index}. `, opts);
    }
    case 'taskList':
      return list(
        content,
        (_index, item) => (attr(item, 'state') === 'DONE' ? '- [x] ' : '- [ ] '),
        opts,
      );
    case 'codeBlock': {
      const code = content.map((child) => child.text ?? '').join('');
      return `\`\`\`${attr(node, 'language')}\n${code}\n\`\`\``;
    }
    case 'blockquote':
    case 'panel':
      return blocks(content, opts)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return table(content);
    case 'expand':
    case 'nestedExpand': {
      const title = attr(node, 'title');
      return [title ? `**${title}**` : '', blocks(content, opts)].filter(Boolean).join('\n\n');
    }
    case 'blockCard':
    case 'embedCard':
      return attr(node, 'url');
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '';
    default:
      // Unknown containers keep their text; unknown inline nodes are rendered as inline.
      if (content.length > 0)
        return content.some(isBlock) ? blocks(content, opts) : inline(content);
      return inline([node]);
  }
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'blockquote',
  'panel',
  'rule',
  'table',
  'expand',
  'nestedExpand',
  'blockCard',
  'embedCard',
  'mediaSingle',
  'mediaGroup',
]);

function isBlock(node: AdfNode): boolean {
  return BLOCK_TYPES.has(node.type ?? '');
}

// One list: each item's first line carries the marker, every other line of the
// item (later paragraphs, nested lists) is indented under it.
function list(
  items: AdfNode[],
  marker: (index: number, item: AdfNode) => string,
  opts: AdfToMarkdownOptions,
): string {
  return items
    .map((item, index) => {
      const prefix = marker(index, item);
      const content = asNodes(item.content);
      // taskItem holds inline content directly.
      const body = content.some(isBlock) ? itemBlocks(content, opts) : inline(content);
      const [first = '', ...rest] = body.split('\n');
      const indent = ' '.repeat(prefix.length);
      return [prefix + first, ...rest.map((line) => (line ? indent + line : ''))].join('\n');
    })
    .join('\n');
}

// A list item's blocks: a nested list follows its paragraph directly (a tight
// list); other blocks inside the item keep a blank line between them.
function itemBlocks(nodes: AdfNode[], opts: AdfToMarkdownOptions): string {
  let out = '';
  for (const node of nodes) {
    const text = block(node, opts);
    if (text === '') continue;
    const nested = /List$/.test(node.type ?? '');
    out = out === '' ? text : `${out}${nested ? '\n' : '\n\n'}${text}`;
  }
  return out;
}

function table(rows: AdfNode[]): string {
  const cells = rows.map((row) =>
    asNodes(row.content).map((cell) =>
      blocks(asNodes(cell.content), {}).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim(),
    ),
  );
  if (cells.length === 0) return '';
  const width = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  const [head, ...body] = cells;
  return [
    line(head),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join('');
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return marked(node.text ?? '', asNodes(node.marks));
    case 'hardBreak':
      return '\n';
    case 'inlineCard':
    case 'blockCard':
      return attr(node, 'url');
    case 'mention': {
      const text = attr(node, 'text') || attr(node, 'displayName') || attr(node, 'id');
      return text ? `@${text.replace(/^@/, '')}` : '';
    }
    case 'emoji':
      return attr(node, 'shortName') || attr(node, 'text');
    case 'status':
      return attr(node, 'text') ? `[${attr(node, 'text')}]` : '';
    case 'date': {
      const ts = Number(attr(node, 'timestamp'));
      return attr(node, 'timestamp') && Number.isFinite(ts)
        ? new Date(ts).toISOString().slice(0, 10)
        : '';
    }
    default:
      return inline(asNodes(node.content));
  }
}

function marked(text: string, marks: AdfNode[]): string {
  if (!text) return '';
  let out = text;
  const types = new Set(marks.map((mark) => mark.type));
  if (types.has('code')) out = `\`${out}\``;
  else {
    if (types.has('strong')) out = `**${out}**`;
    if (types.has('em')) out = `*${out}*`;
    if (types.has('strike')) out = `~~${out}~~`;
  }
  const linkMark = marks.find((mark) => mark.type === 'link');
  const link = linkMark ? attr(linkMark, 'href') : '';
  return link && link !== text ? `[${out}](${link})` : out;
}

/** Jira wiki markup → Markdown: headings, lists, code, quotes, links and tables. */
export function wikiToMarkdown(text: string, opts: AdfToMarkdownOptions = {}): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const codeFence = raw.match(/^\s*\{(?:code|noformat)(?::([^}|]*))?[^}]*\}\s*$/);
    if (codeFence) {
      out.push(inCode ? '```' : `\`\`\`${(codeFence[1] ?? '').trim()}`);
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(raw);
      continue;
    }
    const heading = raw.match(/^\s*h([1-6])\.\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, Number(heading[1]) + (opts.headingOffset ?? 0));
      out.push(`${'#'.repeat(level)} ${wikiInline(heading[2].trim())}`);
      continue;
    }
    const item = raw.match(/^\s*([#*-]+)\s+(.*)$/);
    if (item && /^(#+|\*+|-)$/.test(item[1])) {
      const depth = item[1].length - 1;
      const marker = item[1].startsWith('#') ? '1. ' : '- ';
      out.push(`${'   '.repeat(depth)}${marker}${wikiInline(item[2])}`);
      continue;
    }
    const quote = raw.match(/^\s*bq\.\s+(.*)$/);
    if (quote) {
      out.push(`> ${wikiInline(quote[1])}`);
      continue;
    }
    if (/^\s*\|\|/.test(raw)) {
      const cells = raw
        .trim()
        .replace(/^\|\||\|\|$/g, '')
        .split('||');
      out.push(`| ${cells.map((cell) => wikiInline(cell.trim())).join(' | ')} |`);
      out.push(`| ${cells.map(() => '---').join(' | ')} |`);
      continue;
    }
    out.push(raw.trim().startsWith('|') ? raw.trim() : wikiInline(raw));
  }
  if (inCode) out.push('```');
  return tidy(renumberLists(out).join('\n'));
}

// Wiki ordered items all come out as "1."; number each run of siblings.
function renumberLists(lines: string[]): string[] {
  const counters = new Map<number, number>();
  return lines.map((line) => {
    const match = line.match(/^( *)1\. (.*)$/);
    if (!match) {
      if (!/^ *- /.test(line)) counters.clear();
      return line;
    }
    const depth = match[1].length;
    for (const key of [...counters.keys()]) if (key > depth) counters.delete(key);
    const next = (counters.get(depth) ?? 0) + 1;
    counters.set(depth, next);
    return `${match[1]}${next}. ${match[2]}`;
  });
}

function wikiInline(text: string): string {
  return text
    .replace(/\{\{([^}]+)\}\}/g, '`$1`')
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1*$2*');
}

interface Heading {
  index: number;
  level: number;
  title: string;
}

// A heading line: Markdown `#` headings, or a line that is only bold text
// (`**Acceptance criteria**`, how many editors fake a heading).
function headingAt(line: string, index: number): Heading | null {
  const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (atx) return { index, level: atx[1].length, title: atx[2] };
  const bold = line.match(/^\s{0,3}\*\*(.+?)\*\*\s*:?\s*$/);
  if (bold) return { index, level: 7, title: bold[1] };
  return null;
}

// A short unindented line ending in a colon, e.g. "Steps to reproduce:".
function isLabel(line: string): boolean {
  return /^[A-Za-z][^:]{0,60}:\s*$/.test(line);
}

function normalizeTitle(title: string): string {
  return title
    .replace(/[*_`]/g, '')
    .replace(/[:.\s]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * The body of the first section whose heading is one of `names` (case- and
 * punctuation-insensitive), up to the next heading of the same or a higher level.
 * Also accepts a plain `Acceptance criteria:` line when the ticket has no headings.
 */
export function extractSection(markdown: string, names: string[]): string {
  const lines = markdown.split('\n');
  const wanted = names.map((name) => name.toLowerCase());
  const headings = lines
    .map((line, index) => headingAt(line, index))
    .filter((heading): heading is Heading => heading !== null);
  for (const name of wanted) {
    const start = headings.find((heading) => normalizeTitle(heading.title) === name);
    if (start) {
      const end = headings.find(
        (heading) => heading.index > start.index && heading.level <= start.level,
      );
      return lines
        .slice(start.index + 1, end ? end.index : lines.length)
        .join('\n')
        .trim();
    }
    // No heading: a line that is just the label, e.g. "Acceptance criteria:".
    const label = lines.findIndex((line) => /:\s*$/.test(line) && normalizeTitle(line) === name);
    if (label >= 0) {
      const next = lines.findIndex(
        (line, index) => index > label && (headingAt(line, index) !== null || isLabel(line)),
      );
      return lines
        .slice(label + 1, next >= 0 ? next : lines.length)
        .join('\n')
        .trim();
    }
  }
  return '';
}

/**
 * A section body as items: one per top-level list item, with its continuation
 * lines and nested items kept with it, list markers stripped; without a list,
 * one per paragraph line.
 */
export function sectionItems(section: string): string[] {
  const marker = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
  const lines = section.split('\n').filter((line) => line.trim());
  if (!lines.some((line) => marker.test(line))) return lines.map((line) => line.trim());
  const items: string[][] = [];
  for (const line of lines) {
    if (marker.test(line)) items.push([line.replace(marker, '').trim()]);
    else if (items.length > 0 && /^\s/.test(line)) items[items.length - 1].push(line.trim());
    else items.push([line.trim()]);
  }
  return items.map((item) => item.join('\n')).filter(Boolean);
}
