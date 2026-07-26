---
title: Domains
---

# Domains

A **domain** (for example `payments` or `trading`) is a project-defined name
carried by a run or slot. It can select domain-specific execution templates,
fixtures, and command environment without putting product knowledge in
Farmslot.

## The `domains/<name>/` convention

A project that wants domain overlays keeps them under a `domains/<name>/` directory in its fixtures, for example:

```text
projects/<project>/fixtures/domains/
  trading/
    review-patterns.md
  payments/
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

The effective domain is resolved once:

```text
explicit run or prepare domain → slot domain → pool domain → none
```

That same value controls:

- fixture sync and `{{domain}}` / `{{DOMAIN}}` expansion;
- configured execution-template source/default filtering;
- the matching `command_env.domains.<name>` overlay for prepare, lifecycle,
  and worker commands.

With `execution_templates` configured, a domain-scoped source adds the exact
`domain:<name>` label to its templates. Selection uses that label and an
explicit configured default or exact template id; it never derives domain from
a filename.

With no `execution_templates` configuration, existing farms retain their
original worker-template behavior, including the legacy optional
`<flow>-<domain>.md` preference. New configured sources must use
`<flow>/<variant>.md`.

Domain names must match
`^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$`; invalid names are rejected rather
than sanitized.

## Selection model

Domains use a **set-once default + optional picker** model rather than forcing a per-dispatch choice:

- The pool or slot `domain` field sets the default once, at setup time.
- `--domain` overrides per dispatch when a run needs a different overlay than the default.
- Command Center and the dispatch CLI show the domains declared by the project
  execution-template and command-environment configuration. When no override
  is selected, the gateway applies the slot or pool default.

A single-domain project never has to think about this — set the machine default once and every dispatch carries it. A multi-domain project switches per dispatch with one flag or picker selection.
