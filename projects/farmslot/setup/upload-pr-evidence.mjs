#!/usr/bin/env node
/**
 * Upload farmslot task evidence to the project artifacts repo and refresh the
 * PR ## **Screenshots/Recordings** section with hosted raw URLs.
 *
 * Artifacts layout (from project.json artifacts_repo + gh-upload-asset.sh):
 *   features/<prNumber>/<filename>   — dev flow
 *   fixes/<prNumber>/<filename>      — fix-bug flow
 *   reviews/<prNumber>/<filename>    — review flow
 *
 * Usage:
 *   node projects/farmslot/setup/upload-pr-evidence.mjs \
 *     --task-dir <task-dir> --pr <number> [--flow feature|fix|review] [--dry-run]
 *   node projects/farmslot/setup/upload-pr-evidence.mjs \
 *     --artifacts-dir <dir> --pr <number> --repo deeeed/farmslot [--edit-pr]
 */
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FARMSLOT_ROOT = path.resolve(__dirname, '../../..');

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm']);

function usage() {
  console.error(`Usage:
  upload-pr-evidence.mjs --task-dir <dir> --pr <n> [--flow feature|fix|review] [--edit-pr] [--dry-run]
  upload-pr-evidence.mjs --artifacts-dir <dir> --pr <n> --repo <owner/name> [--flow feature] [--edit-pr] [--dry-run]`);
}

function parseArgs(argv) {
  const opts = {
    taskDir: '',
    artifactsDir: '',
    pr: '',
    flow: 'feature',
    repo: '',
    editPr: false,
    dryRun: false,
    productRepo: 'deeeed/farmslot',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task-dir') opts.taskDir = path.resolve(argv[++i] ?? '');
    else if (arg.startsWith('--task-dir=')) opts.taskDir = path.resolve(arg.slice(11));
    else if (arg === '--artifacts-dir') opts.artifactsDir = path.resolve(argv[++i] ?? '');
    else if (arg.startsWith('--artifacts-dir=')) opts.artifactsDir = path.resolve(arg.slice(16));
    else if (arg === '--pr') opts.pr = String(argv[++i] ?? '');
    else if (arg.startsWith('--pr=')) opts.pr = arg.slice(5);
    else if (arg === '--flow') opts.flow = String(argv[++i] ?? 'feature');
    else if (arg.startsWith('--flow=')) opts.flow = arg.slice(7);
    else if (arg === '--repo') opts.repo = String(argv[++i] ?? '');
    else if (arg.startsWith('--repo=')) opts.repo = arg.slice(7);
    else if (arg === '--product-repo') opts.productRepo = String(argv[++i] ?? 'deeeed/farmslot');
    else if (arg === '--edit-pr') opts.editPr = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!opts.pr) throw new Error('--pr is required');
  if (!opts.taskDir && !opts.artifactsDir) throw new Error('--task-dir or --artifacts-dir is required');
  if (!opts.artifactsDir) opts.artifactsDir = path.join(opts.taskDir, 'artifacts');
  if (!existsSync(opts.artifactsDir)) throw new Error(`artifacts dir not found: ${opts.artifactsDir}`);
  return opts;
}

function readProjectJson() {
  const projectJsonPath = path.join(FARMSLOT_ROOT, 'projects/farmslot/project.json');
  return JSON.parse(readFileSync(projectJsonPath, 'utf8'));
}

function flowDir(flow) {
  if (flow === 'review') return 'reviews';
  if (flow === 'fix') return 'fixes';
  return 'features';
}

function collectMediaFiles(dir) {
  const files = [];
  function walk(current, prefix) {
    for (const name of readdirSync(current)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name.startsWith('.') || name === 'runtime-relaunch') continue;
        walk(full, rel);
      } else if (st.isFile() && MEDIA_EXT.has(path.extname(name).toLowerCase())) {
        files.push(rel);
      }
    }
  }
  walk(dir, '');
  return files.sort();
}

