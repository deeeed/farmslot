#!/usr/bin/env bash
# Alias — canonical live proof is scripts/e2e-tmux-runner-validate.sh
exec "$(cd "$(dirname "$0")" && pwd)/e2e-tmux-runner-validate.sh" "$@"