"""Deterministic weapon-yield approximation for a supplied RESULT profile.

``12 5 1`` describes twelve acquired types: six copies of one, two of another,
and one each of the remaining ten. Values above five retain overflow copies.
``11 5*7`` abbreviates seven types at potential five and four at zero;
the left operand is potential and the right operand is the number of types.
The observed result is used as a reference stopping target, not recovered as
the player's original intention. Each independent reference banner starts at
zero, reaches that copy target (including gifts), and finishes its ten-pull.

Finite-state DP calculates exact terminal first/second moments in float64.
The score then APPROXIMATES P(K_ref/N_ref < K_obs/N_obs) by a normal residual
K_ref - observed_rate*N_ref. It is neither an exact ratio percentile nor an
exact conditional distribution given the player's result or actual strategy.
Both scored outputs include milestone gifts; supplied K6/KU remain raw drawn
counts, including forced 40/80 outputs and excluding directly granted gifts.
No simulation, fitted correction, H80 subtraction, or probability pruning.
"""

from __future__ import annotations

from collections import Counter
from functools import lru_cache
import math
import re

import numpy as np

try:
    from .scorer import P_SIX, P_UP_GIVEN_SIX, _integer
except ImportError:
    from scorer import P_SIX, P_UP_GIVEN_SIX, _integer


VERSION = "weapon-result-profile-gift-inclusive-normal-1.0"
REFERENCE = "result_profile_fresh_banners_terminal_moments_normal_ratio"
MAX_PROFILE_TYPES = 1000
MAX_PROFILE_TEXT = 8192
MAX_DP_CELL_UPDATES = 120_000_000
MAX_TOTAL_DRAWS = 1_000_000_000
RAW_VARIABLES = ("draws", "drawn_six_star", "drawn_signature", "gifts")
VARIABLES = ("draws", "six_star", "signature")
_INCLUSIVE = np.array([[1., 0., 0., 0.],
                       [0., 1., 0., 1.],
                       [0., 0., 1., 1.]])


def parse_profile(profile: str) -> dict:
    """Parse total types followed by potentials or potential*type-count groups.

    Unlisted types have zero potential. Group order has no model significance,
    but the two operands in a group have distinct roles and cannot be swapped;
    normalized text sorts positive potentials and omits explicit zero entries.
    ``0`` is the empty result. Limits protect the service from oversized input,
    and do not impose the in-game five-potential display cap on acquired copies.
    """
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("结果谱不能为空，例如 12、12 5 1 或 11 5*7。")
    if len(profile) > MAX_PROFILE_TEXT:
        raise ValueError(f"结果谱文本不能超过 {MAX_PROFILE_TEXT} 个字符。")
    tokens = re.sub(r"\s*\*\s*", "*", profile).split()
    if (re.fullmatch(r"[0-9]+", tokens[0]) is None
            or any(re.fullmatch(r"[0-9]+(?:\*[0-9]+)?", token) is None
                   for token in tokens[1:])):
        raise ValueError("首项须为种类数；后续填非负潜能或“潜能*数量”，例如 11 5*7。")
    groups = [token.split("*") for token in tokens]
    # Check digit lengths before int conversion and before array allocation.
    if any(len(value.lstrip("0")) > 9 for group in groups for value in group):
        raise ValueError("结果谱中的数值过大。")
    groups = [[int(value.lstrip("0") or "0") for value in group] for group in groups]
    types, listed = groups[0][0], []
    if types > MAX_PROFILE_TYPES:
        raise ValueError(f"结果谱种类数最多支持 {MAX_PROFILE_TYPES}。")
    for group in groups[1:]:
        potential, count = group[0], group[1] if len(group) == 2 else 1
        if count < 1:
            raise ValueError("“潜能*数量”中的数量须为正整数。")
        if len(listed) + count > types:
            raise ValueError("展开后的潜能项数不能超过首项指定的专武种类数。")
        listed.extend([potential] * count)
    potentials = sorted(listed + [0] * (types - len(listed)), reverse=True)
    copies = [potential + 1 for potential in potentials]
    counts = Counter(copies)
    return {
        "total_types": types,
        "potentials": potentials,
        "copies_per_type": copies,
        "total_copies": sum(copies),
        "normalized": " ".join(map(str, [types] + [p for p in potentials if p])),
        "copy_target_counts": [{"copies": c, "types": counts[c]} for c in sorted(counts)],
        "overflow_copies": sum(max(0, c - 6) for c in copies),
        "interpretation": "actual_result_used_as_reference_target",
    }


def _gift_count(draws: int) -> int:
    """Gift milestones are 180, 340, ..., 820, 980, ... individual draws."""
    return 0 if draws < 180 else 1 + (draws - 180) // 160


def _horizon(copies: int) -> int:
    # The first drawn UP is guaranteed by 80. Gifts alone then finish the rest.
    return 80 if copies == 1 else 180 + 160 * (copies - 2)


def _work_units(copies: int) -> int:
    return _horizon(copies) * (copies + 10) * 40 * 3


