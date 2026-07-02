---
title: Domains
---

# Domains

A **domain** (for example `perps`, `swaps`, `assets`) is a named overlay a run or slot can carry. It selects domain-specific prompt content and fixtures without forking the project or the orchestration system. Domains are generic and project-defined — Farmslot only threads the name through dispatch, prepare, and fixture sync; the project owns what a domain actually means.

## The `domains/<name>/` convention

A project that wants domain overlays keeps them under a `domains/<name>/` directory in its fixtures, for example:

```text
projects/<project>/fixtures/domains/
  perps/
    review-patterns.md
  swaps/
    review-patterns.md
```

`_template` is reserved and excluded from discovery — use it for a starter/example domain that isn't itself a real overlay.

Nothing in the engine hardcodes this directory name; it is the recommended convention so `farmslot domain ls` (and the dispatch picker built on top of it) has a predictable place to look. A project's `fixtures.templates` entries reference files under this convention with the `{{domain}}` placeholder, for example:

```json
{
  "fixtures": {
    "templates": [
      { "src": "domains/{{domain}}/review-patterns.md", "dst": "REVIEW.md", "optional": true }
    ]
  }
}
```

## `farmslot domain ls`

Lists the domains discovered across configured projects by scanning each project's fixtures for `domains/<name>/` directories, excluding `_template`, deduping and sorting the result.

```bash
farmslot domain ls
farmslot domain ls --json
```

Plain output is a readable list; `--json` emits an array for the installer or a dispatch picker to consume. An empty result prints a clear "no domains found" message and exits 0 — no domains configured is not an error.

## Resolution precedence

A domain name can be set at three levels, with the most specific value winning:

1. **Task** — `--domain <name>` on `farmslot dispatch preview` or `farmslot run create` (or the `domain` field on a dispatch/run request).
2. **Slot** — the `domain` field on a pool slot.
3. **Machine** — the `domain` field on the pool machine entry (the default for every dispatch from that machine).

Unset at every level means no domain overlay — existing single-domain and no-domain projects are unaffected.

The resolved domain flows through to:

- **Fixture sync** — passed to `sync-fixtures.sh` as `--domain <name>`, available in fixture content as the `{{domain}}` / `{{DOMAIN}}` placeholders, and used to resolve `{{domain}}`-templated fixture paths (including optional compose includes).
- **Worker template selection** — when a run doesn't select an explicit or interactive template, a domain-variant template `<flow>-<domain>.md` (for example `fix-bug-perps.md`) is preferred over the flow default when it exists. See [Customize worker prompts](../guides/customize-worker-prompts.md).

Domain names must match a lowercase slug contract (`^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$`) — the same value lands in fixture paths, sed replacement text, and template file names, so anything outside that allowlist is rejected at the entry point rather than sanitized.

## Selection model

Domains use a **set-once default + optional picker** model rather than forcing a per-dispatch choice:

- The pool `domain` field (machine or slot) sets the default once, at setup time.
- `--domain` overrides per dispatch when a run needs a different overlay than the default.
- A dispatch UI or CLI can offer a picker seeded by `farmslot domain ls`, pre-selected to the resolved default.

A single-domain project never has to think about this — set the machine default once and every dispatch carries it. A multi-domain project switches per dispatch with one flag or picker selection.
