import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_ROADMAP_REFINEMENT_MODEL,
  DEFAULT_ROADMAP_REFINEMENT_RUNNER,
  normalizeRunTags,
  type PoolConfig,
  ROADMAP_ITEM_STAGES,
  ROADMAP_SOURCE_KINDS,
  type RoadmapDeleteParams,
  type RoadmapDeleteResult,
  type RoadmapGetParams,
  type RoadmapGetResult,
  type RoadmapItem,
  type RoadmapItemSaveInput,
  type RoadmapItemStage,
  type RoadmapListParams,
  type RoadmapListResult,
  type RoadmapPromoteParams,
  type RoadmapPromoteResult,
  type RoadmapPromoteSpecInput,
  type RoadmapPromotionDraftGetParams,
  type RoadmapPromotionDraftGetResult,
  type RoadmapPromotionDraftListParams,
  type RoadmapPromotionDraftListResult,
  type RoadmapPromotionDraftSaveParams,
  type RoadmapPromotionDraftSaveResult,
  type RoadmapPromotionEntry,
  type RoadmapPromptGetParams,
  type RoadmapPromptGetResult,
  type RoadmapRefinementSessionGetParams,
  type RoadmapRefinementSessionGetResult,
  type RoadmapRefineParams,
  type RoadmapRefineResult,
  type RoadmapSaveParams,
  type RoadmapSaveResult,
  type RoadmapSource,
  type SafetyTier,
  type TmuxWorkerRef,
} from '@farmslot/protocol';

import {
  createBacklogItem,
  deleteBacklogItem,
  extractBacklogAcceptanceCriteria,
  markBacklogItemReady,
  updateBacklogItem,
} from '../backlog/store.js';
import { isLocal } from '../core/exec.js';
import { assertNoUnknownPlaceholders } from '../core/hooks.js';
import { loadPromptTemplate } from '../core/prompt-templates.js';
import { farmslotRoot, loadPoolConfigs, loadProjectConfig } from '../fleet/state.js';
import { runnerFlagsForTier } from '../runners/registry.js';

const VALID_STAGES = new Set<RoadmapItemStage>(ROADMAP_ITEM_STAGES);
const VALID_SOURCE_KINDS = new Set<string>(ROADMAP_SOURCE_KINDS);
const ROADMAP_ROOT = process.env.FARMSLOT_ROADMAP_DIR ?? path.join(farmslotRoot, '.roadmap');
const BACKLOG_SPEC_ROOT =
  process.env.FARMSLOT_BACKLOG_SPEC_DIR ?? path.join(farmslotRoot, '.backlog', 'specs');
const REFINEMENT_PROMPT_ROOT =
  process.env.FARMSLOT_ROADMAP_REFINEMENT_PROMPT_DIR ??
  path.join(ROADMAP_ROOT, 'refinement-prompts');
const PROMOTION_DRAFT_ROOT = path.join(ROADMAP_ROOT, 'promotion-drafts');
const execFileAsync = promisify(execFile);
const DEFAULT_PROMPT_PROJECT = 'farmslot-farm';
const ROADMAP_REFINEMENT_PROMPT_TEMPLATE = 'roadmap-refinement.md';
let roadmapMutationTail: Promise<void> = Promise.resolve();

