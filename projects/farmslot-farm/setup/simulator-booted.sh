#!/bin/sh
set -eu

inventory=$(xcrun simctl list devices -j 2>/dev/null)
printf '%s\n' "$inventory" |
  jq -e --arg simulator "$1" 'any(.devices[][]?; .state == "Booted" and (.name == $simulator or .udid == $simulator))' >/dev/null
