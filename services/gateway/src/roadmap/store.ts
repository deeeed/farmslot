import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  normalizeRunTags,
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
  type RoadmapPromotionEntry,
  type RoadmapRefineParams,
  type RoadmapRefineResult,
  type RoadmapSaveParams,
  type RoadmapSaveResult,
  type RoadmapSource,
} from '@farmslot/protocol';

import {
  createBacklogItem,
  deleteBacklogItem,
  extractBacklogAcceptanceCriteria,
  markBacklogItemReady,
  updateBacklogItem,
} from '../backlog/store.js';
import { loadPromptTemplate } from '../core/prompt-templates.js';
import { farmslotRoot, loadProjectConfig } from '../fleet/state.js';

const VALID_STAGES = new Set<RoadmapItemStage>(ROADMAP_ITEM_STAGES);
const VALID_SOURCE_KINDS = new Set<string>(ROADMAP_SOURCE_KINDS);
const ROADMAP_ROOT = process.env.FARMSLOT_ROADMAP_DIR ?? path.join(farmslotRoot, '.roadmap');
const BACKLOG_SPEC_ROOT =
  process.env.FARMSLOT_BACKLOG_SPEC_DIR ?? path.join(farmslotRoot, '.backlog', 'specs');
const REFINEMENT_PROMPT_ROOT =
  process.env.FARMSLOT_ROADMAP_REFINEMENT_PROMPT_DIR ??
  path.join(ROADMAP_ROOT, 'refinement-prompts');
const execFileAsync = promisify(execFile);
const DEFAULT_PROMPT_PROJECT = 'farmslot-farm';
const ROADMAP_REFINEMENT_PROMPT_TEMPLATE = 'roadmap-refinement.md';
let roadmapMutationTail: Promise<void> = Promise.resolve();

