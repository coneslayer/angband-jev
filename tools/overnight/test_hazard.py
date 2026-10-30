#!/usr/bin/env python3
"""Tests for hazard.py's sequential screen, on simulated games only.

Run: python3 -I tools/overnight/test_hazard.py [-v]
HAZARD_TEST_SCALE (default 1) multiplies the Monte Carlo replicate counts; at 1 the run takes a few minutes.
The power test prints the operating characteristics of the design (power, expected pairs, where it stops).
"""
import json, math, os, statistics, sys, unittest  # noqa: E401
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I
import hazard as H  # noqa: E402

SCALE = float(os.environ.get("HAZARD_TEST_SCALE", "1"))


def reps(n):
    return max(10, int(n * SCALE))


def pace_for_null(death_rr):
    """The pace ratio that makes PH(10) exactly 1 with this death ratio."""
    lo, hi = 0.5, 1.5
    for _ in range(60):
        mid = (lo + hi) / 2
        if H.true_ph(death_rr, mid) > 1: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def operating(death_rr, pace_rr, n_rep, seed0, **kw):
    """Simulated design: adoption rate, mean pairs used, stops per look, mean log PH and sd at the last look."""
    adopt, pairs, stops, last = 0, [], {}, []
    for s in range(n_rep):
        b, v = H.simulate(H.LOOKS[-1], death_rr, pace_rr, seed=seed0 + s, **kw)
        r = H.run_screen(b, v)
        adopt += r["decision"] == "adopt"
        pairs.append(r["pairs"])
        key = f"{r['decision']}@{r['look']}"
        stops[key] = stops.get(key, 0) + 1
    return {"adopt": adopt / n_rep, "esn": statistics.mean(pairs), "stops": stops, "n": n_rep}


def analytic(theta, futility=True):
    """Normal-theory power and expected pairs for drift theta (the expected final z)."""
    t = [n / H.LOOKS[-1] for n in H.LOOKS]
    lo = list(H.futility_bounds()) if futility else [None] * (len(t) - 1) + [H.obf_bounds()[-1]]
    pu, pl = H.exit_probs(list(H.obf_bounds()), lo, t, theta)
    stop = [pu[k] + pl[k] for k in range(len(t))]
    esn = sum(H.LOOKS[k] * stop[k] for k in range(len(t) - 1)) + H.LOOKS[-1] * (1 - sum(stop[:-1]))
    return sum(pu), esn


class Bounds(unittest.TestCase):
    def test_obf_alpha(self):
        b = H.obf_bounds()
        t = [n / H.LOOKS[-1] for n in H.LOOKS]
        self.assertAlmostEqual(sum(H.exit_probs(list(b), [None] * 3, t)[0]), H.ALPHA, places=6)
        # O'Brien-Fleming shape: b_k * sqrt(t_k) constant, decreasing bounds
        self.assertAlmostEqual(b[0] * math.sqrt(t[0]), b[-1], places=9)
        self.assertGreater(b[0], b[1]); self.assertGreater(b[1], b[2])
        # Monte Carlo check of the integration
        import random
        rng, hits, n = random.Random(1), 0, 100000
        for _ in range(n):
            s = tp = 0.0
            for k, tk in enumerate(t):
                s += rng.gauss(0, math.sqrt(tk - tp)); tp = tk
                if s / math.sqrt(tk) >= b[k]: hits += 1; break
        self.assertLess(abs(hits / n - H.ALPHA), 4 * math.sqrt(H.ALPHA * (1 - H.ALPHA) / n))

    def test_futility(self):
        f, b = H.futility_bounds(), H.obf_bounds()
        self.assertEqual(f[-1], b[-1])
        for k in range(len(f) - 1): self.assertLess(f[k], b[k])
        # non-binding: with futility stopping the type I error can only fall
        t = [n / H.LOOKS[-1] for n in H.LOOKS]
        self.assertLessEqual(sum(H.exit_probs(list(b), list(f), t)[0]), H.ALPHA)


