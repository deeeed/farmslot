# Native reviewer usage backfill

New native review completions resolve their recorded conversation on the execution node and use the installed CLI's shared accounting module. The same measurement feeds normal and evaluation results. Missing or mismatched history remains explicitly unavailable.

Existing records with the former hardcoded unavailable result can be repaired once with:

```sh
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/backfill-native-reviewer-usage.mts \
  --gateway-root "$FARMSLOT_ROOT" --runs-dir "$FARMSLOT_RUNS_DIR" --report /tmp/reviewer-usage-backfill.json
```

This defaults to a dry-run and changes no run files. It reads the configured pool to reach execution hosts over SSH, batches up to 32 distinct sessions per node process, and uses exact session/owner metadata. The report lists successful measurements, unresolved bindings and failures. Totals retain the shared reader's session-total scope.

The lead applies during deployment. Stop the whole stack so supervision cannot restart the gateway, then repeat with `--apply`. The script refuses a live gateway PID, serializes migration writers and refuses any run whose bytes changed during measurement. Each changed file gets a content-hashed hard-link backup before an atomic, synced replacement. It preserves verdicts, learning content, unknown fields and unrelated usage; audit journals and transcript files stay untouched. Repeating the migration changes nothing once the legacy placeholders are repaired.

Restart the stack after the script finishes. Family summaries project tokens from the repaired canonical review usage; frozen audit and judgment artifacts are preserved. Retain the report and backup paths for rollback; restore a backup only while the gateway is stopped.
