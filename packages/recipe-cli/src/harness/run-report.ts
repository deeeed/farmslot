// The human run report (report.md), the product checkout provenance and the
// browser a run drove, written next to a run's artifacts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AdapterBrowser } from '@farmslot/adapter-sdk';
import {
  parseRecipeTemplate,
  type RecipeRecordingInterruption,
  recipeTraceEntries,
} from '@farmslot/protocol';
import {
  CAPTURE_EVIDENCE_INCOMPLETE,
  isCaptureInterruptedEntry,
  onlyCaptureInterrupted,
  type RecipeRunCaptureInterruption,
} from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { harnessHost } from './host.js';
import { isRecord } from './parse-args.js';

export interface RunReport {
  path: string;
  preview: string[];
}

export function writeRunReport(result: {
  summaryPath: string;
  tracePath: string;
  artifactManifestPath: string;
}): RunReport {
  const summaryPath = String(result.summaryPath);
  const tracePath = String(result.tracePath);
  const artifactManifestPath = String(result.artifactManifestPath);
  const artifactsDir = path.dirname(summaryPath);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  const entries = recipeTraceEntries(trace) ?? [];
  const lines = renderRunReport(summary, entries, interruptedVideo(artifactManifestPath));
  const reportPath = path.join(artifactsDir, 'report.md');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
  indexRunReportArtifact(artifactManifestPath);
  return {
    path: reportPath,
    preview: lines
      .filter((line) => line.startsWith('- '))
      .slice(0, 6)
      .map((line) => line.slice(2)),
  };
}

/**
 * The report a failed run still writes when its recording was interrupted, whatever else
 * failed, so the partial video is linked; other violations write none.
 */
export function writeViolationReport(
  result: Parameters<typeof writeRunReport>[0] & {
    captureInterruption?: RecipeRunCaptureInterruption;
  },
): RunReport | undefined {
  return result.captureInterruption ? writeRunReport(result) : undefined;
}

