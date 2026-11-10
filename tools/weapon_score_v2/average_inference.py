"""Infer an explicitly estimated weapon yield from a rounded screenshot mean.

The screenshot does not reveal its original numerator or gift count. This
module implements the user's maximum-numerator convention, keeps raw draw
counts separate, and reports the remaining ambiguity. It does not score.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _average_tenths(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    try:
        number = Decimal(str(value).strip())
        if not number.is_finite() or number < 0:
            return None
        numerator, denominator = number.as_integer_ratio()
        scaled, remainder = divmod(10 * numerator, denominator)
        return scaled if remainder == 0 else None
    except (InvalidOperation, ValueError, OverflowError):
        return None


def infer_weapon_average(N, K6, KU, displayed_average):
    """Return the largest feasible a, then the smallest b tied at that a.

    For c = q / 10, nonnegative ROUND_HALF_UP(a / b, 1) == c is exactly
        (2*q - 1)*b <= 20*a < (2*q + 1)*b.
    Thus each positive multiple-of-ten a has a finite, inclusive b interval
    when c > 0. Counting intervals avoids allocating potentially huge lists.
    candidate_count counts all feasible (a, b); tie_count counts only those
    sharing the selected maximal a. Neither count proves actual gifts.
    """
    result = {
        "status": "unavailable", "reason": None,
        "a": None, "b": None, "gifts": None, "excluded_draws": None,
        "displayed_average": None, "candidate_count": 0, "tie_count": 0,
        "ambiguous": False, "has_alternatives": False, "candidate_range": None,
        "provenance": {
            "method": "screenshot-up-average-max-a-v1",
            "rounding": "ROUND_HALF_UP to one decimal, exact integer bounds",
            "selection": "maximum a, then minimum b",
            "constraints": "0 < a <= N; a % 10 == 0; b >= max(KU, 1)",
            "raw": {"N": N, "K6": K6, "KU": KU},
            "evidence_type": "estimate from rounded screenshot average",
        },
    }
    if not all(_integer(v) for v in (N, K6, KU)) or not 0 <= KU <= K6 <= N:
        result["reason"] = "invalid_raw_counts"
        return result
    if displayed_average is None or displayed_average == "":
        result["reason"] = "missing_average"
        return result
    q = _average_tenths(displayed_average)
    if q is None:
        result["reason"] = "invalid_average"
        return result
    result["displayed_average"] = f"{q // 10}.{q % 10}"
    if q == 0:
        # Positive a would allow every b > 20*a: there is no finite inferred
        # output set. A displayed zero is not evidence that gifts are zero.
        result["reason"] = "zero_average_unbounded"
        return result
    if KU == 0:
        # The first-UP guarantee is already settled before a gift milestone.
        # A gift-only explanation cannot be established from this summary.
        result["reason"] = "no_raw_up"
        return result
    if N < 10:
        result["reason"] = "no_positive_ten_draw_numerator"
        return result

    chosen = None
    for a in range(N // 10 * 10, 0, -10):
        lower = max(KU, 1, (20 * a) // (2 * q + 1) + 1)
        upper = (20 * a) // (2 * q - 1)
        count = max(0, upper - lower + 1)
        result["candidate_count"] += count
        if count and chosen is None:
            chosen = (a, lower, upper, count)
    if chosen is None:
        result["reason"] = "no_integer_solution"
        return result

    a, b, upper, count = chosen
    result.update({
        "status": "estimated", "reason": None, "a": a, "b": b,
        "gifts": b - KU, "excluded_draws": N - a,
        "tie_count": count, "ambiguous": count > 1,
        "has_alternatives": result["candidate_count"] > 1,
        "candidate_range": {"a": a, "b_min": b, "b_max": upper},
    })
    return result
