#!/usr/bin/env bash
# Companion to tela-update.sh - follows the newest (or a given) log and
# prints a cleaned view: strips color codes, drops the repetitive
# "N warning(s) generated." noise, and tags real errors/warnings so
# they're easy to spot without reading raw build output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/build/logs"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  -e, --errors-only   only print lines that look like errors/failures
  -f, --file PATH     watch a specific log instead of the newest one
  -h, --help          show this help

With no options, follows whichever log in $LOG_DIR was written to most
recently (i.e. whatever tela-update.sh is currently running).
EOF
}

ERRORS_ONLY=0
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -e|--errors-only) ERRORS_ONLY=1; shift ;;
    -f|--file) FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$FILE" ]; then
  FILE="$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)"
  if [ -z "$FILE" ]; then
    echo "No logs in $LOG_DIR yet - run tela-update.sh first." >&2
    exit 1
  fi
fi

echo "Watching: $FILE"
echo "(Ctrl+C to stop - the build/sync keeps running either way)"
echo

tail -n0 -F "$FILE" \
  | sed -u 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
  | grep -v -E '^([0-9: ]*W )?[0-9]+ warnings? generated\.$' \
  | awk -v errors_only="$ERRORS_ONLY" '
      /[Ee]rror|ERROR|FAILED|[Ff]atal/ { print "[ERROR] " $0; next }
      /warning|Warning|WARN/ { if (!errors_only) print "[warn]  " $0; next }
      { if (!errors_only) print $0 }
    '
