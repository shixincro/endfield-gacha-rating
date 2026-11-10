"""Weapon yield scores against a fixed-budget, first-signature reference.

Inputs are individual weapon draws (ten draws per requisition) and RANDOM DRAW
outputs, including pity outputs but excluding directly granted milestone gifts.
The reference finishes each ten-pull, then switches to a fresh zero-pity banner
if that ten-pull obtained its first signature. It spends exactly the supplied
budget, retaining the final incomplete banner. Actual strategy is not inferred.

Each axis uses 100 * (P(reference_count < observed) + P(equal) / 2).
Counts at a fixed budget are equivalent to yield rates. These are marginal
reference percentiles, not a strategy-neutral measure or a joint percentile.
Finite-state DP and renewal convolutions use float64; no MC or tail pruning is
used in scoring. Tiny probabilities can underflow at floating-point precision.
"""

from __future__ import annotations

import argparse
from functools import lru_cache
import json
from numbers import Integral
from time import perf_counter

import numpy as np


VERSION = "weapon-yield-v2.0"
REFERENCE = "first_signature_ten_boundary_fixed_budget"
MAX_DRAWS = 5000
P_SIX = 0.04
P_UP_GIVEN_SIX = 0.25
AXES = ("six_star", "signature")


def _integer(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise ValueError(f"{name} must be an integer, not bool or a fraction")
    return int(value)


def _budget(value: int) -> int:
    value = _integer(value, "total_draws")
    if not 0 <= value <= MAX_DRAWS or value % 10:
        raise ValueError(f"total_draws must be a multiple of 10 in [0, {MAX_DRAWS}]")
    return value


def _freeze(array: np.ndarray) -> np.ndarray:
    array.setflags(write=False)
    return array


@lru_cache(maxsize=2)
def _cycle_kernels(axis: str) -> tuple[tuple[np.ndarray, ...], tuple[np.ndarray, ...]]:
    """Unconditional completed-cycle C[t] and no-UP prefix U[t] count PMFs.

    State is (has UP in this cycle, consecutive non-six draws, axis count).
    UP-positive states remain live THROUGH the successful ten-pull, preserving
    additional weapons after the first UP. Survivors have no UP at each boundary.
    The unique first-80 guarantee takes priority over the 40-draw guarantee.
    """
    if axis not in AXES:
        raise ValueError(axis)
    active = np.zeros((2, 40, 81), dtype=np.float64)
    active[0, 0, 0] = 1.0
    completed = [np.zeros(1)]
    unfinished = [np.ones(1)]
    for draw in range(1, 81):
        nxt = np.zeros_like(active)
        for has_up in (0, 1):
            if draw == 80 and not has_up:
                nxt[1, 0, 1:] += active[0, :, :-1].sum(axis=0)
                continue
            nxt[has_up, 1:, :] += (1 - P_SIX) * active[has_up, :39, :]
            six = P_SIX * active[has_up].sum(axis=0) + (1 - P_SIX) * active[has_up, 39]
            nxt[1, 0, 1:] += P_UP_GIVEN_SIX * six[:-1]
            if axis == "six_star":
                nxt[has_up, 0, 1:] += (1 - P_UP_GIVEN_SIX) * six[:-1]
            else:
                nxt[has_up, 0, :] += (1 - P_UP_GIVEN_SIX) * six
        active = nxt
        if draw % 10 == 0:
            completed.append(active[1].sum(axis=0)[:draw + 1].copy())
            active[1] = 0
            unfinished.append(active[0].sum(axis=0)[:draw + 1].copy())
    mass = sum(float(x.sum()) for x in completed)
    if abs(mass - 1) > 2e-12 or unfinished[-1].sum() > 2e-12:
        raise ArithmeticError(f"Invalid renewal cycle probability mass: {mass}")
    return tuple(_freeze(x) for x in completed), tuple(_freeze(x) for x in unfinished)


def reference_metadata() -> dict:
    complete, _ = _cycle_kernels("signature")
    mean_draws = sum(10 * t * float(p.sum()) for t, p in enumerate(complete))
    mean_outputs = {}
    for axis in AXES:
        kernels, _ = _cycle_kernels(axis)
        mean_outputs[axis] = sum(float(np.arange(len(p)) @ p) for p in kernels)
    return {
        "version": VERSION,
        "reference": REFERENCE,
        "method": "finite_state_dp_and_renewal_convolution_float64",
        "six_star_base": P_SIX,
        "signature_given_six_star": P_UP_GIVEN_SIX,
        "six_star_hard_pity": 40,
        "first_signature_guarantee": 80,
        "natural_signature_consumes_first_guarantee": True,
        "complete_successful_ten_pull": True,
        "reset_pity_on_switch": True,
        "retain_unfinished_final_banner": True,
        "direct_gifts_included": False,
        "max_total_draws": MAX_DRAWS,
        "mean_cycle_draws": mean_draws,
        "mean_cycle_outputs": mean_outputs,
        "long_run_yield": {k: v / mean_draws for k, v in mean_outputs.items()},
    }


def _renewal_pmf(draws: int, axis: str) -> np.ndarray:
    complete, unfinished = _cycle_kernels(axis)
    # F[t] counts paths finishing a renewal exactly after 10*t draws. Only the
    # preceding eight F entries are needed; do not allocate an N-by-N table.
    history: list[np.ndarray | None] = [None] * 9
    history[0] = np.ones(1)
    tens = draws // 10
    for t in range(1, tens + 1):
        at_boundary = np.zeros(10 * t + 1, dtype=np.float64)
        for length in range(1, min(8, t) + 1):
            previous = history[(t - length) % 9]
            at_boundary += np.convolve(previous, complete[length])
        history[t % 9] = at_boundary
    result = history[tens % 9].copy()
    # Include the final banner which has not obtained its first UP. Its six-star
    # off-targets matter even though its signature count is necessarily zero.
    for length in range(1, min(7, tens) + 1):
        previous = history[(tens - length) % 9]
        result += np.convolve(previous, unfinished[length])
    mass = float(result.sum())
    if abs(mass - 1) > 2e-10 or result.min() < 0:
        raise ArithmeticError(f"Invalid {axis} PMF: mass={mass}")
    # Only correct accumulated floating-point summation error, never discard bins.
    return _freeze(result / mass)


@lru_cache(maxsize=16)
def _reference_cached(draws: int) -> tuple[np.ndarray, np.ndarray]:
    return tuple(_renewal_pmf(draws, axis) for axis in AXES)


def reference_pmfs(total_draws: int) -> dict[str, np.ndarray]:
    """Return copies of marginal count PMFs; bin k is P(K=k)."""
    draws = _budget(total_draws)
    return {axis: p.copy() for axis, p in zip(AXES, _reference_cached(draws))}


def clear_cache() -> None:
    _reference_cached.cache_clear()
    _cycle_kernels.cache_clear()


def _axis_result(draws: int, observed: int, pmf: np.ndarray) -> dict:
    less = float(pmf[:observed].sum())
    equal = float(pmf[observed])
    greater = float(pmf[observed + 1:].sum())
    expected = float(np.arange(len(pmf)) @ pmf)
    return {
        "count": observed,
        "rate": observed / draws if draws else None,
        "score": min(100.0, max(0.0, 100 * (less + equal / 2))) if draws else None,
        "p_less": less,
        "p_equal": equal,
        "p_greater": greater,
        "expected_count": expected,
        "expected_rate": expected / draws if draws else None,
    }


def score_weapon(total_draws: int, six_star: int, signature: int) -> dict:
    """Score draw outputs ONLY. Keep granted gifts outside both count inputs."""
    draws = _budget(total_draws)
    six = _integer(six_star, "six_star")
    up = _integer(signature, "signature")
    if not 0 <= up <= six <= draws:
        raise ValueError("counts must satisfy 0 <= signature <= six_star <= total_draws")
    pmfs = _reference_cached(draws)
    result = {
        "version": VERSION,
        "reference": REFERENCE,
        "method": "100*(P(K<observed)+0.5*P(K=observed))",
        "total_draws": draws,
        "six_star": _axis_result(draws, six, pmfs[0]),
        "signature": _axis_result(draws, up, pmfs[1]),
        "warnings": [
            "固定预算平铺首专武基准；未校正追潜、试水、专属赠券或实际停手规则。",
            "两维是各自的参考分位，彼此相关；不是联合百分位或实际玩家排名。",
        ],
    }
    if not draws:
        result["warnings"].append("没有武器抽取记录，不赋予默认50分。")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draws", required=True, type=int, help="武器件数，须为10的倍数")
    parser.add_argument("--six-star", required=True, type=int, help="抽出的全部六星，含保底，不含赠送")
    parser.add_argument("--signature", required=True, type=int, help="抽出的当期专武，含保底，不含赠送")
    args = parser.parse_args()
    started = perf_counter()
    try:
        result = score_weapon(args.draws, args.six_star, args.signature)
    except ValueError as error:
        parser.error(str(error))
    result["elapsed_seconds"] = perf_counter() - started
    result["reference_details"] = reference_metadata()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
