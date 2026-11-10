"""Experimental weapon yield reference: complete a fixed number of UP banners.

Unlike scorer.py's fixed-budget reference, the budget here is random. Each new
banner starts at zero pity and ends after the complete ten-pull containing its
first signature weapon. There is no extra draw cap; the first-UP guarantee makes
the natural maximum 80 draws per banner. Both axes rank the observed K/N against
the marginal yield-ratio distribution from exactly `pools` completed banners.

This is NOT a percentile conditional on the observed N and is NOT a model of an
arbitrary observed strategy. With the default pools=10, even observations from
another number of banners are evaluated on the ten-banner reference scale.
Direct milestone gifts do not enter either output count. This module does not
change the historical/default fixed-budget scorer.

Completed-cycle probabilities come from the existing finite-state DP, followed
by two-dimensional (draws, count) convolution. No MC or deliberate probability
tail pruning is used. Float64 underflow remains possible for extreme tails.
Rational yield ties are merged by exact reduced fractions, never float equality.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
import json
from time import perf_counter

import numpy as np

try:
    from .scorer import AXES, _cycle_kernels, _freeze, _integer
except ImportError:
    from scorer import AXES, _cycle_kernels, _freeze, _integer


VERSION = "weapon-yield-completed-pools-experiment-1.0"
REFERENCE = "first_signature_ten_boundary_completed_pools_ratio"


def _pool_count(value: int) -> int:
    value = _integer(value, "pools")
    if value < 1:
        raise ValueError("pools must be a positive integer")
    return value


def _joint_pmf(pools: int, axis: str) -> np.ndarray:
    """Return P(total requisitions=t, total axis outputs=k), including all tails."""
    completed, _ = _cycle_kernels(axis)
    joint = np.ones((1, 1), dtype=np.float64)
    for count in range(1, pools + 1):
        nxt = np.zeros((8 * count + 1, 80 * count + 1), dtype=np.float64)
        for previous_tens in range(count - 1, 8 * (count - 1) + 1):
            previous = joint[previous_tens, :10 * previous_tens + 1]
            for length in range(1, 9):
                destination_tens = previous_tens + length
                nxt[destination_tens, :10 * destination_tens + 1] += np.convolve(
                    previous, completed[length]
                )
        joint = nxt
    mass = float(joint.sum())
    if abs(mass - 1) > 2e-10 or joint.min() < 0 or not np.isfinite(joint).all():
        raise ArithmeticError(f"Invalid completed-pool {axis} PMF: mass={mass}")
    return joint / mass


@dataclass(frozen=True)
class _RatioReference:
    fractions: tuple[Fraction, ...]
    pmf: np.ndarray
    prefix: np.ndarray
    suffix: np.ndarray
    scores: np.ndarray
    expected_rate: float
    expected_draws: float
    expected_count: float


def _collapse_ratios(joint: np.ndarray) -> _RatioReference:
    masses: dict[Fraction, float] = {}
    # Only exact zero entries are omitted, not small but positive probabilities.
    for tens, output in zip(*np.nonzero(joint)):
        ratio = Fraction(int(output), 10 * int(tens))
        masses[ratio] = masses.get(ratio, 0.0) + float(joint[tens, output])
    fractions = tuple(sorted(masses))
    pmf = np.array([masses[r] for r in fractions], dtype=np.float64)
    pmf /= pmf.sum()
    prefix = np.concatenate(([0.0], np.cumsum(pmf)))
    suffix = np.concatenate((np.cumsum(pmf[::-1])[::-1], [0.0]))
    scores = np.clip(100 * (prefix[:-1] + pmf / 2), 0, 100)
    rates = np.array([float(r) for r in fractions])
    return _RatioReference(
        fractions=fractions,
        pmf=_freeze(pmf),
        prefix=_freeze(prefix),
        suffix=_freeze(suffix),
        scores=_freeze(scores),
        expected_rate=float(rates @ pmf),
        expected_draws=float(10 * np.arange(joint.shape[0]) @ joint.sum(axis=1)),
        expected_count=float(np.arange(joint.shape[1]) @ joint.sum(axis=0)),
    )


@lru_cache(maxsize=8)
def _reference_cached(pools: int) -> tuple[_RatioReference, _RatioReference]:
    return tuple(_collapse_ratios(_joint_pmf(pools, axis)) for axis in AXES)


def reference_ratio_distribution(pools: int = 10) -> dict:
    """Return independent public copies of the two marginal ratio distributions.

    `expected_rate` is E[K/N], not E[K]/E[N]. The count and draw expectations
    describe the same random-budget completed-banner population. Fractions are
    returned alongside convenient float ratios to preserve exact equality.
    """
    pools = _pool_count(pools)
    output = {}
    for axis, ref in zip(AXES, _reference_cached(pools)):
        output[axis] = {
            "ratios": np.array([float(r) for r in ref.fractions]),
            "numerators": np.array([r.numerator for r in ref.fractions], dtype=np.int64),
            "denominators": np.array([r.denominator for r in ref.fractions], dtype=np.int64),
            "pmf": ref.pmf.copy(),
            "scores": ref.scores.copy(),
            "expected_rate": ref.expected_rate,
            "expected_draws": ref.expected_draws,
            "expected_count": ref.expected_count,
        }
    return output


def _axis_result(draws: int, count: int, ref: _RatioReference) -> dict:
    if draws:
        observed = Fraction(count, draws)
        left = bisect_left(ref.fractions, observed)
        right = bisect_right(ref.fractions, observed)
        less = min(1.0, float(ref.prefix[left]))
        equal = float(ref.pmf[left]) if right > left else 0.0
        greater = min(1.0, float(ref.suffix[right]))
        score = min(100.0, max(0.0, 100 * (less + equal / 2)))
    else:
        less = equal = greater = score = None
    return {
        "count": count,
        "rate": count / draws if draws else None,
        "score": score,
        "p_less": less,
        "p_equal": equal,
        "p_greater": greater,
        "reference_expected_rate": ref.expected_rate,
        "reference_expected_count": ref.expected_count,
        "reference_expected_draws": ref.expected_draws,
    }


def score_weapon_completed_pools(
    total_draws: int, six_star: int, signature: int, pools: int = 10,
    *, allow_individual_draws: bool = False,
) -> dict:
    """Rank observed yields against exactly `pools` completed fresh UP banners.

    Observed N may lie outside [10*pools, 80*pools]: the chosen reference scale
    remains the same. Zero observations are unscored, not assigned 50 points.
    """
    pools = _pool_count(pools)
    draws = _integer(total_draws, "total_draws")
    six = _integer(six_star, "six_star")
    up = _integer(signature, "signature")
    if type(allow_individual_draws) is not bool:
        raise ValueError("allow_individual_draws must be boolean")
    if draws < 0 or (draws % 10 and not allow_individual_draws):
        raise ValueError("total_draws must be a nonnegative multiple of 10")
    if not 0 <= up <= six <= draws:
        raise ValueError("counts must satisfy 0 <= signature <= six_star <= total_draws")
    references = _reference_cached(pools)
    warnings = [
        f"按完成{pools}个首专武池的产出率分布评分，不是相同实际抽数下的条件分位。",
        "成功十连完整结算后换池；保底计入产量，直接赠品不计；未修正追潜或试水。",
        "两维是各自参考分位，彼此相关，不是联合百分位或实际玩家排名。",
    ]
    if not draws:
        warnings.append("没有武器抽取记录，不赋予默认50分。")
    if draws % 10:
        warnings.append("实际记录包含单次申领，保留原始总抽数计算产出率；参照仍为完整十连平铺。")
    return {
        "version": VERSION,
        "reference": REFERENCE,
        "reference_pools": pools,
        "method": "100*(P(reference_ratio<observed_ratio)+0.5*P(equal))",
        "total_draws": draws,
        **{axis: _axis_result(draws, count, ref)
           for axis, count, ref in zip(AXES, (six, up), references)},
        "warnings": warnings,
    }


def clear_cache() -> None:
    """Clear this experiment's ratio cache, without changing scorer.py caches."""
    _reference_cached.cache_clear()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draws", required=True, type=int)
    parser.add_argument("--six-star", required=True, type=int)
    parser.add_argument("--signature", required=True, type=int)
    parser.add_argument("--pools", default=10, type=int)
    args = parser.parse_args()
    started = perf_counter()
    try:
        result = score_weapon_completed_pools(
            args.draws, args.six_star, args.signature, args.pools
        )
    except ValueError as error:
        parser.error(str(error))
    result["elapsed_seconds"] = perf_counter() - started
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