class Simulator(unittest.TestCase):
    def test_reproduces_table(self):
        """The baseline arm's per-stage rates match the generating table (fresh starts, stages with many events)."""
        b, _ = H.simulate(6000, seed=11, bank_share=0.0)
        t = H.rates(b.values())
        for d in range(1, 8):
            E, D, A = H.BASELINE_14[d]
            se_d, se_a = 1 / math.sqrt(max(t[d][1], 1)), 1 / math.sqrt(max(t[d][2], 1))
            self.assertLess(abs(math.log((t[d][1] / t[d][0]) / (D / E))), 4 * se_d, f"death rate, stage {d}")
            self.assertLess(abs(math.log((t[d][2] / t[d][0]) / (A / E))), 4 * se_a, f"advance rate, stage {d}")

    def test_shape_and_caps(self):
        b, v = H.simulate(400, 0.9, 1.05, seed=3)
        self.assertEqual(set(b), set(v))
        for g in list(b.values()) + list(v.values()):
            self.assertEqual(set(g), {"id", "bank", "start", "end", "actions", "dead", "segs"})
            self.assertEqual(g["bank"], g["id"].startswith("bank-"))
            self.assertLessEqual(g["actions"], 15000 if g["bank"] else 20000)
            self.assertAlmostEqual(sum(s[1] for s in g["segs"]), g["actions"], delta=1)
            self.assertEqual(g["segs"][-1][2], "death" if g["dead"] else "cens")
            if g["bank"]: self.assertTrue(5 <= g["start"] <= 12)
        share = sum(g["bank"] for g in b.values()) / len(b)
        self.assertLess(abs(share - 0.2), 0.06)

    def test_pairs_share_randomness(self):
        """Under the null, paired games are identical until they diverge: far more alike than unpaired ones."""
        b, v = H.simulate(600, seed=4)
        ids = sorted(b)
        same = sum(b[i]["segs"] == v[i]["segs"] for i in ids) / len(ids)
        self.assertGreater(same, 0.2)
        paired = statistics.correlation([b[i]["actions"] for i in ids], [v[i]["actions"] for i in ids])
        self.assertGreater(paired, 0.3)


class Estimator(unittest.TestCase):
    def test_ph_close_to_truth(self):
        for dr, pr in ((0.85, 1.0), (0.9, 1.03), (0.74, 0.965), (1.0, 0.97)):
            ests, drs, prs = [], [], []
            for s in range(4):
                b, v = H.simulate(2000, dr, pr, seed=100 + s)
                tb, tv = H.rates(b.values()), H.rates(v.values())
                d, p = H.mh_ratio(tb, tv, 1), H.mh_ratio(tb, tv, 2)
                ests.append(math.log(H.ctable(H.scaled(tb, d, p))[10] / H.ctable(tb)[10])); drs.append(d); prs.append(p)
            truth = math.log(H.true_ph(dr, pr))
            # 4 x 2,000 pairs: sd of the mean log PH about 0.02
            self.assertLess(abs(statistics.mean(ests) - truth), 0.06, f"PH(10) for {dr}, {pr}")
            self.assertLess(abs(statistics.mean(drs) - dr), 0.04)
            self.assertLess(abs(statistics.mean(prs) - pr), 0.02)

    def test_bootstrap_and_delta_sd_agree(self):
        for s in range(3):
            b, v = H.simulate(300, 0.9, 1.0, seed=200 + s)
            rb = H.screen(b, v, 2, sd="bootstrap", n_boot=400, seed=s)
            rd = H.screen(b, v, 2, sd="delta")
            self.assertAlmostEqual(rb["PH"], rd["PH"])
            self.assertTrue(0.8 < rb["sd"] / rd["sd"] < 1.25, (rb["sd"], rd["sd"]))


