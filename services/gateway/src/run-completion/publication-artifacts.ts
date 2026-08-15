import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef, Run } from '@farmslot/protocol';

import { INTERNAL_ARTIFACT_COPY_EXCLUDES } from '../core/artifact-copy-policy.js';
import { getProjectField, loadProjectVars } from '../core/config.js';
import {
  execLocal,
  farmslotRoot,
  inferArtifactPurpose,
  sanitizeLatestValidRecipeRunPointer,
} from '../core/index.js';
import { ghRequest } from '../integrations/github-client.js';

import {
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  type EvidenceManifest,
  validateEvidenceManifest,
} from './evidence-manifest.js';
import { evidenceKeyVariants } from './evidence-paths.js';

// ─── LLM PR body rewrite ───

const REWRITE_SYSTEM_FALLBACK = `You rewrite GitHub PR descriptions. Output ONLY the rewritten markdown — no explanation, no fences, no preamble.`;

const REWRITE_RULES_FALLBACK = `Rules:
1. Replace ALL local path references to these files with proper markdown image/link embeds using the URLs above.
2. Images (.png, .jpg, .jpeg, .gif): use \`![descriptive alt](url)\`
3. Videos (.mp4, .mov): use \`[filename](url)\` (GitHub doesn't render video embeds)
4. Place images in the **Screenshots/Recordings** section. If it has a table format, put images in the table cells. If not, create a simple list.
5. Remove any remaining local file paths (starting with \`.task/\`, \`/Users/\`, \`/home/\`, \`/tmp/\`, \`file://\`) that don't have uploaded URLs.
6. Remove placeholder text like "_Evidence available in task artifacts — will be added by reviewer if needed._"
7. Do NOT change any other part of the PR description — keep all headings, text, checklists, code blocks exactly as-is.`;

async function rewritePRBodyWithLLM(
  project: string,
  body: string,
  artifactUrls: Map<string, string>,
): Promise<string> {
  const { callLLM } = await import('../llm/index.js');
  const { loadPromptTemplate } = await import('../core/prompt-templates.js');

  const urlMapStr = [...artifactUrls.entries()]
    .map(([name, url]) => `- ${name} → ${url}`)
    .join('\n');

  // Try project-specific template first
  const template = await loadPromptTemplate(project, 'pr-body-rewrite.md', {
    ARTIFACT_URL_MAP: urlMapStr,
  });

  const systemPrompt = template ?? REWRITE_SYSTEM_FALLBACK;
  const userPrompt = template
    ? `PR description:\n\n${body}`
    : `Here is a PR description that contains references to local artifact files (paths like \`.task/...\`, \`temp/...\`, or bare filenames like \`evidence-*.png\`, \`before.mp4\`, \`after.mp4\`).

These artifacts have been uploaded. Here is the filename → URL mapping:

${urlMapStr}

${REWRITE_RULES_FALLBACK}

PR description:

${body}`;

  const { getLLMConfig } = await import('../llm/config.js');
  const cfgLLM = getLLMConfig();
  const result = await callLLM({
    model: cfgLLM.intelligenceModel,
    provider: cfgLLM.defaultProvider,
    maxTokens: 8192,
    systemPrompt,
    userPrompt,
  });

  const rewritten = result.text.trim();
  if (rewritten.length < body.length * 0.3) {
    console.warn(
      `[run-completion] LLM rewrite suspiciously short (${rewritten.length} vs ${body.length}), rejecting`,
    );
    throw new Error('LLM output too short — likely truncated');
  }

  console.log(
    `[run-completion] LLM rewrote PR body (${result.usage.inputTokens ?? '?'}in/${result.usage.outputTokens ?? '?'}out)`,
  );
  return rewritten;
}

// ─── Artifact upload ───

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm']);

