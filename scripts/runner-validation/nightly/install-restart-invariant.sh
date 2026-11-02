#!/usr/bin/env bash
# Installs the nightly restart invariant as a launchd LaunchAgent on this host (03:30 daily).
#
#   scripts/runner-validation/nightly/install-restart-invariant.sh [--checkout <path>] [--home <path>] [--uninstall]
#
# --checkout  the checkout the job runs and moves to origin/main each night; created as a clone
#             of this repository's origin when missing (~/dev/farmslot-worktrees/restart-invariant-nightly)
# --home      evidence, CLI snapshots and the launchd log (~/farmslot-restart-invariant)
# --uninstall unloads the agent and removes its plist; the checkout and evidence stay
#
# The status line goes to ~/lanes/restart-invariant/STATUS.md (see restart-invariant-nightly.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.farmslot.restart-invariant
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CHECKOUT="$HOME/dev/farmslot-worktrees/restart-invariant-nightly"
RI_HOME="$HOME/farmslot-restart-invariant"
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --home) RI_HOME="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL"
fi
if [ "$UNINSTALL" = 1 ]; then
  rm -f "$PLIST"
  echo "removed $LABEL; its checkout and evidence are kept"
  exit 0
fi

if ! git -C "$CHECKOUT" rev-parse --git-dir >/dev/null 2>&1; then
  source_repo="$(git -C "$HERE" rev-parse --show-toplevel)"
  git clone -q --reference "$source_repo" --dissociate "$(git -C "$source_repo" remote get-url origin)" "$CHECKOUT"
fi
mkdir -p "$RI_HOME" "$HOME/Library/LaunchAgents"
sed -e "s#__CHECKOUT__#$CHECKOUT#g" -e "s#__RI_HOME__#$RI_HOME#g" "$HERE/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: daily 03:30, checkout $CHECKOUT, evidence $RI_HOME"
echo "run once now: launchctl kickstart gui/$(id -u)/$LABEL"
