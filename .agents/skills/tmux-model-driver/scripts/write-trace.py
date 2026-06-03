#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone


def main():
    if len(sys.argv) != 3:
        print("usage: write-trace.py <trace.jsonl> <event.json>", file=sys.stderr)
        sys.exit(1)

    trace_path = sys.argv[1]
    event = json.loads(sys.argv[2])
    event.setdefault("ts", datetime.now(timezone.utc).isoformat())
    os.makedirs(os.path.dirname(trace_path), exist_ok=True)
    with open(trace_path, "a", encoding="utf-8") as f:
      f.write(json.dumps(event, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