function isUploadableMediaPath(file: string): boolean {
  // Publication uploads only PR-renderable media. Logs/JSON stay available in the
  // task artifact package, but they are not embedded into the PR evidence block.
  const withoutQuery = file.split(/[?#]/, 1)[0] ?? file;
  return MEDIA_EXTENSIONS.has(path.extname(withoutQuery).toLowerCase());
}

async function fileDigestPrefix(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
    .slice(0, 16);
}

/** Git push can succeed locally while raw.githubusercontent.com is still 404 — verify before PR embed. */
async function assertUploadedArtifactUrlsReachable(
  urlMap: Map<string, string>,
  options: { failOnError?: boolean },
): Promise<void> {
  const failures: string[] = [];
  for (const [file, url] of urlMap.entries()) {
    const probeUrl = url.split('?')[0] ?? url;
    try {
      const response = await fetch(probeUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) failures.push(`${file} (${response.status})`);
    } catch (err) {
      failures.push(`${file} (${(err as Error).message})`);
    }
  }
  if (failures.length === 0) return;
  const message = `artifact upload verification failed: ${failures.join(', ')}`;
  if (options.failOnError) throw new Error(message);
  console.warn(`[run-completion] ${message}`);
}

function evidenceSelectionSet(selectedEvidenceKeys?: string[]): Set<string> | null {
  if (!selectedEvidenceKeys) return null;
  const keys = new Set<string>();
  for (const key of selectedEvidenceKeys) {
    if (typeof key !== 'string' || !key.trim()) continue;
    for (const variant of evidenceKeyVariants(key.trim())) keys.add(variant);
  }
  return keys;
}

function evidencePathSelected(file: string | undefined, selection: Set<string> | null): boolean {
  if (!selection) return true;
  if (!file) return false;
  return evidenceKeyVariants(file).some((variant) => selection.has(variant));
}

export function filterArtifactUrlsByEvidenceSelection(
  artifactUrls: Map<string, string>,
  selectedEvidenceKeys?: string[],
): Map<string, string> {
  const selection = evidenceSelectionSet(selectedEvidenceKeys);
  if (!selection) return artifactUrls;
  const filtered = new Map<string, string>();
  for (const [file, url] of artifactUrls.entries()) {
    if (evidencePathSelected(file, selection)) filtered.set(file, url);
  }
  return filtered;
}

export function expandEvidenceSelectionForManifest(
  manifest: EvidenceManifest | null | undefined,
  selectedEvidenceKeys?: string[],
): string[] | undefined {
  if (!selectedEvidenceKeys) return undefined;
  const selection = evidenceSelectionSet(selectedEvidenceKeys);
  if (!selection || !manifest) return selectedEvidenceKeys;

  const expanded = new Set(selectedEvidenceKeys);
  const addIfPairSelected = (left?: string, right?: string) => {
    const leftSelected = left ? evidencePathSelected(left, selection) : false;
    const rightSelected = right ? evidencePathSelected(right, selection) : false;
    if (!leftSelected && !rightSelected) return;
    if (left) expanded.add(left);
    if (right) expanded.add(right);
  };

  for (const pair of manifest.before_after_pairs ?? []) {
    addIfPairSelected(pair.before, pair.after);
  }
  if (manifest.videos) {
    addIfPairSelected(manifest.videos.before, manifest.videos.after);
  }

  return [...expanded];
}

export function filterEvidenceManifestBySelection(
  manifest: EvidenceManifest,
  selectedEvidenceKeys?: string[],
): EvidenceManifest {
  const selection = evidenceSelectionSet(selectedEvidenceKeys);
  if (!selection) return manifest;

  const beforeAfterPairs = (manifest.before_after_pairs ?? [])
    .map((pair) => ({
      ...pair,
      before: evidencePathSelected(pair.before, selection) ? pair.before : undefined,
      after: evidencePathSelected(pair.after, selection) ? pair.after : undefined,
    }))
    .filter((pair) => pair.before || pair.after);
  const standalone = (manifest.standalone ?? []).filter((entry) =>
    evidencePathSelected(entry.file, selection),
  );
  const videos = manifest.videos
    ? {
        ...manifest.videos,
        before: evidencePathSelected(manifest.videos.before, selection)
          ? manifest.videos.before
          : undefined,
        after: evidencePathSelected(manifest.videos.after, selection)
          ? manifest.videos.after
          : undefined,
      }
    : undefined;

  return {
    ...manifest,
    before_after_pairs: beforeAfterPairs,
    standalone,
    videos: videos?.before || videos?.after ? videos : undefined,
  };
}

/** Recursively collect publishable media files under a directory, returning paths relative to baseDir. */
export async function collectUploadableMediaFiles(baseDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, prefix: string) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      console.warn(
        `[run-completion] failed to read media artifact directory ${dir}: ${(err as Error).message.slice(0, 200)}`,
      );
      return;
    }
    for (const name of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (!shouldScanArtifactPath(relativePath)) continue;
      const full = path.join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          await walk(full, relativePath);
        } else if (s.isFile() && MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          results.push(relativePath);
        }
      } catch (err) {
        console.warn(
          `[run-completion] failed to inspect media artifact ${full}: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
  }
  await walk(baseDir, '');
  return results.sort();
}

export async function uploadArtifacts(
  run: Run,
  prNumber: number,
  selectedEvidenceKeys?: string[],
  options: { failOnError?: boolean } = {},
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  const failOrReturnEmpty = (message: string): Map<string, string> => {
    if (options.failOnError) throw new Error(message);
    console.warn(`[run-completion] ${message}`);
    return urlMap;
  };
  const hasSelectedEvidence = Boolean(
    selectedEvidenceKeys?.some((key) => isUploadableMediaPath(key)),
  );
  if (!run.taskFile) {
    return hasSelectedEvidence
      ? failOrReturnEmpty('artifact upload failed: run has no task file')
      : urlMap;
  }

  let pv: Awaited<ReturnType<typeof loadProjectVars>> | null = null;
  try {
    pv = await loadProjectVars(run.project);
  } catch (err) {
    return failOrReturnEmpty(
      `artifact upload failed: project config unavailable (${(err as Error).message})`,
    );
  }
  const artifactsRepo = pv ? getProjectField(pv.projectJson, 'artifacts_repo') : '';
  if (!artifactsRepo) {
    return hasSelectedEvidence
      ? failOrReturnEmpty('artifact upload failed: project has no artifacts_repo configured')
      : urlMap;
  }

  const taskDir = path.dirname(run.taskFile);
  const artifactsDir = path.join(taskDir, 'artifacts');
  if (!existsSync(artifactsDir)) {
    return hasSelectedEvidence
      ? failOrReturnEmpty('artifact upload failed: artifacts directory is missing')
      : urlMap;
  }

  let files: string[];
  try {
    files = await collectUploadableMediaFiles(artifactsDir);
  } catch (err) {
    return failOrReturnEmpty(
      `artifact upload failed while scanning media: ${(err as Error).message}`,
    );
  }
  const selection = evidenceSelectionSet(selectedEvidenceKeys);
  if (selection) files = files.filter((file) => evidencePathSelected(file, selection));
  if (files.length === 0) {
    return hasSelectedEvidence
      ? failOrReturnEmpty('artifact upload failed: selected evidence files were not found')
      : urlMap;
  }

  const flow = run.flowType === 'review-pr' ? 'review' : run.flowType === 'dev' ? 'feature' : 'fix';
  const flowDir = flow === 'fix' ? 'fixes' : `${flow}s`;
  const uploadScript = path.join(farmslotRoot, 'scripts', 'gh-upload-asset.sh');

  let uploadDir = artifactsDir;
  let tempUploadDir: string | null = null;
  try {
    if (selection) {
      tempUploadDir = path.join(
        '/tmp',
        `farmslot-selected-artifacts-${run.id.slice(0, 8)}-${randomUUID()}`,
      );
      await mkdir(tempUploadDir, { recursive: true });
      for (const file of files) {
        const source = path.join(artifactsDir, file);
        const dest = path.join(tempUploadDir, file);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, await readFile(source));
      }
      uploadDir = tempUploadDir;
    }
    console.log(
      `[run-completion] uploading ${files.length} artifact(s) to ${artifactsRepo} (${flowDir}/${prNumber})`,
    );
    await execLocal(
      `bash '${uploadScript}' --dir '${uploadDir}' --artifacts-repo '${artifactsRepo}' --flow '${flow}' --id '${prNumber}'`,
    );
    const baseUrl = `https://raw.githubusercontent.com/${artifactsRepo}/main/${flowDir}/${prNumber}`;
    for (const f of files) {
      const digest = await fileDigestPrefix(path.join(artifactsDir, f));
      urlMap.set(f, `${baseUrl}/${f}?sha=${digest}`);
    }
    console.log(`[run-completion] uploaded ${files.length} artifact(s): ${files.join(', ')}`);
    await assertUploadedArtifactUrlsReachable(urlMap, options);
  } catch (err) {
    return failOrReturnEmpty(`artifact upload failed: ${(err as Error).message}`);
  } finally {
    if (tempUploadDir) {
      try {
        await rm(tempUploadDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[run-completion] selected artifact staging cleanup failed: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
  }
  return urlMap;
}

function selectedEvidenceKeyUploaded(key: string, artifactUrls: Map<string, string>): boolean {
  const uploaded = new Set(
    [...artifactUrls.keys()].flatMap((urlKey) => evidenceKeyVariants(urlKey)),
  );
  return evidenceKeyVariants(key).some((variant) => uploaded.has(variant));
}

export function assertSelectedEvidencePublished(
  selectedEvidenceKeys: readonly string[] | undefined,
  artifactUrls: Map<string, string>,
): void {
  const selected = (selectedEvidenceKeys ?? []).filter((key) =>
    typeof key === 'string' ? Boolean(key.trim()) && isUploadableMediaPath(key.trim()) : false,
  );
  if (selected.length === 0) return;

  const missing = selected.filter((key) => !selectedEvidenceKeyUploaded(key.trim(), artifactUrls));
  if (missing.length === 0) return;

  throw new Error(
    `Selected evidence was not published (${missing.length}/${selected.length} missing: ${missing.join(', ')}); refresh/fix artifact upload before publishing`,
  );
}

// ─── PR body post-processing (sanitize + author checklist) ───

const LOCAL_PR_BODY_PATH_PATTERNS: RegExp[] = [
  /file:\/\/\/[^\s)>'"]+/gi,
  /(^|[\s(='"])`?(?:\/Users|\/home|\/tmp)\/[^\s)>'"`]+/g,
  /(^|[\s(='"])`?(?:\.\/)?(?:\.task|temp|artifacts|screenshots|videos|recipe-runs)\/[^\s<)>'"`]+/gi,
  /(^|[\s(='"])(?:\.\/)?(?:before|after|evidence)[^/\s)>'"]*\.(?:png|jpe?g|gif|mp4|mov|webm)/gi,
];

function stripCodeBlocks(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

const REMOTE_LINK_PATTERNS = [
  /<a\b[^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi,
  /<img\b[^>]*\bsrc=["']https?:\/\/[^"']+["'][^>]*>/gi,
  /!?\[[^\]]*\]\(https?:\/\/[^)]+\)/gi,
] as const;

function replaceRemoteLinks(body: string, replace: (link: string) => string): string {
  return REMOTE_LINK_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, (link) => replace(link)),
    body,
  );
}

function stripRemoteLinks(body: string): string {
  return replaceRemoteLinks(body, () => ' ');
}

function protectRemoteLinks(body: string): {
  body: string;
  hasProtectedLink: (value: string) => boolean;
  restore: (value: string) => string;
} {
  const links: string[] = [];
  let tokenPrefix = '__FARMSLOT_REMOTE_LINK_';
  while (body.includes(tokenPrefix)) tokenPrefix = `_${tokenPrefix}`;
  const protect = (link: string) => {
    const token = `${tokenPrefix}${links.length}__`;
    links.push(
      link.startsWith('<img')
        ? link.replace(/(\balt=["'])([^"']*)(["'])/i, (_match, open, alt: string, close) => {
            const cleanedAlt = alt.replace(
              new RegExp(LOCAL_ARTIFACT_PATH_SOURCE, 'gi'),
              readableArtifactName,
            );
            return `${open}${cleanedAlt}${close}`;
          })
        : link,
    );
    return token;
  };
  const protectedBody = replaceRemoteLinks(body, protect);
  const tokenPattern = new RegExp(`${tokenPrefix}(\\d+)__`, 'g');
  return {
    body: protectedBody,
    hasProtectedLink: (value) => value.includes(tokenPrefix),
    restore: (value) =>
      value.replace(tokenPattern, (_match, index: string) => {
        return links[Number(index)] ?? '';
      }),
  };
}

// A path a reader must be able to SEE (screenshots, recordings) is evidence: it
// has to be uploaded, and quoting it in backticks does not make it visible.
// Everything else in inline code is provenance narration — worker reports cite
// `artifacts/recipe-run/` and quote broken upstream paths like
// `require("file:///…/mod.ts")`, and both killed FINALIZE on real runs even
// though nothing was linked. So: media residues are flagged everywhere; other
// local paths are flagged only outside code spans.
const MEDIA_RESIDUE_RE = /\.(?:png|jpe?g|gif|mp4|mov|webm)$/i;

function extractInlineCodeSpans(body: string): { prose: string; spans: string } {
  const collected: string[] = [];
  const prose = body.replace(/``[^`\n]+``|`[^`\n]+`/g, (span) => {
    collected.push(span.replace(/^`+|`+$/g, ''));
    return ' ';
  });
  // Spans are re-joined with spaces so the patterns' boundary prefixes match.
  return { prose, spans: ` ${collected.join(' \n ')} ` };
}

function matchResidues(scanned: string, mediaOnly: boolean): string[] {
  const residues: string[] = [];
  for (const pattern of LOCAL_PR_BODY_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of scanned.matchAll(pattern)) {
      const value = match[0].trim().replace(/^[('"=`]+/, '');
      if (!value) continue;
      if (mediaOnly) {
        const cleaned = value.replace(/[`).,;]+$/, '');
        // Only media PATHS count inside code spans: `artifacts/after.png` is
        // un-uploaded evidence, but a bare `evidence-ac1.png` is discussing a
        // filename (recipe docs do this constantly; asserted below in tests).
        if (!MEDIA_RESIDUE_RE.test(cleaned) || !cleaned.includes('/')) continue;
      }
      residues.push(value);
    }
  }
  return residues;
}

export function localPrBodyPathResidues(body: string): string[] {
  // A local-looking label is safe when the enclosing link points at uploaded
  // remote evidence. Validate the link as one unit instead of re-scanning its
  // visible text as though it were an unresolved path.
  const { prose, spans } = extractInlineCodeSpans(stripRemoteLinks(stripCodeBlocks(body)));
  const residues = [...matchResidues(prose, false), ...matchResidues(spans, true)];
  return [...new Set(residues)].slice(0, 10);
}

function assertNoLocalPrBodyPathResidues(body: string): void {
  const residues = localPrBodyPathResidues(body);
  if (residues.length === 0) return;
  throw new Error(`PR body still contains local artifact path(s): ${residues.join(', ')}`);
}

const LOCAL_ARTIFACT_PATH_SOURCE = String.raw`(?:\.\/)?(?:\.task|temp|artifacts|screenshots|videos|recipe-runs)\/[^\s<)>'"\x60|]+`;

function readableArtifactName(value: string): string {
  const basename = value.split('/').pop() ?? value;
  return basename
    .replace(/\.[^.]+$/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function sanitizePRBody(body: string): string {
  const protectedLinks = protectRemoteLinks(body);
  let result = protectedLinks.body;
  // Strip markdown image/link refs pointing to local paths
  result = result.replace(
    /!?\[[^\]]*\]\([^)]*(?:\.task\/|temp\/|\/Users\/|\/home\/|\/tmp\/|file:\/\/)[^)]*\)/g,
    '',
  );
  // Strip bare local file paths to media on their own line
  result = result.replace(
    /^\s*(?:\/Users\/|\/home\/|\/tmp\/|~\/)\S+\.(?:mp4|mov|png|jpg|jpeg|gif)\s*$/gm,
    '',
  );
  const localArtifactPath = new RegExp(LOCAL_ARTIFACT_PATH_SOURCE, 'i');
  const generatedCaptionLine = /<tr\b[^>]*>.*<strong\b[^>]*>/i;
  // Plain local-reference lines have no publishable value. Generated evidence
  // captions and lines containing hosted evidence keep their surrounding text.
  const originalLines = result.split('\n');
  result = originalLines
    .map((line) => {
      if (!localArtifactPath.test(line)) return line;
      if (!protectedLinks.hasProtectedLink(line) && !generatedCaptionLine.test(line)) return '';

      let cleaned = line;
      cleaned = cleaned.replace(
        new RegExp(String.raw`\s*\([^\n)]*${LOCAL_ARTIFACT_PATH_SOURCE}[^\n)]*\)`, 'gi'),
        '',
      );
      cleaned = cleaned.replace(
        new RegExp(
          String.raw`\x60{1,2}[^\x60\n]*${LOCAL_ARTIFACT_PATH_SOURCE}[^\x60\n]*\x60{1,2}`,
          'gi',
        ),
        '',
      );
      if (generatedCaptionLine.test(cleaned)) {
        cleaned = cleaned.replace(
          new RegExp(LOCAL_ARTIFACT_PATH_SOURCE, 'gi'),
          readableArtifactName,
        );
      } else {
        cleaned = cleaned.replace(
          new RegExp(String.raw`(^|[\s|<(='"\x60])${LOCAL_ARTIFACT_PATH_SOURCE}`, 'gi'),
          '$1',
        );
      }
      cleaned = cleaned
        .replace(/\x60{1,2}\s*\x60{1,2}/g, '')
        .replace(/([:|])\s*(?:→|—)\s*/g, '$1 ')
        .replace(/\s+(?:—|-|:)\s*(?=<\/[^>]+>)/g, '');
      return cleaned;
    })
    .filter((line, index) => line !== '' || originalLines[index] === '')
    .join('\n');
  // Strip markdown image refs with just artifact filenames (before.mp4, after.mp4, evidence-*.png)
  result = result.replace(
    /!\[[^\]]*\]\((?:before|after|evidence)[^)]*\.(?:mp4|mov|png|jpg|jpeg)\)/g,
    '',
  );
  // Collapse multiple blank lines left by stripping
  result = result.replace(/\n{3,}/g, '\n\n');
  return protectedLinks.restore(result);
}

function prefixPromotedEvidenceManifestPath(
  value: string | undefined,
  artifactRoot: string | null,
): string | undefined {
  if (!artifactRoot || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return value;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const withoutArtifacts = normalized.startsWith('artifacts/')
    ? normalized.slice('artifacts/'.length)
    : normalized;
  if (withoutArtifacts === artifactRoot || withoutArtifacts.startsWith(`${artifactRoot}/`)) {
    return `artifacts/${withoutArtifacts}`;
  }
  return `artifacts/${artifactRoot}/${withoutArtifacts}`;
}

function prefixPromotedEvidenceManifest(
  manifest: EvidenceManifest,
  artifactRoot: string | null,
): EvidenceManifest {
  if (!artifactRoot) return manifest;
  return {
    ...manifest,
    before_after_pairs: manifest.before_after_pairs?.map((pair) => ({
      ...pair,
      before: prefixPromotedEvidenceManifestPath(pair.before, artifactRoot),
      after: prefixPromotedEvidenceManifestPath(pair.after, artifactRoot),
    })),
    standalone: manifest.standalone?.map((entry) => ({
      ...entry,
      file: prefixPromotedEvidenceManifestPath(entry.file, artifactRoot) ?? entry.file,
    })),
    videos: manifest.videos
      ? {
          ...manifest.videos,
          before: prefixPromotedEvidenceManifestPath(manifest.videos.before, artifactRoot),
          after: prefixPromotedEvidenceManifestPath(manifest.videos.after, artifactRoot),
        }
      : undefined,
  };
}

async function readEvidenceManifestFile(
  manifestPath: string,
  artifactRoot: string | null,
): Promise<EvidenceManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8'));
    const issues = validateEvidenceManifest(parsed);
    if (issues.length > 0) {
      console.warn(
        `[run-completion] invalid evidence manifest ${manifestPath}: ${issues.join('; ')}`,
      );
      return null;
    }
    return prefixPromotedEvidenceManifest(parsed as EvidenceManifest, artifactRoot);
  } catch (err) {
    console.warn(
      `[run-completion] invalid evidence manifest ${manifestPath}: ${(err as Error).message}`,
    );
    return null;
  }
}

interface EvidenceManifestCandidatePath {
  manifestPath: string;
  artifactRoot: string | null;
}

async function evidenceManifestCandidatePaths(
  taskDir: string,
): Promise<EvidenceManifestCandidatePath[]> {
  let promotedArtifactRoot: string | null = null;
  const pointerPath = path.join(taskDir, 'artifacts', 'latest-valid-recipe-run.json');
  if (existsSync(pointerPath)) {
    try {
      const pointer = sanitizeLatestValidRecipeRunPointer(
        JSON.parse(await readFile(pointerPath, 'utf-8')),
      );
      promotedArtifactRoot = pointer?.relativeArtifactRoot ?? null;
    } catch (err) {
      console.warn(
        `[run-completion] invalid latest-valid-recipe-run pointer ${pointerPath}: ${(err as Error).message}`,
      );
    }
  }

  const candidates: EvidenceManifestCandidatePath[] = [
    { manifestPath: path.join(taskDir, 'artifacts', 'evidence-manifest.json'), artifactRoot: null },
  ];
  if (promotedArtifactRoot) {
    candidates.push({
      manifestPath: path.join(taskDir, 'artifacts', promotedArtifactRoot, 'evidence-manifest.json'),
      artifactRoot: promotedArtifactRoot,
    });
  }
  candidates.push({
    manifestPath: path.join(taskDir, 'inputs', 'inherited', 'evidence-manifest.json'),
    artifactRoot: promotedArtifactRoot,
  });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.manifestPath}::${candidate.artifactRoot ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function readEvidenceManifest(run: Run): Promise<EvidenceManifest | null> {
  if (!run.taskFile) return null;
  const taskDir = path.dirname(run.taskFile);
  for (const { manifestPath, artifactRoot } of await evidenceManifestCandidatePaths(taskDir)) {
    if (existsSync(manifestPath)) return readEvidenceManifestFile(manifestPath, artifactRoot);
  }
  return null;
}

export function replaceMarkdownSection(body: string, heading: string, content: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^${escapedHeading}\\s*\\n)([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  if (re.test(body)) {
    const replacement = `${content.trim()}\n\n`;
    return body.replace(re, (_match, headingMatch: string) => `${headingMatch}${replacement}`);
  }
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n${heading}\n\n${content.trim()}\n`;
}

export async function postProcessPRBody(
  run: Run,
  ciRepo: string,
  prNumber: number,
  artifactUrls?: Map<string, string>,
  selectedEvidenceKeys?: string[],
  options: {
    failOnError?: boolean;
    baseBody?: string;
    evidenceManifest?: EvidenceManifest | null;
  } = {},
): Promise<void> {
  try {
    let body: string;
    if (options.baseBody !== undefined) {
      body = options.baseBody;
    } else {
      const result = await ghRequest([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        ciRepo,
        '--json',
        'body',
        '--jq',
        '.body',
      ]);
      body = result.stdout;
    }

    const selectedArtifactUrls = artifactUrls
      ? filterArtifactUrlsByEvidenceSelection(artifactUrls, selectedEvidenceKeys)
      : artifactUrls;
    const rawManifest =
      options.evidenceManifest !== undefined
        ? options.evidenceManifest
        : await readEvidenceManifest(run);
    const manifest = rawManifest
      ? filterEvidenceManifestBySelection(rawManifest, selectedEvidenceKeys)
      : autoDetectEvidenceManifest(selectedArtifactUrls);

    body = sanitizePRBody(body);

    if (selectedEvidenceKeys?.length && selectedArtifactUrls && selectedArtifactUrls.size === 0) {
      if (options.failOnError) {
        throw new Error(
          `selected evidence has no uploaded artifact URLs (${selectedEvidenceKeys.length} selected artifact(s))`,
        );
      }
      body = replaceMarkdownSection(
        body,
        '## **Screenshots/Recordings**',
        'No visual evidence selected for publication.',
      );
    } else if (selectedArtifactUrls && selectedArtifactUrls.size > 0 && manifest) {
      const evidenceSection = buildEvidenceSection(manifest, selectedArtifactUrls);
      if (evidenceSection) {
        body = replaceMarkdownSection(body, '## **Screenshots/Recordings**', evidenceSection);
      }
    }

    // LLM pass remains as a fallback when we do not have a structured evidence
    // manifest/auto-detected evidence set to drive deterministic section updates.
    if (selectedArtifactUrls && selectedArtifactUrls.size > 0 && !manifest) {
      try {
        body = await rewritePRBodyWithLLM(run.project, body, selectedArtifactUrls);
      } catch (err) {
        console.warn(
          `[run-completion] LLM rewrite failed, falling back to sanitize: ${(err as Error).message}`,
        );
        body = sanitizePRBody(body);
      }
    }

    // Structured manifests and fallback rewrites are generated after the
    // initial sanitize pass. Apply the same publication boundary to their
    // output so a manifest summary cannot reintroduce a task-local path.
    body = sanitizePRBody(body);
    if (options.failOnError) assertNoLocalPrBodyPathResidues(body);

    // Auto-check author checklist boxes (CI may be gated on these)
    if (body.includes('- [ ]')) {
      const reviewerMarker = 'reviewer checklist';
      const markerIdx = body.toLowerCase().indexOf(reviewerMarker);
      if (markerIdx > 0) {
        const headingStart = body.lastIndexOf('\n', markerIdx);
        const authorPart = body.substring(0, headingStart).replace(/- \[ \]/g, '- [x]');
        body = authorPart + body.substring(headingStart);
      } else {
        body = body.replace(/- \[ \]/g, '- [x]');
      }
    }

    const tmpFile = `/tmp/farmslot-pr-body-${prNumber}.md`;
    const { writeFile: writeF } = await import('node:fs/promises');
    await writeF(tmpFile, body, 'utf-8');
    let editError: unknown = null;
    let cleanupError: unknown = null;
    try {
      await ghRequest(['pr', 'edit', String(prNumber), '--repo', ciRepo, '--body-file', tmpFile], {
        force: true,
      });
    } catch (err) {
      editError = err;
    }
    try {
      await rm(tmpFile, { force: true });
    } catch (err) {
      cleanupError = err;
    }
    if (editError) {
      if (cleanupError) {
        console.warn(
          `[run-completion] failed to remove temporary PR body after edit failure: ${(cleanupError as Error).message}`,
        );
      }
      throw editError;
    }
    if (cleanupError) throw cleanupError;
    console.log(`[run-completion] post-processed PR #${prNumber} body (sanitized + checklist)`);
  } catch (err) {
    if (options.failOnError) throw err;
    console.warn(`[run-completion] PR body post-processing failed: ${(err as Error).message}`);
  }
}

// ─── Artifact scanning ───

const SCAN_ARTIFACT_TOP_LEVEL_EXCLUDES = new Set<string>(INTERNAL_ARTIFACT_COPY_EXCLUDES);

function shouldScanArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const [topLevel] = normalized.split('/');
  return Boolean(topLevel) && !SCAN_ARTIFACT_TOP_LEVEL_EXCLUDES.has(topLevel);
}

export async function scanArtifacts(taskDir: string): Promise<ArtifactRef[]> {
  const artifactsDir = path.join(taskDir, 'artifacts');
  if (!existsSync(artifactsDir)) return [];

  const refs: ArtifactRef[] = [];
  async function walk(dir: string, prefix: string) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      console.warn(
        `[artifacts] failed to read artifact directory ${dir}: ${(err as Error).message.slice(0, 200)}`,
      );
      return;
    }
    for (const name of entries) {
      if (name === '.DS_Store' || name.startsWith('.')) continue;
      const relativePath = `${prefix}${name}`;
      if (!shouldScanArtifactPath(relativePath)) continue;
      const full = path.join(dir, name);
      try {
        const s = await lstat(full);
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          await walk(full, `${relativePath}/`);
        } else if (s.isFile()) {
          let sha256: string | undefined;
          try {
            const buf = await readFile(full);
            sha256 = createHash('sha256').update(buf).digest('hex');
          } catch (err) {
            console.debug('[artifacts] sha256 failed for', full, err);
          }
          refs.push({
            path: `artifacts/${relativePath}`,
            purpose: inferArtifactPurpose(relativePath),
            sizeBytes: s.size,
            sha256,
          });
        }
      } catch (err) {
        console.warn(
          `[artifacts] failed to inspect artifact ${full}: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
  }
  await walk(artifactsDir, '');
  return refs;
}
