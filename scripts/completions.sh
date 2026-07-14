#!/bin/bash
# completions.sh — `farm` wrapper + tab completion (bash + zsh)
#
# Usage:
#   source ~/dev/farmslot/scripts/completions.sh
#
#   farm check-slot <tab>       → slot IDs
#   farm archive-run <tab>      → project names, then branch names
#   farm <tab>                  → available commands

# ── Resolve farmslot root ────────────────────────────────────────────
FARMSLOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"

# ── Available commands ───────────────────────────────────────────────
_farm_commands=(
  check-slot
  preflight-slot
  setup-slot
  sync-fixtures
  session-usage
  status
  pr-status
  pr-monitor
)

# ── farm wrapper ─────────────────────────────────────────────────────
farm() {
  local cmd="$1"
  shift 2>/dev/null || true

  case "$cmd" in
    status)      bash "$FARMSLOT_DIR/scripts/farm-status.sh" "$@" ;;
    pr-status)
      # Legacy wrapper surface: --pr N → pr status N, else pr list; --json/--human
      # map to the machine flag; auto-JSON when piped; --since ignored (compat).
      local _pr="" _json=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --pr) _pr="$2"; shift 2 ;;
          --json) _json="--json"; shift ;;
          --human) _json=""; shift ;;
          --since) shift 2 ;;
          *) shift ;;
        esac
      done
      [ -z "$_json" ] && [ ! -t 1 ] && _json="--json"
      if [ -n "$_pr" ]; then
        "$FARMSLOT_DIR/packages/cli/bin/farmslot.mjs" $_json pr status "$_pr"
      else
        "$FARMSLOT_DIR/packages/cli/bin/farmslot.mjs" $_json pr list
      fi ;;
    pr-monitor)  bash "$FARMSLOT_DIR/scripts/pr-monitor.sh" "$@" ;;
    ""|--help|-h)
      echo "Usage: farm <command> [args]"
      echo ""
      echo "Commands:"
      printf "  %s\n" "${_farm_commands[@]}"
      ;;
    *)
      local script="$FARMSLOT_DIR/scripts/${cmd}.sh"
      if [ -f "$script" ]; then
        bash "$script" "$@"
      else
        echo "farm: unknown command '$cmd'" >&2
        echo "Run 'farm --help' for available commands." >&2
        return 1
      fi
      ;;
  esac
}

# ── Data sources ─────────────────────────────────────────────────────
_farm_slot_ids() {
  python3 -c "
import json, glob, os
for f in sorted(glob.glob(os.path.join('$FARMSLOT_DIR', 'pool', '*.json'))):
    name = os.path.basename(f)
    if name == 'example.json': continue
    if name == 'farmslot-demo.json' and os.environ.get('FARMSLOT_DEMO_POOL') != '1': continue
    try:
        data = json.load(open(f))
        for s in data.get('slots', []):
            print(s['id'])
    except: pass
" 2>/dev/null
}

_farm_project_names() {
  for d in "$FARMSLOT_DIR"/projects/*/project.json; do
    [ -f "$d" ] && basename "$(dirname "$d")"
  done
}

_farm_task_files() {
  # tasks/<flow>/<id>/TASK.md
  for f in "$FARMSLOT_DIR"/projects/*/tasks/*/*/TASK.md; do
    [ -f "$f" ] || continue
    echo "${f#$FARMSLOT_DIR/}"
  done
}

# ── Commands grouped by completion type ──────────────────────────────
_farm_cmd_takes_slot() {
  case "$1" in
    check-slot|preflight-slot|prepare-slot|\
    setup-slot|session-usage)
      return 0 ;;
    *) return 1 ;;
  esac
}

# ── Bash completion ──────────────────────────────────────────────────
if [ -n "${BASH_VERSION:-}" ]; then
  _farm_completions() {
    local cur prev words cword
    _get_comp_words_by_ref -n : cur prev words cword 2>/dev/null || {
      cur="${COMP_WORDS[COMP_CWORD]}"
      prev="${COMP_WORDS[COMP_CWORD-1]}"
      words=("${COMP_WORDS[@]}")
      cword=$COMP_CWORD
    }

    if [ "$cword" -eq 1 ]; then
      COMPREPLY=($(compgen -W "${_farm_commands[*]}" -- "$cur"))
      return
    fi

    local cmd="${words[1]}"
    if [ "$cword" -eq 2 ]; then
      if _farm_cmd_takes_slot "$cmd"; then
        COMPREPLY=($(compgen -W "$(_farm_slot_ids)" -- "$cur"))
      elif [ "$cmd" = "sync-fixtures" ]; then
        COMPREPLY=($(compgen -W "--slot" -- "$cur"))
      fi
      return
    fi

    if [ "$cword" -ge 3 ]; then
      case "$cmd" in
        session-usage) [ "$cword" -eq 3 ] && COMPREPLY=($(compgen -W "snapshot report total" -- "$cur")) ;;
        sync-fixtures)
          case "$prev" in
            --slot)      COMPREPLY=($(compgen -W "$(_farm_slot_ids)" -- "$cur")) ;;
            --flow-type) COMPREPLY=($(compgen -W "custom default fix-bug new-feature review-pr" -- "$cur")) ;;
            *)           COMPREPLY=($(compgen -W "--slot --flow-type" -- "$cur")) ;;
          esac
          ;;
      esac
      return
    fi
  }

  complete -F _farm_completions farm
fi

# ── Zsh completion ───────────────────────────────────────────────────
if [ -n "${ZSH_VERSION:-}" ]; then
  _farm_completions_zsh() {
    local -a completions
    local cmd="${words[2]}"
    local pos=$((CURRENT - 1))

    if [ "$pos" -eq 1 ]; then
      compadd -- "${_farm_commands[@]}"
      return
    fi

    if [ "$pos" -eq 2 ]; then
      if _farm_cmd_takes_slot "$cmd"; then
        completions=("${(@f)$(_farm_slot_ids)}")
        compadd -a completions
      elif [ "$cmd" = "sync-fixtures" ]; then
        compadd -- "--slot"
      fi
      return
    fi

    if [ "$pos" -ge 3 ]; then
      local prev_word="${words[$((CURRENT - 1))]}"
      case "$cmd" in
        session-usage)
          [ "$pos" -eq 3 ] && { completions=(snapshot report total); compadd -a completions; }
          ;;
        sync-fixtures)
          case "$prev_word" in
            --slot)      completions=("${(@f)$(_farm_slot_ids)}"); compadd -a completions ;;
            --flow-type) compadd -- "custom" "default" "fix-bug" "new-feature" "review-pr" ;;
            *)           compadd -- "--slot" "--flow-type" ;;
          esac
          ;;
      esac
      return
    fi
  }

  if (( $+functions[compdef] )); then
    compdef _farm_completions_zsh farm
  else
    autoload -Uz compinit 2>/dev/null && compinit -u 2>/dev/null
    (( $+functions[compdef] )) && compdef _farm_completions_zsh farm
  fi
fi
