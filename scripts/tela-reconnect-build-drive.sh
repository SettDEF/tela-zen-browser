#!/usr/bin/env bash
# The build tree lives on a loop-mounted ext4 image (tela-zen-build.img) on
# nuke9100, connected via qemu-nbd because that drive is NTFS/FUSE and the
# kernel loop driver can't attach to a file on a FUSE filesystem. None of
# this survives a reboot - the nbd connection and mount have to be redone
# each time, and a hard freeze/crash can leave the ext4 filesystem dirty
# enough that a plain mount refuses ("can't read superblock"). This handles
# both automatically: connect, try to mount, and if that fails, fsck then
# retry - one command, one sudo prompt.
set -uo pipefail

IMG="/mnt/nuke9100/dev/projects/tela-zen-build.img"
MNT="/mnt/nuke9100/dev/projects/tela-zen-build"
DEV="/dev/nbd0"

if findmnt "$MNT" >/dev/null 2>&1; then
  echo "Already mounted: $MNT"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Re-running as root (one sudo prompt for the whole sequence)..." >&2
  exec sudo "$0" "$@"
fi

modprobe nbd

if [ ! -b "$DEV" ] || [ "$(cat /sys/class/block/nbd0/size 2>/dev/null || echo 0)" = "0" ]; then
  qemu-nbd --connect="$DEV" --format=raw "$IMG"
  # give the kernel a moment to register the device
  for _ in 1 2 3 4 5; do
    [ "$(cat /sys/class/block/nbd0/size 2>/dev/null || echo 0)" != "0" ] && break
    sleep 1
  done
fi

if mount "$DEV" "$MNT" 2>/tmp/tela-mount-error.log; then
  echo "Mounted cleanly:"
  findmnt "$MNT"
  exit 0
fi

echo "Mount failed, likely a dirty filesystem from an unclean shutdown - running fsck:"
cat /tmp/tela-mount-error.log >&2
e2fsck -fy "$DEV"
FSCK_STATUS=$?

# e2fsck exit codes: 0=clean, 1=errors fixed, 2=errors fixed+reboot suggested
# (irrelevant here, this isn't the root fs), >=4=fsck could NOT fix it
if [ "$FSCK_STATUS" -ge 4 ]; then
  echo "fsck could not repair $DEV (exit $FSCK_STATUS) - filesystem may need to be recreated." >&2
  exit 1
fi

if mount "$DEV" "$MNT"; then
  echo "Mounted after repair:"
  findmnt "$MNT"
else
  echo "Still won't mount after fsck - something worse is wrong." >&2
  exit 1
fi
