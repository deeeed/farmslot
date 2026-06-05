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

function completionForShell(shell: CompletionShell): string {
  switch (shell) {
    case 'zsh':
      return ZSH_COMPLETION;
    case 'bash':
      return BASH_COMPLETION;
    case 'fish':
      return FISH_COMPLETION;
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

function installZshCompletion(): string {
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
  writeFileSync(completionPath, ZSH_COMPLETION, 'utf8');

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

function installCompletion(shell: CompletionShell): string {
  if (shell !== 'zsh') {
    throw new Error(
      `Install is currently supported for zsh only. Run 'farmslot completion ${shell}' to print ${shell} completions.`,
    );
  }
  return installZshCompletion();
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
          const installedPath = installCompletion(shell);
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

      process.stdout.write(completionForShell(shell));
    });
}

const ZSH_COMPLETION = `#compdef farmslot

_farmslot() {
  local context state state_descr line
  typeset -A opt_args

  _arguments -C \\
    '(--url)--url[Gateway WebSocket URL]:url:' \\
    '(--timeout)--timeout[Timeout in ms]:ms:' \\
    '(--json)--json[Output raw JSON]' \\
    '1: :_farmslot_commands' \\
    '*::arg:->args'

  case $state in
    args)
      case \${words[1]} in
        fleet) _farmslot_fleet ;;
        gateway) _farmslot_gateway ;;
        slot) _farmslot_slot ;;
        dispatch) _farmslot_dispatch ;;
        pr) _farmslot_pr ;;
        config) _farmslot_config ;;
        rpc) _arguments '1:method:' '2:params:' '(--stream)--stream[Show streaming events]' ;;
        recipe) _farmslot_recipe ;;
        run) _farmslot_run ;;
        completion) _farmslot_completion ;;
        node) _farmslot_node ;;
      esac ;;
  esac
}

_farmslot_commands() {
  local -a commands
  commands=(
    'fleet:Fleet management'
    'gateway:Gateway management'
    'slot:Slot lifecycle operations'
    'dispatch:Dispatch planning'
    'pr:PR status and monitoring'
    'config:View configuration'
    'rpc:Raw gateway RPC call'
    'recipe:Recipe protocol helpers'
    'run:Run lifecycle operations'
    'completion:Generate or install shell completions'
    'node:Node management'
  )
  _describe 'command' commands
}

_farmslot_fleet() {
  local -a commands
  commands=('status:Show fleet status' 'refresh:Force refresh')
  _describe 'subcommand' commands
}

_farmslot_gateway() {
  local -a commands
  commands=('status:Show Gateway health')
  _describe 'subcommand' commands
}

_farmslot_slot() {
  local -a commands
  commands=('current:Print current slot' 'check:Check slot health' 'prepare:Prepare slot' 'release:Release slot' 'refresh:Refresh slot' 'fixtures:Refresh fixtures' 'fixture-refresh:Refresh fixtures' 'sync:Quick-sync fixtures' 'open:Open slot repo' 'action:Project slot actions' 'recycle:Recycle slot')
  _describe 'subcommand' commands
}

_farmslot_dispatch() {
  local -a commands
  commands=('preview:Preview dispatch plan')
  _describe 'subcommand' commands
}

_farmslot_run() {
  local -a commands
  commands=('create:Create a supervised run')
  _describe 'subcommand' commands
}

_farmslot_recipe() {
  local -a commands
  commands=('validate:Validate recipe' 'run:Run a recipe through the harness')
  _describe 'subcommand' commands
}

_farmslot_pr() {
  local -a commands
  commands=('status:Show PR status' 'list:List active PRs')
  _describe 'subcommand' commands
}

_farmslot_config() {
  local -a commands
  commands=('pools:Show pool configurations' 'projects:Show project configurations')
  _describe 'subcommand' commands
}

_farmslot_completion() {
  local -a commands
  commands=('zsh:Print zsh completion' 'bash:Print bash completion' 'fish:Print fish completion' 'install:Install shell completion')
  _describe 'subcommand' commands
}

_farmslot_node() {
  local -a commands
  commands=('status:Show connected nodes' 'deploy:Deploy/update node')
  _describe 'subcommand' commands
}

_farmslot "$@"
`;

const BASH_COMPLETION = `_farmslot_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case \${COMP_CWORD} in
    1) COMPREPLY=($(compgen -W "fleet gateway slot dispatch pr config rpc recipe run completion node" -- "$cur")) ;;
    2)
      case \${COMP_WORDS[1]} in
        fleet) COMPREPLY=($(compgen -W "status refresh" -- "$cur")) ;;
        gateway) COMPREPLY=($(compgen -W "status" -- "$cur")) ;;
        slot) COMPREPLY=($(compgen -W "current check prepare release refresh fixtures fixture-refresh sync open action recycle" -- "$cur")) ;;
        dispatch) COMPREPLY=($(compgen -W "preview" -- "$cur")) ;;
        pr) COMPREPLY=($(compgen -W "status list" -- "$cur")) ;;
        config) COMPREPLY=($(compgen -W "pools projects" -- "$cur")) ;;
        recipe) COMPREPLY=($(compgen -W "validate run" -- "$cur")) ;;
        run) COMPREPLY=($(compgen -W "create" -- "$cur")) ;;
        completion) COMPREPLY=($(compgen -W "zsh bash fish install" -- "$cur")) ;;
        node) COMPREPLY=($(compgen -W "status deploy" -- "$cur")) ;;
      esac ;;
  esac
}

complete -F _farmslot_completions farmslot
`;

const FISH_COMPLETION = `# farmslot completions for fish
complete -c farmslot -n '__fish_use_subcommand' -a fleet -d 'Fleet management'
complete -c farmslot -n '__fish_use_subcommand' -a gateway -d 'Gateway management'
complete -c farmslot -n '__fish_use_subcommand' -a slot -d 'Slot lifecycle'
complete -c farmslot -n '__fish_use_subcommand' -a dispatch -d 'Dispatch planning'
complete -c farmslot -n '__fish_use_subcommand' -a pr -d 'PR status'
complete -c farmslot -n '__fish_use_subcommand' -a config -d 'Configuration'
complete -c farmslot -n '__fish_use_subcommand' -a rpc -d 'Raw RPC call'
complete -c farmslot -n '__fish_use_subcommand' -a recipe -d 'Recipe protocol helpers'
complete -c farmslot -n '__fish_use_subcommand' -a run -d 'Run lifecycle operations'
complete -c farmslot -n '__fish_use_subcommand' -a completion -d 'Shell completions'
complete -c farmslot -n '__fish_use_subcommand' -a node -d 'Node management'

complete -c farmslot -n '__fish_seen_subcommand_from fleet' -a 'status refresh'
complete -c farmslot -n '__fish_seen_subcommand_from gateway' -a 'status'
complete -c farmslot -n '__fish_seen_subcommand_from slot' -a 'current check prepare release refresh fixtures fixture-refresh sync open action recycle'
complete -c farmslot -n '__fish_seen_subcommand_from dispatch' -a 'preview'
complete -c farmslot -n '__fish_seen_subcommand_from pr' -a 'status list'
complete -c farmslot -n '__fish_seen_subcommand_from config' -a 'pools projects'
complete -c farmslot -n '__fish_seen_subcommand_from recipe' -a 'validate run'
complete -c farmslot -n '__fish_seen_subcommand_from run' -a 'create'
complete -c farmslot -n '__fish_seen_subcommand_from completion' -a 'zsh bash fish install'
complete -c farmslot -n '__fish_seen_subcommand_from node' -a 'status deploy'

complete -c farmslot -l url -d 'Gateway WebSocket URL'
complete -c farmslot -l timeout -d 'Timeout in ms'
complete -c farmslot -l json -d 'Output raw JSON'
`;