type RoadmapMeta = {
  id: string;
  kind: 'roadmap-item';
  project: string;
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
  return {
    meta: {
      id: parsed.id,
      kind: 'roadmap-item',
      project: parsed.project,
      title: parsed.title,
      stage,
      ...(tags.length > 0 ? { tags } : {}),
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
  return hydrateItem(meta, body, absolutePath, raw);
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
    if (params.project && item.project !== params.project) return false;
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

function normalizeSaveInput(
  input: RoadmapItemSaveInput,
  existing?: RoadmapItem,
): { meta: RoadmapMeta; body: string } {
  if (!input.title?.trim()) throw new Error('Roadmap item title is required');
  const now = new Date().toISOString();
  const project = normalizeProject(input.project ?? existing?.project);
  const tags = normalizeRunTags(input.tags ?? existing?.tags);
  const promotion = normalizePromotion(input.promotion ?? existing?.promotion);
  const source = normalizeSource(input.source ?? existing?.source);
  return {
    meta: {
      id: input.id?.trim() || existing?.id || newRoadmapId(),
      kind: 'roadmap-item',
      project,
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

function renderBacklogSpecMarkdown(item: RoadmapItem, spec: RoadmapPromoteSpecInput): string {
  const tags = normalizeRunTags([...(item.tags ?? []), ...(spec.tags ?? [])]);
  const frontmatter = [
    ['kind', 'backlog-spec'],
    ['roadmapItemId', item.id],
    ['roadmapTitle', item.title],
    ['tags', tags],
  ]
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  const body = spec.body.trim();
  const titledBody = /^#\s+/m.test(body) ? body : `# ${spec.title.trim()}\n\n${body}`;
  return `---\n${frontmatter}\n---\n\n${titledBody.trimEnd()}\n`;
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
  };
}

function refinementPromptVars(
  item: RoadmapItem,
  runner?: string,
  model?: string,
): Record<string, string> {
  const tags = (item.tags ?? []).join(', ') || '(none)';
  const currentMarkdown = item.body.trim() || '(empty)';
  return {
    ROADMAP_ITEM_ID: item.id,
    ITEM_ID: item.id,
    TITLE: item.title,
    PROJECT: item.project,
    STAGE: item.stage,
    FILE_PATH: item.filePath,
    ITEM_FILE: item.filePath,
    TAGS: tags,
    RUNNER: runner || '(project default)',
    MODEL: model || '(project default)',
    CURRENT_MARKDOWN: currentMarkdown,
    BODY: currentMarkdown,
    roadmap_item_id: item.id,
    item_id: item.id,
    title: item.title,
    project: item.project,
    stage: item.stage,
    file_path: item.filePath,
    item_file: item.filePath,
    tags,
    runner: runner || '(project default)',
    model: model || '(project default)',
    current_markdown: currentMarkdown,
    body: currentMarkdown,
  };
}

function expandPromptTemplate(template: string, vars: Record<string, string>): string {
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
  return expandPromptTemplate(await readFile(promptPath, 'utf-8'), vars);
}

async function resolveRoadmapRefinementPrompt(
  item: RoadmapItem,
  config: { refinementPrompt?: string; refinementPromptPath?: string },
  runner?: string,
  model?: string,
): Promise<string> {
  const vars = refinementPromptVars(item, runner, model);
  if (config.refinementPromptPath) {
    return loadExplicitRefinementPromptTemplate(item.project, config.refinementPromptPath, vars);
  }
  if (config.refinementPrompt) return expandPromptTemplate(config.refinementPrompt, vars);

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

  return renderBuiltInRefinementPrompt(item, runner, model);
}

function renderBuiltInRefinementPrompt(item: RoadmapItem, runner?: string, model?: string): string {
  return [
    '# Roadmap refinement task',
    '',
    `Roadmap item: ${item.id}`,
    `Project: ${item.project}`,
    `Stage: ${item.stage}`,
    `File: ${item.filePath}`,
    `Tags: ${(item.tags ?? []).join(', ') || '(none)'}`,
    `Refinement runner: ${runner || '(project default)'}`,
    `Refinement model: ${model || '(project default)'}`,
    '',
    'Refine the roadmap markdown file in-place. Do not create ADRs automatically.',
    'If an ADR seems necessary, add an ordinary markdown note for the developer to handle manually.',
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
    'Keep backlog boundaries clear: one refined roadmap item may promote into multiple backlog specs.',
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
    await execFileAsync('tmux', ['has-session', '-t', session]);
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
): string | null {
  const runnerCommand = runner?.trim();
  if (!runnerCommand) return null;
  const modelFlag = model?.trim() ? ` --model ${shellQuote(model.trim())}` : '';
  return `${shellQuote(runnerCommand)}${modelFlag} "$(cat ${shellQuote(promptPath)})"`;
}

function expandRefinementRunnerCommand(
  command: string,
  context: { runner?: string; model?: string; promptPath: string; itemFile: string },
): string {
  const replacements: Record<string, string> = {
    runner: shellQuote(context.runner ?? ''),
    model: shellQuote(context.model ?? ''),
    prompt_path: shellQuote(context.promptPath),
    item_file: shellQuote(context.itemFile),
  };
  let expanded = command;
  for (const [key, value] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, value);
  }
  if (!command.includes('{{prompt_path}}'))
    expanded = `${expanded} ${shellQuote(context.promptPath)}`;
  return expanded;
}

async function launchRefinementTmux(
  item: RoadmapItem,
  promptPath: string,
  runnerCommand?: string,
  runner?: string,
  model?: string,
): Promise<boolean> {
  const session = refinementSessionName(item);
  if (await tmuxSessionExists(session)) return false;
  const absolutePromptPath = path.resolve(farmslotRoot, promptPath);
  const absoluteItemFile = path.resolve(farmslotRoot, item.filePath);
  const commandTemplate =
    runnerCommand?.trim() || process.env.FARMSLOT_ROADMAP_REFINER_COMMAND?.trim();
  const defaultCommand = defaultRefinementRunnerCommand(runner, model, absolutePromptPath);
  const shellCommand = commandTemplate
    ? `cd ${shellQuote(farmslotRoot)} && ${expandRefinementRunnerCommand(commandTemplate, {
        ...(runner ? { runner } : {}),
        ...(model ? { model } : {}),
        promptPath: absolutePromptPath,
        itemFile: absoluteItemFile,
      })}`
    : defaultCommand
      ? `cd ${shellQuote(farmslotRoot)} && exec ${defaultCommand}`
      : [
          `cd ${shellQuote(farmslotRoot)}`,
          `printf '%s\n' ${shellQuote(`Roadmap refinement prompt: ${absolutePromptPath}`)}`,
          `printf '%s\n' ${shellQuote(`Edit roadmap item: ${path.resolve(farmslotRoot, item.filePath)}`)}`,
          'exec ${SHELL:-zsh} -l',
        ].join(' && ');
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
  const runner = params.runner?.trim() || projectConfig.runner;
  const model = params.model?.trim() || projectConfig.model;
  const runnerCommand = params.runnerCommand?.trim() || projectConfig.runnerCommand;
  const prompt = await resolveRoadmapRefinementPrompt(item, projectConfig, runner, model);
  const absolutePromptPath = await allocateRefinementPromptPath(item);
  await writeRoadmapFile(absolutePromptPath, prompt);
  const promptPath = repoRelative(absolutePromptPath);
  const session = refinementSessionName(item);
  const launched =
    params.launch === true
      ? await launchRefinementTmux(item, promptPath, runnerCommand, runner, model)
      : false;
  return {
    item,
    promptPath,
    tmuxSession: session,
    tmuxTarget: session,
    launched,
    attachCommand: `tmux attach -t ${shellQuote(session)}`,
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(runnerCommand ? { runnerCommand } : {}),
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
  if (current.project === 'global' || current.project === 'unassigned') {
    throw new Error('Roadmap item must be assigned to a concrete project before promotion');
  }
  if (params.expectedHash && params.expectedHash !== current.fileHash) {
    throw new Error('Roadmap item changed on disk; reload before promoting');
  }

  const preparedSpecs = params.specs.map((spec) => {
    if (!spec.title?.trim()) throw new Error('Backlog spec title is required');
    if (!spec.body?.trim()) throw new Error(`Backlog spec body is required: ${spec.title}`);
    const markdown = renderBacklogSpecMarkdown(current, spec);
    if (extractBacklogAcceptanceCriteria(markdown).length === 0) {
      throw new Error(
        `Backlog spec requires a non-empty ## Acceptance Criteria section: ${spec.title}`,
      );
    }
    const tags = normalizeRunTags([...(current.tags ?? []), ...(spec.tags ?? [])]);
    return { spec, markdown, tags };
  });

  const backlogItems: RoadmapPromoteResult['backlogItems'] = [];
  const specPaths: string[] = [];
  const promotion: RoadmapPromotionEntry[] = [...(current.promotion ?? [])];
  let updated: RoadmapSaveResult;
  try {
    for (const prepared of preparedSpecs) {
      const { spec, markdown, tags } = prepared;
      const specPath = await writeBacklogSpecFile(current.project, spec.title, markdown);
      specPaths.push(specPath);
      const created = await createBacklogItem({
        project: current.project,
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
        createdAt: created.item.createdAt,
      });
    }

    updated = await saveRoadmapItemUnlocked({
      expectedHash: current.fileHash,
      item: {
        id: current.id,
        project: current.project,
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
