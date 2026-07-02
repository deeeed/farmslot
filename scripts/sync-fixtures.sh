#!/bin/bash
# sync-fixtures.sh — Apply project fixtures to a slot.
# Reads fixture mappings from projects/<name>/project.json.
#
# Usage:
#   sync-fixtures.sh --slot <id>    # apply fixtures from projects/<project>/fixtures/ to slot repo
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SLOT_ID=""

# Shell-side mirror of TEAM_NAME_RE / isValidTeamName in @farmslot/protocol
# (packages/protocol/src/contracts/runs.ts) — the single contract for team
# names. The value lands in sed replacement text and in fixture paths, so
# anything outside this allowlist (path separators, sed metacharacters,
# quotes, spaces) must be rejected here, not sanitized downstream.
TEAM_NAME_RE='^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot)      SLOT_ID="$2"; shift 2 ;;
    --flow-type) export FLOW_TYPE="$2"; shift 2 ;;
    --app)       export APP="$2"; shift 2 ;;
    --team)
      # bash [[ =~ ]] anchors ^/$ to the WHOLE string — grep (even -x) is
      # line-based, so a newline-embedded value like $'blue\nEVIL' would pass
      # on its first line and smuggle the rest into sed/paths.
      if ! [[ "$2" =~ $TEAM_NAME_RE ]]; then
        echo "FAIL: invalid --team '$2' — must be a lowercase slug (a-z, 0-9, '._-', no leading/trailing punctuation)" >&2
        exit 1
      fi
      export TEAM="$2"; shift 2 ;;
    *)           echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# --- Apply fixtures to a slot ---
