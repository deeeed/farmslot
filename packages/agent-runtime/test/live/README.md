# Native adapter live checks

From a repository checkout, run the bounded effort JSON-RPC fixture manually:

```sh
TSX_TSCONFIG_PATH=packages/agent-runtime/tsconfig.json node --import tsx --test \
  --test-name-pattern='^Codex (default|plan|refuses|preserves)' \
  packages/agent-runtime/test/live/codex-effort.test.mts
```

This exercises production native-adapter requests against a private protocol
fixture, without model calls or a real runner session. It stays outside the
default suite because process ownership and cleanup can exceed five seconds.
