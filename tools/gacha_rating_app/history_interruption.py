"""User-selected scoring scope, derived without rewriting observed history."""
from __future__ import annotations

import copy
from importer import BANNERS as BANNER_UPS

VERSION = 'history-interruption-v2-catalog-pity-20261111'
BANNERS = tuple(BANNER_UPS)
SIX_STARS = {*BANNER_UPS.values(), '骏卫', '黎风', '别礼', '余烬', '艾尔黛拉'}


def normalize_correction(value):
    if value is None:
        return {'excludedIndices': [], 'freeAllowances': {}, 'resumeInfo': {}}
    if not isinstance(value, dict):
        raise ValueError('中断修正设置须为对象。')
    indices, allowances = value.get('excludedIndices'), value.get('freeAllowances', {})
    if (not isinstance(indices, list) or len(indices) > len(BANNERS)
            or any(type(index) is not int or not 0 <= index < len(BANNERS) for index in indices)
            or len(set(indices)) != len(indices)):
        raise ValueError('中断修正须选择不重复的有效卡池。')
    if (not isinstance(allowances, dict) or len(allowances) > len(BANNERS)
            or any(not isinstance(key, str) or key not in {str(i) for i in range(len(BANNERS))}
                   or type(amount) is not int or amount not in (0, 10, 20)
                   for key, amount in allowances.items())):
        raise ValueError('中断后免费额度须为0、10或20抽。')
    resume = value.get('resumeInfo', {})
    keys = {str(i) for i in range(len(BANNERS))}
    if not isinstance(resume, dict) or len(resume) > len(BANNERS) or any(key not in keys for key in resume):
        raise ValueError('中断补充信息须对应有效卡池。')
    normalized = {}
    for key, info in resume.items():
        if not isinstance(info, dict):
            raise ValueError('中断补充信息须为对象。')
        names = info.get('ownedSixStars', [])
        if (not isinstance(names, list) or len(names) > len(SIX_STARS)
                or any(not isinstance(name, str) or ('骏卫' if name == '俊卫' else name) not in SIX_STARS for name in names)):
            raise ValueError('补充图鉴须为已支持的六星角色列表。')
        names = ['骏卫' if name == '俊卫' else name for name in names]
        if len(set(names)) != len(names):
            raise ValueError('补充图鉴中的六星角色不能重复。')
        complete, pity = info.get('catalogComplete', False), info.get('initialPity', 0)
        if type(complete) is not bool:
            raise ValueError('图鉴补全确认须为选中或未选中。')
        if type(pity) is not int or not 0 <= pity <= 79:
            raise ValueError('中断后补充水位须为0—79的整数。')
        normalized[key] = {'ownedSixStars': names, 'catalogComplete': complete, 'initialPity': pity}
    return {'excludedIndices': sorted(indices), 'freeAllowances': dict(allowances), 'resumeInfo': normalized}


def _integer(value, low=0, high=10000):
    return type(value) is int and low <= value <= high