if [ -n "${SLOT_ID}" ]; then
  echo "=== Applying fixtures to slot ${SLOT_ID} ==="

  POOL_DIR="${PROJECT_DIR}/pool"
  source "${SCRIPT_DIR}/lib/slot-common.sh"
  load_slot_vars "$SLOT_ID"
  check_slot_enabled || exit 0
  load_project_config || { echo "FAIL: no project config for ${PROJECT_NAME}"; exit 1; }

  # Custom slots default to custom flow type for fixture composition
  if [ "$(get_slot_mode)" = "custom" ]; then
    export FLOW_TYPE="${FLOW_TYPE:-custom}"
  fi

  LOCAL_HOSTNAME=$(hostname)

  # Detect if slot is on this machine
  is_local_slot=false
  is_local "$HOST" "$MACHINE" && is_local_slot=true

  # farmslot_dir: local = repo root, remote = agent deployment dir (matches gateway REMOTE_FARMSLOT_DIR)
  if [ "$is_local_slot" = true ]; then
    FARMSLOT_DIR="${PROJECT_DIR}"
  else
    FARMSLOT_DIR="~/farmslot-node"
  fi

  echo "  host:     ${SSH_TARGET} $([ "$is_local_slot" = true ] && echo '(local)')"
  echo "  repo:     ${REMOTE_REPO}"
  echo "  project:  ${PROJECT_NAME}"

  # Reuse a single SSH connection across every ssh/scp/rsync for remote slots.
  # Without this, each per-file copy spawns a fresh TCP+TLS handshake to the
  # node (~2-3s cold on WAN); the prepare-fixture step has ~40 SSH round trips
  # and used to tip past the gateway's fixtures timeout. ControlPersist keeps
  # the master around for follow-up phases (deps, preflight) that re-enter this
  # script with the same target.
  SSH_MUX_OPTS=()
  SSH_MUX_E=""
  if [ "$is_local_slot" != true ]; then
    # ControlPath must stay under the Unix-socket path limit (104 bytes on
    # macOS/Darwin, 108 on Linux). Default $TMPDIR on macOS is
    # /var/folders/<2>/<24>/T/ — over 40 chars before we add cm-%C (another
    # 40-char SHA), which overflows and makes every ssh fail with exit 255.
    # Stay under /tmp/ to keep total path short.
    SSH_CTL_DIR="$(mktemp -d /tmp/fs-ssh.XXXXXX)"
    SSH_CTL_PATH="${SSH_CTL_DIR}/cm-%C"
    trap 'rm -rf "${SSH_CTL_DIR}"' EXIT
    SSH_MUX_OPTS=(-o ControlMaster=auto -o "ControlPath=${SSH_CTL_PATH}" -o ControlPersist=60)
    SSH_MUX_E="ssh -o ControlMaster=auto -o ControlPath=${SSH_CTL_PATH} -o ControlPersist=60"
  fi

  # Helper: copy file to slot (preserves exec bit on *.sh so repo-local
  # wrappers like reopen-slot-browser.sh stay runnable without `bash` prefix).
  copy_to_slot() {
    local src="$1" dst="$2"
    if [ "$is_local_slot" = true ]; then
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      if [[ "$dst" == *.sh ]]; then chmod +x "$dst"; fi
    else
      # Don't redirect ssh stderr — swallowing it has hidden 255-class failures
      # (e.g. ControlPath > 104 bytes) for hours of debugging. Let real errors
      # land in the prepare log.
      ssh -n "${SSH_MUX_OPTS[@]}" -o BatchMode=yes "${SSH_TARGET}" "mkdir -p '$(dirname "$dst")'"
      scp -q "${SSH_MUX_OPTS[@]}" "$src" "${SSH_TARGET}:${dst}"
      if [[ "$dst" == *.sh ]]; then
        ssh -n "${SSH_MUX_OPTS[@]}" -o BatchMode=yes "${SSH_TARGET}" "chmod +x '$dst'"
      fi
    fi
  }

  # Helper: when a fixture dst is a tracked-upstream file, mark it
  # `skip-worktree` so the forced fixture patch doesn't show up in `git status`
  # during the worker session, and emit a `[WARN] forced fixture patch` line
  # so the project author sees what happened. Forced patches are intentional
  # (e.g. layering CLAUDE.md on top of upstream) but used to brick the next
  # prepare because the flag persisted across runs and broke
  # `git reset --hard <ref>` ("Entry not uptodate. Cannot merge.").
  # That part is now handled at the prepare side: slot.prepare clears every
  # skip-worktree / assume-unchanged flag before its reset chain (see PR #26).
  #
  # SSH path uses a TRACKED/UNTRACKED sentinel and checks the ssh exit code
  # separately so an infra failure (ssh / cd / git missing) is never silently
  # treated as "not tracked".
  mark_forced_patch_if_tracked() {
    local dst="$1"
    if [ "$is_local_slot" = true ]; then
      if git -C "$REMOTE_REPO" ls-files --error-unmatch "$dst" >/dev/null 2>&1; then
        if ! git -C "$REMOTE_REPO" update-index --skip-worktree "$dst"; then
          echo "[FAIL] Could not set skip-worktree on '${dst}' in ${REMOTE_REPO}." >&2
          exit 1
        fi
        echo "  [WARN] forced fixture patch onto tracked upstream file '${dst}' — visible to worker, reset by next prepare." >&2
      fi
    else
      local result
      if ! result=$(ssh -n "${SSH_MUX_OPTS[@]}" -o BatchMode=yes "${SSH_TARGET}" "cd '${REMOTE_REPO}' && (git ls-files --error-unmatch '${dst}' >/dev/null 2>&1 && echo TRACKED || echo UNTRACKED)" 2>&1); then
        echo "[FAIL] SSH check for fixture dst '${dst}' failed on ${SSH_TARGET}: ${result}" >&2
        exit 1
      fi
      # UNTRACKED must come first — it is a superstring of TRACKED, so the
      # reverse order would treat every untracked file as tracked and run
      # update-index --skip-worktree against paths git doesn't know (exit 128).
      case "$result" in
        *UNTRACKED*) ;;
        *TRACKED*)
          local mark
          if ! mark=$(ssh -n "${SSH_MUX_OPTS[@]}" -o BatchMode=yes "${SSH_TARGET}" "cd '${REMOTE_REPO}' && git update-index --skip-worktree '${dst}'" 2>&1); then
            echo "[FAIL] Could not set skip-worktree on '${dst}' in ${REMOTE_REPO} on ${SSH_TARGET}: ${mark}" >&2
            exit 1
          fi
          echo "  [WARN] forced fixture patch onto tracked upstream file '${dst}' on ${SSH_TARGET} — visible to worker, reset by next prepare." >&2
          ;;
        *)
          echo "[FAIL] Unexpected SSH response checking fixture dst '${dst}' on ${SSH_TARGET}: ${result}" >&2
          exit 1
          ;;
      esac
    fi
  }

  # Apply all fixture templates (includes former plain files + compose entries)
  TEMPLATE_COUNT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('fixtures',{}).get('templates',[])))")
  if [ "$TEMPLATE_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((TEMPLATE_COUNT - 1))); do
    TPL_SRC=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['templates'][$i].get('src',''))")
    TPL_DST=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['templates'][$i]['dst'])")
    TPL_DST=$(expand_slot_template "$TPL_DST")

    # Check for compose config
    COMPOSE_VAR=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
