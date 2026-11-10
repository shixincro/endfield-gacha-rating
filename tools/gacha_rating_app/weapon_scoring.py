"""Weapon scoring for raw draw totals and manually supplied corrections.

Raw ledger counts are never rewritten. Legacy H80/B fields remain archival
metadata, not a switch that silently changes the new score's meaning.
"""
from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'weapon_score_v2'))
from potential_profile_score import (MAX_DP_CELL_UPDATES, _gift_count, _work_units,
                                    parse_profile, score_weapon_profile)
from ten_pool_reference import _axis_result, _reference_cached

VERSION = 'weapon-potential-table-loss-v2-20261104'


def profile_from_table(config):
    if not isinstance(config, dict):
        raise ValueError('专武配置须为潜能数量表。')
    types, counts = config.get('totalTypes'), config.get('counts')
    if type(types) is not int or not 1 <= types <= 30:
        raise ValueError('总专武种类须为1至30的整数。')
    if (not isinstance(counts, list) or len(counts) != 5
            or any(type(n) is not int or not 0 <= n <= 30 for n in counts)):
        raise ValueError('1至5潜的专武数量均须为0至30的整数。')
    if sum(counts) > types:
        raise ValueError('各潜能数量之和不能超过总专武种类。')
    overflow = config.get('overflowCopies', 0)
    if type(overflow) is not int or not 0 <= overflow <= 30000:
        raise ValueError('溢出专武数量须为0至30000的整数。')
    full = counts[4]
    if overflow and not full:
        raise ValueError('有溢出时至少需要一把5潜专武。')
    allocation = config.get('overflowByType')
    if allocation is None:
        if overflow and full > 1:
            raise ValueError('请分别填写各把5潜专武的溢出份数。')
        allocation = [overflow] if full == 1 else [0] * full
    if (not isinstance(allocation, list) or len(allocation) != full
            or any(type(n) is not int or not 0 <= n <= overflow for n in allocation)
            or sum(allocation) != overflow):
        raise ValueError('各把5潜专武的溢出份数之和须等于溢出专武数量。')
    potentials = [p for p, count in enumerate(counts[:4], 1) for _ in range(count)]
    potentials.extend(5 + copies for copies in allocation)
    return ' '.join(map(str, [types, *potentials]))


def validated_profile(weapon):
    config = weapon.get('potentialConfig')
    profile = profile_from_table(config) if config is not None else weapon.get('profile')
    if profile is not None and not isinstance(profile, str):
        raise ValueError('潜能配置格式无效。')
    if not profile or not profile.strip():
        return None
    parsed = parse_profile(profile)
    types = parsed['total_types']
    if not 1 <= types <= 30:
        raise ValueError('专武种类数须为1至30。')
    up, draws = weapon.get('KU'), weapon.get('N')
    if type(up) is int:
        gifts = parsed['total_copies'] - up
        if gifts < 0:
            raise ValueError('结果谱总份数少于原始抽出专武数，请核对潜能和溢出。')
        if types > up:
            raise ValueError('结果谱种类数不能超过原始抽出专武数。')
        if type(draws) is int and gifts > _gift_count(draws):
            raise ValueError('由结果谱推算的赠品数超出当前总抽数能够到达的赠品节点。')
    if sum(_work_units(row['copies']) for row in parsed['copy_target_counts']) > MAX_DP_CELL_UPDATES:
        raise ValueError('结果谱超出当前确定性计算预算，请核对高潜能和溢出份数。')
    return parsed['normalized']


def loss_draws(weapon):
    loss = weapon.get('lossDraws')
    if loss is None:
        return 0
    if type(loss) is not int or not 0 <= loss <= 30000:
        raise ValueError('亏损抽数须为非负整数。')
    draws, up = weapon.get('N'), weapon.get('KU')
    if type(draws) is int and type(up) is int and loss > draws - up:
        raise ValueError('扣除亏损后，剩余抽数不能少于抽出的当期专武数。')
    return loss


def score_weapon_record(weapon):
    """Use full draws for six stars, and remove only declared losses for signature yield."""
    for name in ('N', 'K6', 'KU'):
        if type(weapon.get(name)) is not int:
            raise ValueError('武器抽数、六星数或专武数未识别完整。')
    n, six, up = (weapon[k] for k in ('N', 'K6', 'KU'))
    if not 0 < n <= 30000:
        raise ValueError('当前工具支持1至30000次武器抽取。')
    if not 0 <= up <= six <= n:
        raise ValueError('原始武器数量须满足0 ≤ 专武数 ≤ 六星数 ≤ 总抽数。')
    individual = weapon.get('allowIndividualDraws') is True
    if n % 10 and not individual:
        raise ValueError('截图武器总抽数须为10的倍数；单次申领记录须有明确标记。')
    try:
        loss, loss_error = loss_draws(weapon), None
    except ValueError as exc:
        loss, loss_error = 0, str(exc)
    signature_n = n - loss
    profile = validated_profile(weapon)
    if profile:
        result = score_weapon_profile(n, six, up, profile,
                                      allow_individual_draws=individual, loss_draws=loss)
        result['mode'] = 'potential-profile'
    else:
        six_reference, signature_reference = _reference_cached(10)
        result = {
            'version': VERSION, 'mode': 'raw-totals',
            'reference': 'first_signature_ten_boundary_completed_pools_ratio',
            'reference_pools': 10, 'total_draws': n,
            'method': '100*(P(reference_ratio<observed_ratio)+0.5*P(equal))',
            'raw_input': {'N': n, 'K6': six, 'KU': up},
            'six_star': _axis_result(n, six, six_reference),
            'signature': _axis_result(signature_n, up, signature_reference),
            'warnings': [],
        }
        for key, count in (('six_star', six), ('signature', up)):
            result[key].update(raw_count=count, effective_count=count, gifts=0)
    result['six_star']['total_draws'] = n
    result['signature']['total_draws'] = signature_n
    result['averageEstimate'] = None
    result['routingVersion'] = VERSION
    result['lossDraws'] = loss
    if loss_error or not signature_n:
        result['signature'] = {'score': None, 'reason': loss_error or '扣除亏损后没有可评分的专武抽数。'}
    return result
