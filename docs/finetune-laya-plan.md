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
(none yet)

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
