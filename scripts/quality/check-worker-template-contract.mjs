#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
  lintWorkerTemplateProofSelection,
  lintWorkerTemplateStructure,
  templateUsesTerminalMark,
} = require('./worker-terminal-contract.cjs');

const repoRoot = path.resolve(import.meta.dirname, '../..');
const inputs = process.argv.slice(2);

/** @type {string[]} */
const targets =
  inputs.length > 0
    ? inputs.map((entry) => path.resolve(entry))
    : [path.join(repoRoot, 'projects/farmslot-farm')];

/** @type {string[]} */
const issues = [];

for (const target of targets) {
  if (target.endsWith('.md')) {
    lintTemplateFile(target, issues);
    continue;
  }
  lintProjectRoot(target, issues);
}

if (issues.length > 0) {
  console.error('WORKER_TEMPLATE_CONTRACT_FAIL');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log('WORKER_TEMPLATE_CONTRACT_PASS');
process.exit(0);

/**
 * @param {string} templatePath
 * @param {string[]} issues
 */
function lintTemplateFile(templatePath, issues) {
  if (!existsSync(templatePath)) {
    issues.push(`${templatePath}: file not found`);
    return;
  }
  const projectRoot = findProjectRoot(templatePath);
  const workerTerminal = readWorkerTerminalConfig(projectRoot);
  const content = readFileSync(templatePath, 'utf8');
  const fileName = path.basename(templatePath);
  collectTemplateIssues(
    path.relative(repoRoot, templatePath),
    fileName,
    content,
    workerTerminal,
    issues,
  );
}

/**
 * @param {string} projectRoot
 * @param {string[]} issues
 */
function lintProjectRoot(projectRoot, issues) {
  const projectJsonPath = path.join(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) {
    issues.push(`${projectRoot}: missing project.json`);
    return;
  }
  const workerTerminal = readWorkerTerminalConfig(projectRoot);
  // Pack-owned execution-template checklists (<projectPath>/<subpath>/<flow>/<id>.md) carry
  // the proof steps for packs without flow templates; they get the proof-selection rule.
  // Sources rooted in an env var or another source are checked in the repo that owns them.
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  const packRoot = realpathSync(projectRoot);
  // Segment-wise, like the catalog: `..checklists` is a child, `../x` is not.
  const within = (root, target) => {
    const relative = path.relative(root, target);
    return (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  for (const source of project.execution_templates?.sources ?? []) {
    const root = source?.root?.projectPath;
    if (typeof root !== 'string') continue;
    // Catalog resolution: canonical source root inside the pack, canonical scan path
    // (subpath) inside that root; missing roots are skipped like the catalog does.
    const sourceRoot = path.resolve(projectRoot, root);
    // Lexically first (as configured), then after resolving symlinks.
    const lexicalEscape =
      !within(projectRoot, sourceRoot) ||
      !within(sourceRoot, path.resolve(sourceRoot, source.subpath ?? '.'));
    if (!lexicalEscape && !existsSync(sourceRoot)) continue;
    const canonicalRoot = existsSync(sourceRoot) ? realpathSync(sourceRoot) : sourceRoot;
    const scanPath = path.resolve(canonicalRoot, source.subpath ?? '.');
    const canonicalScan = existsSync(scanPath) ? realpathSync(scanPath) : null;
    if (
      lexicalEscape ||
      !within(packRoot, canonicalRoot) ||
      (canonicalScan && !within(canonicalRoot, canonicalScan))
    ) {
      issues.push(
        `${projectRoot}: execution template source ${source.id} resolves outside the pack`,
      );
      continue;
    }
    if (!canonicalScan) continue;
    for (const dir of readdirSync(canonicalScan, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const flowDir = path.join(canonicalScan, dir.name);
      for (const fileName of readdirSync(flowDir).filter((name) => name.endsWith('.md'))) {
        const checklistPath = path.join(flowDir, fileName);
        if (!lstatSync(checklistPath).isFile()) continue;
        const content = readFileSync(checklistPath, 'utf8');
        // Catalog metadata: frontmatter flow, then the flow directory.
        const flow = frontmatterFlow(content);
        for (const issue of lintWorkerTemplateProofSelection(content, flow ?? dir.name)) {
          issues.push(`${path.relative(repoRoot, checklistPath)}: ${issue}`);
        }
      }
    }
  }
  const templatesDir = path.join(projectRoot, 'templates/worker');
  if (!existsSync(templatesDir)) return;

  for (const fileName of readdirSync(templatesDir).filter((name) => name.endsWith('.md'))) {
    const templatePath = path.join(templatesDir, fileName);
    const content = readFileSync(templatePath, 'utf8');
    collectTemplateIssues(
      path.relative(repoRoot, templatePath),
      fileName,
      content,
      workerTerminal,
      issues,
    );
  }
}

/**
 * @param {string} displayPath
 * @param {string} fileName
 * @param {string} content
 * @param {import('./worker-terminal-contract.cjs').WorkerTerminalProjectConfig | null} workerTerminal
 * @param {string[]} issues
 */
function collectTemplateIssues(displayPath, fileName, content, workerTerminal, issues) {
  // No mark-usage gate here: the contract lint itself decides whether a
  // mark-less template is acceptable (only when the resolved contract has
  // requireSignal=false). Skipping mark-less templates entirely let a template
  // omit the required terminal command without any author-time signal.
  if (templateUsesTerminalMark(content)) {
    // Nested-loop role checklists render beside an existing task dir and keep
    // their own header, and dev-interactive renders into TASK.md for lightweight
    // interactive dev; every other flow template must not carry one (the
    // generated TASK.md does).
    const roleChecklist = /^(review|review-fix|ci-fix|dev-interactive)(?:[.-]|$)/.test(fileName);
    for (const issue of lintWorkerTemplateStructure(content, { roleChecklist })) {
      issues.push(`${displayPath}: ${issue}`);
    }
  }

  const { flowType, mode } = inferFlowTypeFromTemplate(fileName, content);
  const contract = resolveWorkerTerminalContract(workerTerminal, flowType, { mode });
  for (const issue of lintWorkerTemplateAgainstContract(content, contract)) {
    issues.push(`${displayPath}: ${issue}`);
  }
  for (const issue of lintWorkerTemplateProofSelection(content, flowType)) {
    issues.push(`${displayPath}: ${issue}`);
  }
}

/** @param {string | null} projectRoot */
function readWorkerTerminalConfig(projectRoot) {
  if (!projectRoot) return null;
  const projectJsonPath = path.join(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) return null;
  const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  return projectJson.worker_terminal ?? null;
}

/** @param {string} templatePath */
function findProjectRoot(templatePath) {
  let dir = path.dirname(templatePath);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'project.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** @param {string} fileName @param {string} content */
function inferFlowTypeFromTemplate(fileName, content) {
  const head = content.split('\n').slice(0, 6).join('\n').toLowerCase();
  const base = fileName.replace(/\.md$/, '');
  const mode = base.includes('interactive') ? 'interactive' : undefined;
  if (head.includes('fix-bug') || head.includes('fix bug')) return { flowType: 'fix-bug', mode };
  if (head.includes('review-pr') || head.includes('review pr'))
    return { flowType: 'review-pr', mode };
  if (head.includes('pr-complete') || head.includes('pr complete'))
    return { flowType: 'pr-complete', mode };
  if (head.includes('update-branch') || head.includes('update branch'))
    return { flowType: 'update-branch', mode };
  if (head.includes('interactive dev') || head.includes('feature') || head.includes('dev'))
    return { flowType: 'dev', mode };
  if (base.startsWith('fix-bug')) return { flowType: 'fix-bug', mode };
  if (base.startsWith('review-pr')) return { flowType: 'review-pr', mode };
  if (base.startsWith('pr-complete')) return { flowType: 'pr-complete', mode };
  if (base.startsWith('update-branch')) return { flowType: 'update-branch', mode };
  if (base.startsWith('dev')) return { flowType: 'dev', mode };
  if (base.startsWith('review-fix')) return { flowType: 'review-fix', mode };
  if (base.startsWith('review')) return { flowType: 'review', mode };
  if (base === 'ci-fix') return { flowType: 'ci-fix', mode };
  if (base === 'validate-dep') return { flowType: 'validate-dep', mode };
  return { flowType: base, mode };
}

/**
 * The `flow:` value of a leading frontmatter block, as the execution-template catalog reads it
 * (BOM stripped, LF or CRLF, closing `---` on its own line, optional quotes); body text is ignored.
 * @param {string} text
 */
function frontmatterFlow(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return undefined;
  // The closing fence is `---` alone on its line; searching from the opening fence's newline
  // lets an empty block close immediately.
  let end = -1;
  for (let from = 3; ; ) {
    const candidate = normalized.indexOf('\n---', from);
    if (candidate === -1) break;
    const after = normalized.slice(candidate + 4, candidate + 6);
    if (after === '' || after.startsWith('\n') || after.startsWith('\r\n')) {
      end = candidate;
      break;
    }
    from = candidate + 4;
  }
  if (end === -1) return undefined;
  for (const line of normalized.slice(normalized.indexOf('\n') + 1, end).split(/\r?\n/)) {
    const match = line.trim().match(/^flow\s*:\s*(.*)$/);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}