type RoadmapMeta = {
  id: string;
  kind: 'roadmap-item';
  project: string;
  targetProjects?: string[];
  title: string;
  stage: RoadmapItemStage;
  tags?: string[];
  source?: RoadmapSource;
  promotion?: RoadmapPromotionEntry[];
  createdAt: string;
  updatedAt: string;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function repoRelative(filePath: string): string {
  const relative = path.relative(farmslotRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function assertSafePathSegment(label: string, value: string): void {
  if (
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${label} cannot contain path separators`);
  }
}

function resolveRoadmapPath(filePath: string): string {
  const resolved = path.resolve(farmslotRoot, filePath);
  const root = path.resolve(ROADMAP_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('roadmap filePath must stay under .roadmap');
  }
  return resolved;
}

function assertRoadmapItemPath(filePath: string, project: string): string {
  const resolved = resolveRoadmapPath(filePath);
  const itemDir = path.resolve(targetDirForProject(project));
  if (!resolved.endsWith('.md')) throw new Error('roadmap filePath must be a markdown file');
  if (resolved !== itemDir && !resolved.startsWith(`${itemDir}${path.sep}`)) {
    throw new Error('roadmap filePath must stay within the project roadmap item directory');
  }
  return resolved;
}

async function withRoadmapMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = roadmapMutationTail;
  let release!: () => void;
  roadmapMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeProject(value: string | undefined): string {
  const project = value?.trim() || 'unassigned';
  assertSafePathSegment('roadmap project', project);
  return project;
}

function normalizeTargetProjects(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((project) => project.trim())
        .filter(Boolean)
        .map((project) => {
          if (project === 'global' || project === 'unassigned') {
            throw new Error(`Roadmap target project must be concrete: ${project}`);
          }
          assertSafePathSegment('roadmap target project', project);
          return project;
        }),
    ),
  ].sort();
}

function normalizeStage(value: string | undefined): RoadmapItemStage {
  const stage = value ?? 'rough';
  if (!VALID_STAGES.has(stage as RoadmapItemStage))
    throw new Error(`Invalid roadmap stage: ${stage}`);
  return stage as RoadmapItemStage;
}

function normalizeSource(value: RoadmapSource | undefined): RoadmapSource {
  const source = value ?? { kind: 'manual' };
  if (!VALID_SOURCE_KINDS.has(source.kind))
    throw new Error(`Invalid roadmap source kind: ${source.kind}`);
  return {
    kind: source.kind,
    ...(source.ref?.trim() ? { ref: source.ref.trim() } : {}),
    ...(source.path?.trim() ? { path: source.path.trim() } : {}),
    ...(source.url?.trim() ? { url: source.url.trim() } : {}),
  };
}

function normalizePromotion(
  value: RoadmapPromotionEntry[] | undefined,
): RoadmapPromotionEntry[] | undefined {
  if (!value?.length) return undefined;
  const entries = value
    .filter((entry) => typeof entry.createdAt === 'string' && entry.createdAt.trim())
    .map((entry) => ({
      ...(entry.backlogItemId?.trim() ? { backlogItemId: entry.backlogItemId.trim() } : {}),
      ...(entry.specPath?.trim() ? { specPath: entry.specPath.trim() } : {}),
      ...(entry.project?.trim() ? { project: normalizeProject(entry.project) } : {}),
      createdAt: entry.createdAt.trim(),
    }));
  return entries.length > 0 ? entries : undefined;
}

function parseFrontmatterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Human-edited roadmap markdown may use simple YAML-like scalars/lists.
    const listMatch = value.match(/^\[(.*)\]$/);
    if (listMatch) {
      return listMatch[1]
        .split(',')
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    return value.replace(/^['"]|['"]$/g, '');
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'roadmap-item';
}

function backlogSpecDirForProject(project: string): string {
  assertSafePathSegment('backlog spec project', project);
  return path.join(BACKLOG_SPEC_ROOT, project);
}

function newRoadmapId(): string {
  return `ri_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function targetDirForProject(project: string): string {
  if (project === 'global' || project === 'unassigned')
    return path.join(ROADMAP_ROOT, 'inbox', 'items');
  return path.join(ROADMAP_ROOT, 'projects', project, 'items');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf-8');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function allocatePath(project: string, title: string): Promise<string> {
  const dir = targetDirForProject(project);
  await mkdir(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${project === 'unassigned' ? 'unassigned-' : ''}${slugify(title)}`;
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const candidate = path.join(dir, `${base}${suffix}.md`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not allocate unique roadmap item path');
}

async function allocateBacklogSpecPath(project: string, title: string): Promise<string> {
  const dir = backlogSpecDirForProject(project);
  await mkdir(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${slugify(title)}`;
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const candidate = path.join(dir, `${base}${suffix}.md`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not allocate unique backlog spec path');
}

async function allocateRefinementPromptPath(item: RoadmapItem): Promise<string> {
  await mkdir(REFINEMENT_PROMPT_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    REFINEMENT_PROMPT_ROOT,
    `${stamp}-${slugify(item.id)}-${slugify(item.title)}.md`,
  );
}

async function latestRefinementPromptPath(item: Pick<RoadmapItem, 'id'>): Promise<string | null> {
  const idSlug = slugify(item.id);
  const files = (await collectMarkdownFiles(REFINEMENT_PROMPT_ROOT))
    .filter((file) => path.basename(file).includes(`-${idSlug}-`))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return files[0] ? repoRelative(files[0]) : null;
}

function resolveRefinementPromptPath(promptPath: string): string {
  const absolutePath = path.resolve(farmslotRoot, promptPath);
  const root = path.resolve(REFINEMENT_PROMPT_ROOT);
  if (!absolutePath.startsWith(`${root}${path.sep}`) || !absolutePath.endsWith('.md')) {
    throw new Error('Roadmap prompt path must point to a refinement prompt markdown file');
  }
  return absolutePath;
}

function promotionDraftDir(itemId: string): string {
  assertSafePathSegment('roadmap item id', itemId);
  return path.join(PROMOTION_DRAFT_ROOT, itemId);
}

function resolvePromotionDraftPath(draftPath: string): string {
  const absolutePath = path.resolve(farmslotRoot, draftPath);
  const root = path.resolve(PROMOTION_DRAFT_ROOT);
  if (!absolutePath.startsWith(`${root}${path.sep}`) || !absolutePath.endsWith('.md')) {
    throw new Error('Roadmap promotion draft path must point to a promotion draft markdown file');
  }
  return absolutePath;
}

function parseFrontmatter(raw: string, filePath: string): { meta: RoadmapMeta; body: string } {
  if (!raw.startsWith('---\n')) throw new Error(`Roadmap item missing frontmatter: ${filePath}`);
  const end = raw.indexOf('\n---', 4);
  if (end < 0) throw new Error(`Roadmap item frontmatter is unterminated: ${filePath}`);
  const frontmatter = raw.slice(4, end).trim();
  const body = raw.slice(end + 5).replace(/^\r?\n/, '');
  const parsed: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    parsed[key] = parseFrontmatterValue(value);
  }
  if (parsed.kind !== 'roadmap-item') throw new Error(`Roadmap item kind is invalid: ${filePath}`);
  if (typeof parsed.id !== 'string' || !parsed.id)
    throw new Error(`Roadmap item id is missing: ${filePath}`);
  if (typeof parsed.project !== 'string' || !parsed.project)
    throw new Error(`Roadmap item project is missing: ${filePath}`);
  if (typeof parsed.title !== 'string' || !parsed.title)
    throw new Error(`Roadmap item title is missing: ${filePath}`);
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt)
    throw new Error(`Roadmap item createdAt is missing: ${filePath}`);
  if (typeof parsed.updatedAt !== 'string' || !parsed.updatedAt)
    throw new Error(`Roadmap item updatedAt is missing: ${filePath}`);
  const stage = normalizeStage(typeof parsed.stage === 'string' ? parsed.stage : undefined);
  const tags = normalizeRunTags(Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined);
  const source = normalizeSource(
    parsed.source && typeof parsed.source === 'object'
      ? (parsed.source as RoadmapSource)
      : undefined,
  );
  const promotion = Array.isArray(parsed.promotion)
    ? normalizePromotion(parsed.promotion as RoadmapPromotionEntry[])
    : undefined;
  const targetProjects = normalizeTargetProjects(
    Array.isArray(parsed.targetProjects) ? parsed.targetProjects.map(String) : undefined,
  );
  return {
    meta: {
      id: parsed.id,
      kind: 'roadmap-item',
      project: parsed.project,
      title: parsed.title,
      stage,
      ...(tags.length > 0 ? { tags } : {}),
      ...(targetProjects.length > 0 ? { targetProjects } : {}),
      source,
      ...(promotion ? { promotion } : {}),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    },
    body,
  };
}

function renderMarkdown(meta: RoadmapMeta, body: string): string {
  const entries: Array<[string, unknown]> = [
    ['id', meta.id],
    ['kind', meta.kind],
    ['project', meta.project],
    ['targetProjects', meta.targetProjects ?? []],
    ['title', meta.title],
    ['stage', meta.stage],
    ['tags', meta.tags ?? []],
    ['source', meta.source],
    ['promotion', meta.promotion ?? []],
    ['createdAt', meta.createdAt],
    ['updatedAt', meta.updatedAt],
  ];
  const frontmatter = entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\n${frontmatter}\n---\n\n${body.trimEnd()}\n`;
}

function hydrateItem(
  meta: RoadmapMeta,
  body: string,
  absolutePath: string,
  raw: string,
): RoadmapItem {
  return {
    ...meta,
    source: meta.source ?? { kind: 'manual' },
    body,
    filePath: repoRelative(absolutePath),
    fileHash: sha256(raw),
  };
}

async function readItemFile(absolutePath: string): Promise<RoadmapItem> {
  const raw = await readFile(absolutePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw, repoRelative(absolutePath));
  const item = hydrateItem(meta, body, absolutePath, raw);
  const refinementPromptPath = await latestRefinementPromptPath(item);
  return {
    ...item,
    ...(refinementPromptPath ? { refinementPromptPath } : {}),
  };
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectMarkdownFiles(child)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
  }
  return out;
}

async function collectRoadmapItemFiles(): Promise<string[]> {
  const files = await collectMarkdownFiles(path.join(ROADMAP_ROOT, 'inbox', 'items'));
  let projectDirs;
  try {
    projectDirs = await readdir(path.join(ROADMAP_ROOT, 'projects'), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw err;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    files.push(
      ...(await collectMarkdownFiles(path.join(ROADMAP_ROOT, 'projects', entry.name, 'items'))),
    );
  }
  return files;
}

async function loadAllItems(): Promise<RoadmapItem[]> {
  const files = await collectRoadmapItemFiles();
  const items: RoadmapItem[] = [];
  for (const file of files) {
    items.push(await readItemFile(file));
  }
  return items.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title),
  );
}

async function findItemById(itemId: string): Promise<RoadmapItem | null> {
  const items = await loadAllItems();
  return items.find((item) => item.id === itemId) ?? null;
}

function itemMatchesSearch(item: RoadmapItem, search: string | undefined): boolean {
  if (!search?.trim()) return true;
  const needle = search.trim().toLowerCase();
  return `${item.title}\n${item.body}\n${item.tags?.join(' ') ?? ''}`
    .toLowerCase()
    .includes(needle);
}

export async function listRoadmapItems(params: RoadmapListParams = {}): Promise<RoadmapListResult> {
  const tagFilter = normalizeRunTags(params.tags);
  const all = await loadAllItems();
  const items = all.filter((item) => {
    if (
      params.project &&
      item.project !== params.project &&
      !(item.targetProjects ?? []).includes(params.project)
    ) {
      return false;
    }
    if (params.stage && item.stage !== params.stage) return false;
    if (!params.includeArchived && item.stage === 'archived') return false;
    if (!itemMatchesSearch(item, params.search)) return false;
    if (tagFilter.length > 0) {
      const tags = new Set(normalizeRunTags(item.tags));
      if (!tagFilter.every((tag) => tags.has(tag))) return false;
    }
    return true;
  });
  return { items };
}

export async function getRoadmapItem(params: RoadmapGetParams): Promise<RoadmapGetResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.get requires itemId');
  const item = await findItemById(params.itemId.trim());
  if (!item) throw new Error(`Roadmap item not found: ${params.itemId}`);
  return { item };
}

export async function getRoadmapPrompt(
  params: RoadmapPromptGetParams,
): Promise<RoadmapPromptGetResult> {
  if (!params.path?.trim()) throw new Error('roadmap.prompt.get requires path');
  const absolutePath = resolveRefinementPromptPath(params.path.trim());
  const content = await readFile(absolutePath, 'utf-8');
  return {
    path: repoRelative(absolutePath),
    absolutePath,
    content,
  };
}

export async function listRoadmapPromotionDrafts(
  params: RoadmapPromotionDraftListParams,
): Promise<RoadmapPromotionDraftListResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.promotionDraft.list requires itemId');
  const dir = promotionDraftDir(params.itemId.trim());
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { drafts: [] };
    throw err;
  }
  const drafts = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const absolutePath = path.join(dir, entry.name);
        const content = await readFile(absolutePath, 'utf-8');
        return {
          path: repoRelative(absolutePath),
          filename: entry.name,
          absolutePath,
          contentHash: sha256(content),
        };
      }),
  );
  return { drafts };
}

export async function getRoadmapPromotionDraft(
  params: RoadmapPromotionDraftGetParams,
): Promise<RoadmapPromotionDraftGetResult> {
  if (!params.path?.trim()) throw new Error('roadmap.promotionDraft.get requires path');
  const absolutePath = resolvePromotionDraftPath(params.path.trim());
  const content = await readFile(absolutePath, 'utf-8');
  return {
    path: repoRelative(absolutePath),
    filename: path.basename(absolutePath),
    absolutePath,
    contentHash: sha256(content),
    content,
  };
}

export async function saveRoadmapPromotionDraft(
  params: RoadmapPromotionDraftSaveParams,
): Promise<RoadmapPromotionDraftSaveResult> {
  if (!params.path?.trim()) throw new Error('roadmap.promotionDraft.save requires path');
  const absolutePath = resolvePromotionDraftPath(params.path.trim());
  const current = await readFile(absolutePath, 'utf-8');
  if (params.expectedHash && params.expectedHash !== sha256(current)) {
    throw new Error('Roadmap promotion draft changed on disk; reload before saving');
  }
  await writeFile(absolutePath, params.content, 'utf-8');
  return getRoadmapPromotionDraft({ path: repoRelative(absolutePath) });
}

function normalizeSaveInput(
  input: RoadmapItemSaveInput,
  existing?: RoadmapItem,
): { meta: RoadmapMeta; body: string } {
  if (!input.title?.trim()) throw new Error('Roadmap item title is required');
  const now = new Date().toISOString();
  const project = normalizeProject(input.project ?? existing?.project);
  const targetProjects = normalizeTargetProjects(input.targetProjects ?? existing?.targetProjects);
  const tags = normalizeRunTags(input.tags ?? existing?.tags);
  const promotion = normalizePromotion(input.promotion ?? existing?.promotion);
  const source = normalizeSource(input.source ?? existing?.source);
  return {
    meta: {
      id: input.id?.trim() || existing?.id || newRoadmapId(),
      kind: 'roadmap-item',
      project,
      ...(targetProjects.length > 0 ? { targetProjects } : {}),
      title: input.title.trim(),
      stage: normalizeStage(input.stage ?? existing?.stage ?? 'rough'),
      ...(tags.length > 0 ? { tags } : {}),
      source,
      ...(promotion ? { promotion } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    body: input.body ?? existing?.body ?? '',
  };
}

function assertRefinedRoadmapBody(stage: RoadmapItemStage, body: string): void {
  if (stage !== 'refined' && stage !== 'promoted') return;
  const requiredHeadings = [
    'Problem',
    'Proposed Solution',
    'Non-goals',
    'Risks',
    'Dispatch Notes',
    'Acceptance Criteria',
  ];
  const missing = requiredHeadings.filter(
    (heading) => !new RegExp(`^##\\s+${heading}\\s*$`, 'im').test(body),
  );
  if (missing.length > 0) {
    throw new Error(`Refined roadmap items require sections: ${missing.join(', ')}`);
  }
  if (extractBacklogAcceptanceCriteria(body).length === 0) {
    throw new Error('Refined roadmap items require a non-empty ## Acceptance Criteria section');
  }
}

async function writeRoadmapFile(absolutePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const tmp = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, absolutePath);
}

function renderBacklogSpecMarkdown(
  item: RoadmapItem,
  spec: RoadmapPromoteSpecInput,
  project: string,
): string {
  const tags = normalizeRunTags([...(item.tags ?? []), ...(spec.tags ?? [])]);
  const frontmatter = [
    ['kind', 'backlog-spec'],
    ['roadmapItemId', item.id],
    ['roadmapTitle', item.title],
    ['project', project],
    ['tags', tags],
  ]
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  const body = spec.body.trim();
  const titledBody = /^#\s+/m.test(body) ? body : `# ${spec.title.trim()}\n\n${body}`;
  return `---\n${frontmatter}\n---\n\n${titledBody.trimEnd()}\n`;
}

function isConcreteProject(project: string): boolean {
  return project !== 'global' && project !== 'unassigned';
}

function defaultPromotionTargetProject(item: RoadmapItem): string | null {
  const targets = item.targetProjects ?? [];
  if (targets.length === 1) return targets[0]!;
  if (targets.length === 0 && isConcreteProject(item.project)) return item.project;
  return null;
}

function resolvePromotionSpecProject(item: RoadmapItem, spec: RoadmapPromoteSpecInput): string {
  const explicit = spec.project?.trim();
  const targets = item.targetProjects ?? [];
  if (explicit) {
    const [project] = normalizeTargetProjects([explicit]);
    if (!project) throw new Error('Backlog spec project is required');
    if (targets.length > 0 && !targets.includes(project)) {
      throw new Error(`Backlog spec project ${project} is not in roadmap targetProjects`);
    }
    if (targets.length === 0 && project !== item.project) {
      throw new Error(
        `Backlog spec project ${project} does not match roadmap project ${item.project}`,
      );
    }
    return project;
  }

  const fallback = defaultPromotionTargetProject(item);
  if (fallback) return fallback;
  throw new Error(
    'Backlog spec project is required when roadmap has multiple or no concrete targets',
  );
}

async function writeBacklogSpecFile(
  project: string,
  title: string,
  markdown: string,
): Promise<string> {
  const absolutePath = await allocateBacklogSpecPath(project, title);
  await writeRoadmapFile(absolutePath, markdown);
  return repoRelative(absolutePath);
}

async function projectRefinementConfig(item: RoadmapItem): Promise<{
  refinementPrompt?: string;
  refinementPromptPath?: string;
  runner?: string;
  model?: string;
  runnerCommand?: string;
  farmslotCommand?: string;
}> {
  if (item.project === 'global' || item.project === 'unassigned') return {};
  const project = await loadProjectConfig(item.project);
  if (!project) return {};
  const roadmap = project.roadmap;
  const defaultRefinement =
    project.defaults.feature ?? project.defaults.dev ?? project.defaults.fix;
  return {
    ...(roadmap?.refinementPrompt ? { refinementPrompt: roadmap.refinementPrompt } : {}),
    ...(roadmap?.refinementPromptPath
      ? { refinementPromptPath: roadmap.refinementPromptPath }
      : {}),
    ...((roadmap?.runner ?? defaultRefinement?.runner)
      ? { runner: roadmap?.runner ?? defaultRefinement?.runner }
      : {}),
    ...((roadmap?.model ?? defaultRefinement?.model)
      ? { model: roadmap?.model ?? defaultRefinement?.model }
      : {}),
    ...(roadmap?.runnerCommand ? { runnerCommand: roadmap.runnerCommand } : {}),
    ...(roadmap?.farmslotCommand ? { farmslotCommand: roadmap.farmslotCommand } : {}),
  };
}

function roadmapRoute(item: RoadmapItem): string {
  const params = new URLSearchParams();
  if (item.targetProjects?.length) params.set('projects', item.targetProjects.join(','));
  params.set('item', item.id);
  return `#roadmap?${params.toString()}`;
}

function defaultFarmslotCommand(farmslotCommand?: string): string {
  const command =
    farmslotCommand?.trim() ||
    process.env.FARMSLOT_COMMAND?.trim() ||
    checkoutFarmslotCommand() ||
    'farmslot';
  return command;
}

function checkoutFarmslotCommand(): string | null {
  for (const name of ['.env.ports', '.env']) {
    const envPath = path.join(farmslotRoot, name);
    if (!existsSync(envPath)) continue;
    let text: string;
    try {
      text = readFileSync(envPath, 'utf-8');
    } catch {
      continue;
    }
    const command = parseSimpleEnvValue(text, 'FARMSLOT_COMMAND');
    if (command) return command;
  }
  return null;
}

function parseSimpleEnvValue(text: string, key: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match =
      line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/) ??
      line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2]?.trim() ?? '';
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

function defaultPromotionRequestCommand(item: RoadmapItem, farmslotCommand?: string): string {
  return [
    defaultFarmslotCommand(farmslotCommand),
    'roadmap',
    'request-promotion',
    '--item-id',
    shellQuote(item.id),
    '--item-file',
    shellQuote(item.filePath),
    '--title',
    shellQuote(item.title),
    '--target-projects',
    shellQuote((item.targetProjects ?? []).join(',')),
    '--roadmap-route',
    shellQuote(roadmapRoute(item)),
  ].join(' ');
}

function contextProjects(item: RoadmapItem): string[] {
  const projects = item.targetProjects?.length
    ? item.targetProjects
    : isConcreteProject(item.project)
      ? [item.project]
      : [];
  return [...new Set(projects)].sort();
}

function renderSlotContext(project: string, pools: PoolConfig[]): string {
  const slots = pools.flatMap((pool) =>
    pool.slots
      .filter((slot) => slot.project === project)
      .map((slot) => ({
        machine: pool.machine,
        platform: slot.resources?.['ios-sim']
          ? 'ios'
          : slot.resources?.['android-emu'] || slot.resources?.['android-device']
            ? 'android'
            : (pool.platform ?? 'unknown'),
        slot,
      })),
  );
  if (slots.length === 0) return '- Slots: none configured in pool/*.json';
  return [
    '- Slots:',
    ...slots.map(({ machine, platform, slot }) =>
      [
        `  - ${slot.id}`,
        `machine=${machine}`,
        `repo=${slot.repo}`,
        `tmux=${slot.session}`,
        `platform=${platform}`,
        `mode=${slot.mode}`,
        slot.enabled === false ? 'disabled' : 'enabled',
      ].join(' · '),
    ),
  ].join('\n');
}

async function roadmapFrameworkContext(item: RoadmapItem): Promise<string> {
  const projects = contextProjects(item);
  const pools = await loadPoolConfigs();
  const projectBlocks =
    projects.length > 0
      ? projects.map((project) =>
          [
            `### ${project}`,
            `- Farmslot project config: projects/${project}/project.json`,
            '- Project templates/hooks live under `projects/<project>/`; client source code lives in the slot repo path below.',
            renderSlotContext(project, pools),
          ].join('\n'),
        )
      : [
          'No concrete target projects are set yet. Use targetProjects before drafting backlog specs.',
        ];
  return [
    `Farmslot repo root: ${farmslotRoot}`,
    `Roadmap item file: ${item.filePath}`,
    '',
    'Farmslot model:',
    '- This runner is working in the Farmslot framework repo.',
    '- `projects/<project>/project.json` configures hooks, templates, defaults, and project metadata.',
    '- `pool/*.json` maps dispatch slots to real source checkouts, tmux sessions, machines, and resources.',
    '- Backlog specs should target projects and slots, but this refinement run must not dispatch or prepare slots.',
    '',
    ...projectBlocks,
  ].join('\n');
}

async function refinementPromptVars(
  item: RoadmapItem,
  runner?: string,
  model?: string,
  farmslotCommand?: string,
): Promise<Record<string, string>> {
  const tags = (item.tags ?? []).join(', ') || '(none)';
  const targetProjects = (item.targetProjects ?? []).join(', ') || '(none)';
  const currentMarkdown = item.body.trim() || '(empty)';
  const context = await roadmapFrameworkContext(item);
  const promotionCommand = defaultPromotionRequestCommand(item, farmslotCommand);
  return {
    ROADMAP_ITEM_ID: item.id,
    ITEM_ID: item.id,
    TITLE: item.title,
    PROJECT: item.project,
    TARGET_PROJECTS: targetProjects,
    STAGE: item.stage,
    FILE_PATH: item.filePath,
    ITEM_FILE: item.filePath,
    TAGS: tags,
    RUNNER: runner || '(project default)',
    MODEL: model || '(project default)',
    FARMSLOT_CONTEXT: context,
    PROMOTION_REQUEST_COMMAND: promotionCommand,
    CURRENT_MARKDOWN: currentMarkdown,
    BODY: currentMarkdown,
    roadmap_item_id: item.id,
    item_id: item.id,
    title: item.title,
    project: item.project,
    target_projects: targetProjects,
    stage: item.stage,
    file_path: item.filePath,
    item_file: item.filePath,
    tags,
    runner: runner || '(project default)',
    model: model || '(project default)',
    farmslot_context: context,
    promotion_request_command: promotionCommand,
    current_markdown: currentMarkdown,
    body: currentMarkdown,
  };
}

function expandPromptTemplate(
  template: string,
  vars: Record<string, string>,
  source: string,
): string {
  assertNoUnknownPlaceholders(template, Object.keys(vars), source);
  let rendered = template;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return `${rendered.trimEnd()}\n`;
}

async function loadExplicitRefinementPromptTemplate(
  project: string,
  refinementPromptPath: string,
  vars: Record<string, string>,
): Promise<string> {
  const promptPath = path.isAbsolute(refinementPromptPath)
    ? refinementPromptPath
    : path.join(farmslotRoot, 'projects', project, refinementPromptPath);
  return expandPromptTemplate(
    await readFile(promptPath, 'utf-8'),
    vars,
    `Roadmap refinement prompt ${promptPath}`,
  );
}

async function resolveRoadmapRefinementPrompt(
  item: RoadmapItem,
  config: {
    refinementPrompt?: string;
    refinementPromptPath?: string;
    farmslotCommand?: string;
  },
  runner?: string,
  model?: string,
): Promise<string> {
  const vars = await refinementPromptVars(item, runner, model, config.farmslotCommand);
  if (config.refinementPromptPath) {
    return loadExplicitRefinementPromptTemplate(item.project, config.refinementPromptPath, vars);
  }
  if (config.refinementPrompt)
    return expandPromptTemplate(
      config.refinementPrompt,
      vars,
      `Inline roadmap refinement prompt for ${item.project}`,
    );

  const projectTemplate = await loadPromptTemplate(
    item.project,
    ROADMAP_REFINEMENT_PROMPT_TEMPLATE,
    vars,
  );
  if (projectTemplate?.trim()) return `${projectTemplate.trimEnd()}\n`;

  if (item.project !== DEFAULT_PROMPT_PROJECT) {
    const fallback = await loadPromptTemplate(
      DEFAULT_PROMPT_PROJECT,
      ROADMAP_REFINEMENT_PROMPT_TEMPLATE,
      vars,
    );
    if (fallback?.trim()) return `${fallback.trimEnd()}\n`;
  }

  return renderBuiltInRefinementPrompt(
    item,
    runner,
    model,
    vars.FARMSLOT_CONTEXT,
    vars.PROMOTION_REQUEST_COMMAND,
  );
}

function renderBuiltInRefinementPrompt(
  item: RoadmapItem,
  runner?: string,
  model?: string,
  farmslotContext?: string,
  promotionRequestCommand?: string,
): string {
  return [
    '# Roadmap refinement task',
    '',
    `Roadmap item: ${item.id}`,
    `Project: ${item.project}`,
    `Target projects: ${(item.targetProjects ?? []).join(', ') || '(none)'}`,
    `Stage: ${item.stage}`,
    `File: ${item.filePath}`,
    `Tags: ${(item.tags ?? []).join(', ') || '(none)'}`,
    `Refinement runner: ${runner || '(project default)'}`,
    `Refinement model: ${model || '(project default)'}`,
    '',
    '## Farmslot framework context',
    '',
    farmslotContext || '(unavailable)',
    '',
    'This is an interactive planning/refinement session inside the Farmslot framework, not an implementation run.',
    'Before changing the roadmap markdown file, show the operator a concise proposed refinement and ask what to do next.',
    'Only edit the roadmap markdown file after the operator confirms. Never overwrite the rough idea silently.',
    'Do not create ADRs automatically.',
    'If an ADR seems necessary, add an ordinary markdown note for the developer to handle manually.',
    'Treat `farmslot roadmap --help` as the discoverable command surface.',
    '',
    'Before drafting final backlog content from GitHub PR or issue URLs, verify those references with authenticated local tooling when available.',
    'For GitHub PR URLs, prefer `gh pr view <number> --repo <owner>/<repo> --json title,body,state,mergedAt,headRefName,baseRefName,files,commits`.',
    'If `gh` hits a network/auth/sandbox approval boundary, ask the operator before falling back to unverified assumptions.',
    'Do not say a PR cannot be verified until authenticated `gh` has been tried or the operator declines that lookup.',
    'Summarize which references were verified and which remain unverified before asking to apply the roadmap edit.',
    '',
    'The refined item should include:',
    '',
    '- `## Problem`',
    '- `## Proposed Solution`',
    '- `## Non-goals`',
    '- `## Risks`',
    '- `## Dispatch Notes`',
    '- `## Acceptance Criteria`',
    '',
    'When the file satisfies this contract, update the roadmap item frontmatter to `stage: "refined"` and refresh `updatedAt`.',
    'Leave it as `stage: "refining"` only if important information is still missing.',
    '',
    'Keep backlog boundaries clear: draft count follows deployable objectives, not len(targetProjects).',
    'targetProjects is the allowed implementation set, not a mandate to open one ticket per listed project.',
    'Multiple drafts for the same project are valid when objectives are independent; framework-only Farmslot monorepo work still prefers one farmslot-farm draft (narrow over-broad targetProjects).',
    'Cross-project fan-out only when each project needs distinct code or dispatch. Packs that prefer smaller slices override via project roadmap.refinement_prompt_path / refinement_prompt.',
    'Each backlog draft must include a promotion-valid `## Acceptance Criteria` section.',
    'Use one `### Backlog Draft: <title>` heading per draft and do not repeat the same title as a separate `Title:` line.',
    'Use draft-local `#### Implementation Notes` and `#### References` headings so the roadmap remains readable.',
    '',
    'When the roadmap item is refined and the backlog drafts are ready, ask the operator whether to request promotion review.',
    'If they confirm, request human promotion with:',
    '',
    '```sh',
    promotionRequestCommand || '(promotion request command unavailable)',
    '```',
    '',
    'Run that command at most once. It creates a Farmslot/Command Center human decision only; it does not create backlog items.',
    'Do not promote, create, or dispatch backlog items yourself.',
    'For final verification, reread the roadmap markdown and the promotion decision file if one was created; do not rely on `git diff` alone because roadmap inbox files may be untracked or ignored.',
    '',
    'Current roadmap markdown:',
    '',
    item.body.trim() || '(empty)',
    '',
  ].join('\n');
}

function refinementSessionName(item: RoadmapItem): string {
  return `roadmap-${slugify(item.id)}`;
}

async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', `=${session}`]);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
    throw err;
  }
}