def project_character(character, *, for_planning=False):
    """Return a new effective character and a small public scope summary.

    Missing ownership seeds the collection only, never observed hits. Supplied
    pity affects luck only; planning retains the zero-pity reset convention.
    Subsequent water follows previously consistent links, not unrelated errors.
    """
    original = character or {'pools': []}
    result = copy.deepcopy(original)
    config = normalize_correction(original.get('interruptionCorrection'))
    selected = set(config['excludedIndices'])
    summary = {'enabled': bool(selected), 'version': VERSION,
               'excludedIndices': sorted(selected),
               'excludedBanners': [BANNERS[i] for i in sorted(selected)],
               'excludedPoolIds': [], 'excludedMainDraws': 0, 'resetPools': []}
    if not selected:
        return result, summary
    pools = original.get('pools', [])
    if not isinstance(pools, list) or any(not isinstance(p, dict) or type(p.get('index')) is not int for p in pools):
        raise ValueError('中断修正需要有效的卡池序号。')
    excluded = [p for p in pools if p['index'] in selected]
    summary['excludedPoolIds'] = [p.get('id') for p in excluded]
    summary['excludedMainDraws'] = sum(p['total'] for p in excluded if _integer(p.get('total')))
    # A future selection records a preference only. It must not discard an
    # existing proof that intervening unlisted banners had exactly zero draws.
    if not excluded and not any(index < p['index'] for index in selected for p in pools):
        return result, summary
    pairs = [(p, copy.deepcopy(p)) for p in sorted(pools, key=lambda row: row['index'])
             if p['index'] not in selected]
    previous_raw = previous = None
    for raw, pool in pairs:
        previous_index = previous['index'] if previous is not None else -1
        boundary = any(previous_index < index < pool['index'] for index in selected)
        if boundary:
            info = config['resumeInfo'].get(str(pool['index']), {})
            pool['interruptionBefore'] = True
            pool['initialPity'] = 0 if for_planning else info.get('initialPity', 0)
            pool['interruptionCatalog'] = {'ownedSixStars': list(info.get('ownedSixStars', [])),
                                           'catalogComplete': info.get('catalogComplete', False)}
            pool['freeAllowance'] = config['freeAllowances'].get(str(pool['index']), 10)
            # Attribution described the original allowance and cannot override
            # the newly selected resource convention in the scoring view.
            pool.pop('freeDrawPositions', None)
            summary['resetPools'].append({key: pool.get(key) for key in ('id', 'index', 'banner')}
                                        | {'initialPity': pool['initialPity'], 'planningInitialPity': 0,
                                           'freeAllowance': pool['freeAllowance'], **pool['interruptionCatalog']})
        elif (previous is not None and pool['index'] == previous['index'] + 1
              and previous.get('tail') != previous_raw.get('tail')
              and (raw.get('initialPity') is None or raw.get('initialPity') == previous_raw.get('tail'))
              and _integer(previous.get('tail'), 0, 79)):
            pool['initialPity'] = previous['tail']
        changed_opening = pool.get('initialPity') != raw.get('initialPity')
        if ((boundary or changed_opening) and pool.get('events') == [] and _integer(pool.get('total'))
                and _integer(pool.get('initialPity'), 0, 79)):
            original_consistent = (raw.get('tail') is None or _integer(raw.get('initialPity'), 0, 79)
                                   and raw['tail'] == raw['initialPity'] + raw['total'])
            if boundary or original_consistent:
                pool['tail'] = pool['initialPity'] + pool['total']
                pool['localTail'] = pool['total']
        previous_raw, previous = raw, pool
    result['pools'] = [p for _, p in pairs]
    result['completeHistory'] = False
    if excluded:
        # A whole-record quota cannot be apportioned across omitted pools by
        # guessing. Per-pool quotas remain and can still determine five stars.
        result.pop('quotaSummary', None)
    first_raw = min(pools, key=lambda p: p['index']) if pools else None
    first = result['pools'][0] if result['pools'] else None
    if first is None or first.get('id') != (first_raw or {}).get('id') or first.get('interruptionBefore'):
        result['initialPity'] = first.get('initialPity') if first else None
        result['initialOwned'] = None
        result.pop('firstPoolHistory', None)
    return result, summary


def project_ledger(ledger, *, for_planning=False):
    result = copy.deepcopy(ledger)
    result['character'], summary = project_character(ledger.get('character'), for_planning=for_planning)
    return result, summary


def refresh_projected_mechanics(ledger):
    """Revalidate derived water while keeping non-mechanical source evidence."""
    from importer import CURRENT_POOL_CODES, CHAR_AXES, _allows_missing_quota, _current_pool_issues, issue
    character = ledger.get('character') or {}
    pools = sorted(character.get('pools', []), key=lambda p: p['index'])
    for index, pool in enumerate(pools):
        pool['issues'] = [i for i in pool.get('issues', []) if i.get('code') not in CURRENT_POOL_CODES]
        pool['issues'].extend(_current_pool_issues(pool, allow_missing_quota=_allows_missing_quota(character)))
        before = pools[index - 1] if index else None
        linked = (before is not None and not pool.get('interruptionBefore')
                  and (pool['index'] == before['index'] + 1 or character.get('completeHistory') is True))
        expected = before.get('tail') if linked else character.get('initialPity') if not index else None
        if expected is not None and pool.get('initialPity') is not None and expected != pool['initialPity']:
            pool['issues'].append(issue('inherited_pity_conflict', '本池期初水位与已填写的前序期末水位不一致。',
                                        'error', CHAR_AXES, basis='current-ledger',
                                        expected=expected, observed=pool['initialPity']))
    return ledger
