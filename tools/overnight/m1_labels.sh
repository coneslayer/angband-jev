#!/bin/bash
# M1 rollout labels for a selection made by m1_select.py (docs/plan-2026-11-09.md).
#
# Usage: tools/overnight/m1_labels.sh LABEL_DIR [STEPS]
#   STEPS (default "check-long check-sticky check-short train-short train-sticky"), any of:
#     check-long    check.jsonl, 8 paired seeds, 2,000 actions, single override
#     check-sticky  the first 200 of check.jsonl, the same, sticky (the option at every occurrence: ROLLOUT_STICKY=1)
#     check-short   check.jsonl, 4 seeds, 500 actions (to compare with the long labels)
#     train-short   train.jsonl, 4 seeds, 500 actions, single override
#     train-sticky  train.jsonl, 4 seeds, 500 actions, sticky (the labels to train on: single labels proved blunt)
# Env: SERVERS (default 12 on 7800-7811), C_BIN (default angband-c build-rd), NODE_BIN (a dir with node >= 20).
# Every step runs with full play rules in rollouts (ROLLOUT_FULL_RULES=1) and utility "game" (levels gained − 3 if
# dead). A 3-record preflight runs first and stops everything if any record comes back unlabelled (a relative path or
# a restore that doesn't take shows up there, not after hours of empty labels).
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"
L=$(cd "$1" && pwd)  # absolute: rollout C games run with their cwd in the binary's folder
STEPS=${2:-"check-long check-sticky check-short train-short train-sticky"}
[ -n "${NODE_BIN:-}" ] && export PATH="$NODE_BIN:$PATH"
SV=${SERVERS:-$(seq -s, -f "http://127.0.0.1:%g" 7800 7811)}
CB=$(realpath "${C_BIN:-/home/mph/src/angband-c/build-rd/game/angband}")
node_modules/.bin/esbuild tools/busho-player.ts --bundle --platform=node --format=esm --outfile="$L/p.mjs" --log-level=error \
  "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" || exit 1

lab() {  # name decisions K horizon sticky
  local name=$1 dec=$2 k=$3 h=$4 st=$5
  echo "== $name $(date)"
  ROLLOUT_FULL_RULES=1 ROLLOUT_STICKY=$st BUSHO_TMP="$L/tmp-$name" DECISION_LOG= DANGER_LOG= nice node_modules/.bin/tsx tools/rollout/run.ts \
    --decisions "$dec" --dir "$L" --out "$L/$name.jsonl" --servers "$SV" --k "$k" --k-min "$k" --utility game \
    --horizon "blind=$h,fight=$h,tactic=$h,recall=$h,descend=$h,explore=$h" --checkpoints 150,500 \
    --player-cmd "node $L/p.mjs" --c-tmp "$L/c-$name" --c-bin "$CB" > "$L/$name.log" 2>&1
  tail -1 "$L/$name.log" | cut -c1-200; rm -rf "$L/c-$name" "$L/tmp-$name"
}

head -3 "$L/check.jsonl" > "$L/preflight-in.jsonl"
rm -f "$L/preflight.jsonl" "$L/preflight.unlabelled.jsonl"
lab preflight "$L/preflight-in.jsonl" 2 300 0
if [ -s "$L/preflight.unlabelled.jsonl" ] || [ ! -s "$L/preflight.jsonl" ]; then echo "PREFLIGHT FAILED"; exit 1; fi
head -200 "$L/check.jsonl" > "$L/check200.jsonl"
for s in $STEPS; do
  case $s in
    check-long)   lab check-long   "$L/check.jsonl"    8 2000 0 ;;
    check-sticky) lab check-sticky "$L/check200.jsonl" 8 2000 1 ;;
    check-short)  lab check-short  "$L/check.jsonl"    4 500 0 ;;
    train-short)  lab train-short  "$L/train.jsonl"    4 500 0 ;;
    train-sticky) lab train-sticky "$L/train.jsonl"    4 500 1 ;;
    *) echo "unknown step $s"; exit 1 ;;
  esac
done
echo "labels done $(date)"
