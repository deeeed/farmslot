#!/usr/bin/env bash
# backup-runs.sh — Copy tasks/ and runs/ for farm projects into .backups/
set -euo pipefail

FARMSLOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$FARMSLOT_DIR/.backups"
usage() {
  echo "Usage: $0 [--project <name>] [--all]"
  echo "  --project <name>  Backup a specific project"
  echo "  --all             Backup all projects"
  exit 1
}

backup_project() {
  local name="$1"
  local proj_dir="$FARMSLOT_DIR/projects/$name"

  if [[ ! -d "$proj_dir" ]]; then
    echo "ERROR: project dir not found: $proj_dir"
    return 1
  fi

  mkdir -p "$BACKUP_DIR"

  for subdir in tasks runs; do
    local src="$proj_dir/$subdir"
    local dst="$BACKUP_DIR/${name}-${subdir}"

    if [[ ! -d "$src" ]] || [[ -z "$(ls -A "$src" 2>/dev/null)" ]]; then
      echo "  SKIP $name/$subdir (empty or missing)"
      continue
    fi

    rsync -a --ignore-existing "$src/" "$dst/"
    local count=$(find "$dst" -type f | wc -l | tr -d ' ')
    echo "  OK   $dst ($count files)"
  done
}

MODE=""
PROJECT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; MODE="single"; shift 2 ;;
    --all)     MODE="all"; shift ;;
    *)         usage ;;
  esac
done

[[ -z "$MODE" ]] && usage

if [[ "$MODE" == "single" ]]; then
  echo "Backing up $PROJECT..."
  backup_project "$PROJECT"
elif [[ "$MODE" == "all" ]]; then
  echo "Backing up all projects..."
  for proj_dir in "$FARMSLOT_DIR"/projects/*-farm; do
    [[ -d "$proj_dir" ]] || continue
    name=$(basename "$proj_dir")
    echo "Project: $name"
    backup_project "$name"
  done
fi

echo "Done. Backups in $BACKUP_DIR/"
