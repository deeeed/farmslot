import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
  type RoadmapItem,
} from '@farmslot/protocol';

export interface RoadmapPromotionRequestInput {
  itemId: string;
  itemFile?: string;
  title?: string;
  targetProjects?: string[] | string;
  roadmapRoute?: string;
}

export interface RoadmapPromotionRequestResult {
  decisionPath: string;
  decision: {
    id: string;
    type: 'blocked_alert';
    slot_id: null;
    title: string;
    description: string;
    context: {
      kind: 'roadmap-promotion';
      roadmapItemId: string;
      itemFile: string;
      targetProjects: string[];
      draftSpecPaths: string[];
      route: string;
    };
    payload: {
      kind: 'roadmap-promotion';
      roadmapItemId: string;
      itemFile: string;
      targetProjects: string[];
      draftSpecPaths: string[];
      expectedBacklogItems: number;
      route: string;
      promotionRoute: string;
    };
    actions: Array<{
      id: string;
      label: string;
      style: 'primary' | 'secondary' | 'danger';
      description?: string;
    }>;
    created_at: string;
  };
}

export async function createRoadmapPromotionRequest(
  root: string,
  input: RoadmapPromotionRequestInput,
  now = new Date(),
): Promise<RoadmapPromotionRequestResult> {
  const itemId = input.itemId.trim();
  if (!itemId) throw new Error('roadmap request-promotion requires --item-id');

  const title = input.title?.trim() || itemId;
  const itemFile = input.itemFile?.trim() || '';
  const targetProjects = normalizeTargetProjects(input.targetProjects);
  const draftSpecPaths = itemFile
    ? await materializePromotionDraftSpecs(root, {
        itemId,
        itemFile,
        title,
      })
    : [];
  const route = input.roadmapRoute?.trim() || `#roadmap?item=${encodeURIComponent(itemId)}`;
  const promotionRoute = withRouteParam(route, 'promote', '1');
  // Count materialized drafts, not targetProjects. Targets are the allowed set;
  // one framework ticket can list many targets by mistake and still be one draft.
  const expectedBacklogItems = draftSpecPaths.length;
  const decisionTitle =
    expectedBacklogItems > 0
      ? `Review roadmap promotion (${expectedBacklogItems} backlog ${expectedBacklogItems === 1 ? 'item' : 'items'})`
      : 'Review roadmap promotion (no generated drafts)';
  const reviewActionLabel =
    expectedBacklogItems > 0
      ? `Review ${expectedBacklogItems} draft${expectedBacklogItems === 1 ? '' : 's'}`
      : 'Review promotion';
  const decisionDir = path.join(
    root,
    'projects',
    'farmslot-farm',
    'tasks',
    `roadmap-promotion-${itemId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
  );
  const decisionPath = path.join(decisionDir, '.pending_decision.json');
  const decision: RoadmapPromotionRequestResult['decision'] = {
    id: decisionPath,
    type: 'blocked_alert',
    slot_id: null,
    title: decisionTitle,
    description:
      expectedBacklogItems > 0
        ? `Refinement is ready for "${title}". Review the generated backlog spec attachments with the operator; promote only after confirming the scope and target projects.`
        : `Refinement is ready for "${title}", but no backlog draft attachments were generated. Review the roadmap item and confirm its scope before promotion.`,
    context: {
      kind: 'roadmap-promotion',
      roadmapItemId: itemId,
      itemFile,
      targetProjects,
      draftSpecPaths,
      route,
    },
    payload: {
      kind: 'roadmap-promotion',
      roadmapItemId: itemId,
      itemFile,
      targetProjects,
      draftSpecPaths,
      expectedBacklogItems,
      route,
      promotionRoute,
    },
    actions: [
      {
        id: 'review-promotion',
        label: reviewActionLabel,
        style: 'primary',
        description:
          'Open the roadmap promotion panel and review the generated draft spec attachments. This does not create backlog items.',
      },
      {
        id: 'open-roadmap',
        label: 'Open roadmap',
        style: 'secondary',
        description: 'Open the roadmap item without entering promotion mode.',
      },
      {
        id: 'revise-runner',
        label: 'Revise with runner',
        style: 'secondary',
        description: 'Return to the roadmap item with the refinement runner picker open.',
      },
      {
        id: 'dismiss',
        label: 'Dismiss',
        style: 'secondary',
        description: 'Remove this prompt without promoting anything.',
      },
    ],
    created_at: now.toISOString(),
  };

  await mkdir(decisionDir, { recursive: true });
  await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  return { decisionPath, decision };
}

async function materializePromotionDraftSpecs(
  root: string,
  input: {
    itemId: string;
    itemFile: string;
    title: string;
  },
): Promise<string[]> {
  assertSafePathSegment('--item-id', input.itemId);
  const itemPath = path.resolve(root, input.itemFile);
  const rootPath = path.resolve(root);
  if (!itemPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('--item-file must be inside the Farmslot root');
  }
  const raw = await readFile(itemPath, 'utf8');
  const { frontmatter, body } = parseMarkdownFrontmatter(raw);
  const drafts = parsePromotionDraftsFromRoadmapBody(body);
  if (!drafts.length) return [];

  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
  const item: Pick<RoadmapItem, 'id' | 'title' | 'tags'> = {
    id: input.itemId,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : input.title,
    ...(tags.length ? { tags } : {}),
  };
  const draftRoot = path.resolve(root, '.roadmap', 'promotion-drafts');
  const draftDir = path.resolve(draftRoot, input.itemId);
  if (!draftDir.startsWith(`${draftRoot}${path.sep}`)) {
    throw new Error('--item-id must resolve inside .roadmap/promotion-drafts');
  }
  await rm(draftDir, { recursive: true, force: true });
  await mkdir(draftDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const attachment = promotionDraftAttachment(item, draft, index, tags);
    const absolutePath = path.join(draftDir, attachment.filename);
    await writeFile(absolutePath, attachment.content, 'utf8');
    paths.push(path.relative(root, absolutePath));
  }
  return paths;
}

function assertSafePathSegment(label: string, value: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    path.isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
}

function parseMarkdownFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
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

function normalizeTargetProjects(value: string[] | string | undefined): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(raw.map((part) => part.trim()).filter(Boolean))];
}

function withRouteParam(route: string, key: string, value: string): string {
  const [base, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${base}?${params.toString()}`;
}
