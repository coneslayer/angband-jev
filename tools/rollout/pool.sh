#!/usr/bin/env bash
# Rollout server pool: N long-lived game servers (one game each; rollouts on one server are sequential).
#   tools/rollout/pool.sh start [N=8]   # containers ro-d-1..N on 127.0.0.1:3801..(3800+N)
#   tools/rollout/pool.sh stop          # remove all ro-d-* pool containers
#   tools/rollout/pool.sh urls [N=8]    # comma-separated URL list for run.ts --servers
# Settings that matter for restore: VANILLA=1 (no resupply on depth change, no free Pick).
# RACE/CLASS/STAT_FLOOR are irrelevant: /restore replaces the whole player (race/class/stats come from the snapshot).
# --seed only seeds the throwaway initial game; every rollout reseeds on /restore.
set -euo pipefail
ROOT="${ROOT:-/home/mph/src/angband-jev}"
IMAGE="${IMAGE:-angband-jev-game}"
BASE_PORT=3801
cmd="${1:-start}"; N="${2:-8}"
case "$cmd" in
  start)
    for i in $(seq 1 "$N"); do
      docker rm -f "ro-d-$i" >/dev/null 2>&1 || true
      docker run -d --name "ro-d-$i" -p "127.0.0.1:$((BASE_PORT + i - 1)):3000" -e VANILLA=1 \
        -v "$ROOT/packages/@angband/core/src:/app/packages/@angband/core/src:ro" "$IMAGE" \
        npx tsx packages/@angband/core/src/borg/ai-server.ts --port 3000 --seed 1 >/dev/null
    done
    for i in $(seq 1 "$N"); do
      for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$((BASE_PORT + i - 1))/health" >/dev/null && break; sleep 1; done
    done
    bash "${BASH_SOURCE[0]}" urls "$N" ;;
  stop) docker ps -aq --filter "name=^ro-d-" | xargs -r docker rm -f >/dev/null ;;
  urls) seq 1 "$N" | awk -v b="$BASE_PORT" '{printf "%shttp://127.0.0.1:%d", (NR>1?",":""), b+$1-1} END{print ""}' ;;
  *) echo "usage: $0 start|stop|urls [N]" >&2; exit 1 ;;
esac
