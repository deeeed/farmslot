import type { RoadmapItem } from '../contracts/roadmap.js';

export interface PromotionDraft {
  project: string;
  title: string;
  body: string;
  attachmentPath?: string;
}

export interface PromotionDraftAttachment {
  filename: string;
  virtualPath: string;
  content: string;
}

function stripGlobalTail(body: string): string {
  const tailMatch = body.match(
    /\n##\s+(Reference Verification|Roadmap Notes|Promotion Notes|Next Steps)\b/i,
  );
  return tailMatch?.index == null ? body : body.slice(0, tailMatch.index);
}

export function parsePromotionDraftsFromRoadmapBody(body: string): PromotionDraft[] {
  const backlogStart = body.search(/^##\s+Backlog Drafts\s*$/im);
  if (backlogStart < 0) return [];

  const backlogBody = body.slice(backlogStart);
  const draftPattern = /^###\s+Backlog Draft:\s*(.+?)\s*$/gim;
  const matches = [...backlogBody.matchAll(draftPattern)];
  if (!matches.length) return [];

  return matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? backlogBody.length;
      const rawBody = stripGlobalTail(backlogBody.slice(start, end)).trim();
      const projectMatch = rawBody.match(/^Project:\s*`?([^`\n]+?)`?\s*$/im);
      return {
        project: projectMatch?.[1]?.trim() ?? '',
        title: match[1]?.trim() ?? '',
        body: rawBody,
      };
    })
    .filter((draft) => draft.title || draft.project || draft.body);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'draft'
  );
}

export function promotionDraftAttachment(
  item: Pick<RoadmapItem, 'id' | 'title' | 'tags'>,
  draft: PromotionDraft,
  index: number,
  tags: readonly string[] = item.tags ?? [],
): PromotionDraftAttachment {
  const project = draft.project.trim() || 'unassigned';
  const title = draft.title.trim() || item.title;
  const filename = `${String(index + 1).padStart(2, '0')}-${slugify(project)}-${slugify(title)}.md`;
  const body = draft.body.trim();
  const titledBody = /^#\s+/m.test(body) ? body : `# ${title}\n\n${body}`;
  const frontmatter = [
    ['kind', 'backlog-spec'],
    ['roadmapItemId', item.id],
    ['roadmapTitle', item.title],
    ['project', project],
    ['tags', tags],
  ]
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return {
    filename,
    virtualPath: `.roadmap/promotion-drafts/${item.id}/${filename}`,
    content: `---\n${frontmatter}\n---\n\n${titledBody.trimEnd()}\n`,
  };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, unknown> = {};
  for (const line of raw.slice(4, end).trim().split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      frontmatter[key] = JSON.parse(value);
    } catch {
      frontmatter[key] = value.replace(/^"|"$/g, '');
    }
  }
  return { frontmatter, body: raw.slice(end + 5).replace(/^\r?\n/, '') };
}

export function parsePromotionDraftAttachment(path: string, content: string): PromotionDraft {
  const { frontmatter, body } = parseFrontmatter(content);
  const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch?.[1]?.trim() ?? '';
  const bodyWithoutTitle =
    titleMatch?.index === 0 ? body.slice(titleMatch[0].length).replace(/^\r?\n+/, '') : body;
  return {
    project: typeof frontmatter.project === 'string' ? frontmatter.project : '',
    title,
    body: bodyWithoutTitle.trim(),
    attachmentPath: path,
  };
}