function defaultRefinementRunnerCommand(
  runner: string | undefined,
  model: string | undefined,
  promptPath: string,
  safetyTier?: SafetyTier,
): string | null {
  const runnerId = runner?.trim();
  if (!runnerId) return null;
  const modelFlag = model?.trim() ? ` --model ${shellQuote(model.trim())}` : '';
  const promptArg = `"$(cat ${shellQuote(promptPath)})"`;
  const safetyFlags = runnerFlagsForTier(runnerId, safetyTier).map(shellQuote).join(' ');
  if (runnerId === 'codex') {
    const codexSafety = safetyFlags || '--sandbox workspace-write --ask-for-approval on-request';
    return [
      shellQuote('codex'),
      `--cd ${shellQuote(farmslotRoot)}`,
      codexSafety,
      modelFlag.trim(),
      promptArg,
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (runnerId === 'cursor') {
    const flags = safetyFlags ? ` ${safetyFlags}` : '';
    return `${shellQuote('cursor-agent')} --workspace ${shellQuote(farmslotRoot)}${flags}${modelFlag} ${promptArg}`;
  }
  const flags = safetyFlags ? ` ${safetyFlags}` : '';
  return `${shellQuote(runnerId)}${flags}${modelFlag} ${promptArg}`;
}

function expandRefinementRunnerCommand(
  command: string,
  context: {
    runner?: string;
    model?: string;
    promptPath: string;
    itemFile: string;
    safetyTier?: SafetyTier;
  },
): string {
  const replacements: Record<string, string> = {
    runner: shellQuote(context.runner ?? ''),
    model: shellQuote(context.model ?? ''),
    prompt_path: shellQuote(context.promptPath),
    item_file: shellQuote(context.itemFile),
    safety_tier: shellQuote(context.safetyTier ?? ''),
    safety_flags: runnerFlagsForTier(context.runner ?? '', context.safetyTier)
      .map(shellQuote)
      .join(' '),
  };
  // A raw {{...}} surviving into a shell command is worse than into a prompt.
  assertNoUnknownPlaceholders(command, Object.keys(replacements), 'Roadmap refinement command');
  let expanded = command;
  for (const [key, value] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, value);
  }
  if (!command.includes('{{prompt_path}}'))
    expanded = `${expanded} ${shellQuote(context.promptPath)}`;
  return expanded;
}

function roadmapRefinementRunnerPrelude(): string {
  return [
    'unset TMUX TMUX_PANE',
    'export FARMSLOT_ROADMAP_REFINEMENT=1',
    'export FARMSLOT_RUNNER_SCOPE=roadmap-refinement',
  ].join(' && ');
}

function buildRefinementShellCommand(
  item: RoadmapItem,
  promptPath: string,
  runnerCommand?: string,
  runner?: string,
  model?: string,
  safetyTier?: SafetyTier,
): string {
  const absolutePromptPath = path.resolve(farmslotRoot, promptPath);
  const absoluteItemFile = path.resolve(farmslotRoot, item.filePath);
  const commandTemplate =
    runnerCommand?.trim() || process.env.FARMSLOT_ROADMAP_REFINER_COMMAND?.trim();
  const defaultCommand = defaultRefinementRunnerCommand(
    runner,
    model,
    absolutePromptPath,
    safetyTier,
  );
  const prelude = roadmapRefinementRunnerPrelude();
  if (commandTemplate) {
    return `cd ${shellQuote(farmslotRoot)} && ${prelude} && ${expandRefinementRunnerCommand(
      commandTemplate,
      {
        ...(runner ? { runner } : {}),
        ...(model ? { model } : {}),
        ...(safetyTier ? { safetyTier } : {}),
        promptPath: absolutePromptPath,
        itemFile: absoluteItemFile,
      },
    )}`;
  }
  if (defaultCommand)
    return `cd ${shellQuote(farmslotRoot)} && ${prelude} && exec ${defaultCommand}`;
  return [
    `cd ${shellQuote(farmslotRoot)}`,
    prelude,
    `printf '%s\n' ${shellQuote(`Roadmap refinement prompt: ${absolutePromptPath}`)}`,
    `printf '%s\n' ${shellQuote(`Edit roadmap item: ${path.resolve(farmslotRoot, item.filePath)}`)}`,
    'exec ${SHELL:-zsh} -l',
  ].join(' && ');
}

async function launchRefinementTmux(
  item: RoadmapItem,
  promptPath: string,
  runnerCommand?: string,
  runner?: string,
  model?: string,
  safetyTier?: SafetyTier,
): Promise<boolean> {
  const session = refinementSessionName(item);
  if (await tmuxSessionExists(session)) return false;
  const shellCommand = buildRefinementShellCommand(
    item,
    promptPath,
    runnerCommand,
    runner,
    model,
    safetyTier,
  );
  await execFileAsync('tmux', [
    'new-session',
    '-d',
    '-s',
    session,
    '-c',
    farmslotRoot,
    shellCommand,
  ]);
  return true;
}

async function localTmuxWorkerNodeId(): Promise<string> {
  const pools = await loadPoolConfigs();
  const localPool = pools.find((pool) => isLocal(pool.host, pool.machine));
  return localPool?.machine ?? os.hostname().replace(/\.local$/, '');
}

async function resolveTmuxSessionWorker(session: string): Promise<TmuxWorkerRef> {
  const { stdout } = await execFileAsync('tmux', [
    'list-panes',
    '-t',
    `=${session}`,
    '-F',
    '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}',
  ]);
  const [line] = stdout.split('\n').filter(Boolean);
  if (!line) throw new Error(`tmux session ${session} has no panes`);
  const [sessionName, window, windowName, pane, paneId] = line.split('\t');
  const target = paneId || `${sessionName}:${window}.${pane}`;
  return {
    nodeId: await localTmuxWorkerNodeId(),
    session: sessionName,
    window,
    ...(windowName ? { windowName } : {}),
    pane,
    ...(paneId ? { paneId } : {}),
    target,
  };
}

export async function getRoadmapRefinementSession(
  params: RoadmapRefinementSessionGetParams,
): Promise<RoadmapRefinementSessionGetResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.refinementSession.get requires itemId');
  const item = (await getRoadmapItem({ itemId: params.itemId.trim() })).item;
  const session = refinementSessionName(item);
  const exists = await tmuxSessionExists(session);
  const tmuxWorker = exists ? await resolveTmuxSessionWorker(session) : undefined;
  return {
    itemId: item.id,
    tmuxSession: session,
    tmuxTarget: tmuxWorker?.target ?? session,
    exists,
    ...(tmuxWorker ? { tmuxWorker } : {}),
    attachCommand: `tmux attach -t ${shellQuote(`=${session}`)}`,
  };
}

