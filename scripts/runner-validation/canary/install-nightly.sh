#!/usr/bin/env bash
# Installs the nightly canary (canary.mts --profile nightly) as a launchd LaunchAgent on this host (03:30 daily).
#
#   scripts/runner-validation/canary/install-nightly.sh [--checkout <path>] [--home <path>] [--uninstall]
#
# --checkout  the checkout the job runs and moves to origin/main each night; created as a clone
#             of this repository's origin when missing (~/dev/farmslot-worktrees/canary-nightly)
# --home      evidence, CLI snapshots and the launchd log (~/farmslot-canary)
# --uninstall unloads the agent and removes its plist; the checkout and evidence stay
#
# The status line goes to ~/lanes/canary-nightly/STATUS.md (see nightly.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.farmslot.canary-nightly
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CHECKOUT="$HOME/dev/farmslot-worktrees/canary-nightly"
CANARY_HOME="$HOME/farmslot-canary"
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --home) CANARY_HOME="$2"; shift 2 ;;
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
mkdir -p "$CANARY_HOME" "$HOME/Library/LaunchAgents"
sed -e "s#__CHECKOUT__#$CHECKOUT#g" -e "s#__CANARY_HOME__#$CANARY_HOME#g" "$HERE/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: daily 03:30, checkout $CHECKOUT, evidence $CANARY_HOME"
echo "run once now: launchctl kickstart gui/$(id -u)/$LABEL"