class Screen(unittest.TestCase):
    def test_decisions(self):
        b, v = H.simulate(700, 0.74, 0.965, seed=7)
        self.assertEqual(H.screen(b, v, 1, ids=sorted(b)[:100])["decision"], "continue")  # too few pairs
        r = H.screen(b, v, sd="delta")
        self.assertEqual(r["look"], 3)
        self.assertIn(r["decision"], ("adopt", "reject"))
        # the deep-death guard: a variant with fewer deaths early but more deep must not be adopted
        def deep_worse(g):
            g = dict(g)
            if g["dead"] or g["end"] < H.DEEP_STAGE: return g
            g["segs"] = g["segs"][:-1] + [(g["segs"][-1][0], g["segs"][-1][1], "death", None)]
            g["dead"] = True
            return g
        v2 = {i: deep_worse(g) for i, g in v.items()}
        r2 = H.screen(b, v2, 3, sd="delta")
        self.assertNotEqual(r2["decision"], "adopt")
        self.assertGreater(r2["death_rr_deep"], 1)


def write_game(root, g):
    """A simulated game as the files parse_game reads: player.log status lines every 200 actions and depth changes,
    and busho-play-report.json's summary."""
    d = os.path.join(root, g["id"])
    os.makedirs(d)
    lines, t, depth, nxt = [], 0.0, g["start"], 200
    for st, e, kind, to in g["segs"]:
        end = t + e
        while nxt <= end and nxt <= g["actions"]:
            lines.append(f"  [状態] A{nxt} T{nxt * 10} HP10/10 | DL{depth} CL1"); nxt += 200
        if kind == "adv":
            lines.append(f"  [深度変更] DL{depth} → DL{to} (WoR/階段)"); depth = to
        t = end
    with open(os.path.join(d, "player.log"), "w", encoding="utf-8") as f: f.write("\n".join(lines) + "\n")
    with open(os.path.join(d, "busho-play-report.json"), "w") as f:
        json.dump({"summary": {"actions": g["actions"], "dead": g["dead"], "maxDepth": g["end"]}}, f)


class Files(unittest.TestCase):
    def test_round_trip_and_cli(self):
        """Simulated games written as logs parse back to the same games, and `hazard.py screen` runs on them."""
        import subprocess, tempfile
        b, v = H.simulate(160, 0.8, 1.0, seed=9)
        with tempfile.TemporaryDirectory() as tmp:
            for arm, games in (("base", b), ("var", v)):
                os.makedirs(os.path.join(tmp, arm))
                for g in games.values(): write_game(os.path.join(tmp, arm), g)
            back = H.load([os.path.join(tmp, "base")])
            self.assertEqual(set(back), set(b))
            for i, g in b.items():
                self.assertEqual((back[i]["start"], back[i]["end"], back[i]["dead"], back[i]["actions"]),
                                 (g["start"], g["end"], g["dead"], g["actions"]))
            out = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "hazard.py"), "screen", os.path.join(tmp, "base"), os.path.join(tmp, "var")],
                                 capture_output=True, text=True, timeout=300)
            self.assertEqual(out.returncode, 0, out.stderr)
            r = json.loads(out.stdout)
            self.assertEqual((r["look"], r["pairs"]), (1, 160))
            self.assertIn(r["decision"], ("adopt", "reject", "continue"))
            self.assertEqual(len(r["bounds"]), 3)


