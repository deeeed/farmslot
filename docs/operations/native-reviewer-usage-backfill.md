# Native reviewer usage backfill

Completed and settled failed native reviewer contexts resolve their recorded conversation on the execution node and use the installed CLI's shared accounting module. The same measurement feeds context receipts, normal results and evaluation results. Missing or mismatched history remains explicitly unavailable.

Existing context-only sessions and former hardcoded unavailable results can be repaired once with:

```sh
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/backfill-native-reviewer-usage.mts \
  --gateway-root "$FARMSLOT_ROOT" --runs-dir "$FARMSLOT_RUNS_DIR" --report /tmp/reviewer-usage-backfill.json
```

This defaults to a dry-run and changes no run files. It reads the configured pool to reach execution hosts over SSH, batches up to 32 distinct sessions per node process, and uses exact session/owner metadata. The report lists successful measurements, unresolved bindings and failures. Totals retain the shared reader's session-total scope.

The lead applies during deployment. Stop the whole stack so supervision cannot restart the gateway, then repeat with `--apply`. The script refuses a live gateway PID, serializes migration writers and refuses any run whose bytes changed during measurement. Each changed file gets a content-hashed hard-link backup before an atomic, synced replacement. It preserves verdicts, learning content, unknown fields and unrelated usage; audit journals and transcript files stay untouched. Repeating the migration changes nothing once context receipts and legacy placeholders are repaired.

Restart the stack after the script finishes. Family summaries project tokens from the deduplicated result and context receipts; frozen audit and judgment artifacts are preserved. Retain the report and backup paths for rollback; restore a backup only while the gateway is stopped.

## Pipeline capture coverage

All flows and roles use the run store's shared registration and session rows. Relaunch/replay source bindings remain in `Run.sessionUsage` after context replacement. Terminal settlement, native close and slot release collect usage through the shared worker parser. API helpers record every transport attempt, including failed attempts and all tool responses, through the shared LLM wrapper. Existing run RPCs return the rows.

| Session source                                   | Capture                                                            | Explicit gap                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Native Claude/Codex                              | Exact execution-host journal, account directory and conversation   | Pruned history/account directories remain unavailable.                                           |
| Terminal Claude/Codex/Pi                         | Recorded conversation path and existing worker parser              | Missing paths or transcripts remain unavailable.                                                 |
| Other native runners                             | Session row with exact identity and available source metadata      | Without transcript discovery or a supported parser, counters remain unavailable and unpriced.    |
| Grok/Cursor terminal sessions                    | Existing parser when its required structured source exists         | Grok needs its inference log; interactive Cursor has no persisted usage.                         |
| API grade, task/summary and other helpers        | Structured provider responses, all tool rounds and failed attempts | Unreported prices remain unpriced; provider-internal unreported retries cannot be reconstructed. |
| Claude CLI helper fallback                       | Structured JSON usage and recorded conversation id                 | Missing fields remain explicit gaps.                                                             |
| Legacy Codex CLI helper fallback                 | Request identity, model, effort, role and duration                 | Its plain stdout supplies no verifiable conversation id or usage.                                |
| Historical helpers                               | Retained step usage is preserved                                   | Missing original request identity cannot be invented.                                            |
| Standalone Copilot/native sessions outside a run | Their existing session identity/journal is retained                | No run receipt owner exists; durable run-less usage accounting remains a gap.                    |
| Opaque child agents or helpers outside a run     | Parent or returned helper receipt identifies the limitation        | Child identities and durable out-of-run retention are not available.                             |

The backfill reports capture gaps separately from successful measurements. It repairs all recoverable context roles and preserves unrelated records. A partial result is not a claim of complete historical coverage.

The offline safety proof takes over five seconds and stays outside the default test suite:

```sh
node --test scripts/runner-validation/native-usage-backfill.live.mjs
```
