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

// Resolves the caller's shell from $SHELL (basename match); falls back to zsh
// when unset or unrecognized (matches the CLI's long-standing default).
export function detectShell(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellEnv = env.SHELL;
  if (shellEnv) {
    const base = path.basename(shellEnv);
    if (isCompletionShell(base)) return base;
  }
  return 'zsh';
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

export function installZshCompletion(): string {
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
  const fpathLine = `fpath=(${shellQuoteForZsh(installDir)} $fpath)`;
  const block = [
    '',
    '# Farmslot CLI completions',
    fpathLine,
    'autoload -Uz compinit',
    'compinit',
    '',
  ].join('\n');
  const current = existsSync(zshrc) ? readFileSync(zshrc, 'utf8') : '';
  // Compare against the quoted line actually written, not the raw installDir — an
  // apostrophe in the path (e.g. /Users/O'Connor) makes shellQuoteForZsh's escaped
  // form never contain installDir as a contiguous substring, which would otherwise
  // re-append the block on every run.
  if (!current.includes(fpathLine)) {
    writeFileSync(zshrc, `${current.replace(/\n?$/u, '\n')}${block}`, 'utf8');
  }

  return completionPath;
}

function bashInstallDir(): string {
  const explicit = process.env.FARMSLOT_BASH_COMPLETION_DIR;
  if (explicit) return explicit;

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'bash-completion', 'completions');
}

export function installBashCompletion(): string {
  const installDir = bashInstallDir();
  mkdirSync(installDir, { recursive: true });
  const completionPath = path.join(installDir, 'farmslot');
  writeFileSync(completionPath, BASH_COMPLETION, 'utf8');

  // bash-completion's dynamic loader auto-sources this file for machines that have
  // it installed; add a direct source line too so completions work without it.
  const bashrc = path.join(os.homedir(), '.bashrc');
  const sourceLine = `[ -f ${shellQuoteForZsh(completionPath)} ] && . ${shellQuoteForZsh(completionPath)}`;
  const block = ['', '# Farmslot CLI completions', sourceLine, ''].join('\n');
  const current = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : '';
  // Compare against the quoted line actually written, not the raw completionPath —
  // see the matching comment in installZshCompletion for why the raw path can't be
  // used as the idempotency check.
  if (!current.includes(sourceLine)) {
    writeFileSync(bashrc, `${current.replace(/\n?$/u, '\n')}${block}`, 'utf8');
  }

  return completionPath;
}

function fishInstallDir(): string {
  const explicit = process.env.FARMSLOT_FISH_COMPLETION_DIR;
  if (explicit) return explicit;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfigHome, 'fish', 'completions');
}

export function installFishCompletion(): string {
  // Fish autoloads any script under completions/ — no rc edit needed, and
  // re-running just overwrites the file, so this is inherently idempotent.
  const installDir = fishInstallDir();
  mkdirSync(installDir, { recursive: true });
  const completionPath = path.join(installDir, 'farmslot.fish');
  writeFileSync(completionPath, FISH_COMPLETION, 'utf8');
  return completionPath;
}