class TypeI(unittest.TestCase):
    def check(self, label, res):
        se = math.sqrt(H.ALPHA * (1 - H.ALPHA) / res["n"])
        print(f"\n  type I, {label}: {res['adopt']:.4f} (Monte Carlo se {se:.4f}), {res['n']} replicates, "
              f"expected pairs {res['esn']:.0f}", file=sys.stderr)
        self.assertLessEqual(res["adopt"], H.ALPHA + 1.645 * se)

    def test_null(self):
        self.check("deaths 1, pace 1", operating(1.0, 1.0, reps(1200), 10000))

    def test_null_offsetting(self):
        """PH(10) = 1 with both rates moved: fewer deaths, slower descent."""
        p = pace_for_null(0.9)
        self.assertAlmostEqual(H.true_ph(0.9, p), 1.0, places=6)
        self.check(f"deaths 0.9, pace {p:.4f}", operating(0.9, p, reps(500), 20000))

    def test_null_heterogeneous(self):
        """Characters differ (frailty shared by the pair): still a null."""
        self.check("deaths 1, pace 1, frailty 0.5/0.2",
                   operating(1.0, 1.0, reps(400), 30000, frailty=0.5, pace_frailty=0.2))

    def test_null_bootstrap_sd(self):
        """The production path: the bootstrap sd (fewer resamples, to keep the run short)."""
        adopt, n = 0, reps(150)
        for s in range(n):
            b, v = H.simulate(H.LOOKS[-1], seed=40000 + s)
            ids = sorted(b, key=lambda g: g.split("-")[-1])
            for k, m in enumerate(H.LOOKS, 1):
                r = H.screen(b, v, k, sd="bootstrap", n_boot=200, seed=s, ids=ids[:m])
                if r["decision"] != "continue": break
            adopt += r["decision"] == "adopt"
        self.check("bootstrap sd, n_boot 200", {"adopt": adopt / n, "n": n, "esn": float("nan")})


class Power(unittest.TestCase):
    def test_report(self):
        scenarios = [("deaths 0.95", 0.95, 1.0), ("deaths 0.90", 0.90, 1.0), ("deaths 0.85", 0.85, 1.0),
                     ("pace 0.97", 1.0, 0.97), ("pace 1.03", 1.0, 1.03),
                     ("fire+lowheal (0.74, 0.965)", 0.74, 0.965)]
        # sd of log PH(10) at the last look under the null, for the normal-theory columns
        sds = []
        for s in range(reps(30)):
            b, v = H.simulate(H.LOOKS[-1], seed=50000 + s)
            sds.append(H.screen(b, v, 3, sd="delta")["sd"])
        sd700 = statistics.mean(sds)
        lines = [f"\n  Operating characteristics (looks {H.LOOKS}, efficacy bounds "
                 f"{', '.join(f'{x:.3f}' for x in H.obf_bounds())}, futility "
                 f"{', '.join(f'{x:.3f}' for x in H.futility_bounds()[:-1])}; sd of log PH(10) at "
                 f"{H.LOOKS[-1]} pairs about {sd700:.3f})",
                 f"  {'scenario':28s} {'PH(10)':>7s} {'adopt':>6s} {'E[pairs]':>8s} {'normal':>7s} {'no-fut':>7s}  stops"]
        results = {}
        for i, (label, dr, pr) in enumerate(scenarios):
            res = operating(dr, pr, reps(250), 60000 + 1000 * i)
            ph = H.true_ph(dr, pr)
            theta = -math.log(ph) / sd700
            pw, _ = analytic(theta); pw0, _ = analytic(theta, futility=False)
            results[label] = res
            stops = " ".join(f"{k}:{v}" for k, v in sorted(res["stops"].items()))
            lines.append(f"  {label:28s} {ph:7.3f} {res['adopt']:6.3f} {res['esn']:8.0f} {pw:7.3f} {pw0:7.3f}  {stops}")
        print("\n".join(lines) + "\n  (adopt, E[pairs]: simulated; normal, no-fut: normal theory with and without "
              "the futility bound)", file=sys.stderr)
        # sanity: monotone in the effect, harmful variants seldom adopted
        self.assertLess(results["deaths 0.95"]["adopt"], results["deaths 0.85"]["adopt"])
        self.assertLess(results["pace 0.97"]["adopt"], 0.02)
        self.assertGreater(results["fire+lowheal (0.74, 0.965)"]["adopt"], 0.8)


if __name__ == "__main__":
    unittest.main()