async function saveRoadmapItemUnlocked(params: RoadmapSaveParams): Promise<RoadmapSaveResult> {
  const input = params.item;
  const existing = input.id ? await findItemById(input.id) : null;
  const project = normalizeProject(input.project);
  const currentPath = existing
    ? resolveRoadmapPath(existing.filePath)
    : input.filePath
      ? assertRoadmapItemPath(input.filePath, project)
      : await allocatePath(project, input.title);
  if (existing) {
    const currentHash = (await readItemFile(currentPath)).fileHash;
    const expectedHash = params.expectedHash ?? input.fileHash;
    if (!expectedHash)
      throw new Error('roadmap.save requires expectedHash or item.fileHash for updates');
    if (currentHash !== expectedHash)
      throw new Error('Roadmap item changed on disk; reload before saving');
  }
  const { meta, body } = normalizeSaveInput(input, existing ?? undefined);
  assertRefinedRoadmapBody(meta.stage, body);
  const targetPath =
    existing && existing.project !== meta.project
      ? await allocatePath(meta.project, meta.title)
      : currentPath;
  const content = renderMarkdown(meta, body);
  await writeRoadmapFile(targetPath, content);
  if (existing && targetPath !== currentPath) await unlink(currentPath);
  return { item: hydrateItem(meta, body, targetPath, content) };
}

