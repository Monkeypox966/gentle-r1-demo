#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/home/mapinxuan/.local/opt/node-v24.22.2-linux-x64/bin:$PATH"
unit="gentle-r1-web-$(date +%Y%m%d-%H%M%S)-$RANDOM"
exec systemd-run --user --unit="$unit" --wait --pipe --collect \
  --property=MemoryMax=6G --property=MemoryHigh=5G --property=MemorySwapMax=0 \
  --property=CPUQuota=200% --property=CPUAffinity=8,9 \
  --property='SystemCallFilter=~sched_setaffinity' --property=SystemCallErrorNumber=EPERM \
  --property=RuntimeMaxSec=1200 --property=TasksMax=256 \
  --setenv=PATH="$PATH" --setenv=OMP_NUM_THREADS=1 --setenv=OPENBLAS_NUM_THREADS=1 \
  --setenv=PYTHONDONTWRITEBYTECODE=1 --working-directory="$PWD" \
  /usr/bin/flock --nonblock /home/mapinxuan/gentle-r1/.cache/r1-training.lock "$@"
