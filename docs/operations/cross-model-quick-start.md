# Cross-model orchestration quick-start

Start two lanes and review one PR with the [canonical skill](../../.agents/skills/cross-model-orchestrator/SKILL.md).
Install tmux and the model CLIs. Claude also needs its local `/goal` command installed.
The [concepts page](../reference/cross-model-orchestration.md) defines review and merge policy.

## Prepare two lanes

Create separate checkouts and a GOAL.md for each. Name acceptance checks, owned paths,
and evidence. Start each REPORT.md with its state and next step. Save this as
`local/config.json`, outside the tracked tree. Paths resolve relative to that file.
Choose a unique private socket name.

```json
{
  "version": 1,
  "state_dir": "state",
  "tmux": { "socket": "cross-model-demo" },
  "lanes": [
    {
      "id": "worker",
      "runner": "codex",
      "cwd": "worker/checkout",
      "goal": "worker/GOAL.md",
      "report": "worker/REPORT.md",
      "reservations": ["src/feature"]
    },
    {
      "id": "docs",
      "runner": "claude",
      "cwd": "docs/checkout",
      "goal": "docs/GOAL.md",
      "report": "docs/REPORT.md",
      "goal_command": "/goal",
      "reservations": ["docs"]
    }
  ],
  "projects": {
    "example/project": {
      "auto_merge": false,
      "hooks": {},
      "forbidden_patterns": [],
      "expected_nodes": []
    }
  }
}
```

Install `templates/goal.md` as `docs/checkout/.claude/commands/goal.md` before launching the
Claude lane. Run from the Farmslot checkout:

```bash
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json launch worker
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json launch docs
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json lanes-status
```

Use `send worker --file <path>` for a file-backed follow-up. Pending questions block
ordinary sends; inspect and resolve the actual question first. `restore` recovers after
a tmux crash. Use `reserve <lane> <paths...>` and
`transfer <source> <destination> <paths...>` to change ownership.

## Review and merge

Have the worker finish evidence, commit the reviewable head, and report its canonical PR.
One command runs one round; repeat only after fixing blockers:

```bash
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json review --repo example/project --pr 123 --cwd worker/checkout --report worker/REPORT.md
```

Intermediate rounds run affected tests and `yarn prepush:quality`. The final committed
SHA gets one `yarn quality`. Both approvals freeze the head. Once CI passes, the lead
checks readiness and inspects the merge dry run:

```bash
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json ready example/project 123 <full-SHA> worker/REPORT.md
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json heartbeat
python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config local/config.json merge-watch
```

`ready` writes `MERGE-READY` only after all gates pass. Keep `auto_merge` false for
rollout proof. If the project already authorizes an admin merge after these gates, set
`merge_admin: true` in its local config. For an authorized repository, enable auto-merge and run
`merge-watch --execute --watch` to poll every minute. Record later ideas under `FOLLOW-UPS`.
Round 4 writes `ESCALATE`; round 5 writes `STOPPED` and requires a lead decision.

## Cut over an existing lead

| Existing responsibility                      | Replacement                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `lead-heartbeat`                             | `heartbeat`                                                                |
| `merge-watch` and `pr-ready`                 | `merge-watch` and `ready`                                                  |
| `run-attention`                              | `attention`, with a `runs` JSON hook                                       |
| Lane registry and GOAL/REPORT briefs         | Config, `lanes-status`, `launch`, `restore`                                |
| Raw nudges and separate review orchestrators | `send` and `review`                                                        |
| `dev-gateway-update`                         | Project hook `gateway_update`                                              |
| Node deploy and package sync                 | Hooks `node_deploy` and `pack_sync`                                        |
| `worktree-sweep`, `nm-sweep`, `purge-tmp`    | Optional hooks `worktree_cleanup`, `dependency_cleanup`, `scratch_cleanup` |

Hooks are argv arrays for project-owned commands, invoked with `hook <owner/repo> <name>`.
Keep paths, node IDs, credentials, and merge permissions in local config. Point personal
command entries at the canonical skill after rollout approval. First prove send, question
detection, and MERGE-READY dry-run handling on the private socket.
