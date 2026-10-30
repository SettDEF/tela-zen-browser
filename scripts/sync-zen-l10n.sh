#!/usr/bin/env bash
# Copy Zen's own en-US .ftl files into the Firefox source tree so the build
# packages them.
#
# WHY THIS EXISTS
# ---------------
# browser.xhtml declares ~30 Fluent resources, nine of them Zen-specific
# (zen-workspaces, zen-general, zen-folders, ...). Those live in `locales/` but
# nothing copies them into `engine/browser/locales/en-US/browser/`, which is
# where `browser/locales/jar.mn` packages from via `browser (%browser/**/*.ftl)`.
#
# If even ONE declared .ftl is missing, Fluent's bundle generation for the whole
# document fails and EVERY label in the main window renders blank — app menu,
# context menus, about:preferences. It looks like a catastrophic theme bug; it
# is not. (about:addons keeps working, because it doesn't load those files.)
#
# Run this after `surfer download` / `surfer import` / `npm run init`, which
# regenerate `engine/` and drop the files again. Idempotent — safe to re-run.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/locales/en-US/browser/browser"
dst="$root/engine/browser/locales/en-US/browser"

if [[ ! -d "$src" ]]; then
  echo "error: no locale source at $src" >&2
  exit 1
fi
if [[ ! -d "$dst" ]]; then
  echo "error: no engine tree at $dst — run 'npm run download' first" >&2
  exit 1
fi

cp -f "$src"/zen-*.ftl "$dst/"
count=$(ls -1 "$dst"/zen-*.ftl | wc -l)

if [[ -f "$src/preferences/zen-preferences.ftl" ]]; then
  mkdir -p "$dst/preferences"
  cp -f "$src/preferences/zen-preferences.ftl" "$dst/preferences/"
fi

echo "synced $count zen *.ftl -> ${dst#"$root"/}"

# A loose (unpackaged) build serves straight from dist/, so refresh it too when
# one is present — otherwise the running binary keeps the stale set.
obj="$root/engine/obj-x86_64-pc-linux-gnu/dist/bin/browser/localization/en-US/browser"
if [[ -d "$obj" ]]; then
  cp -f "$src"/zen-*.ftl "$obj/"
  if [[ -f "$src/preferences/zen-preferences.ftl" ]]; then
    mkdir -p "$obj/preferences"
    cp -f "$src/preferences/zen-preferences.ftl" "$obj/preferences/"
  fi
  echo "also refreshed the existing dist/ build"
fi
