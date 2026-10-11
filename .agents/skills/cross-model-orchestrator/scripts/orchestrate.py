#!/usr/bin/env python3
"""Portable command entry point for long-running lane work."""

import argparse
import json
import sys

from common import load_config
import lanes
import lead
import review


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for module in (lanes, review, lead):
        module.add_parser(subparsers)
    args = parser.parse_args()
    config = load_config(args.config)
    if args.command == "review":
        module = review
    elif args.command in ("heartbeat", "merge-watch", "attention", "ready", "hook"):
        module = lead
    else:
        module = lanes
    result = module.dispatch(config, args)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
