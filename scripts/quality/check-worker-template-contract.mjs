#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
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
  if (!templateUsesTerminalMark(content)) return;

  for (const issue of lintWorkerTemplateStructure(content)) {
    issues.push(`${displayPath}: ${issue}`);
  }

  const { flowType, mode } = inferFlowTypeFromTemplate(fileName, content);
  const contract = resolveWorkerTerminalContract(workerTerminal, flowType, { mode });
  for (const issue of lintWorkerTemplateAgainstContract(content, contract)) {
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
  if (base.startsWith('self-review-fix')) return { flowType: 'self-review-fix', mode };
  if (base.startsWith('self-review')) return { flowType: 'self-review', mode };
  if (base === 'ci-fix') return { flowType: 'ci-fix', mode };
  if (base === 'validate-dep') return { flowType: 'validate-dep', mode };
  return { flowType: base, mode };
}