def _advance(active: np.ndarray, draw: int) -> np.ndarray:
    """Advance weighted moments [mass, E(K6), E(K6**2)] for (drawnUP,pity)."""
    nxt = np.zeros_like(active)
    nxt[:, :, 1:] = (1.0 - P_SIX) * active[:, :, :39]
    six = P_SIX * active.sum(axis=2) + (1.0 - P_SIX) * active[:, :, 39]
    up = P_UP_GIVEN_SIX * six
    off = (1.0 - P_UP_GIVEN_SIX) * six
    if draw == 80:
        # Only paths with no earlier drawn UP retain the one-time guarantee.
        nxt[:, 0, :] = 0.0
        up[:, 0] = active[:, 0, :].sum(axis=1)
        off[:, 0] = 0.0
    for source in (up, off):
        source[2] += 2.0 * source[1] + source[0]
        source[1] += source[0]
    nxt[:, 1:, 0] += up[:, :-1]
    nxt[:, :, 0] += off
    return nxt


@lru_cache(maxsize=64)
def _target_moments(copies: int) -> tuple[np.ndarray, np.ndarray, float]:
    """Exact moments of [N, drawn K6, drawn KU, gifts] for one copy target.

    The UP index is not clipped when the target is hit: all remaining draws
    in that ten-pull, plus a gift at its boundary, still enter terminal output.
    Raw second moments are accumulated before converting to covariance.
    """
    copies = _integer(copies, "copies")
    if copies < 1 or _work_units(copies) > MAX_DP_CELL_UPDATES:
        raise ValueError("单种专武的份数超出当前确定性计算预算。")
    active = np.zeros((3, copies + 10, 40), dtype=np.float64)
    active[0, 0, 0] = 1.0
    mean = np.zeros(4)
    second = np.zeros((4, 4))
    mass = 0.0
    up_values = np.arange(copies + 10, dtype=np.float64)
    for draw in range(1, _horizon(copies) + 1):
        active = _advance(active, draw)
        if draw % 10:
            continue
        gifts = _gift_count(draw)
        complete = up_values + gifts >= copies
        terminal = active[:, complete, :].sum(axis=2)
        active[:, complete, :] = 0.0
        probability, six_sum, six_square_sum = terminal
        up = up_values[complete]
        local_mass = float(probability.sum())
        mass += local_mass
        deterministic = {0: np.full_like(up, draw), 2: up,
                         3: np.full_like(up, gifts)}
        mean[1] += float(six_sum.sum())
        second[1, 1] += float(six_square_sum.sum())
        for i, value in deterministic.items():
            mean[i] += float(value @ probability)
            second[i, 1] += float(value @ six_sum)
            second[1, i] += float(value @ six_sum)
            for j, other in deterministic.items():
                second[i, j] += float((value * other) @ probability)
    if abs(mass - 1.0) > 2e-11 or float(active[0].sum()) > 2e-11:
        raise ArithmeticError(f"结果谱 DP 概率质量不守恒：{mass}")
    # Normalize only float summation error; no small-probability paths are cut.
    mean /= mass
    second /= mass
    covariance = second - np.outer(mean, mean)
    covariance = (covariance + covariance.T) / 2.0
    mean.setflags(write=False)
    covariance.setflags(write=False)
    return mean, covariance, mass


