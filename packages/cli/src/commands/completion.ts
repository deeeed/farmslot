import type { Command } from 'commander';

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Generate shell completions')
    .argument('[shell]', 'Shell type: zsh, bash, fish', 'zsh')
    .action((shell: string) => {
      switch (shell) {
        case 'zsh':
          process.stdout.write(ZSH_COMPLETION);
          break;
        case 'bash':
          process.stdout.write(BASH_COMPLETION);
          break;
        case 'fish':
          process.stdout.write(FISH_COMPLETION);
          break;
        default:
          process.stderr.write(`Unknown shell: ${shell}. Supported: zsh, bash, fish\n`);
          process.exit(1);
      }
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
        slot) _farmslot_slot ;;
        dispatch) _farmslot_dispatch ;;
        pr) _farmslot_pr ;;
        config) _farmslot_config ;;
        rpc) _arguments '1:method:' '2:params:' '(--stream)--stream[Show streaming events]' ;;
        recipe) _farmslot_recipe ;;
        run) _farmslot_run ;;
        completion) _describe 'shell' '(zsh bash fish)' ;;
      esac ;;
  esac
}

_farmslot_commands() {
  local -a commands
  commands=(
    'fleet:Fleet management'
    'slot:Slot lifecycle operations'
    'dispatch:Dispatch planning'
    'pr:PR status and monitoring'
    'config:View configuration'
    'rpc:Raw gateway RPC call'
    'recipe:Recipe protocol helpers'
    'run:Run lifecycle operations'
    'completion:Generate shell completions'
  )
  _describe 'command' commands
}

_farmslot_fleet() {
  local -a commands
  commands=('status:Show fleet status' 'refresh:Force refresh')
  _describe 'subcommand' commands
}

_farmslot_slot() {
  local -a commands
  commands=('check:Check slot health' 'prepare:Prepare slot' 'release:Release slot' 'recycle:Recycle slot')
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

_farmslot "$@"
`;

const BASH_COMPLETION = `_farmslot_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case \${COMP_CWORD} in
    1) COMPREPLY=($(compgen -W "fleet slot dispatch pr config rpc recipe run completion" -- "$cur")) ;;
    2)
      case \${COMP_WORDS[1]} in
        fleet) COMPREPLY=($(compgen -W "status refresh" -- "$cur")) ;;
        slot) COMPREPLY=($(compgen -W "check prepare release recycle" -- "$cur")) ;;
        dispatch) COMPREPLY=($(compgen -W "preview" -- "$cur")) ;;
        pr) COMPREPLY=($(compgen -W "status list" -- "$cur")) ;;
        config) COMPREPLY=($(compgen -W "pools projects" -- "$cur")) ;;
        recipe) COMPREPLY=($(compgen -W "validate run" -- "$cur")) ;;
        run) COMPREPLY=($(compgen -W "create" -- "$cur")) ;;
        completion) COMPREPLY=($(compgen -W "zsh bash fish" -- "$cur")) ;;
      esac ;;
  esac
}

complete -F _farmslot_completions farmslot
`;

const FISH_COMPLETION = `# farmslot completions for fish
complete -c farmslot -n '__fish_use_subcommand' -a fleet -d 'Fleet management'
complete -c farmslot -n '__fish_use_subcommand' -a slot -d 'Slot lifecycle'
complete -c farmslot -n '__fish_use_subcommand' -a dispatch -d 'Dispatch planning'
complete -c farmslot -n '__fish_use_subcommand' -a pr -d 'PR status'
complete -c farmslot -n '__fish_use_subcommand' -a config -d 'Configuration'
complete -c farmslot -n '__fish_use_subcommand' -a rpc -d 'Raw RPC call'
complete -c farmslot -n '__fish_use_subcommand' -a recipe -d 'Recipe protocol helpers'
complete -c farmslot -n '__fish_use_subcommand' -a run -d 'Run lifecycle operations'
complete -c farmslot -n '__fish_use_subcommand' -a completion -d 'Shell completions'

complete -c farmslot -n '__fish_seen_subcommand_from fleet' -a 'status refresh'
complete -c farmslot -n '__fish_seen_subcommand_from slot' -a 'check prepare release recycle'
complete -c farmslot -n '__fish_seen_subcommand_from dispatch' -a 'preview'
complete -c farmslot -n '__fish_seen_subcommand_from pr' -a 'status list'
complete -c farmslot -n '__fish_seen_subcommand_from config' -a 'pools projects'
complete -c farmslot -n '__fish_seen_subcommand_from recipe' -a 'validate run'
complete -c farmslot -n '__fish_seen_subcommand_from run' -a 'create'
complete -c farmslot -n '__fish_seen_subcommand_from completion' -a 'zsh bash fish'

complete -c farmslot -l url -d 'Gateway WebSocket URL'
complete -c farmslot -l timeout -d 'Timeout in ms'
complete -c farmslot -l json -d 'Output raw JSON'
`;
