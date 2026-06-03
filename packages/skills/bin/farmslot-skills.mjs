#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = path.join(packageRoot, 'skills');
const knownSkills = readdirSync(skillsRoot)
  .filter((entry) => existsSync(path.join(skillsRoot, entry, 'SKILL.md')))
  .sort();

const layoutDirs = {
  agents: '.agents/skills',
  claude: '.claude/skills',
  codex: '.codex/skills',
  cursor: '.cursor/skills',
};

function parseArgs(argv) {
  const parsed = {
    command: argv[0] || 'help',
    target: '.',
    layout: 'agents',
    include: [],
    force: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') parsed.target = argv[++index] || '.';
    else if (arg.startsWith('--target=')) parsed.target = arg.slice('--target='.length);
    else if (arg === '--layout') parsed.layout = argv[++index] || 'agents';
    else if (arg.startsWith('--layout=')) parsed.layout = arg.slice('--layout='.length);
    else if (arg === '--include') parsed.include = splitCsv(argv[++index] || '');
    else if (arg.startsWith('--include='))
      parsed.include = splitCsv(arg.slice('--include='.length));
    else if (arg === '--force') parsed.force = true;
  }
  return parsed;
}

function splitCsv(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function usage() {
  return [
    'Usage: farmslot-skills <command> [options]',
    '',
    'Commands:',
    '  list                         List bundled skills',
    '  install                      Install skills into a target layout',
    '  init                         Alias for install',
    '  doctor                       Print target install destination',
    '',
    'Options:',
    '  --target <dir>               Target root, default .',
    '  --layout <agents|claude|codex|cursor>',
    '  --include <a,b>              Skill names to install, default all',
    '  --force                      Replace existing installed skill directories',
  ].join('\n');
}

function selectedSkills(include) {
  const selected = include.length > 0 ? include : knownSkills;
  const unknown = selected.filter((skill) => !knownSkills.includes(skill));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown skill(s): ${unknown.join(', ')}. Known skills: ${knownSkills.join(', ')}`,
    );
  }
  return selected;
}

function install(args) {
  const relativeDest = layoutDirs[args.layout];
  if (!relativeDest) {
    throw new Error(
      `Unknown layout: ${args.layout}. Expected one of: ${Object.keys(layoutDirs).join(', ')}`,
    );
  }
  const targetRoot = path.resolve(args.target);
  const destRoot = path.join(targetRoot, relativeDest);
  mkdirSync(destRoot, { recursive: true });

  for (const skill of selectedSkills(args.include)) {
    const source = path.join(skillsRoot, skill);
    const dest = path.join(destRoot, skill);
    if (existsSync(dest)) {
      if (!args.force) {
        throw new Error(`Refusing to overwrite existing skill without --force: ${dest}`);
      }
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(source, dest, { recursive: true });
    console.log(`${skill} -> ${dest}`);
  }
}

function doctor(args) {
  const relativeDest = layoutDirs[args.layout];
  if (!relativeDest) {
    throw new Error(
      `Unknown layout: ${args.layout}. Expected one of: ${Object.keys(layoutDirs).join(', ')}`,
    );
  }
  const targetRoot = path.resolve(args.target);
  const destRoot = path.join(targetRoot, relativeDest);
  console.log(
    `package: ${JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).name}`,
  );
  console.log(`layout: ${args.layout}`);
  console.log(`destination: ${destRoot}`);
  console.log(`skills: ${knownSkills.join(', ')}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'list') console.log(knownSkills.join('\n'));
  else if (args.command === 'install' || args.command === 'init') install(args);
  else if (args.command === 'doctor') doctor(args);
  else {
    console.log(usage());
    if (args.command !== 'help' && args.command !== '--help' && args.command !== '-h')
      process.exitCode = 1;
  }
}

main();