def reference_profile_moments(profile: str) -> dict:
    """Public, JSON-safe copies of the exact terminal moments, not a PMF."""
    parsed = parse_profile(profile)
    targets = parsed["copy_target_counts"]
    work = sum(_work_units(row["copies"]) for row in targets)
    if work > MAX_DP_CELL_UPDATES:
        raise ValueError("结果谱超出当前确定性计算预算，请减少不同高份数项。")
    mean = np.zeros(4)
    covariance = np.zeros((4, 4))
    for row in targets:
        one_mean, one_covariance, _ = _target_moments(row["copies"])
        mean += row["types"] * one_mean
        covariance += row["types"] * one_covariance
    inclusive_mean = _INCLUSIVE @ mean
    inclusive_covariance = _INCLUSIVE @ covariance @ _INCLUSIVE.T
    return {
        "variables": list(VARIABLES),
        "mean": inclusive_mean.tolist(),
        "covariance": inclusive_covariance.tolist(),
        "raw_variables": list(RAW_VARIABLES),
        "raw_mean": mean.tolist(),
        "raw_covariance": covariance.tolist(),
        "mean_gifts": float(mean[3]),
        "minimum_draws": sum(10 * ((row["copies"] + 9) // 10) * row["types"]
                             for row in targets),
        "maximum_draws": sum(_horizon(row["copies"]) * row["types"] for row in targets),
        "gift_milestones": "180 + 160*k, k=0,1,2,...",
        "method": "finite_state_terminal_first_second_moments_float64",
        "distribution_is_exact": False,
        "moments_are_exact_within_reference_model": True,
    }


def _axis_result(draws: int, raw_count: int, gifts: int, index: int,
                 moments: dict) -> dict:
    count = raw_count + gifts
    mean = np.asarray(moments["mean"])
    covariance = np.asarray(moments["covariance"])
    rate = count / draws if draws else None
    residual_mean = residual_variance = z = score = None
    if draws:
        residual_mean = float(mean[index] - rate * mean[0])
        residual_variance = float(covariance[index, index]
                                  + rate * rate * covariance[0, 0]
                                  - 2.0 * rate * covariance[index, 0])
        tolerance = 1e-10 * max(1.0, covariance[index, index],
                                rate * rate * covariance[0, 0])
        if residual_variance < -tolerance:
            raise ArithmeticError("结果谱残差方差为负，无法计算。")
        residual_variance = max(0.0, residual_variance)
        if residual_variance:
            z = -residual_mean / math.sqrt(residual_variance)
            score = 50.0 * math.erfc(-z / math.sqrt(2.0))
        else:
            score = 0.0 if residual_mean > 0 else 100.0 if residual_mean < 0 else 50.0
    reference_rate = float(mean[index] / mean[0]) if mean[0] else None
    return {
        "raw_count": raw_count,
        "gifts": gifts,
        "count": count,
        "effective_count": count,
        "rate": rate,
        "score": score,
        "expected_count": float(mean[index]),
        "expected_draws": float(mean[0]),
        "reference_rate": reference_rate,
        "reference_rate_definition": "E[K]/E[N], not E[K/N]",
        "residual_mean": residual_mean,
        "residual_variance": residual_variance,
        "z": z,
        "approximate": True,
    }


def score_weapon_profile(N: int, K6: int, KU: int, profile: str,
                         *, allow_individual_draws: bool = False, loss_draws: int = 0) -> dict:
    """Score original raw counts against a supplied actual-result profile.

    Inferred direct gifts are profile.total_copies - KU. This is a scope
    consistency inference, not reconstruction or verification of gift events.
    It never rewrites N/K6/KU. Non-ten N is accepted only with the explicit flag.
    """
    draws = _integer(N, "N")
    six = _integer(K6, "K6")
    up = _integer(KU, "KU")
    if type(allow_individual_draws) is not bool:
        raise ValueError("allow_individual_draws 必须为布尔值。")
    if not 0 <= draws <= MAX_TOTAL_DRAWS or (draws % 10 and not allow_individual_draws):
        raise ValueError(f"N 必须为 0 至 {MAX_TOTAL_DRAWS} 的整十抽数；单抽记录须显式启用。")
    if not 0 <= up <= six <= draws:
        raise ValueError("原始抽取数量必须满足 0 <= KU <= K6 <= N。")
    if type(loss_draws) is not int or not 0 <= loss_draws <= draws - up:
        raise ValueError("扣除亏损后，剩余抽数不能少于抽出的当期专武数。")
    parsed = parse_profile(profile)
    copies = parsed["total_copies"]
    types = parsed["total_types"]
    gifts = copies - up
    if gifts < 0:
        raise ValueError("结果谱总份数少于原始抽出专武 KU；请补全溢出份数或核对统计范围。")
    if not types and (draws or six or up):
        raise ValueError("非空武器记录需要非空结果谱；结果谱 0 仅用于无记录。")
    if types > up:
        raise ValueError("结果谱种类数不能超过原始抽出专武 KU；每个新池先在 80 抽内取得首把。")
    if gifts > _gift_count(draws):
        raise ValueError("由结果谱推算的赠品数超出当前总抽数能够到达的赠品节点。")
    moments = reference_profile_moments(parsed["normalized"])
    warnings = [
        "手填的是实际取得结果谱，将其作为各新池的参照停手目标；不代表已知原定抽取策略。",
        "每池从零开始，逐件结算 40 抽六星与一次性 80 抽首专武保障，达标后结算完整十连。",
        "实际与参照的六星、专武产量都计入节点赠品；原始 N/K6/KU 保持不变。",
        "赠品数由结果谱总份数减原始 KU 推算，要求统计范围一致，不等于逐条赠品核验。",
        "终止均值和协方差由确定性 DP 计算；分数采用正态近似，不是精确分位或实际玩家排名。",
        "结果谱不能还原试水、未完成池、初始库存、跨复刻继承或实际停手方式；两项分数也不是联合百分位。",
    ]
    if not draws:
        warnings.append("没有武器抽取记录，不赋予默认 50 分。")
    if draws % 10:
        warnings.append("实际记录保留原始非整十抽数；参照仍在完整十连结束时停手。")
    if parsed["overflow_copies"]:
        warnings.append("超过 5 潜的数字按额外取得份数保留；赠品节点按 180+160k 延续建模。")
    return {
        "version": VERSION,
        "reference": REFERENCE,
        "method": "100*Phi(-E[K-r*N]/sqrt(Var(K-r*N))), r=observed_inclusive_count/N",
        "total_draws": draws,
        "inputs": {"N": draws, "K6": six, "KU": up},
        "profile": parsed,
        "inferred_gifts": gifts,
        "gift_inference": "profile.total_copies - original_KU",
        "six_star": _axis_result(draws, six, gifts, 1, moments),
        "signature": _axis_result(draws - loss_draws, up, gifts, 2, moments),
        "reference_moments": moments,
        "approximate": True,
        "warnings": warnings,
    }


def clear_cache() -> None:
    _target_moments.cache_clear()
