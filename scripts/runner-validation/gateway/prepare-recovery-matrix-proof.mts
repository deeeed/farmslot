// Manual production recovery table: 192 real replay/Git cells exceed the default suite budget.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --experimental-test-module-mocks scripts/runner-validation/gateway/prepare-recovery-matrix-proof.mts
// Temporary repos, trapped tmux, no worker or server launch.
process.env.FARMSLOT_LIVE_RECOVERY_MATRIX = '1';
await import('../../../services/gateway/src/run-engine/prepare-recovery-matrix.test.js');
