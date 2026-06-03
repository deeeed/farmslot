# Error Log

## [ERR-20260511-001] codex-subagent-model-routing

**Logged**: 2026-05-11T05:26:50Z
**Priority**: medium
**Status**: pending
**Area**: tooling

### Summary

Two Codex native `explore` subagents failed because the configured spark model is not available on this ChatGPT-account Codex surface.

### Details

The failed subagents returned: `The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.`

### Suggested Action

When this surface is a ChatGPT-account Codex session, prefer standard roles such as `analyst` for local repository inventory, or avoid roles pinned to `gpt-5.3-codex-spark`.

### Metadata

- Source: error
- Tags: codex, subagents, model-routing, chatgpt-account

---
