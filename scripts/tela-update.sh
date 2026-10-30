#!/usr/bin/env bash
# Simple driver for syncing, building, and packaging tela-zen.
#
# Runs quietly by default: full raw output (which is extremely noisy -
# thousands of compiler warning lines) goes to a log file, not the
# terminal. Only a one-line status per step is printed, plus the tail of
# the log if a step fails. Run tela-watch.sh in another terminal to follow
# progress with the noise filtered out instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/build/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TAIL_LINES=40

# This host has repeatedly frozen hard (unresponsive, needing a power-cycle)
# during full builds - not an OOM-kill, a freeze, which points at memory
# pressure the kernel's OOM-killer never resolves in time. Running the heavy
# steps in their own cgroup scope with a hard memory ceiling means the BUILD
# gets killed if it goes over, not the desktop. Adjust if you have more RAM.
BUILD_MEM_CAP="15G"
cgroup_wrap() {
  if command -v systemd-run >/dev/null 2>&1; then
    # bash -c, not a bare command list: the wrapped commands use shell
    # syntax (cd ... &&), and systemd-run's argv after -- execs directly
    # rather than going through a shell.
    printf 'systemd-run --user --scope -p MemoryMax=%s -p MemoryHigh=%sG -- bash -c %q' \
      "$BUILD_MEM_CAP" "$((${BUILD_MEM_CAP%G} - 2))" "$1"
  else
    echo "$1"
  fi
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [step...] [options]

Steps (default: all, in order): sync build package
  sync      npm run sync:raw     - pull the latest Firefox/Zen source
  build     npm run build        - full compile
  faster    mach build faster    - repackage chrome JS/CSS/XHTML only,
                                    no C++/Rust recompile (seconds, not
                                    minutes). Use this instead of "build"
                                    when you only touched src/**/*.{css,js,
                                    mjs,xhtml} - not part of the default
                                    step set, pass it explicitly.
  package   npm run package      - produce the distributable

Options:
  -v, --verbose   also stream raw output to the terminal, not just the log
  -h, --help      show this help

Logs always go to: $LOG_DIR/<step>-$STAMP.log
EOF
}

VERBOSE=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    sync|build|faster|package) SELECTED+=("$arg") ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done
if [ ${#SELECTED[@]} -eq 0 ]; then
  SELECTED=(sync build package)
fi

run_step() {
  local step="$1" cmd="$2"
  local log="$LOG_DIR/${step}-$STAMP.log"
  local start end status

  echo "==> $step"
  start=$(date +%s)

  if [ "$VERBOSE" -eq 1 ]; then
    ( cd "$ROOT" && eval "$cmd" ) 2>&1 | tee "$log"
    status=${PIPESTATUS[0]}
  else
    ( cd "$ROOT" && eval "$cmd" ) >"$log" 2>&1
    status=$?
  fi

  end=$(date +%s)

  if [ "$status" -eq 0 ]; then
    echo "==> $step done ($((end - start))s) - log: $log"
  else
    echo "==> $step FAILED (exit $status) - log: $log"
    echo "--- last $TAIL_LINES lines ---"
    tail -n "$TAIL_LINES" "$log"
    exit "$status"
  fi
}

for step in "${SELECTED[@]}"; do
  case "$step" in
    sync)    run_step sync    "npm run sync:raw" ;;
    build)   run_step build   "$(cgroup_wrap "npm run build")" ;;
    faster)  run_step faster  "$(cgroup_wrap "cd engine && ./mach build faster")" ;;
    package) run_step package "npm run package" ;;
  esac
done

echo "All done."
