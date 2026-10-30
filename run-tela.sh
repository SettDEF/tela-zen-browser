#!/usr/bin/env bash
exec env MOZ_ENABLE_WAYLAND=1 "/mnt/storage/dev/projects/tela-zen/engine/obj-x86_64-pc-linux-gnu/dist/bin/zen" --no-remote -profile "$HOME/.tela-zen-profile" "$@"
