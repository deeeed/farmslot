# Shell prefix every worker launch runs before its runner. Single owner:
# services/gateway/src/runners/registry.ts (WORKER_ENV_PREFIX) reads the
# non-comment line below, and scripts/deploy-node.sh verifies the node CLI under it.
#
# asdf shims go first so tool calls honor the repo's .tool-versions. Then
# ~/.local/bin, where deploy-node.sh links the node's farmslot CLI, goes ahead of
# them: workers start in a non-interactive `bash -lc` whose dotfiles may never
# add it (the tmux server PATH on macpro and mini has neither ~/.local/bin nor
# ~/.npm-global/bin), and it must win over a stale asdf-installed farmslot.
# Nothing there is expected to share a name with an asdf shim (on the nodes it
# holds farmslot and user-installed CLIs such as cursor-agent), so node and the
# other pinned tools still resolve through the shims.
export DISABLE_OMC=1 DISABLE_OMX=1; ASDF_SHIMS="${ASDF_DATA_DIR:-$HOME/.asdf}/shims"; if [ -d "$ASDF_SHIMS" ]; then export PATH="$ASDF_SHIMS:$PATH"; fi; export PATH="$HOME/.local/bin:$PATH"
