# Refresh published PR evidence

Operator procedure for the run publication pipeline. Keep this page aligned
with the gateway refresh operation.

For a finished, published run with a recorded publication package whose evidence
was not delivered, use the gateway
that owns the run. The operation uploads media named by its current mirrored
evidence manifest, rewrites the evidence section through the normal publication
renderer, and records the posted description for Command Center. It does not
reopen approval, change code, or restamp historical reviews. Each refresh uploads
into a new revision directory, preserving every asset linked by the existing PR
if rendering or the body update fails.

```bash
farmslot rpc run.refreshPublishedEvidence '{"runId":"<published-run-id>"}'
```

An optional `selectedEvidenceKeys` array narrows the current manifest selection;
empty visual selections are rejected. Missing files, repository configuration,
upload failures, unreachable hosted assets or a concurrent PR change refuse the
body update. Wait for an active run to finish before refreshing its evidence.
