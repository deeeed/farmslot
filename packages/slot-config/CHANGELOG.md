# Changelog

All notable changes to `@farmslot/slot-config` are tracked here.

## Unreleased

- feat: initial extraction of the slot/pool/project config + hook/template expansion decision core from `services/gateway/src/core/{config,hooks}.ts`, so the CLI (`farmslot internal …` verbs) and the gateway share one implementation that works without a running gateway.