export async function saveRoadmapItem(params: RoadmapSaveParams): Promise<RoadmapSaveResult> {
  return withRoadmapMutation(() => saveRoadmapItemUnlocked(params));
}

async function deleteRoadmapItemUnlocked(
  params: RoadmapDeleteParams,
): Promise<RoadmapDeleteResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.delete requires itemId');
  const current = (await getRoadmapItem({ itemId: params.itemId.trim() })).item;
  if (params.expectedHash && params.expectedHash !== current.fileHash) {
    throw new Error('Roadmap item changed on disk; reload before deleting');
  }
  if (current.stage === 'promoted' || current.promotion?.length) {
    throw new Error('Promoted roadmap items cannot be deleted; archive them instead');
  }
  await unlink(resolveRoadmapPath(current.filePath));
  return { ok: true };
}

export async function deleteRoadmapItem(params: RoadmapDeleteParams): Promise<RoadmapDeleteResult> {
  return withRoadmapMutation(() => deleteRoadmapItemUnlocked(params));
}

export async function startRoadmapRefinement(
  params: RoadmapRefineParams,
): Promise<RoadmapRefineResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.refine requires itemId');
  const current = (await getRoadmapItem({ itemId: params.itemId.trim() })).item;
  if (params.expectedHash && params.expectedHash !== current.fileHash) {
    throw new Error('Roadmap item changed on disk; reload before refining');
  }
  if (current.stage === 'archived' || current.stage === 'promoted') {
    throw new Error(`Cannot refine roadmap item in stage ${current.stage}`);
  }

  const item =
    params.markRefining === false || current.stage === 'refining'
      ? current
      : (
          await saveRoadmapItem({
            expectedHash: current.fileHash,
            item: {
              id: current.id,
              project: current.project,
              ...(current.targetProjects ? { targetProjects: current.targetProjects } : {}),
              title: current.title,
              stage: 'refining',
              ...(current.tags ? { tags: current.tags } : {}),
              source: current.source,
              body: current.body,
              ...(current.promotion ? { promotion: current.promotion } : {}),
            },
          })
        ).item;
  const projectConfig = await projectRefinementConfig(item);
  const runner =
    params.runner?.trim() ||
    projectConfig.runner ||
    process.env.FARMSLOT_ROADMAP_REFINER_RUNNER?.trim() ||
    DEFAULT_ROADMAP_REFINEMENT_RUNNER;
  const model =
    params.model?.trim() ||
    projectConfig.model ||
    process.env.FARMSLOT_ROADMAP_REFINER_MODEL?.trim() ||
    DEFAULT_ROADMAP_REFINEMENT_MODEL;
  const runnerCommand = params.runnerCommand?.trim() || projectConfig.runnerCommand;
  const safetyTier = params.safetyTier;
  const session = refinementSessionName(item);
  const existingSession = params.launch === true && (await tmuxSessionExists(session));
  const prompt = await resolveRoadmapRefinementPrompt(item, projectConfig, runner, model);
  const absolutePromptPath = await allocateRefinementPromptPath(item);
  await writeRoadmapFile(absolutePromptPath, prompt);
  const promptPath = repoRelative(absolutePromptPath);
  const launched =
    params.launch === true && !existingSession
      ? await launchRefinementTmux(item, promptPath, runnerCommand, runner, model, safetyTier)
      : false;
  const tmuxWorker =
    params.launch === true && (launched || existingSession)
      ? await resolveTmuxSessionWorker(session)
      : undefined;
  return {
    item: {
      ...item,
      refinementPromptPath: promptPath,
    },
    promptPath,
    tmuxSession: session,
    tmuxTarget: tmuxWorker?.target ?? session,
    ...(tmuxWorker ? { tmuxWorker } : {}),
    launched,
    ...(existingSession ? { attachedExisting: true } : {}),
    attachCommand: `tmux attach -t ${shellQuote(`=${session}`)}`,
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(runnerCommand ? { runnerCommand } : {}),
    ...(safetyTier ? { safetyTier } : {}),
  };
}

