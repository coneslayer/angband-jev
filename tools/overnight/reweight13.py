"""Session 13: gate scores on held-out labelL, weighted back to how often each pool stratum occurs in play. Usage: reweight13.py RUN"""
import json, sys
run = sys.argv[1]
POOL = {"hi": 20811, "lo": 44448, "agree": 100232}
strat, order = {}, []
for line in open(f"{run}/labelL/decisions.jsonl"):
    r = json.loads(line)
    dis = bool(r.get("model_choice") and r.get("rules_choice") and r["model_choice"] != r["rules_choice"])
    s = "agree" if not dis else ("hi" if float(r.get("model_confidence") or 0) >= 0.1 else "lo")
    strat[(r["game_id"], int(r["turn"]), r["decision_type"])] = s
labelled = {"hi": 0, "lo": 0, "agree": 0}
for line in open(f"{run}/labelL/labels.jsonl"):
    r = json.loads(line); m = r.get("meta", r)
    k = (m["game_id"], int(m["turn"]), m["decision_type"])
    if k in strat: labelled[strat[k]] += 1
w = {s: POOL[s] / labelled[s] for s in POOL}
print("labelled", labelled, "weights", {s: round(v, 1) for s, v in w.items()})
for model in ("trainH", "trainI0", "trainIL", "trainHJL"):
    rows = [json.loads(l) for l in open(f"{run}/trainIL/{model}.heldout.L.answers.jsonl")]
    out = []
    for gate in (0.0, 0.02, 0.05, 0.1, 0.2):
        W = S = n = 0; wins = losses = 0.0
        for r in rows:
            s = strat.get((r["game_id"], int(r["turn"]), r["type"]))
            if s is None: continue
            ww = w[s]; W += ww
            a = r["answer"]; c = a.get("choice")
            if c is None or c == r["rules"] or a["confidence"] < gate: continue
            d = r["gold"].get(c, 0) - r["gold"].get(r["rules"], 0)
            S += ww * d; n += 1
            wins += ww * (d > 0); losses += ww * (d < 0)
        out.append(f"g{gate}: {1000*S/W:5.1f} (n {n}, W/L {wins/W*1000:.0f}/{losses/W*1000:.0f})")
    print(f"{model:9s}", " | ".join(out))
