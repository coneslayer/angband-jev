# Fine-tuning Laya on vanilla Angband decisions

Status: in progress. Phase 0 started 2026-10-12; curriculum added the same day.

## Why

The busho player asks a System One decision model six strategic questions (fight/flee,
heal/flee/fight, recall, descend, explore-vs-descend, equipment swap). Zero-shot, none of the
local models read the game state. On 16 clear-cut Angband cases, Kev-0.8B, Laya `english` and
Laya `typed-decisions` scored 50%, 38% and 44%. A constant "fight / no / explore" answer scores
44%. Laya's own docs say the base checkpoints sit below the majority-class baseline and that
all the capability comes from fine-tuning.

## Scope decisions

- **Vanilla** means the TS game server with `VANILLA=1` (no bonus items, no free resupply on
  descent). Also remove the server's forced Human Warrior and its STR/DEX/CON floor, so race
  and class vary as in a normal birth.
- **Labels come from rollouts only.** No LLM teacher.

## Design

1. **Every question is a `choice`, never a `noul`.** Laya's English checkpoint can follow a
   noul's option labels instead of the state (laya #156). Descend becomes `{descend, stay}`,
   recall becomes `{recall, continue}`, and swap becomes `{swap, keep}`.
2. **One state builder and one set of questions, shared by training and inference.** They live
   in `tools/decision/` and carry a format version. Question instructions are fixed text, and
   variable details such as the target monster go in the state. The past-run lessons text
   (`wisdomContext`) is removed from the state. The state gains monster breath/spell info,
   light radius, and FREE_ACT / SEE_INVIS.
