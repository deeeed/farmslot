#!/bin/bash
set -euo pipefail
if [ -n "${TMUX_MODEL_DRIVER_SOCKET:-}" ]; then
  exec tmux -L "$TMUX_MODEL_DRIVER_SOCKET" "$@"
fi
exec tmux "$@"