async function promoteRoadmapItemUnlocked(
  params: RoadmapPromoteParams,
): Promise<RoadmapPromoteResult> {
  if (!params.itemId?.trim()) throw new Error('roadmap.promote requires itemId');
  if (!Array.isArray(params.specs) || params.specs.length === 0) {
    throw new Error('roadmap.promote requires at least one backlog spec');
  }
  const current = (await getRoadmapItem({ itemId: params.itemId.trim() })).item;
  if (current.stage !== 'refined') throw new Error('Only refined roadmap items can be promoted');
  if (params.expectedHash && params.expectedHash !== current.fileHash) {
    throw new Error('Roadmap item changed on disk; reload before promoting');
  }

  const preparedSpecs = params.specs.map((spec) => {
    if (!spec.title?.trim()) throw new Error('Backlog spec title is required');
    if (!spec.body?.trim()) throw new Error(`Backlog spec body is required: ${spec.title}`);
    const project = resolvePromotionSpecProject(current, spec);
    const markdown = renderBacklogSpecMarkdown(current, spec, project);
    if (extractBacklogAcceptanceCriteria(markdown).length === 0) {
      throw new Error(
        `Backlog spec requires a non-empty ## Acceptance Criteria section: ${spec.title}`,
      );
    }
    const tags = normalizeRunTags([...(current.tags ?? []), ...(spec.tags ?? [])]);
    return { spec, project, markdown, tags };
  });

  const backlogItems: RoadmapPromoteResult['backlogItems'] = [];
  const specPaths: string[] = [];
  const promotion: RoadmapPromotionEntry[] = [...(current.promotion ?? [])];
  let updated: RoadmapSaveResult;
  try {
    for (const prepared of preparedSpecs) {
      const { spec, project, markdown, tags } = prepared;
      const specPath = await writeBacklogSpecFile(project, spec.title, markdown);
      specPaths.push(specPath);
      const created = await createBacklogItem({
        project,
        title: spec.title,
        sourceKind: 'manual',
        flowType: spec.flowType ?? 'dev',
        roadmapItemId: current.id,
        specPath,
        tags,
        status: 'ready',
        notes: `Promoted from roadmap item ${current.id}: ${current.title}`,
        ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        ...(spec.allowedSlots !== undefined ? { allowedSlots: spec.allowedSlots } : {}),
        autoDispatch: false,
      });
      backlogItems.push(created.item);
      promotion.push({
        backlogItemId: created.item.id,
        specPath,
        project,
        createdAt: created.item.createdAt,
      });
    }

    updated = await saveRoadmapItemUnlocked({
      expectedHash: current.fileHash,
      item: {
        id: current.id,
        project: current.project,
        ...(current.targetProjects ? { targetProjects: current.targetProjects } : {}),
        title: current.title,
        stage: 'promoted',
        ...(current.tags ? { tags: current.tags } : {}),
        source: current.source,
        body: current.body,
        promotion,
      },
    });

    for (let index = 0; index < backlogItems.length; index += 1) {
      const ready = await markBacklogItemReady({ itemId: backlogItems[index]!.id });
      backlogItems[index] =
        preparedSpecs[index]?.spec.autoDispatch === true
          ? (await updateBacklogItem({ itemId: ready.item.id, autoDispatch: true })).item
          : ready.item;
    }
  } catch (err) {
    await Promise.allSettled(backlogItems.map((item) => deleteBacklogItem(item.id)));
    await Promise.allSettled(
      specPaths.map((specPath) => unlink(path.resolve(farmslotRoot, specPath))),
    );
    throw err;
  }

  return { roadmapItem: updated.item, backlogItems, specPaths };
}

export async function promoteRoadmapItem(
  params: RoadmapPromoteParams,
): Promise<RoadmapPromoteResult> {
  return withRoadmapMutation(() => promoteRoadmapItemUnlocked(params));
}

export const __roadmapStoreTest = {
  buildRefinementShellCommand,
  defaultPromotionRequestCommand,
};