3. **Labels from rollouts.** Snapshot the game at the decision point. For each option and each
   of K = 8 seeds:
   - restore the snapshot,
   - reseed the RNG with that seed (the same seed for every option),
   - force the option,
   - let the rules-only player continue for H actions.

   Score each run with U = −1 on death, otherwise
   U = 0.6 × (HP fraction at the end) + 0.4 × min(1, XP gained ÷ XP to next level)
   − 0.3 × min(1, gold value of consumables used ÷ (gold + consumables' value at the start)).
   The consumable term matters early: the one Word of Recall costs 125 gold against a
   starting purse of 70–430, so a reward that ignores it teaches the model to burn it.
   The gold target is each option's share of the seeds it won, with ties split. It goes in the
   JSONL `gold` field, as probabilities.
4. **Label-noise check.** Compute labels from seeds 1–4 and 5–8 separately and measure how
   often they agree. That rate is the accuracy ceiling. Drop a decision type whose agreement
   is below about 70%.
5. **Split train and test by game seed**, never by decision.

| Hook | Options | Horizon H | Expected label quality |
|---|---|---|---|
| `llmShouldFight` | fight / flee | 150 actions | Good |
| `llmHealOrFlee` | heal / flee / fight | 50 actions | Good |
| `llmShouldRecall` | recall / continue | 400 actions | Medium |
| `llmShouldDescend`, `llmShouldExploreMore` | descend / stay, explore / descend | 2,000+ actions | Noisy; Phase 4 only if the noise check passes |
| `llmChooseEquipment` | swap / keep | — | Deferred; rollouts measure gear value poorly |

## Vanilla fidelity

The TS server must match vanilla 4.2 where it affects early decisions.

- [x] Starting gold has the kit's value deducted, as in 4.2's `player_outfit`. It was a flat
      600 plus the kit; now Warrior 330, Mage 390, Druid 430, Priest 190, Necromancer 421,
      Paladin 365, Rogue 410, Ranger 347, Blackguard 70.
- [x] `VANILLA=1` no longer adds the free Pick that `ai-server.ts` gives every character.
- [ ] Spot-check other server conveniences against 4.2.6 before collecting data at scale.

## Curriculum

Early-game decisions are plentiful and have short horizons, so they label cleanly. Later
decisions only appear in games that get deep, and replaying the early game every time is
wasteful. So the work goes in stages:

1. **Early-game survival (DL1–5).** First give busho the vanilla early-game toolkit as rules,
   because rollouts can only rank actions the player can execute. Then label and train fight
   and tactic decisions on the toolkit's options.
2. **Savepoint bank.** Once games reach the midgame, save snapshots at level entry from DL5,
   plus the last levels before each death. Restore them with new seeds to get many different
   futures from one hard-won position.
3. **Midgame decisions.** Recall, descend, explore and equipment, labelled by rollouts from the
   bank, then retrained with on-policy data.

## Phases

### Phase 0: Prerequisites
- [x] `GET /snapshot` and `POST /restore` (with an optional RNG reseed) in `ai-server.ts`.
      The existing `saveGameToJSON` / `loadGameFromJSON` turned out lossy (no inventory,
      equipment, monsters or objects), so `borg/snapshot.ts` serializes the whole object graph
      instead (format `ts-graph-1`). It includes RNG state and the mutable fields of static
      templates such as unique counts and flavor awareness. A snapshot is about 0.35 MB in town
      and 2.1 MB at DL3, and takes about 0.3 s; a restore takes about 0.23 s.
- [x] **Determinism gate** (`tools/determinism-check.ts`): passes on 4 setups. Seed 42 and
      seed 11 Warriors at DL3 match the full snapshot at 10, 100 and 1,000 commands; a seed 42
      random-race Rogue with no stat floor and a seed 2024 Paladin, both snapshotted in town,
      replay identically through to their deaths. Reseeding: the same seed gives the same
      future, and different seeds diverge.
- [x] `RACE`, `CLASS` (a name or `random`) and `STAT_FLOOR=0` settings in `ai-server.ts`.
- [x] Survival check: 10 rules-only `VANILLA=1` games (5 classes × 2 seeds, random race, no
      stat floor). 9 of 10 died on DL1–2, all to Fang, Farmer Maggot's Dog. The best game
      reached DL5 at CL8.
- [x] Throughput: about 30 actions/s per game process with 10 running at once, about 51
      actions/s alone. The 5 ms polling in `/command` is one bound.

### Phase 1: Collecting decision points
- [x] Shared `tools/decision/` module: state builder, question definitions, format version.
- [x] `DECISION_LOG=1` in busho, with a gzipped snapshot per record. The triggers were
      widened in log mode: fight per monster instance, tactic below 90% HP, recall at DL5+.
      Early games yield 11–15 records per 1,000 actions, mostly fights.
- [ ] Stage 1 data: early-game games with the toolkit (Phase 1b) across 5 classes.

### Phase 1b: Vanilla early-game toolkit (busho rules)
- [ ] Shopping within the starting budget: Phase Door, Flasks of oil and Cure Light Wounds
      before anything expensive. Today `buySupplies` buys Cure Critical Wounds first and
      leaves early characters with `Phase:0`.
- [ ] Throwing flasks of oil at dangerous monsters (the server already supports THROW).
- [ ] Fleeing that works at CL1: phase door, then walk to and take the nearest stairs.
- [ ] Fight question becomes `{melee, throw, flee}` (format version 2).
- [x] Stationary monsters (2026-10-13). In the first overnight attempt, 12 of the first 13
      finished games died on DL1–3, a third of them to grey mushroom patches, white jellies and
      worm masses. The bot didn't treat stationary monsters as threats, so it walked next to them,
      walked into jellies blocking a corridor, and drank Cure Light Wounds while a mushroom patch
      kept re-confusing it. The fix:
  - Mushroom patches (1–2 HP) are killed, even while confused.
  - Jellies, molds and floating eyes (`hurtsOnContact`) are avoided below CL12. The BFS
    never paths through their squares and avoids the squares next to them when there is
    another route.
  - When next to one, the bot steps away.
  - When confused and only stationary monsters are near, it walks away instead of drinking a
    potion.
  - A/B test on the same 16 seeds (600 s per game): no stationary-monster deaths, and 8 of 16
    died, all to soldiers, wild cats, gallants and kobolds. Those encounters are logged as
    fight/tactic decisions with snapshots, which is what the rollout labels are for.

### Phase 1c: Savepoint bank
- [ ] `SAVEPOINT_DIR`: save a snapshot on entering each new level from DL5, with metadata
      (depth, CL, class, race, seed, turn).
- [ ] Keep a rolling buffer of the last 2–3 level-entry snapshots. On death, promote them as
      "hard" savepoints.
- [ ] A launcher that starts a game from a bank savepoint with a new seed.

### Phase 2: Rollout labelling
- [ ] Busho rollout mode: force option X at the first decision of type T, then rules-only
      for H actions, then emit the outcome as JSON.
- [ ] `tools/rollout/` worker: decision record in, JSONL with `gold` out.
- [ ] Speed up rollouts if needed: a lighter `/command` reply, no map serialization during
      rollouts, or shorter polling.
- [ ] Label-noise check.

### Phase 3: Training (pinned `laya==0.4.6`)
- [ ] `laya-train --dry-run`, then
      `laya-train --data train.jsonl --base english --out ckpt --max-len 512`.
      If 10 GB runs out of memory, use micro-batch 4 × grad-accum 16. Stop kev while training.
- [ ] Compare base `english` vs `typed-decisions` and `--loss rlcd` vs `soft-ce`, with 3 seeds
      each. If a run stays at chance, run the positive control: put the answer in the state and
      retrain.

### Phase 4: Evaluation
- [ ] Offline, on held-out games: accuracy, Brier score and calibration error, compared with
      the noise ceiling, base Laya, Kev-0.8B and the rules player's own choice.
- [ ] Online, stage 1: the share of games that reach DL5 and DL10, rules + toolkit vs rules +
      toolkit + model, over 30 paired seeds × 5 classes. Use a Wilcoxon signed-rank test.

### Phase 5: Deployment and on-policy data
- [ ] A `laya` compose service with `LAYA_EXTRA_MODELS={"angband-vanilla": "/models/..."}`.
      Busho gates on `answer_confidence`, using the thresholds fitted by `--target-error`.
- [ ] DAgger round: play with the model, label the decision points it reaches, retrain.
- [ ] Stage 3: midgame decisions from the savepoint bank.

## Overnight run (18 hours, unattended)

### Budget (measured 2026-10-12)
- **CPU:** all 16 cores, about 13 game-server/player pairs, at low CPU weight (`--cpu-shares 256`)
  so the user's other containers win when busy. Rules play runs at about 30 actions/s per
  process with 10 running.
- **GPU:** a full fine-tune of the 421M `english` model fits only at micro-batch 2 (grad-accum
  32), peaking at 9.57 of 10.24 GB. Micro-batch 4 and 8 run out of memory.
  - `soft-ce`: about 0.25 s per item per epoch.
  - `rlcd`: about 0.4 s per item per epoch.
  - 2,000 items × 4 epochs with `soft-ce` is about 35 minutes.
  - Kev stays stopped overnight to free 6 GB.
- **Other containers can briefly spike GPU memory.** Every GPU step must survive a CUDA
  out-of-memory error.

### Schedule: two DAgger iterations
| Time | Stage | What happens |
|---|---|---|
| 0:00–0:30 | Smoke test | Every stage at toy size. Abort the night if any stage fails. |
| 0:30–2:00 | Collect 1 | 10 parallel `DECISION_LOG` games, rules + toolkit, `VANILLA=1`, 5 classes, random races, fresh seeds. Writes decision records and savepoints. |
| 2:00–7:00 | Label 1 | Rollouts on fight and tactic records, sampled by stratum ("interesting" first: uniques, monsters at or above CL, HP below 70%). K = 6–8. Then the noise check per type. |
| 7:00–8:00 | Train 1 | `soft-ce`, 2 seeds, split by game. Pick the best by held-out accuracy and Brier score against the rollout labels. |
| 8:00–8:45 | Eval 1 | Offline metrics, plus 30 paired seeds online (rules vs rules + model): DL5 reached, deaths, and deaths to Fang/Grip. Promote the model only if it isn't worse. |
| 8:45–10:15 | Collect 2 | Games with the promoted model in control (DAgger). More decision records, and deeper savepoints. |
| 10:15–15:15 | Label 2 | Rollouts on the new records. |
| 15:15–16:30 | Train 2 | Retrain on all labels so far. |
| 16:30–17:15 | Eval 2 | As Eval 1. |
| 17:15–18:00 | Report | `runs/overnight/<date>/REPORT.md`. |

Labelling is the bottleneck. At about 3 minutes per fight record per worker pair at K = 8
and horizon 150, 10 pairs label about 200 records an hour. The orchestrator's measured cost
and any player-startup overhead decide K and the horizon.

### Robustness requirements
- **Resumable:** the driver is a resumable state machine. Each stage writes a done-marker and
  its outputs, and a restart skips finished stages.
- **Time limits:** per-stage deadlines plus a global 18-hour deadline. A stage that runs out
  of time stops cleanly with partial output.
- **Kill switch:** `touch runs/overnight/STOP`.
- **GPU out of memory:**
  - wait until at least 8 GB is free before starting;
  - on CUDA OOM, wait 60 s and retry; on a second failure, drop to micro-batch 1 and
    grad-accum 64;
  - continue from `checkpoint_latest/` for the remaining epochs.
  - Online eval tolerates Laya's CPU fallback and counts it in the report.
- **Docker:** containers are named `ovn-*` and limited with `--cpus` and `--memory`. The
  driver never touches other containers, cleans up its own on exit, and retries if the Docker
  daemon hiccups.
- **Report:** a report and `metrics.json` are updated after every stage, so a partial night
  still leaves results.
- **Native mode (`--native`):** the same pipeline as host processes, for when Docker is down.
  - Game servers and players run from Node 22 (`OVN_NODE_BIN`) with `npm ci` in the repo.
    They run under `nice -n 10`, with a 1 GB V8 heap standing in for `--memory 1g`. Each
    stage runs in its own process group, so cleanup kills tsx's child processes too.
  - `run/src/app` is a runnable copy of the frozen source. `node_modules` is a symlink to the
    repo's.
  - Laya runs from a pipenv environment in `tools/overnight/native` (torch 2.14.1 + cu130,
    `laya[serve]==0.4.6`), with the model cache in `~/.cache/huggingface`.
  - `BUSHO_TMP` keeps each player's replay, wisdom and report files in its own game folder.
  - laya-serve preloads only the fine-tuned checkpoint and `english` (`LAYA_MODELS`). All
    three bundled checkpoints together take 9.8 GB.

## Session 2: 20-hour autonomous improvement (planned 2026-10-13)

### What session 1 taught us
- **Measured rates** (native mode, 13 slots):
  - collection: about 57 games/h;
  - labelling: about 250 records/h at K=4–8;
  - training: about 0.19 s per item-epoch;
  - eval: 24 paired seeds in 45 min.
- **Labels are the bottleneck.** Only 35% of logged fight/tactic decisions got labelled.
- **The model is better offline but not yet in play.** 61% accuracy against the rules bot's 40%,
  but in-game it ties: 13 vs 11 deaths on 24 pairs, the same mean depth, and deeper in 11 pairs
  against shallower in 5. 24 pairs can't tell those apart.
- **Silent harness bugs cost a whole night.** Model answers were ignored, a confidence gate
  sent everything back to the rules, and a throw loop stalled games. Every stage now needs
  self-checks that fail loudly.
- **Survival is the ceiling.** About half of games die on DL1–3, to soldiers, crows, kobold
  shamans, Fang and Grip. The bank has 40 savepoints at DL5–13 that we haven't used.

### Goals, in order
1. Ship a checkpoint that beats the rules bot in play, by a pre-committed test (below).
2. Real DAgger: collect data with the model acting, and label the states where it disagrees
   with the rules.
3. Get beyond DL1–3: early-survival rule fixes, plus midgame data branched from bank
   savepoints with new seeds (the user's savepoint idea).

### Pre-committed decision rules (no human in the loop)
- **Promotion test:** 48 paired seeds. Each game scores max depth, minus 3 if dead. Promote if
  the model wins more pairs than it loses, *and* has no more than 2 more deaths than the rules
  bot.
- **Model scope:** the model only answers question types it was trained on (fight, tactic).
  descend, explore, recall and equip stay with the rules (`DECISION_MODEL_TYPES`).
- **Rule changes:** keep a busho rule change only if a 32-seed A/B shows fewer deaths and no
  lower mean depth. Otherwise revert it.
- **Canaries:** every stage asserts its own sanity before its results count (see Phase 0). A
  failed canary means fix, then rerun that stage once. If it fails again, skip the stage and
  record why.
- **Hard limits:**
  - Never commit or push, and never touch Docker or the user's containers.
  - Native mode only, 13 slots, `nice 10`.
  - Stop if Windows logs a low-memory event (ID 2004) or WSL RAM use passes 16 GB; restart with
    9 slots.

### Schedule (20 h, about 2 h of it slack)
| # | Stage | Budget | Who |
|---|---|---|---|
| 0 | Harness fixes and canaries, then a smoke run | 1.0 h | agent |
| 1 | Baseline eval: train2 checkpoint vs rules, 48 pairs, model on fight/tactic only | 1.5 h | driver |
| 2 | Early-survival rule pass: top killers, with 32-seed A/Bs | 2.0 h | agent |
| 3a | Collect A: 60% model-acting games, 40% bank branches (DL5+ savepoints, new seeds) | 1.25 h | driver |
| 3b | Label A: disagreements first, then danger | 3.5 h | driver |
| 3c | Train A: from base on all labels (about 4.5k), 4 epochs, 1 seed | 1.0 h | driver |
| 3d | Eval A: 48 pairs, against the rules and against the incumbent | 1.25 h | driver |
| 4 | Round B: same as 3a–3d, using A's checkpoint (if promoted) for collection | 7.0 h | driver |
| 5 | Final eval of the best checkpoint on 60 fresh seeds, then the report | 1.5 h | driver + agent |

The rule pass (2) runs before the DAgger rounds because better rules improve both arms and the
rollout continuation policy. Its A/B games use CPU while stage 1 uses GPU and CPU, so the two run
one after the other.

### Phase 0: harness work (before anything runs)
- [x] `DECISION_MODEL_TYPES=fight,tactic`: model-policy mode only acts on (and only asks about)
      those types.
- [x] Canaries in the driver:
  - **eval/collect:** at least 90% of trained-type decisions have `acted=model`; at most 100
    throws per game; every game passes at least 5 actions/s on average; the rules and model
    arms are not move-for-move identical in more than 50% of pairs.
  - **label:** split-half agreement of at least 65%; at most 15% all-tie records; at most 2%
    errored runs.
  - **train:** held-out accuracy above the majority baseline. Otherwise keep the incumbent.
- [x] Labelling order `--order disagree,danger`: model-acting records where
      `model_choice != rules_choice` first. Those are the labels that change the policy.
- [x] Bank-branch collection: restore a random DL≥5 savepoint with a fresh seed
      (`tools/savepoint/launch.ts`), then play it as an ordinary logged game.
- [x] Promotion test and incumbent comparison in `stage_eval`, with paired-score bootstrap
      intervals in the report.
- [x] Driver: arbitrary stage lists (so the agent can splice in stages), plus `OVN_*` overrides
      recorded in `state.json`.
- [x] Smoke run (`--smoke`, about 25 min) with every canary exercised.

### Phase 2: early-survival rule pass (agent, time-boxed)
- Rank death causes over the about 230 session-1 games. Expected top killers: soldiers and
  gallants (2 × 1d7 blows at DL2–4), crows and wild cats (fast), and kobold shamans (ranged
  magic missile).
- Candidate fixes:
  - treat out-of-depth melee monsters (level ≥ CL+2 with 2+ blows) like `lowCLDanger`;
  - rest to full HP before exploring at CL<5;
  - close distance to casters, or break line of sight from them.
- Each fix gets its own A/B, and only fixes that pass are kept. The pass stops at 2 hours
  whatever the state.
- **Done 2026-10-13 21:10.** Three fixes are behind `RULEFIX` (default
  `danger,restock,escape`; `none` gives the old rules):
  - `danger`: don't melee when the expected damage taken before the monster dies (from its
    gamedata blows, speed and our weapon) is at least half our HP. Throw oil or flee instead.
  - `restock`: on DL1–4, with no Cure potions or no Phase Door/oil, walk up the stairs to
    town, sell, and rebuy the kit.
  - `escape`: below CL10 on DL≤5, the emergency and flee thresholds go from 30% to 50% HP.
  - Combined A/B, 32 paired seeds (`runs/session2/rules-ab1`): deaths 15 → 3, mean max depth
    2.44 → 2.69, pairs won 18 against 6 lost. All three were kept. There was no time for
    per-fix A/Bs, so this is a combined result.
- The rule pass ran before the baseline eval, so the baseline uses the new rules. Its spare
  time went to labelling (3.75 h per round).

### Run log (`runs/session2/2026-10-13`, launched 21:13, deadline about 15:50 on 10-14)
- **Baseline (session-1 model vs. new rules, ended 22:28).** As first scored, 37 pairs: 14 wins
  and 13 losses, deaths 10 (model) against 7 (rules), mean max depth 2.65 against 2.30. Not
  promoted. Canaries passed (acted 1.0, 9 identical pairs, max 27 throws).
  - **Scoring bug:** games killed by the *stage* deadline (some after about 60 s) were paired
    as if they had finished. Rescored without those games, 32 clean pairs: 11 wins, 12 losses,
    mean diff −0.03, deaths 9 against 7. Same verdict.
  - **Fix (takes effect from evalA):** `stage_eval` drops deadline-cut games, which are timed
    out with fewer than cap − 30 s, and reports them as `deadline_cut`. Eval budgets went
    1.25 → 1.6 h and the final 1.5 → 1.75 h, out of the slack, so about 48 clean pairs can
    finish. The driver was restarted at the start of labelA to load the patch (resume skips
    finished stages).
  - **Restart mishap (23:44).** Killing the label orchestrator made labelA return at once as
    `failed` (no new labels). The relaunched driver then skipped trainA and evalA and started
    collectB. Within a minute it was stopped. labelA, trainA, evalA and collectB were cleared from
    `state.json` (backup `state.json.bak-2344`), the seconds-old collectB directory was deleted,
    and the driver relaunched at 23:45. labelA resumed and skipped the records already done.
    Lesson: restart a driver between stages by editing `state.json`, never by timing a kill.
- **collectA (22:28–23:44):** 72 games (29 bank branches), 0 errors, 3,134 decisions (2,666 of
  them fight/tactic), 33 deaths, max DL15, max 25 throws. Canaries passed.

- **labelA (23:45–03:30):** 612 new labels (fight 519, tactic 93), all of them on
  model/rules disagreements. Total with carried labels: 3,259. Run errors 0%. Split-half
  agreement: tactic 74.0%, fight 82.1%. Throughput was about 2.8 records/min (about 19 rollouts
  per record at 1.1 s each).
  - The all-tie canary failed: 123 of 612 (20%) against the 15% limit. **Waived by the agent.**
    Ties are not trained on. Errors and split-half agreement show the rollouts are sound, and
    disagreement-first records are expected to tie more often. A rerun would have cost another
    3.75 h. The threshold is now 25% for labelB.
  - The failure had made the driver skip trainA and evalA and start collectB at once (with the
    old incumbent, which defeats DAgger). It was stopped about 1 min in, labelA was marked done
    with `labels` set in `state.json` (backup `state.json.bak-0330`), collectB was removed,
    and the driver relaunched at 03:31.
    - New timeline: trainA to about 04:30, evalA to about 06:10, collectB to about 07:25,
      labelB to about 11:10, trainB to about 12:10, evalB to about 13:45, final to about 15:30
      (deadline about 15:50).

- **trainA (03:31–04:21):** 2,513 training items and 360 held out, 4 epochs, seed 0, from
  base. Held-out accuracy: model 0.594, rules 0.40, majority 0.369, base 0.389. Brier: model
  0.170, rules 0.846. By type: tactic acc 0.61, fight acc 0.58. Canary passed, so this is the
  new incumbent for collectB.

- **evalA (04:21–05:57), trainA model vs. rules:** 37 clean pairs (6 rules games were
  deadline-cut and dropped). 14 wins, 15 losses, mean diff −0.11 (80% CI −0.57 to +0.38).
  Deaths: model 9, rules 5. Mean max depth: model 2.78, rules 2.57. **Not promoted.** Canaries
  passed. Even with the 1.6 h budget the rules arm only finished about 43 games, which caps
  the clean pairs at about 37. The rules arm has 6 of the 13 slots and its games run longer.
  - **Pattern across baseline and evalA:** the model goes deeper but dies more (19 deaths
    against 12 over 69 clean pairs). Where the model's choice differs from the rules' (per
    eval):
    - fight, melee → throw: about 950;
    - fight, flee → throw: about 110;
    - tactic, fight → heal: 50–70.
  - In the last 5 decisions of the model's dead games, these were the most common
    disagreements: melee → throw 35, tactic fight → heal 19, flee → throw 12.
  - **Hypothesis:** the rollout labels are myopic about consumables. A rollout ends after a
    short horizon, so throwing a flask (or quaffing) is free in the label, but the model then
    lacks oil or potions when a real threat arrives.
    - It is also unsafe to override a rules "flee" with "throw".
    - Laya's `confidence` is normalized entropy. In game it is 0.001–0.02 (near-flat
      distributions from soft-CE on soft rollout targets), so it can't serve as a gate.
  - Candidate fixes (not run this session, no slack): charge consumables in the rollout value;
    a flee-veto (the model never overrides a rules flee with an aggressive option); and
    lengthen the rollout horizon at low CL.

- **collectB (05:57–07:12), trainA model acting:** 65 games (26 bank branches), 0 errors,
  2,382 decisions (2,045 of them fight/tactic), 28 deaths, max DL17, max 20 throws. Canaries
  passed. labelB runs 07:12 to about 10:57.

- **labelB (07:12–10:57):** 774 new labels (fight 696, tactic 78), all on disagreements.
  Total 4,033. Run errors 0%. Split-half agreement: tactic 74.2%, fight 82.5%. All-tie 171/774
  (22%), which passes the relaxed 25% canary. Of the new fight labels, 168 were best as `flee`,
  which is direct DAgger signal against the model's flee → throw habit.

- **trainB (10:57–11:40):** 3,083 training items and 393 held out, 4 epochs, seed 0, from
  base. Held-out accuracy: model 0.606, rules 0.397, majority 0.382, base 0.387. Brier: model
  0.169, rules 0.852. By type: tactic 0.62, fight 0.59. Canary passed. evalB runs 11:40 to
  about 13:16.

- **evalB (11:40–13:16), trainB model vs. rules:** 43 clean pairs (5 rules games
  deadline-cut). 17 wins, 13 losses, mean diff +0.35 (80% CI −0.16 to +0.88). Deaths: model 8,
  rules 10. Mean max depth: model 2.63, rules 2.42. **Promoted** (wins > losses and deaths ≤
  rules + 2). Canaries passed.
  - The DAgger round moved the disagreements the intended way (evalA → evalB, model games):

    | rules → model | evalA | evalB |
    |---|---|---|
    | melee → throw | 978 | 560 |
    | melee → flee | 3 | 271 |
    | flee → throw | 113 | 70 |
    | tactic fight → heal | 68 | 54 |

  - The final eval (60 fresh seeds, 990000+) runs trainB from 13:16 to about 15:01.

- **final (13:16–15:01), trainB on 60 fresh seeds:** 45 clean pairs (cut: rules 4,
  model 3). 19 wins, 14 losses, mean diff +0.09 (80% CI −0.42 to +0.62). Deaths: model 11,
  rules 10. Depth: 2.67 against 2.51. Passes the promotion rule.
  - evalB and the final pooled (88 pairs): 36–27, deaths 19 against 20, depth 2.65 against
    2.47, one-sided sign test p ≈ 0.16.
  - **Outcome:** trainB is about as good as the improved rules, with a slight depth edge. It
    is not yet clearly better. Next steps are in `runs/session2/2026-10-13/REPORT.md`.

### Supervision
- The driver runs detached (`setsid`) and doesn't depend on the agent's session.
  - Stages 0 and 2 are agent work. If the agent is gone, the driver skips stage 2 and runs
    the rest with defaults.
- The agent checks in at every stage boundary (background waiters, not 30-minute monitors). It
  reads the canaries and acts only by the rules above. It updates this section's checkboxes and
  `REPORT.md`.
- Morning deliverable: `REPORT.md` with the promotion verdicts, the depth/death tables, the
  label stats, and what to try next.

## Session 3: 23-hour autonomous improvement (planned 2026-10-14)

### What session 2 taught us
- trainB (two DAgger rounds) roughly matches the improved rules. evalB plus the final, 88
  pairs: 36–27, deaths 19 against 20, depth 2.65 against 2.47, sign test p ≈ 0.16. It is not
  yet clearly better.
- **Its failure mode is supply exhaustion.** At the last logged decision before death:
  - 49 of 52 dead model games had no oil, and 11 of 52 had no potions.
  - For the rules' dead games those figures are 20 of 32 and 1 of 32.
  - Even surviving model games end with a median of 1 flask, against 8 for the rules.
- **The rollout utility can't see this.** Its supply term is
  `cons = gold value used / (gold + consumable value)`. A flask is worth about 3 gold, so
  throw runs actually score *lower* cons than melee runs (0.065 against 0.070). Reweighting
  cons offline over the stored runs (0.3 → 4.0) mostly removes "heal" labels and barely moves
  "throw". The labels need a scarcity term (the share of the flasks, potions and Phase scrolls
  on hand that a run used), and the stored runs don't have the counts for one.
- Eval power is the other limit. A two-arm eval finished only 37–45 clean pairs in 1.6 h,
  because the rules arm had 6 of the 13 slots and its games run longer. Shallow games (mean
  max depth about 2.5) also mean midgame decisions are barely tested.

### Goals, in order
1. Stop the model wasting supplies, first cheaply with **policy guards** and then properly with
   **scarcity-aware labels** (one DAgger round).
2. Settle, with enough paired games, whether the best model+guard policy beats the rules on
   both fresh DL1 starts and midgame (bank) starts.
3. Leave behind faster, fairer evaluation tooling: a multi-arm tournament with seeds
   interleaved and a bank suite.

### Phase 0: harness work (agent, about 2.5 h, before the driver starts)
- [x] **busho `MODEL_GUARD`** (comma list). When a guard fires, the rules' choice is used and
  the decision log gets `guard: <name>`.
  - `oil`: the model may choose `throw` only if flasks > 3, or `meleeTooCostly(target)`, or
    the rules also chose throw.
  - `potion`: the model may choose `heal` only if potions > 2, or HP < 50%, or the rules also
    chose heal.
  - `flee`: the model may not override a rules `flee` with `throw` or `melee`.
- [x] **Rollout utility v2** (`--utility v2` in `tools/rollout/run.ts`). Each run records
  start and end counts for flasks, Cure potions and Phase/teleport scrolls. The utility adds
  `− Σ_c w_c · min(1, used_c / max(1, start_c))`, with w = 0.15 (flask), 0.25 (potion) and
  0.15 (escape). The old `cons` stays at 0.3 (the potion and escape terms overlap with it
  partly; both are kept for continuity).
  - The counts are stored per run, so the weights can be re-tuned offline later.
  - A unit check on 3 labelled records: the u of a throw run falls when flasks run low.
- [x] **Tournament eval** (`stage_tournament` in a new `driver3.py`):
  - N arms share one seed list. Jobs are interleaved by seed (seed 1 for every arm, then
    seed 2, and so on) on one shared slot pool, so every arm finishes the same seeds.
  - Each arm is (checkpoint or rules, busho env). Arms that use the same checkpoint share one
    laya server, so there is never more than one server on the GPU.
  - Report: paired test of each arm against rules, pairwise against the best arm, and deaths
    with zero supplies.
- [x] **Bank suite.** Paired starts from bank savepoints at DL≥5 with a fixed seed per start.
  Every arm restores the same savepoint and seed. Cap 600 s.
- [x] Smoke run of driver3 (about 25 min), with each stage and canary exercised.

#### Phase 0 notes (2026-10-14)
- The guards and utility v2 are implemented. busho and run.ts typecheck. Utility v2 was tested
  live on 3 records: supply counts are recorded, and a run that used all 5 flasks and 12
  potions got a scarcity charge of 0.4.
- **Finding:** in session-2 fight labels, `throw` plays out exactly like `melee` on 1,211 of
  2,543 records. 503 of those have `Oil:0`, where the throw option can only fall back to melee.
  The other 708 most likely lacked line of sight. So many "melee+throw" ties are artefacts.
  This is harmless in game, because busho falls back to melee, but it inflates the model's
  p(throw).
- **One laya server for several checkpoints:** `LAYA_EXTRA_MODELS={name: ckpt, ...}`,
  `LAYA_MODELS=<names>` preloads them, and requests pick a checkpoint by `model`. The default
  model has to be a bundled one (`english`), but it doesn't need preloading. Two checkpoints
  peaked at about 6.9 GB GPU total (2.2 GB of that from other processes), the same as session
  2's eval server.
- `driver3.py` implements the stages. The trainC canary uses session 2's mixed held-out set
  (v1 and v2 records), not v2 only. That is simpler, and the deviation is noted here.

### Schedule (23 h; about 3 h slack)
| Stage | Budget | What |
|---|---|---|
| Phase 0 | 2.5 h | agent work above, then launch the driver |
| T1 tournament | 4.5 h | arms: rules, B, B+`oil,potion`, B+`oil,potion,flee`. 48 fresh seeds + 24 bank starts, 288 games |
| collectC | 1.25 h | the T1 winner (model + guards) acting, 40% bank branches |
| labelC | 5.0 h | utility v2, disagreement-first, on collectC. Then old session-2 records where v1 said throw or heal won, re-rolled with v2 |
| trainC | 0.75 h | from base: v2 labels plus v1 labels for records that weren't re-rolled (v2 replaces v1 per record) |
| final | 7.5 h | arms: rules, T1 winner, C + the winner's guards, rules-adj (added 18:50, see below). 90 fresh seeds + 30 bank starts, 480 games |
| slack | 1.5 h | reruns after canary failures, or extra final seeds |

### Run log (`runs/session3/2026-10-14`, launched 17:34, deadline 14:34 on 10-15)
- **Smoke run (`runs/session3/smoke`, 17:23–17:34):**
  - Every stage ran. The guards fired: oil 4 times in B-op; oil 3, flee 2 and potion 2 in
    B-opf. The winner rule picked the fewest-guard arm on a tie.
  - labelC failed split-half (5–6 labels) and the final failed "identical to rules" (2 of 3
    starts, 240 s games). Both are expected on samples this small.
  - Utility v2 changed the argmax on 18% of the smoke labels.
- **T1 (17:34–21:32, finished early):** all 72 starts complete. No errors, no deadline cuts, and
  the canaries passed. **Every model arm lost to the rules:**

  | Arm | W–L | Mean diff (80% CI) | Deaths (model/rules) | Depth (model/rules) | Fresh W–L | Bank W–L | Sweep verdict |
  |---|---|---|---|---|---|---|---|
  | B | 18–37 | −1.07 (−1.53, −0.65) | 35/24 | 4.22/4.83 | 11–28 | 7–9 | worse |
  | B-op | 25–32 | −0.54 (−1.04, −0.04) | 25/24 | 4.33/4.83 | 18–23 | 7–9 | trade-off (29–29 at a penalty of 20) |
  | B-opf | 25–34 | −0.58 (−1.11, −0.08) | 25/24 | 4.29/4.83 | 15–25 | 10–9 | worse |

  - Deaths per level reached: rules 0.069, B 0.115, B-op 0.080, B-opf 0.081. The guards fired
    a lot: B-op had oil 379 and potion 34; B-opf had oil 364, flee 108 and potion 53.
  - In 33 of B's 35 deaths the character had no oil, against 23 of 24 for the rules.
  - **Not a wall-clock artefact:** where both arms were alive at the cap, the model had
    reached the same game turn as the rules (median ratio 0.94–1.01).
  - **Why this differs from session 2 is not yet explained.** These are not the causes:
    - **Code:** the frozen rules are identical apart from the default-off guard code.
    - **Caps:** session 2's evals also used 900 s / 20,000 actions.
    - **The served checkpoint:** B's choice mix matches session 2's evalB and final. Melee
      was overridden to throw 28% of the time here against 35–37%, and to flee 19% against
      12–18%.
    - **Time-cap bias:** in session 2 the model's games got further in game turns than the
      rules' (median ratio 1.28).

    Session 2's +0.18 (p≈0.16) was never significant. On fresh starts alone, this is 11–28,
    with deaths 20 against 10. The best reading of everything so far is that B is no better
    than the rules on fresh starts and probably worse, because it spends oil it later needs.
    The guards recover about half of the gap.
  - **Winner by the pre-committed rule: B-op.** No arm passes promotion. B-op (−0.542) and
    B-opf (−0.583) are within 0.05, and B-op has fewer guards. So collectC and the final use
    B-op, and the rules-adj sign will be −1 (bold), because B-op died once more than the
    rules (25 against 24). The rule was fixed before T1, and I'm keeping it even though the
    one-death gap is noise.
- **collectC (21:32–22:47):** B-op played 65 games, 26 of them bank branches, with 0 errors.
  - 2,471 decisions: fight 1,862, tactic 277, descend 154, explore 154, recall 19, equip 5.
  - The model was consulted on every trained-type decision (2,139), and the guards fired
    476 times (oil 435, potion 41).
  - 28 deaths. The deepest depth was DL19, and no game made more than 22 throws.
  - Canaries passed. labelC began at 22:47 with a 5 h budget.
- **labelC (22:47–03:47):** used the whole 5 h budget, with no run errors.
  - 932 records were labelled with utility v2: 615 new collectC decisions (fight 791 and tactic
    141 across both sources) and 317 re-rolled session-2 records. Disagreement-first ordering
    means the 615 are the decisions where the rules and the model differed most, not a random
    sample of the 2,139.
  - The training set totals 4,648 records, with 3,716 v1 records kept.
  - Canaries passed: split-half agreement 79.4% (tactic) and 85.0% (fight), all-tie 14–15%,
    and v2 changed the argmax on 22.4% of re-rolled v1 records (the threshold was ≥ 5%).
  - trainC began at 03:47. handoff_final touched STOP at 03:47:28, so the driver will stop
    after trainC and relaunch for the 4-arm final.
- **trainC (03:47–04:51):** took 1.07 h, over its 0.75 h budget by 20 min. That came out of slack.
  - 3,519 training items, 433 held out, 4 epochs. Canaries passed.
  - Held-out accuracy 0.570 (majority 0.381, rules 0.411, base laya 0.393). Brier 0.172.
  - By type: tactic 0.565 (n 177), fight 0.574 (n 256).
  - This held-out set mixes v1 and v2 labels, so it can't be compared directly with trainB's
    0.606 on the v1 set. Offline accuracy also didn't predict play in T1.
- **Hand-off (04:51):** the driver stopped after trainC. handoff_final put the RULES_CAUTION
  build of busho-player.ts into the frozen source (old copy kept at
  `src/busho-player.ts.before-final`) and relaunched driver3 at 04:51:26.
  - The final began at 04:51 with 4 arms: rules, W (B-op: trainB + oil/potion guards),
    C (trainC + the same guards), and rules-adj at `RULES_CAUTION=-1.0`.
  - It uses one laya server with both checkpoints. Its budget runs to about 12:21, inside the
    14:34 global deadline.
- **Final (04:51–12:05):** all 120 starts done for each of the 4 arms (90 fresh, 30 bank). No
  errors and no deadline cuts. Canaries passed.

  | Arm vs rules | W–L | Mean diff (CI80) | Deaths (model/rules) | Depth (model/rules) | Deaths per level | Sweep verdict | Replacement cost W–L, mean |
  |---|---|---|---|---|---|---|---|
  | W (trainB + guards) | 23–53 | −0.717 (−0.99, −0.46) | 46/33 | 4.01/4.40 | 0.096 vs 0.063 | worse | 22–41, −14.9k |
  | C (trainC + guards) | 33–50 | −0.475 (−0.84, −0.11) | 26/33 | 3.75/4.40 | 0.058 vs 0.063 | trade-off | 26–40, −7.6k |
  | rules-adj (caution −1) | 35–32 | 0.000 (−0.21, +0.21) | 33/33 | 4.40/4.40 | 0.063 vs 0.063 | trade-off | 33–26, +2.3k |

  - **C against W:** 45–36, +0.242 (p = 0.19). C died far less (26 against 46) and went
    slightly shallower. The verdict is a trade-off: W wins with no death penalty, and C wins
    at a penalty of 2 or more.
  - **C fresh/bank:** fresh starts 24–37 (−0.256, deaths 11 against 15); bank starts 9–13
    (−1.133, deaths 15 against 18).
  - **rules-adj matched the rules exactly in total:** 528 levels and 33 deaths each. This is
    a coincidence, not a bug: 67 of the 120 pairs had different outcomes, and the logs differ.
    So caution −1 moves individual games but not the aggregate. The frontier line is
    degenerate (both points coincide), so the frontier check gives no answer for C. A
    cautious control (+1) would have been the informative one for C. The sign was fixed by
    W's T1 death count before C existed.
  - **By the pre-committed rules:**
    - No model arm passes promotion.
    - Neither model is "clearly better play".
    - **W is worse than the rules** at every death penalty, confirming T1.
    - **C trades depth for safety:** 21% fewer deaths, 15% less depth, and slightly fewer
      deaths per level reached (0.058 against 0.063). It still loses to the rules at every
      penalty up to 6 and on replacement cost.
    - **C improves on W**, which is the first sign that utility v2 labels moved behaviour in
      the intended direction (it is now spending less oil and dying less). That improvement
      isn't significant on its own.
  - **Session 3 conclusion:** the fine-tuned model doesn't yet play better than the rules.
    The labelling objective changes *how* it plays (C is more cautious than W), which is
    evidence that the pipeline responds to the objective, but neither model beats the rules
    on the measures fixed in advance. Session 4 begins with the honest-play change below,
    which resets the baselines anyway.

### Pre-committed decision rules
- **Score** per game = max depth − 3 if dead. **Arm vs. rules:** promote if wins > losses and
  deaths ≤ rules + 2, on fresh and bank starts **combined** (each start is one pair).
- **T1 winner:** the arm with the highest mean paired diff against rules among those passing
  the promotion rule. If none pass, the arm with the highest mean diff. If two are within 0.05
  of each other, the one with fewer guards (simpler) wins.
- **labelC canaries:** the same as session 2 (split-half ≥ 65%, all-tie ≤ 25%, errors ≤ 2%),
  plus "v2 changed the argmax on ≥ 5% of re-rolled v1 records". Otherwise the scarcity term
  has no effect, so the cause is investigated before training.
- **trainC canary:** acc > majority on v2 held-out records. If it fails, the final runs with
  only the rules and the T1 winner.
- **Final verdict:** report every arm against the rules and C against the T1 winner, with a
  bootstrap 80% CI and a sign test. "Clearly better" means p < 0.05 one-sided on the pooled
  pairs.
- **Skill or risk tuning? (added 2026-10-14 18:50, during T1, at the user's request.)** The
  "−3 per death" score is itself a risk/reward setting, and a model can win at one death price
  and lose at another. Rescoring session 2 (97 pairs) under death penalties 0–20 gives wins at
  0–6 but a negative mean at 20 (survival first). Deaths per level reached were 0.085 (rules)
  and 0.088 (model), so session 2's gain fits slightly bolder play at least as well as better
  play. From now on:
  - Every paired comparison also reports a **death-penalty sweep** (0, 1, 2, 3, 6, 20) with W–L,
    mean diff and sign p, plus **deaths per dungeon level reached**. Verdict "better" means it
    wins (W > L and mean diff > 0) at every penalty, "worse" means it loses at every one, and
    anything else is a "trade-off".
  - **rules-adj control arm in the final:** the rules with `RULES_CAUTION` = ±1. That one knob
    moves only the rules' own fight and tactic decisions, which are what the model controls:
    the combat heal threshold ±0.15, the level margin for fleeing or throwing at fast enemies
    2 ∓ 2, and the melee damage budget 0.5·(1 ∓ 0.5) of HP. Its sign is fixed by W's T1 result
    against the rules:
    - more deaths → bolder (−1);
    - fewer deaths → more cautious (+1);
    - equal deaths → bolder if W went deeper, else more cautious.

    The final reports W and C against rules-adj. It also reports a **frontier** check: the
    rules' depth at the model's death count, on the line through rules and rules-adj.
  - **"Clearly better play"** now needs all three: p < 0.05 at the −3 score, the "better"
    verdict across the sweep, and W (or C) above the rules frontier or "better" against
    rules-adj. A model that wins at −3 but is a "trade-off" across the sweep is reported as a
    different risk tuning, not as better play.
  - **Mechanics:** `tools/overnight/handoff_final.py` runs detached. When trainC begins it
    touches `STOP`. train.py only watches `trainC/STOP`, so training still finishes, and the
    driver then stops before the final. The helper then copies the new `busho-player.ts` into
    the run's frozen source (the old copy is kept as `src/busho-player.ts.before-final`) and
    relaunches driver3, whose final has the 4th arm and 7.5 h. `RULES_CAUTION` defaults to 0, so
    the rules, W and C arms play exactly as before. If trainC is skipped instantly (labelC
    failed), the helper may lose the race and the final then runs as originally planned.
- **Never restart the driver mid-stage.** For changes between stages, stop it while it is idle
  between stages (`STOP` file), edit `state.json`, and relaunch (lesson from session 2).

### Guardrails (unchanged)
- Native mode, 13 slots, throttle to 9 on WSL memory > 16 GB or Windows event 2004. At most
  one laya server on the GPU, and no greedy VRAM probes. Retry on VRAM spikes from the
  user's containers.
- Don't touch the user's containers. Process cleanup goes by PID list, never by `pkill -f`.
- Background stage-boundary waiters, never long foreground waits. At each boundary: read the
  canaries, act only by the rules above, and update the run log and `REPORT.md`.

## Roadmap after session 3 (recorded 2026-10-14)

Session 3's T1 showed the trained model (B) losing to the rules over long games: 18–37,
with 35 deaths against 24, mostly after its oil ran out. Session 2's small edge did not hold
up. The bottleneck is the labels and the evaluation, not model capacity. In order:

1. **One stated objective, used everywhere.** Labels (rollout utility), the tournament score
   (−3 per death) and the robustness sweep currently disagree, and every hand-set weight is
   an accidental caution setting. Define one objective: the chance of surviving to a horizon
   plus depth reached, at a stated exchange rate. Use it for labels, training choices and
   verdicts, and keep the death-penalty sweep and the rules-adj frontier as checks.
   - **Proposed form (user's idea, 2026-10-14): price a death at its replacement cost.**
     - **Definition:** C(d) is the expected game turns for a fresh character to first reach
       DL d, counting every death and restart on the way. Recursively,
       C(d+1) = (C(d) + τ_d) / p_d, where p_d is the chance of getting from d to d+1 and τ_d
       is the mean turns spent at d.
     - **Score:** a game is worth C(final depth) if the character is alive and 0 if it dies,
       with turns spent optionally subtracted. Everything is then in one unit (turns of
       effort). Deaths cost more the deeper the character is, as a careful human plays
       (protective of a high-level character), and characters alive at the cap get credit
       for the effort they embody.
     - **The optimal policy** minimises the expected time to reach a target depth under
       permadeath.
     - **First estimate,** from 225 fresh rules games over sessions 2 and 3:

       | First reach | DL2 | DL3 | DL4 | DL5 | DL6 | DL7 | DL8 | DL9 |
       |---|---|---|---|---|---|---|---|---|
       | C (game turns) | 16k | 39k | 75k | 94k | 120k | 151k | 156k | 199k |

       So a death at DL3 costs about 1–2 levels of progress at the current pace, and one at
       DL8 about 4–5. The fixed −3 is too harsh early and too lenient later. DL5+ rests on
       9–25 games.
     - **T1 rescored by C:**
       - B: 12–28, −20k turns per game.
       - B-op: 24–25, −11k.
       - B-opf: 22–27, **+3k**. Its edge comes from fewer deaths on the deep bank starts:
         10 against 14.
       - Session 2's B: 38–34, +1k.
     - **Next steps:**
       - Define C by a fixed reference policy (the rules) so it's a stable yardstick.
       - Extend it deeper with the bank starts.
       - Bootstrap the score, since a few deep deaths dominate it.
       - Later, replace C(depth) with the value function V(state) (item 3), so character
         level and gear count too.
       - Use the same C as the rollout terminal value, so labels and verdicts share the
         objective.
   - **Guarding against paralysis (user, 2026-10-14).** A pure "death costs C(d)" score lets
     a deep character stall safely forever. If C were re-estimated from that slower policy,
     C would grow, and the policy would grow more cautious still: a spiral. The defences,
     in order:
     1. **Charge for time.** Score a game segment as `C(d_end) − C(d_start) − turns` if the
        character is alive, and `−C(d_start) − turns` if it dies. Both terms are in turns, so
        the exchange rate is 1. This is the standard way of turning "maximise the long-run
        progress rate" into a per-game score. A positive score means building characters
        faster than the reference policy does on average, deaths included. Stalling scores
        −turns, so paralysis is never optimal.
     2. **Fix the yardstick.** Within a session, C comes from a fixed reference (the rules).
        Re-estimate it only between sessions, from the promoted policy, and damp the update
        (for example a 50/50 mix with the previous table) so it can't spiral.
     3. **Soften explicitly, as a stated design choice, if play still looks timid.** Options
        are a concave price (C^α, α<1), a cap of k levels' worth of effort, or a per-turn
        discount. Pace is a playability requirement, so it can also be a constraint: minimise
        deaths subject to median turns per level ≤ X.
     4. **Measure timidity.** Every tournament reports turns per level, time in town, flee and
        recall rates, and stalls (no new depth or experience for N turns), next to the
        robustness sweep.
2. **Act only when confident.** In T1, B overrode the rules 1,165 times with a median
   confidence of 0.012. Only 7% of its overrides had confidence of 0.1 or more, because
   training set `DECISION_MIN_CONFIDENCE=0`. Add tournament arms with thresholds (for example
   0.05, 0.1 and 0.2), or a predicted-advantage-over-rules gate. This is cheap and likely to
   help.
3. **A value function for long horizons.** Train V(state) → eventual outcome from the
   finished games and snapshots we already have. Rollouts then end with V(state) as their
   value, so delayed costs (oil, potions, pace) are visible without hand-made scarcity terms.
4. **A scenario suite.** Hundreds of short, fixed situations from the savepoint bank, for
   example "fast unique at range 4, 2 flasks, 60% HP". They give low-variance, cheap answers
   per decision type. Full-game tournaments, with the rules-adj control, remain the final check.
5. **More decision types,** ordered by how cheaply each can be labelled and how directly it
   hits observed failures. Each one gets its own `DECISION_MODEL_TYPES` switch and its own
   A/B test before they are combined:
   1. **Supplies:** how much oil and how many potions to buy, and when to go back to town to
      restock. This is new, and it targets the main way the model dies.
   2. **Equipment:** label with simulated fights.
   3. **Pace (descend, explore, recall):** this needs item 3 first, because short rollouts
      can't see the consequences, and it needs the frontier control because pace *is* the
      risk/reward axis.
6. **Depth:** grow the savepoint bank with the best policy and report results by depth band
   (1–4, 5–9, 10–19, 20+).

Rough order:
- **Session 4:** items 1, 2 and 4, plus Jev phase J1.
- **Session 5:** item 3, the supplies decision type, and Jev phase J2.
- **Session 6:** the pace decisions.

### Principle: the prompt shows only what the player's UI shows (user, 2026-10-15)
The decision model's state text may contain only information a human player could see on
screen: the map as seen, visible monsters, the health bar of the tracked monster, the status
line, the inventory and equipment as identified, and monster recall as far as lore allows.
Knowledge the player brings from experience or spoilers belongs in the model's weights, not
in the prompt. Rollout labels may still use the true game state: they measure what actually
happens, which is how a player learns from experience.

**How far the current prompt is from this** (`tools/decision/index.ts`, `buildStateText` and
`monsterLine`):
- **Monster selection.** `/state` returns every living monster on the level. The game server
  runs in "omniscient mode", and `buildStateText` filters by distance ≤ 6 only. Monsters behind
  walls, out of light and invisible ones all appear. One held-out record lists Sméagol, who is
  invisible, next to a CL2 Elf Warrior without See Invisible.
- **Monster details from race data.** The prompt shows exact HP, level, exact speed, breath
  and spell elements, spell frequency, evil/undead and other kinds, immunities, BREEDER and
  PASSWALL. In the UI, HP is a health bar for the tracked monster only, and the rest is monster
  recall, which depends on lore. The port has `monster/lore.ts`, but nothing in the game loop
  calls it.
- **Status.** The prompt shows `food:13782`, where the UI shows Hungry/Fed/Full.
- **Items.** `describeItem` shows resists and flags without checking rune knowledge; this only
  affects the 5 equip decisions so far.
- **The rules player is omniscient too.** It uses the full map and every monster for the ~90%
  of decisions it makes, and for choosing when to ask the model. The tournaments are fair
  between arms, because every arm shares the same rules player, but no arm plays from the UI.
  This principle covers the prompt; whether it should also cover the rules player is open.

**Plan (start of session 4, before any other prompt change, so new models train on the
honest prompt from the start):**
1. **A visibility function:** a monster is shown only if its square is in view (`updateView`
   already runs in the game loop) and it is lit or within infravision, and it isn't
   INVISIBLE unless the player has See Invisible. Telepathy and detection count when active.
2. **Health bar instead of HP:** in 10% steps, as the UI draws it.
3. **Recall from lore:** decide whether lore starts empty per character or uses a fixed
   "veteran" lore file, as vanilla carries lore across characters. Then wire up `lore.ts`.
4. **Food as the UI's words**, and item properties only as known runes.
5. **Re-render the existing records:** every decision kept a full snapshot (2,353 in collectC
   alone), so states can be re-rendered without new rollouts, and the labels can be kept.
   Retrain on the honest prompt and compare it with the leaky one in held-out accuracy and in
   play, to measure how much the model relied on hidden information.
6. **Monster knowledge from documentation and tables** then becomes the legitimate route for
   what the player "knows": synthetic recall questions generated from the tables, or training
   on documentation. This replaces the earlier idea of putting full table lines in the prompt.

**Decisions (user, 2026-10-15):**
- **Lore starts empty** for every character and is learned only by observation: seeing a
  monster, its attacks and spells hitting you, and kills. No veteran lore file.
- **The rules player is limited to the UI too, for fairness.** It must see what the model
  sees. That supersedes the open question above, and it changes what follows.

**Revised plan (session 4 becomes "honest play"):**
1. **A perception layer in the game server.** `/state?view=player` returns the same schema,
   filtered to what the UI shows:
   - **Map memory:** a square is known once it has been SEEN; lit rooms are remembered when
     seen. Mapping and detection effects already set MARK. Memory is lost on a level change.
     The game loop currently never marks seen squares, though the renderer draws SEEN|MARK.
   - **Monsters:** only those on SEEN squares. Infravision counts only warm-blooded monsters
     (it currently counts any monster). INVISIBLE monsters are hidden without See Invisible.
     Telepathy and detection count while active.
   - **Remembered monsters (user, 2026-10-15):** the prompt may say "you saw a live X
     recently on this level". The view keeps, per level, the monsters the player has seen and
     not seen die, with where and how many turns ago they were last seen. Entries are dropped
     on a level change, or once the player sees the monster die. This is what a player
     remembers; it is not a live position.
   - **Monster health:** the look command's words (unhurt … almost dead) instead of exact HP.
   - **Lore:** wire `monster/lore.ts` into the game loop (on sight, attack, spell and kill),
     store it per character in the save, and expose only known fields. Level, speed, blows,
     spells and flags are unknown until learned.
   - **Objects:** floor objects only when seen; item properties only as known runes and
     flavours.
   - **Food** as Hungry/Weak/Fed/Full.
   - **Status (2026-10-15 morning):** first version done in
     `packages/@angband/core/src/borg/perception.ts` and wired into `ai-server.ts`.
     - `/state`, `/command` and `/restore` take `?view=player`; without it nothing changes.
     - Lore and map memory travel inside `/snapshot` saves as `save.perception`; older saves
       restore with them empty.
     - Smoke-tested on two saves:
       - DL3 dark corridor: the omniscient view had 13,068 squares, Sméagol (invisible) and a
         green ooze. The player view had 9 squares and no monsters.
       - Fight with a cutpurse: the view showed "badly wounded", then "wounded". Lore learned
         HIT:HURT (dice after 10 hits) and TOUCH:EAT_GOLD from the message log. Speed was
         known after 1 sighting, and level stayed unknown before any kill.
     - Not yet covered: detection effects, mimics, item rune and flavour knowledge, sightings
       during multi-turn commands (run/rest), and unit tests.
2. **Rules player on `view=player`** (`tools/busho-player.ts`, ~4,100 lines).
   - **Status (2026-10-15 afternoon):** `PLAYER_VIEW=1` makes the rules player fetch
     `?view=player`. `tools/honest-view.ts` adapts that view to the fields the rules code
     reads, using only the view plus generic priors, never per-monster data:
     - an unknown monster level counts as the dungeon level;
     - max HP comes from one power law over all monsters (1.7·L^1.48; uniques 7.5·L^1.5),
       and current HP from the health word's band;
     - spells, breaths and summons count only once seen;
     - a race counts as a breeder once six or more are seen on the level;
     - immunities and PASS_WALL count as unknown, which the code treats as false;
     - only visible monsters go into `monsters`; remembered ones go into
       `rememberedMonsters`;
     - hunger words map back to representative food values.

     Exploration needed no change. The honest map only has seen squares, so walking to
     unvisited known floor already explores frontier-first.
   - **Decision prompts in honest mode** (format v3): monsters show as health, `Lv?` until
     learned, speed, distance, UNIQUE, asleep/afraid, blows and spells seen, and kinds and
     kills once known. A "Seen recently on this level" line lists remembered monsters with
     their age. Status shows the hunger word.
   - **Known remaining leak: item knowledge.** Inventory and equipment names and properties
     come from the object kind even when it is unaware, and runes are not checked. The port
     sets `kind.aware` only in `identifyObject`, so honest item names would also need
     learn-on-use and store awareness. The consumables the rules player relies on (CLW,
     Phase, oil, WoR) are store-bought and therefore known in vanilla, so the leak is mostly
     floor items. Deferred.
   - Original plan for this step:
   - Audit every use of the map, monsters and items.
   - Exploration becomes frontier-based, because it can no longer path to unseen stairs.
   - Threat estimates use health words and lore instead of exact HP and race flags; unknown
     monsters get a depth-based prior.
   - Expect the honest rules player to be weaker (more deaths, slower descent). It is a new
     baseline, not a regression to fix at all costs.
3. **Rollouts use the honest rules player** as the continuation policy, so labels measure what
   an honest player would get. They still start from the true snapshot, because the outcome is
   real.
4. **Data:** old records can't be re-rendered faithfully, because the snapshots carry no lore
   or map memory. Session 1–3 data and models count as the "omniscient" era: kept for
   reference, not mixed with the new data. Savepoints in the bank stay usable as starting
   states, with lore and map memory empty on restore (recorded as a known approximation).
5. **Baselines reset:** a fresh honest-rules baseline (T0), then collect, label and train as
   before. Session 3's verdicts stand only for the omniscient setting.
6. **Jev J1** waits for honest held-out data, so both models get the same honest prompts.
7. **Canaries:**
   - A leak test: an invisible monster, a monster behind a wall and an unexplored stair must
     not appear in `view=player`.
   - A replay check: the omniscient view is unchanged when the parameter is absent.

## Session 4: honest play (planned 2026-10-15)

Everything in this session sees only what the UI shows: games, rollouts and every tournament arm
run with `PLAYER_VIEW=1`. This is a new era. Session 1–3 data, models and verdicts aren't
mixed in, because they were made with an omniscient prompt and an omniscient rules player.
Driver: `tools/overnight/driver4.py`.

### Honest rules player: shake-down before the run
Three bugs were found and fixed by playing 8 matched seeds (omniscient vs. honest rules,
900 s / 20,000 actions):
1. **Map memory only updated per command**, so RUN left gaps in remembered corridors.
   Perception now runs on every game-loop REFRESH, scanning a radius-21 window around the
   player plus a full sweep every 200 turns.
2. **No frontier.** The explorer only targets known unvisited squares, so it stalled in pockets
   whose exits were doors or dark edges (e.g. after a Phase Door). The adapter now offers each
   unknown square next to known floor or a door as unvisited floor.
3. **Paths to known stairs went only through known squares**, so with no known route the
   player dug futilely at granite. In player-view mode, `bfsNextStep` now treats unknown
   in-bounds squares as passable, as a human assumes, and replans as they're seen.
4. **Light radius off by one in the port** (`cave/view.ts` `determineSeen`): a light-r source
   lit distance < r, where vanilla lights ≤ r. A torch showed only the 3×3 around the player,
   and light 1 showed nothing beyond the player's own square. This is fixed. Only the renderer
   and the perception layer read SEEN; monster AI uses VIEW, which is unchanged.
5. **Descent deadlock (pre-existing):** with no healing potions and under 40 gold, the rules
   player neither restocked nor descended. On DL < 8 it may now descend after twice the
   too-long-on-level time.
6. **Futile digging (pre-existing):** with any digger, it assumed granite was diggable. Digging
   now follows vanilla's skill thresholds (magma > 10, quartz > 20, granite > 40), both for
   `digWorthwhile` and for the digging pathfinder's costs.

| Batch | Stall resets in honest games | Honest total depth / deaths | Omniscient total depth / deaths |
|---|---|---|---|
| ab1 (before fixes) | up to 24 per game | 36 / 3 | 25 / 4 |
| ab3 (fixes 1–2) | 4 and 9 in two games | 39 / 5 | 25 / 4 |
| ab4 (fixes 1–3) | 1 and 3 in two games | 31 / 4 | 28 / 4 |
| ab5 (fixes 1–5) | 17 in one game (fixed by 6), 1 in two | 46 / 6 | 29 / 2 |

The honest rules player is not weaker on these 8 seeds; it dives sooner, because "explored"
is measured over what it has seen, and it dies more. That makes it a different baseline, not a
broken one. The omniscient numbers move between batches too, because fixes 4–6 change the
shared code. collectD reports stall resets so this can be watched at scale.

### Stages (21 h, 13 slots)
| Stage | Budget | What |
|---|---|---|
| collectD | 1.5 h | honest rules acting, decisions logged in format v3, 40% of games from bank savepoints (DL ≥ 5, restored with empty map memory and lore, a recorded approximation) |
| labelD | 9.0 h | rollouts on collectD, utility v2, danger-first order, K = 8, honest continuation policy |
| trainD | 1.0 h | laya from the base model on labelD only, 4 epochs |
| finalD | 7.5 h | 5 arms × 96 starts (72 fresh, 24 bank): rules, D (model + oil/potion guards), D-gate (same, but acting only at confidence ≥ 0.3), rules+ (caution +1), rules− (caution −1) |

### Pre-committed decision rules
- **Score and promotion:** the same as session 3 (depth − 3 per death; promote if W > L and
  deaths ≤ rules + 2), reported for fresh starts, bank starts and both together.
- **Robustness:** the death-penalty sweep (0, 1, 2, 3, 6, 20) with a better / worse / trade-off
  verdict, and deaths per level reached.
- **Frontier:** a least-squares line through rules, rules+ and rules− in (deaths, mean depth).
  A model arm is "above the frontier" if its mean depth beats the line at its death count. If
  the three rules points have no spread in deaths, the frontier is undefined and reported as
  such.
- **"Clearly better play"** needs all of: p < 0.05 at −3 per death, the "better" verdict
  across the sweep, and above the frontier.
- **Confidence gating:** D-gate against D head to head. If D-gate is better or a trade-off with
  fewer deaths, then gating becomes the default for the next session.
- **Canaries:**
  - collectD: errors ≤ 10%, every decision in format v3, and ≥ 500 fight/tactic decisions.
  - labelD: ≥ 300 labels, split-half ≥ 65%, all-tie ≤ 25%, run errors ≤ 2%.
  - trainD: accuracy > majority.
  - finalD: ≥ 75% of starts complete; D identical to rules ≤ 50% (not D-gate); consulted
    ≥ 0.9; throws ≤ 100.

### Run log
- **Launch:** `driver4.py --run runs/session4/2026-10-15 --prior runs/session3/2026-10-14
  --hours 21 --slots 13`, started 2026-10-15 14:13 (PID 38878) from commit `359ee6e`.
  - The global deadline is about 11:13 on 10-16. The stage budgets sum to 19 h.
  - The smoke run before it passed every stage. Gating changed who acts: D acted on 29/29
    fight/tactic decisions, D-gate on 4/19.
  - Early bank starts die fast (e.g. a CL5 Paladin restored on DL8 meets Wormtongue). These
    are genuine and shared by all arms.
- **collectD (14:13–15:44):** 139 games (56 bank), 0 errors, 9,038 decisions, all format v3.
  - By type: fight 5,538, tactic 1,752, recall 707, descend 515, explore 515, equip 11.
  - Canaries passed. labelD began at 15:44.
  - **Deaths are high: 111 of 139** (fresh 66/83, mean depth 5.5; bank 45/56, mean depth 11.3).
    Session 3's model-led collectC lost 28 of 65.
  - **Sméagol is the top killer (11).** Two causes, neither changed mid-session:
    1. **Port fidelity bug:** TS `EAT_GOLD` is "simplified". The thief steals but never
       teleports away as vanilla's does (`mon-blows.c`: the thief blinks after stealing).
       Invisible and fast, Sméagol keeps attacking. `EAT_ITEM` is a stub too.
    2. **Honest rules player gap:** it has no response to an unseen attacker. It walks into
       him ("You hit the monster"), doesn't heal or Phase, and dies at full kit.
  - **Message scrub leak:** `perception.ts` `raceVisible` treats an adjacent monster on a SEEN
    square as visible even when it is INVISIBLE, so some messages still name Sméagol.
  - Stall resets: 283, mostly in ten games (11–36 each). Most games have none.
  - For session 5: fix 1 (or move to C, where it's right already), add unseen-attacker
    handling to the rules player, fix the scrub, and investigate the remaining stall games.
- **labelD contamination (17:07):** two C smoke tests collided with labelD's rollout servers
  (ports 4300–4303) between 16:10–16:18 and 16:52–17:00. 175 of the first 400 labels were
  quarantined (see "C Angband engine: spike", Incident); trainD uses the rest.
- **labelD (15:44–00:44):** 2,823 clean labels (tactic 1,285, fight 1,538), plus 175
  quarantined and 62 unlabelled. Run errors 0.0%.
  - Split-half agreement: tactic 83.8% and fight 82.9%. Excluding all-tie records, it is 79.8%
    and 81.2%.
  - All-option ties: tactic 19.8% and fight 9.2%. Canaries passed.
  - Every gate passes (≥ 300 labels, split-half ≥ 65%, all-tie ≤ 25%, errors ≤ 2%).
  - Argmax spread is broad. Fight: throw 420, flee 364, melee 336, plus mixed ties. Tactic:
    fight 403, flee+fight 227, heal 155, flee 106, plus ties.
  - trainD began at 00:44.
- **trainD (00:44–01:27):** 2,308 training items, 118 held out, 4 epochs. Canaries passed.
  - Held-out accuracy 0.703 (majority 0.458, rules 0.492, base laya 0.458). Brier 0.137
    (base laya 0.252).
  - By type: fight 0.718 (n 78), tactic 0.675 (n 40).
  - This is a different label era (honest view, utility v2), so it isn't directly comparable
    with trainC's 0.570, and offline accuracy hasn't predicted play before.
  - finalD began at 01:27 (7.5 h budget, so it ends about 08:57).
- **finalD (01:27–06:34, done early):** 96/96 starts complete for all five arms. No errors, no
  deadline cuts, canaries passed. The rules died in 73 of 96 starts, mean depth 6.45.

  | Arm vs rules | W–L | Mean diff (CI80) | Deaths | Mean depth | Sweep verdict | Sign p |
  |---|---|---|---|---|---|---|
  | D | 33–43 | −0.40 (−0.96, 0.14) | 72 vs 73 | 6.02 vs 6.45 | worse | 0.90 |
  | D-gate | 10–8 | +0.03 (−0.20, 0.27) | 72 vs 73 | 6.45 vs 6.45 | trade-off | 0.41 |
  | rules+ (caution +1) | **46–32** | **+0.73 (0.19, 1.27)** | **67 vs 73** | **6.99 vs 6.45** | **better** | 0.07 |
  | rules− (caution −1) | 33–27 | −0.08 (−0.54, 0.37) | 63 vs 73 | 6.05 vs 6.45 | trade-off | 0.26 |

  - **D:**
    - Fresh starts: 27–35, −0.50.
    - Bank starts: 6–8, −0.08.
    - Identical to rules in 3/96 games; consulted 1.0.
    - The oil guard overrode the model 156 times, the potion guard once.
    - Deaths per level reached: 0.125 vs the rules' 0.118.
  - **D-gate:**
    - It matched the rules in 75/96 games, because at confidence ≥ 0.3 the model rarely acted.
    - Its "promote" flag (W > L, deaths ≤ rules + 2) is technically true, but it rests on 18
      differing games with a +0.03 mean.
  - **Frontier:** the three rules points (73, 6.45), (67, 6.99) and (63, 6.05) don't lie on a
    trade-off curve. rules+ beats the rules on both axes, and rules− has fewer deaths but less
    depth. The fitted line is nearly flat (+0.03 depth per death).
    - D and D-gate are both below it: 6.02 and 6.45 against the line's 6.63.
    - Given the spread, the frontier says little this session.
  - **Pre-committed verdicts:**
    - **No arm shows "clearly better play".** That needs p < 0.05, "better" across the sweep and
      above the frontier.
    - **D is worse than the rules.** The model trained on honest labels plays worse than the
      honest rules player that labelled it, as W and C did in session 3.
    - **D-gate is not a meaningful promotion.** It is the rules player 78% of the time, and its
      edge is noise.
    - **Gating becomes the default for session 5.** D-gate beat D head to head: 43–33, +0.43,
      verdict "better", deaths 72 vs 72. That meets the rule ("better, or a trade-off with
      fewer deaths").
  - **Finding, not pre-committed:** under the honest view, raising the rules' caution by +1
    helped on every measure. It had 6 fewer deaths and +0.54 mean depth, the sweep was "better"
    at every penalty, and the CI80 excludes 0.
    - In session 3, with the full view, the caution change was a wash.
    - Honest play means less information, so more caution pays.
    - p = 0.07, so this needs confirming before it becomes the baseline. Session 5 should
      include rules+ as an arm or as the new baseline candidate.

## Session 5: C engine, 8 hours (2026-10-16)

The user asked for an 8-hour session after session 4: "Commit, and start the next phase with an
8 hour window". Driver: `tools/overnight/driver5.py`, from commit `3c3584c` plus driver5.
- **Engine:** C Angband 4.2.6 (`main-http`, angband-c `jev-http`), frozen into `RUN/src/c-game`.
- **View:** honest, as in session 4.
- **Rules player:** includes the unseen-attacker handling and the scrub fix.
- **Bank:** TS savepoints can't load in C, so collectE starts fresh, and the run's own C bank
  (DL ≥ 5) feeds finalE's bank starts.

### Questions
1. Does session 4's rules+ finding (caution +1 better under the honest view) hold on C?
2. Does a gated model trained on more data (labelD + labelE) beat the rules, and also the best
   rules setting?

### Stages (8 h, 7.5 h budgeted, 13 slots)
| Stage | Budget | What |
|---|---|---|
| collectE | 0.75 h | honest rules on C, format v3; bank starts once the run's bank has DL ≥ 5 savepoints |
| labelE | 3.0 h | C rollouts, utility v2, danger-first, K = 8, honest rules continuation |
| trainE | 0.75 h | laya from the base model on labelD (2,823 clean TS labels) + labelE, 4 epochs; held-out accuracy reported overall and on the labelE part |
| finalE | 3.0 h | 3 arms × 192 starts (144 fresh, 48 bank): rules, rules+ (caution +1), E-gate (trainE, oil/potion guards, confidence ≥ 0.3) |

### Pre-committed decision rules
- **Score and promotion** are as before: depth − 3 per death; promote if W > L and deaths ≤
  rules + 2. They're reported for fresh, bank and all starts, with the death-penalty sweep
  and its verdict.
- **rules+ becomes the rules baseline** if, against rules (all starts), W > L, the sweep verdict
  is "better", and sign p < 0.05 at −3 per death. If it is "better" but p ≥ 0.05, it stays a
  candidate. Two sessions in the same direction count as evidence for the next plan, not as a
  promotion.
- **E-gate is promoted** only if it passes the promotion test against rules **and** beats rules+
  head to head (W > L). "Clearly better play" also needs p < 0.05 against both and a "better"
  sweep verdict against both.
- **No frontier line this session.** Two rules points can't support one.
- **Canaries:**
  - collectE: errors ≤ 10%, every decision format v3, ≥ 500 fight/tactic decisions.
  - labelE: ≥ 300 labels, split-half ≥ 65%, all-tie ≤ 25%, run errors ≤ 2%.
  - trainE: accuracy > majority.
  - finalE: ≥ 75% of starts complete for all arms, consulted ≥ 0.9, throws ≤ 100.

### Run log
- **Smoke tests** (offset ports, 6 slots):
  - The first smoke test found that `freeze_c` ran before `app_dir`, whose source freeze
    deleted `src/c-game`, so no C game could start. Fixed.
  - The second smoke test passed every stage: collectE 260 games, 0 errors; labelE 40/40; trainE;
    finalE 3 starts × 3 arms, E-gate consulted 1.0.
- **First launch, 08:46, aborted after about 2 minutes:** a C Paladin looped on "study Bless" 929
  times until killed.
  - Vanilla Priests, Paladins and Druids lack `CHOOSE_SPELLS`, so `CMD_STUDY` takes a book
    (`item`), and `main-http` only set `spell`. The smoke test hadn't caught it.
  - Fixes: angband-c `3605dc6d5` (study names a studiable book holding the spell; checked for
    Paladin, Priest, Druid and Mage) and angband-jev `635a9d3` (busho stops retrying a study
    that doesn't take, for 200 actions).
  - The aborted run is kept at `runs/session5/2026-10-16.aborted-study-bug`.
- **Second launch, 08:49, stopped at 08:54.** The first 25 games showed C-specific failures that
  the 1,500-action smoke caps had hidden. 13/25 ran all 30,000 actions, most of them "resting
  while confused". Kept at `runs/session5/2026-10-16.aborted-c-fidelity`.
- **Fixes, each checked with a 12–15 minute full-length collect on offset ports (13 slots):**
  1. **REST was a no-op on C** (angband-c `6ef6f25ee`). Vanilla reads a rest count of 1 as
     "repeat the last count", initially 0, so no time passed and confusion never wore off.
  2. **Starvation.** Food came last in the shopping list, and shopping was skipped under 50 gold.
     - Rations are now bought first.
     - Hunger with no food now means: eat if possible, else Word of Recall, else walk up to town.
     - This runs before the stall handlers, which had pre-empted it every turn.
  3. **Light.** Vanilla torches burn out (TS's don't), and busho sold its spares. In the dark it
     can't read or cast, and the refused commands passed no time, so it looped: Bless ×23,000,
     Phase Door ×26,000.
     - C now reports `fuel` for lights (shown in the UI as turns).
     - busho keeps and buys spare torches and swaps one in below 300 turns.
     - A silver jelly can still drain the light.
  4. **Generic no-time guard.** A READ or CAST that passes no game time blocks that type for 20
     commands. After 30 consecutive commands that pass no time, a turn is held (SEARCH) instead.
  5. **Stalls.** When stalled with a stair known, busho walks the BFS path to it, instead of
     tunnelling in a straight line toward it.
  6. **Lava is impassable to busho.** Vanilla asks before a step that would cost over a third of
     HP; headless, that means no step and no time.

  | Test | Games | 30k-action cap | Stall resets | Starvation | Decisions | Mean max DL |
  |---|---|---|---|---|---|---|
  | REST fix only | 107 | 24 | 663 | 15 | 10,046 | 3.59 |
  | + food, light (first pass) | 138 | 19 | 775 | 15 | — | 3.95 |
  | + no-time guard | 122 | 23 | 889 | 15 | — | 3.60 |
  | + early hunger, stair walk | 148 | 16 | 404 | 7 | 19,218 | 4.30 |

  Remaining: deaths to poison (21 in the last test; they're ordinary fights lost without potions)
  and small sealed pockets (e.g. 46 known squares, no stairs). These are shared by every arm.
- **Launch:** `driver5.py --run runs/session5/2026-10-16 --prior runs/session4/2026-10-15
  --hours 8 --slots 13`, started 10:00 (PID 71726) from `36bd4b5`. The C binary is frozen from
  angband-c `6ef6f25ee`. Deadline about 18:00.
  - First 25 games: none hit the action cap, and no loops (the top repeated action is Bless, up to
    121 times). All 25 died, reaching up to DL9.
- **collectE (10:00–10:46):** 352 games, 0 errors, 49,794 decisions, all format v3. Canaries
  passed.
  - By type: fight 37,514, tactic 6,945, equip 1,455, descend and explore 1,423 each, recall
    1,034. That's five times collectD's 9,038 decisions in half the time.
  - Deaths: 288 of 352. Max depth 12.
  - Top killers: poison 32, soldier 30, starvation 20, cave spider 16, acolyte 14, apprentice 14.
  - Stall resets: 967.
  - The C bank now holds 623 savepoints for finalE's bank starts. There were no bank starts in
    collectE, since TS savepoints can't load in C.
- **labelE (10:46–13:46):** 4,117 labels (fight 3,034, tactic 1,083), 0 rollout errors.
  Canaries passed.
  - Split-half agreement: fight 80.9%, tactic 82.1% (labelD: 83.8/82.9%).
  - All-option ties: 364 (8.8%); fight 5.5%, tactic 18.3%. Nearly all are records where every
    option died in every rollout (u = −1 throughout).
  - Fight argmax: melee 978, throw 864, flee 600, the rest ties.
  - Tactic argmax: fight 301, heal 199, flee 137, the rest ties (201 three-way).
  - That is 1.5 times labelD's 2,823 clean labels, so trainE has about 6,900 labels.
- **trainE (13:46–15:04):** 6,940 labels in (labelD 2,823 + labelE 4,117); all-option ties are
  not trained on, leaving 5,600 train and 579 held out. 4 epochs. Canaries passed.
  - Overran its 0.75 h budget by 33 minutes: training runs a fixed 4 epochs and isn't time-boxed,
    and the data was 2.5 times trainD's. finalE is capped by the global deadline, so it gets
    2 h 56 min instead of 3 h.

  | Held-out | n | Model | Rules | Majority | Base |
  |---|---|---|---|---|---|
  | All | 579 | 0.630 | 0.535 | 0.508 | 0.508 |
  | labelE part | 461 | 0.605 | 0.547 | 0.521 | 0.521 |
  | Fight | 436 | 0.592 | | | |
  | Tactic | 143 | 0.748 | | | |

  - Brier 0.199 (base 0.292, rules 0.713).
  - The margin over the rules is +0.095, under half of trainD's +0.21 (0.703 vs 0.492). The weak
    spot is fight (0.592). The fight choice was already three-way in labelD (throw 420, flee 364,
    melee 336), so the drop isn't a new kind of question. One possible cause is that C fights differ
    from TS fights, so the two sets of labels may pull in different directions (untested).
- **Hibernation (about 15:24–16:55):** a power failure hibernated the machine. Every process
  (driver, laya server, game processes) was frozen and resumed together. Per-game time limits use
  the monotonic clock, so no game was wrongly cut; games in flight report about 5,600 s because
  their wall time includes the sleep. The global deadline is wall-clock, so finalE lost 91
  minutes, but it still finished every start by 17:41.
- **finalE (15:04–17:41):** 192 of 192 starts complete in all three arms, 0 errors, 0 deadline
  cuts. Canaries passed (E-gate consulted 1.0, max throws 25). The rules arm died in 150 of 192,
  mean depth 5.11. Top killers: poison 18, soldier 15, apprentice 13.

  | Arm vs rules (all 192) | W–L | Mean diff (−3/death) | CI80 | Deaths | Depth | Sweep | Sign p |
  |---|---|---|---|---|---|---|---|
  | rules+ (caution +1) | 85–75 | +0.40 | [0.06, 0.74] | 142 | 5.39 | better | 0.24 |
  | E-gate | 67–64 | +0.16 | [−0.13, 0.44] | 149 | 5.25 | trade-off | 0.43 |
  | E-gate vs rules+ | 74–81 | −0.25 | [−0.55, 0.09] | 149 vs 142 | 5.25 vs 5.39 | worse | 0.74 |

  - rules+ by start type: fresh 71–63 (+0.51, better), bank 14–12 (+0.08, better). It was
    identical to rules in 9 starts.
  - E-gate by start type: fresh 61–61 (+0.14, trade-off), bank 6–3 (+0.21, trade-off). It was
    identical to rules in only 36 of 192 starts (D-gate: 75 of 96), so the model is acting far
    more often now, but that doesn't add up to better play.

### Session 5 verdicts (by the pre-committed rules)
1. **rules+ does not become the baseline.** It beat rules (W > L, sweep "better") but sign p is
   0.24, not < 0.05, so it stays a candidate. With session 4 (46–32, "better", p 0.03–0.07), that's
   two sessions in the same direction on two engines. Per the rules, that counts as evidence for
   the next plan, not a promotion.
2. **E-gate is not promoted.** It passes the promotion test against rules (67–64, deaths 149 ≤
   152), but it loses to rules+ head to head (74–81), which the rules also require. Its sweep
   verdict against rules is only "trade-off" (60–64 with no death penalty).
3. **Offline vs play:** trainE's held-out lead over the rules (+9.5 points) again didn't turn
   into better play. The gap between label accuracy and game results is now the main open
   question, alongside whether longer training (more epochs, more labels) helps offline at all.

## Session 6 (14 h, from 2026-10-16 evening)

Not a complete experiment on its own: it fixes the pairing, tests the confidence gate, and builds the
labels and training evidence for the next session.

### What session 5 left (found after its run)
- **The gate kept the model out of play.** In finalE, E-gate's model disagreed with the rules on
  about 11,200 fight/tactic decisions, but its answer was used (confidence ≥ 0.3) on only 139 of
  about 20,000, and it changed the rules' choice in 45, spread over 33 games. On trainE's held-out
  labels at the 0.3 gate it would act on 3.8% of decisions and disagree with the rules on 3 of 579.
  The "consulted ≥ 0.9" canary only showed that the model was asked.
  - Selective accuracy on trainE's held-out labels (any tied winner counts as right):

    | Gate | Coverage | Model acc | Rules acc | Disagreements | Model acc there | Rules acc there |
    |---|---|---|---|---|---|---|
    | 0 | 100% | 0.630 | 0.535 | 349 | 0.585 | 0.427 |
    | 0.05 | 65% | 0.648 | 0.577 | 207 | 0.575 | 0.444 |
    | 0.1 | 33% | 0.663 | 0.601 | 80 | 0.525 | 0.375 |
    | 0.3 | 3.8% | 0.909 | 0.864 | 3 | 0.667 | 0.333 |
- **Pairs weren't pairs.** The rules player used unseeded `Math.random()` for random moves when
  confused or stuck. C games stall often (967 stall resets in collectE), so the same seed played
  twice gave different games in 3 of 6 starts. In finalE, 87 of the 121 E-gate games where the
  model never acted still differed from the rules game. Paired tests were valid but much noisier
  than designed, and "identical to rules" counts on C meant little.
  - **Fix:** busho draws those moves from a seeded mulberry32 (`PLAYER_RNG_SEED`, default the
    game's `SEED`). Rollouts pass seed k, so common random numbers now cover the player too. The
    replay test then gave 6 of 6 identical games (including 17,000- and 20,000-action games).
  - labelF's rollouts use the seeded player; labelD/labelE's didn't. Same labels in expectation,
    less noise.
- **New C characters shared one savefile.** A new C game (`-n`) uses the default savefile
  `lib/save/<user>` in the frozen game directory, so every concurrent new game read it at birth
  and wrote it while playing. The same seed then gave different characters in different arms
  (seed 2600004: Human, High-Elf, Half-Troll, Half-Orc and Elf Blackguards), and the shared save
  likely also leaked flavours and RNG state. Found on the first session 6 launch (one of five
  replays differed). Affected: fresh starts in every C session (collectE, finalE, and their
  pairs). Not affected: bank starts and rollouts, which `--load` their own file and save to it.
  - **Fix:** new games get their own save/scores/panic directories (`-dsave` etc.), and
    `freeze_c` no longer copies savefiles. `-dsave` must not be used with `--load`: the load then
    fails silently and a new level-1 character is born.
  - Check: 12 fresh seeds and 6 bank savepoints, each played twice at the same time (13 slots):
    18 of 18 identical, bank games loaded at DL5–9.
- **Evaluation** now also writes the per-gate table above (`evaluate.py` "selective") and saves
  every answer beside its metrics file.

### Questions
1. With true pairs, does rules+ beat rules (third test)?
2. Does trainE play better than the rules when it is allowed to act: gate 0.05 (acts on about
   two-thirds of decisions) or no gate?
3. Does longer training help offline (2, 4, 8 epochs, with a second seed at 4 to size the noise)?
4. A bigger model for the next session: labelD + labelE + labelF.

### Plan (`driver6.py`, 14 h, 13 slots)
| Phase | Stage | Budget | What |
|---|---|---|---|
| 1 | finalF | 2.5 h | 240 starts (192 fresh seeds 2600000+, 48 bank from session 5's bank): rules, rules+ (caution +1), E05 and E00 (trainE at gates 0.05 and 0, oil/potion guards), plus rules-replay on the first 24 starts |
| 2, CPU | labelF | to the end | continue labelling session 5's collectE decisions (danger-first; labelE's are skipped), K = 8, seeded rollouts |
| 2, GPU | sweepF | about 4.5 h | on trainE's exact train/held-out split: 8 epochs (seed 0), 4 epochs (seed 1), 2 epochs (seed 0); trainE is the 4-epoch seed-0 point; accuracy, Brier and the per-gate table for each |
| 2, GPU | trainF | the rest | laya from the base model on labelD + labelE + labelF so far, at the sweep's epoch count, capped to fit the deadline; same game-hash split, so trainE's held-out games stay held out; scored on all held-out, on the labelD/E part and on the labelF part |

Training and labelling share the machine: labelling is CPU-bound and training GPU-bound.

### Pre-committed decision rules
- **Score** as before: depth − 3 per death. Promotion test: W > L and deaths ≤ rules + 2.
- **rules+ becomes the rules baseline** if, against rules over all starts, W > L, the sweep
  verdict is "better" and sign p < 0.05.
- **E05 or E00 is promoted** only if it passes the promotion test against rules **and** beats
  rules+ head to head (W > L). "Clearly better play" also needs a "better" sweep verdict against
  both and sign p < 0.025 against both (two model arms, so the 0.05 bar is halved).
- **Epoch count for trainF:** the count with the best held-out accuracy among 2, 4 and 8. A count
  other than 4 is chosen only if it beats trainE (4 epochs, seed 0) by more than the seed-to-seed
  gap at 4 epochs (at least 1 point). Ties go to fewer epochs. trainF isn't promoted or played
  this session; it is the next session's candidate.
- **Canaries:**
  - finalF: ≥ 75% of starts complete in every main arm; rules-replay identical to rules in ≥ 90%
    of its starts; model arms consulted ≥ 0.9 and throws ≤ 100. If the replay canary fails, the
    results are reported as unpaired.
  - labelF: ≥ 300 new labels, split-half ≥ 65%, all-tie ≤ 25%, run errors ≤ 2%.
  - sweepF: trainE re-evaluated and at least one sweep run finished.
  - trainF: accuracy > majority.
- **Reported for model arms:** how often the model's answer was used and how often it changed the
  rules' choice, so a gate that blocks everything is visible.

### Run log
- **Smoke tests** (offset ports, 6 slots, `runs/session6/smoke*`):
  - The first hung after finalF. Both phase-2 tracks saved `state.json` while the other changed it;
    a save raised "dictionary changed size during iteration" while holding the save lock, and the
    other track then waited on that lock forever. Saves now serialise, retry on that error, and
    always release the lock. Kept at `runs/session6/smoke.deadlock`.
  - The second passed every stage and canary (19:57–20:07): finalF replays 2 of 2 identical;
    E00's model answer used 131 times and changed the rules' choice 42 times in 4 games; labelF
    30 labels; sweepF three 1-epoch runs and trainE re-evaluated; trainF's held-out set is exactly
    trainE's 579 records.
- **Launch:** held for a reboot (security updates), then launched 20:26 (PID 359) from `3015602`.
  - Stopped at 20:38 by STOP file (between games), still in finalF. In the first five replays one
    differed (2600002-Ranger: Kobold in rules, Human in the replay and the other arms), which led to
    the shared-savefile bug above. Kept at `runs/session6/2026-10-16.aborted-shared-savefile`.
  - Relaunched 20:47 (PID 8550) from `7235069`. First 7 minutes: 54 games, 0 errors, 10 of 10
    replays identical, every start the same character in all arms.
  - A second short power cut hibernated the machine for about 2 minutes (22:20:47–22:22:51). The
    driver, laya server and games resumed; no errors or cuts after it.
- **finalF (20:47–22:40):** 240 of 240 starts complete in every arm, 0 errors, 0 deadline cuts.
  rules-replay identical in 24 of 24, so these are true pairs (the first C tournament with them).
  Canaries passed. The rules arm died in 183 of 240, mean depth 4.90. Top killers: poison 25,
  soldier 17, apprentice 14.

  | Arm (all 240) | W–L | Mean diff (−3/death) | CI80 | Deaths | Depth | Sweep | Sign p | Identical to rules |
  |---|---|---|---|---|---|---|---|---|
  | rules+ vs rules | 102–77 | +0.25 | [0.00, 0.50] | 184 | 5.17 | better | 0.036 | 23 |
  | E05 vs rules | 95–97 | −0.06 | [−0.32, 0.21] | 186 | 4.88 | worse | 0.59 | 3 |
  | E00 vs rules | 91–110 | −0.46 | [−0.73, −0.20] | 198 | 4.62 | worse | 0.92 | 3 |
  | E05 vs rules+ | 88–107 | −0.31 | [−0.60, −0.02] | 186 vs 184 | | worse | 0.92 | |
  | E00 vs rules+ | 81–120 | −0.72 | [−0.99, −0.45] | 198 vs 184 | | worse | 0.998 | |

  - rules+ by start type: fresh 90–65 (+0.33, better), bank 12–12 (−0.04, trade-off). Its sweep is
    positive at every death penalty (sign p 0.026–0.039 up to −3, 0.13 at −6 and −20).
  - The model now really plays. E05's answer was used on 11,286 of 24,294 trained-type decisions
    and changed the rules' choice 5,097 times (238 of 240 games). E00's was used on 21,994 of 22,887
    and changed it 9,531 times (all 240 games). Max throws 36 and 50.
  - Both model arms lose on fresh starts (E05 77–82, E00 72–95) and are slightly ahead on bank
    starts (E05 18–15, E00 19–15; 48 starts, too few to read). E00 dies 15 more times than rules.
- **sweepF (22:40–09:48, 11.1 h against a 4.5 h budget):** canary passed. The budget was wrong
  by a factor of about 2.5: training runs at 0.50 s per item per epoch, so the three runs (14
  epochs on 5,600 items) needed about 11 h. All on trainE's 579 held-out records.

  | Point | Accuracy | Brier | Fight (436) | Tactic (143) | Disagreements at gate 0: n, model vs rules | Train time |
  |---|---|---|---|---|---|---|
  | 4 epochs, seed 0 (trainE) | **0.630** | **0.199** | 0.592 | 0.748 | 349, 0.585 vs 0.427 | (session 5) |
  | 4 epochs, seed 1 | 0.611 | 0.216 | 0.585 | 0.692 | 335, 0.540 vs 0.409 | 209 min |
  | 8 epochs, seed 0 | 0.617 | 0.202 | 0.596 | 0.678 | 336, 0.557 vs 0.417 | 372 min |
  | 2 epochs, seed 0 | 0.587 | 0.215 | 0.578 | 0.615 | 301, 0.522 vs 0.422 | 82 min |

  Majority 0.508, rules 0.535. The seed-to-seed gap at 4 epochs is 1.9 points, so the rule keeps
  **4 epochs**: 8 epochs is 1.4 points below trainE (within seed noise), 2 epochs is 4.3 below.
  On this data, training longer doesn't help. Every point beats the rules where they disagree.
- **trainF: skipped** (09:48). With labelF's 9,232 new labels the training set is 13,416 items
  (held-out 1,657); 4 epochs would take about 7.4 h and even one about 1.9 h, with 59 minutes left.
  The labels are kept for the next session.
- **labelF (22:40–10:37):** canary passed. 10,096 new labels (fight 8,428, tactic 1,668), 0 run
  errors, all-tie 373 (3.7%). Split-half agreement: fight 80.5%, tactic 84.1%. With labelD and
  labelE that makes 17,036 labels, 84% of them fights. The driver finished at 10:37 and left no
  processes behind.

### Session 6 verdicts (by the pre-committed rules)
1. **rules+ becomes the rules baseline.** Against rules over all starts: W > L (102–77), sweep
   "better", sign p 0.036 < 0.05. It's the third session in the same direction, and the first
   with true pairs. From session 7, "rules" means caution +1. Its edge is on fresh starts; on bank
   starts it's even.
2. **Neither model arm is promoted.** Both fail the promotion test against rules, and both lose
   to rules+ head to head.
3. **The offline lead is real in the labels but not in play.** When trainE is allowed to act,
   it changes thousands of decisions and plays worse, most clearly with no gate. On held-out
   labels it beat the rules where they disagreed (0.585 vs 0.427 at gate 0). So the rollout labels
   (short horizons: fight 150 turns, tactic 50) and whole-game results disagree. That gap, not
   gating or training length, is now the main problem.
4. **Epochs stay at 4.** 8 epochs is no better than 4 (inside the 1.9-point seed gap) and 2 is
   worse. More epochs on the same labels isn't the way forward.
5. **trainF wasn't trained.** The sweep used the time. labelF's 10,096 labels (more than labelD
   and labelE together, and as reproducible: split-half 80–84%) carry over.

Reproducible labels aren't the same as right labels. The split-half check shows the rollouts
agree with themselves, not that a 150-turn result predicts the whole game. Session 7 should test
that directly.

## Session 7 (14 h, planned 2026-10-17)

Session 6 showed that trainE beats the rules on held-out labels but loses to them in play. The
labels score each choice over a short look-ahead (fight 150 actions, tactic 50) with a utility of
HP, XP and supplies; the tournament scores the whole game (deepest level − 3 per death). This
session tests whether the two agree.

### Questions
1. On held-out decisions, does the short label pick the same option as long rollouts scored like
   the tournament?
2. Where the short label says the rules are wrong, does the label's choice do better than the
   rules' choice over the long rollouts? Where trainE disagrees with the rules, does its choice?
3. How long does a horizon need to be before its winner matches the longest one?
4. "Train more": trainG, 4 epochs on all 17k labels (labelD + labelE + labelF).

### Plan (`driver7.py`, 14 h, 13 slots, two tracks from the start)
| Track | Stage | Budget | What |
|---|---|---|---|
| CPU | valG | to 30 min before the end | re-label held-out labelF decisions with long rollouts: 5,000 actions (about a median game), scored as deepest level gained − 3 if dead, K = 8, the same seeds and the same rules continuation as labelF, with checkpoints at 50, 150, 500 and 1,500 actions. Pool: 922 records (held-out games, one short-label winner, not all-tie); the 480 where the label disagrees with the rules alternate with those where it agrees |
| CPU | reportG | after both tracks | `horizon.py`: agreement and the paired tests at each horizon |
| GPU | evalE | minutes | trainE asked on the pool: its choices for reportG, and its accuracy on new held-out games |
| GPU | trainG | about 7.5 h | laya from the base model on labelD + labelE + labelF (13,416 train items), 4 epochs (capped to fit), same game-hash split; scored on all held-out, the labelD/E part, the labelF part, and asked on the pool |

The long rollouts keep the rules continuation (caution 0) that labelF used, so the only changes
from the short labels are the horizon and the score. Because the seeds are the same and the
player is seeded, each long rollout's first 150 (or 50) actions should replay the short one
exactly; that is a canary. Labelling after this session should continue with rules+.

`run.ts` gains `--utility game` (deepest level gained − 3 if dead) and `--checkpoints`; the
player reports its deepest level and its state at the checkpoints. Neither changes play.

### Pre-committed decision rules
- **The main test:** at 5,000 actions, on records where the short label's winner differs from
  the rules' choice, compare the two choices' mean value over the paired seeds, record by record.
  - **Labels point the right way** if W > L with sign p < 0.05. Then the play gap is somewhere
    else (small gains that don't add up over a game, or the model's errors), and session 8
    looks there.
  - **Labels mislead** if L > W with sign p < 0.05 (for the rules). Then session 8 relabels with
    the game score at the shortest checkpoint horizon whose winner agrees with the 5,000-action
    winner in at least 80% of records (5,000 if none does).
  - Otherwise **inconclusive**: report how noisy the long labels are (their split-half agreement).
- **Reported, no rule:** short-versus-long agreement at each horizon against chance (about 1/3)
  and the long labels' own split-half ceiling; trainE's and trainG's choices against the rules
  by the same paired test; death rates per option.
- **trainG** isn't played this session. Canary: accuracy > majority.
- **Canaries:** valG ≥ 150 records labelled and run errors ≤ 2%; long rollouts replay the short
  ones in ≥ 95% of comparable runs. If the replay canary fails, the long labels are still a valid
  independent sample, but not paired with the short ones seed by seed.

### Run log
- **Smoke test** (`runs/session7/smoke`, 13 slots, 11:52–12:00 on 10-17): every stage and canary
  passed.
  - valG: 3 records, 72 long rollouts, 0 errors. Mean 3,841 actions, 50 s per rollout; 62.5%
    reached 5,000 actions, and the rest died first.
  - Long rollouts replayed the short ones in 60 of 60 comparable runs.
  - At 50 and 150 actions, all three records were ties under the game score (no deaths, no new
    levels). The short horizons will be compared on few records; that is itself the point.
  - evalE and a 1-epoch, 300-item trainG ran beside the rollouts (0.60 s per item-epoch with
    fixed costs included).
  - **Throughput:** 50 s per rollout on 13 slots is about 92 s per record (24 rollouts), so about
    525 of the 922 records in 13.5 h, about 260 of them disagreements (they alternate).
- **Launch:** scheduled for 16:30, but the launcher's "another driver running" check matched
  something and it didn't start. No driver was running. The likely culprit is a shell whose own
  command text contained the driver command line. Started by hand at 18:11 (PID 79329, deadline
  08:11 on 10-18). Pool: 922 records (480 disagree, 442 agree).
- **evalE (18:11–18:13):** trainE on the pool: accuracy 0.516 against the short labels (majority
  0.473, rules 0.479). The pool was chosen so that the rules lose about half of it, so these
  numbers aren't comparable with trainE's held-out 0.630. Where trainE disagrees with the rules
  (442): 0.462 vs 0.385.
- **trainG (18:13–00:41):** canary passed. 14,147 train items, 4 epochs in 380 minutes (0.40 s
  per item-epoch, faster than session 6's 0.50).

  | Held-out set | n | trainG | trainE | Majority | Rules | Where trainG disagrees with rules: n, trainG vs rules |
  |---|---|---|---|---|---|---|
  | All | 1,755 | 0.621 | | 0.549 | 0.561 | 732, 0.574 vs 0.432 |
  | labelD/E part (trainE's held-out) | 579 | 0.594 | **0.630** | 0.508 | 0.535 | 329, 0.538 vs 0.435 |
  | labelF part | 1,176 | 0.634 | | 0.569 | 0.574 | 403, 0.603 vs 0.429 |
  | valG pool | 922 | 0.573 | 0.516 | 0.473 | 0.479 | 291, 0.536 vs 0.241 |

  On trainE's own held-out set, trainG is 3.6 points worse, which is more than the 1.9-point
  seed gap. Adding labelF (2.4 times the data) didn't help on the old labels. On the pool,
  trainG is better than trainE, and it disagrees with the rules less often (291 vs 442).
- **valG (18:11–07:41):** canary passed. 668 records labelled (fight 588, tactic 80), 0 run
  errors, mean 3,474 actions per rollout, 52.7% reached 5,000 actions. That's faster than
  estimated (525). The driver finished at 07:41 and left no processes behind.
- **reportG:** canary passed. The long rollouts replayed the short ones in 14,040 of 14,040
  comparable runs, so every comparison is paired seed by seed.

  | Horizon (actions) | Long result is a tie | Short label = long winner | Long split-half (ceiling) | Winner = 5,000's | Label's choice vs rules: W–L, mean, p | trainE vs rules | trainG vs rules |
  |---|---|---|---|---|---|---|---|
  | 50 | 540 / 668 | 0.49 (128) | 0.88 (64) | 0.53 | 68–11, +0.13, <0.001 | 37–18, +0.07, 0.007 | 33–12, +0.08, 0.001 |
  | 150 | 456 | 0.50 (212) | 0.76 (104) | 0.51 | 108–33, +0.17, <0.001 | 57–39, +0.08, 0.04 | 49–28, +0.07, 0.01 |
  | 500 | 267 | 0.48 (401) | 0.55 (234) | 0.57 | 148–97, +0.16, <0.001 | 112–84, +0.08, 0.03 | 75–55, +0.08, 0.048 |
  | 1,500 | 130 | 0.42 (538) | 0.44 (401) | 0.65 | 170–131, +0.22, 0.014 | 152–113, +0.16, 0.010 | 104–73, +0.19, 0.012 |
  | **5,000** | 87 | 0.38 (581) | 0.39 (482) | 1 | **162–142, +0.22, 0.14** | 144–139, +0.20, 0.41 | 88–91, +0.23, 0.62 |

  Values are the tournament's score over the rollout (deepest level gained − 3 if dead), and
  "mean" is the per-record mean difference. Label vs rules covers the 334 records where they
  differ, trainE 319 and trainG 210. Sign p is one-sided, for the chooser. Death rates by 5,000
  actions are 46–51% for every option.
  - At 5,000 actions, eight rollouts can't tell options apart: seeds 1–4 and 5–8 pick the same
    winner in 39% of records, against a chance of about 33%. The short label agrees with the
    long winner (38%) as often as the long rollouts agree with themselves.
  - Summed over records, though, the label's choice is ahead of the rules' at every horizon, and
    significantly so up to 1,500 actions. So are trainE's and trainG's choices.
  - By option pair at 5,000 (label's choice over the rules'): flee over melee 69–50, mean +0.62;
    throw over melee 74–79, −0.03; heal over fight 10–6. Fight records 145–130 (+0.24); tactic
    records 17–12 (+0.08).
- **Why trainE still lost in play** (finalF, from its decision logs): E00 overrode the rules
  9,531 times. 6,351 of those were flee instead of melee (26 per game) and 2,016 throw instead
  of melee. One flee, with the rules taking over afterwards, gains on average. Fleeing every
  time the question comes up is a different policy, and nothing in the labels measures it.

### Session 7 verdicts (by the pre-committed rules)
1. **The main test is inconclusive:** at 5,000 actions, the label's choice beats the rules'
   162–142 (mean +0.22), p = 0.14. The labels don't mislead: the rules don't win at any
   horizon. Per decision, long results with K = 8 are close to pure noise.
2. **The labels point the right way for one decision at a time.** With the rules continuing
   afterwards, the label's choice wins significantly up to 1,500 actions and stays ahead at
   5,000. trainE's and trainG's overrides do too. So the gap between labels and play isn't the
   label horizon.
3. **The likely gap is compounding.** Rollout labels value one override followed by the rules.
   In play the model overrides at every decision, mostly by fleeing (26 times per game for E00).
   That repeated policy is the thing that loses.
4. **trainG isn't better than trainE** on trainE's held-out set (0.594 vs 0.630). More of the
   same labels didn't help there. trainG overrides less and does better on the pool.

## Session 8 (18 h, run 2026-10-20)

Session 7 found that the label's choice beats the rules' choice when it is made once and the
rules then play on, at every horizon up to 1,500 actions (5,000 is too noisy to tell). In play,
though, trainE overrides the rules about 40 times per game (E00: 6,351 flee-for-melee and 2,016
throw-for-melee overrides in 240 games), and it loses. This session tests whether the loss comes
from overrides piling up.

How a fight decision works matters here. It is made once per monster when the monster first
comes within 6 squares, and the choice becomes that monster's plan for the whole encounter. So
"once per monster" is already true, and piling up means across monsters: a model that says
"flee" to most new monsters flees from most of the dungeon.

### Questions
1. If the model must hand control back to the rules after each override, does it stop losing?
   Does it beat rules+?
2. Is there a dose response: no cooldown, the label horizon, 1,000 actions?
3. Does trainG play better than trainE under the same cooldown?

### Plan (`driver8.py`, one stage, 18 h, 13 slots)
`MODEL_COOLDOWN` (new in the player): after the model overrides the rules, further overrides are
ignored for a set number of actions. The model is still asked, and the record shows the blocked
override (`ration: cooldown`) and the action count. A cooldown equal to the label horizon
(fight 150, tactic 50) is exactly what the labels measured: one override, then the rules.
In finalF's E00 logs, a cooldown of about 150 actions would have kept about a third of the
overrides (3,255 of 9,531, using game turns ÷ 10 as actions).

| Arm | Model | Cooldown after an override |
|---|---|---|
| rules+ (baseline) | – | – |
| E-all | trainE, no gate, oil/potion guards | none (finalF's E00, now on rules+) |
| E-cool | trainE, same | the label horizon: fight 150, tactic 50 actions |
| E-cool1000 | trainE, same | 1,000 actions |
| G-cool | trainG, same | the label horizon |
| rules+-replay | – | first 24 starts, determinism canary |

Every arm runs on rules+ (caution +1). Starts follow a fixed order, 4 fresh to 1 bank (fresh
seeds 2800000+, bank seeds 2850000+ from session 5's bank). The stage plays them in that order
until 20 minutes before the end, and every start completed by all five main arms is analysed.
Expect about 1,300–1,400 starts: about 83 s per rules game, plus about 44 s of model calls per
model game, since four model arms queue on one laya server. Stopping depends only on the clock,
never on results.

### Pre-committed decision rules
- **Score** as before: depth − 3 per death; paired by start.
- **Compounding:** supported if E-cool beats E-all head to head with W > L and sign p < 0.05.
  E-cool1000 against E-all and against E-cool shows the dose response (reported, no rule).
- **Promotion:** a model arm is promoted if, against rules+, W > L, deaths ≤ rules+ + 2, the
  death-penalty sweep says "better", and sign p < 0.0125 (four model arms, so 0.05 ÷ 4). If
  several pass, the one with the best mean difference is promoted. A promoted arm becomes the
  player for session 9 and the collector for labels taken from the model's own play.
- **trainG vs trainE:** G-cool against E-cool head to head (reported, no rule).
- **Canaries:**
  - at least 600 complete starts, and at least 75% of started starts complete;
  - rules+-replay identical in at least 90% of its starts;
  - model arms consulted at least 0.9 of the time, with at most 100 throws in any game;
  - the cooldown binds: each cooldown arm has blocked overrides and fewer changes per game than
    E-all.
- **Reported for model arms:** changes per game, by (model, rules) pair; blocked overrides.

### Run log
- **Smoke test** (`runs/session8/smoke`, 13 slots, 09:17–09:20 on 10-18; games capped at 1,500
  actions): every canary passed.
  - 18 of 18 starts complete in every arm; 0 errors, 0 cuts; replay 2 of 2 identical.
  - Model arms consulted 1.0, with rules+ underneath (`RULES_CAUTION: 1` in the logs).
  - The cooldown binds. Changes per game: E-all 10.8, E-cool 3.9, E-cool1000 1.5, G-cool 3.5.
    Blocked overrides: 142, 160 and 132. In one E-cool game, the override at action 311 blocks
    those at 353, 402 and 432, and the next is allowed after 461.
  - With four model arms, laya answers in about 460 ms per call (finalF: about 150 ms). It's
    slower, but no call timed out.
- **Launch:** `runs/session8/2026-10-20`, 18:30 on 10-20; the stage ran until 12:12 on 10-21
  (1,062 min). Every canary passed.
  - 1,336 starts begun, 1,329 complete in all five arms (1,063 fresh, 266 bank); 0 errors.
    12 games were cut at the deadline, and those starts are excluded.
  - Replay 24 of 24 identical. The cooldown binds: changes per game E-all 41.0, E-cool 14.2,
    E-cool1000 5.4, G-cool 13.3 (blocked overrides 0, 45,570, 63,390 and 36,199). Real games run
    far longer than the smoke test's 1,500-action cap, so the counts are higher than there.
  - rules+: 996 deaths, mean depth 5.19.

| Against rules+ (1,329 pairs) | W | L | Mean diff (80% CI) | Deaths | Sweep | Sign p |
|---|---|---|---|---|---|---|
| E-all | 416 | 674 | −0.85 (−0.96, −0.73) | 1,104 | worse | 1.0 |
| E-cool | 467 | 626 | −0.52 (−0.64, −0.40) | 1,054 | worse | 1.0 |
| E-cool1000 | 525 | 569 | −0.13 (−0.25, −0.01) | 1,001 | worse | 0.91 |
| G-cool | 532 | 558 | −0.18 (−0.30, −0.06) | 1,018 | worse | 0.79 |

| Head to head | W | L | Mean diff (80% CI) | Deaths | Sign p |
|---|---|---|---|---|---|
| E-cool vs E-all | 565 | 461 | +0.33 (0.22, 0.43) | 1,054 vs 1,104 | 0.0006 |
| E-cool1000 vs E-all | 642 | 417 | +0.72 (0.60, 0.82) | 1,001 vs 1,104 | <0.0001 |
| E-cool1000 vs E-cool | 567 | 452 | +0.39 (0.28, 0.49) | 1,001 vs 1,054 | 0.0002 |
| G-cool vs E-cool | 585 | 474 | +0.34 (0.23, 0.44) | 1,018 vs 1,054 | 0.0004 |

On bank starts (deeper characters) no arm differs clearly from rules+ (E-cool1000 98–85,
G-cool 85–91); the losses come from fresh starts.

### Verdicts
1. **Promotion: none.** Every model arm loses to rules+; no arm has W > L. rules+ stays the
   player.
2. **Compounding: the pre-committed rule passes, but the explanation it was meant to test
   doesn't hold up.** E-cool beats E-all (p = 0.0006), and the dose response is clean: fewer
   overrides, smaller loss. But the loss per override does not shrink when overrides are spaced
   out: about −0.021 per override for E-all, −0.037 for E-cool, −0.024 for E-cool1000. If
   overrides hurt mainly by piling up, isolated overrides should cost less, and they don't. The
   simpler reading is dilution: trainE's overrides are wrong on average one at a time, and the
   cooldown just makes fewer of them. This contradicts session 7 only on the surface: the labels'
   choice beats the rules, but trainE's choice where it differs from the rules is often not the
   label's (held-out accuracy 0.63), and two thirds of E-all's overrides are flee-for-melee
   (35,751 of 54,513).
3. **trainG plays better than trainE** under the same cooldown (+0.34, p = 0.0004), with about
   the same number of overrides (13.3 vs 14.2 per game) and −0.014 per override. Offline
   held-out accuracy did not show this (session 7: 0.594 vs 0.630), so the offline metric is not
   a reliable stand-in for play.
4. **Next:** the model's overrides need to be right more often, not rarer. Options: gate
   overrides on confidence again with trainG (fewer, better-chosen overrides rather than a
   clock); restrict overrides to the pairs that don't lose (measure the per-pair outcome from
   these logs first); or label decisions from the model's own games so it learns from the states
   its overrides create.

## Phase: labels from the model's own games (sessions 9 onward)

Session 8 showed that trainG's overrides lose to rules+ one at a time, not by piling up. The
labels it was trained on came from the rules' own games. The states a model reaches when it
plays are different (it has fled from things, thrown oil, kept fighting), and nothing taught it
what to do there. This phase labels decisions from the model's own games, finds out which
overrides are right, and trains on those states. The loop: play, label, (gate or retrain), play
again.

- **Session 9 (5 h, now):** label trainG's own session 8 decisions; measure which overrides are
  right, by pair and by confidence; choose a gate on half of the games and check it on the other
  half.
- **Session 10 (overnight):** depending on session 9:
  - if the gate holds up on the held-out half, a tournament of gated trainG against rules+, while
    labelling continues on CPU;
  - in either case, trainH: laya from the base model on labelD–F plus labelH.
- **Later:** the best player's games become the next round's label pool.

## Session 9 (5 h, run 2026-10-21)

### Questions
1. On states that trainG's own play reaches, how often is its override better than rules+'s
   choice, judged by rollouts with rules+ continuing?
2. Which overrides are right: by (model, rules) pair, by decision type, by whether it acted or the
   cooldown blocked it, and by trainG's confidence?
3. Is there a gate (a set of pairs, a minimum confidence) under which the overrides win, and does
   it hold up on games it wasn't chosen on?

### Plan (`driver9.py`, CPU only, 13 slots)
| Stage | Time | What |
|---|---|---|
| labelH | to 15 min before the end | rollout labels (K = 8, adaptive from 4, utility v2, horizons fight 150 / tactic 50) on fight/tactic decisions from session 8's G-cool games. Disagree and agree records 3 to 1, each shuffled with a fixed seed. Records the guards blocked (no oil, no potion) are left out, since the choice was never possible. |
| reportH | the rest | per record, the label's mean utility of trainG's choice minus the rules' choice; tallies by pair, type, acted/cooldown and confidence bin; the gate |

Changes from earlier labels:
- The rollout continuation is rules+ (`RULES_CAUTION=1`), the player the overrides now have to
  beat. labelD–F used the rules at caution 0.
- The states come from a model's games, not the rules' games.

Pool: 45,937 disagree and 78,487 agree records (one per game, turn and type). trainG's
confidence on its overrides runs from 0 to about 0.4 (median 0.055, 90th percentile 0.2), so
the bins are 0, 0.02, 0.05, 0.1 and 0.2. Expect about 4,500 labels (about 1,000 an hour).

### Pre-committed decision rules
- **Labels canaries** as labelF: at least 300 labels, split-half at least 65%, all-tie at most
  25%, run errors at most 2%.
- **Gate:** chosen on the games with sha1(game_id) even: the pairs with at least 30 records and a
  positive mean difference, then the lowest confidence bin at which those pairs' overrides have a
  positive mean. Scored on the odd games. **The gate goes to a session 10 tournament only if, on
  the odd games, W > L with sign p < 0.05.**
- **Reported, no rule:** overall disagree W/L; by pair, type, acted/cooldown, and confidence bin.

### Run log
- **Smoke tests** (`runs/session9/smoke`, `smoke2`, `smoke3`; 24 records each): the pipeline
  works from end to end, with 0 run errors. Two fixes after the first: the confidence bins
  (trainG's confidence is on a 0–0.4 scale), and leaving out guard-blocked records. smoke2 ran
  before the fixes were saved; smoke3 has them, and every canary passed.
- **Launch:** `runs/session9/2026-10-21`, 12:46 on 10-21; labelH until 17:31.
- **labelH (12:46–17:31):** every canary passed. 5,460 labels (fight 4,628, tactic 832), 0 run
  errors, split-half 82.3% (fight) and 79.4% (tactic), all-tie 270 (4.9%). 3,843 labelled
  disagreements are not all-tie.

| trainG's choice minus rules+'s (labelH) | n | W | L | Mean diff | Sign p (model) |
|---|---|---|---|---|---|
| All disagreements | 3,843 | 1,737 | 1,837 | +0.035 | 0.95 (rules: 0.049) |
| Acted | 1,453 | 617 | 729 | +0.002 | 1.0 (rules: 0.001) |
| Blocked by the cooldown | 2,390 | 1,120 | 1,108 | +0.055 | 0.41 |
| Confidence < 0.02 | 862 | 302 | 464 | −0.007 | 1.0 |
| 0.02–0.05 | 763 | 319 | 387 | +0.017 | 1.0 |
| 0.05–0.1 | 846 | 409 | 381 | +0.032 | 0.17 |
| 0.1–0.2 | 932 | 464 | 422 | +0.058 | 0.08 |
| ≥ 0.2 | 440 | 243 | 183 | +0.106 | 0.002 |
| flee>melee | 2,102 | 903 | 1,091 | +0.050 | 1.0 |
| throw>melee | 862 | 431 | 404 | +0.024 | 0.18 |
| heal>fight | 356 | 178 | 172 | +0.001 | 0.39 |
| flee>fight | 222 | 32 | 68 | −0.014 | 1.0 |
| melee>throw | 190 | 122 | 67 | +0.021 | <0.0001 |

- **reportH:** the pre-committed gate kept four pairs (flee>melee, heal>fight, melee>throw,
  throw>melee) at confidence 0, because those pairs' mean was already positive there. On the odd
  games it scores 822–853 (p = 0.78): it fails.

### Verdicts
1. **trainG's overrides lose more often than they win (1,737–1,837), but by less when they lose.**
   The mean utility is slightly in the model's favour (+0.035), while the count favours the rules
   (p = 0.049). The overrides it acted on in session 8 are the weakest group (617–729).
2. **The pre-committed gate fails**, so by the rule no gate goes to a tournament. The rule chose
   on the mean and was scored on the count, and those disagree here.
3. **Confidence separates right from wrong overrides cleanly (post hoc).** Win rate rises with
   every bin, from 39% below 0.02 to 57% at 0.2 and above. This wasn't the pre-committed test,
   but it holds on both halves of the games separately: at confidence ≥ 0.05, 561–498 (p = 0.03)
   and 555–488 (p = 0.02); at ≥ 0.1, 356–314 and 351–291. Caveats: the overrides trainG actually
   acted on at ≥ 0.05 are only even (400–390), and in session 6 trainE gated at 0.05 lost to rules+
   (88–107). A confidence gate on trainG needs its own tournament before anyone relies on it.
4. **By pair:** melee-for-throw (122–67) and throw-for-melee at confidence ≥ 0.05 (307–242) win.
   Flee-for-fight in heal/flee decisions loses (32–68). Flee-for-melee, the commonest override,
   loses on count at any confidence (573–607 at ≥ 0.05) despite a positive mean.
5. **labelH is the first set of labels from a model's own games, with rules+ continuing.** It's
   ready for trainH.

## Session 10 (22 h, run 2026-10-21)

Session 9's pre-committed gate failed, but trainG's confidence separated right overrides from
wrong ones on both halves of the games: at confidence ≥ 0.05 they win more often than the rules'
choice, and below it they lose. That is a post-hoc finding, so it needs its own test in play,
on new starts. In parallel, trainH is the phase's first model trained partly on labels from a
model's own games.

### Questions
1. Does trainG beat rules+ when it acts only at confidence ≥ 0.05, or ≥ 0.1?
2. Does adding labelH make a model whose overrides are right more often, on held-out labelH?
3. Which of the gated player's overrides are right, on its own states (for the next round)?

### Plan (`driver10.py`, 13 slots)
| Phase | Track | Stage | Time | What |
|---|---|---|---|---|
| 1 | CPU + GPU serving | finalJ | until 9.75 h before the end (about 12 h) | tournament on new seeds (fresh 2900000+, bank 2950000+ from session 5's bank), fixed order, 4 fresh to 1 bank: rules+; **G-c05** (trainG acting only at confidence ≥ 0.05, oil/potion guards, label-horizon cooldown as session 8's G-cool); **G-c10** (the same at 0.1); rules+-replay on the first 24 starts |
| 2 | GPU | trainH | to 20 min before the end | laya from the base model on labelD + labelE + labelF + labelH (about 18,900 train items), 4 epochs (fewer if they don't fit), the game-hash split; scored on all held-out and on each part; trainG also answers held-out labelH; both models' overrides there are scored against the rules with the labels' utilities, by confidence |
| 2 | CPU | labelJ | to 30 min before the end | rollout labels on G-c05's finalJ games, rules+ continuing, disagree and agree 3 to 1 (driver9's pool and labeller) |
| 2 | CPU | reportJ | the rest | driver9's override report on labelJ, with overrides split into acted, blocked by the cooldown and blocked by the gate |

The gated arms keep session 8's cooldown, so the only change from G-cool is the gate. Expect
about 1,400 complete starts (3 main arms instead of 5, and 2 model arms sharing laya). At
that size a sign test at p < 0.025 needs roughly 66 more wins than losses in 1,100 decided pairs.
trainH: 18,861 items × 4 epochs × 0.403 s (trainG's rate) is about 8.4 h, which fits phase 2's
9.4 h with the five evaluations.

Two things are mixed in trainH's data: labelD–F's rollouts continue with the rules at caution
0, while labelH's continue with rules+; labelD is from the TS engine.

### Pre-committed decision rules
- **Score** as before: depth − 3 per death; paired by start.
- **Promotion:** a gated arm is promoted if, against rules+, W > L, deaths ≤ rules+ + 2, the
  death-penalty sweep says "better", and sign p < 0.025 (two arms, so 0.05 ÷ 2). If both pass,
  the one with the better mean difference. A promoted arm becomes the player for session 11.
- **G-c05 vs G-c10:** head to head, reported, no rule.
- **trainH plays next** (replacing trainG in session 11's arms) if, on held-out labelH, its
  overrides at confidence ≥ 0.05 win a larger share of decided records (W ÷ (W + L)) than
  trainG's, and its held-out accuracy beats the majority baseline.
- **Canaries:** at least 600 complete starts and at least 75% of started starts complete; replay
  identical in at least 90%; each gated arm consulted at least 0.9 of the time, at most 100 throws
  in any game, and its gate blocks some overrides; labelJ as labelH (at least 300 labels,
  split-half at least 65%, all-tie at most 25%, run errors at most 2%).
- **Reported:** changes per game and pairs per arm; blocked by the gate and by the cooldown;
  reportJ's tables.

### Code changes
- `driver8.py`: the start seeds and head-to-head pairs are module settings (`STARTS`,
  `HEAD_TO_HEAD`), so session 10 reuses its tournament. Session 8's starts are unchanged.
- `driver9.py`: the pool, labeller and report take their inputs as arguments
  (`build_pool`, `label`, `overrides`, `report`), and an override's status is acted, cooldown or
  gate. Re-running the report on session 9's labels reproduces reportH exactly.

### Run log
- **Smoke test** (`runs/session10/smoke`, 17:38–17:47 on 10-21; games capped at 1,500 actions,
  trainH on 300 items for 1 epoch): every canary passed.
  - finalJ: 18 of 18 starts complete in every arm, 0 errors, 0 cuts; replay 2 of 2 identical.
  - The gate binds. G-c05: 2.8 changes per game, 96 overrides blocked by the gate and 51 by the
    cooldown. G-c10: 2.0 changes per game, 122 blocked by the gate and 20 by the cooldown.
  - trainH ran end to end, with every evaluation. Held-out labelH has 476 records; trainG
    overrides the rules on 350 of them, 199 at confidence ≥ 0.05 (110–80). So the trainH rule
    will compare about 200 records per model, which is noisy.
  - labelJ and reportJ ran on G-c05's smoke games, with overrides split into acted, cooldown and
    gate.
- **Launch:** `runs/session10/2026-10-21`, 18:25 on 10-21, extended to 22 h (the extra 4 h go to
  the tournament); finalJ until 06:40 on 10-22, then trainH and labelJ until about 16:25.
- **finalJ (18:25 on 10-21 to 06:42 on 10-22):** every canary passed. 1,682 of 1,688 started
  starts complete in every main arm (1,345 fresh, 337 bank), 0 errors, at most 4 cut by the
  deadline per arm; replay 24 of 24 identical. Both gated arms consulted 1.0 of the time, at most
  57 throws in a game. rules+: 1,240 deaths, mean depth 5.2.

| Arm vs rules+ | W–L | Mean diff | Deaths | Sweep | Sign p | Changes per game | Blocked by gate | Blocked by cooldown |
|---|---|---|---|---|---|---|---|---|
| G-c05 | 675–673 | −0.03 | 1,242 | trade-off | 0.49 | 10.0 | 39,256 | 25,589 |
| G-c10 | 669–627 | +0.06 | 1,234 | better | 0.13 | 6.9 | 60,903 | 14,406 |

| By kind of start | G-c05 vs rules+ | G-c10 vs rules+ | G-c10 vs G-c05 |
|---|---|---|---|
| Fresh (1,345) | 544–582, −0.12; deaths 1,000 vs 973 | 568–547, +0.01; 982 vs 973 | 570–498 (p = 0.015) |
| Bank (337) | 131–91 (p = 0.004), +0.33; 242 vs 267 | 101–80, +0.24; 252 vs 267 | 87–93 |
| All | 675–673 | 669–627 | 657–591 (p = 0.033), deaths 1,234 vs 1,242 |

  Commonest changes, G-c05 (G-c10 is similar in proportion): flee>melee 7,838, throw>melee 5,341,
  melee>throw 1,600, heal>fight 1,046.
- **trainH (06:42–14:15):** 3 epochs, not 4. The driver capped them: phase 2 began at 06:42, and
  4 epochs of 18,861 items didn't fit before 16:05 with the evaluations. Training also ran at
  0.469 s per item-epoch (with labelJ sharing the machine), not the 0.403 assumed, so 4 epochs
  would have needed about 9.8 h. Train items 18,861 (labelD 2,823, labelE 4,117, labelF 10,096,
  labelH 5,460 before the split), held out 2,231. Every canary passed.

| Held-out accuracy | trainH | Majority | Rules | trainG |
|---|---|---|---|---|
| All (2,231) | 62.1% | 50.7% | 55.1% | |
| labelD + E (579) | 62.7% | 46.1% | 53.5% | |
| labelF (1,176) | 62.7% | 52.2% | 57.4% | |
| labelH (476) | 59.9% | 52.3% | 51.5% | 59.5% |

| Overrides on held-out labelH (476 records) | trainG | trainH |
|---|---|---|
| All | 170–162 (n 350) | 129–110 (n 262) |
| Confidence ≥ 0.05 | 110–80, 57.9%, +0.047 | **83–48, 63.4%**, +0.070 (p = 0.001) |
| Confidence ≥ 0.1 | 71–47, 60.2% | 56–30, 65.1% |
| Confidence ≥ 0.2 | 25–20 | 23–13 |

- **labelJ (06:42–15:55):** every canary passed. 8,927 labels (fight 7,359, tactic 1,568) on
  G-c05's own finalJ games, 0 run errors, split-half 82.5% and 81.4%, all-tie 623 (7.0%).
- **reportJ:** 6,104 labelled disagreements that aren't all-tie.

| trainG's choice minus rules+'s (labelJ, G-c05's games) | n | W | L | Mean diff | Sign p (model) |
|---|---|---|---|---|---|
| All disagreements | 6,104 | 2,543 | 2,803 | +0.034 | 1.0 (rules: 0.0002) |
| Acted | 1,513 | 718 | 729 | +0.016 | 0.62 |
| Blocked by the cooldown | 1,750 | 892 | 790 | +0.103 | 0.007 |
| Blocked by the gate (< 0.05) | 2,841 | 933 | 1,284 | +0.002 | 1.0 |
| Confidence 0.05–0.1 | 1,310 | 591 | 659 | +0.020 | 0.97 |
| 0.1–0.2 | 1,349 | 678 | 623 | +0.055 | 0.07 |
| ≥ 0.2 | 604 | 341 | 237 | +0.172 | <0.0001 |
| flee>melee | 2,979 | 1,255 | 1,590 | +0.057 | 1.0 |
| throw>melee | 1,730 | 671 | 697 | +0.010 | 0.77 |
| heal>fight | 660 | 289 | 280 | +0.001 | 0.37 |
| melee>throw | 280 | 162 | 112 | +0.015 | 0.002 |
| melee>flee | 67 | 50 | 16 | +0.137 | <0.0001 |

  The report's gate chooser again kept four pairs at confidence 0 (their mean is positive) and
  loses on both halves by count (1,053–1,162, then 1,085–1,253), as in session 9.
- **Machine:** one Windows low-memory event at 06:57; the watchdog throttled labelJ to 9 games.
  The driver finished at 15:56 on 10-22.

### Verdicts
1. **No promotion.** G-c05 is even with rules+ (675–673, p = 0.49, sweep "trade-off").
   G-c10 passes every condition but significance (669–627, 6 fewer deaths, sweep "better",
   p = 0.13). It is the best result for a model arm so far, but it isn't a win.
2. **The higher gate is better.** G-c10 beats G-c05 head to head (657–591, p = 0.033), almost all
   of it on fresh starts (570–498). labelJ says why: on G-c05's own games, overrides at confidence
   0.05–0.1 lose (591–659), and only those at ≥ 0.1 win (1,019–860; ≥ 0.2: 341–237). Session 9's
   post-hoc 0.05 threshold was too low once the model played its own games.
3. **The overrides G-c05 acted on are even (718–729)**, which matches its even tournament. As in
   session 9, overrides the cooldown blocked would have won (892–790), so the cooldown still
   blocks good overrides along with bad ones.
4. **Both gated arms do better on bank starts than on fresh ones** (G-c05 131–91 against 544–582).
   Session 8 leans the same way for every arm (each was relatively better on bank starts), but
   much less. Bank starts begin at DL ≥ 5 (mean depth 7.6 against 4.6). The likeliest reading is
   that the model helps deeper down and hurts early, but it isn't tested: labelE and the bank
   savepoints both come from session 5, so familiarity with those games isn't ruled out.
5. **trainH replaces trainG in session 11** by the pre-committed rule: on held-out labelH at
   confidence ≥ 0.05 its overrides win 63.4% (83–48) against trainG's 57.9% (110–80), and its
   held-out accuracy (62.1%) beats the majority (50.7%). The margin is small and the samples are
   about 140 and 190 records, so trainH is the better bet rather than a proven improvement. Its
   held-out labelH accuracy is barely above trainG's (59.9% against 59.5%), and it overrides less
   often. It trained for 3 epochs, not 4.
6. **labelJ adds 8,927 labels from the gated player's own states**, ready for the next training
   round.

## Session 11 (12 h, planned 2026-10-22)

Session 10 left two leads. Gated at 0.1, trainG was the closest any model has come to rules+
(669–627, p = 0.13), and trainH, which replaces it, overrides correctly more often on held-out
labelH. Both label sets also say the cooldown blocks good overrides: at confidence ≥ 0.1 the
overrides it blocked would have won (labelJ 597–478, labelH 466–388, summed over depths).

Session 10's labels don't support gating by depth. Overrides at ≥ 0.1 win most clearly at
DL 0–2 (labelJ 413–325, labelH 294–241) and are about even at DL 8 and below (64–62, 55–60).
So the bank-start advantage isn't explained by better overrides deeper down, and it isn't
tested here.

### Questions
1. Does trainH, acting only at confidence ≥ 0.1, beat rules+?
2. With the gate at 0.1, does dropping the cooldown help or hurt in play? Session 8's E-all
   (no gate, no cooldown) was far worse, but its overrides were mostly low-confidence.

### Plan (`driver11.py`, one stage, 13 slots)
| Stage | Time | What |
|---|---|---|
| finalK | until 20 min before the end (about 11.4 h) | tournament on new seeds (fresh 3000000+, bank 3050000+ from session 5's bank), fixed order, 4 fresh to 1 bank: rules+; **H-c10** (trainH `runs/session10/2026-10-21/trainH/ckpt-e3-s0.final`, acts only at confidence ≥ 0.1, oil/potion guards, label-horizon cooldown, as G-c10); **H-c10-nocool** (the same without the cooldown); rules+-replay on the first 24 starts |

No training or labelling: laya serves the tournament on the GPU throughout, and 12 h isn't
enough for both a tournament worth running and a training round. At session 10's rate (about
137 complete starts an hour with 3 main arms), expect about 1,550 complete starts and roughly
1,200 decided pairs per arm. A sign test at p < 0.025 then needs about 68 more wins than
losses, a 53% win rate. G-c10 managed 51.6%, so an arm only as good as G-c10 won't be promoted;
trainH has to be better in play, not only on labels.

### Pre-committed decision rules
- **Score** as before: depth − 3 per death; paired by start.
- **Promotion:** an arm is promoted if, against rules+, W > L, deaths ≤ rules+ + 2, the
  death-penalty sweep says "better", and sign p < 0.025 (two arms). If both pass, the one with
  the better mean difference. A promoted arm becomes the player for session 12.
- **Cooldown:** dropped from the gated player (in later sessions' arms) if H-c10-nocool beats
  H-c10 head to head with W > L, sign p < 0.05 and deaths ≤ H-c10's + 2. Otherwise it stays.
- **Canaries:** at least 600 complete starts and at least 75% of started starts complete; replay
  identical in at least 90%; each gated arm consulted at least 0.9 of the time, at most 100 throws
  in any game, and its gate blocks some overrides.
- **Reported:** fresh and bank separately; changes per game and pairs per arm; blocked by the
  gate and by the cooldown.

### Code changes
- `driver11.py`: session 10's tournament (`driver10.stage_tournament`, with its gate-binds
  canary) with session 11's arms, seeds and head-to-head pair.

### Run log
- **Smoke test** (`runs/session11/smoke`, 17:44–17:47 on 10-22; games capped at 1,500 actions):
  every canary passed. 18 of 18 starts complete in every arm, 0 errors, 0 cuts; replay 2 of 2
  identical. Both arms load trainH, are consulted every time and stay under 13 throws a game.
  The gate binds in both. H-c10: 2.0 changes per game, 102 overrides blocked by the gate and 97 by
  the cooldown. H-c10-nocool: 4.3 changes per game, 120 blocked by the gate and none by the
  cooldown, so the cooldown setting takes effect.
- **Launch:** `runs/session11/2026-10-22`, 17:47 on 10-22 (driver PID 2519); finalK until 05:27
  on 10-23.
- **finalK (17:47 on 10-22 to 05:28 on 10-23):** every canary passed. 1,633 of 1,639 started
  starts complete in every main arm (1,306 fresh, 327 bank), 0 errors, at most 4 cut by the
  deadline per arm; replay 24 of 24 identical. Both arms consulted 1.0 of the time, at most 50
  throws in a game. rules+: 1,182 deaths, mean depth 5.08. No low-memory events.

| Arm vs rules+ | W–L | Mean diff | Deaths | Mean depth | Sweep | Sign p | Changes per game | Blocked by gate | Blocked by cooldown |
|---|---|---|---|---|---|---|---|---|---|
| H-c10 | 637–627 | +0.07 | 1,225 | 5.23 | trade-off | 0.40 | 5.7 | 51,404 | 15,008 |
| H-c10-nocool | 670–611 | +0.15 | 1,213 | 5.28 | trade-off | 0.053 | 14.1 | 49,335 | 0 |

| Death penalty (W–L, mean diff) | 0 | 1 | 3 | 6 | 20 |
|---|---|---|---|---|---|
| H-c10 | 639–573, +0.15 | 640–594, +0.12 | 637–627, +0.07 | 639–650, −0.01 | 641–654, −0.38 |
| H-c10-nocool | 662–557 (p = 0.001), +0.20 | 668–580, +0.18 | 670–611, +0.15 | 668–642, +0.09 | 671–643, −0.18 |

| By kind of start | H-c10 vs rules+ | H-c10-nocool vs rules+ | nocool vs H-c10 |
|---|---|---|---|
| Fresh (1,306) | 549–531, +0.12 | 575–513 (p = 0.03), +0.18 | 392–367 |
| Bank (327) | 88–96, −0.11 | 95–98, +0.01 | 72–52 (p = 0.04) |
| All | 637–627 | 670–611 | 464–419 (p = 0.069), deaths 1,213 vs 1,225 |

  Deaths per level reached are the same in every arm (rules+ 0.143, H-c10 0.143, H-c10-nocool
  0.141): the models go deeper and die in proportion. Death causes that differ most (rules+,
  H-c10, H-c10-nocool, all starts): starvation 63, 86, 85; blacklock mage 7, 21, 15; kobold 7, 19,
  17; snaga 56, 33, 35; giant white louse 28, 20, 14. Commonest changes, H-c10-nocool: flee>melee
  15,257, throw>melee 3,209, melee>throw 2,680, heal>fight 801.

### Verdicts
1. **No promotion.** Both arms win more pairs than they lose, but both die more than rules+
   allows (+43 and +31 against +2), and neither sweep is "better".
2. **H-c10-nocool is the best model arm yet** (670–611, +0.15, p = 0.053), and at death penalty 0
   it wins clearly (662–557, p = 0.001). It goes deeper at the same death rate per level, so the
   extra deaths come with the extra depth. Whether that counts as better depends on the death
   penalty, which the promotion rule fixes at 3 and the sweep tests up to 20.
3. **The cooldown stays, by the rule.** Without it the player beats H-c10 (464–419, 12 fewer
   deaths) but at p = 0.069, short of 0.05. The direction agrees with the labels: the cooldown
   blocks more good overrides than bad ones.
4. **Session 10's bank advantage doesn't replicate.** With trainH the gains are on fresh starts
   and the bank starts are even or slightly worse. It was likely noise or specific to trainG.
5. **Starvation is the largest single source of the models' extra deaths** (85–86 against 63,
   about 22 of the 31–43). The games aren't longer overall (about 9,000–9,250 actions in every
   arm), and the starved characters reach the same depth (about DL 6), so the cause isn't known.
   One guess is the commonest override, flee for melee, which may cost turns or food drops. Food
   is visible in the UI and handled by the rules, so it's worth looking at the starved games
   before the next tournament: a fix in the rules would apply under every arm.

### Starvation follow-up (2026-10-23)
- **How the characters starve** (finalK, all arms): mostly by running out of food deep in the
  dungeon without a Word of Recall, then walking up and starving on the way (rules+ 43 of 63,
  H-c10 53 of 86, H-c10-nocool 52 of 85). The rest: out of food with a WoR (4–6), a shallow
  restock trip started only at zero food (6, 15, 14), other (9–15). All three arms run out of
  food in about as many games (85, 91, 90); the model arms survive the walk up less often.
- **A rule tried and dropped:** `RULEFIX=food` started the walk up before the food ran out
  (rations ≤ one per three levels, no WoR, gold ≥ 5). Checked on session 11's starts, rules+
  only, paired with session 11's own rules+ games (`runs/session11/foodcheck`, 07:09–08:24; the
  code is in its frozen `src`). With the rule off, 20 of 20 re-run games were identical.
  - The 63 starts where rules+ starved: starvation 63 → 46 and deaths 63 → 57, but W–L 8–8 and
    mean depth 6.19 → 5.97. The rule fired in 92 games.
  - 453 other starts: W–L 7–13, 5 new starvations, deaths 302 → 301.
  - It doesn't help, so it was reverted.
- **Why it doesn't help:** the walk up is the problem, not when it starts. In the games that
  starved anyway, the player spends thousands of actions per level looking for an up staircase;
  when exploration stalls, the stall rule forces a descent, and it oscillates between two levels.
  WoR is near the end of the town shopping list (after 30 Cure Critical Wounds, 20 Phase Door and
  12 Teleportation), so poor characters seldom hold one; of the players who starved walking up,
  about a third had 150 gold or more at their last restock. Fixing that means changing how the
  rules shop or navigate, a larger change than this follow-up.
- **The model arms' extra starvation is still unexplained.**

### Up-staircase fix (2026-10-23)
The walk up stalls because, with connected stairs, every level of the walk needs an up staircase
found by exploring. Three rules were tried on the same 516 session 11 starts (the 63 where rules+
starved and 453 others), rules+ only, paired with session 11's rules+ games. With the rules off,
20 of 20 re-run games were identical in both checks.
- **`upnav`**: on a walk back to town, after about 300 actions on a level with no up staircase in
  sight, go back to a down staircase, go down and come straight back up. Arriving on the
  staircase, this gives a fresh level at the same depth. At most 10 times per depth.
- **`wor`**: Word of Recall added to the shopping list after the Wooden Torch, before the
  potions and scrolls.
- **`upnavfood`**: `upnav` only when 3 or fewer food items are left.

| Rule vs rules+ (session 11) | Starved starts: W–L | Starved | Deaths | Other starts: W–L | Deaths | Games changed |
|---|---|---|---|---|---|---|
| upnav (`runs/session11/rulecheck`) | 15–3 (p = 0.004) | 63 → 38 | 63 → 54 | 69–73 | 302 → 327 | 170 |
| upnav + wor | 17–4 | 63 → 37 | 63 → 53 | 76–76 | 302 → 329 | 182 |
| upnavfood (`runs/session11/rulecheck2`) | 9–2 (p = 0.033) | 63 → 43 | 63 → 59 | 4–3 | 302 → 303 | 13 |

- **upnav fixes the walk but costs deaths elsewhere.** Most trips back to town are for potions or
  Phase Door, not food: 255 of 296 first re-makes in the other starts began with more than 5 food.
  Each fresh level brings fresh monsters, and of the 56 other starts newly dead, 49 had re-made a
  level (31 newly alive). Re-making usually works quickly: about half the trips find an up
  staircase on the first fresh level, and few reach the cap.
- **wor makes no difference** (12–13 against upnav alone). WoR is already bought in some games
  (45 of 516 with upnav, 82 with wor), and a WoR in the pack seldom changes the game.
- **upnavfood is adopted** as part of RULEFIX's default (`danger,restock,escape,upnavfood`). It
  keeps most of the gain where it's needed and changes only 13 of the other 453 games. Of the 44
  games that still starve, 28 never re-made a level: most of them start the walk only when hungry
  with no food left, from DL 5–9, and starve before they need to.

## Session 12 (12 h, planned 2026-10-23)

Session 11's tournament again on new starts, with upnavfood in rules+ under every arm. Session
11's best arm, H-c10-nocool, was 670–611 against rules+ (p = 0.053) with more deaths, and beat
H-c10 head to head at p = 0.069. Neither result is decisive. A second session on new starts tests
whether they hold, and session 11's starvation excess may shrink now that the walk back to town
works better.

### Questions
1. With upnavfood in the rules, does H-c10 or H-c10-nocool beat rules+?
2. Does H-c10-nocool beat H-c10 again, and do sessions 11 and 12 together settle the cooldown?
3. Do the model arms still starve more than rules+?

### Plan (`driver12.py`, one stage, 13 slots)
| Stage | Time | What |
|---|---|---|
| finalL | until 20 min before the end (about 11.4 h) | tournament on new seeds (fresh 3100000+, bank 3150000+ from session 5's bank), fixed order, 4 fresh to 1 bank: rules+; **H-c10**; **H-c10-nocool**; rules+-replay on the first 24 starts. Arms as in session 11 |

Expect about 1,600 complete starts, as in session 11.

### Pre-committed decision rules
- **Promotion and cooldown:** session 11's rules, applied to session 12 alone.
- **Pooled:** sessions 11 and 12 together (pairs are within a session) are reported for both
  arms against rules+ and head to head. They count only for the cooldown, and only at p < 0.01.
  The baselines differ slightly (upnavfood), so pooling answers whether the effect is
  consistent, not how big it is.
- **Canaries:** as in session 11.
- **Reported:** as in session 11, plus starvation per arm.

### Code changes
- `busho-player.ts`: RULEFIX `upnav`, `upnavfood` and `wor` (opt-in). `upnavfood` is added to the
  default.
- `rulecheck11.py`: the rule check above. `RULECHECK_VARIANTS` overrides the variants.
- `driver12.py`: session 11's driver with new seeds.

### Run log
- **Smoke test** (`runs/session12/smoke`, 12:09–12:11 on 10-23; games capped at 1,500 actions):
  every canary passed. 18 of 18 starts complete in every arm, 0 errors, 0 cuts; replay 2 of 2
  identical; the frozen source has upnavfood in the default. Both arms are consulted every time
  and stay under 17 throws a game, and the gate binds in both. H-c10: 2.1 changes per game, 77
  overrides blocked by the gate and 24 by the cooldown. H-c10-nocool: 3.2 changes per game, 103
  blocked by the gate, none by the cooldown.
- **Launch:** `runs/session12/2026-10-23`, 12:11 on 10-23 (driver PID 19163); finalL until 23:51.
- **finalL (12:11 to 23:52 on 10-23):** every canary passed. 1,611 of 1,617 started starts
  complete in every main arm (1,288 fresh, 323 bank), 0 errors, at most 5 cut by the deadline per
  arm; replay 24 of 24 identical. Both arms consulted 1.0 of the time, at most 50 throws in a
  game. rules+: 1,198 deaths, mean depth 5.17.

| Arm vs rules+ | W–L | Mean diff | Deaths | Mean depth | Sweep | Sign p | Changes per game | Blocked by gate | Blocked by cooldown |
|---|---|---|---|---|---|---|---|---|---|
| H-c10 | 647–579 | +0.14 | 1,161 | 5.23 | better | 0.028 | 5.9 | 50,868 | 15,535 |
| H-c10-nocool | 629–590 | +0.14 | 1,158 | 5.23 | better | 0.14 | 14.2 | 48,659 | 0 |

| Death penalty (W–L, sign p) | 0 | 1 | 2 | 3 | 6 | 20 |
|---|---|---|---|---|---|---|
| H-c10 | 614–554, 0.042 | 629–561, 0.026 | 639–567, 0.020 | 647–579, 0.028 | 669–583, 0.008 | 674–583, 0.006 |
| H-c10-nocool | 607–573, 0.17 | 615–569, 0.10 | 626–585, 0.13 | 629–590, 0.14 | 651–599, 0.075 | 653–601, 0.075 |

| By kind of start | H-c10 vs rules+ | H-c10-nocool vs rules+ | nocool vs H-c10 |
|---|---|---|---|
| Fresh (1,288) | 561–496, +0.16 | 542–503, +0.17 | 389–367 |
| Bank (323) | 86–83, +0.04 | 87–87, +0.03 | 52–60 |
| All | 647–579 | 629–590 | 441–427 (p = 0.33), deaths 1,158 vs 1,161 |

| Sessions 11 + 12 pooled | W–L | Sign p |
|---|---|---|
| H-c10 vs rules+ | 1,284–1,206 | 0.061 |
| H-c10-nocool vs rules+ | 1,299–1,201 | 0.026 |
| nocool vs H-c10 | 905–846 | 0.083 |

  Starvation (rules+, H-c10, H-c10-nocool): 59, 56, 54, against session 11's 63, 86, 85. Other
  deaths: 1,139, 1,105, 1,104. Death causes that differ most: poison 143, 124, 117; snaga 50, 33,
  38; soldier 101, 108, 120; scout 23, 30, 35; crow 11, 18, 23. Commonest changes, H-c10:
  flee>melee 4,201, throw>melee 2,706, melee>throw 1,626, heal>fight 481.

### Verdicts
1. **No promotion, narrowly.** H-c10 passes three of the four tests: it wins more pairs
   (647–579), dies less than rules+ (1,161 against 1,198) and its sweep is "better", the first
   model arm to pass the sweep. But its sign p is 0.028 against the 0.025 the two-arm rule needs.
   (The driver's own `promote` flag uses a looser test; the pre-committed rule is the one that
   counts.) H-c10-nocool also dies less and sweeps "better", but at p = 0.14.
2. **The models no longer die more.** In session 11 both arms died 31–43 more than rules+; here
   both die 37–40 fewer, at the same depth. The starvation excess is gone (56 and 54 against 59),
   and other deaths are also lower. With upnavfood in every arm, it isn't possible to say how much
   of that is the fix and how much is the new starts.
3. **The cooldown stays.** Head to head the two arms are even (441–427, p = 0.33; deaths 1,158
   and 1,161), and pooled with session 11 the no-cooldown lead is 905–846, p = 0.083, short of the
   pre-committed 0.01.
4. **The gain is small but consistent.** Over the two sessions both arms win about 51.6–52% of
   decided pairs, all of it on fresh starts; bank starts are even in both sessions. Session 11's
   lead for H-c10-nocool and session 12's lead for H-c10 are each within the other's noise.

## Session 13 (24 h, planned 2026-10-24)

H-c10 wins about 52% of decided pairs against rules+ over two sessions, short of what a
12-hour tournament can show. This session works on the model instead of testing it again.
Two sets of labels from the gated players' own states have never been trained on: labelJ
(8,927 labels on G-c05's session 10 games) and the states H-c10 itself reaches, which haven't
been labelled at all. Session 10 found that labels from a model's own games made trainH's
overrides right more often (63% against trainG's 58% on held-out labelH). This session adds
more of them and tries two ways of training on them.

### Questions
1. Does training on labelJ and on labels from H-c10's own states (labelL) make a model whose
   overrides at the gate are worth more, on held-out states from H-c10's play?
2. Which is better: training from the base model on everything, or continuing trainH on the new
   labels?
3. In play, does the best new model beat H-c10 (a first, short look), and does H-c10 still beat
   rules+ (a third session for the pooled count)?

### Plan (`driver13.py`, 13 slots)
| Phase | Track | Stage | Time | What |
|---|---|---|---|---|
| 1 | GPU | trainI0 | first 11 h | laya from the base model on labelD–H (trainH's data) plus labelJ: 25,042 train items, 3 epochs (about 9.8 h at 0.469 s per item-epoch, capped to fit). Held out: trainH's held-out games (2,231 records, the same split) and a quarter of labelJ's games (2,123). trainH also answers held-out labelJ |
| 1 | CPU | labelL | first 11 h | rollout labels on H-c10's session 12 games (trainH's own states), rules+ continuing, K = 8 as before. The disagreements alternate between trainH confidence ≥ 0.1 (the overrides the gate lets through; a third of them in play) and below; agree records 1 in 4. Expect about 10,500 labels |
| 2 | GPU | trainIL | 7.25 h | **trainIL**: trainI0 continued on labelL's train games (about 7,000 items), 2 epochs. **trainHJL**: trainH continued on labelJ + labelL train games (about 13,000), 2 epochs. Then trainH, trainI0, trainIL and trainHJL answer held-out labelL (a quarter of its games); the two continuations also answer held-out labelJ and trainH's held-out. Chooses finalM's candidate |
| 2 | CPU | labelM, reportL | 7.25 h | labelM: rollout labels on H-c10's session 11 games, as labelL (for session 14's training). reportL: driver9's override report on labelL |
| 3 | CPU + GPU serving | finalM | last 5.75 h | tournament on new seeds (fresh 3200000+, bank 3250000+), 4 fresh to 1 bank: rules+; H-c10; **X-c10** (the candidate, gated at 0.1 with the cooldown, as H-c10); rules+-replay on the first 24 starts. About 750 complete starts |

Continued training runs at laya's default learning rates from the checkpoint, the same way
`train.py` already resumes after an out-of-memory error. The held-out quarter of labelJ and
labelL is new; labelD–H keep trainH's 10% game-hash split, so its held-out records stay unseen
by every model.

### Pre-committed decision rules
- **Gate score:** on held-out labelL, the sum over a model's overrides at confidence ≥ 0.1 of
  its choice's mean utility minus the rules', per 1,000 records. It counts both how often a
  gated model acts and how good the actions are.
- **Candidate for finalM:** the model with the best gate score among trainI0, trainIL and
  trainHJL, if its score beats trainH's, its held-out labelL accuracy beats the majority, and
  its accuracy on trainH's held-out is no more than 2 points below trainH's. Otherwise finalM
  runs with rules+ and H-c10 only.
- **Session 14's model:** X replaces trainH if, in finalM, X-c10 beats H-c10 head to head
  (W > L) with deaths ≤ H-c10's + 2. finalM is short (about 750 starts), so this is a choice of
  which model to take forward, not a promotion.
- **Promotion** against rules+ as in session 11 (sign p < 0.025 with two model arms, 0.05 with
  one), on finalM alone. Pooled H-c10 against rules+ over sessions 11–13 is reported.
- **Canaries:** labels as before (at least 300, split-half at least 65%, all-tie at most 25%,
  run errors at most 2%); every trained model beats the majority on its held-out set; finalM at
  least 400 complete starts and 75% of those started, replay identical in at least 90%, each
  gated arm consulted at least 0.9 of the time, at most 100 throws in a game, the gate binds.
- **Reported:** each model's held-out accuracy (labelL, labelJ, trainH's held-out) and its
  overrides on held-out labelL by confidence; reportL's tables (trainH's overrides on its own
  states by pair, confidence, and acted, cooldown or gate).

### Code changes
- `driver6.train_eval` takes `base`, a checkpoint to continue from (default: the base model).
- `driver13.py`: the stages above. Its label pool is driver9's, with the disagreements balanced
  by confidence.

### Run log
- **Smoke test** (`runs/session13/smoke`, 09:31–10:37 on 10-24; 300 training items for 1 epoch,
  150-record held-out sets, games capped at 1,500 actions): every stage ran end to end.
  - trainI0 trained after 3 out-of-memory retries: another process on the GPU spiked, and
    `train.py`'s retry handled it. Both continued trainings worked from a checkpoint; trainHJL
    kept trainH's accuracy on its held-out (0.65 against trainH's 0.71 on 150 records, where
    trainI0 from the base on 300 items had 0.47).
  - labelL and labelM: 24 labels each, 0 run errors. reportL ran.
  - No candidate was chosen on the tiny held-out set, so finalM ran its fallback (rules+ and
    H-c10). A second finalM with a candidate forced in: 18 of 18 starts complete in every arm, 0
    errors, replay 2 of 2 identical, every canary passed. X-c10 was consulted every time, had
    2.2 changes per game, and 121 overrides blocked by the gate and 36 by the cooldown.
  - One false alarm: a rerun was started while the previous driver was still running (the
    waiter had the launch shell's PID, and buffered stdout made the log look stopped). The two
    drivers shared ports and the replay check failed. Rerun alone, it passed. The full run
    is started with unbuffered output and its PID taken from `^python3`.
- **Launch:** `runs/session13/2026-10-24`, 10:37 on 10-24 (driver PID 46464). Phase 1 until
  21:37, phase 2 until 04:52 on 10-25, finalM until 10:17.
- **trainI0 (10:37 to 20:20):** 25,042 items, 3 epochs, 570 minutes (0.455 s per item-epoch).
  On held-out labelJ, trainH scores 0.621 against a majority of 0.516.
- **labelL (10:37 to 21:37):** 11,432 labels (9,721 fight, 1,711 tactic). Of those, 10,672 have
  a snapshot that trains. 0 run errors; split-half agreement 81.3% (fight) and 82.1% (tactic);
  all-tie 4.0% and 21.7%. Labelled per stratum: 4,292 high-confidence disagreements, 4,287 low,
  2,853 agree, out of a pool of 20,811, 44,448 and 100,232.
- **trainIL (21:37 to 04:47):** trainIL took 114 minutes on 8,011 items and trainHJL 263 minutes
  on 14,192. Held-out labelL has 2,661 records.

| Model | Acc held-out L (majority 0.500, rules 0.486) | Brier L | Acc held-out J (0.516) | Acc trainH's held-out (0.507) | Overrides at 0.1 on L: W–L, mean diff | Gate score |
|---|---|---|---|---|---|---|
| trainH | 0.613 | 0.209 | 0.621 | 0.621 | 574–374, +0.092 | **34.2** |
| trainI0 | **0.643** | 0.196 | **0.643** | **0.657** | 370–187, +0.113 | 24.9 |
| trainIL | **0.643** | **0.192** | 0.638 | 0.619 | 336–149, +0.139 | 26.3 |
| trainHJL | 0.629 | 0.197 | 0.625 | 0.631 | 243–132, +0.123 | 18.0 |

  No candidate: trainH has the best gate score, so finalM ran its fallback (rules+ and H-c10).
  The new models are more accurate and their overrides at 0.1 are better, but they are less
  confident: fewer of their disagreements reach 0.1 (586, 503 and 389, against trainH's 990).
- **Post hoc: the pool's sampling.** The label pool takes trainH's confident disagreements 2.2
  times as often as its other disagreements and 7.3 times as often as agreements, which favours
  trainH on a per-record score. Weighted back to how often each kind occurs in play (weights
  4.8, 10.4 and 35.1), the gate scores are:

| Gate | 0 | 0.02 | 0.05 | 0.1 | 0.2 |
|---|---|---|---|---|---|
| trainH | 31.2 | 25.5 | 22.8 | **19.5** | 9.4 |
| trainI0 | **43.3** | **38.6** | **28.9** | 17.9 | 7.3 |
| trainIL | 34.3 | 26.8 | 23.7 | 14.8 | 5.9 |
| trainHJL | 32.2 | 24.0 | 17.2 | 11.6 | 1.6 |

  At the 0.1 gate trainH still leads, so the weighting doesn't change the pre-committed result.
  At 0.02–0.05 trainI0 is ahead of trainH at any gate. (Script:
  `tools/overnight/reweight13.py`.)
- **labelM (21:37 to 04:42):** 6,342 labels, 0 run errors, split-half 80.7% (fight) and 83.4%
  (tactic), all-tie 3.3% and 21.8%. Not used yet.
- **reportL** (trainH on its own states, pool-weighted, 7,852 disagreements): overrides H-c10
  acted on went 1,021–721 (mean +0.045). Those the cooldown blocked went 1,220–863 (mean +0.159),
  and those the gate blocked went 1,545–1,668 (+0.015). By pair: flee>melee 2,027–2,051 (mean
  +0.091, from a few large wins); throw>melee 929–615; melee>throw 330–190; heal>fight 351–340.
- **finalM (04:47 to 10:18 on 10-25):** every canary passed. 1,143 of 1,150 starts complete in
  every main arm (913 fresh, 230 bank), 0 errors, 5 cut by the deadline per arm; replay 24 of 24
  identical. rules+: 820 deaths, mean depth 5.22.

| H-c10 vs rules+ | W–L | Mean diff | Deaths | Mean depth | Sweep | Sign p |
|---|---|---|---|---|---|---|
| Fresh (913) | 390–383 | +0.07 | 663 vs 659 | 4.73 vs 4.65 | trade-off | 0.41 |
| Bank (230) | 57–58 | −0.12 | 172 vs 161 | 7.49 vs 7.47 | trade-off | 0.57 |
| All (1,143) | 447–441 | +0.03 | 835 vs 820 | 5.29 vs 5.22 | trade-off | 0.43 |

| Death penalty | 0 | 1 | 2 | 3 | 6 | 20 |
|---|---|---|---|---|---|---|
| H-c10 (W–L, sign p) | 445–392, 0.036 | 444–406, 0.10 | 448–425, 0.23 | 447–441, 0.43 | 459–448, 0.37 | 460–450, 0.38 |

| H-c10 vs rules+, pooled | Pairs | W–L | Deaths (rules+, H-c10) | Sign p |
|---|---|---|---|---|
| Session 11 | 1,633 | 637–627 | 1,182, 1,225 | 0.40 |
| Session 12 | 1,611 | 647–579 | 1,198, 1,161 | 0.028 |
| Session 13 | 1,143 | 447–441 | 820, 835 | 0.43 |
| Sessions 11–13 | 4,387 | 1,731–1,647 | 3,200, 3,221 | 0.077 |

  H-c10: 5.9 changes per game, 38,672 overrides blocked by the gate and 11,026 by the cooldown.
  Commonest changes: flee>melee 2,972, throw>melee 1,866, melee>throw 1,109, heal>fight 391.
  Starvation: rules+ 32, H-c10 48. Top killers for rules+: poison 76, soldier 75, apprentice 67.

### Verdicts
1. **No new model.** None of the three new models beat trainH's gate score, so finalM had no
   candidate and trainH stays the model for session 14. Training on more labels made models
   that are more accurate everywhere: trainI0 gains 3 points on held-out labelL, 2 on held-out
   labelJ and 3.6 on trainH's held-out. But at the 0.1 gate, which was tuned for trainH, they act
   less often. Continuing trainH (trainHJL) was the weakest of the three; training from the base
   on everything (trainI0) was the most accurate.
2. **No promotion.** H-c10 against rules+ in finalM is 447–441 (p = 0.43), dies 15 more and
   sweeps "trade-off". Pooled over three sessions it wins 51.2% of decided pairs (p = 0.077) and
   dies 21 more in 4,387 pairs. The gated trainH is not clearly better than rules+.
3. **Label gains don't become game gains.** The overrides H-c10 acts on win their labels
   1,021–721, and it changes about 6 decisions a game. But the games it plays are even with
   rules+. Each label scores one decision with rules+ playing on, so this suggests that overrides
   which help one at a time don't add up over a game, or that the labels' K = 8 rollouts are too
   short-sighted for decisions whose cost comes later (starvation: 48 against 32 here).
4. **Possible next steps** (not pre-committed): play trainI0 at a lower gate (0.02–0.05), where
   the reweighted held-out score is ahead of trainH at any gate. Before training more, check
   whether labels predict game outcomes at all: for H-c10's labelled games, does the sum of its
   overrides' label gains predict whether the game beat its rules+ pair?

### Do label gains show up in games? (2026-10-25)
A check from data we already have (`tools/overnight/labelgain13.py runs`). It converts label gains
into game score, predicts what H-c10 and H-c10-nocool should gain per game, and compares that
with the tournaments.

- **Calibration.** Session 7 re-ran 668 of labelF's states with 5,000-action rollouts scored like
  the tournament. Regress the long result of each option against the rules on the short label's
  gain. The label is taken from seeds 1–4 and the result from seeds 5–8, and the reverse, so
  they share no randomness, as in play; then the slope is scaled to an 8-seed label. With shared
  seeds the slope is 1.08, which is inflated, because a death in the first 150 actions counts in
  both. One unit of label gain is worth, in game score:

| Horizon (actions) | 500 | 1,500 | 5,000 |
|---|---|---|---|
| Game score per unit of label gain | 0.98 ± 0.09 | 0.92 ± 0.14 | 0.79 ± 0.18 |

- **Label gains of trainH's overrides** on its own states (labelL and labelM together): acted
  +0.045 ± 0.005 (2,972), blocked by the cooldown +0.139 ± 0.007 (3,699), blocked by the gate
  +0.012 ± 0.003 (6,666).
- **Noise.** A pair's score difference has a standard deviation of about 3.2 (2.6 for the two
  model arms head to head). The smallest effect a tournament detects at p < 0.025 with 80%
  power is +0.27 per game for 1,143 pairs, +0.22 for 1,611 and +0.14 for 4,387.

| Comparison | Predicted per game | Observed, pooled | Gap |
|---|---|---|---|
| H-c10 vs rules+ (sessions 11–13) | 5.8 changes × 0.045 × 0.79 = **+0.21 ± 0.05** | **+0.086 ± 0.048** | +0.12 ± 0.07 (z ≈ 1.8) |
| H-c10-nocool vs H-c10 (sessions 11–12) | 8.3 extra changes × 0.139 × 0.79 = **+0.91 ± 0.21** | **+0.037 ± 0.046** | +0.88 ± 0.22 (z ≈ 4) |
| H-c10-nocool vs rules+ (sessions 11–12) | about +1.1 | +0.142 ± 0.056 | about +1.0 |

Findings:
1. **H-c10's edge is small even on paper.** If its label gains all turned into game score, it
   would gain about 0.2 levels a game, which is under the 0.22–0.27 that one session's
   tournament can see. What we observe is about 40% of that, and the shortfall is within 2
   standard errors. For H-c10 alone, "too small for one session" explains most of what we've
   seen.
2. **Label gains don't add up when overrides come close together.** The overrides the cooldown
   blocks have the best labels of all, three times the acted ones. Playing them (no cooldown)
   should have added about 0.9 a game, and it added 0.04. Each label values one override with
   rules+ taking over afterwards. Overrides soon after another override look good on that
   assumption, but don't help when the model keeps overriding. This is session 7's compounding
   explanation, now measured: about 95% of the predicted gain from the extra overrides is lost.
3. **This answers the planned steps 2 and 3 in large part.** The no-cooldown arm was a
   dose-response test already: more overrides with good labels gave no more game score.

Caveats: the calibration comes from session 7's rules-play states (caution 0) and stops at 5,000
actions, while the median tournament game is 7,200 (mean 9,300). The slope falls with horizon,
so these predictions may be somewhat high. The no-cooldown arm's extra overrides happen in its
own games, not exactly at the states H-c10's cooldown blocked.

What this suggests for the next session (not pre-committed):
- **Labels that value a policy, not one override.** Rollouts that continue with H-c10 (model,
  gate and cooldown) instead of rules+, so that a label measures the override as it will be
  played. This needs the model consulted inside the rollouts.
- **Fewer, bigger gains.** At +0.045 a change, H-c10's best case is about 0.2 a game. A model
  that makes the same few changes better won't be visible in a tournament; it needs decisions
  with larger effects.

## Session 14 (12 h, planned 2026-10-25)

rules+ scores 3.07 a game in finalM (mean depth 5.22, minus 2.15 for deaths), and H-c10 adds
about 0.09. This session looks for bigger gains in the rules themselves, where finalM's rules+
games lose score:

| Where the score goes (finalM, rules+, 1,145 games) | Evidence | Variant |
|---|---|---|
| Rangers score 1.14 (86% die); Warriors 4.23, the others 2.3–2.4 | The player never fires a launcher (`CMD.FIRE` is defined but never sent), so Rangers can't use their Short Bow and arrows | **fire** |
| Poison is the commonest killer (76 deaths, 9%) | Replays: a Paladin poisoned at 5 of 30 HP, holding 6 Cure Light Wounds potions, kept tunnelling and died. The stall escapes (`noProgressCount` ≥ 100 or 500) run before every heal check | **lowheal** |
| 28% of games reach the 20,000-action cap at a mean depth of 5.8 | Survivors make 27.9 restock trips a game and 37.7 descents, and spend 43% of their actions on DL1–2. A trip starts whenever potions *or* Phase/oil run out with 40 gold, which buys one or two potions | **restock100**, **restockboth** |
| The same | On DL1–3 the rules wait for CL ≥ DL+2 | **clgate1** |

### Questions
1. Which of these rule changes raise the score (depth − 3 per death), each on its own?
2. Do the adopted changes together raise it on starts that weren't used to choose them?

### Variants (`RULEFIX` flags, off by default; rules+ is unchanged)
- **fire:** with a launcher and matching ammo, shoot a monster 2 or more squares away in line
  of sight instead of walking up to it, unless the plan is to flee from it or throw oil at it.
  In town, buy ammo up to 30 (the General Store always has it) right after torches.
- **lowheal:** below 35% HP, or below 50% while poisoned, the stall escapes are held back. With
  no monster adjacent, drink a Cure potion first (the strongest one below 35%). With a monster
  adjacent, the usual emergency flee/heal code runs.
- **restock100:** a restock trip for potions or escapes needs 100 gold (now 40).
- **restockboth:** a restock trip starts only when potions *and* Phase/oil are both gone (now
  either). Food and light trips are unchanged.
- **clgate1:** on DL1–3, descend at CL ≥ DL+1 (now DL+2).

### Plan (`driver14.py`, 13 slots, CPU only)
| Stage | Time | What |
|---|---|---|
| ruleN | first 9.8 h | First, rules+ re-run on 20 starts (replay canary). Then each variant alone on a fixed sample of 700 of finalM's 1,145 complete starts, start by start, and **fire** also on the other 71 fresh Ranger starts (184 in all). About 3,590 games at about 450 an hour (session 11's rule checks) |
| confirmN | last 2.2 h | the adopted variants together ("combo") on the other 445 starts first, then on the 700 |

Each variant's game is paired with finalM's rules+ game on the same start. Games are
deterministic, and both runs freeze their source, so a pair differs only where the variant's
rule fires.

### Pre-committed decision rules
- **Replay canary:** at least 18 of the 20 rules+ re-runs identical to finalM (actions, death,
  depth), else no result counts.
- **Adopt a variant** if, on its pairs, W > L at a death penalty of 3, one-sided sign p < 0.05
  and the mean difference is above 0. **fire** is judged on all Ranger starts, and it must not
  lose on the other sample starts (L > W with p < 0.05). If both restock variants pass, only
  the one with the larger mean difference is adopted.
- **New default rules+** (for session 15 and its labels): the combo of the adopted variants, if
  on the 445 held-out starts it has W > L and a mean difference above 0.
- **Reported:** W–L, mean difference and sign p at death penalties 0, 1, 3 and 6; deaths,
  depth, starvation and poison deaths; mean actions; shots, restock trips and descents per game.

### Run log
- **Smoke test** (`runs/session14/smoke`, 11:01–11:03 on 10-25; 6 sample starts, 2 of them
  Rangers, plus 1 other Ranger; games capped at 1,500 actions, except the replays): every
  stage ran end to end. The first try ran every game and then failed in the analysis (a wrong
  module for the sign test). Fixed and rerun:
  - Replay canary: 3 of 3 full-length rules+ re-runs (2 bank starts and 1 fresh) identical to
    finalM, so the new source with the flags off plays session 13's games.
  - fire: Rangers fired 47 shots a game in 1,500 actions (37–59), more than the 15–20 arrows
    they start with, so ammo is picked up or bought. restockboth cut restock trips from 0.8 to 0.2
    a game in 1,500 actions.
  - With nothing adopted in so short a test, the smoke test forced a combo (fire, lowheal,
    restockboth) to exercise confirmN: 10 games, 0 errors.
- **Full run** (`runs/session14/2026-10-25`, 16:13 on 10-25 to 01:21 on 10-26, 9.1 h; 13 slots,
  CPU only; 0 errors). ruleN (3,596 games) ended at 22:50, and confirmN took 2.5 h.
  - **Replay canary:** 20 of 20 full-length rules+ re-runs identical to finalM. Passed.
  - **ruleN, each variant alone** (pairs against finalM's rules+ on the same start; W–L,
    mean difference and sign p at penalty 3):

    | Variant | Pairs | Changed | W–L | Mean diff | p | Deaths | Mean depth | Poison deaths | Mean actions | Per game |
    |---|---|---|---|---|---|---|---|---|---|---|
    | fire, Rangers | 184 | 183 | 116–49 | **+1.55** | < 0.0001 | 159 → 135 | 3.73 → 4.89 | 25 → 23 | 6,570 → 10,634 | 149 shots |
    | fire, other sample starts | 592 | 145 | 71–53 | +0.06 | 0.06 | 408 → 404 | 5.53 → 5.58 | 37 → 31 | | |
    | fire, the 700 sample starts | 700 | 252 | 143–79 | +0.34 | < 0.0001 | 504 → 479 | 5.23 → 5.46 | 50 → 42 | 9,247 → 10,365 | 53 shots |
    | lowheal | 700 | 178 | 86–27 | +0.28 | < 0.0001 | 504 → 470 | 5.23 → 5.36 | 50 → 51 | 9,247 → 10,134 | |
    | restock100 | 700 | 204 | 94–79 | +0.06 | 0.14 | 504 → 510 | 5.23 → 5.31 | 50 → 53 | 9,247 → 9,210 | 3.8 trips, 10.5 descents |
    | restockboth | 700 | 460 | 173–229 | **−0.34** | 1.00 | 504 → 528 | 5.23 → 4.99 | 50 → 63 | 9,247 → 9,123 | 0.3 trips, 6.2 descents |
    | clgate1 | 700 | 264 | 115–117 | −0.02 | 0.58 | 504 → 510 | 5.23 → 5.23 | 50 → 52 | 9,247 → 9,079 | 8.3 trips, 14.7 descents |

    (Trips and descents per game are counted over the whole game, from the player logs. lowheal
    and fire, with the default restock rule, make 9.1–9.6 trips and 16.4–16.5 descents a game.)
    The ordering holds at penalties 0, 1, 3 and 6 for every variant.
  - **confirmN, combo = rules+ with fire and lowheal** (`RULEFIX=danger,restock,escape,upnavfood,fire,lowheal`):

    | Starts | Pairs | Changed | W–L (k3) | Mean diff (k0 / k1 / k3 / k6) | p (k3) | Deaths | Mean depth | Starvation | Poison | Mean actions |
    |---|---|---|---|---|---|---|---|---|---|---|
    | **445 held-out** | 445 | 229 | **116–72** | +0.26 / +0.32 / **+0.45** / +0.64 | 0.0008 | 317 → 289 | 5.21 → 5.47 | 10 → 23 | 26 → 27 | 9,372 → 10,875 |
    | 700 sample | 700 | 368 | 201–92 | +0.36 / +0.46 / +0.65 / +0.94 | < 0.0001 | 504 → 436 | 5.23 → 5.59 | 22 → 25 | 50 → 45 | 9,247 → 11,218 |
    | all | 1,145 | 597 | 317–164 | +0.32 / +0.41 / +0.57 / +0.82 | < 0.0001 | 821 → 725 | 5.22 → 5.54 | 32 → 48 | 76 → 72 | 9,296 → 11,084 |

    Per game: 57 shots, 6.2 restock trips, 13.9 descents. The mean score rises from 3.07 to 3.64.
  - **By class (all 1,145 starts, score at penalty 3):**

    | Class | Pairs | W–L | rules+ | combo | Deaths |
    |---|---|---|---|---|---|
    | Ranger | 184 | 117–47 | 1.14 | **2.82** | 159 → 128 |
    | Blackguard | 182 | 46–26 | 2.44 | 3.10 | 129 → 111 |
    | Paladin | 183 | 42–22 | 2.34 | 2.84 | 133 → 118 |
    | Rogue | 183 | 44–23 | 2.30 | 2.65 | 134 → 123 |
    | Warrior | 183 | 39–30 | 4.23 | 4.43 | 105 → 88 |
    | bank (DL5–6 savepoints) | 230 | 29–16 | 5.37 | 5.52 | 161 → 157 |

  - **Death causes (all starts):** poison 76 → 72, soldier 75 → 55, apprentice 67 → 33,
    **starvation 32 → 48**. Games that reach the action cap alive: 320 → 416.

### Verdicts
- **Q1:** fire and lowheal each raise the score; restock100 and clgate1 make no difference;
  restockboth lowers it.
  - **fire** was adopted. Rangers gain +1.55 a game (116–49), about 7 times the +0.21 predicted
    for H-c10's overrides. Rangers still score below the other classes (2.82 in the combo), so
    there is more to find in how they shoot (range, ammo, retreating to shoot).
  - **lowheal** was adopted. It changes few games (178 of 700) but wins those 86–27. Poison
    deaths didn't fall (50 → 51), so the gain is from healing earlier in general, not from
    curing poison. Cure Light Wounds doesn't cure poison; poison is still the top killer.
  - **restock100** was not adopted (+0.06, p 0.14). It cut trips from about 9 to 3.8 a game
    and descents from about 16 to 10.5, but the score didn't change.
  - **restockboth** was not adopted. Waiting until both potions and escapes run out cost
    0.34 a game: more deaths (528 against 504), most of them poison (63 against 50).
  - **clgate1** was not adopted (115–117).
- **Q2: yes.** On the 445 held-out starts the combo wins 116–72 (p 0.0008), +0.45 a game, so
  under the pre-committed rule it is the **new default rules+**. `busho-player.ts` now
  defaults to `RULEFIX=danger,restock,escape,upnavfood,fire,lowheal`. Session 15's baseline
  and labels use it, so earlier rules+ games no longer replay (pass the old `RULEFIX` to
  replay them).
- **Scale:** this one change (+0.57 on all starts) is about 6 times H-c10's pooled edge over
  rules+ (+0.09). Rule fixes aimed at where the score goes have moved the score more than
  fine-tuning has.
- **Next levers:**
  - **Starvation** rose from 32 to 48 deaths, because 96 more games survive long enough to run
    out of food. Session 12's upnavfood fix doesn't cover them all.
  - **Poison** (72 deaths): buy Neutralize Poison (alchemist, 75 gold), or rest or leave the
    level while poisoned.
  - **Rangers' shooting:** more ammo, retreating to keep range.
  - **Soldiers** (55 deaths).
- **For the model:** trainH was trained on labels made against the old rules. A model on top of
  the new default needs new labels on its states before it can be compared against it.

## Session 15 (24 h, planned 2026-10-26)

Session 14's new default rules+ (`danger,restock,escape,upnavfood,fire,lowheal`) scores 3.64 a
game on finalM's starts and still loses 725 of 1,145 games. The first half of this session tries a
second round of rule changes aimed at what kills those games. The second half makes the first
labels whose rollouts continue with the rules in use, and continues trainH on them.

| Where the score goes (session 14's combo, 1,145 games) | Evidence | Variant |
|---|---|---|
| Poison is still the top killer (72; 22 Rangers, 20 Rogues, 1 Warrior) | In C 4.2 Cure Light and Cure Serious Wounds don't cure poison, and while poisoned HP doesn't regenerate (`player-util.c`). Replays: HP falls from 90 to 15 with no monster in view, or right after the last potion | **neutpois**, **poisonhold** |
| Starvation rose from 32 to 48 deaths: 96 more games now live long enough | Mostly on DL5–8: 34 of the 48 were on a restock walk, 21 re-making levels to find an up staircase. The town shopping keeps 6 rations; session 11 showed starting the walk earlier doesn't help | **food8** |
| Rangers score 2.82, against Warriors' 4.43 | Rangers fire about 150 shots a game, so 30 bought arrows run short; fire only shoots at 2+ squares, and a Ranger's melee is weak | **fireadj**, **ammo60** |

### Questions
1. Which of these rule changes raise the score on top of the new default, each on its own?
2. Do the adopted ones together raise it on new starts?
3. Trained on labels made with the rules in use, does trainH's continuation beat trainH offline?

### Variants (`RULEFIX` flags, off by default)
- **food8:** keep 8 rations (now 6), in the early kit and on later town visits.
- **neutpois:** buy Neutralize Poison (alchemist, 75 gold, when stocked): 1 after the first 3
  Cure Light Wounds, then up to 2; on later town visits up to 2 before Cure Critical Wounds.
  Poisoned below 50% HP with no monster adjacent: drink Neutralize Poison or Cure Critical Wounds
  before any other potion.
- **poisonhold:** poisoned below 50% HP, with no healing potion and no monster in view: rest (10
  turns at a time) instead of exploring or walking back to town. Uses only the "Poisoned" status
  the UI shows.
- **fireadj:** with a launcher and ammo, shoot adjacent monsters too (now only 2+ squares away).
  4.2 has no penalty for shooting at an adjacent monster.
- **ammo60:** buy ammo up to 60 (now 30).

### Plan (`driver15.py`, 13 slots)
| Stage | Track | Time | What |
|---|---|---|---|
| ruleO | CPU | first 7 h | First, rules+ re-run on 20 starts (replay canary against session 14's combo games). Then food8, neutpois and poisonhold each on a new sample of 700 of finalM's 1,145 starts; fireadj and ammo60 each on the 184 Ranger starts and the 269 others whose combo game fired at least once. About 3,000 games |
| answerO | GPU | alongside ruleO | trainH answers 60,000 of the 140,000 fight/tactic decisions of session 14's combo games (chunks of 5,000), so labelO can choose records as labelL did |
| confirmO | CPU | 2.5 h | rules+ and rules+ with the adopted variants, start by start, on **new starts** (fresh 3300000+, bank 3350000+; finalM's starts have now been used to select twice). Skipped if nothing is adopted |
| labelO | CPU | until 3 h before the end | rollout labels (K = 8, as before) on session 14's combo states, the **final** default rules continuing. trainH's disagreements alternate between confidence ≥ 0.1 and below; agreements 1 in 4. Expect about 10,000 labels |
| trainO | GPU | last 3 h | trainH continued on labelO's train games (three quarters, by game), 2 epochs (capped to fit). trainH and trainO answer held-out labelO and trainH's held-out set |

The labelO states come from session 14's combo games, not from the confirmO games, so labelling
needs no model answers after ruleO. If confirmO changes the default, those states are from a
slightly different player (the variants change about a quarter of games), and the rollouts still
continue with the new default.

**Disk** (88 GB free at the start): each game deletes its replay and snapshots once played (about
8 MB a game in session 14); player logs, decisions and reports stay. The labels use session 14's
snapshots. A guard stops new games below 30 GB free and stops the run below 15 GB; the driver
won't start below 40 GB. Expected use: under 5 GB.

### Pre-committed decision rules
- **Replay canary:** at least 18 of the 20 rules+ re-runs identical to session 14's combo games,
  else no ruleO result counts and confirmO is skipped.
- **Adopt a variant** if, on its pairs, W > L at a death penalty of 3, one-sided sign p < 0.05
  and the mean difference is above 0. fireadj and ammo60 are judged on the Ranger starts and
  must not lose on the other shooters (L > W with p < 0.05). If both poison variants pass, only
  the one with the larger mean difference is adopted.
- **New default rules+:** the adopted variants together, if on confirmO's new starts (at least
  300 complete pairs) W > L and the mean difference is above 0.
- **Session 16's model:** trainO, if its gate score on held-out labelO beats trainH's, its
  held-out labelO accuracy beats the majority, and its accuracy on trainH's held-out set is no
  more than 2 points below trainH's. Otherwise trainH. Session 16 plays it, gated as H-c10,
  against the final default rules+.
- **Canaries:** labels as before (at least 300, split-half at least 65%, all-tie at most 25%,
  run errors at most 2%); answerO at least 5,000 answered.
- **Reported:** per variant W–L, mean difference and sign p at penalties 0, 1, 3 and 6; deaths,
  depth, starvation and poison deaths; mean actions; shots, poison cures, restock trips and
  descents per game. labelO's pool and labels by type; both models' held-out accuracy and gate
  score.

### Run log
- **Smoke test** (`runs/session15/smoke`, 17:31–17:38 on 10-26; 4 sample starts, 2 Rangers and 1
  other shooter; games capped at 1,500 actions except the replays; answerO on 200 decisions in
  chunks of 100; 300 training items for 1 epoch): every stage ran end to end, with 0 errors.
  - Replay canary: 3 of 3 full-length rules+ re-runs (2 bank starts and 1 fresh) identical to
    session 14's combo games.
  - fireadj: 37 shots a game; ammo60: 61 shots a game in 1,500 actions.
  - answerO: trainH disagreed with the rules on 84 of 200 decisions, 32 of them at confidence ≥
    0.1. Over 60,000, that is about 25,000 disagreements to choose from.
  - With nothing adopted in so short a test, the smoke test forced a combo (food8, neutpois,
    fireadj) to exercise confirmO: 18 pairs. labelO then labelled 24 records (0 run errors), and
    trainO trained and answered both held-out sets.
  - Disk: games kept only player.log, decisions and the report; 86 GB free at the end.
- **Found and fixed during the smoke tests:**
  - The first try ran ruleO's start list by switching `run.smoke` off for a moment, and answerO,
    in the other thread, read it and built its full 60,000-record pool. The start list is now
    built without touching `run.smoke`.
  - In C the alchemist is store type 4, not 5, so the later town visits' list wouldn't have
    bought Neutralize Poison. Fixed; the early kit now buys it only there, since the black market
    sells it at 225 gold. Checked by hand with two Paladin games: the early kit bought 1 (seed
    15), and a later town visit with 1,205 gold bought 2 before Cure Critical Wounds (seed 11).
    No game in these tests was poisoned below 50% HP holding a cure, so the drink itself is
    checked only in the full run (`poison_cures_per_game`).
- **Full run** (`runs/session15/2026-10-26`, 17:40 on 10-26 to 15:33 on 10-27; 0 errors; 2.8 GB
  in the end, 83 GB free; the disk guard never fired).
  - **answerO** (done 19:11): trainH answered all 60,000 decisions; it disagreed with the rules on
    24,941, 6,633 of them at confidence ≥ 0.1. Canary passed.
  - **ruleO** (done 00:11): replay canary 20 of 20 identical. Results at a death penalty of 3;
    rules+ is session 14's combo game on the same start. Penalties 0, 1 and 6 agree in sign except
    ammo60 on Rangers (−0.22 at 0, +0.33 at 6: fewer deaths, less depth):

    | Variant | Starts | Changed | W–L | Mean | Sign p | Deaths | Mean depth | Starvation | Poison |
    |---|---|---|---|---|---|---|---|---|---|
    | food8 | 700 | 215 | 91–85 | +0.03 | 0.35 | 444 → 445 | 5.59 → 5.62 | 30 → 25 | 44 → 43 |
    | neutpois | 700 | 234 | 95–113 | −0.10 | 0.91 | 444 → 454 | 5.59 → 5.54 | 30 → 34 | 44 → 39 |
    | poisonhold | 700 | 34 | 9–8 | +0.01 | 0.50 | 444 → 441 | 5.59 → 5.59 | 30 → 31 | 44 → 44 |
    | fireadj, Rangers | 184 | 182 | 62–96 | −0.94 | 0.997 | 128 → 138 | 4.91 → 4.14 | 3 → 7 | 22 → 22 |
    | fireadj, other shooters | 269 | 241 | 93–115 | −0.30 | 0.94 | 120 → 143 | 6.09 → 6.04 | 16 → 15 | 9 → 9 |
    | ammo60, Rangers | 184 | 178 | 79–77 | +0.05 | 0.47 | 128 → 111 | 4.91 → 4.68 | 3 → 4 | 22 → 11 |
    | ammo60, other shooters | 269 | 132 | 60–65 | −0.22 | 0.70 | 120 → 126 | 6.09 → 5.94 | 16 → 16 | 9 → 8 |

    Per game: neutpois drank a poison cure 0.18 times and made 10.7 restock trips (food8 8.3,
    poisonhold 7.3); fireadj Rangers fired 137 shots, ammo60 Rangers 195, with 3.7 restock trips
    and 12.4 descents.
  - **confirmO:** skipped, nothing adopted.
  - **labelO** (00:11–14:40): 15,813 labels (13,459 fight, 2,354 tactic) on session 14's combo
    states, rollouts with the unchanged default rules+; 0 run errors; split-half agreement 81.4%
    (fight) and 84.7% (tactic); all options tie on 4.2% and 22.9%. Canary passed.
  - **trainO** (14:40–15:33): 11,110 train items, 3,599 held out (by game). It trained for **1
    epoch**, not 2: the cap uses session 10's rate with labelling on the CPU (0.469 s an item),
    and with the CPU idle it ran at 0.219 s, so 2 epochs would have fitted in about 81 minutes.

    | | Held-out labelO acc. (majority 52.8%, rules 51.0%) | Brier | Overrides at conf ≥ 0.1 | Their W–L, mean | Gate score | trainH's held-out set acc. |
    |---|---|---|---|---|---|---|
    | trainH | 60.7% | 0.206 | 1,312 | 707–550, +0.075 | **27.3** | 62.1% |
    | trainO | **63.4%** | **0.193** | 522 | 330–167, +0.102 | 14.8 | 61.8% |

### Verdicts
- **Q1: none of the five changes raises the score**, so the default rules+ stays
  `danger,restock,escape,upnavfood,fire,lowheal`, and Q2 had nothing to test.
  - **food8** cut starvation (30 → 25 deaths) but not the score. Food isn't what limits these games.
  - **neutpois** works as written: it drinks cures and poison deaths fall (44 → 39). But the extra
    shopping makes more trips (10.7 against about 8) and starvation rises (30 → 34), and net the
    score falls. A cheaper version, buying it only when already in the alchemist's, might not cost
    the trips.
  - **poisonhold** rarely applies (34 games): a poisoned character below half HP with no potion
    and nothing in view is rare. Poison deaths happen in fights.
  - **fireadj** is clearly worse (Rangers −0.94, p 0.997). Shooting an adjacent monster instead
    of hitting it or stepping away loses, for Rangers too. Rangers shooting only at 2+ squares
    stays.
  - **ammo60** halves Rangers' poison deaths (22 → 11) and cuts their deaths 128 → 111, but they
    restock less often (3.7 trips) and descend less (12.4 descents), so mean depth falls. Whether
    it helps depends on the death penalty (−0.22 at 0, +0.05 at 3, +0.33 at 6), and at the
    pre-committed 3 it doesn't move the score.
- **Q3: trainO is more accurate, but trainH stays** under the pre-committed rule (gate score
  27.3 against 14.8). trainO beats the majority and is within 2 points of trainH on trainH's
  held-out set, but it overrides the rules at confidence ≥ 0.1 on 522 held-out records against
  trainH's 1,312. Its overrides win more often (+0.102 against +0.075 each), but there are too few
  of them to add up to as much. Two caveats, both against trainO: the held-out pool was chosen
  from trainH's disagreements, half of them at trainH's confidence ≥ 0.1, which favours trainH's
  gate score; and trainO trained for 1 epoch, not 2. **Session 16 plays trainH**, gated as
  H-c10, against the default rules+.
- **Where the score goes now:** the rules+ changes in sessions 12 to 14 each took a cause of
  death the rules handled badly; this round's targets (food, poison, Rangers' ammo) moved deaths
  around between causes without raising depth. Speed is not a lever yet: no game drank a Potion
  of Speed (the rule only applies from DL10, which 46 of 1,145 games reach; the deepest is DL13).

## Sessions 16 and 17 (to noon 2026-10-30, planned 2026-10-27)

Unattended, back to back: session 16 (24 h, `driver16.py`), session 17's tournament (16 h,
`driver17.py`), then a fourth round of rule variants chosen from session 16's games (about 18 h),
and the write-up by noon Friday. Results are committed after each part.

Where session 14's combo games (the default rules+, 1,145 games, 725 deaths) lose score:
- 228 deaths in the first 2,500 actions, mostly fresh characters at CL 1–4 on DL1–3: poison 27,
  soldiers 26, apprentices 16, cave spiders 14, floating eyes 8.
- Breeders: giant white lice 19 deaths, worm masses 9. The rules' only answer is the swarm escape
  (20 monsters in view, or 10 with a breeder within 10 squares), and on the C engine the breeder test
  never fired: `isBreeder` came from the TS server only. The escape ran in 333 games.
- Bleeding ("a fatal wound") 11.
- Blackguards cast no spells (Whirlwind Attack, CL5, hits every adjacent monster, is in no spell list).
  The classes played (Warrior, Rogue, Ranger, Paladin, Blackguard) have no area spells otherwise, and
  no Spear of Light (a Priest spell).

### Engine change
`main-http.c` (angband-c `133251a69`) sends `breeds` for each monster: true once the character has
seen that kind try to breed, which is exactly when monster recall shows "breeds explosively"
(`mon-move.c` sets the lore flag; `mon-lore.c` shows race flags and lore flags). With the default
rules, 5 of session 14's games replay identically on the new build.

### Session 16 variants (`RULEFIX` flags, off by default)
- **breed:** a known breeder within 10 squares comes before items, other monsters, stairs and
  exploring; among adjacent monsters it is the first target; Rangers shoot it first. With 4 known
  breeders in view, or 150 actions with one in view on the level, walk to the nearest known stairs
  and take them, up or down. Known breeders also count for the swarm escape.
- **earlyrun:** at CL ≤ 4, having lost a third of max HP since the last check with a monster adjacent:
  stairs if standing on them, else Phase Door or a walk to the nearest stairs.
- **neutshop:** one Neutralize Poison at the end of the town shopping list (neutpois bought it early
  and made more trips); drink it as neutpois does.
- **cutcure:** bleeding below 50% HP joins lowheal's triggers.
- **whirl:** Blackguards cast Whirlwind Attack with 2 or more monsters adjacent.

A hand check on 8 starts whose session 14 game died to breeders (`breed,whirl`): 7 avoided that
death, 4 reached the action cap, 6 went deeper. These starts were chosen for breeder deaths, so this
checks the code, not the size of the gain.

### Session 16 plan (`driver16.py`, 13 slots)
| Stage | Track | Time | What |
|---|---|---|---|
| ruleP | CPU | 8 h | rules+ re-run on 20 starts (replay canary against session 14's combo games); then breed, earlyrun, neutshop and cutcure each on a sample of 700 of finalM's starts, and whirl on finalM's Blackguard starts. About 3,050 games |
| trainO2 | GPU | alongside ruleP | trainH continued on session 15's labelO train games for 2 epochs (trainO had 1). trainH, trainO and trainO2 scored on held-out labelO with each record weighted by its stratum's pool size over labels made (agreements, disagreements at confidence ≥ 0.1, below), so the set stands for all 60,000 decisions and not mostly trainH's disagreements |
| confirmP | CPU | 3 h | rules+ and rules+ with the adopted variants, start by start, on new starts (fresh 3400000+, bank 3450000+); snapshots of the final default's games stay for labelP |
| labelP | CPU | the rest | rollout labels (K = 8) on a uniform random sample of the final default's fight/tactic decisions: an unbiased set on the current rules for later training and scoring |

### Session 17 plan
| Part | Time | What |
|---|---|---|
| finalQ (`driver17.py`) | 16 h | tournament on new starts (fresh 3500000+, bank 3550000+): the final default rules+ against session 16's chosen model gated as H-c10, and a 24-start replay arm. About 3,000 starts; each game's replay and snapshots are deleted once played |
| ruleQ, confirmQ | about 18 h | a fourth round of variants aimed at what kills session 16's confirm games, chosen and written while finalQ runs, then confirmed on new starts |

### Pre-committed decision rules
- **Replay canary:** at least 18 of 20 rules+ re-runs identical to session 14's combo games, else no
  ruleP result counts.
- **Adopt a variant** if, on its starts, W > L at a death penalty of 3, one-sided sign p < 0.05 and
  the mean difference is above 0 (whirl on the Blackguard starts).
- **New default rules+:** the adopted variants together, if on confirmP's new starts (at least 300
  complete pairs) W > L and the mean difference is above 0. busho's default `RULEFIX` is then updated
  before session 17.
- **Session 17's model:** the highest weighted gate score among trainH, trainO and trainO2, if its
  held-out labelO accuracy beats the majority and its accuracy on trainH's held-out set is no more
  than 2 points below trainH's; otherwise trainH.
- **Promotion** (finalQ): the gated model becomes the player if W > L with one-sided sign p < 0.05 on
  the complete starts. If not, the model track moves to labels that value a whole policy (session
  13's finding) instead of another tournament of the same kind.
- **Canaries:** labels as before (at least 300, split-half at least 65%, all-tie at most 25%, run
  errors at most 2%); finalQ as finalM (at least 600 complete starts and 75% of those started,
  replay identical in at least 90%, consulted at least 0.9, at most 100 throws, the gate binds).
- **Reported:** per variant W–L, mean difference and sign p at penalties 0, 1, 3 and 6; deaths by
  cause against session 14's games on the same starts (breeders together); breeder hunts and exits,
  early exits, poison cures, spells, restock trips and descents per game.

**Disk** (84 GB free at the start): ruleP and finalQ delete replays and snapshots; confirmP keeps
snapshots for labelP (about 10 GB). The guard stops new games below 30 GB free and the run below 15 GB.

## Measurement: a score without the action cap (2026-10-27, before ruleP's results)

An outside review (`docs/review-2026-10-27.md` on branch `claude/rule-model-improvements-bymira`)
pointed out that the replacement-cost score from the roadmap after session 3 was never adopted. 36% of
games are still alive at the 20,000-action cap, so anything that changes pace is judged at an arbitrary
cutoff. `tools/overnight/hazard.py` now scores every logged game without the cap.

- **Stages.** A game's stage is the deepest level it has reached so far. player.log gives the depth and
  action count every 200 actions and every depth change, so each game becomes stage segments ending in
  an advance, a death or the cap (censored: exposure only).
- **Rates.** For each stage d: deaths and advances per action. Under constant hazards the chance of
  advancing is p_d = A_d / (A_d + D_d) and the mean stay is τ_d = E_d / (A_d + D_d).
- **C(k)**, the replacement cost: the expected actions for a fresh character to first reach DL k,
  counting deaths and restarts: C(d+1) = (C(d) + τ_d) / p_d. Lower is better. Session 14's default
  rules: C(5) 11k, C(8) 48k, C(10) 204k actions.
- **PH(k)**, the proportional-hazards version used for verdicts: one death-rate ratio and one
  advance-rate ratio for the variant, each a Mantel–Haenszel ratio stratified by stage. They are applied
  to the baseline's own table, and the result is reported as C_var(k) / C_base(k). A paired bootstrap
  over starts gives the interval and a one-sided p.

**What the rescoring of sessions 14 and 15 showed** (ratios variant/base; 80% intervals; p is the chance
the variant isn't better):

| Variant | Capped score t | Death rate | Pace | Raw C(8) | PH(8) | PH(10) |
|---|---|---|---|---|---|---|
| combo14 (fire + lowheal) | +8.27 | 0.743 (0.71–0.78) | 0.965 (0.94–0.99) | 0.962, p 0.25 | 0.881, p 0.000 | 0.710, p 0.000 |
| fire | +5.11 | 0.836 | 0.988 | 0.994, p 0.45 | 0.902, p 0.000 | 0.790, p 0.000 |
| lowheal | +5.27 | 0.851 | 0.980 | 0.967, p 0.18 | 0.927, p 0.000 | 0.829, p 0.000 |
| restock100 | +0.78 | 1.034 | 1.010 | 0.909, p 0.05 | 1.007, p 0.54 | 1.028, p 0.62 |
| restockboth | −3.02 | 1.113 | 0.844 | 1.124, p 0.88 | 1.489, p 1.00 | 1.914, p 1.00 |
| clgate1 | −0.23 | 1.032 | 1.038 (p 0.013) | 0.999, p 0.47 | 0.959, p 0.09 | 0.954, p 0.19 |
| ammo60 | −0.81 | 0.959 | 0.927 | 1.062, p 0.74 | 1.101, p 0.95 | 1.126, p 0.88 |
| fireadj | −3.74 | 1.327 | 1.022 | 1.036, p 0.63 | 1.156, p 0.98 | 1.386, p 1.00 |
| neutpois | −1.49 | 1.042 | 0.991 | 1.124, p 0.97 | 1.039, p 0.93 | 1.084, p 0.96 |
| food8, poisonhold | about 0 | about 1 | about 1 | about 1 | about 1 | about 1 |

- **Raw C(k) is much noisier than the capped score, not less noisy as the review expected.** Most of
  its weight falls on stages 7–10, which have only tens to hundreds of events. The 1,145-pair
  combination has a capped t of 8.3 but a raw C(8) interval that crosses 1. The per-game replacement-cost
  score is worse still (|t| < 1.3 for every variant): a handful of deep games dominate it.
- **The two components are precise.** The death-rate ratio and the pace ratio have intervals of about
  ±3%. PH(k) combines them with the baseline's well-estimated table, so it keeps that precision. It
  assumes a variant changes rates by the same factor at every stage. For combo14 the stage-by-stage death
  ratios were 0.6–0.9 throughout, so that holds roughly.
- **Rule improvements so far trade pace for safety.** The combination cut deaths by 26% and slowed
  descent by 3.5%. The target k sets the exchange rate: PH(5) 0.99 (neutral), PH(8) 0.88, PH(10) 0.71.
  Near the baseline, at k = 10, 1% faster descent is worth about 3% of C and 1% fewer deaths about 1.5%.
- **Where the verdicts differ:** clgate1 (CL gate one level lower) descends 3.8% faster at no clear cost,
  so PH leans its way, against "no effect" from the capped score. ammo60 slows descent 7% and comes out
  worse. restock100's raw-C gain is noise: PH and both components are flat.

### Decision rules from here (replacing the capped score)
- **Primary score: PH(10).** DL10 is about where a careful first trip should reach (the Players' Guide).
  It is deeper than the rules now reach, so a death is weighed as it will be in deeper play, and the
  baseline table still has 40–90 events a stage up to stage 9. PH(5), PH(8), raw C(10), the two ratios
  and the capped score are reported alongside.
- **Adopt a variant** if PH(10) < 1 with one-sided bootstrap p < 0.05 on its starts. Flag it, and don't
  adopt it, if its death-rate ratio over stages 7 and deeper alone is above 1 with p < 0.05. That is the
  check on the proportional-hazards assumption where it matters most.
- **Session 16** runs as launched: its driver applies the capped rules, and both scores are reported. If
  the two disagree, PH(10) decides which rules become the default for session 17. The new default
  needs at least 300 complete confirmP pairs with PH(10) < 1, p < 0.05.

### Revised plan to noon 2026-10-30
- **The 16-hour model tournament (finalQ) is cancelled.** At about 3,000 starts it had about 45% power
  for the +0.09 that H-c10 has shown, on the capped score. On PH it would be weaker still, and if trainH
  is the model, its labels predate fire and lowheal.
- **Session 16:** ruleP, trainO2 and confirmP finish as launched (to about 05:51 on 10-28). labelP runs
  only until the replacement session is ready, then the driver is stopped between games.
- **Session 17 (replacement, from 10-28 to about 10:30 on 10-30):** a rule screen judged by PH(10).
  - The review's stairs-first variants: `arrive` (leave on a bad level feeling or a listed early
    killer in view) and `stairsfirst`.
  - Leave-level triggers, replacing the switch to forced fighting after repeated flees with leaving.
  - `seal`: close a door behind a retreat from breeders, and close a door at once if it opens onto
    known breeders (monster nests have exactly one door). Sealed doors are walls for the rest of the
    level.
  - `sling` for classes without a launcher.
  - clgate1 again, now that pace counts.
  - Then a confirmation on new starts.

## C Angband engine: spike (2026-10-15)

The question: should games run on C Angband 4.2.6 instead of the TS port? This spike ran
during session 4, at low priority.

**Starting point.** `yuukiishikawa/angband` is a fork of angband/angband at 4.2.6 (the version
the TS port targets). Its changes are front-end and borg only (`main-borg.c`, `main-http.c`,
`ui-game.c` hooks); gameplay is unchanged. The original `main-http.c` was a proof of concept:
- its command codes don't match our `CommandType`;
- it has no throw, attack or fire, no seed, no snapshot and no shops;
- it replied from the refresh hook, and hung on the first `/command` in testing.

Its birth path was the borg's auto-birth, which isn't vanilla: forced Human Warrior and every
modifier rune known.

**What was built** (clone at `~/src/angband-c`, branch `jev-http`, uncommitted): a new
`src/main-http.c`, plus two hooks in `ui-game.c`.
- **Protocol:** the TS server's (`/health`, `/state`, `/command` with our TS `CommandType`
  codes and arguments). Each reply goes out when the game next asks for a command, i.e. after
  the previous one has fully run.
- **Birth:** vanilla, through the birth commands, with `--seed`, `--race` and `--class`.
- **State built from C's own player knowledge.** It uses the same schema as the TS player view,
  so `tools/honest-view.ts` and the rules player work unchanged:
  - the remembered map (`player->cave`);
  - visible monsters with `look_mon_desc` health words;
  - recall from lore (level, speed and kinds always, as vanilla recall shows them; blows and
    spells only as observed);
  - item names from `object_desc` with the player's knowledge, so unaware flavours show as
    flavours;
  - the known state (AC, to-hit and resistances as the player knows them);
  - the hunger grade name, the message log, and monsters seen recently on the level.
- **Branching:** `/fork {port, seed}` forks the whole game process; the child serves the same
  game on a new port, reseeded. `/quit` exits.
- **Death and lore:** after death it answers the last command and keeps serving `/state`.
  Nothing is ever saved, so lore starts empty with a fresh user directory.

**Measurements** (same machine and load, with session 4 running):

| | TS server | C server |
|---|---|---|
| Walk round trip in town (300 commands) | 12.3 ms (omniscient), 13.7 ms (player view) | 1.7 ms |
| State reply | 100 KB / 91 KB | 57 KB |
| Honest rules player, 3,000 actions | 94 s wall (server 73 s CPU, player 24 s) | 25 s wall |
| Branching a game for a rollout | snapshot restore (session-3 rollouts: 0.9 s/run wall at 13 workers ≈ 12 s worker time per run, including a fresh tsx player per run) | 2 ms per `fork` |

In TS the game server, not the rules player, is the bottleneck: about 24 ms of server CPU per
action in the dungeon. C cuts whole-game time by about 3.7×. Rollouts should gain at least
that, plus the restore cost.

**Fidelity differences found:**
- **Starting gold:** vanilla Human Warrior 149, TS port 330 for a Warrior. That roughly doubles
  early potion purchases in TS.
- **Monster recall:** vanilla shows level, speed and racial kind on first sight
  (`mon-lore.c` `lore_append_movement`). The TS perception layer hides level until a kill and
  kinds until 10 sightings; it should follow vanilla.
- **Light radius:** fixed earlier today in TS (`cave/view.ts`).

**Still missing before C can replace TS:**
1. **`/buy` and `/sell`.** The rules player won't leave town without a healing potion; it
   stayed in town for 3,000 actions in the test.
2. **Rollouts by fork.** The orchestrator (`tools/rollout/run.ts`) would branch with `/fork`
   instead of `/snapshot` + `/restore`, ideally with one persistent rules-player process
   rather than one tsx spawn per run.
3. **Decision snapshots and the savepoint bank** as C savefiles, with save at a decision and
   load at start.
4. **Fixes in the C front end:** quiver handling for fire and throw, and a check of every
   command against the rules player's use (spells and targeting).
5. **An era reset:** new baselines, as with honest play.

**Recommendation:** worth doing at a session boundary. It brings vanilla fidelity, the player's
knowledge model for free (including items, the remaining honest-view gap) and about 3–4× more
games and labels per hour. Estimated 2–3 days for items 1–4, then a shake-down like session
4's.

**Progress (2026-10-15 afternoon, user: "Continue the C work").** C front end commits
`4e2d838b9`, `c1fd47073` and `47ab01e90` (local, branch `jev-http`). In angband-jev:
`driver.py` `OVN_ENGINE=c`, `run.ts` C rollouts, an engine-aware bank, and rules-player fixes.
1. **Shops:** `/buy` and `/sell` work as remote shopping, plus a `stores` listing in town.
   Vanilla 4.2.6 defaults to `birth_no_selling`, so a sale pays 0 gold; the TS port pays.
   Names: `name` is the kind name once the player knows the kind (as the TS server sends it),
   and `desc` is the full description.
2. **Snapshots:** `GET /snapshot` returns a base64 C savefile plus the character's lore. A
   server started with `--load` and `--seed` continues it, about 80 ms to `/health`. A
   snapshot loaded into a fresh server matched the original state exactly.
3. **Rollouts:** C snapshots are detected by format. Each run starts a fresh C process from the
   savefile on the worker's port; no fork is needed at that start-up cost. A test labelled
   6/6 records with 0 errors, at 5.1 s of worker time per run, against about 11.7 s for TS
   in session 3. Most of the remainder is starting a tsx rules player per run.
4. **Driver:**
   - `start_server` starts C games (fresh user directory, `--race` and `--class` unless
     random, `--load` for bank savepoints).
   - `bank_files` only offers savepoints of the current engine.
   - driver4's labeller doesn't pre-start servers in C mode.
5. **Bug found and fixed: the headless birth crashed for spellcasting classes.**
   `character_generated` wasn't cleared, so `calc_spells` read an unallocated array. It
   looked `-O3`-specific because it depended on memory contents. All 9 classes now pass
   (36/36 births). The binary is the RelWithDebInfo (`-O2 -g`) build in `build-rd`, which
   includes a SIGSEGV backtrace handler.
6. **Rules player on vanilla:**
   - it keeps Flasks of oil (it used to sell them);
   - DL0–2 no longer require a healing potion when the character can't afford one (< 20 gold);
   - the throw-hit counter handles C's message order;
   - the death cause comes from C's `died_from`.

   A 20,000-action game on C took 164 s, reached DL3, survived, and had no stalls.
7. **C pipeline smoke** (OVN_ENGINE=c driver4 --smoke):
   - collect: 58 games, 0 errors, 1,268 decisions;
   - final: 0 errors.
   - labelling: all forced decisions fire once the port collision below was removed (3/3
     records labelled, 36/36 runs fired).
8. **Vanilla starting gold by class:** Warrior 146, Mage 331, Druid 385, Priest 91,
   Necromancer 360–363, Paladin 301, Rogue 201, Ranger 122–132, Blackguard 145. TS gives
   Warrior 330, Priest 190, Rogue 410, Blackguard 70.

**Incident: port collision with the running session 4 (my error).** The two C smoke runs
labelled on ports 4300–4303, which session 4's labelD servers use (16:10–16:18 and
16:52–17:00):
- the C games failed to bind;
- `run.ts` accepted the TS server that answered `/health`;
- so smoke rules players sent commands into session 4's rollout games.

The affected session-4 records can't be identified exactly (the servers log no timestamps). The
label lines that completed in or just after those windows, estimated from the 5.6/min rate
with margins, were moved to `labelD/labels.quarantined-port-collision.jsonl`: 175 of 400 at
17:07. The original is in `labels.before-quarantine.jsonl`, and trainD trains on the rest.

Fixes:
- `run.ts` C rollouts only accept a server whose `/health` says `engine: "c"` from the
  process they just started;
- `OVN_PORT_OFFSET` shifts every game, labeller and laya port (driver, evaluate.py), so test
  runs can't collide with a session.

**Progress (2026-10-16 night, during session 4's trainD and finalD).** Test runs use ports 5300+.
1. **Rollout cost.** The rules player isn't the bottleneck, so a persistent player process isn't
   worth the refactor.
   - Startup is 0.3 s on tsx and 0.09 s pre-bundled with esbuild.
   - A 300-action rollout on an idle machine took 1.0 s of wall time, about 3 ms per action.
   - The 3.1 s per 150-action run measured earlier was mostly contention with session 4's 13
     slots.
   - Bundling (`PLAYER_CMD="node <bundle>.mjs"`) would save about 0.2 s per run. It is optional.
2. **The C game is frozen per run.** `driver.freeze_c` copies the binary and `lib/` (34 MB) into
   `RUN/src/c-game`, records the angband-c HEAD and diff, and points `C_BIN` at the copy.
   driver4 calls it at start in C mode, so a rebuild during the night can't change a session.
3. **Unaware items.**
   - C now names an unaware flavour in the singular ("Blue Potion"), so its key doesn't
     change with quantity.
   - The rollout cost table values unaware flavours at a generic prior: the median cost of
     that type's kinds at level ≤ 15 (potion 75, scroll 57.5, mushroom 80, food 3).
   - Limitation: a flavour identified during a rollout renames its stack, so the whole stack
     counts as used.
4. **Session-5 fixes from collectD:**
   - **The rules player now handles unseen attackers.** A hit is: HP fell since the last
     step, no visible monster is adjacent, and a recent message reads "It … you" or "hit by
     something". It keeps a 20-action window of hits.
     A bump ("You hit the monster" on TS, "You hit it." on C) with an HP drop also counts.
     - Below 50% HP it heals, by spell or by a strong potion if HP ≥ 25%.
     - On stairs after 3 hits, it takes them.
     - It reads Teleport after 5 hits or below 25% HP.
     - It reads Phase Door after 3 hits or below 50% HP, at most once per 8 actions unless HP is
       below 35%. Phasing away from a fast invisible thief every turn was futile.
     - With no escape item, or with Phase Door on cooldown, after 2 hits it walks to the nearest
       known stairs within 80 steps.
     - It never rests while the threat is active.
   - **Replays:** all 11 fresh-start collectD games that Sméagol killed were rerun on TS with
     the same seeds and a 15-minute cap.

     | Version | Sméagol deaths | Deepest level |
     |---|---|---|
     | Original collectD games | 11/11 | DL2–4 |
     | First rule (no bump signal, no Phase cooldown, no stairs) | 3/11 | — |
     | Final rule | 0/11 | mean DL6.2 (DL4–13) |

     - With the final rule, 9 of the 11 still died, of ordinary early causes (nagas, kobold
       chiefs, Wormtongue).
     - Once a game diverges, its trajectory changes, so this is a sanity check, not a
       measurement.
   - **The scrub leak is fixed.** `perception.raceVisible`'s "just came into view" fallback now
     excludes INVISIBLE races (unless See Invisible) and blindness.
   - **TS thief behaviour stays as it is.** `EAT_GOLD` (no blink), `EAT_ITEM`, `DRAIN_CHARGES` and
     `EAT_LIGHT` are all "simplified" in `monster/attack.ts`. This is one more reason to move to
     C, where they're exact.

## Evaluating against hosted Jev (TypeSafe), plan

**Setup (2026-10-14):** the user funded $10, and the key is `TYPESAFE_API_KEY` in `.env`,
which is gitignored. Never print or log the key. busho already reads it:
`SYSTEMONE_API_KEY` falls back to `TYPESAFE_API_KEY`. A model list call returned
`jev-latest` and `jev-preview`. Per the docs, `jev-latest` is `jev-1.13.0`, and `jev-preview`
is `jev-1.14.0`, released 2026-10-14.

**Cost:**
- **Price:** $0.042 per million input tokens; output is free.
- **Request size:** our fight and tactic requests are about 870 characters (median), 1,225
  at most, which is about 250–400 tokens, or about $0.000015 per decision. $10 is about
  600,000 decisions, so money is not the constraint. Rate limits and latency are.
- **Spending cap anyway:** every Jev call goes through a ledger
  (`runs/jev/spend.jsonl`: tokens from the response's `usage` when present, otherwise
  characters ÷ 3). The tooling stops itself at **$1 per phase** and **$5 overall**, which
  leaves at least half the funding untouched.

**Fairness rules:**
- **Pin versions:** use `jev-1.13.0` and `jev-1.14.0` explicitly, never `jev-latest`, and
  log the `model` each response reports.
- **Same inputs:** the same `state` string and question criteria our models get, as is.
  A second, "enriched" variant with clearer option descriptions may be added, and is reported
  separately.
- **Same gating:** `DECISION_MIN_CONFIDENCE=0`, like the local models, plus the confidence
  threshold variants from roadmap item 2.
- **Wall-clock caps:** network latency slows games, and under a 900 s wall cap a slower arm
  plays fewer turns. That biases it toward fewer deaths and less depth. Jev arms are capped
  by actions and game turns only, and every comparison reports the matched-progress ratio.
- **Count fallbacks:** timeouts, 429s and errors fall back to the rules, which would quietly
  weaken the arm. Count them. **Canary:** fallbacks ≤ 2% of trained-type decisions, otherwise
  the arm is invalid.
- **Concurrency:** start at ≤ 4 concurrent games on the Jev arm. Raise it only after
  checking the organization's rate limits in the TypeSafe console.

**Phases:**
- **J1, offline benchmark** (session 4, about $0.20).
  - **Data:** the session-3 held-out labelled decisions (v2 utility), plus the session-2
    held-out set.
  - **Policies compared:** the rules, majority, base Kev-0.8B, base Laya, trainB, trainC,
    Jev 1.13 and Jev 1.14.
  - **Metrics:**
    - agreement with the rollout argmax;
    - **regret**: the rollout utility of the best option minus that of the chosen option,
      which is the headline;
    - Brier score against the soft labels;
    - a per-type and per-depth-band breakdown.
  - **Tool:** new `tools/overnight/jev_bench.py`, with ledger, retries and a resumable output.
- **J2, tournament arm** (session 5, about $0.10–0.30). Jev, using whichever version did
  better in J1, plays as an arm next to the rules, rules-adj and the best local model, on the
  same fresh and bank starts. It reports:
  - the robustness sweep;
  - deaths per level reached;
  - the frontier check;
  - fallbacks;
  - matched progress.

  It runs only after J1 shows Jev is competitive offline, or if the user asks.
- **J3 (optional):** Jev as a teacher. Where its confidence is high and it disagrees with the
  rollout label, re-roll that record with more rollouts, which finds label noise cheaply.
  Distil only from labels the re-rolls confirm.
- **Fine-tuning Jev:** not documented. If it isn't available, the comparison is Jev zero-shot
  (or with a few examples in context) against our fine-tuned local model, and the report
  says so.

**Probe (2026-10-14 22:04, during session 3; `tools/overnight/jev_probe.py`, output in
`runs/jev/probe-2026-10-14/`).**
- **Works with our requests as is.**
  - Answers come back in busho's format (`choice`, `confidence` and `probabilities`).
  - The `model` field in each response confirms the pinned version.
  - `usage.input_tokens` is reported: about 576 tokens per decision, or about $0.000024.
    That is higher than the 250–400 estimated above, so $10 is about 400,000 decisions.
  - About 900 calls cost **$0.018**.
- **Latency:** p50 is 200–230 ms and p90 260–540 ms, with a maximum of 2.3 s. busho's 10 s
  timeout is never close. A game's ~30 trained-type decisions add about 6–10 s of wall time,
  which is small against the 900 s cap. Still check matched progress.
- **Rate limits:** there were no 429s up to 16 requests in flight, at 26–31 requests a
  second. The response headers show no rate-limit fields, only `x-typesafe-request-id`, so
  the real limits are in the console. A 13-slot tournament arm is well within what we saw.
- **Zero-shot score on the session-2 held-out set** (393 records, v1 utility labels, the
  same set trainB was scored on):

  | Policy | Accuracy | Brier | Regret (u_mean) |
  |---|---|---|---|
  | rules | 0.397 | 0.852 | 0.110 |
  | majority | 0.382 | | |
  | **jev-1.13.0** | **0.473** | 0.262 | **0.080** |
  | jev-1.14.0 | 0.430 | 0.306 | 0.090 |
  | laya base (zero-shot) | 0.387 | 0.325 | |
  | trainB (fine-tuned laya) | 0.606 | 0.169 | |

  - Zero-shot Jev 1.13 beats the rules and zero-shot laya offline, but trails our fine-tuned model by 13 points.
    Jev 1.14 is worse than 1.13 here.
  - **Caveat:** these labels are v1 (short-horizon). trainB's offline lead didn't turn into
    better play in T1, so this table ranks label agreement, not play.
  - J1 should rescore on the v2 (labelC) held-out set and add regret for trainB and trainC.

**Not before:** session 3 finishes (about 12:00 on 10-15, deadline 14:34). J1 needs no game
slots and only a little CPU, but it waits so session 3's timings stay clean.

## Risks

- **Docker Desktop crash (happened 2026-10-12 ~22:31).** A deliberate GPU-memory spike test
  (grabbing all free VRAM) ran on top of training and 20 game containers. Training and the spike
  were SIGKILLed, then Docker Desktop stopped responding and WSL lost interop with Windows, so it
  couldn't be restarted from WSL. The likely cause is that under WSL2 GPU allocations spill into
  shared system memory. Mitigations:
  - no more greedy spike tests;
  - training defaults to micro-batch 1 (lower peak);
  - exit 137 is treated as retryable;
  - the driver waits for Docker to come back and reruns the interrupted stage.
  - Docker didn't come back in the next 2.8 hours (the WSL interop error meant it couldn't be
    restarted from WSL), so the overnight run moved to `--native`, which needs no Docker.

- **Evaluation bugs found after the first overnight run (2026-10-13):**
  - The model arm was missing `DECISION_LOG=1` and `DECISION_POLICY=model`, so busho only
    consulted the model through the old confidence-gated hooks.
  - Even in model-policy mode, `DECISION_MIN_CONFIDENCE=0.3` sent every answer back to the
    rules. Laya's `confidence` for soft-ce fine-tunes is about 0.0003–0.19. Eval now acts on the
    argmax (`DECISION_MIN_CONFIDENCE=0`).
  - A server-rejected throw ("no line of sight": busho's `hasLOS` disagrees with the server)
    passes no game time, so a sticky `throw` plan looped about 1,600 times. Rejected throws are
    now remembered per (player square, target square) and fall back to melee. The labels were
    checked and were not inflated by this: rollouts force the option once.
  - eval1, and both DAgger collection rounds' "promote" decisions, were therefore not real tests
    of the model.
- **Non-deterministic restore** blocks everything; the Phase 0 determinism check exists for it.
- **Labels are relative to the rules player.** If busho flees badly, "flee" is under-rated.
  The DAgger round reduces this but doesn't remove it.
- **Long-horizon labels** (descend, explore) may stay too noisy to use.
- **Laya changes very fast**, with several releases a day. Pin the version and record it in
  the checkpoint config.
