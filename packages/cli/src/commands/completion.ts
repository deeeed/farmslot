import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';

type CompletionShell = 'zsh' | 'bash' | 'fish';

export function shellQuoteForZsh(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function isCompletionShell(value: string): value is CompletionShell {
  return value === 'zsh' || value === 'bash' || value === 'fish';
}

interface CommandInfo {
  name: string;
  description: string;
  subs: CommandInfo[];
}

/** Derive the completion vocabulary from the live commander tree — the lists
 * can never go stale when commands are added. Recursive, so third-level
 * commands (e.g. `recipe artifacts validate`) complete too. */
export function commandTree(program: Command): CommandInfo[] {
  const walk = (command: Command): CommandInfo => ({
    name: command.name(),
    description: command.description().split('\n')[0] ?? '',
    subs: command.commands.filter((sub) => sub.name() !== 'help').map(walk),
  });
  return program.commands.filter((command) => command.name() !== 'help').map(walk);
}

function completionForShell(shell: CompletionShell, program: Command): string {
  const tree = commandTree(program);
  switch (shell) {
    case 'zsh':
      return zshCompletion(tree);
    case 'bash':
      return bashCompletion(tree);
    case 'fish':
      return fishCompletion(tree);
  }
}

function zshInstallDir(): string {
  const explicit = process.env.FARMSLOT_ZSH_COMPLETION_DIR;
  if (explicit) return explicit;

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'zsh', 'site-functions');
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function removeGroupAndOtherWriteBits(dir: string): void {
  const stat = statSync(dir);
  if ((stat.mode & 0o022) === 0) return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return;
  chmodSync(dir, stat.mode & ~0o022);
}

function secureHomeCompletionPath(installDir: string): void {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(installDir);
  if (!isPathInside(resolved, home)) return;

  let current = resolved;
  const dirs = [];
  while (isPathInside(current, home)) {
    dirs.push(current);
    if (current === home) break;
    current = path.dirname(current);
  }

  for (const dir of dirs.reverse()) {
    if (existsSync(dir)) removeGroupAndOtherWriteBits(dir);
  }
}

function insecureZshAncestor(installDir: string): string | undefined {
  let current = path.resolve(installDir);
  const home = path.resolve(os.homedir());
  while (true) {
    const stat = statSync(current);
    if ((stat.mode & 0o022) !== 0) return current;
    if (current === home) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function installZshCompletion(program: Command): string {
  const installDir = zshInstallDir();
  mkdirSync(installDir, { recursive: true });
  secureHomeCompletionPath(installDir);
  const unsafePath = insecureZshAncestor(installDir);
  if (unsafePath) {
    throw new Error(
      `Refusing to install zsh completion into compinit-insecure path: ${installDir} (unsafe ancestor: ${unsafePath})`,
    );
  }
  const completionPath = path.join(installDir, '_farmslot');
  writeFileSync(completionPath, completionForShell('zsh', program), 'utf8');

  const zshrc = path.join(os.homedir(), '.zshrc');
  const block = [
    '',
    '# Farmslot CLI completions',
    `fpath=(${shellQuoteForZsh(installDir)} $fpath)`,
    'autoload -Uz compinit',
    'compinit',
    '',
  ].join('\n');
  const current = existsSync(zshrc) ? readFileSync(zshrc, 'utf8') : '';
  if (!current.includes(installDir)) {
    writeFileSync(zshrc, `${current.replace(/\n?$/u, '\n')}${block}`, 'utf8');
  }

  return completionPath;
}

function installCompletion(shell: CompletionShell, program: Command): string {
  if (shell !== 'zsh') {
    throw new Error(
      `Install is currently supported for zsh only. Run 'farmslot completion ${shell}' to print ${shell} completions.`,
    );
  }
  return installZshCompletion(program);
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Generate or install shell completions')
    .argument('[shellOrAction]', 'Shell type (zsh, bash, fish) or action (install)', 'zsh')
    .argument('[shell]', 'Shell type for install: zsh, bash, fish', 'zsh')
    .option('--install', 'Install completions instead of printing them')
    .action((shellOrAction: string, shellArg: string, opts: { install?: boolean }) => {
      const install = opts.install || shellOrAction === 'install';
      const shell = shellOrAction === 'install' ? shellArg : shellOrAction;
      if (!isCompletionShell(shell)) {
        process.stderr.write(`Unknown shell: ${shell}. Supported: zsh, bash, fish\n`);
        process.exit(1);
      }

      if (install) {
        try {
          const installedPath = installCompletion(shell, program);
          process.stdout.write(`Installed ${shell} completion: ${installedPath}\n`);
          if (shell === 'zsh') {
            process.stdout.write(
              [
                'Restart your shell, or run this in the current shell:',
                `  fpath=(${shellQuoteForZsh(path.dirname(installedPath))} $fpath)`,
                '  autoload -Uz compinit && compinit',
              ].join('\n') + '\n',
            );
          }
        } catch (err) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
        return;
      }

      process.stdout.write(completionForShell(shell, program));
    });
}

function sanitizeDescription(value: string): string {
  return value.replace(/['\\]/gu, '').replace(/:/gu, ' -');
}

function zshCompletion(tree: CommandInfo[]): string {
  const fnName = (parts: string[]) => `_farmslot_${parts.join('_').replaceAll('-', '_')}`;
  const describeFns = (parts: string[], info: CommandInfo): string[] => {
    const nested = info.subs.filter((sub) => sub.subs.length > 0);
    const dispatch =
      nested.length > 0
        ? `\n  case \${words[2]} in\n${nested
            .map((sub) => `    ${sub.name}) ${fnName([...parts, sub.name])}; return ;;`)
            .join('\n')}\n  esac\n`
        : '';
    const own = `${fnName(parts)}() {${dispatch}
  local -a commands
  commands=(
${info.subs.map((sub) => `    ${shellQuoteForZsh(`${sub.name}:${sanitizeDescription(sub.description)}`)}`).join('\n')}
  )
  _describe 'subcommand' commands
}`;
    return [own, ...nested.flatMap((sub) => describeFns([...parts, sub.name], sub))];
  };
  const withSubs = tree.filter((c) => c.subs.length > 0);
  const subFns = withSubs.flatMap((c) => describeFns([c.name], c)).join('\n\n');
  const arms = withSubs.map((c) => `        ${c.name}) ${fnName([c.name])} ;;`).join('\n');
  const top = tree
    .map((c) => `    ${shellQuoteForZsh(`${c.name}:${sanitizeDescription(c.description)}`)}`)
    .join('\n');
  return [
    '#compdef farmslot',
    '',
    '_farmslot_commands() {',
    '  local -a commands',
    '  commands=(',
    top,
    '  )',
    "  _describe 'command' commands",
    '}',
    '',
    '_farmslot() {',
    '  local context state state_descr line',
    '  typeset -A opt_args',
    '',
    '  _arguments -C \\',
    "    '(--url)--url[Gateway WebSocket URL]:url:' \\",
    "    '(--timeout)--timeout[Timeout in ms]:ms:' \\",
    "    '(--json)--json[Output raw JSON]' \\",
    "    '1: :_farmslot_commands' \\",
    "    '*::arg:->args'",
    '',
    '  case $state in',
    '    args)',
    '      case ${words[1]} in',
    arms,
    '      esac ;;',
    '  esac',
    '}',
    '',
    subFns,
    '',
    '_farmslot "$@"',
    '',
  ].join('\n');
}

function bashCompletion(tree: CommandInfo[]): string {
  const top = tree.map((c) => c.name).join(' ');
  const arms = tree
    .filter((c) => c.subs.length > 0)
    .map(
      (c) =>
        `        ${c.name}) COMPREPLY=($(compgen -W "${c.subs.map((sub) => sub.name).join(' ')}" -- "$cur")) ;;`,
    )
    .join('\n');
  const thirdLevel = tree
    .flatMap((c) =>
      c.subs.filter((sub) => sub.subs.length > 0).map((sub) => ({ parent: c.name, sub })),
    )
    .map(
      ({ parent, sub }) =>
        `        "${parent} ${sub.name}") COMPREPLY=($(compgen -W "${sub.subs
          .map((g) => g.name)
          .join(' ')}" -- "$cur")) ;;`,
    )
    .join('\n');
  return [
    '_farmslot_completions() {',
    '  local cur prev',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '',
    '  case ${COMP_CWORD} in',
    `    1) COMPREPLY=($(compgen -W "${top}" -- "$cur")) ;;`,
    '    2)',
    '      case ${COMP_WORDS[1]} in',
    arms,
    '      esac ;;',
    '    3)',
    '      case "${COMP_WORDS[1]} ${COMP_WORDS[2]}" in',
    thirdLevel,
    '      esac ;;',
    '  esac',
    '}',
    '',
    'complete -F _farmslot_completions farmslot',
    '',
  ].join('\n');
}

function fishCompletion(tree: CommandInfo[]): string {
  const lines: string[] = ['# farmslot completions for fish (generated from the command tree)'];
  for (const c of tree) {
    lines.push(
      `complete -c farmslot -n '__fish_use_subcommand' -a ${c.name} -d '${sanitizeDescription(c.description)}'`,
    );
  }
  lines.push('');
  for (const c of tree.filter((cmd) => cmd.subs.length > 0)) {
    lines.push(
      `complete -c farmslot -n '__fish_seen_subcommand_from ${c.name}' -a '${c.subs
        .map((sub) => sub.name)
        .join(' ')}'`,
    );
    // Third level keyed on the intermediate subcommand name (fish has no
    // positional dispatch; sub names are unique enough across the tree today).
    for (const sub of c.subs.filter((candidate) => candidate.subs.length > 0)) {
      lines.push(
        `complete -c farmslot -n '__fish_seen_subcommand_from ${sub.name}' -a '${sub.subs
          .map((g) => g.name)
          .join(' ')}'`,
      );
    }
  }
  lines.push('');
  lines.push("complete -c farmslot -l url -d 'Gateway WebSocket URL'");
  lines.push("complete -c farmslot -l timeout -d 'Timeout in ms'");
  lines.push("complete -c farmslot -l json -d 'Output raw JSON'");
  return `${lines.join('\n')}\n`;
}