function installCompletion(shell: CompletionShell): string {
  switch (shell) {
    case 'zsh':
      return installZshCompletion();
    case 'bash':
      return installBashCompletion();
    case 'fish':
      return installFishCompletion();
  }
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Generate or install shell completions')
    .argument('[shellOrAction]', 'Shell type (zsh, bash, fish) or action (install)', 'zsh')
    .argument('[shell]', 'Shell type for install: zsh, bash, fish — defaults to the detected shell')
    .option('--install', 'Install completions instead of printing them')
    .action((shellOrAction: string, shellArg: string | undefined, opts: { install?: boolean }) => {
      const install = opts.install || shellOrAction === 'install';
      // `install` with no explicit shell arg detects it from $SHELL; the print path
      // keeps its long-standing zsh default (set via the argument default above).
      const explicitShell = shellOrAction === 'install' ? shellArg : shellOrAction;
      const shell = install ? (explicitShell ?? detectShell()) : explicitShell;
      if (!shell || !isCompletionShell(shell)) {
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
          } else if (shell === 'bash') {
            process.stdout.write(
              [
                'Restart your shell, or run this in the current shell:',
                `  source ${shellQuoteForZsh(installedPath)}`,
              ].join('\n') + '\n',
            );
          } else if (shell === 'fish') {
            process.stdout.write('Restart your shell (or run: exec fish) to load it.\n');
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
        runs) _farmslot_runs ;;
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
    'runs:Portable run bundle export/import'
    'completion:Generate or install shell completions'
    'node:Node management'
    'doctor:Check workspace health'
    'project:Project pack management'
    'update:Update workspace clone and packs'
    'login:Authenticate a gateway profile'
    'logout:Forget a gateway credential'
    'auth:Gateway authentication'
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
  commands=('status:Show Gateway health' 'add:Add gateway profile' 'remove:Remove gateway profile' 'list:List gateway profiles' 'use:Set active gateway profile')
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

_farmslot_runs() {
  local -a commands
  commands=('export:Export portable run bundle' 'import:Import portable run bundle' 'bundle:Inspect bundles')
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

if [ "$funcstack[1]" = "_farmslot" ]; then
  _farmslot "$@"
else
  compdef _farmslot farmslot
fi
`;

const BASH_COMPLETION = `_farmslot_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case \${COMP_CWORD} in
    1) COMPREPLY=($(compgen -W "fleet gateway slot dispatch pr config rpc recipe run runs completion node doctor project update login logout auth" -- "$cur")) ;;
    2)
      case \${COMP_WORDS[1]} in
        fleet) COMPREPLY=($(compgen -W "status refresh" -- "$cur")) ;;
        gateway) COMPREPLY=($(compgen -W "status add remove list use" -- "$cur")) ;;
        slot) COMPREPLY=($(compgen -W "current check prepare release refresh fixtures fixture-refresh sync open action recycle" -- "$cur")) ;;
        dispatch) COMPREPLY=($(compgen -W "preview" -- "$cur")) ;;
        pr) COMPREPLY=($(compgen -W "status list" -- "$cur")) ;;
        config) COMPREPLY=($(compgen -W "pools projects" -- "$cur")) ;;
        recipe) COMPREPLY=($(compgen -W "validate run" -- "$cur")) ;;
        run) COMPREPLY=($(compgen -W "create" -- "$cur")) ;;
        runs) COMPREPLY=($(compgen -W "export import bundle" -- "$cur")) ;;
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
complete -c farmslot -n '__fish_use_subcommand' -a doctor -d 'Check workspace health'
complete -c farmslot -n '__fish_use_subcommand' -a project -d 'Project pack management'
complete -c farmslot -n '__fish_use_subcommand' -a update -d 'Update workspace clone and packs'
complete -c farmslot -n '__fish_use_subcommand' -a login -d 'Authenticate a gateway profile'
complete -c farmslot -n '__fish_use_subcommand' -a logout -d 'Forget a gateway credential'
complete -c farmslot -n '__fish_use_subcommand' -a auth -d 'Gateway authentication'
complete -c farmslot -n '__fish_use_subcommand' -a slot -d 'Slot lifecycle'
complete -c farmslot -n '__fish_use_subcommand' -a dispatch -d 'Dispatch planning'
complete -c farmslot -n '__fish_use_subcommand' -a pr -d 'PR status'
complete -c farmslot -n '__fish_use_subcommand' -a config -d 'Configuration'
complete -c farmslot -n '__fish_use_subcommand' -a rpc -d 'Raw RPC call'
complete -c farmslot -n '__fish_use_subcommand' -a recipe -d 'Recipe protocol helpers'
complete -c farmslot -n '__fish_use_subcommand' -a run -d 'Run lifecycle operations'
complete -c farmslot -n '__fish_use_subcommand' -a runs -d 'Portable run bundle export/import'
complete -c farmslot -n '__fish_use_subcommand' -a completion -d 'Shell completions'
complete -c farmslot -n '__fish_use_subcommand' -a node -d 'Node management'

complete -c farmslot -n '__fish_seen_subcommand_from fleet' -a 'status refresh'
complete -c farmslot -n '__fish_seen_subcommand_from gateway' -a 'status add remove list use'
complete -c farmslot -n '__fish_seen_subcommand_from slot' -a 'current check prepare release refresh fixtures fixture-refresh sync open action recycle'
complete -c farmslot -n '__fish_seen_subcommand_from dispatch' -a 'preview'
complete -c farmslot -n '__fish_seen_subcommand_from pr' -a 'status list'
complete -c farmslot -n '__fish_seen_subcommand_from config' -a 'pools projects'
complete -c farmslot -n '__fish_seen_subcommand_from recipe' -a 'validate run'
complete -c farmslot -n '__fish_seen_subcommand_from run' -a 'create'
complete -c farmslot -n '__fish_seen_subcommand_from runs' -a 'export import bundle'
complete -c farmslot -n '__fish_seen_subcommand_from completion' -a 'zsh bash fish install'
complete -c farmslot -n '__fish_seen_subcommand_from node' -a 'status deploy'

complete -c farmslot -l url -d 'Gateway WebSocket URL'
complete -c farmslot -l timeout -d 'Timeout in ms'
complete -c farmslot -l json -d 'Output raw JSON'
`;
