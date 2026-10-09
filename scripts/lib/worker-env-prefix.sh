# Shell prefix every worker launch runs before its runner. Single owner:
# services/gateway/src/runners/registry.ts (WORKER_ENV_PREFIX) reads the
# non-comment line below, and scripts/deploy-node.sh verifies the node CLI under it.
export DISABLE_OMC=1 DISABLE_OMX=1; ASDF_SHIMS="${ASDF_DATA_DIR:-$HOME/.asdf}/shims"; if [ -d "$ASDF_SHIMS" ]; then export PATH="$ASDF_SHIMS:$PATH"; fi
