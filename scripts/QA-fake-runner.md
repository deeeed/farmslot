# QA: Fake Runner E2E Validation

Hands-on manual validation. You'll dispatch a fake run through the gateway and watch it complete.

## Setup (one-time)

```bash
# 1. Create tmux session for the test slot
tmux new-session -d -s ff-1 -c "$(pwd)"

# 2. Start dev server (gateway + UI)
bash scripts/dev.sh > /tmp/farmslot-dev.log 2>&1 &

# 3. Wait and verify
sleep 3 && curl -sf http://localhost:7777/health
# Should print: {"status":"ok",...}
```

The `demo-ff-1` slot is already defined in `pool/farmslot-demo.json`. The gateway auto-bootstraps fleet status from pool configs on startup — no manual seeding needed.

## Dispatch a Fake Run

In a separate terminal:

```bash
node -e "
const ws = new (require('ws'))('ws://localhost:7777');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'req', id: '1', method: 'run.create',
    params: {
      project: 'farmslot-farm',
      flowType: 'dev',
      ticketOrPr: 'FARM-QA1',
      runner: 'fake',
      model: 'sonnet',
      slotId: 'demo-ff-1',
      skipPrepare: true,
    }
  }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'res') {
    console.log('Created:', m.ok ? m.payload?.run?.id?.slice(0,8) : m.error);
  }
  if (m.type === 'event' && m.event === 'RUN_UPDATED') {
    const r = m.payload?.run;
    if (r) console.log(r.status + (r.metrics?.outcome ? ' outcome=' + r.metrics.outcome : ''));
  }
});
"
```

Watch the output. Within ~30 seconds:

```
Created: ec5d3314
slot-finding
task-writing
dispatching
monitoring
done outcome=success          <-- THIS IS THE GOAL
```

## Manual Checks

While the run is in progress or after it completes:

### A. Watch the fake runner in tmux

```bash
tmux attach -t ff-1
```

You should see output like:

```
[fake-runner] scenario=success steps=3 delay=500ms
[fake-runner] [1/3] - [x] Step 1: Initialize project
[fake-runner] [2/3] - [x] Step 2: Run tests
[fake-runner] [3/3] - [x] Step 3: Generate report
[fake-runner] Signal written: success
```

Detach with `Ctrl+B D`.

### B. Check SIGNAL.json was written

```bash
# Find the task dir (check gateway log)
TASK_DIR=$(grep 'copied task files' /tmp/farmslot-dev.log | tail -1 | awk '{print $NF}')
cat "$TASK_DIR/SIGNAL.json"
```

Expected:

```json
{ "status": "complete", "outcome": "success", "timestamp": "..." }
```

### C. Check TASK.md checkboxes are ticked

```bash
cat "$TASK_DIR/TASK.md" | grep '\[x\]'
```

All steps should show `[x]`.

### D. Check the launch command was correct

```bash
grep 'launchCommand' /tmp/farmslot-dev.log
```

Should contain `npx farmslot fake-runner --task-dir ... --scenario success --step-delay-ms 500`.
Must NOT contain `claude`, `codex`, or `dispatch_cmd`.

### E. Check no readiness polling happened

```bash
grep -c 'Waiting for agent ready' /tmp/farmslot-dev.log
```

Should be `0`. The fake runner is exec-mode — no Claude prompt detection needed.

### F. Query final run state

```bash
node -e "
const ws = new (require('ws'))('ws://localhost:7777');
ws.on('open', () => ws.send(JSON.stringify({type:'req',id:'1',method:'run.list',params:{limit:1}})));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== 'res') return;
  const r = m.payload?.runs?.[0];
  if (!r) { console.log('No runs'); ws.close(); return; }
  console.log('status:     ', r.status);
  console.log('outcome:    ', r.metrics?.outcome);
  console.log('runner:     ', r.metrics?.runner);
  console.log('promptSent: ', r.steps?.find(s=>s.name==='dispatch')?.outputs?.promptSent);
  console.log('');
  r.steps?.forEach(s => console.log('  ' + s.name.padEnd(14) + s.status));
  ws.close();
});
"
```

Expected:

```
status:      done
outcome:     success
runner:      fake
promptSent:  false

  find-slot     done
  write-task    done
  prepare       done
  dispatch      done
  monitor       done
  self-review   done
  complete      done
  human-gate    done
  finalize      done
  ci-watch      done
```

## Cleanup

```bash
kill $(lsof -ti :7777) 2>/dev/null
tmux kill-session -t ff-1 2>/dev/null
```

## Pass / Fail

- [ ] Run reaches `status: done`, `outcome: success`
- [ ] tmux pane shows fake-runner stepping through checkboxes
- [ ] SIGNAL.json written with `outcome: success`
- [ ] TASK.md has all `[x]` checkboxes
- [ ] Launch command is `npx farmslot fake-runner`, not claude/codex
- [ ] No "Waiting for agent ready" in logs (no readiness polling)
- [ ] `promptSent: false` in dispatch step output