function fileDigestPrefix(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

async function gh(args, cwd) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  const { stdout } = await execFileAsync('gh', args, { encoding: 'utf8', env, cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function assertUrlsReachable(urlMap) {
  const failures = [];
  for (const [file, url] of urlMap.entries()) {
    const probe = url.split('?')[0] ?? url;
    try {
      const response = await fetch(probe, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) failures.push(`${file} HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${file} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`upload verification failed: ${failures.join('; ')}`);
}

function readEvidenceManifest(artifactsDir) {
  const manifestPath = path.join(artifactsDir, 'evidence-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function buildEvidenceSection(manifest, urlMap) {
  const lines = [];
  if (manifest?.summary) lines.push(manifest.summary.trim(), '');

  const pairs = manifest?.before_after_pairs ?? [];
  if (pairs.length > 0) {
    const rows = pairs
      .map((pair) => {
        const beforeUrl = pair.before ? urlMap.get(pair.before) : undefined;
        const afterUrl = pair.after ? urlMap.get(pair.after) : undefined;
        if (!beforeUrl && !afterUrl) return '';
        const label = pair.label ?? 'Evidence';
        const labelRow = `<tr><td colspan="2"><strong>${label}</strong></td></tr>`;
        if (beforeUrl && afterUrl) {
          return [
            labelRow,
            '<tr>',
            `<td align="center" width="50%"><em>Before</em><br/><img src="${beforeUrl}" alt="before" width="400" /></td>`,
            `<td align="center" width="50%"><em>After</em><br/><img src="${afterUrl}" alt="after" width="400" /></td>`,
            '</tr>',
          ].join('\n');
        }
        const url = beforeUrl ?? afterUrl;
        const which = beforeUrl ? 'Before' : 'After';
        return [
          labelRow,
          `<tr><td colspan="2" align="center"><em>${which}</em><br/><img src="${url}" alt="${which.toLowerCase()}" width="400" /></td></tr>`,
        ].join('\n');
      })
      .filter(Boolean);
    if (rows.length) {
      lines.push('<table>', ...rows, '</table>', '');
    }
  } else {
    const images = [...urlMap.entries()].filter(([f]) => /\.(png|jpe?g|gif)$/i.test(f));
    if (images.length) {
      lines.push('<table>');
      for (let i = 0; i < images.length; i += 2) {
        const left = images[i];
        const right = images[i + 1];
        lines.push('<tr>');
        for (const item of [left, right]) {
          if (item) {
            const [file, url] = item;
            lines.push(
              `<td align="center" width="50%"><em>${path.basename(file)}</em><br/><img src="${url}" alt="${path.basename(file)}" width="400" /></td>`,
            );
          } else lines.push('<td width="50%"></td>');
        }
        lines.push('</tr>');
      }
      lines.push('</table>', '');
    }
  }

  const videos = [...urlMap.entries()].filter(([f]) => /\.(mp4|mov|webm)$/i.test(f));
  for (const [file, url] of videos) {
    lines.push(`[${path.basename(file)}](${url})`);
  }

  return lines.join('\n').trim() || null;
}

function replaceScreenshotsSection(body, section) {
  const heading = '## **Screenshots/Recordings**';
  const re = new RegExp(
    `(^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n)([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`,
    'm',
  );
  if (re.test(body)) {
    return body.replace(re, `$1${section.trim()}\n\n`);
  }
  return `${body.trim()}\n\n${heading}\n\n${section.trim()}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = readProjectJson();
  const artifactsRepo = opts.repo || project.artifacts_repo;
  if (!artifactsRepo) throw new Error('artifacts_repo missing in projects/farmslot/project.json');

  const mediaFiles = collectMediaFiles(opts.artifactsDir).filter((f) => !f.includes('/'));
  if (mediaFiles.length === 0) {
    throw new Error(`no top-level publishable media in ${opts.artifactsDir}`);
  }

  const uploadScript = path.join(FARMSLOT_ROOT, 'scripts/gh-upload-asset.sh');
  const flowPlural = flowDir(opts.flow);
  const plan = {
    artifactsRepo,
    flow: opts.flow,
    pr: opts.pr,
    files: mediaFiles,
    targetPath: `${flowPlural}/${opts.pr}/`,
  };
  console.error('[upload-pr-evidence] plan:', JSON.stringify(plan, null, 2));

  if (opts.dryRun) {
    console.log(JSON.stringify({ ...plan, dryRun: true }, null, 2));
    return;
  }

  const staging = path.join('/tmp', `farmslot-pr-evidence-${opts.pr}-${Date.now()}`);
  const { mkdirSync, cpSync } = await import('node:fs');
  mkdirSync(staging, { recursive: true });
  for (const file of mediaFiles) {
    cpSync(path.join(opts.artifactsDir, file), path.join(staging, file));
  }

  const result = spawnSync(
    'bash',
    [
      uploadScript,
      '--dir',
      staging,
      '--artifacts-repo',
      artifactsRepo,
      '--flow',
      opts.flow,
      '--id',
      opts.pr,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'gh-upload-asset.sh failed');
  }

  const baseUrl = `https://raw.githubusercontent.com/${artifactsRepo}/main/${flowPlural}/${opts.pr}`;
  const urlMap = new Map();
  for (const file of mediaFiles) {
    const digest = fileDigestPrefix(path.join(opts.artifactsDir, file));
    urlMap.set(file, `${baseUrl}/${file}?sha=${digest}`);
  }

  await assertUrlsReachable(urlMap);

  const manifest = readEvidenceManifest(opts.artifactsDir);
  const section = buildEvidenceSection(manifest, urlMap);
  if (!section) throw new Error('could not build Screenshots/Recordings section');

  const out = {
    ...plan,
    urls: Object.fromEntries(urlMap),
    sectionPreview: section.slice(0, 200),
  };

  if (opts.editPr) {
    const currentBody = await gh(['pr', 'view', opts.pr, '--repo', opts.productRepo, '--json', 'body', '--jq', '.body']);
    const newBody = replaceScreenshotsSection(currentBody, section);
    const bodyFile = path.join('/tmp', `farmslot-pr-${opts.pr}-body.md`);
    writeFileSync(bodyFile, newBody, 'utf8');
    await gh(['pr', 'edit', opts.pr, '--repo', opts.productRepo, '--body-file', bodyFile]);
    out.prEdited = true;
    out.prUrl = await gh(['pr', 'view', opts.pr, '--repo', opts.productRepo, '--json', 'url', '--jq', '.url']);
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(`[upload-pr-evidence] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});