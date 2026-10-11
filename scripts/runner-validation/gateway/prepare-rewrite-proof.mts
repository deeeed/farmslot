// Manual live tier, real Git; no tmux/server operations.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --test --test-name-pattern='destructive prepare rechecks' scripts/runner-validation/gateway/prepare-rewrite-proof.mts
process.env.FARMSLOT_LIVE_PREPARE_REWRITES = '1';
await import('../../../services/gateway/src/methods/slot/prepare-preserve-branch.test.js');