f=json.load(sys.stdin)['fixtures']['templates'][$i]
print(f.get('compose',{}).get('var',''))
" 2>/dev/null || true)

    if [ -n "$COMPOSE_VAR" ]; then
      # === Compose entry (variant-based) ===
      FLOW_TYPE_VAL="${!COMPOSE_VAR:-}"
      [ "$FLOW_TYPE_VAL" = "default" ] && FLOW_TYPE_VAL=""
      if [ -z "$FLOW_TYPE_VAL" ]; then
        AVAILABLE_VARIANTS=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
f=json.load(sys.stdin)['fixtures']['templates'][$i]
keys=list(f.get('compose',{}).get('variants',{}).keys())
print(' '.join(['default' if k=='' else k for k in keys]))
" 2>/dev/null || true)
        echo "  [SKIP] ${TPL_DST} — ${COMPOSE_VAR} not set (variants: ${AVAILABLE_VARIANTS})"
        continue
      fi

      VARIANT_FILE=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
f=json.load(sys.stdin)['fixtures']['templates'][$i]
variants=f.get('compose',{}).get('variants',{})
v=variants.get('${FLOW_TYPE_VAL}', '')
if isinstance(v, dict):
    print(v.get('file',''))
else:
    print(v)
" 2>/dev/null || true)

      COMPOSED=$(mktemp)
      if [ -n "$VARIANT_FILE" ] && [ -f "${PROJECT_FIXTURES_DIR}/${VARIANT_FILE}" ]; then
        cat "${PROJECT_FIXTURES_DIR}/${VARIANT_FILE}" > "$COMPOSED"
      elif [ -n "$VARIANT_FILE" ]; then
        echo "  [SKIP] No variant for FLOW_TYPE='${FLOW_TYPE_VAL}'"
        rm -f "$COMPOSED"
        continue
      else
        > "$COMPOSED"
      fi

      INCLUDE_COUNT=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
f=json.load(sys.stdin)['fixtures']['templates'][$i]
compose=f.get('compose',{})
variants=compose.get('variants',{})
v=variants.get('${FLOW_TYPE_VAL}', '')
if isinstance(v, dict):
    print(len(v.get('includes',[])))
else:
    print(len(compose.get('includes',[])))