// `browser` is the browser the run drove, bound by runRecipe while the run's
// ports were active (see executedBrowser); it is never re-derived here, after
// the run environment was restored.
export function indexProductProvenanceArtifact(
  artifactManifestPath: string,
  target: string,
  adapter: string,
  browser: AdapterBrowser | null = null,
): void {
  const artifactsDir = path.dirname(artifactManifestPath);
  let gitRef = 'unknown';
  let branch = 'unknown';
  let dirty = true;
  try {
    gitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: target,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    branch =
      execFileSync('git', ['branch', '--show-current'], {
        cwd: target,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'detached';
    dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: target,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0;
  } catch {
    // Non-git targets keep explicit unknown provenance.
  }

  const provenance = {
    schemaVersion: 1,
    adapter,
    repository: path.basename(path.resolve(target)),
    git_ref: gitRef,
    branch,
    dirty,
    ...(browser ? { browser } : {}),
  };
  fs.writeFileSync(
    path.join(artifactsDir, 'product-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(artifactManifestPath, 'utf8'));
  } catch {
    return;
  }
  if (!isRecord(manifest)) return;
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  manifest.artifacts = [
    ...artifacts.filter(
      (artifact) => !isRecord(artifact) || artifact.path !== 'product-provenance.json',
    ),
    {
      path: 'product-provenance.json',
      type: 'json',
      label: 'Product checkout provenance',
      category: 'system',
      metadata: {
        adapter,
        git_ref: gitRef,
        branch,
        dirty,
        ...(browser?.boundTo && browser.boundTo !== 'none'
          ? (harnessAdapter(adapter).run?.browserProvenance?.(browser) ?? {})
          : {}),
      },
    },
  ];
  fs.writeFileSync(artifactManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// A node's cdp_port, literal or "{{params.name}}" resolved from the run's
// params, then the recipe's paramsSchema default; null when it stays unknown.
function resolveTemplatedPort(value: unknown, params: unknown, recipe: unknown): string | null {
  let resolved: unknown = value;
  const template = typeof value === 'string' ? parseRecipeTemplate(value.trim()) : undefined;
  if (template?.source === 'params' && !template.path.includes('.')) {
    const name = template.path;
    const schema =
      isRecord(recipe) && isRecord(recipe.paramsSchema) && isRecord(recipe.paramsSchema.properties)
        ? recipe.paramsSchema.properties[name]
        : undefined;
    resolved =
      isRecord(params) && params[name] !== undefined
        ? params[name]
        : isRecord(schema)
          ? schema.default
          : undefined;
  }
  const text = String(resolved ?? '').trim();
  return /^\d+$/u.test(text) ? text : null;
}

// The CDP ports a run's actions were given: the run environment's port (same
// precedence as the adapters: CDP_PORT, then RECIPE_CDP_PORT) and any
// `cdp_port` a node of the run's own recipe sets for itself. Nodes inside
// called library recipes are not walked; no shipped recipe sets cdp_port.
export function recipeCdpPorts(request: {
  env?: Record<string, string | undefined>;
  params?: Record<string, unknown>;
  recipeDocument?: unknown;
  recipePath?: string;
}): string[] {
  const ports = new Set<string>();
  const envPort = request.env?.CDP_PORT || request.env?.RECIPE_CDP_PORT;
  if (envPort) ports.add(String(envPort));
  let recipe: unknown = request.recipeDocument;
  if (recipe === undefined && request.recipePath) {
    try {
      recipe = JSON.parse(fs.readFileSync(request.recipePath, 'utf8'));
    } catch {
      recipe = undefined;
    }
  }
  const workflow = isRecord(recipe) && isRecord(recipe.workflow) ? recipe.workflow : null;
  const nodes = workflow && isRecord(workflow.nodes) ? Object.values(workflow.nodes) : [];
  for (const node of nodes) {
    if (!isRecord(node) || node.cdp_port === undefined || node.cdp_port === null) continue;
    const port = resolveTemplatedPort(node.cdp_port, request.params, recipe);
    // An unresolvable template could name any port, so it blocks binding.
    ports.add(port ?? `unresolved ${String(node.cdp_port)}`);
  }
  return [...ports];
}

// The browser a run drove, bound by the engine while the run is active,
// against the port(s) its actions were given. Binding needs exactly one known
// port; the caller's environment is never consulted.
export function executedBrowser(
  adapter: string,
  target: string,
  artifactManifestPath: string,
  ports: string[],
): AdapterBrowser | null {
  const run = harnessAdapter(adapter).run;
  if (!run?.launchedBrowser) return null;
  if (ports.length === 0) return { boundTo: 'none', reason: 'the run had no known CDP port' };
  if (ports.length > 1)
    return { boundTo: 'none', reason: `the run drove several CDP ports (${ports.join(', ')})` };
  return run.launchedBrowser(target, path.dirname(artifactManifestPath), ports[0]);
}

// The video the recorder kept after its stream stopped, with the interruption.
function interruptedVideo(
  artifactManifestPath: string,
): { path: string; interruption: RecipeRecordingInterruption } | undefined {
  const manifest = readArtifactManifest(artifactManifestPath);
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.path !== 'string') continue;
    const { interruption } = artifact;
    if (!isRecord(interruption)) continue;
    return {
      path: artifact.path,
      interruption: {
        frames: Number(interruption.frames),
        mediaTimeMs: Number(interruption.mediaTimeMs),
        cause: String(interruption.cause),
      },
    };
  }
  return undefined;
}

function renderRunReport(
  summary: Record<string, unknown>,
  entries: unknown[],
  video?: { path: string; interruption: RecipeRecordingInterruption },
): string[] {
  // A run that failed only because its recording stopped proved what it ran, with partial video.
  const status = onlyCaptureInterrupted(entries)
    ? CAPTURE_EVIDENCE_INCOMPLETE
    : String(summary.status ?? 'unknown');
  const lines = [
    `# ${harnessHost().product} Recipe Run`,
    '',
    `Status: ${status}`,
    `Duration: ${formatDuration(Number(summary.durationMs ?? 0))}`,
    `Nodes: ${Number(summary.passed ?? 0)}/${Number(summary.total ?? entries.length)} passed`,
  ];
  const sideFindings = isRecord(summary.sideFindings) ? summary.sideFindings : undefined;
  const sideFindingCounts =
    sideFindings && isRecord(sideFindings.counts) ? sideFindings.counts : undefined;
  const sideFindingTotal = Number(sideFindingCounts?.total ?? 0);
  if (sideFindingTotal > 0) {
    lines.push(
      '',
      '## Side findings',
      `- REVIEW ${sideFindingTotal} distinct application warning/error event(s) (non-blocking; expanded below and stored in diagnostics.json)`,
    );
  }
  if (video) {
    const { frames, mediaTimeMs, cause } = video.interruption;
    const measured = frames > 0 ? ` after ${frames} frames (${formatDuration(mediaTimeMs)})` : '';
    lines.push(
      '',
      '## Evidence',
      `- INCOMPLETE partial video [${video.path}](${video.path}): the recording stopped${measured}: ${cause}`,
    );
  }
  lines.push('', '## Steps');
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const mark = isCaptureInterruptedEntry(entry)
      ? 'INCOMPLETE'
      : entry.ok === false
        ? 'FAIL'
        : 'PASS';
    const nodeId = String(entry.nodeId ?? '(node)');
    const action = String(entry.action ?? '(action)');
    const duration = formatDuration(Number(entry.durationMs ?? 0));
    const detail = summarizeNodeOutput(entry.output);
    lines.push(`- ${mark} ${nodeId} (${action}, ${duration})${detail ? `: ${detail}` : ''}`);
  }
  return lines;
}

function summarizeNodeOutput(output: unknown): string {
  if (!isRecord(output)) return '';
  const parts: string[] = [];
  const preferredKeys = [
    'platform',
    'screen',
    'route',
    'page',
    'network',
    'account',
    'count',
    'matchingCount',
    'proofPath',
    'screenshot',
    'path',
  ];
  for (const key of preferredKeys) addPart(parts, labelFor(key), summarizeValue(output[key]));
  const accountState = isRecord(output.accountState) ? output.accountState : undefined;
  if (accountState) {
    addPart(parts, 'totalBalance', accountState.totalBalance);
    addPart(parts, 'spendable', accountState.spendableBalance);
    addPart(parts, 'marginUsed', accountState.marginUsed);
    addPart(parts, 'unrealizedPnl', accountState.unrealizedPnl);
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(output)) {
      if (parts.length >= 5) break;
      if (key === 'liveAdapter' || key === 'artifacts') continue;
      addPart(parts, key, summarizeValue(value));
    }
  }
  return parts.join(', ');
}

function labelFor(key: string): string {
  return key === 'matchingCount' ? 'matching' : key === 'proofPath' ? 'proof' : key;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') return shortenAddress(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return undefined;
}

function addPart(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  parts.push(`${label}=${String(value)}`);
}

function shortenAddress(value: string): string {
  return /^0x[a-fA-F0-9]{40}$/u.test(value) ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// The run's artifact manifest; undefined when it is missing or malformed, so there is
// nothing to index the report into or link from it.
function readArtifactManifest(artifactManifestPath: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(artifactManifestPath, 'utf8'));
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function indexRunReportArtifact(artifactManifestPath: string): void {
  const manifest = readArtifactManifest(artifactManifestPath);
  if (!manifest) return;
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  manifest.artifacts = [
    ...artifacts.filter((artifact) => !isRecord(artifact) || artifact.path !== 'report.md'),
    { path: 'report.md', type: 'report', label: 'Human run report', category: 'system' },
  ];
  fs.writeFileSync(artifactManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
