# Changelog

All notable changes to `@farmslot/slot-config` are tracked here.

## Unreleased

## 0.1.0 - 2026-07-13

- feat: `session-usage.ts` — runner session discovery (claude/codex/grok), JSONL token aggregation, and model pricing ported from `scripts/session-usage.sh`'s python; consumed by the gateway and `farmslot internal session-usage`.
- feat: initial extraction of the slot/pool/project config + hook/template expansion decision core from `services/gateway/src/core/{config,hooks}.ts`, so the CLI (`farmslot internal …` verbs) and the gateway share one implementation that works without a running gateway.