" 2>/dev/null || echo 0)
      if [ "$INCLUDE_COUNT" -gt 0 ]; then
      for inc_i in $(seq 0 $((INCLUDE_COUNT - 1))); do
        INC_FILE=$(echo "$PROJECT_JSON" | python3 -c "
import json,sys
f=json.load(sys.stdin)['fixtures']['templates'][$i]
compose=f.get('compose',{})
variants=compose.get('variants',{})
v=variants.get('${FLOW_TYPE_VAL}', '')
if isinstance(v, dict):
    print(v['includes'][$inc_i])
else:
    print(compose['includes'][$inc_i])
")
        if [ -f "${PROJECT_FIXTURES_DIR}/${INC_FILE}" ]; then
          printf '\n' >> "$COMPOSED"
          cat "${PROJECT_FIXTURES_DIR}/${INC_FILE}" >> "$COMPOSED"
        else
          echo "  [WARN] include ${INC_FILE} not found"
        fi
      done
      fi

      # Run the same substitution path as regular templates so compose files
      # cannot drift and leave uppercase vars (for example {{CDP_PORT}})
      # unresolved.
      RENDERED_COMPOSED=$(render_fixture_template "$COMPOSED")
      copy_to_slot "$RENDERED_COMPOSED" "${REMOTE_REPO}/${TPL_DST}"
      rm -f "$COMPOSED" "$RENDERED_COMPOSED"
      mark_forced_patch_if_tracked "$TPL_DST"
      echo "  [OK] ${TPL_DST} (composed: ${VARIANT_FILE:-includes})"

    elif [ -n "$TPL_SRC" ]; then
      # === Template or plain file entry ===
      LOCAL_TPL="${PROJECT_FIXTURES_DIR}/${TPL_SRC}"
      if [ -f "$LOCAL_TPL" ]; then
        RENDERED=$(render_fixture_template "$LOCAL_TPL")
        copy_to_slot "$RENDERED" "${REMOTE_REPO}/${TPL_DST}"
        rm -f "$RENDERED"
        mark_forced_patch_if_tracked "$TPL_DST"
        echo "  [OK] ${TPL_DST}"
      else
        echo "  [SKIP] ${TPL_SRC} not found"
      fi
    else
      echo "  [SKIP] ${TPL_DST} — no src or compose"
    fi
  done
  fi

  # Apply directories (rsync)
  DIR_COUNT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('fixtures',{}).get('directories',[])))")
  if [ "$DIR_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((DIR_COUNT - 1))); do
    DIR_SRC=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['directories'][$i]['src'])")
    DIR_DST=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['directories'][$i]['dst'])")
    DIR_DST=$(expand_slot_template "$DIR_DST")

    LOCAL_DIR="${PROJECT_FIXTURES_DIR}/${DIR_SRC}"
    if [ ! -d "$LOCAL_DIR" ]; then
      echo "  [SKIP] ${DIR_SRC} directory not found in fixtures"
      continue
    fi

    # Build exclude args
    EXCLUDE_ARGS=""
    EXCLUDE_COUNT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['fixtures']['directories'][$i].get('exclude',[])))")
    if [ "$EXCLUDE_COUNT" -gt 0 ]; then
    for exc_i in $(seq 0 $((EXCLUDE_COUNT - 1))); do
      EXC_PAT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['directories'][$i]['exclude'][$exc_i])")
      EXCLUDE_ARGS="${EXCLUDE_ARGS} --exclude='${EXC_PAT}'"
    done
    fi

    REMOTE_DST="${REMOTE_REPO}/${DIR_DST}"

    # Stage locally first, then sync the rendered directory. This avoids fragile
    # remote heredoc quoting and keeps placeholder substitution identical for
    # local and remote slots.
    STAGED_DIR=$(mktemp -d)
    eval rsync -a ${EXCLUDE_ARGS} "'${LOCAL_DIR}/'" "'${STAGED_DIR}/'"

    find "$STAGED_DIR" -not -path '*/test-artifacts/*' -type f \( -name '*.md' -o -name '*.js' -o -name '*.json' -o -name '*.ts' -o -name '*.sh' \) -exec \
      sed -i.bak \
        -e "s|{{farmslot_dir}}|${FARMSLOT_DIR}|g" \
        -e "s|{{slot_id}}|${SLOT_ID}|g" \
        -e "s|{{platform}}|${PLATFORM}|g" \
        -e "s|{{port}}|${PORT:-}|g" \
        -e "s|{{cdp_port}}|${CDP_PORT:-}|g" \
        -e "s|{{simulator}}|${SIMULATOR:-}|g" \
        -e "s|{{runtime_dir}}|${RUNTIME_DIR:-.agent}|g" \
        -e "s|{{RUNTIME_DIR}}|${RUNTIME_DIR:-.agent}|g" \
        -e "s|{{artifact_dir}}|${ARTIFACT_DIR:-.task}|g" \
        -e "s|{{ARTIFACT_DIR}}|${ARTIFACT_DIR:-.task}|g" \
        -e "s|{{recipe_dir}}|${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}|g" \
        -e "s|{{RECIPE_DIR}}|${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}|g" \
        -e "s|{{team}}|${TEAM:-}|g" \
        -e "s|{{TEAM}}|${TEAM:-}|g" \
        {} +
    find "$STAGED_DIR" -name '*.bak' -delete

    if [ "$is_local_slot" = true ]; then
      mkdir -p "$REMOTE_DST"
      rsync -a "$STAGED_DIR/" "$REMOTE_DST/"
    else
      ssh -n "${SSH_MUX_OPTS[@]}" -o BatchMode=yes "${SSH_TARGET}" "mkdir -p '${REMOTE_DST}'" 2>/dev/null
      rsync -az -e "${SSH_MUX_E:-ssh}" "$STAGED_DIR/" "${SSH_TARGET}:${REMOTE_DST}/"
    fi
    rm -rf "$STAGED_DIR"
    echo "  [OK] ${DIR_DST}/ (directory)"
  done
  fi

  echo ""
  echo "Slot ${SLOT_ID} fixtures synced to ${REMOTE_REPO}"
fi

if [ -z "${SLOT_ID}" ]; then
  echo "Usage:"
  echo "  sync-fixtures.sh --slot <id> --flow-type <type>  # apply fixtures to slot"
  echo ""
  echo "Options:"
  echo "  --slot <id>          Slot to sync fixtures for"
  echo "  --flow-type <type>   Flow type for compose variants (e.g. fix-bug, new-feature, review-pr, personal, default)"
  echo "  --app <path>         Project-specific app selector for template substitution"
  echo "  --team <name>        Team overlay name for compose variants + {{team}} substitution"
  exit 1
fi

exit 0
