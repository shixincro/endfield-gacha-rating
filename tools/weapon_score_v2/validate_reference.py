"""Independent, bounded per-item Monte Carlo check of weapon-score v2.

This intentionally does not reuse the scorer's transition or renewal kernels.
Only the final marginal PMFs are imported.  The discrete midrank score is NOT
asserted to be uniform: its reference mean is 50, but ties reduce its variance.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import random
import time

import numpy as np

try:
    from .scorer import reference_pmfs
except ImportError:
    from scorer import reference_pmfs


def simulate_one(total_draws: int, rng: random.Random) -> tuple[int, int]:
    """Fresh banner; finish the first-UP ten-pull, then reset all banner state."""
    six_count = 0
    up_count = 0
    banner_draws = 0
    missed_six = 0
    banner_has_up = False
    for pull in range(1, total_draws + 1):
        banner_draws += 1
        if banner_draws == 80 and not banner_has_up:
            is_six, is_up = True, True
        else:
            is_six = missed_six == 39 or rng.random() < 0.04
            is_up = is_six and rng.random() < 0.25
        if is_six:
            six_count += 1
            missed_six = 0
        else:
            missed_six += 1
        if is_up:
            up_count += 1
            banner_has_up = True
        if pull % 10 == 0 and banner_has_up:
            banner_draws = 0
            missed_six = 0
            banner_has_up = False
    return six_count, up_count


def simulate_many(total_draws: int, samples: int, seed: int) -> np.ndarray:
    rng = random.Random(seed)
    return np.asarray([simulate_one(total_draws, rng) for _ in range(samples)], dtype=int)


def midrank_table(pmf: np.ndarray) -> np.ndarray:
    return 100.0 * (np.cumsum(pmf) - 0.5 * pmf)


def compare_axis(pmf: np.ndarray, observations: np.ndarray, cdf_limit: float) -> dict:
    pmf = np.asarray(pmf, dtype=float)
    support = np.arange(len(pmf), dtype=float)
    mean = float(np.dot(support, pmf))
    variance = float(np.dot((support - mean) ** 2, pmf))
    ranks = midrank_table(pmf)
    score_mean = float(np.dot(ranks, pmf))
    score_variance = float(np.dot((ranks - score_mean) ** 2, pmf))
    count_se = math.sqrt(variance / len(observations))
    score_se = math.sqrt(score_variance / len(observations))
    hist = np.bincount(observations, minlength=len(pmf))
    if len(hist) > len(pmf):
        raise AssertionError("MC observed a count outside the reference PMF array")
    empirical_cdf = np.cumsum(hist) / len(observations)
    cdf_error = float(np.max(np.abs(empirical_cdf - np.cumsum(pmf))))
    empirical_mean = float(np.mean(observations))
    empirical_score = float(np.mean(ranks[observations]))
    checks = {
        "pmf_normalized": abs(float(pmf.sum()) - 1.0) < 1e-10,
        "pmf_nonnegative": bool(np.all(pmf >= -1e-13)),
        "count_mean_within_6se": abs(empirical_mean - mean) <= 6 * count_se + 1e-10,
        "cdf_within_dkw_familywise_limit": cdf_error <= cdf_limit + 1e-10,
        "exact_midrank_mean_50": abs(score_mean - 50.0) < 1e-8,
        "mc_midrank_mean_within_6se": abs(empirical_score - 50.0) <= 6 * score_se + 1e-8,
    }
    return {
        "expected_count": mean,
        "mc_mean_count": empirical_mean,
        "count_mean_standard_error": count_se,
        "count_mean_z": (empirical_mean - mean) / count_se if count_se else 0.0,
        "cdf_max_abs_error": cdf_error,
        "cdf_limit": cdf_limit,
        "exact_midrank_mean": score_mean,
        "mc_midrank_mean": empirical_score,
        "midrank_mean_standard_error": score_se,
        "checks": checks,
        "passed": all(checks.values()),
    }


def run_validation(draw_counts: list[int], max_samples: int, time_budget: float, seed: int) -> dict:
    if not draw_counts or any(n <= 0 or n % 10 for n in draw_counts):
        raise ValueError("draw counts must be positive multiples of 10")
    if max_samples < 100 or time_budget <= 0:
        raise ValueError("max_samples >= 100 and time_budget > 0 required")
    pilot_size = 100
    started = time.perf_counter()
    simulate_many(max(draw_counts), pilot_size, seed)
    pilot_seconds = time.perf_counter() - started
    # Keep the entire run (pilot included) below 10,000 trajectories.
    hard_cap = (10000 - pilot_size) // len(draw_counts)
    budget_cap = int(time_budget / max(pilot_seconds / pilot_size * len(draw_counts), 1e-9))
    samples = min(max_samples, hard_cap, max(100, budget_cap))
    familywise_alpha = 0.001
    comparisons = len(draw_counts) * 2
    # DKW: P(sup|F_n-F| > e) <= 2 exp(-2 n e^2), union over both axes/Ns.
    cdf_limit = math.sqrt(math.log(2 * comparisons / familywise_alpha) / (2 * samples))
    report = {
        "reference": "fresh banners; stop at end of first-UP ten-pull; fixed total budget",
        "method": "independent per-item MC versus exact marginal reference PMFs",
        "seed": seed,
        "pilot": {"samples": pilot_size, "total_draws": max(draw_counts), "seconds": pilot_seconds},
        "samples_per_budget": samples,
        "total_simulated_trajectories": pilot_size + samples * len(draw_counts),
        "familywise_cdf_alpha": familywise_alpha,
        "checks": [],
        "note": "Discrete midrank scores have mean 50 under the reference, not a uniform distribution.",
    }
    for index, total in enumerate(draw_counts):
        mc_start = time.perf_counter()
        observed = simulate_many(total, samples, seed + index + 1)
        mc_seconds = time.perf_counter() - mc_start
        dp_start = time.perf_counter()
        pmfs = reference_pmfs(total)
        dp_seconds = time.perf_counter() - dp_start
        axes = {name: compare_axis(pmfs[name], observed[:, column], cdf_limit)
                for column, name in enumerate(("six_star", "signature"))}
        report["checks"].append({
            "total_draws": total,
            "samples": samples,
            "mc_seconds": mc_seconds,
            "reference_seconds": dp_seconds,
            "axes": axes,
            "passed": all(axis["passed"] for axis in axes.values()),
        })
    report["passed"] = all(item["passed"] for item in report["checks"])
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draws", nargs="+", type=int, default=[80, 400])
    parser.add_argument("--max-samples", type=int, default=2000)
    parser.add_argument("--time-budget", type=float, default=5.0, help="soft budget for MC only, seconds")
    parser.add_argument("--seed", type=int, default=20261012)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = run_validation(args.draws, args.max_samples, args.time_budget, args.seed)
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
